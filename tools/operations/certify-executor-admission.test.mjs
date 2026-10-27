import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {readManifest} from '../../apps/live-executor/deploy/fleet-parity.mjs';
import {certifyExecutorAdmission,cliAdmissionRPC,assertCertificateReadback,preserveWorkloadEvidence,parseArguments} from './certify-executor-admission.mjs';
const m=readManifest(),policy={version:'capacity-v3-20260930'};
function fleet(){return{status:'FLEET_PARITY_PASS',target_sha:m.target_sha,
 shards:[1,2].map(n=>({shard_id:'executor-0'+n,status:'PASS',ip:'192.0.2.'+n,actual_sha:m.target_sha,runtime_sha256:m.runtime_sha256,observed_at:new Date().toISOString()})),
 evidence:[1,2].map(n=>({shard_id:'executor-0'+n,node_version:m.node_version,runtime_sha256:m.runtime_sha256,service:{active_state:'active'},health:{healthy:true},process_identity_verified:true,code_loaded_evidence:'DISK_UNCHANGED_SINCE_PROCESS_START'}))};}
const cert=()=>({p_target_sha:m.target_sha,p_runtime_sha256:m.runtime_sha256,p_node_version:m.node_version,p_policy_version:policy.version,p_evidence:fleet().shards});
function saved(c){return{release:{target_sha:c.p_target_sha,runtime_sha256:c.p_runtime_sha256,node_version:c.p_node_version,policy_version:c.p_policy_version},
 attestations:c.p_evidence.map(e=>({shard_id:e.shard_id,target_sha:c.p_target_sha,runtime_sha256:c.p_runtime_sha256,node_version:c.p_node_version,policy_version:c.p_policy_version,evidence:structuredClone(e)}))};}
function fixture({uncertain=false,badReadback=false,blocked=false}={}){
 const calls=[];let stored={release:null,attestations:[]};return{calls,verifyProject(){calls.push('PROJECT');},query(sql){calls.push(sql);
  if(sql.includes('SELECT coinops.executor_capacity_policy()'))return policy;
  if(sql.includes('SELECT coinops.executor_capacity_decisions()'))return[1,2,3].map(n=>({shard_id:'executor-0'+n,plus_one:{ready:{ready:n<3},code:blocked?'CAPACITY_REQUIRED':'CAPACITY_OK',reason:blocked?'RECOVERY_STABILIZING':'SUSTAINED_HEADROOM_AVAILABLE'}}));
  if(sql.includes('SELECT coinops.certify_executor_admission(')){
   const args=sql.match(/certify_executor_admission\('([a-f0-9]+)','([a-f0-9]+)',\s*'([^']+)','([^']+)','(.+)'::jsonb\)/s);
   assert.ok(args);stored=saved({p_target_sha:args[1],p_runtime_sha256:args[2],p_node_version:args[3],p_policy_version:args[4],p_evidence:JSON.parse(args[5].replaceAll("''","'"))});
   if(badReadback)stored.release.target_sha='f'.repeat(40);if(uncertain)throw Error('TRANSPORT_UNKNOWN');return'ADMISSION_PREFLIGHT_PASS';
  }return structuredClone(stored);
 }};
}
test('verify uses the official project/fleet proof and never writes or needs a secret export',async()=>{
 const cli=fixture();const r=await certifyExecutorAdmission({cli,keyPath:'fixture',fleetVerifier:async options=>{assert.equal(typeof options.registryReader,'function');return fleet();}});
 assert.equal(r.status,'CAPACITY_PREFLIGHT_VERIFIED_NOT_RECORDED');assert.ok(cli.calls.every(s=>!s.includes('SELECT coinops.certify_executor_admission(')));
});
test('record certifies the current release, proves readback, omits retired03 and never forces admission',async()=>{
 for(const blocked of[false,true]){const cli=fixture({blocked});const r=await certifyExecutorAdmission({record:true,cli,keyPath:'fixture',fleetVerifier:async()=>fleet()});
  assert.equal(r.status,'ADMISSION_PREFLIGHT_PASS');assert.equal(r.shards.length,2);assert.equal(r.shards[0].admission,blocked?'CAPACITY_REQUIRED':'CAPACITY_OK');
  const writes=cli.calls.filter(s=>s.includes('SELECT coinops.certify_executor_admission('));assert.equal(writes.length,1);assert.match(writes[0],/SET LOCAL ROLE service_role/);
  assert.doesNotMatch(writes[0],/UPDATE|INSERT|DELETE|healthy_since|reserve_executor_capacity|robot_v1_live/i);
 }
});
test('failed parity does not record and uncertain response is observed rather than repeated',async()=>{
 const cli=fixture();await assert.rejects(certifyExecutorAdmission({record:true,cli,keyPath:'fixture',fleetVerifier:async()=>({...fleet(),status:'FLEET_PARITY_NOT_CONFIRMED'})}),/FLEET_UNVERIFIED/);
 assert.ok(cli.calls.every(s=>!s.includes('SELECT coinops.certify_executor_admission(')));
 for(const badReadback of[false,true]){const c=fixture({uncertain:true,badReadback}),rpc=cliAdmissionRPC(c);
  if(badReadback)await assert.rejects(rpc('certify_executor_admission',cert()),/OUTCOME_UNKNOWN_READ_BACK/);
  else assert.equal(await rpc('certify_executor_admission',cert()),'ADMISSION_PREFLIGHT_PASS');
  assert.equal(c.calls.filter(s=>s.includes('SELECT coinops.certify_executor_admission(')).length,1);
 }
});
test('25-slot release renewal cannot copy or discard a stale 50/100-slot certificate',()=>{
 const c=cert(),previous=saved(c);previous.attestations[0].evidence.slot_workload={profiles:[{slot_count:50},{slot_count:100}]};
 const merged=preserveWorkloadEvidence(c,previous);assert.deepEqual(merged.p_evidence[0].slot_workload,previous.attestations[0].evidence.slot_workload);
 previous.attestations[0].target_sha='a'.repeat(40);assert.throws(()=>preserveWorkloadEvidence(c,previous),/WORKLOAD_REVIEW_REQUIRED/);
 assert.equal(assertCertificateReadback(saved(c),c),true);const corrupt=saved(c);corrupt.attestations[0].evidence.ip='192.0.2.99';assert.equal(assertCertificateReadback(corrupt,c),false);
});
test('unknown RPC, missing SSH path and ambiguous command modes fail closed',async()=>{
 await assert.rejects(cliAdmissionRPC(fixture())('activate_robot_v1_live_cycle'),/RPC_DENIED/);
 await assert.rejects(certifyExecutorAdmission({cli:fixture()}),/SSH_KEY_PATH_REQUIRED/);
 assert.equal(parseArguments(['--ssh-key','fixture']).record,false);
 assert.throws(()=>parseArguments(['--record','--verify','--ssh-key','fixture']),/USAGE_INVALID/);
});
test('both deploy scripts explicitly require admission certification after runtime health',()=>{
 for(const name of['deploy-legacy.sh','deploy-shard.sh']){
  const text=readFileSync(new URL('../../apps/live-executor/deploy/'+name,import.meta.url),'utf8');
  assert.match(text,/ADMISSION_PREFLIGHT_REQUIRED/);assert.match(text,/certify-executor-admission\.mjs --record/);
  assert.match(text.split(/\r?\n/).find(line=>line.includes('ALREADY_DEPLOYED')),/ADMISSION_PREFLIGHT_REQUIRED/);
 }
});
