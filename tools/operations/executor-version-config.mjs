#!/usr/bin/env node
/** Release-config closeout only. Reads public SHA/time config and fresh fleet
 * evidence; no secrets, env export, DB writes, service restart or trading. */
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {validateManifest} from '../../apps/live-executor/deploy/fleet-parity.mjs';
import {resolveExecutorValidatedVersion} from '../../apps/web/lib/execution/executor-shards-server.ts';

const SHA=/^[a-f0-9]{40}$/,SHARD=/^executor-[0-9]{2,4}$/;
const keyFor=id=>`COINOPS_${id.toUpperCase().replaceAll('-','_')}`;
const fail=()=>{throw Error('EXECUTOR_VERSION_FLEET_UNPROVEN');};
function provenShards(manifest,fleet,now){
 validateManifest(manifest);
 if(!Number.isFinite(now)||fleet?.status!=='FLEET_PARITY_PASS'||fleet.target_sha!==manifest.target_sha
  ||!Array.isArray(fleet.shards)||!fleet.shards.length||fleet.total!==fleet.shards.length
  ||fleet.verified!==fleet.total||new Set(fleet.shards.map(s=>s.shard_id)).size!==fleet.total)fail();
 for(const s of fleet.shards){const age=now-Date.parse(s.observed_at);
  if(!SHARD.test(s.shard_id)||s.status!=='PASS'||s.actual_sha!==manifest.target_sha
   ||s.runtime_sha256!==manifest.runtime_sha256||!Number.isFinite(age)||age< -1000
   ||age>manifest.max_evidence_age_ms)fail();}
 return fleet.shards;
}

/** Exact steady-state promotion. Promoting only the base leaves an expired
 * NEXT override pointing at the old release; both keys must converge. */
export function planExecutorVersionPromotion(manifest,fleet,now=Date.now()){
 return provenShards(manifest,fleet,now).flatMap(s=>['VALIDATED_VERSION','NEXT_VALIDATED_VERSION']
  .map(suffix=>({key:`${keyFor(s.shard_id)}_${suffix}`,value:manifest.target_sha,type:'plain',target:['production']})));
}

export function verifyExecutorVersionConfiguration(manifest,fleet,rows,now=Date.now()){
 const shards=provenShards(manifest,fleet,now),env={};
 if(!Array.isArray(rows))throw Error('EXECUTOR_VERSION_CONFIG_INCOMPLETE');
 for(const row of rows){
  if(!/^COINOPS_EXECUTOR_[0-9]{2,4}_(?:VALIDATED_VERSION|NEXT_VALIDATED_VERSION|VERSION_TRANSITION_START|VERSION_TRANSITION_UNTIL)$/.test(row.key??''))continue;
  if(!row.target?.includes('production'))continue;
  if(row.type!=='plain'||typeof row.value!=='string'||Object.hasOwn(env,row.key))throw Error('EXECUTOR_VERSION_CONFIG_INCOMPLETE');
  env[row.key]=row.value;
 }
 const results=shards.map(s=>{let effective;try{effective=resolveExecutorValidatedVersion(s.shard_id,undefined,env,now);}catch{/* fail closed */}
  return{shard:s.shard_id,expected:manifest.target_sha,effective:SHA.test(effective??'')?effective:null,
   status:effective===manifest.target_sha?'PASS':'VERSION_CONFIG_MISMATCH'};});
 return{status:results.every(s=>s.status==='PASS')?'EXECUTOR_VERSION_CONFIG_PASS':'EXECUTOR_VERSION_CONFIG_FAILED',shards:results};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const args=process.argv.slice(2);if(args.length!==4||args[0]!=='--fleet'||args[2]!=='--versions')throw Error('EXECUTOR_VERSION_USAGE_INVALID');
  const manifest=JSON.parse(readFileSync(new URL('../../apps/live-executor/deploy/fleet-release.json',import.meta.url),'utf8')),
   fleet=JSON.parse(readFileSync(args[1],'utf8')),rows=JSON.parse(readFileSync(args[3],'utf8')),
   result=verifyExecutorVersionConfiguration(manifest,fleet,rows);
  console.log(JSON.stringify(result,null,2));if(result.status!=='EXECUTOR_VERSION_CONFIG_PASS')process.exitCode=1;
 }catch(e){console.error(/^EXECUTOR_VERSION_[A-Z_]+$/.test(e.message)?e.message:'EXECUTOR_VERSION_CONFIG_UNPROVEN');process.exitCode=1;}
}
