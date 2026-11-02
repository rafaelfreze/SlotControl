import assert from'node:assert/strict';
import test from'node:test';
import{planExecutorVersionPromotion,verifyExecutorVersionConfiguration}from'./executor-version-config.mjs';
const now=Date.parse('2026-11-02T20:40:00Z'),old='8'.repeat(40),current='5'.repeat(40),hash='a'.repeat(64),
 manifest={contract_version:1,target_sha:current,node_version:'v24.21.0',runtime_entry:'apps/live-executor/src/server.mjs',runtime_sha256:hash,max_evidence_age_ms:120000,max_health_age_ms:45000};
const fleet=()=>({status:'FLEET_PARITY_PASS',target_sha:current,total:2,verified:2,
 shards:['executor-01','executor-02'].map(shard_id=>({shard_id,status:'PASS',actual_sha:current,runtime_sha256:hash,observed_at:new Date(now).toISOString()}))});
const rows=()=>['01','02'].flatMap(s=>Object.entries({VALIDATED_VERSION:old,NEXT_VALIDATED_VERSION:old,
 VERSION_TRANSITION_START:'2026-11-01T18:23:32Z',VERSION_TRANSITION_UNTIL:'2026-11-01T18:59:32Z'})
 .map(([suffix,value])=>({key:`COINOPS_EXECUTOR_${s}_${suffix}`,value,type:'plain',target:['production']})));
test('reproduces stale UI release after healthy fleet rollout; base-only promotion cannot defeat expired NEXT',()=>{
 const r=rows();assert.equal(verifyExecutorVersionConfiguration(manifest,fleet(),r,now).status,'EXECUTOR_VERSION_CONFIG_FAILED');
 for(const row of r.filter(r=>r.key.endsWith('_VALIDATED_VERSION')&&!r.key.includes('_NEXT_')))row.value=current;
 const result=verifyExecutorVersionConfiguration(manifest,fleet(),r,now);
 assert.ok(result.shards.every(s=>s.effective===old&&s.status==='VERSION_CONFIG_MISMATCH'));
});
test('exact promotion fixes both versions without widening windows, changing secrets or mutating its input',()=>{
 const r=rows(),before=structuredClone(r),plan=planExecutorVersionPromotion(manifest,fleet(),now);
 assert.equal(plan.length,4);assert.ok(plan.every(r=>r.value===current&&r.type==='plain'));
 const merged=r.map(r=>plan.find(p=>p.key===r.key)??r);
 assert.equal(verifyExecutorVersionConfiguration(manifest,fleet(),merged,now).status,'EXECUTOR_VERSION_CONFIG_PASS');
 assert.deepEqual(r,before);
});
test('partial rollout, stale/foreign fingerprint, unknown/duplicate shard or missing proof cannot produce a promotion',()=>{
 for(const patch of [{status:'FLEET_PARITY_NOT_CONFIRMED'},{target_sha:old},{verified:1},{total:3}])
  assert.throws(()=>planExecutorVersionPromotion(manifest,{...fleet(),...patch},now));
 for(const patch of [{status:'FAIL'},{actual_sha:old},{runtime_sha256:'b'.repeat(64)},
  {observed_at:new Date(now-120001).toISOString()},{observed_at:new Date(now+2000).toISOString()}]){
  const f=fleet();Object.assign(f.shards[0],patch);assert.throws(()=>planExecutorVersionPromotion(manifest,f,now));}
 const duplicate=fleet();duplicate.shards[1]=duplicate.shards[0];assert.throws(()=>planExecutorVersionPromotion(manifest,duplicate,now));
});
test('missing, duplicate, secret, malformed or preview-only config remains closed; new enabled shard is required',()=>{
 const p=planExecutorVersionPromotion(manifest,fleet(),now);
 assert.equal(verifyExecutorVersionConfiguration(manifest,fleet(),p.filter(r=>!r.key.startsWith('COINOPS_EXECUTOR_02')),now).status,'EXECUTOR_VERSION_CONFIG_FAILED');
 assert.throws(()=>verifyExecutorVersionConfiguration(manifest,fleet(),[...p,p[0]],now));
 assert.throws(()=>verifyExecutorVersionConfiguration(manifest,fleet(),p.map(r=>({...r,type:'encrypted'})),now));
 for(const patch of [{target:['preview']},{value:'*'},{value:old+','+current}])
  assert.equal(verifyExecutorVersionConfiguration(manifest,fleet(),p.map(r=>({...r,...patch})),now).status,'EXECUTOR_VERSION_CONFIG_FAILED');
 const third=fleet();third.total=third.verified=3;third.shards.push({...third.shards[0],shard_id:'executor-03'});
 assert.equal(verifyExecutorVersionConfiguration(manifest,third,p,now).status,'EXECUTOR_VERSION_CONFIG_FAILED');
 assert.equal(planExecutorVersionPromotion(manifest,third,now).length,6);
});
