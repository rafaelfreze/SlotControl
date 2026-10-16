import assert from "node:assert/strict";
import { readFileSync,existsSync } from "node:fs";
import { mkdtemp,rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname,join,resolve,sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { createExecutorHandler } from "../../apps/live-executor/src/server.mjs";
import { saveCredential } from "../../apps/live-executor/src/credential-vault.mjs";
import { enableAccountOrderPolicy } from "../../apps/live-executor/src/account-order-policy.mjs";
import { validateExecutorRegistry } from "../../apps/live-executor/src/account-registry.mjs";
import { createHundredFillFixture } from "./hundred-fills-reconciliation.test.mjs";
import { liveClientOrderId,liveEngineOrderPrefix } from "../../apps/web/lib/execution/robot-v1-live-cycle.ts";

const root=fileURLToPath(new URL("../../",import.meta.url));
const read=path=>readFileSync(join(root,path),"utf8");
const webRequire=createRequire(new URL("../../apps/web/package.json",import.meta.url));
const ts=webRequire("typescript");
export const offlineId=n=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const id=offlineId;
const credentialRef=`account_${id(2).replaceAll("-","")}`;
const secret="OFFLINE_ONLY_NOT_A_PRODUCTION_SECRET_".repeat(2);
const version="f82e134084c67b424809c586a3b7b4cd46e00489";
const literal=value=>`'${String(value).replaceAll("'","''")}'`;
const identifier=value=>{assert.match(value,/^[a-z_][a-z0-9_]*$/);return `"${value}"`;};
const columnExpression=value=>{const json=/^([a-z_][a-z0-9_]*)->>([a-z_][a-z0-9_]*)$/.exec(value);
  return json?`${identifier(json[1])}->>${literal(json[2])}`:identifier(value);};
const postgrestValue=value=>value instanceof Date?value.toISOString():Array.isArray(value)?value.map(postgrestValue)
  :value!==null&&typeof value==="object"?Object.fromEntries(Object.entries(value).map(([key,item])=>[key,postgrestValue(item)])):value;
function requestWindows(requests,offset=0){
  const aligned=new Map();let rolling=0,left=0,maxRolling=0;
  for(let right=0;right<requests.length;right++){
    const row=requests[right],minute=Math.floor((row.at+offset)/60000);
    aligned.set(minute,(aligned.get(minute)??0)+row.weight);rolling+=row.weight;
    while(requests[left].at<=row.at-60000)rolling-=requests[left++].weight;
    maxRolling=Math.max(maxRolling,rolling);
  }
  return {maxRolling60s:maxRolling,alignedMinutes:Object.fromEntries(aligned),maxAlignedMinute:Math.max(0,...aligned.values())};
}
const delayWithSignal=(milliseconds,signal)=>new Promise((done,fail)=>{
  if(signal?.aborted){fail(signal.reason);return;}
  const finish=()=>{signal?.removeEventListener("abort",abort);done();};
  const timer=setTimeout(finish,milliseconds);
  const abort=()=>{clearTimeout(timer);signal.removeEventListener("abort",abort);fail(signal.reason);};
  signal?.addEventListener("abort",abort,{once:true});
});

function sqlFunction(path,name){
  const text=read(path),pattern=new RegExp(`create(?: or replace)? function ${name.replaceAll(".","\\.")}\\(`,"ig");
  const matches=[...text.matchAll(pattern)];assert.ok(matches.length,`Missing canonical ${name}`);
  const start=matches.at(-1).index,begin=text.slice(start).search(/\bas\s+(\$[a-z_]*\$)/i);
  assert.ok(begin>=0,name);const delimiter=/\bas\s+(\$[a-z_]*\$)/i.exec(text.slice(start+begin))[1];
  const first=text.indexOf(delimiter,start+begin),end=text.indexOf(delimiter,first+delimiter.length);
  assert.ok(end>first,name);return text.slice(start,text.indexOf(";",end+delimiter.length)+1);
}

/** Local PostgREST-shaped provider, not a replacement financial kernel.
 * All mutations/RPCs execute actual SQL, and query counts/ranges are exact. */
async function sqlService(db,metrics,{sqlDelayMs=0,crashAfterSync=null,crashAfterCredit=null,interruption=null}={}){
  let durableSyncs=0,durableCredits=0;
  const jsonColumns=new Set((await db.query("select table_name,column_name from information_schema.columns where table_schema='coinops' and data_type in ('json','jsonb')")).rows.map(row=>`${row.table_name}:${row.column_name}`));
  const query=async(sql,args=[])=>{
    // An abrupt worker loss does not enter advance's catch/finally. Fence every
    // later provider call and leave the interrupted call suspended forever;
    // a separately loaded worker later uses the same durable database.
    if(interruption?.stopped)return await new Promise(()=>{});
    metrics.sql++;const started=Date.now();
    if(sqlDelayMs)await new Promise(r=>setTimeout(r,sqlDelayMs));
    try{return postgrestValue((await db.query(sql,args)).rows);}
    finally{metrics.sqlElapsedMs+=Date.now()-started;}
  };
  return {query,from(table){
    identifier(table);const predicates=[],args=[],ordering=[];let values=null,insert=false,upsert=null,remove=false,
      countWanted=false,start=0,limit=null,selected="*",head=false;
    const param=value=>{args.push(value);return `$${args.length}`;};
    const encoded=(key,value)=>value!==null&&(typeof value==="object"||jsonColumns.has(`${table}:${key}`))?JSON.stringify(value):value;
    const compare=(key,value,operator)=>{predicates.push(`${columnExpression(key)}${operator}${param(value)}`);return chain;};
    const execute=async single=>{
      const where=predicates.length?` where ${predicates.join(" and ")}`:"";
      try{
        let rows,count=null;
        if(values){
          const list=Array.isArray(values)?values:[values],keys=Object.keys(list[0]);keys.forEach(identifier);
          if(insert){
            const tuples=list.map(row=>`(${keys.map(key=>param(encoded(key,row[key]))).join(",")})`).join(",");
            let conflict="";
            if(upsert){const columns=String(upsert.onConflict??"id").split(",").map(identifier).join(",");
              conflict=` on conflict(${columns}) `+(upsert.ignoreDuplicates?"do nothing":`do update set ${keys.map(key=>`${identifier(key)}=excluded.${identifier(key)}`).join(",")}`);}
            rows=await query(`insert into coinops.${identifier(table)}(${keys.map(identifier).join(",")}) values ${tuples}${conflict} returning *`,args);
          }else rows=await query(`update coinops.${identifier(table)} set ${keys.map(key=>`${identifier(key)}=${param(encoded(key,values[key]))}`).join(",")}${where} returning *`,args);
        }else if(remove)rows=await query(`delete from coinops.${identifier(table)}${where} returning *`,args);
        else{
          if(countWanted)count=Number((await query(`select count(*)::int n from coinops.${identifier(table)}${where}`,args))[0].n);
          rows=head?[]:await query(`select ${selected} from coinops.${identifier(table)}${where}${ordering.length?` order by ${ordering.join(",")}`:""}${limit!==null?` limit ${limit}`:""}${start?` offset ${start}`:""}`,args);
        }
        if(single&&rows.length>1||single==="single"&&rows.length!==1)return {data:null,error:{code:"PGRST116",message:"cardinality"},count,status:406};
        return {data:single?rows[0]??null:rows,error:null,count,status:200};
      }catch(error){metrics.sqlErrors.push({table,code:error.code,message:error.message});return {data:null,error:{code:error.code,message:error.message},status:500};}
    };
    const chain={select(columns="*",options={}){countWanted=options.count==="exact";head=options.head===true;
      // No relational selection occurs in this flow. Preserve actual column
      // projection rather than silently returning an overbroad row.
      selected=columns==="*"?"*":columns.split(",").map(identifier).join(",");return chain;},
      eq:(key,value)=>compare(key,value,"="),neq:(key,value)=>compare(key,value,"<>"),gt:(key,value)=>compare(key,value,">"),
      gte:(key,value)=>compare(key,value,">="),lt:(key,value)=>compare(key,value,"<"),lte:(key,value)=>compare(key,value,"<="),
      is(key,value){assert.equal(value,null);predicates.push(`${identifier(key)} is null`);return chain;},
      not(key,operator,value){assert.equal(operator,"is");assert.equal(value,null);predicates.push(`${identifier(key)} is not null`);return chain;},
      in(key,values){predicates.push(values.length?`${identifier(key)} in (${values.map(param).join(",")})`:"false");return chain;},
      or(value){assert.equal(value,"lease_until.is.null,lease_until.lt."+value.split("lease_until.lt.")[1]);
        const until=value.split("lease_until.lt.")[1];assert.ok(until&&Number.isFinite(Date.parse(until)));predicates.push(`(lease_until is null or lease_until<${param(until)})`);return chain;},
      order(key,{ascending=true}={}){ordering.push(`${identifier(key)} ${ascending?"asc":"desc"}`);return chain;},
      range(first,last){assert.ok(Number.isSafeInteger(first)&&Number.isSafeInteger(last)&&first>=0&&last>=first);start=first;limit=last-first+1;return chain;},
      limit(n){assert.ok(Number.isSafeInteger(n)&&n>=0);limit=n;return chain;},abortSignal:()=>chain,
      insert(data){values=data;insert=true;return chain;},upsert(data,options={}){values=data;insert=true;upsert=options;return chain;},
      update(data){values=data;return chain;},delete(){remove=true;return chain;},
      single:()=>execute("single"),maybeSingle:()=>execute("maybe"),then:(done,fail)=>execute(false).then(done,fail)};
    return chain;
  },async rpc(name,input){
    identifier(name);metrics.rpc[name]=(metrics.rpc[name]??0)+1;
    const entries=Object.entries(input??{}),args=entries.map(([,value])=>encodedRpc(value));
    const expression=`coinops.${identifier(name)}(${entries.map(([key],i)=>`${identifier(key)}=>$${i+1}`).join(",")})`;
    const scalar=new Set(["acquire_account_order_budget_probe","record_account_order_budget_sample","reserve_account_order_budget",
      "acknowledge_account_order_budget","record_live_reconciliation_checkpoint"]);
    try{
      const rows=await query(scalar.has(name)?`select ${expression} v`:`select * from ${expression}`,args);
      if(interruption&&name===interruption.rpc&&++interruption.count===interruption.after){
        interruption.stopped=true;interruption.signal({rpc:name,durableCount:interruption.count});
        return await new Promise(()=>{});
      }
      if(name==="sync_robot_v1_live_order"&&++durableSyncs===crashAfterSync){crashAfterSync=null;throw new Error("OFFLINE_CRASH_AFTER_DURABLE_SYNC");}
      if(name==="credit_robot_v1_live_closed_slot"&&++durableCredits===crashAfterCredit){crashAfterCredit=null;throw new Error("OFFLINE_CRASH_AFTER_DURABLE_CREDIT");}
      return {data:scalar.has(name)?rows[0].v:rows,error:null};
    }catch(error){if(error.message.startsWith("OFFLINE_CRASH_"))throw error;
      metrics.sqlErrors.push({rpc:name,code:error.code,message:error.message});return {data:null,error:{code:error.code,message:error.message}};}
  }};
}
const encodedRpc=value=>value!==null&&typeof value==="object"?JSON.stringify(value):value;

function moduleLoader(service,fetcher,env,diagnostics,{reuseFeeQuoteFor25=false}={}){
  const fingerprints=new Map(),cache=new Map(),special=new Map([
    [join(root,"apps/web/lib/supabase/service-role.ts"),{createServiceRoleClient:()=>service}],
    [join(root,"apps/web/lib/supabase/env.ts"),{getCoinOpsServiceTenantId:()=>id(91),getSupabaseDataSchema:()=>"coinops"}],
  ]);
  const load=filename=>{
    filename=resolve(filename);if(special.has(filename))return special.get(filename);if(cache.has(filename))return cache.get(filename).exports;
    const module={exports:{}};cache.set(filename,module);
    let source=readFileSync(filename,"utf8");
    fingerprints.set(filename,createHash("sha256").update(source).digest("hex"));
    if(reuseFeeQuoteFor25&&filename.endsWith(`${sep}robot-v1-live-server.ts`)){
      // Explicit experimental source variant, never a production edit. Keep
      // legacy25 serial transport/branches/checkpoints/fresh financial reads;
      // share only the existing scoped60s fee-FX context during observation.
      const substitutions=[
        ["    const settledSellsBefore =", "    const orderFeeValuation = feeValuation ?? createReconciliationFeeValuation(run, reconciliationState);\n    const settledSellsBefore ="],
        ["if (!reconciledSellIds.has(order.id)) await reconcileOrder(service, run, order, feeValuation);", "if (!reconciledSellIds.has(order.id)) await reconcileOrder(service, run, order, orderFeeValuation);"],
        ["await ensureTakeProfits(service, run, ledger, state, feeValuation);", "await ensureTakeProfits(service, run, ledger, state, orderFeeValuation);"],
        ["await ensureTakeProfits(service, run, after, state, feeValuation);", "await ensureTakeProfits(service, run, after, state, orderFeeValuation);"],
      ];
      for(const [before,after]of substitutions){assert.equal(source.split(before).length,2,`Variant source anchor changed: ${before}`);source=source.replace(before,after);}
    }
    const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
    const localRequire=name=>{
      if(name==="server-only")return {};
      if(name.startsWith("node:"))return webRequire(name);
      if(!name.startsWith("."))return webRequire(name);
      const full=resolve(dirname(filename),name),candidate=[full,`${full}.ts`,`${full}.js`,join(full,"index.ts")].find(existsSync);
      assert.ok(candidate,`Cannot resolve ${name} from ${filename}`);return load(candidate);
    };
    new Function("require","exports","module","process","fetch","__filename","__dirname",compiled)(
      localRequire,module.exports,module,{env},fetcher,filename,dirname(filename));
    if(filename.endsWith(`${sep}live-read-error.ts`)){
      const original=module.exports.liveFailureEvidence;
      module.exports.liveFailureEvidence=(error,...args)=>{diagnostics.push({message:error?.message,stack:error?.stack});return original(error,...args);};
    }
    return module.exports;
  };
  load.fingerprints=fingerprints;return load;
}

function endpointWeight(url,method){
  if(url.hostname==="api.ipify.org")return 0;
  if(url.pathname==="/api/v3/time")return 1;
  if(["/api/v3/account","/api/v3/exchangeInfo"].includes(url.pathname))return 20;
  if(url.pathname==="/sapi/v1/account/apiRestrictions")return 1;
  if(url.pathname==="/api/v3/ticker/price")return url.searchParams.has("symbols")?4:2;
  if(url.pathname==="/api/v3/openOrders")return url.searchParams.has("symbol")?6:80;
  if(["/api/v3/rateLimit/order","/api/v3/myFilters"].includes(url.pathname))return 40;
  if(url.pathname==="/api/v3/order")return method==="GET"?4:1;
  if(url.pathname==="/api/v3/myTrades"){assert.ok(url.searchParams.has("orderId"));return 5;}
  assert.fail(`Uninventoried endpoint ${url.pathname}`);
}

export async function createFullAdvanceFixture({slotCount=50,slotCapital=22,fillCount=0,monthlyTarget=3,
  failPermissionSnapshots=0,failOrderQueries=[],marketPrice=501,fillNewBuyCount=0,sqlDelayMs=0,httpDelayMs=0,
  crashAfterSync=null,crashAfterCredit=null,inventoryMarkets=["BTCBRL","BTCUSDT","SOLBRL","SOLUSDT"],budgetWindowFailures=0,
  newBuyFillMode="full",binanceClockOffsetMs=0,clockReadFailures=false,interruptAfter=null,globalOrderLimit=null,reuseFeeQuoteFor25=false}={}){
  assert.ok(globalOrderLimit===null||Number.isSafeInteger(globalOrderLimit)&&globalOrderLimit>0);
  const f=await createHundredFillFixture({slotCount,slotCapital,fillCount,monthlyTarget,normalSpacingRate:.02,
    postAthSpacingRate:.03,gainRate:.03,clockFollowsModel:false,progressCheckpoint:true,sqlLatencyMs:0,exchangeLatencyMs:0});
  const temporary=await mkdtemp(join(root,"tools/testing/.full-advance-offline-"));
  const cleanup=async()=>{await f.db.close();const target=resolve(temporary),base=resolve(join(root,"tools/testing"))+sep;
    assert.ok(target.startsWith(base)&&target.split(sep).at(-1).startsWith(".full-advance-offline-"));await rm(target,{recursive:true,force:true});};
  try{
  const requests=[],executorRequests=[],logs=[],diagnostics=[],metrics={sql:0,sqlElapsedMs:0,sqlErrors:[],rpc:{}};
  let signalInterruption;
  const interrupted=new Promise(resolve=>{signalInterruption=resolve;});
  const interruption=interruptAfter?{rpc:interruptAfter.rpc,after:interruptAfter.count,count:0,stopped:false,signal:signalInterruption}:null;
  let service=await sqlService(f.db,metrics,{sqlDelayMs,crashAfterSync,crashAfterCredit,interruption});
  await f.db.exec(`alter table coinops.robot_v1_live_alerts add column id uuid default gen_random_uuid(),add column asset text,
    add column alert_key text,add column code text,add column details jsonb,add column first_seen_at timestamptz default now(),add column last_seen_at timestamptz default now(),
    add column product_id uuid,add column tenant_id uuid,add column user_id uuid,add column quote_asset text;
    create unique index test_alert_scope on coinops.robot_v1_live_alerts(trading_engine_id,alert_key);
    create unique index test_decision_scope on coinops.robot_v1_strategy_decisions(trading_engine_id,decision_id);
    create unique index test_budget_reservation on coinops.account_order_budget_reservations(client_order_id);
    create unique index test_budget_sample on coinops.account_order_budget_samples(exchange_account_id);
    create table coinops.account_order_budget_probe_leases(exchange_account_id uuid primary key,operator_id uuid,lease_owner uuid,expires_at timestamptz);
    create table coinops.strategy_bulk_engine_updates(id uuid,run_id uuid,trading_engine_id uuid,status text,created_at timestamptz,updated_at timestamptz,batch_id uuid,error_code text);
    create table coinops.strategy_bulk_batches(id uuid,status text,updated_at timestamptz);
    alter table coinops.robot_v1_ath_profiles add column id uuid default gen_random_uuid(),add column next_config_version int,
      add column next_gain_rate numeric,add column next_normal_spacing_rate numeric,add column next_post_ath_spacing_rate numeric,
      add column ath_price numeric,add column previous_ath numeric,add column ath_observed_at timestamptz,add column ath_source text,
      add column ath_verified_at timestamptz,add column ath_history_candle_count int,add column ath_floor_reference numeric,
      add column ath_floor_source text,add column ath_floor_defined_at timestamptz,add column transition_key text,
      add column transition_events text[] default '{}',add column transition_observed_at timestamptz,add column updated_at timestamptz default now();
    update coinops.trading_engines set ath_reference_symbol='SOLBRL';
    insert into coinops.robot_v1_ath_profiles(product_id,tenant_id,user_id,operator_id,exchange_account_id,trading_engine_id,environment,asset,quote_asset,
      config_version,gain_rate,normal_spacing_rate,post_ath_spacing_rate,regime,ath_price,ath_source,ath_verified_at,ath_observed_at)
      values('${id(90)}','${id(91)}','${id(3)}','${id(1)}','${id(2)}','${id(4)}','REAL','SOL','BRL',1,.03,.02,.03,'NORMAL',1000,'OFFLINE_FIXTURE',now(),now());
    update coinops.robot_v1_live_runs set lease_owner=null,lease_until=null;
    update coinops.robot_v1_live_orders set reserved_notional_brl=case when side='BUY' then cumulative_quote else 0 end;
    insert into coinops.account_execution_policies(exchange_account_id,operator_id,contract,status) values('${id(2)}','${id(1)}','ENGINE_ISOLATION_V2','ACTIVE');`);
  const gainView=read("supabase/migrations/20260924141913_add_multi_account_operator_engine_isolation.sql");
  const contextMigration="supabase/migrations/20260924141913_add_multi_account_operator_engine_isolation.sql";
  await f.db.exec("update coinops.robot_v1_strategy_decisions set quote_asset='BRL'");
  for(const [index,symbol] of inventoryMarkets.filter(symbol=>symbol!=="SOLBRL").entries()){
    const quote=symbol.endsWith("USDT")?"USDT":"BRL",asset=symbol.slice(0,-quote.length);
    await service.query(`insert into coinops.trading_engines(id,operator_id,exchange_account_id,environment,symbol,base_asset,quote_asset,status,kill_switch,
      config,slot_count,executor_shard_id,hard_cap_quote,ath_reference_symbol) values($1,$2,$3,'REAL',$4,$5,$6,'ACTIVE',false,'{"slot_count":25}',25,'executor-01',275,$4)`,
    [id(20+index),id(1),id(2),symbol,asset,quote]);
  }
  for(const name of ["private.coinops_resolve_engine","private.coinops_parent_engine","private.coinops_row_engine_context","private.coinops_bind_engine_context"])
    await f.db.exec(sqlFunction(contextMigration,name));
  // Use the actual ownership/physical-slot binder, particularly the canonical
  // engine-based monthly physical ID, not the minimal settlement scaffold.
  for(const [table,environment,parent,column,accountOnly] of [
    ["robot_v1_live_preparations","REAL","","",false],["robot_v1_live_slot_accounts","REAL","","",false],
    ["robot_v1_live_runs","REAL","","",false],["robot_v1_live_slots","REAL","robot_v1_live_runs","run_id",false],
    ["robot_v1_live_orders","REAL","robot_v1_live_runs","run_id",false],["robot_v1_live_events","REAL","robot_v1_live_runs","run_id",false],
    ["robot_v1_monthly_slot_gains","","","",false],["robot_v1_strategy_decisions","","","",false],
    ["robot_v1_live_alerts","REAL","","",true],
  ])await f.db.exec(`drop trigger if exists aa_coinops_engine_context on coinops.${table};
    create trigger aa_coinops_engine_context before insert or update on coinops.${table}
    for each row execute function private.coinops_bind_engine_context('${environment}','${parent}','${column}','${accountOnly}');`);
  const viewStart=gainView.indexOf("create or replace view coinops.robot_v1_slot_gain_totals");
  await f.db.exec(gainView.slice(viewStart,gainView.indexOf(";",viewStart)+1));
  const budgetMigration="supabase/migrations/20261004125202_add_same_symbol_engine_provisioning.sql";
  for(const name of ["coinops.acquire_account_order_budget_probe","coinops.record_account_order_budget_sample","coinops.reserve_account_order_budget"])
    await f.db.exec(sqlFunction(budgetMigration,name));
  await f.db.exec(read("supabase/migrations/20261016193756_prove_partial_tp_reconciliation_checkpoint.sql"));
  const engine={...f.engine,execution_allowed:true,is_legacy_default:false,legacy_ownership:false,kill_switch:false,
    account_kill_switch:false,global_kill_switch:false,credential_ref:credentialRef,executor_profile:"coinops-fixed-ip",
    account_cap_quote:slotCount*slotCapital+275,max_order_quote:slotCount*slotCapital};
  const registry=validateExecutorRegistry({version:1,executor_shard_id:"executor-03",credentials:{[credentialRef]:{vault:true}},engines:[engine]});
  await saveCredential({directory:join(temporary,"credentials"),masterSecret:secret,
    scope:{operator_id:id(1),exchange_account_id:id(2),credential_ref:credentialRef,environment:"REAL"},
    apiKey:"A".repeat(64),apiSecret:"B".repeat(64),observation:{status:"PASS",uidHash:"OFFLINE_SYNTHETIC_UID",validatedAt:new Date().toISOString()}});
  await enableAccountOrderPolicy(temporary,{operator_id:id(1),exchange_account_id:id(2),environment:"REAL"},"executor-03");
  const ip="203.0.113.3";
  await service.query("update coinops.executor_shards set egress_ipv4=$1 where id='executor-03'",[ip]);
  await service.query(`insert into coinops.account_executor_connections(exchange_account_id,operator_id,executor_shard_id,environment,credential_ref,status,validation_evidence)
    values($1,$2,'executor-03','REAL',$3,'VALIDATED',$4)`,[id(2),id(1),credentialRef,JSON.stringify({status:"PASS",environment:"REAL",executor_shard_id:"executor-03",executor_ip:ip})]);
  let permissionReads=0,nextOrderId=1000000,remainingNewBuyFills=fillNewBuyCount,budgetProbes=0;
  const requestContext=new AsyncLocalStorage();
  const clockReads=new Map(),budgetClockStarts=new Set();let executorSequence=0;
  const failures=new Set(failOrderQueries.map(slot=>String(1000+slot*2+1)));
  const tradeFor=order=>order.trades??(Number(order.executedQty)>0?[{id:Number(order.orderId),orderId:Number(order.orderId),
    qty:order.executedQty,quoteQty:order.cummulativeQuoteQty,commission:order.side==="SELL"?".00000001":"0",commissionAsset:"BNB",isBuyer:order.side==="BUY",time:Date.now()}]:[]);
  // Freeze trade timestamps/identities before the first observation; replays
  // must never fabricate a changed historical execution.
  for(const order of f.exchange.values())if(Number(order.executedQty)>0)order.trades=tradeFor(order);
  const rawFetch=async(input,init={})=>{
    const url=new URL(input),method=init.method??"GET";
    assert.ok(["api.binance.com","data-api.binance.vision","api.ipify.org"].includes(url.hostname),`Offline network fence: ${url.hostname}`);
    const params=method==="GET"?url.searchParams:new URLSearchParams(init.body);
    const current={host:url.hostname,path:url.pathname,method,weight:endpointWeight(url,method),at:Date.now(),
      executorPath:requestContext.getStore()?.path??"WEB_PUBLIC",engineId:requestContext.getStore()?.engineId??null,invocationId:requestContext.getStore()?.invocationId??null};
    requests.push(current);
    if(httpDelayMs)await delayWithSignal(httpDelayMs,init.signal);
    if(url.hostname==="api.ipify.org")return Response.json({ip});
    if(url.pathname==="/api/v3/time"){
      const context=requestContext.getStore();
      if(context?.path==="/v1/admin/order-budget"&&context.probe<=budgetWindowFailures&&!budgetClockStarts.has(context.probe)){
        budgetClockStarts.add(context.probe);
        const left=10000-((Date.now()+binanceClockOffsetMs)%10000);
        // Start an actual sample no more than7s before its boundary. The later
        // openOrders delay therefore remains inside the real8s HTTP timeout.
        if(left>7000)await delayWithSignal(left-6000,init.signal);
      }
      return Response.json({serverTime:Date.now()+binanceClockOffsetMs});
    }
    if(clockReadFailures&&method==="GET"&&["/api/v3/account","/api/v3/openOrders"].includes(url.pathname)){
      const key=`${requestContext.getStore()?.requestKey}:${url.pathname}:${params.get("symbol")??""}`;
      const count=(clockReads.get(key)??0)+1;clockReads.set(key,count);
      // Every independent read's first request receives a real provider -1021;
      // the canonical adapter performs its one clock refresh and exact retry.
      if(count%2===1){current.status=400;current.providerCode=-1021;return Response.json({code:-1021,msg:"offline clock drift"},{status:400});}
    }
    if(url.pathname==="/api/v3/account")return Response.json({canTrade:true,balances:[{asset:"BRL",free:String(slotCount*slotCapital),locked:"0"},
      {asset:"SOL",free:"1000",locked:"0"},{asset:"BNB",free:".005",locked:"0"}]});
    if(url.pathname==="/sapi/v1/account/apiRestrictions"){
      if(current.executorPath!=="/v1/health")permissionReads++;
      if(current.executorPath!=="/v1/health"&&permissionReads<=failPermissionSnapshots*2&&permissionReads%2===1){current.status=503;return Response.json({code:-1000,msg:"offline transient"},{status:503});}
      return Response.json({ipRestrict:true,enableReading:true,enableSpotAndMarginTrading:true,enableWithdrawals:false,
        enableInternalTransfer:false,permitsUniversalTransfer:false,enableMargin:false,enableFutures:false,enableVanillaOptions:false,enablePortfolioMarginTrading:false,enableFixApiTrade:false});
    }
    const symbols=JSON.parse(params.get("symbols")??"null")??[params.get("symbol")??"SOLBRL"];
    if(url.pathname==="/api/v3/exchangeInfo")return Response.json({exchangeFilters:globalOrderLimit===null?[]:[{filterType:"EXCHANGE_MAX_NUM_ORDERS",maxNumOrders:globalOrderLimit}],symbols:symbols.map(symbol=>({symbol,status:"TRADING",
      baseAsset:symbol.slice(0,symbol.endsWith("USDT")?-4:-3),quoteAsset:symbol.endsWith("USDT")?"USDT":"BRL",allowedSelfTradePreventionModes:["EXPIRE_TAKER"],
      filters:[{filterType:"LOT_SIZE",minQty:".001",maxQty:"100000",stepSize:".001"},
        {filterType:"PRICE_FILTER",minPrice:".1",maxPrice:"1000000",tickSize:".1"},{filterType:"NOTIONAL",minNotional:"10"},{filterType:"MAX_NUM_ORDERS",maxNumOrders:1000}]}))});
    if(url.pathname==="/api/v3/ticker/price")return Response.json(params.has("symbols")?symbols.map(symbol=>({symbol,price:String(marketPrice)})):{symbol:params.get("symbol"),price:String(marketPrice)});
    if(url.pathname==="/api/v3/openOrders"){
      if(current.executorPath==="/v1/admin/order-budget"&&requestContext.getStore().probe<=budgetWindowFailures){
        // Let a real10s Binance counter boundary pass after all full reads.
        // No synthetic timestamp or SQL clock override is permitted.
        const delay=10000-((Date.now()+binanceClockOffsetMs)%10000)+10;await delayWithSignal(delay,init.signal);
      }
      return Response.json([...f.exchange.values()].filter(row=>["NEW","PARTIALLY_FILLED"].includes(row.status)&&(!params.has("symbol")||row.symbol===params.get("symbol"))));
    }
    if(url.pathname==="/api/v3/rateLimit/order")return Response.json([{rateLimitType:"ORDERS",interval:"SECOND",intervalNum:10,limit:10000,count:0},
      {rateLimitType:"ORDERS",interval:"DAY",intervalNum:1,limit:200000,count:0}]);
    if(url.pathname==="/api/v3/myFilters")return Response.json({assetFilters:[],symbolFilters:[],exchangeFilters:[]});
    let order=f.exchange.get(params.get("orderId"))??[...f.exchange.values()].find(row=>row.clientOrderId===params.get("origClientOrderId"));
    if(url.pathname==="/api/v3/myTrades")return Response.json(order?tradeFor(order):[]);
    if(url.pathname==="/api/v3/order"){
      if(method==="GET"){
        if(order&&failures.has(String(order.orderId))){failures.delete(String(order.orderId));current.status=503;return Response.json({code:-1000,msg:"offline503"},{status:503});}
        return order?Response.json(order):Response.json({code:-2013,msg:"no offline order"},{status:400});
      }
      if(method==="POST"){
        assert.ok(![...f.exchange.values()].some(row=>row.clientOrderId===params.get("newClientOrderId")),"duplicate financial POST");
        const side=params.get("side"),filled=side==="BUY"&&(params.get("type")==="MARKET"||remainingNewBuyFills-->0);
        const price=Number(params.get("price")??marketPrice),quantity=Number(params.get("quantity")??Number(params.get("quoteOrderQty"))/price);
        const partial=filled&&newBuyFillMode==="partial"&&params.get("type")==="LIMIT",executed=partial?.022:quantity;
        order={symbol:params.get("symbol"),orderId:++nextOrderId,clientOrderId:params.get("newClientOrderId"),side,status:filled?partial?"PARTIALLY_FILLED":"FILLED":"NEW",
          origQty:String(quantity),executedQty:filled?String(executed):"0",cummulativeQuoteQty:filled?String(executed*price):"0",price:String(price)};
        order.trades=tradeFor(order);f.exchange.set(String(order.orderId),order);return Response.json(order);
      }
      if(method==="DELETE"){assert.ok(order);assert.equal(order.side,"BUY");order.status="CANCELED";return Response.json({...order,origClientOrderId:order.clientOrderId});}
    }
    assert.fail(`Unimplemented offline ${method} ${url.pathname}`);
  };
  const handler=createExecutorHandler({secret,stateDirectory:temporary,expectedEgressIp:ip,fetcher:rawFetch,
    version,region:"OFFLINE_TEST",tradingEnabled:true,killSwitch:false,registry,credentialEnvironment:{},shardId:"executor-03",logger:entry=>logs.push(entry)});
  const fetcher=async(input,init={})=>{
    const url=new URL(input);
    if(url.hostname!==ip)return rawFetch(input,init);
    const executorEntry={path:url.pathname,at:Date.now()};executorRequests.push(executorEntry);
    const request=Readable.from(init.body?[Buffer.from(init.body)]:[]);
    request.url=url.pathname;request.method=init.method??"GET";request.headers=Object.fromEntries(new Headers(init.headers));
    let status=200,headers={},body="";
    const response={writeHead(code,values){status=code;headers=values;return response;},end(chunk){body+=chunk??"";}};
    const probe=url.pathname==="/v1/admin/order-budget"?++budgetProbes:undefined;
    await requestContext.run({...requestContext.getStore(),path:url.pathname,probe,requestKey:++executorSequence},()=>handler(request,response));
    executorEntry.status=status;
    if(status>=400){const payload=JSON.parse(body);executorEntry.code=payload.error;executorEntry.observedAt=payload.observation?.observedAt;executorEntry.serverTime=payload.observation?.serverTime;}
    return new Response(body,{status,headers});
  };
  const env={COINOPS_EXECUTOR_SHARDS_JSON:JSON.stringify({"executor-03":{egressIp:ip,baseUrl:`https://${ip}`,hmacSecret:secret,validatedVersion:version}})};
  let load=moduleLoader(service,fetcher,env,diagnostics,{reuseFeeQuoteFor25}),server=load(join(root,"apps/web/lib/execution/robot-v1-live-server.ts"));
  const startedAt=Date.now();
  const runEngines=new Map([[f.run.id,id(4)]]);let invocationSequence=0;
  return {...f,get service(){return service;},requests,executorRequests,metrics,logs,diagnostics,get server(){return server;},fetcher,registry,startedAt,
    waitForInterruption(){assert.ok(interruption,"Interruption must be configured");return interrupted;},
    async restartAfterInterruption(runId=f.run.id){
      assert.equal(interruption?.stopped,true,"Old worker must be fenced before takeover");
      // Drain queries already queued before the interruption. Only this local
      // fixture lease expires; no operational or provider data is edited.
      await f.db.query("select 1");
      await f.db.query("update coinops.robot_v1_live_runs set lease_until=clock_timestamp()-interval '1 second' where id=$1",[runId]);
      service=await sqlService(f.db,metrics,{sqlDelayMs});
      load=moduleLoader(service,fetcher,env,diagnostics,{reuseFeeQuoteFor25});
      server=load(join(root,"apps/web/lib/execution/robot-v1-live-server.ts"));
    },
    async addSibling(index,{fillCount=0}={}){
      assert.ok(Number.isSafeInteger(index)&&index>=1&&index<=2);
      assert.ok(Number.isSafeInteger(fillCount)&&fillCount>=0&&fillCount<=25);
      const engineId=id(30+index),runId=id(700+index),config={slot_count:25,normal_spacing_rate:.02,post_ath_spacing_rate:.03,gain_rate:.03,monthly_target:3};
      runEngines.set(runId,engineId);
      const copy=async(table,value)=>service.query(`insert into coinops.${identifier(table)} select (jsonb_populate_record(null::coinops.${identifier(table)},$1::jsonb)).* returning *`,[JSON.stringify(value)]);
      const ownEngine=(await service.query("select * from coinops.trading_engines where id=$1",[id(4)]))[0];
      const sibling={...ownEngine,id:engineId,slot_count:25,config,hard_cap_quote:275,order_owner_prefix:null};
      const registryEngine={...engine,id:engineId,trading_engine_id:engineId,slot_count:25,hard_cap_quote:275,max_order_quote:275};
      sibling.order_owner_prefix=liveEngineOrderPrefix(registryEngine);await copy("trading_engines",sibling);
      const prep=(await service.query("select * from coinops.robot_v1_live_preparations where trading_engine_id=$1",[id(4)]))[0];
      await copy("robot_v1_live_preparations",{...prep,id:id(500+index),trading_engine_id:engineId,slot_count:25,
        configured_live_capital_brl:275,max_order_notional_brl:275,max_total_exposure_brl:275});
      const profile=(await service.query("select * from coinops.robot_v1_ath_profiles where trading_engine_id=$1",[id(4)]))[0];
      await copy("robot_v1_ath_profiles",{...profile,id:id(600+index),trading_engine_id:engineId});
      const baseRun=(await service.query("select * from coinops.robot_v1_live_runs where id=$1",[id(6)]))[0];
      await copy("robot_v1_live_runs",{...baseRun,id:runId,trading_engine_id:engineId,slot_count:25,slot_notional_brl:11,
        config_snapshot:config,lease_owner:null,lease_until:null,previous_run_id:null,last_reconciled_at:null});
      const baseSlots=await service.query("select * from coinops.robot_v1_live_slots where run_id=$1 and slot_number<=25 order by slot_number",[id(6)]);
      const baseAccounts=await service.query("select * from coinops.robot_v1_live_slot_accounts where trading_engine_id=$1 and slot_number<=25 order by slot_number",[id(4)]);
      const baseOrders=await service.query("select * from coinops.robot_v1_live_orders where run_id=$1 and slot_number<=25 order by slot_number",[id(6)]);
      for(const slot of baseSlots){
        const slotId=id(10000+index*100+slot.slot_number);
        await copy("robot_v1_live_slots",{...slot,id:slotId,run_id:runId,trading_engine_id:engineId,entry_state:"OPEN",position_quantity:.022,position_committed_brl:11});
        const account=baseAccounts.find(row=>row.slot_number===slot.slot_number);
        await copy("robot_v1_live_slot_accounts",{...account,id:id(15000+index*100+slot.slot_number),trading_engine_id:engineId,
          balance_brl:11,contribution_brl:11,market_pnl_brl:0,fees_brl:0,gain_count:0});
        for(const side of ["BUY","SELL"]){
          const old=baseOrders.find(row=>row.slot_number===slot.slot_number&&row.side===side),orderId=id(20000+index*100+slot.slot_number*2+Number(side==="SELL"));
          const exchangeId=String(3000000+index*100+slot.slot_number*2+Number(side==="SELL"));
          const client=liveClientOrderId(runId,"SOL",slot.slot_number,1,side,1,registryEngine),decision=`offline-decision-${client}`;
          await copy("robot_v1_live_orders",{...old,id:orderId,run_id:runId,slot_id:slotId,trading_engine_id:engineId,
            client_order_id:client,exchange_order_id:exchangeId,status:side==="BUY"?"FILLED":"NEW",requested_quantity:.022,
            executed_quantity:side==="BUY"?.022:0,cumulative_quote:side==="BUY"?11:0,reserved_notional_brl:side==="BUY"?11:0,
            trades_reconciled:side==="BUY",strategy_decision_id:decision,config_snapshot:{gain_rate:.03,entry_spacing:.02}});
          const priorDecision=(await service.query("select * from coinops.robot_v1_strategy_decisions where decision_id=$1",[old.strategy_decision_id]))[0];
          await copy("robot_v1_strategy_decisions",{...priorDecision,id:id(40000+index*100+slot.slot_number*2+Number(side==="SELL")),
            decision_id:decision,trading_engine_id:engineId,cycle_id:runId,slot_id:slotId,result:side==="BUY"?"COMPLETED":"DISPATCHED"});
          if(side==="BUY")await service.query(`insert into coinops.robot_v1_live_fills(order_id,product_id,tenant_id,user_id,symbol,exchange_trade_id,
            quantity,quote_quantity,commission,commission_asset,commission_brl,filled_at) values($1,$2,$3,$4,'SOLBRL',$5,.022,11,0,'BRL',0,now())`,
            [orderId,id(90),id(91),id(3),exchangeId]);
          const filled=side==="BUY"||slot.slot_number<=fillCount;
          const raw={symbol:"SOLBRL",orderId:Number(exchangeId),clientOrderId:client,side,status:filled?"FILLED":"NEW",
            executedQty:filled?".022":"0",cummulativeQuoteQty:filled?side==="BUY"?"11":"11.33":"0",price:side==="BUY"?"500":"515",origQty:".022"};
          raw.trades=tradeFor(raw);f.exchange.set(exchangeId,raw);
        }
      }
      registry.engines.push(registryEngine);
      const cap=Number((await service.query("select sum(hard_cap_quote)::numeric n from coinops.trading_engines where quote_asset='BRL'"))[0].n);
      await service.query("update coinops.account_quote_caps set hard_cap_quote=$1 where exchange_account_id=$2 and quote_asset='BRL'",[cap,id(2)]);
      for(const row of registry.engines)row.account_cap_quote=cap;
      validateExecutorRegistry(registry);
      return {engineId,runId};
    },
    async advance(runId=f.run.id){try{
      if(!runEngines.has(runId)){
        // Attribution only: follow the persisted successor's actual engine.
        // The canonical runtime still resolves/authenticates it independently.
        const rows=(await f.db.query("select trading_engine_id from coinops.robot_v1_live_runs where id=$1",[runId])).rows;
        assert.equal(rows.length,1);runEngines.set(runId,rows[0].trading_engine_id);
      }
      return await requestContext.run({engineId:runEngines.get(runId),invocationId:++invocationSequence},()=>server.advanceLiveRun(runId,"OFFLINE_CANONICAL_FULL_ADVANCE"));}
      catch(error){error.offlineEvidence={diagnostics,sqlErrors:metrics.sqlErrors,failedExecutorRequests:logs.filter(row=>row.status>=400)};
        console.error(JSON.stringify({event:"OFFLINE_FULL_ADVANCE_FAILURE",...error.offlineEvidence}));throw error;}},
    beginMeasurement(){return {requestIndex:requests.length,executorIndex:executorRequests.length,sql:metrics.sql,rpc:{...metrics.rpc},budgetProbes,at:Date.now()};},
    report(baseline=null){
      const measured=requests.slice(baseline?.requestIndex??0),windows=requestWindows(measured);
      const byHost=Object.fromEntries(["api.binance.com","data-api.binance.vision"].map(host=>[host,requestWindows(measured.filter(row=>row.host===host),binanceClockOffsetMs)]));
      return {contract:"OFFLINE_FULL_ADVANCE_V1",sourceVariant:reuseFeeQuoteFor25?"EXPERIMENTAL_FEE_QUOTE_25_REUSE":"CANONICAL_UNMODIFIED",slotCount,slotCapital,elapsedMs:Date.now()-(baseline?.at??startedAt),
        webServerSourceSha256:load.fingerprints.get(join(root,"apps/web/lib/execution/robot-v1-live-server.ts")),
        totalWeight:measured.reduce((n,r)=>n+r.weight,0),privateWeight:measured.filter(r=>r.host==="api.binance.com").reduce((n,r)=>n+r.weight,0),
        publicWeight:measured.filter(r=>r.host==="data-api.binance.vision").reduce((n,r)=>n+r.weight,0),...windows,
        providerAlignedWindows:requestWindows(measured,binanceClockOffsetMs),byHost,
        posts:measured.filter(r=>r.method==="POST").length,deletes:measured.filter(r=>r.method==="DELETE").length,
        executorCalls:executorRequests.length-(baseline?.executorIndex??0),sql:metrics.sql-(baseline?.sql??0),
        rpc:Object.fromEntries(Object.entries(metrics.rpc).map(([name,n])=>[name,n-(baseline?.rpc?.[name]??0)])),sqlErrors:metrics.sqlErrors,
        inventoryMarkets,globalOrderLimit,binanceClockOffsetMs,snapshotPermissionFailures:measured.filter(r=>r.path==="/sapi/v1/account/apiRestrictions"&&r.status===503).length,
        clockReadFailures:measured.filter(r=>r.providerCode===-1021).length,
        outerOrderFailures:measured.filter(r=>r.path==="/api/v3/order"&&r.status===503).length,budgetProbes:budgetProbes-(baseline?.budgetProbes??0),
        engineWeights:Object.fromEntries([...new Set(measured.map(r=>r.engineId))].map(engine=>[engine,measured.filter(r=>r.engineId===engine).reduce((n,r)=>n+r.weight,0)])),
        invocationWeights:Object.fromEntries([...new Set(measured.map(r=>r.invocationId))].map(invocation=>[invocation,measured.filter(r=>r.invocationId===invocation).reduce((n,r)=>n+r.weight,0)])),
        failedExecutorCalls:executorRequests.slice(baseline?.executorIndex??0).filter(row=>row.status>=400),
        endpointInventory:Object.fromEntries([...new Set(measured.map(r=>`${r.method} ${r.host}${r.path}`))].map(key=>[key,measured.filter(r=>`${r.method} ${r.host}${r.path}`===key).length]))};
    },
    close:cleanup,
  };
  }catch(error){await cleanup();throw error;}
}
