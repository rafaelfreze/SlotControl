/** Root-operated maintenance, not an HTTP API or a second Strategy Engine.
 * Only registry metadata changes. Never move vaults/journals/financial claims.
 */
import * as fs from 'node:fs/promises';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
export const HANDOFF_ENGINES=Object.freeze({
 'b08b6f73-6fc2-485d-a949-5f77ce651c17':'c1a0e4d2-8c8f-421d-8fb4-5ddd26e606c3',
 '755cf77f-a517-4c84-ac4b-6ee041ed1123':'ffd5dceb-5cce-4504-921b-6ec0f9a37df1',
 '8464c3b3-62ac-4a52-b2f1-c4bf4bd6ed36':'95c95966-b92e-4e22-ac03-32a3f1d0bc1b',
 'b4d30a96-71a3-4e44-a633-13bc419be7e1':'95c95966-b92e-4e22-ac03-32a3f1d0bc1b'});

export async function fenceRegistry({directory,staticRegistry,expected,mergeDynamicRegistry}) {
 const fail=()=>{throw Error('HANDOFF_NATIVE_SCOPE_OR_SNAPSHOT_CHANGED')};
 if(!Array.isArray(expected)||!expected.length||new Set(expected.map(r=>r.trading_engine_id)).size!==expected.length)fail();
 const ids=new Set(expected.map(r=>r.trading_engine_id));
 if(expected.some(r=>r.operator_id!=='d508bb3e-5a1d-4579-bd7a-de171c118d25'
  ||HANDOFF_ENGINES[r.trading_engine_id]!==r.exchange_account_id||r.environment!=='REAL')
  ||staticRegistry.engines.some(r=>ids.has(r.trading_engine_id)))fail();
 const path=join(directory,'dynamic-registry.json'),lockPath=join(directory,'dynamic-registry.lock');
 const lock=await fs.open(lockPath,'wx',0o600);
 let temporary;
 try{
  const metadata=await fs.lstat(path);if(!metadata.isFile()||metadata.nlink!==1||process.platform!=='win32'&&(metadata.mode&0o027)!==0)fail();
  const dynamic=JSON.parse(await fs.readFile(path,'utf8'));
  const current=mergeDynamicRegistry(staticRegistry,dynamic,fail);
  const fields=['operator_id','exchange_account_id','trading_engine_id','environment','symbol','base_asset','quote_asset',
   'credential_ref','hard_cap_quote','account_cap_quote','max_order_quote','slot_count','legacy_ownership','is_legacy_default'];
  for(const row of expected){const found=current.engines.find(r=>r.trading_engine_id===row.trading_engine_id);
   if(!found||fields.some(k=>found[k]!==row[k])||!['ACTIVE','INACTIVE'].includes(found.status))fail();}
  const next={...dynamic,engines:dynamic.engines.map(r=>ids.has(r.trading_engine_id)?{...r,status:'INACTIVE',
   execution_allowed:false,kill_switch:true,account_kill_switch:true,global_kill_switch:true}:r)};
  const checked=mergeDynamicRegistry(staticRegistry,next,fail);
  if(expected.some(r=>!checked.engines.some(x=>x.trading_engine_id===r.trading_engine_id&&x.status==='INACTIVE'
   &&!x.execution_allowed&&x.kill_switch&&x.account_kill_switch&&x.global_kill_switch)))fail();
  const others=rows=>JSON.stringify(rows.filter(r=>!ids.has(r.trading_engine_id)));
  if(others(current.engines)!==others(checked.engines))fail();
  const othersHash=createHash('sha256').update(others(current.engines)).digest('hex');
  temporary=path+'.'+randomUUID()+'.tmp';const file=await fs.open(temporary,'wx',0o600);
  try{await file.writeFile(JSON.stringify(next));await file.sync()}finally{await file.close()}
  if(process.platform!=='win32'){await fs.chown(temporary,metadata.uid,metadata.gid);await fs.chmod(temporary,metadata.mode&0o777)}
  await fs.rename(temporary,path);temporary=null;
  return {fenced:true,engines:expected.map(r=>r.trading_engine_id),other_engines_sha256:othersHash};
 }finally{if(temporary)await fs.unlink(temporary).catch(()=>{});await lock.close();await fs.unlink(lockPath)}
}

