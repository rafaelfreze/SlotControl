#!/usr/bin/env node
/** Explicit owner-authorized operations only. No exchange write transport.
 * Persistence/idempotency lives in engine_handoffs, not workstation files. */
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createCLI,canonicalJSON} from './certify-slot-workload.mjs';
import {nativeProgram} from './engine-handoff-native.mjs';
import {accountConnectionProof} from '../../apps/web/lib/execution/account-connection-proof.ts';
export const CLIENTS=['b08b6f73-6fc2-485d-a949-5f77ce651c17','755cf77f-a517-4c84-ac4b-6ee041ed1123'];
export const SAMYA=['8464c3b3-62ac-4a52-b2f1-c4bf4bd6ed36','b4d30a96-71a3-4e44-a633-13bc419be7e1'];
const IP={'executor-02':'164.90.223.159','executor-03':'167.71.37.166'};
const q=v=>"'"+String(v).replaceAll("'","''")+"'";
export function requestId(engine,kind){const hash=createHash('sha256').update('COINOPS:20261025:'+kind+':'+engine).digest('hex');
 return `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-8${hash.slice(17,20)}-${hash.slice(20,32)}`;}
export function remote(action,params,shard){
 try{return JSON.parse(execFileSync('ssh.exe',['-T','-i','C:/Users/rafae/.ssh/coinops_executor_notebook_ed25519',
  '-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=10','root@'+IP[shard],
  '/usr/local/bin/node','--input-type=module','-'],{input:nativeProgram(action,params,shard,IP[shard]),encoding:'utf8',
  timeout:100000,maxBuffer:4*1024*1024,windowsHide:true,stdio:['pipe','pipe','pipe']}));}
 catch(e){throw Error(String(e.stderr||'').match(/HANDOFF_[A-Z0-9_]+/)?.[0]||'HANDOFF_REMOTE_UNPROVEN');}
}
export function control(){
 const runner=(file,args)=>{try{return execFileSync(file,args,{encoding:'utf8',timeout:70000,maxBuffer:8*1024*1024,
  windowsHide:true,stdio:['ignore','pipe','pipe']})}catch(e){throw Error(String(e.stderr||'').match(/COINOPS_[A-Z0-9_]+/)?.[0]||'HANDOFF_SQL_UNPROVEN')}};
 const c=createCLI({runner});c.verifyProject();
 return {query:(sql)=>c.query(sql,'evidence'),write:(sql)=>c.query("BEGIN;SET LOCAL lock_timeout='3s';SET LOCAL statement_timeout='20s';SET LOCAL request.jwt.claim.role='service_role';"+sql+';COMMIT;','evidence')};
}
export function proveOrders(h,probe){
 const fail=()=>{throw Error('HANDOFF_BINANCE_LEDGER_UNPROVEN')};
 const health=probe?.rows?.find(x=>x.path==='/v1/health')?.result;
 const state=probe?.rows?.find(x=>x.path==='/v1/state')?.result;
 if(probe.pending_claims!==0||health?.healthy!==true||health.egress_ipv4_verified!==true
  ||!state||!Array.isArray(state.open_orders))fail();
 const {engine,run,slots,orders}=h.before_snapshot;
 for(const row of [health,state])if(row.operator_id!==h.operator_id||row.exchange_account_id!==h.exchange_account_id
  ||row.trading_engine_id!==h.trading_engine_id||row.environment!=='REAL'||row.symbol!==engine.symbol)fail();
 const resident=orders.filter(o=>['NEW','PARTIALLY_FILLED'].includes(o.status));
 if(resident.length!==state.open_orders.length||orders.some(o=>o.status==='PREPARED'))fail();
 const prefix=engine.order_owner_prefix;
 if(!/^C2-[a-f0-9]{10}-$/.test(prefix||''))fail();
 for(const o of resident){const x=state.open_orders.find(x=>String(x.id)===String(o.exchange_order_id)&&x.clientOrderId===o.client_order_id);
  if(!x||!o.client_order_id.startsWith(prefix)||x.symbol!==engine.symbol||x.side!==o.side||x.status!==o.status
   ||Number(x.originalQuantity)!==Number(o.requested_quantity)||Number(x.executedQuantity)!==Number(o.executed_quantity)
   ||Number(x.price)!==Number(o.price)||Number(x.executedQuantity)!==0)fail();
 }
 const open=slots.filter(s=>s.entry_state==='OPEN'),tps=resident.filter(o=>o.side==='SELL'&&o.purpose==='TP');
 if(open.length!==tps.length||slots.length!==engine.slot_count||slots.some(s=>s.run_id!==run.id))fail();
 for(const s of open){const tp=tps.filter(o=>o.slot_id===s.id);if(tp.length!==1||Number(tp[0].requested_quantity)<=0
  ||Number(tp[0].requested_quantity)>Number(s.position_quantity)+1e-12)fail();}
 const buys=resident.filter(o=>o.side==='BUY');if(buys.length>1||h.kind==='CLIENT_MANAGED'&&buys.length)fail();
 return {positions:open.length,tps:tps.length,next_buy:buys.length,orders:resident.map(o=>({client:o.client_order_id,id:o.exchange_order_id}))};
}
function prepare(c,engine,kind){return c.write(`SELECT coinops.prepare_engine_handoff('${requestId(engine,kind)}','${engine}','${kind}') AS evidence`);}
function current(c,id){return c.query(`SELECT to_jsonb(h) AS evidence FROM coinops.engine_handoffs h WHERE id='${id}'`);}
function commit(c,h,proof){
 try{return c.write(`SELECT coinops.commit_engine_handoff('${h.id}',${q(JSON.stringify(proof))}::jsonb) AS evidence`)}
 catch(error){const observed=current(c,h.id);if(observed.phase==='COMMITTED'&&canonicalJSON(observed.proof)===canonicalJSON(proof))return {status:'COMMITTED',readback:true};throw error;}
}
export function offboardClients(c=control()){
 const results=[];
 for(const engine of CLIENTS){
  const h=prepare(c,engine,'CLIENT_MANAGED');if(h.phase==='COMMITTED'){results.push({engine,status:'COMMITTED',replayed:true});continue;}
  const native=remote('READ',{},'executor-02');
  const row=native.engines.find(e=>e.trading_engine_id===engine);
  if(!row||row.hard_cap_quote!==Number(h.before_snapshot.engine.hard_cap_quote)
    ||row.symbol!==h.before_snapshot.engine.symbol||native.pending_claims)throw Error('HANDOFF_NATIVE_IDENTITY_UNPROVEN');
  proveOrders(h,remote('PROBE',{engine},'executor-02'));
  const fence=remote('FENCE',{rows:[row]},'executor-02');
  const observed=remote('PROBE',{engine},'executor-02'),counts=proveOrders(h,observed);
  const proof={contract:'CONTROLLED_HANDOFF_V1',engine_id:engine,run_id:h.run_id,snapshot_sha256:h.before_sha256,
   source_shard:h.source_shard_id,source_write_fenced:fence.fenced,binance_ledger_match:true,pending_claims:0,
   observed_at:new Date().toISOString(),client_assumes_management:true,
   other_engines_sha256:fence.other_engines_sha256,positions:counts.positions,tps:counts.tps,next_buy:counts.next_buy};
  const result=commit(c,h,proof);results.push({engine,...result,...counts});
 }
 return results;
}

