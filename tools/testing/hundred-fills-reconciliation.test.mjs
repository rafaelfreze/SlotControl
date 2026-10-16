import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { BinanceLiveTransport } from "../../apps/live-executor/src/binance-live.mjs";
import * as cycle from "../../apps/web/lib/execution/robot-v1-live-cycle.ts";
import * as topology from "../../apps/web/lib/execution/engine-slot-topology.ts";
import * as ledgerRead from "../../apps/web/lib/execution/live-ledger-read.ts";
import * as readErrors from "../../apps/web/lib/execution/live-read-error.ts";
import * as ownership from "../../apps/web/lib/execution/operator-context.ts";
import * as shortcut from "../../apps/web/lib/execution/live-reconciliation-shortcut.ts";
import * as strategy from "../../apps/web/lib/execution/strategy-engine.ts";
import { completeLedgerRead } from "../../apps/web/lib/execution/complete-ledger-read.ts";
import * as webTransport from "../../apps/web/lib/execution/live-executor-transport.ts";
import { withLiveObservationRetryBudget } from "../../apps/web/lib/execution/live-observation-retry-budget.ts";

// Isolated, no .env, no remote DB, no real keys and no network writes. This
// executes the canonical web reconciliation/credit functions, canonical VPS
// Binance transport, and actual versioned SQL sync/credit bodies in PGlite.
// The schema/context trigger is a synthetic scaffold, not a production schema
// certification; transport fetch is a deterministic exchange simulation.
const requireFixture = createRequire(new URL("./account-pause-sql/package.json", import.meta.url));
const { PGlite } = requireFixture("@electric-sql/pglite");
const ts = createRequire(new URL("../../apps/web/package.json", import.meta.url))("typescript");
const root = new URL("../../", import.meta.url);
const read = path => readFileSync(new URL(path, root), "utf8");
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const literal = value => `'${String(value).replaceAll("'", "''")}'`;
const scope = { product_id: id(90), tenant_id: id(91), user_id: id(3), operator_id: id(1),
  exchange_account_id: id(2), trading_engine_id: id(4), symbol: "SOLBRL", quote_asset: "BRL" };
const engine = { ...scope, id: id(4), environment: "REAL", base_asset: "SOL", legacy_compatible: false,
  slot_count: 100, executor_shard_id: "executor-03", status: "ACTIVE", engine_kill_switch: false,
  global_kill_switch: false, account_kill_switch: false, hard_cap_quote: 1100 };

function functionBody(path, name) {
  const source = read(path), start = Math.max(source.indexOf(`create or replace function coinops.${name}(`),source.indexOf(`create function coinops.${name}(`));
  assert.ok(start >= 0, `Missing canonical function ${name}`);
  const end = source.indexOf("end $$;", start);
  assert.ok(end > start);
  return source.slice(start, end + "end $$;".length);
}

function requestWeight(url) {
  if (url.pathname === "/api/v3/time") return 1;
  if (["/api/v3/account", "/api/v3/exchangeInfo"].includes(url.pathname)) return 20;
  if (url.pathname === "/sapi/v1/account/apiRestrictions") return 1;
  if (url.pathname === "/api/v3/ticker/price") return 2;
  if (url.pathname === "/api/v3/openOrders") return 6;
  if (url.pathname === "/api/v3/order") return 4;
  if (url.pathname === "/api/v3/myTrades") { assert.ok(url.searchParams.get("orderId")); return 5; }
  assert.fail(`Unexpected exchange request ${url.pathname}`);
}

