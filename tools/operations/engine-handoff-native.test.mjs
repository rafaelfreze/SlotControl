import {test} from 'node:test';import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fenceRegistry,HANDOFF_ENGINES,nativeProgram} from './engine-handoff-native.mjs';
const engine='b08b6f73-6fc2-485d-a949-5f77ce651c17';
const row={operator_id:'d508bb3e-5a1d-4579-bd7a-de171c118d25',trading_engine_id:engine,
 exchange_account_id:HANDOFF_ENGINES[engine],environment:'REAL',status:'ACTIVE',execution_allowed:true,
 kill_switch:false,account_kill_switch:false,global_kill_switch:false};
const merge=(a,b)=>({...a,engines:[...a.engines,...b.engines]});
test('fence is durable/idempotent, changes only exact approved engines and preserves other state',async()=>{
 const dir=await fs.mkdtemp(join(tmpdir(),'coinops-handoff-'));
 try{const sibling={...row,trading_engine_id:'sibling',exchange_account_id:'other'};
 await fs.writeFile(join(dir,'dynamic-registry.json'),JSON.stringify({version:1,engines:[row,sibling],credentials:{untouched:true}}),{mode:0o600});
 const args={directory:dir,staticRegistry:{engines:[]},expected:[row],mergeDynamicRegistry:merge};
 const first=await fenceRegistry(args),second=await fenceRegistry(args);
 assert.equal(first.other_engines_sha256,second.other_engines_sha256);
 const r=JSON.parse(await fs.readFile(join(dir,'dynamic-registry.json'),'utf8'));
 assert.deepEqual(r.engines[1],sibling);assert.deepEqual(r.credentials,{untouched:true});
 assert.equal(r.engines[0].status,'INACTIVE');assert.equal(r.engines[0].execution_allowed,false);
 assert.equal(r.engines[0].global_kill_switch,true);
 }finally{await fs.rm(dir,{recursive:true,force:true})}
});
test('static fallback, wrong account and immutable snapshot mismatch never fence',async()=>{
 const dir=await fs.mkdtemp(join(tmpdir(),'coinops-handoff-denied-'));
 try{await fs.writeFile(join(dir,'dynamic-registry.json'),JSON.stringify({engines:[row]}),{mode:0o600});
 for(const patch of [{staticRegistry:{engines:[row]}},{expected:[{...row,exchange_account_id:'foreign'}]},
  {expected:[{...row,hard_cap_quote:999}]}]){
 await assert.rejects(fenceRegistry({directory:dir,staticRegistry:{engines:[]},expected:[row],mergeDynamicRegistry:merge,...patch}),/SCOPE_OR_SNAPSHOT_CHANGED/);
 }
 assert.equal(JSON.parse(await fs.readFile(join(dir,'dynamic-registry.json'),'utf8')).engines[0].status,'ACTIVE');
 }finally{await fs.rm(dir,{recursive:true,force:true})}
});
test('generated maintenance program parses, uses GET-only probes and cannot copy financial claims',()=>{
 for(const action of ['READ','FENCE','PREPARE','PROMOTE','PROBE','STOP_SOURCE']){
 const p=nativeProgram(action,{},'executor-02','164.90.223.159');
 const r=spawnSync(process.execPath,['--check','--input-type=module'],{input:p,encoding:'utf8'});assert.equal(r.status,0,r.stderr);
 assert.doesNotMatch(p,/\/api\/v3\/order|copyFile|apiSecret|loadCredential/);
 assert.match(p,/staticRegistry\.engines\.length/);
 }
 assert.throws(()=>nativeProgram('READ',{},'executor-01','46.101.104.48'),/HOST_DENIED/);
});