export function refreshSamyaConnection(c){
 const result=remote('VALIDATE_CREDENTIAL',{},'executor-02'),operator='d508bb3e-5a1d-4579-bd7a-de171c118d25',
  account='95c95966-b92e-4e22-ac03-32a3f1d0bc1b',credential='account_95c95966b92e4e22ac0332a3f1d0bc1b';
 const evidence=accountConnectionProof(result,{shardId:'executor-02',ip:IP['executor-02'],credentialRef:credential},operator,account);
 if(!/^[a-f0-9]{64}$/.test(result.uidHash||''))throw Error('HANDOFF_IDENTITY_UNPROVEN');
 return c.write(`DO $identity$ BEGIN IF NOT EXISTS(SELECT 1 FROM coinops.binance_account_identity_bindings
  WHERE exchange_account_id='${account}' AND operator_id='${operator}' AND environment='REAL' AND identity_hash=${q(result.uidHash)})
  THEN RAISE EXCEPTION 'COINOPS_BINANCE_IDENTITY_CHANGED';END IF;END $identity$;
  UPDATE coinops.account_executor_connections SET status='VALIDATED',checked_at=${q(evidence.validated_at)}::timestamptz,
   validation_evidence=${q(JSON.stringify(evidence))}::jsonb WHERE exchange_account_id='${account}' AND executor_shard_id='executor-02' AND environment='REAL';
  INSERT INTO coinops.account_onboarding_checks(operator_id,exchange_account_id,check_key,status,evidence,created_by,idempotency_key)
  SELECT '${operator}','${account}','SHARD_CONNECTION','PASS',${q(JSON.stringify(evidence))}::jsonb,user_id,${q('connection:'+result.handoff_validation_request)}
  FROM coinops.operators WHERE id='${operator}' ON CONFLICT(exchange_account_id,idempotency_key) DO NOTHING;
  SELECT jsonb_build_object('status','VALIDATED','shard','executor-02') AS evidence`);
}