async function fixture({ fillCount = 100, crashAfterSync = null, crashAfterCredit = null, transientQuerySlots = [], clockFollowsModel = true,
  progressCheckpoint = false, sqlLatencyMs = 150, exchangeLatencyMs = 150, pacedLatencyScale = null } = {}) {
  const db = new PGlite(), now = Date.now(), requests = [];
  // A logical-clock sensitivity fixture drives TTL assertions; it is not an
  // exact distributed scheduler or a Production latency measurement. The
  // separate paced mode really awaits scaled I/O delays to exercise workers.
  const metrics = { sql:0, sync:0, credit:0, renew:0, ackCalls:0, completeCalls:0, modeledLatencyMs:0,
    observationsInFlight:0,peakObservationsInFlight:0 };
  let recording = false;
  let pacedStarted=performance.now();
  const modeledElapsed=()=>pacedLatencyScale ? Math.round((performance.now()-pacedStarted)*pacedLatencyScale) : metrics.modeledLatencyMs;
  const clockNow=()=>clockFollowsModel ? now+modeledElapsed() : Date.now();
  const pace=async ms=>{if(recording&&pacedLatencyScale)await new Promise(resolve=>setTimeout(resolve,ms/pacedLatencyScale));};
  const query = async (sql, args = []) => {
    if(recording) metrics.sql++;
    const started=metrics.modeledLatencyMs;
    const [response]=await Promise.all([db.query(sql,args),pace(sqlLatencyMs)]);
    const result=response.rows;
    if(recording)metrics.modeledLatencyMs=pacedLatencyScale ? modeledElapsed() : Math.max(metrics.modeledLatencyMs,started+sqlLatencyMs);
    return result;
  };
  await db.exec(read("supabase/tests/configurable_engine_slots_fixture.sql"));
  await db.exec(read("supabase/migrations/20261016161550_configurable_live_engine_slots.sql"));
  await db.exec(`create unique index test_events_natural on coinops.robot_v1_live_events(run_id,event_key);
    create table coinops.robot_v1_live_fills(id uuid default gen_random_uuid(),order_id uuid,product_id uuid,tenant_id uuid,user_id uuid,
      operator_id uuid,exchange_account_id uuid,trading_engine_id uuid,symbol text,exchange_trade_id text,
      quantity numeric,quote_quantity numeric,commission numeric,commission_asset text,commission_brl numeric,
      fee_fx_source text,fee_fx_observed_at timestamptz,filled_at timestamptz,
      unique(exchange_account_id,symbol,exchange_trade_id));
    create function private.test_fill_context() returns trigger language plpgsql as $$
      declare r coinops.robot_v1_live_orders%rowtype; begin
      select * into strict r from coinops.robot_v1_live_orders where id=new.order_id;
      new.operator_id:=r.operator_id; new.exchange_account_id:=r.exchange_account_id;
      new.trading_engine_id:=r.trading_engine_id; return new; end $$;
    create trigger test_fill_context before insert on coinops.robot_v1_live_fills for each row execute function private.test_fill_context();
    create function private.test_gain_context() returns trigger language plpgsql as $$
      declare r coinops.robot_v1_live_orders%rowtype; begin
      select * into strict r from coinops.robot_v1_live_orders where id=new.source_id;
      new.operator_id:=r.operator_id; new.exchange_account_id:=r.exchange_account_id;
      new.trading_engine_id:=r.trading_engine_id; return new; end $$;
    create trigger aa_coinops_engine_context before insert on coinops.robot_v1_monthly_slot_gains
      for each row execute function private.test_gain_context();`);
  await db.exec(functionBody("supabase/migrations/20261016175026_large_engine_reconciliation_progress_checkpoint.sql", "sync_robot_v1_live_order"));
  await db.exec(functionBody("supabase/migrations/20260927133000_add_selective_slot_contributions.sql", "credit_robot_v1_live_closed_slot"));
  await db.exec(functionBody("supabase/migrations/20261004125202_add_same_symbol_engine_provisioning.sql", "acknowledge_account_order_budget"));
  if(progressCheckpoint){
    await db.exec(`create table coinops.robot_v1_live_alerts(operator_id uuid,exchange_account_id uuid,trading_engine_id uuid,severity text,resolved_at timestamptz);`);
    const migration=read("supabase/migrations/20261016175026_large_engine_reconciliation_progress_checkpoint.sql");
    assert.ok(migration.includes("record_live_reconciliation_checkpoint"),"canonical progress migration is required");
    await db.exec(migration);
  }
  await db.exec(`select set_config('request.jwt.claim.role','service_role',false)`);
  await db.exec(`insert into coinops.operators(id,user_id,product_id,tenant_id,status,kill_switch)
      values('${id(1)}','${id(3)}','${id(90)}','${id(91)}','ACTIVE',false);
    insert into coinops.exchange_accounts(id,operator_id,display_name,status,kill_switch) values('${id(2)}','${id(1)}','Synthetic Thyely','ACTIVE',false);
    insert into coinops.trading_engines(id,operator_id,exchange_account_id,environment,symbol,base_asset,quote_asset,status,kill_switch,config,slot_count,executor_shard_id)
      values('${id(4)}','${id(1)}','${id(2)}','REAL','SOLBRL','SOL','BRL','ACTIVE',false,'{"slot_count":100}',100,'executor-03'),
      ('${id(5)}','${id(1)}','${id(2)}','REAL','SOLBRL','SOL','BRL','ACTIVE',false,'{"slot_count":25}',25,'executor-01');
    insert into coinops.robot_v1_live_preparations(product_id,tenant_id,user_id,operator_id,exchange_account_id,trading_engine_id,asset,symbol,quote_asset,slot_count)
      values('${id(90)}','${id(91)}','${id(3)}','${id(1)}','${id(2)}','${id(4)}','SOL','SOLBRL','BRL',100);
    insert into coinops.robot_v1_live_runs(id,product_id,tenant_id,user_id,operator_id,exchange_account_id,trading_engine_id,asset,symbol,quote_asset,status,
      anchor_price,slot_notional_brl,gain_rate,entry_spacing,entry_regime,config_version,config_snapshot,strategy_version,lease_owner,lease_until)
      values('${id(6)}','${id(90)}','${id(91)}','${id(3)}','${id(1)}','${id(2)}','${id(4)}','SOL','SOLBRL','BRL','ACTIVE',500,11,.03,.01,'NORMAL',1,'{"slot_count":100}','4.3.1','${id(7)}',now()+interval '5 minutes');
    insert into coinops.robot_v1_live_slots(id,run_id,product_id,tenant_id,user_id,slot_number,entry_state,position_quantity,position_committed_brl,target_buy_price,entry_reference_price,operational_rank)
      select ('00000000-0000-4000-8001-'||lpad(n::text,12,'0'))::uuid,'${id(6)}','${id(90)}','${id(91)}','${id(3)}',n,'OPEN',.022,11,500,500,n from generate_series(1,100)n;
    insert into coinops.robot_v1_live_slot_accounts(product_id,tenant_id,user_id,operator_id,exchange_account_id,trading_engine_id,asset,slot_number,balance_brl,contribution_brl)
      select '${id(90)}','${id(91)}','${id(3)}','${id(1)}','${id(2)}','${id(4)}','SOL',n,11,11 from generate_series(1,100)n;
    insert into coinops.robot_v1_live_slot_accounts(product_id,tenant_id,user_id,operator_id,exchange_account_id,trading_engine_id,asset,slot_number,balance_brl,contribution_brl)
      select '${id(90)}','${id(91)}','${id(3)}','${id(1)}','${id(2)}','${id(5)}','SOL',n,11,11 from generate_series(1,25)n;`);
  const exchange = new Map();
  for (const slot of await query(`select * from coinops.robot_v1_live_slots order by slot_number`)) {
    for (const side of ["BUY", "SELL"]) {
      const client = cycle.liveClientOrderId(id(6), "SOL", slot.slot_number, 1, side, 1, engine);
      const orderId = id(1000 + slot.slot_number * 2 + Number(side === "SELL"));
      const exId = String(1000 + slot.slot_number * 2 + Number(side === "SELL"));
      await query(`insert into coinops.robot_v1_live_orders(id,run_id,slot_id,product_id,tenant_id,user_id,slot_number,operation_sequence,
        side,purpose,revision,client_order_id,exchange_order_id,status,requested_quantity,price,executed_quantity,cumulative_quote,
        trades_reconciled,submission_guarded_at,config_snapshot)
        values($1,$2,$3,$4,$5,$6,$7,1,$8,$9,1,$10,$11,$12,.022,$13,$14,$15,$16,now(),'{"gain_rate":0.03,"entry_spacing":0.01}')`,
      [orderId,id(6),slot.id,id(90),id(91),id(3),slot.slot_number,side,side === "BUY" ? "ENTRY" : "TP",client,exId,
        side === "BUY" ? "FILLED" : "NEW",side === "BUY" ? 500 : 515,side === "BUY" ? .022 : 0,side === "BUY" ? 11 : 0,side === "BUY"]);
      if (side === "BUY") await query(`insert into coinops.robot_v1_live_fills(order_id,product_id,tenant_id,user_id,symbol,exchange_trade_id,
        quantity,quote_quantity,commission,commission_asset,commission_brl,filled_at) values($1,$2,$3,$4,'SOLBRL',$5,.022,11,0,'BRL',0,$6)`,
      [orderId,id(90),id(91),id(3),exId,new Date(now).toISOString()]);
      const filled = side === "BUY" || slot.slot_number <= fillCount;
      exchange.set(exId, { symbol: "SOLBRL", clientOrderId: client, orderId: Number(exId), side,
        status: filled ? "FILLED" : "NEW", executedQty: filled ? ".022" : "0",
        cummulativeQuoteQty: filled ? side === "BUY" ? "11" : "11.33" : "0", price: side === "BUY" ? "500" : "515", origQty: ".022" });
    }
  }
  await query(`update coinops.robot_v1_live_orders set strategy_decision_id='offline-decision-'||client_order_id`);
  await query(`update coinops.trading_engines set hard_cap_quote=case when id='${id(4)}' then 1100 else 275 end`);
  await query(`update coinops.trading_engines set order_owner_prefix=$1 where id='${id(4)}'`,[cycle.liveEngineOrderPrefix(engine)]);
  await query(`insert into coinops.executor_shards(id,enabled) values('executor-03',true),('executor-01',true)`);
  await query(`update coinops.robot_v1_live_preparations set live_enabled=true,kill_switch=false,
    max_order_notional_brl=1100,max_total_exposure_brl=1100,configured_live_capital_brl=1100 where trading_engine_id='${id(4)}'`);
  await query(`insert into coinops.account_quote_caps(operator_id,exchange_account_id,quote_asset,hard_cap_quote) values('${id(1)}','${id(2)}','BRL',1375)`);
  await query(`insert into coinops.robot_v1_strategy_decisions(product_id,tenant_id,user_id,operator_id,exchange_account_id,trading_engine_id,
    environment,asset,decision_id,strategy_version,cycle_id,slot_id,operation_sequence,action_type,result)
    select product_id,tenant_id,user_id,operator_id,exchange_account_id,trading_engine_id,'REAL','SOL',strategy_decision_id,'4.3.1',run_id,slot_id,1,
      case when side='BUY' then 'ARM_NEXT_BUY' else 'CREATE_TP' end,case when side='BUY' then 'COMPLETED' else 'DISPATCHED' end
      from coinops.robot_v1_live_orders`);
  await query(`insert into coinops.account_order_budget_reservations(client_order_id,exchange_account_id,operator_id,trading_engine_id,executor_shard_id,acknowledged_at)
    select client_order_id,exchange_account_id,operator_id,trading_engine_id,'executor-03',now() from coinops.robot_v1_live_orders`);
  const siblingBefore = JSON.stringify(await query(`select * from coinops.robot_v1_live_slot_accounts where trading_engine_id='${id(5)}' order by slot_number`));
  let failNext = null, synced = 0, shouldCrash = crashAfterSync, credited = 0, shouldCrashCredit = crashAfterCredit;
  const failedQueries=new Set(transientQuerySlots.map(slot=>String(1000+slot*2+1)));
  const fetcher = async (input, init = {}) => {
    const url = new URL(input);
    const started=metrics.modeledLatencyMs;
    await pace(exchangeLatencyMs);
    await Promise.resolve();
    if(recording)metrics.modeledLatencyMs=pacedLatencyScale ? modeledElapsed() : Math.max(metrics.modeledLatencyMs,started+exchangeLatencyMs);
    assert.equal(init.method ?? "GET", "GET", "phase cannot submit/cancel any exchange order");
    requests.push({ path: url.pathname, host: url.hostname, weight: requestWeight(url) });
    if (failNext === url.pathname) { failNext = null; return Response.json({ code: -1000, msg: "simulated503" }, { status: 503 }); }
    if(url.pathname==="/api/v3/order"&&failedQueries.has(url.searchParams.get("orderId"))){
      failedQueries.delete(url.searchParams.get("orderId"));return Response.json({code:-1000,msg:"simulated intermittent503"},{status:503});
    }
    if (url.pathname === "/api/v3/time") return Response.json({ serverTime: clockNow() });
    if (url.pathname === "/api/v3/account") return Response.json({ canTrade: true,
      balances: [{asset:"BRL",free:"1100",locked:"0"},{asset:"SOL",free:"0",locked:"0"},{asset:"BNB",free:".005",locked:"0"}] });
    if (url.pathname === "/sapi/v1/account/apiRestrictions") return Response.json({ ipRestrict: true, enableReading: true,
      enableSpotAndMarginTrading: true, enableWithdrawals: false, enableInternalTransfer: false, permitsUniversalTransfer: false,
      enableMargin:false, enableFutures:false, enableVanillaOptions:false, enablePortfolioMarginTrading:false, enableFixApiTrade:false });
    if (url.pathname === "/api/v3/exchangeInfo") return Response.json({ symbols: [{ symbol:"SOLBRL",baseAsset:"SOL",quoteAsset:"BRL",
      filters:[{filterType:"LOT_SIZE",minQty:".001",maxQty:"100000",stepSize:".001"},{filterType:"PRICE_FILTER",minPrice:".1",maxPrice:"10000000",tickSize:".1"},{filterType:"NOTIONAL",minNotional:"10"}] }] });
    if (url.pathname === "/api/v3/ticker/price") return Response.json({ symbol:url.searchParams.get("symbol"),price:"500" });
    if (url.pathname === "/api/v3/openOrders") return Response.json([...exchange.values()].filter(row => row.status === "NEW"));
    const order = exchange.get(url.searchParams.get("orderId")) ?? [...exchange.values()].find(row => row.clientOrderId === url.searchParams.get("origClientOrderId"));
    if (url.pathname === "/api/v3/order") return order ? Response.json(order) : Response.json({code:-2013,msg:"Order does not exist"},{status:400});
    if (url.pathname === "/api/v3/myTrades") return Response.json(order.status === "FILLED" ? [{id:Number(order.orderId),orderId:order.orderId,
      qty:order.executedQty,quoteQty:order.cummulativeQuoteQty,commission:order.side === "SELL" ? ".00000001" : "0",
      commissionAsset:"BNB",isBuyer:order.side === "BUY",time:now}] : []);
    assert.fail(url.pathname);
  };
  const transport = selected => new BinanceLiveTransport({ apiKey:"offline-key",apiSecret:"offline-secret",fetcher,engine:selected ?? engine,
    now:clockNow });
  const state = async () => {
    const value = await transport().safetySnapshot("SOLBRL");
    return { ...scope,symbol:"SOLBRL",balances:value.account.balances,filters:value.filters,price:value.price,
      open_orders:value.openOrders.map(row => ({...row,id:row.id,clientOrderId:row.clientOrderId})),
      bnb_brl_price:value.bnbBrlPrice,observed_at:new Date(clockNow()).toISOString() };
  };
  const resolver=async(operator,account,selectedEngine)=>{
    assert.equal(operator,scope.operator_id);assert.equal(account,scope.exchange_account_id);assert.equal(selectedEngine,scope.trading_engine_id);
    return {shardId:"executor-03",ip:"203.0.113.3",base:"https://offline.invalid",secret:"s".repeat(32)};
  };
  const bridge=async(input,init)=>{
    const path=new URL(input).pathname,body=JSON.parse(init.body),t=transport(engine);
    assert.ok(["/v1/state","/v1/query-order","/v1/trades"].includes(path),"bridge never permits create/cancel");
    assert.equal(body.executor_shard_id,"executor-03");
    const counted=path!=="/v1/state";
    if(counted){metrics.observationsInFlight++;metrics.peakObservationsInFlight=Math.max(metrics.peakObservationsInFlight,metrics.observationsInFlight);}
    try{
      let payload;
      if(path==="/v1/state")payload=await state();
      if(path==="/v1/query-order")payload={order:await t.queryOrder(body.symbol,body.clientOrderId,body.orderId)};
      if(path==="/v1/trades"){
        const order=await t.queryOrder(body.symbol,body.clientOrderId,body.orderId);
        payload={order,trades:await t.ownedTrades(body.symbol,body.clientOrderId,body.orderId)};
      }
      return Response.json({...scope,environment:"REAL",executor_shard_id:"executor-03",...payload});
    }catch(error){return Response.json({error:error.code??error.message},{status:503});}
    finally{if(counted)metrics.observationsInFlight--;}
  };
  const service = { from(table) {
    const filters = [], args = []; let values = null, upsert = false;
    const execute = async singular => {
      const fields = values ? Object.keys(values) : [];
      const where = filters.length ? ` where ${filters.join(" and ")}` : "";
      let rows;
      if (!values) rows = await query(`select * from coinops.${table}${where}`,args);
      else if (upsert) {
        const vals = fields.map(key => values[key]);
        const conflict = table === "robot_v1_live_events" ? "on conflict(run_id,event_key) do nothing" : "";
        rows = await query(`insert into coinops.${table}(${fields.join(",")}) values(${fields.map((_,i)=>`$${i+1}`).join(",")}) ${conflict} returning *`,vals);
      } else rows = await query(`update coinops.${table} set ${fields.map((key,i)=>`${key}=$${args.length+i+1}`).join(",")}${where} returning *`, [...args,...fields.map(key=>values[key])]);
      return { data:singular ? rows[0] ?? null : rows,error:null };
    };
    const filter = (key,value,op="=") => { args.push(value); filters.push(`${key}${op}$${args.length}`); return chain; };
    const chain = {select:()=>chain,order:()=>chain,abortSignal:()=>chain,range:()=>chain,limit:()=>chain,
      eq:(key,value)=>filter(key,value),gt:(key,value)=>filter(key,value,">"),is:(key,value)=>{assert.equal(value,null);filters.push(`${key} is null`);return chain;},
      neq:(key,value)=>filter(key,value,"<>"),
      in:(key,values)=>{filters.push(`${key} in (${values.map(literal).join(",")})`);return chain;},
      or:()=>{filters.push("(lease_until is null or lease_until<now())");return chain;},
      update:data=>{if(recording&&table==="robot_v1_live_runs"&&data.lease_until)metrics.renew++;values=data;return chain;},upsert:data=>{values=data;upsert=true;return chain;},
      maybeSingle:()=>execute(true),single:()=>execute(true),then:done=>execute(false).then(done)};
    return chain;
  }, async rpc(name,input) {
    assert.ok(["sync_robot_v1_live_order","credit_robot_v1_live_closed_slot","acknowledge_account_order_budget","record_live_reconciliation_checkpoint"].includes(name),`Unexpected financial RPC ${name}`);
    if(recording&&["sync_robot_v1_live_order","credit_robot_v1_live_closed_slot"].includes(name)) name === "sync_robot_v1_live_order" ? metrics.sync++ : metrics.credit++;
    const entries=Object.entries(input),params=entries.map(([,value])=>Array.isArray(value)||value&&typeof value === "object" ? JSON.stringify(value) : value);
    if(name==="acknowledge_account_order_budget")return {data:(await query(`select coinops.${name}(${entries.map(([key],i)=>`${key}=>$${i+1}`).join(",")}) as v`,params))[0].v,error:null};
    if(name==="record_live_reconciliation_checkpoint")return {data:(await query(`select coinops.${name}(${entries.map(([key],i)=>`${key}=>$${i+1}`).join(",")}) as v`,params))[0].v,error:null};
    const rows=await query(`select * from coinops.${name}(${entries.map(([key],i)=>`${key}=>$${i+1}`).join(",")})`,params);
    if (name === "sync_robot_v1_live_order" && ++synced === shouldCrash) { shouldCrash=null; throw new Error("SIMULATED_PROCESS_EXIT_AFTER_DURABLE_SYNC"); }
    if (name === "credit_robot_v1_live_closed_slot" && ++credited === shouldCrashCredit) { shouldCrashCredit=null; throw new Error("SIMULATED_PROCESS_EXIT_AFTER_DURABLE_CREDIT"); }
    return {data:rows,error:null};
  } };
  const compile = (path, dependencies) => {
    const exported={};const compiled=ts.transpileModule(read(path),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
    new Function("require","exports",compiled)(name=>dependencies[name]??{},exported);return exported;
  };
  const registry = compile("apps/web/lib/execution/operator-context-server.ts",{
    "./live-read-error":readErrors,"./live-ledger-read":ledgerRead,"./operator-context":ownership,
  });
  const decisions = compile("apps/web/lib/execution/strategy-decision-server.ts",{
    "./operator-context-server":registry,"./operator-context":ownership,
  });
  const budget = compile("apps/web/lib/execution/account-order-budget-server.ts",{});
  const deps = {"node:crypto":{createHash,randomUUID},"./engine-slot-topology":topology,"./live-ledger-read":ledgerRead,
    "./live-read-error":readErrors,"./complete-ledger-read":{completeLedgerRead},"./robot-v1-live-cycle":cycle,
    "./operator-context":ownership,"./strategy-engine":strategy,"./live-reconciliation-shortcut":shortcut,
    "../supabase/env":{getCoinOpsServiceTenantId:()=>id(91),getSupabaseDataSchema:()=>"coinops"},
    // Execute metadata helpers, complete paginated registry and ACK SQL too.
    // No remote provider/transport latency is claimed from local PGlite.
    "./account-order-budget-server":{acknowledgeAccountOrderDispatch:async(...args)=>{metrics.ackCalls++;return budget.acknowledgeAccountOrderDispatch(...args);}},
    "./strategy-decision-server":{completeStrategyDecision:async(...args)=>{metrics.completeCalls++;return decisions.completeStrategyDecision(...args);}},
    "./live-observation-retry-budget":{withLiveObservationRetryBudget},
    "./live-executor-transport":{
      readLiveExecutorState:state,
      readLiveExecutorOrder:async(run,client,exchangeId)=>webTransport.readLiveExecutorOrder(run,client,exchangeId,bridge,resolver),
      readLiveExecutorTrades:async(run,client,exchangeId)=>webTransport.readLiveExecutorTrades(run,client,exchangeId,bridge,resolver),
      createLiveExecutorOrder:()=>assert.fail("No new order expected in observation/settlement phase"),
      cancelLiveExecutorOrder:()=>assert.fail("No cancellation expected in observation/settlement phase"),
    }};
  const compiled=ts.transpileModule(read("apps/web/lib/execution/robot-v1-live-server.ts"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const exported={};
  class ModeledDate extends Date {
    constructor(...args){super(...(args.length ? args : [clockNow()]));}
    static now(){return clockNow();}
  }
  new Function("require","exports","Date",compiled+`\nexports.test={reconcileOrder,reconcileAcknowledgedSellOrders,creditClosedSlots,runRows,claim,release,ensureTakeProfits,createReconciliationFeeValuation,checkpointLargeEngineProgress};`)(
    name=>deps[name]??{},exported,ModeledDate);
  const run={...(await query(`select * from coinops.robot_v1_live_runs where id='${id(6)}'`))[0],engine};
  pacedStarted=performance.now();recording=true;
  return {db,query,run,service,api:exported.test,state,requests,transport,metrics,clockNow,
    fail:()=>{failNext="/api/v3/order";},
    beforeSibling:siblingBefore,
    totals:()=>({all:requests.reduce((n,r)=>n+r.weight,0),private:requests.filter(r=>r.host==="api.binance.com").reduce((n,r)=>n+r.weight,0),
      public:requests.filter(r=>r.host==="data-api.binance.vision").reduce((n,r)=>n+r.weight,0)}),
    clearRequests:()=>{requests.length=0;},
  };
}

async function reconcilePhase(f) {
  return withLiveObservationRetryBudget(f.run,async()=>{
    const rows=await f.api.runRows(f.service,f.run);
    const initial=await f.state();
    const fee=f.api.createReconciliationFeeValuation(f.run,initial);
    const processed=await f.api.reconcileAcknowledgedSellOrders(f.service,f.run,rows.orders,fee);
    for(const row of rows.orders) if(!processed.has(row.id))await f.api.reconcileOrder(f.service,f.run,row,fee);
    return f.api.runRows(f.service,f.run);
  });
}

export { fixture as createHundredFillFixture, reconcilePhase };

// Reuse the exact fixture in focused continuation tests without registering
// this file's tests a second time in that test worker.
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
test("100 simultaneous TP fills: actual transport + canonical SQL settle exactly once; foreign engine never adopts",async t=>{
  const f=await fixture(); t.after(()=>f.db.close());
  const rows=await reconcilePhase(f);
  const phaseMetrics=structuredClone(f.metrics),phaseWeights=f.totals();
  assert.ok(phaseWeights.private<=2200,"fresh BNB fee quote must not re-read full account state per fill");
  assert.ok(phaseMetrics.peakObservationsInFlight>1&&phaseMetrics.peakObservationsInFlight<=4,"canonical acknowledged-SELL worker pool is bounded at4");
  assert.equal(rows.orders.filter(row=>row.side==="SELL"&&row.status==="FILLED"&&row.trades_reconciled).length,100);
  assert.equal(rows.slots.filter(row=>Number(row.position_quantity)===0).length,100);
  await f.api.creditClosedSlots(f.service,f.run,rows,await f.state());
  await f.api.creditClosedSlots(f.service,f.run,await f.api.runRows(f.service,f.run),await f.state());
  const gains=await f.query(`select count(*)::int n from coinops.robot_v1_monthly_slot_gains`);
  assert.equal(gains[0].n,100);
  assert.deepEqual((await f.query(`select sum(gain_count)::int gains,sum(balance_brl)::numeric balance from coinops.robot_v1_live_slot_accounts where trading_engine_id='${id(4)}'`))[0],{gains:100,balance:"1132.99950000"});
  assert.equal(JSON.stringify(await f.query(`select * from coinops.robot_v1_live_slot_accounts where trading_engine_id='${id(5)}' order by slot_number`)),f.beforeSibling);
  const foreign={...engine,trading_engine_id:id(5),slot_count:25,executor_shard_id:"executor-01"};
  const own100=rows.orders.find(row=>row.slot_number===100&&row.side==="SELL");
  await assert.rejects(f.transport(foreign).queryOrder("SOLBRL",own100.client_order_id,own100.exchange_order_id),/EXECUTOR_ORDER_NOT_OWNED/);
  assert.equal((await f.query(`select count(*)::int n from coinops.robot_v1_live_fills`))[0].n,200);
  assert.equal((await f.query(`select count(*)::int n from coinops.robot_v1_strategy_decisions where result='COMPLETED' and action_type='CREATE_TP'`))[0].n,100);
  console.log(JSON.stringify({scenario:"100_ACTUAL_RECONCILIATION_PHASE",phaseWeights,phaseMetrics,
    settleWeights:f.totals(),settleMetrics:f.metrics,requests:f.requests.length,
    caveat:"Canonical observation/SQL settlement/metadata/registry. No real network latency/hardware/capacity certificate"}));
});

test("crash after fill37 durable sync resumes idempotently; confirmed fills/gains not duplicated",async t=>{
  const f=await fixture({crashAfterSync:37}); t.after(()=>f.db.close());
  await assert.rejects(reconcilePhase(f),/SIMULATED_PROCESS_EXIT_AFTER_DURABLE_SYNC/);
  const rows=await reconcilePhase(f);
  await f.api.creditClosedSlots(f.service,f.run,rows,await f.state());
  await f.api.creditClosedSlots(f.service,f.run,await f.api.runRows(f.service,f.run),await f.state());
  assert.equal((await f.query(`select count(*)::int n from coinops.robot_v1_live_fills`))[0].n,200);
  assert.equal((await f.query(`select count(*)::int n from coinops.robot_v1_monthly_slot_gains`))[0].n,100);
  assert.equal((await f.query(`select sum(gain_count)::int n from coinops.robot_v1_live_slot_accounts where trading_engine_id='${id(4)}'`))[0].n,100);
});

test("503 before exchange query retries through actual web transport; same100 fills with no Binance write",async t=>{
  const f=await fixture(); t.after(()=>f.db.close()); f.fail();
  const rows=await reconcilePhase(f);await f.api.creditClosedSlots(f.service,f.run,rows,await f.state());
  assert.equal((await f.query(`select count(*)::int n from coinops.robot_v1_live_fills`))[0].n,200);
  assert.equal((await f.query(`select count(*)::int n from coinops.robot_v1_monthly_slot_gains`))[0].n,100);
});

test("three intermittent503s share invocation retry pool and100fills converge without duplicates",async t=>{
  const f=await fixture({transientQuerySlots:[1,50,100]});t.after(()=>f.db.close());
  const rows=await reconcilePhase(f);
  await f.api.creditClosedSlots(f.service,f.run,rows,await f.state());
  assert.equal((await f.query(`select count(*)::int n from coinops.robot_v1_live_fills`))[0].n,200);
  assert.equal((await f.query(`select count(*)::int n from coinops.robot_v1_monthly_slot_gains`))[0].n,100);
  console.log(JSON.stringify({scenario:"THREE_INTERMITTENT_503S",weights:f.totals(),metrics:f.metrics}));
});

test("fourth distinct503 drains inflight workers; next invocation resumes remaining fills safely",async t=>{
  const f=await fixture({transientQuerySlots:[1,11,21,31]});t.after(()=>f.db.close());
  await assert.rejects(reconcilePhase(f),error=>error instanceof readErrors.LiveReadUnavailable&&error.path==="/v1/query-order");
  const sqlAfterReject=f.metrics.sql,requestsAfterReject=f.requests.length;
  await new Promise(resolve=>setTimeout(resolve,40));
  assert.equal(f.metrics.sql,sqlAfterReject,"no late DB mutation after worker failure drains");
  assert.equal(f.requests.length,requestsAfterReject,"no late exchange observation after drained failure");
  assert.equal(f.metrics.observationsInFlight,0);
  const durable=(await f.query(`select count(*)::int n from coinops.robot_v1_live_fills`))[0].n;
  assert.ok(durable>100&&durable<200,"partial already settled fills survive the failed observation");
  assert.equal((await f.query(`select count(*)::int n from coinops.robot_v1_monthly_slot_gains`))[0].n,0);
  const rows=await reconcilePhase(f);await f.api.creditClosedSlots(f.service,f.run,rows,await f.state());
  assert.equal((await f.query(`select count(*)::int n from coinops.robot_v1_live_fills`))[0].n,200);
  assert.equal((await f.query(`select count(*)::int n from coinops.robot_v1_monthly_slot_gains`))[0].n,100);
  assert.equal(JSON.stringify(await f.query(`select * from coinops.robot_v1_live_slot_accounts where trading_engine_id='${id(5)}' order by slot_number`)),f.beforeSibling);
});

test("crash after gain37 durable credit resumes remaining63; reinvestment/gain-count/monthly rows exactly once",async t=>{
  const f=await fixture({crashAfterCredit:37});t.after(()=>f.db.close());
  const rows=await reconcilePhase(f);
  await assert.rejects(f.api.creditClosedSlots(f.service,f.run,rows,await f.state()),/SIMULATED_PROCESS_EXIT_AFTER_DURABLE_CREDIT/);
  assert.equal((await f.query(`select count(*)::int n from coinops.robot_v1_monthly_slot_gains`))[0].n,37);
  await f.api.creditClosedSlots(f.service,f.run,await f.api.runRows(f.service,f.run),await f.state());
  assert.equal((await f.query(`select count(*)::int n from coinops.robot_v1_monthly_slot_gains`))[0].n,100);
  assert.equal((await f.query(`select sum(gain_count)::int n from coinops.robot_v1_live_slot_accounts where trading_engine_id='${id(4)}'`))[0].n,100);
});

test("75 simultaneous fills preserve25 resident TPs and sibling25 without recreation/cancellation",async t=>{
  const f=await fixture({fillCount:75});t.after(()=>f.db.close());
  const old=await f.query(`select * from coinops.robot_v1_live_orders where side='SELL' and slot_number>75 order by slot_number`);
  const rows=await reconcilePhase(f),state=await f.state();
  await f.api.ensureTakeProfits(f.service,f.run,rows,state);
  await f.api.creditClosedSlots(f.service,f.run,rows,state);
  assert.equal((await f.query(`select count(*)::int n from coinops.robot_v1_monthly_slot_gains`))[0].n,75);
  assert.deepEqual(await f.query(`select * from coinops.robot_v1_live_orders where side='SELL' and slot_number>75 order by slot_number`),old);
  assert.equal((await f.query(`select count(*)::int n from coinops.robot_v1_live_slots where position_quantity>0`))[0].n,25);
});

test("lease cannot be stolen or used after expiry; only one canonical NEXT BUY plan for100 physical slots",async t=>{
  const f=await fixture({fillCount:0,clockFollowsModel:false}); t.after(()=>f.db.close());
  assert.equal(await f.api.claim(f.service,f.run.id),null);
  await f.query(`update coinops.robot_v1_live_runs set lease_until=now()-interval '1 second' where id='${id(6)}'`);
  const row=(await f.api.runRows(f.service,f.run)).orders.find(row=>row.side==="SELL");
  // Changed observation forces sync under the expired lease; normal no-change
  // shortcut alone cannot authorize any financial mutation.
  row.status="PARTIALLY_FILLED";
  await assert.rejects(f.api.reconcileOrder(f.service,f.run,row),/COINOPS_LIVE_LEASE_LOST/);
  const claims=await Promise.all([f.api.claim(f.service,f.run.id),f.api.claim(f.service,f.run.id)]);
  assert.equal(claims.filter(Boolean).length,1);
  const candidates=Array.from({length:100},(_,i)=>({id:`slot-${i+1}`,slotNumber:i+1,operationSequence:1,buyPrice:500*.99**i,
    balanceQuote:11,operationalRank:i+1,monthlyTargetReached:false,state:"PLANNED"}));
  const plan=strategy.planStrategyNextEntry({asset:"SOL",cycleId:f.run.id,observedAt:new Date().toISOString(),quoteAsset:"BRL",slotCount:100},candidates,495);
  assert.equal(plan.decision.action_type,"ARM_NEXT_BUY");
  assert.equal(plan.decisions,undefined,"canonical plan returns one entry decision, not100 orders");
});

test("120s bounded progress uses actual SQL checkpoint;37 credits yield, next invocation finishes63 without fake freshness",async t=>{
  const f=await fixture({progressCheckpoint:true,clockFollowsModel:false});t.after(()=>f.db.close());
  const rows=await reconcilePhase(f);
  const tooOld=f.clockNow()-120001;
  assert.equal(await f.api.checkpointLargeEngineProgress(f.service,f.run,f.clockNow(),"CREDIT_SLOTS"),false);
  assert.equal(await f.api.checkpointLargeEngineProgress(f.service,f.run,f.clockNow(),"CREDIT_SLOTS",true),true,
    "concentrated settlement can checkpoint immediately after protection, before entering gain/new-order phase");
  const first=(await f.query(`select reconciliation_checkpoint,last_reconciled_at from coinops.robot_v1_live_runs where id='${id(6)}'`))[0];
  assert.equal(first.last_reconciled_at,null);
  assert.equal(first.reconciliation_checkpoint.slot_count,100);
  assert.equal(first.reconciliation_checkpoint.settled_orders,200);
  assert.equal(first.reconciliation_checkpoint.credited_gains,0);
  assert.equal(first.reconciliation_checkpoint.contract,"LARGE_ENGINE_PROGRESS_V1");
  assert.equal(await f.api.checkpointLargeEngineProgress(f.service,f.run,tooOld,"CREDIT_SLOTS"),true);
  assert.deepEqual((await f.query(`select reconciliation_checkpoint from coinops.robot_v1_live_runs where id='${id(6)}'`))[0].reconciliation_checkpoint,
    first.reconciliation_checkpoint,"unchanged work must not manufacture new observed_at");
  let completed=0;
  const yielded=await f.api.creditClosedSlots(f.service,f.run,rows,await f.state(),async()=>{
    completed++;
    return completed===37 ? f.api.checkpointLargeEngineProgress(f.service,f.run,f.clockNow()-120001,"CREDIT_SLOTS") : false;
  });
  assert.equal(yielded,true);assert.equal(completed,37);
  const second=(await f.query(`select reconciliation_checkpoint,last_reconciled_at from coinops.robot_v1_live_runs where id='${id(6)}'`))[0];
  assert.equal(second.last_reconciled_at,null);assert.equal(second.reconciliation_checkpoint.credited_gains,37);
  assert.equal(second.reconciliation_checkpoint.started_at,first.reconciliation_checkpoint.started_at);
  const nextInvocationStarted=f.clockNow();
  const finished=await f.api.creditClosedSlots(f.service,f.run,await f.api.runRows(f.service,f.run),await f.state(),
    ()=>f.api.checkpointLargeEngineProgress(f.service,f.run,nextInvocationStarted,"CREDIT_SLOTS"));
  assert.equal(finished,false);
  assert.equal((await f.query(`select count(*)::int n from coinops.robot_v1_monthly_slot_gains`))[0].n,100);
  assert.equal((await f.query(`select sum(gain_count)::int n from coinops.robot_v1_live_slot_accounts where trading_engine_id='${id(4)}'`))[0].n,100);
  await f.api.release(f.service,f.run,null,true);
  const final=(await f.query(`select reconciliation_checkpoint,last_reconciled_at,lease_owner from coinops.robot_v1_live_runs where id='${id(6)}'`))[0];
  assert.equal(final.reconciliation_checkpoint,null);assert.ok(final.last_reconciled_at);assert.equal(final.lease_owner,null);
  assert.equal(JSON.stringify(await f.query(`select * from coinops.robot_v1_live_slot_accounts where trading_engine_id='${id(5)}' order by slot_number`)),f.beforeSibling);
});

test("progress never yields before TP protection or complete fill reconciliation",async t=>{
  const f=await fixture({progressCheckpoint:true,clockFollowsModel:false,fillCount:99});t.after(()=>f.db.close());
  await reconcilePhase(f);
  await f.query(`update coinops.robot_v1_live_orders set status='CANCELED' where side='SELL' and slot_number=100`);
  await assert.rejects(f.api.checkpointLargeEngineProgress(f.service,f.run,f.clockNow()-120001,"CREDIT_SLOTS"),/COINOPS_LIVE_OPEN_WITHOUT_RESIDENT_TP/);
  assert.equal((await f.query(`select reconciliation_checkpoint from coinops.robot_v1_live_runs where id='${id(6)}'`))[0].reconciliation_checkpoint,null);
  await f.query(`update coinops.robot_v1_live_orders set status='NEW' where side='SELL' and slot_number=100`);
  await f.query(`update coinops.robot_v1_live_orders set trades_reconciled=false where side='SELL' and slot_number=1`);
  await assert.rejects(f.api.checkpointLargeEngineProgress(f.service,f.run,f.clockNow()-120001,"CREDIT_SLOTS"),/COINOPS_LIVE_RECONCILIATION_PROGRESS_UNSETTLED/);
  assert.equal((await f.query(`select reconciliation_checkpoint from coinops.robot_v1_live_runs where id='${id(6)}'`))[0].reconciliation_checkpoint,null);
});

test("600ms REST/150ms SQL sensitivity model settles100 TP observations with four workers",async t=>{
  const f=await fixture({sqlLatencyMs:150,exchangeLatencyMs:600,pacedLatencyScale:10});t.after(()=>f.db.close());
  const rows=await reconcilePhase(f);
  assert.equal(rows.orders.filter(row=>row.side==="SELL"&&row.trades_reconciled&&row.status==="FILLED").length,100);
  assert.ok(f.metrics.peakObservationsInFlight>1&&f.metrics.peakObservationsInFlight<=4);
  console.log(JSON.stringify({scenario:"100_TP_600MS_REST_150MS_SQL_PACED_MODEL",scale:10,metrics:f.metrics,weights:f.totals(),
    caveat:"Fixed simulated I/O delays scaled10; notebook CPU and timers included. Not Production latency/performance certification"}));
});

test("sync rejects an expired lease using wall clock even inside a long transaction",async t=>{
  const f=await fixture({clockFollowsModel:false});t.after(()=>f.db.close());
  const row=(await f.api.runRows(f.service,f.run)).orders.find(row=>row.side==="SELL");
  await f.query("begin");
  try{
    await f.query(`update coinops.robot_v1_live_runs set lease_until=clock_timestamp()+interval '20 milliseconds' where id='${id(6)}'`);
    await new Promise(resolve=>setTimeout(resolve,50));
    await assert.rejects(f.service.rpc("sync_robot_v1_live_order",{p_order_id:row.id,p_exchange_order_id:row.exchange_order_id,
      p_status:"NEW",p_executed_quantity:0,p_cumulative_quote:0,p_trades:[],p_bnb_brl_price:null,p_bnb_brl_observed_at:null,p_lease_owner:f.run.lease_owner}),/COINOPS_LIVE_LEASE_BLOCKED/);
  }finally{await f.query("rollback");}
});
}
