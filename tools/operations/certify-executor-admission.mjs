#!/usr/bin/env node
/** Complete an authorized runtime rollout through the existing official
 * preflight/RPC. Default is read-only. No dotenv, secrets, exchange I/O,
 * admission reservation, timer edit, engine creation or service restart. */
import {realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createCLI,canonicalJSON} from './certify-slot-workload.mjs';
import {capacityPreflight} from '../../apps/live-executor/deploy/capacity-preflight.mjs';
import {verifyFleet} from '../../apps/live-executor/deploy/fleet-parity.mjs';

const fail=code=>{throw Error(code);};
const literal=value=>"'"+String(value).replaceAll("'","''")+"'";
const registrySQL=`SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'egress_ipv4',egress_ipv4,'enabled',enabled) ORDER BY id),'[]'::jsonb) AS evidence FROM coinops.executor_shards WHERE enabled`;
const certificateSQL=`SELECT jsonb_build_object('release',(SELECT to_jsonb(r) FROM coinops.executor_admission_release r WHERE singleton),
 'attestations',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.shard_id),'[]'::jsonb) FROM coinops.executor_admission_attestations a)) AS evidence`;
const readOnly=sql=>`BEGIN READ ONLY;${sql};COMMIT;`;

export function assertCertificateReadback(value,certificate){
 const r=value?.release;
 if(!r||r.target_sha!==certificate.p_target_sha||r.runtime_sha256!==certificate.p_runtime_sha256
  ||r.node_version!==certificate.p_node_version||r.policy_version!==certificate.p_policy_version
  ||!Array.isArray(value.attestations))return false;
 return certificate.p_evidence.every(e=>{
  const a=value.attestations.filter(a=>a.shard_id===e.shard_id);
  return a.length===1&&a[0].target_sha===r.target_sha&&a[0].runtime_sha256===r.runtime_sha256
   &&a[0].node_version===r.node_version&&a[0].policy_version===r.policy_version
   &&canonicalJSON(a[0].evidence)===canonicalJSON(e);
 });
}

/** Same-release extensions are retained exactly. A changed runtime must not
 * silently copy or discard a 50/100-slot workload certificate: review it in
 * the dedicated workload workflow instead. Legacy25 needs no such profile. */
export function preserveWorkloadEvidence(certificate,previous){
 return {...certificate,p_evidence:certificate.p_evidence.map(e=>{
  const a=previous.attestations?.find(a=>a.shard_id===e.shard_id);
  if(!a?.evidence?.slot_workload)return e;
  if(a.target_sha!==certificate.p_target_sha||a.runtime_sha256!==certificate.p_runtime_sha256
   ||a.node_version!==certificate.p_node_version||a.policy_version!==certificate.p_policy_version)
   fail('CAPACITY_EXISTING_WORKLOAD_REVIEW_REQUIRED');
  return {...e,slot_workload:a.evidence.slot_workload};
 })};
}

export function cliAdmissionRPC(cli){
 return async(name,body={})=>{
  if(name==='executor_capacity_policy')return cli.query(readOnly('SELECT coinops.executor_capacity_policy() AS evidence'),'evidence');
  if(name==='executor_capacity_decisions')return cli.query(readOnly('SELECT coinops.executor_capacity_decisions() AS evidence'),'evidence');
  if(name!=='certify_executor_admission')return fail('CAPACITY_RPC_DENIED');
  const previous=cli.query(readOnly(certificateSQL),'evidence');
  const cert=preserveWorkloadEvidence(body,previous);
  const sql=`BEGIN;SET LOCAL lock_timeout='3s';SET LOCAL statement_timeout='30s';SET LOCAL ROLE service_role;
   SELECT coinops.certify_executor_admission(${literal(cert.p_target_sha)},${literal(cert.p_runtime_sha256)},
   ${literal(cert.p_node_version)},${literal(cert.p_policy_version)},${literal(JSON.stringify(cert.p_evidence))}::jsonb) AS evidence;COMMIT;`;
  let receipt;
  try{receipt=cli.query(sql,'evidence');}
  catch{
   // Only observe an uncertain metadata response. Never issue the RPC twice.
   const observed=cli.query(readOnly(certificateSQL),'evidence');
   if(!assertCertificateReadback(observed,cert))return fail('CAPACITY_RECORD_OUTCOME_UNKNOWN_READ_BACK');
   receipt='ADMISSION_PREFLIGHT_PASS';
  }
  if(receipt!=='ADMISSION_PREFLIGHT_PASS')return fail('CAPACITY_CERTIFICATION_FAILED');
  if(!assertCertificateReadback(cli.query(readOnly(certificateSQL),'evidence'),cert))
   return fail('CAPACITY_CERTIFICATE_READBACK_FAILED');
  return receipt;
 };
}

export async function certifyExecutorAdmission({record=false,cli=createCLI(),keyPath,sshUser='root',fleetVerifier=verifyFleet}={}){
 if(typeof keyPath!=='string'||!keyPath)return fail('CAPACITY_SSH_KEY_PATH_REQUIRED');
 cli.verifyProject();
 const rpc=cliAdmissionRPC(cli);
 return capacityPreflight({record,rpcProvider:rpc,fleetVerifier:options=>fleetVerifier({...options,keyPath,sshUser,
  registryReader:()=>cli.query(readOnly(registrySQL),'evidence')})});
}

export function parseArguments(args){
 const options={record:false};let mode=false;
 for(let i=0;i<args.length;i++){
  const flag=args[i];
  if(['--verify','--record'].includes(flag)){if(mode)fail('CAPACITY_USAGE_INVALID');mode=true;options.record=flag==='--record';}
  else{const key={'--ssh-key':'keyPath','--ssh-user':'sshUser','--cli':'cliPath'}[flag];
   if(!key||options[key]!==undefined||!args[i+1]||args[i+1].startsWith('--'))fail('CAPACITY_USAGE_INVALID');options[key]=args[++i];}
 }
 if(!options.keyPath)fail('CAPACITY_USAGE_INVALID');return options;
}
if(process.argv[1]&&realpathSync(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const options=parseArguments(process.argv.slice(2));
  console.log(JSON.stringify(await certifyExecutorAdmission({...options,cli:createCLI({path:options.cliPath})}),null,2));
 }catch(error){console.error(JSON.stringify({status:'FAIL',code:/^(?:CAPACITY|FLEET|SLOT_WORKLOAD|COINOPS_ADMISSION)_[A-Z0-9_]+$/.test(error?.message??'')?error.message:'CAPACITY_PREFLIGHT_FAILED'}));process.exitCode=1;}
}