/** Freeze BOTH source workers, then atomically change only their routing. The
 * source process remains disabled and cannot be a second financial writer. */
export async function migrateSamya(c=control(),onProgress=()=>{}){
 const committedBefore=c.query(`SELECT coalesce(jsonb_agg(to_jsonb(h)),'[]'::jsonb) AS evidence FROM coinops.engine_handoffs h
  WHERE id IN(${SAMYA.map(e=>q(requestId(e,'SHARD_MIGRATION'))).join(',')}) AND phase='COMMITTED'`);
 if(committedBefore.length===2){
  const target=remote('READ',{},'executor-02');
  if(!SAMYA.every(id=>target.engines.some(e=>e.trading_engine_id===id&&e.status==='ACTIVE'&&e.execution_allowed)))throw Error('HANDOFF_COMMITTED_DESTINATION_REVIEW_REQUIRED');
  return {status:'ALREADY_MIGRATED',engines:SAMYA,target:'executor-02',no_replay:true};
 }
 const admission=c.query("SELECT coinops.preview_engine_slot_admission('executor-02','REAL',array[25,25],NULL) AS evidence");
 if(admission.code!=='CAPACITY_OK')throw Error('HANDOFF_PAIR_ADMISSION_'+admission.code);
 refreshSamyaConnection(c);
 const rows=remote('READ',{},'executor-03');
 if(rows.pending_claims||rows.engines.length!==2||rows.static_engine_ids.length
  ||rows.engines.some(e=>!SAMYA.includes(e.trading_engine_id)))throw Error('HANDOFF_SOURCE_INVENTORY_UNPROVEN');
 const list=SAMYA.map(engine=>`coinops.prepare_engine_handoff('${requestId(engine,'SHARD_MIGRATION')}','${engine}','SHARD_MIGRATION')`);
 const handoffs=c.write(`SELECT jsonb_build_array(${list.join(',')}) AS evidence`);
 const committed=handoffs.every(h=>h.phase==='COMMITTED');
 if(!committed){
  if(handoffs.some(h=>h.phase!=='PREPARED'))throw Error('HANDOFF_PAIR_PARTIAL_STATE_REVIEW_REQUIRED');
  if(!c.write(`SELECT bool_and(coinops.renew_engine_handoff(id)) AS evidence FROM coinops.engine_handoffs WHERE id IN(${handoffs.map(h=>q(h.id)).join(',')})`))throw Error('HANDOFF_LEASE_LOST');
  const targetRows=rows.engines.map(e=>({...e,executor_shard_id:'executor-02',status:'INACTIVE',execution_allowed:false,
   kill_switch:true,account_kill_switch:true,global_kill_switch:true}));
  for(const h of handoffs){const e=rows.engines.find(e=>e.trading_engine_id===h.trading_engine_id);
   if(e.hard_cap_quote!==Number(h.before_snapshot.engine.hard_cap_quote)||e.symbol!==h.before_snapshot.engine.symbol)throw Error('HANDOFF_SOURCE_IDENTITY_UNPROVEN');
   proveOrders(h,remote('PROBE',{engine:e.trading_engine_id},'executor-03'));
  }
  const scope={operator_id:rows.engines[0].operator_id,exchange_account_id:rows.engines[0].exchange_account_id,
   credential_ref:rows.engines[0].credential_ref,environment:'REAL',executor_shard_id:'executor-02'};
  remote('PREPARE',{scope,rows:targetRows},'executor-02');
  for(const h of handoffs)proveOrders(h,remote('PROBE',{engine:h.trading_engine_id},'executor-02'));
  if(!c.write(`SELECT bool_and(coinops.renew_engine_handoff(id)) AS evidence FROM coinops.engine_handoffs WHERE id IN(${handoffs.map(h=>q(h.id)).join(',')})`))throw Error('HANDOFF_LEASE_LOST');
  remote('FENCE',{rows:rows.engines},'executor-03');
  const stopped=remote('STOP_SOURCE',{},'executor-03');
  if(!stopped.source_process_stopped)throw Error('HANDOFF_SOURCE_STOP_UNPROVEN');
  onProgress({phase:'SOURCE_FENCED',engines:SAMYA});
  const proofs=[];
  for(const h of handoffs){proveOrders(h,remote('PROBE',{engine:h.trading_engine_id},'executor-02'));
   proofs.push({contract:'CONTROLLED_HANDOFF_V1',engine_id:h.trading_engine_id,run_id:h.run_id,snapshot_sha256:h.before_sha256,
    source_shard:'executor-03',target_shard:'executor-02',source_write_fenced:true,source_process_stopped:true,
    target_read_proven:true,binance_ledger_match:true,pending_claims:0,observed_at:new Date().toISOString()});
  }
  if(!c.write(`SELECT bool_and(coinops.renew_engine_handoff(id)) AS evidence FROM coinops.engine_handoffs WHERE id IN(${handoffs.map(h=>q(h.id)).join(',')})`))throw Error('HANDOFF_LEASE_LOST');
  const commands=handoffs.map((h,i)=>`coinops.commit_engine_handoff('${h.id}',${q(JSON.stringify(proofs[i]))}::jsonb)`);
  try{c.write(`SELECT jsonb_build_array(${commands.join(',')}) AS evidence`)}
  catch(error){if(!handoffs.every((h,i)=>{const observed=current(c,h.id);return observed.phase==='COMMITTED'&&canonicalJSON(observed.proof)===canonicalJSON(proofs[i])}))throw error;}
  onProgress({phase:'ROUTING_COMMITTED',engines:SAMYA});
 }
 // Monotonic/idempotent promotion cannot demote an already ACTIVE destination.
 for(const e of rows.engines)remote('PROMOTE',{scope:{...e,executor_shard_id:'executor-02'}},'executor-02');
 // Every web routing cache expires in 30s. Keep both canonical run leases for
 // 40s after cutover; no old cached route can dispatch when workers resume.
 onProgress({phase:'DRAINING_ROUTING_CACHES',seconds:40});
 await new Promise(accept=>setTimeout(accept,40000));
 c.write(`UPDATE coinops.robot_v1_live_runs SET lease_owner=NULL,lease_until=NULL
  WHERE (id,lease_owner) IN(${handoffs.map(h=>`('${h.run_id}'::uuid,'${h.id}'::uuid)`).join(',')});
  SELECT jsonb_build_object('status','MIGRATED','source','executor-03','target','executor-02') AS evidence`);
 return {status:'MIGRATED',engines:SAMYA,source:'executor-03',target:'executor-02',orders_created:0,orders_cancelled:0};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{if(process.argv.length!==3||!['--offboard-clients','--migrate-samya'].includes(process.argv[2]))throw Error('HANDOFF_EXPLICIT_ACTION_REQUIRED');
  console.log(JSON.stringify(process.argv[2]==='--offboard-clients'?offboardClients():await migrateSamya(undefined,p=>console.log(JSON.stringify(p)))));
 }catch(e){console.error(/^[A-Z0-9_]+$/.test(e.message)?e.message:'HANDOFF_FAILED_READBACK_REQUIRED');process.exitCode=1;}
}
