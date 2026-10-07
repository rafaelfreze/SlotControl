import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as readErrors from "./live-read-error.ts";

/** Execute the real advanceOnce catch/checkpoint/release logic. Financial work
 * and network are replaced with fixtures; an unexpected dependency cannot trade. */
function fixture(error:Error, oldFirstSeen?:string, engineId="engine-a", registryFailure=false) {
  const writes:Array<{table:string,data:Record<string,unknown>,filters:Record<string,unknown>}>=[];
  const run={id:`run-${engineId}`,trading_engine_id:engineId,exchange_account_id:"same-account",operator_id:"operator",
    tenant_id:"tenant",product_id:"product",user_id:"user",asset:"SOL",symbol:"SOLBRL",quote_asset:"BRL",strategy_version:"fixture",lease_owner:"lease"};
  const service={from(table:string){
    const filters:Record<string,unknown>={};let data:Record<string,unknown>|null=null;
    const result=()=>{
      if(data)writes.push({table,data,filters:{...filters}});
      return {error:null,data:oldFirstSeen?{first_seen_at:oldFirstSeen}:null};
    };
    const chain={select:()=>chain,update:(v:Record<string,unknown>)=>{data=v;return chain;},upsert:(v:Record<string,unknown>)=>{data=v;return chain;},
      eq:(k:string,v:unknown)=>{filters[k]=v;return chain;},is:(k:string,v:unknown)=>{filters[k]=v;return chain;},
      maybeSingle:async()=>result(),then:(done:(v:unknown)=>unknown)=>Promise.resolve(result()).then(done)};
    return chain;
  }};
  const deps:Record<string,unknown>={
    "./live-read-error":readErrors,
    "../supabase/service-role":{createServiceRoleClient:()=>service},
    "./strategy-engine":{STRATEGY_VERSION:"fixture"},
    "./live-executor-transport":{readLiveExecutorState:async()=>{throw error;}},
    "./account-order-budget-server":{AccountOrderBudgetHold:class extends Error{}},
  };
  const compiled=ts.transpileModule(readFileSync(new URL("./robot-v1-live-server.ts",import.meta.url),"utf8"),
    {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const exports:Record<string,unknown>={};
  new Function("require","exports","fixtureRun","registryError",compiled+`
    assertScope=()=>{}; claim=async()=>fixtureRun; validateRunEngine=async()=>{if(registryError)throw registryError;};
    runRows=async()=>({slots:[],orders:[],accounts:[]}); assertLiveResidentPrices=()=>{};
    exports.testAdvance=()=>advanceLiveRunOnce(fixtureRun.id,"LIVE_CRON");
  `)((name:string)=>deps[name]??{},exports,run,registryFailure?error:null);
  return {execute:exports.testAdvance as ()=>Promise<{status:string}>,writes,run};
}

test("exhausted observation resumes through normal cron checkpoint, never Watchdog or a financial gate",async()=>{
  for(const id of ["engine-a","engine-b"]){
    const f=fixture(new readErrors.LiveReadUnavailable("EXECUTOR_ORDER_QUERY_FAILED","/v1/query-order",4,503),undefined,id);
    assert.equal((await f.execute()).status,"RETRY");
    assert.ok(f.writes.every(w=>!w.data.kill_switch));
    const warning=f.writes.find(w=>w.table==="robot_v1_live_alerts")!;
    assert.equal(warning.data.trading_engine_id,id);
    assert.deepEqual(warning.data.details,{run_id:f.run.id,stage:"RECONCILE_ORDERS",source:"ENGINE",root_code:"EXECUTOR_ORDER_QUERY_FAILED",read_path:"/v1/query-order",read_attempts:4,http_status:503});
    const release=f.writes.find(w=>w.table==="robot_v1_live_runs")!;
    assert.equal(release.data.last_error,null);assert.equal(release.data.last_reconciled_at,undefined);
    assert.equal(release.filters.id,f.run.id);assert.equal(release.filters.lease_owner,"lease");
  }
});

test("registry timeout before any exchange access checkpoints RETRY and does not claim freshness", async () => {
  for (const engineId of ["engine-a", "engine-b"]) {
    const f = fixture(new readErrors.LiveReadUnavailable("COINOPS_OPERATOR_REGISTRY_READ_TIMEOUT",
      "registry/trading_engines", 2), undefined, engineId, true);
    assert.equal((await f.execute()).status, "RETRY");
    assert.ok(f.writes.every(w => !w.data.kill_switch));
    const alert = f.writes.find(w => w.table === "robot_v1_live_alerts")!;
    assert.equal(alert.data.trading_engine_id, engineId);
    assert.equal((alert.data.details as Record<string, unknown>).stage, "LOAD_LEDGER");
    assert.equal((alert.data.details as Record<string, unknown>).read_attempts, 2);
    assert.equal(f.writes.find(w => w.table === "robot_v1_live_runs")!.data.last_reconciled_at, undefined);
  }
});

test("persistent registry outage blocks only the affected engine; permission errors never become RETRY", async () => {
  const f = fixture(new readErrors.LiveReadUnavailable("COINOPS_OPERATOR_REGISTRY_READ_TIMEOUT",
    "registry/trading_engines", 2), new Date(Date.now() - 301000).toISOString(), "engine-b", true);
  await assert.rejects(f.execute(), /COINOPS_LIVE_EXECUTOR_READ_STALE/);
  assert.ok(f.writes.some(w => w.table === "trading_engines" && w.filters.id === "engine-b" && w.data.kill_switch));
  const denied = fixture(new Error("COINOPS_OPERATOR_SCOPE_DENIED"), undefined, "engine-a", true);
  await assert.rejects(denied.execute(), /COINOPS_OPERATOR_SCOPE_DENIED/);
  assert.ok(denied.writes.some(w => w.table === "trading_engines" && w.filters.id === "engine-a" && w.data.kill_switch));
});
test("persistent observation outage remains engine-local fail-closed and keeps root evidence",async()=>{
  const f=fixture(new readErrors.LiveReadUnavailable("EXECUTOR_ORDER_QUERY_FAILED","/v1/query-order",4,503),new Date(Date.now()-301000).toISOString());
  await assert.rejects(f.execute(),/COINOPS_LIVE_EXECUTOR_READ_STALE/);
  assert.ok(f.writes.some(w=>w.table==="trading_engines"&&w.filters.id==="engine-a"&&w.data.kill_switch===true));
  assert.equal(f.writes.find(w=>w.table==="robot_v1_live_runs")!.data.last_reconciled_at,undefined);
});
test("ambiguous write-like error is not converted to an observation retry by its message",async()=>{
  const f=fixture(new Error("EXECUTOR_BINANCE_RESULT_UNKNOWN"));
  await assert.rejects(f.execute(),/COINOPS_LIVE_RECONCILE_ORDERS_FAILED/);
  assert.ok(f.writes.some(w=>w.data.kill_switch===true));
});
test("snapshot fill race stays retryable without claiming completed reconciliation",async()=>{
  const f=fixture(new Error("COINOPS_LIVE_FILLED_DURING_SNAPSHOT"));
  assert.equal((await f.execute()).status,"RETRY");
  assert.equal(f.writes.length,1); assert.equal(f.writes[0].data.last_reconciled_at,undefined);
});

test("ledger outage uses its own diagnostic code, durable retry and engine-local prolonged block", async () => {
  const error = new readErrors.LiveReadUnavailable("COINOPS_LIVE_LEDGER_READ_UNAVAILABLE", "ledger/orders", 2, 504, "PGRST003");
  const transient = fixture(error);
  assert.equal((await transient.execute()).status, "RETRY");
  assert.ok(transient.writes.every(w => !w.data.kill_switch));
  const alert = transient.writes.find(w => w.table === "robot_v1_live_alerts")!;
  assert.equal(alert.data.code, "COINOPS_LIVE_TRANSIENT_LEDGER_READ");
  assert.equal((alert.data.details as Record<string, unknown>).provider_code, "PGRST003");
  assert.equal(transient.writes.find(w => w.table === "robot_v1_live_runs")!.data.last_reconciled_at, undefined);
  const stale = fixture(error, new Date(Date.now() - 301000).toISOString(), "engine-b");
  await assert.rejects(stale.execute(), /COINOPS_LIVE_LEDGER_READ_STALE/);
  assert.ok(stale.writes.filter(w => w.table === "trading_engines")
    .every(w => w.filters.id === "engine-b" && w.data.kill_switch === true));
});