export function nativeProgram(action,params,shard,ip){
 if(!['READ','FENCE','PREPARE','PROMOTE','PROBE','STOP_SOURCE','VALIDATE_CREDENTIAL'].includes(action)
  ||!['executor-02','executor-03'].includes(shard)||ip!==(shard==='executor-02'?'164.90.223.159':'167.71.37.166'))throw Error('HANDOFF_NATIVE_HOST_DENIED');
 return `import * as fs from 'node:fs/promises';import {join} from 'node:path';
import {createHash,createHmac,randomUUID} from 'node:crypto';import {loadEnvFile} from 'node:process';import {execFileSync} from 'node:child_process';
import {loadExecutorRegistry,loadCombinedRegistry,mergeDynamicRegistry,saveInactiveRegistryAccount,promoteRegistryEngine} from '/opt/coinops/current/apps/live-executor/src/account-registry.mjs';
loadEnvFile('/etc/coinops/live-executor.env');const env=process.env;
if(env.COINOPS_EXECUTOR_SHARD_ID!==${JSON.stringify(shard)}||env.LIVE_EXECUTOR_EGRESS_IP!==${JSON.stringify(ip)})throw Error('HANDOFF_NATIVE_HOST_DENIED');
const directory=env.COINOPS_EXECUTOR_STATE_DIR,staticRegistry=await loadExecutorRegistry(env.COINOPS_EXECUTOR_REGISTRY_PATH);
const fail=()=>{throw Error('HANDOFF_NATIVE_REGISTRY_UNPROVEN')};
const HANDOFF_ENGINES=${JSON.stringify(HANDOFF_ENGINES)};
${fenceRegistry.toString()}
const action=${JSON.stringify(action)},params=${JSON.stringify(params)};
const combined=()=>loadCombinedRegistry(staticRegistry,directory,fail);
const pending=async()=>{let count=0;for(const sub of ['orders','cancels']){for(const name of await fs.readdir(join(directory,sub)).catch(e=>{if(e.code==='ENOENT')return [];throw e})){if(name.endsWith('.pending'))count++}}return count;};
let result;
if(action==='READ'){const r=await combined();result={engines:r.engines,static_engine_ids:staticRegistry.engines.map(e=>e.trading_engine_id),pending_claims:await pending()};}
if(action==='FENCE')result=await fenceRegistry({directory,staticRegistry,expected:params.rows,mergeDynamicRegistry});
if(action==='PREPARE'){
 if(${JSON.stringify(shard)}!=='executor-02'||params.scope.exchange_account_id!=='95c95966-b92e-4e22-ac03-32a3f1d0bc1b')fail();
 result=await saveInactiveRegistryAccount(staticRegistry,directory,params.scope,params.rows);
}
if(action==='PROMOTE'){
 if(${JSON.stringify(shard)}!=='executor-02'||params.scope.exchange_account_id!=='95c95966-b92e-4e22-ac03-32a3f1d0bc1b')fail();
 result=await promoteRegistryEngine(staticRegistry,directory,params.scope);
}
if(action==='PROBE'){
 const r=await combined(),e=r.engines.find(e=>e.trading_engine_id===params.engine&&HANDOFF_ENGINES[e.trading_engine_id]===e.exchange_account_id);
 if(!e)fail();const rows=[];
 for(const path of ['/v1/health','/v1/state']){
  const key='HANDOFF:READ:'+randomUUID(),timestamp=String(Date.now()),nonce=randomUUID();
  const body=JSON.stringify({operator_id:e.operator_id,exchange_account_id:e.exchange_account_id,trading_engine_id:e.trading_engine_id,
   environment:'REAL',symbol:e.symbol,quote_asset:e.quote_asset,executor_shard_id:${JSON.stringify(shard)},decision_id:key,idempotency_key:key});
  const hash=createHash('sha256').update(body).digest('hex'),signature=createHmac('sha256',env.COINOPS_EXECUTOR_HMAC_SECRET).update(['POST',path,timestamp,nonce,hash].join('\\n')).digest('hex');
  const response=await fetch('http://127.0.0.1:'+Number(env.PORT||8080)+path,{method:'POST',headers:{'content-type':'application/json',
   'x-coinops-timestamp':timestamp,'x-coinops-nonce':nonce,'x-coinops-body-sha256':hash,'x-coinops-signature':signature,'x-coinops-idempotency-key':key},body,signal:AbortSignal.timeout(35000)});
  if(!response.ok)throw Error('HANDOFF_NATIVE_PROBE_UNPROVEN');rows.push({path,result:await response.json()});
 }result={rows,pending_claims:await pending()};
}
if(action==='STOP_SOURCE'){
 const r=await combined();if(${JSON.stringify(shard)}!=='executor-03'||r.engines.length!==2
  ||r.engines.some(e=>e.exchange_account_id!=='95c95966-b92e-4e22-ac03-32a3f1d0bc1b'||e.status!=='INACTIVE'||e.execution_allowed||!e.kill_switch)
  ||staticRegistry.engines.length||await pending())fail();
 execFileSync('systemctl',['disable','--now','coinops-live-executor.service'],{stdio:['ignore','pipe','pipe'],timeout:90000});
 const state=execFileSync('systemctl',['show','coinops-live-executor.service','--property=ActiveState','--property=MainPID','--property=UnitFileState'],{encoding:'utf8'});
 if(!state.includes('ActiveState=inactive')||!state.includes('MainPID=0')||!state.includes('UnitFileState=disabled'))fail();
 result={source_process_stopped:true,source_registry_fenced:true,pending_claims:0};
}
if(action==='VALIDATE_CREDENTIAL'){
 if(${JSON.stringify(shard)}!=='executor-02')fail();
 const request=randomUUID(),path='/v1/admin/credentials',key='CREDENTIAL:'+request,timestamp=String(Date.now()),nonce=randomUUID();
 const body=JSON.stringify({operator_id:'d508bb3e-5a1d-4579-bd7a-de171c118d25',exchange_account_id:'95c95966-b92e-4e22-ac03-32a3f1d0bc1b',
  credential_ref:'account_95c95966b92e4e22ac0332a3f1d0bc1b',environment:'REAL',executor_shard_id:'executor-02',operation:'REVALIDATE',request_id:request});
 const hash=createHash('sha256').update(body).digest('hex'),signature=createHmac('sha256',env.COINOPS_EXECUTOR_HMAC_SECRET).update(['POST',path,timestamp,nonce,hash].join('\\n')).digest('hex');
 const response=await fetch('http://127.0.0.1:'+Number(env.PORT||8080)+path,{method:'POST',headers:{'content-type':'application/json',
  'x-coinops-timestamp':timestamp,'x-coinops-nonce':nonce,'x-coinops-body-sha256':hash,'x-coinops-signature':signature,'x-coinops-idempotency-key':key},body,signal:AbortSignal.timeout(35000)});
 if(!response.ok)throw Error('HANDOFF_CREDENTIAL_VALIDATION_FAILED');result={...await response.json(),handoff_validation_request:request};
}
process.stdout.write(JSON.stringify(result));`;
}
