import test from "node:test";
import * as slotTopology from "./engine-slot-topology.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as readErrors from "./live-read-error.ts";
import { readLiveExposure } from "./live-exposure-read.ts";
import { resolveAccountBudgetAlert, AccountBudgetAlertResolutionError } from "./live-account-budget-alert.ts";
import { liveEngineOrderPrefix } from "./robot-v1-live-cycle.ts";

/** Execute the real advanceOnce catch/checkpoint/release logic. Financial work
 * and network are replaced with fixtures; an unexpected dependency cannot trade. */
function fixture(error:Error, oldFirstSeen?:string, engineId="engine-a", registryFailure=false,
  metadata?: { next?: string; writeFailure?: "transient" | "permission"; absent?: boolean }) {
  const writes:Array<{table:string,data:Record<string,unknown>,filters:Record<string,unknown>}>=[];
  const effects = { arm: 0, reconcileOrder: 0, protect: 0, snapshot: 0 };
  const run={id:`run-${engineId}`,trading_engine_id:engineId,exchange_account_id:"same-account",operator_id:"operator",
    tenant_id:"tenant",product_id:"product",user_id:"user",asset:"SOL",symbol:"SOLBRL",quote_asset:"BRL",strategy_version:"fixture",lease_owner:"lease",
    engine: { trading_engine_id: engineId, exchange_account_id: "same-account", base_asset: "SOL",
      legacy_compatible: false, executor_shard_id: "executor-03" } };
  const order = { ...run, id: "resident-buy", run_id: run.id, slot_id: "slot-8", operation_sequence: 1,
    side: "BUY", status: "NEW", executed_quantity: 0, trades_reconciled: true,
    client_order_id: `${liveEngineOrderPrefix(run.engine)}8-B-fixture`, strategy_decision_id: "decision-8",
    exchange_order_id: "binance-next-buy-8" };
  const budgetAlert = { ...run, id: "budget-warning", alert_key: `LIVE_RUN:${run.id}:ACCOUNT_ORDER_BUDGET`,
    code: "COINOPS_ACCOUNT_ORDER_BUDGET_UNKNOWN", first_seen_at: "2026-10-14T00:00:00Z",
    last_seen_at: "2026-10-14T00:01:00Z", resolved_at: null,
    details: { run_id: run.id, side: "BUY", client_order_id: order.client_order_id } };
  const service={from(table:string){
    const filters:Record<string,unknown>={};let data:Record<string,unknown>|null=null;
    const result=()=>{
      if(data)writes.push({table,data,filters:{...filters}});
      if (metadata && table === "robot_v1_live_alerts" && filters.alert_key === budgetAlert.alert_key) {
        if (!data) return { data: metadata.absent ? [] : [budgetAlert], error: null };
        if (metadata.writeFailure) return { data: null, error: { code: metadata.writeFailure === "permission"
          ? "42501" : "PGRST001", message: "Private provider payload must not escape" },
          status: metadata.writeFailure === "permission" ? 403 : 503 };
        return { data: [{ id: budgetAlert.id }], error: null };
      }
      if (metadata && table === "robot_v1_strategy_decisions") return { data: [{ ...run,
        decision_id: order.strategy_decision_id, environment: "REAL", cycle_id: run.id,
        slot_id: order.slot_id, operation_sequence: 1, action_type: "ARM_NEXT_BUY", result: "COMPLETED",
        completed_at: "2026-10-14T00:02:00Z", exchange_ack_at: "2026-10-14T00:02:00Z",
        observed_next_state: { exchange_order_id: order.exchange_order_id } }], error: null };
      if (metadata && table === "account_order_budget_reservations") return { data: [{ ...run,
        executor_shard_id: "executor-03", client_order_id: order.client_order_id,
        reserved_at: "2026-10-14T00:01:00Z", acknowledged_at: "2026-10-14T00:02:00Z" }], error: null };
      if (metadata && table === "robot_v1_live_runs" && data?.lease_until) return { data: { id: run.id }, error: null };
      return {error:null,data:oldFirstSeen?{first_seen_at:oldFirstSeen}:null};
    };
    const chain={select:()=>chain,update:(v:Record<string,unknown>)=>{data=v;return chain;},upsert:(v:Record<string,unknown>)=>{data=v;return chain;},
      eq:(k:string,v:unknown)=>{filters[k]=v;return chain;},is:(k:string,v:unknown)=>{filters[k]=v;return chain;},
      limit:()=>chain, abortSignal:()=>chain, gt:()=>chain,
      maybeSingle:async()=>result(),then:(done:(v:unknown)=>unknown)=>Promise.resolve(result()).then(done)};
    return chain;
  }};
  const deps:Record<string,unknown>={
    "./engine-slot-topology": slotTopology,
    "./live-read-error":readErrors,
    "./live-account-budget-alert": { resolveAccountBudgetAlert, AccountBudgetAlertResolutionError },
    "./live-exposure-read":{readLiveExposure},
    "../supabase/service-role":{createServiceRoleClient:()=>service},
    "./strategy-engine":{STRATEGY_VERSION:"fixture"},
    "./live-executor-transport":{readLiveExecutorState:async()=>{
      effects.snapshot++;
      if (!metadata) throw error;
      return { open_orders: [], filters: { quantityStep: .001 } };
    }},
    "./account-order-budget-server":{AccountOrderBudgetHold:class extends Error{}},
  };
  const compiled=ts.transpileModule(readFileSync(new URL("./robot-v1-live-server.ts",import.meta.url),"utf8"),
    {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const exports:Record<string,unknown>={};
  new Function("require","exports","fixtureRun","registryError","metadata","fixtureOrder","effects",compiled+`
    assertScope=()=>{}; claim=async()=>fixtureRun; validateRunEngine=async()=>{if(registryError)throw registryError;};
    runRows=async()=>({slots:[],orders:metadata?[fixtureOrder]:[],accounts:[]}); assertLiveResidentPrices=()=>{};
    if (metadata) {
      reconcileOrder=async()=>{effects.reconcileOrder++;};
      ensureTakeProfits=async()=>{effects.protect++;}; creditClosedSlots=async()=>{};
      recycleClosedSlots=async()=>{}; assertAllPositionsProtected=async()=>{};
      applyPendingStrategyUpdate=async()=>{}; configUpdatePending=async()=>false;
      restartClosedCycle=async()=>null; applyAthTransition=async()=>{};
      armNextEntry=async()=>{effects.arm++;return metadata.next??"HIGHEST_PRIORITY_BUY_ALREADY_RESIDENT";};
      confirmCapitalRefreshes=async()=>{};
    }
    exports.testAdvance=()=>advanceLiveRunOnce(fixtureRun.id,"LIVE_CRON");
  `)((name:string)=>deps[name]??{},exports,run,registryFailure?error:null,metadata,order,effects);
  return {execute:exports.testAdvance as ()=>Promise<{status:string}>,writes,run,effects};
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

test("typed restriction read outage checkpoints the normal engine flow; prolonged outage blocks only that engine", async () => {
  const error = new readErrors.LiveReadUnavailable("EXECUTOR_PRODUCTION_PERMISSION_READ_UNAVAILABLE", "/v1/state", 4, 503);
  for (const engineId of ["engine-a", "engine-b"]) {
    const transient = fixture(error, undefined, engineId);
    assert.equal((await transient.execute()).status, "RETRY");
    assert.ok(transient.writes.every(write => !write.data.kill_switch));
    const alert = transient.writes.find(write => write.table === "robot_v1_live_alerts")!;
    assert.equal(alert.data.trading_engine_id, engineId);
    assert.equal(alert.data.code, "COINOPS_LIVE_TRANSIENT_EXECUTOR_READ");
    assert.equal((alert.data.details as Record<string, unknown>).root_code, error.code);
    assert.equal((alert.data.details as Record<string, unknown>).read_attempts, 4);
    const release = transient.writes.find(write => write.table === "robot_v1_live_runs")!;
    assert.equal(release.filters.id, transient.run.id);
    assert.equal(release.data.last_error, null);
    assert.equal(release.data.last_reconciled_at, undefined);
  }
  const stale = fixture(error, new Date(Date.now() - 301000).toISOString(), "engine-b");
  await assert.rejects(stale.execute(), /COINOPS_LIVE_EXECUTOR_READ_STALE/);
  assert.ok(stale.writes.filter(write => write.table === "trading_engines")
    .every(write => write.filters.id === "engine-b" && write.data.kill_switch === true));
  const denied = fixture(new readErrors.ExecutorHttpError("EXECUTOR_PRODUCTION_PERMISSION_DENIED", 503));
  await assert.rejects(denied.execute(), /COINOPS_LIVE_RECONCILE_ORDERS_FAILED/);
  assert.ok(denied.writes.some(write => write.table === "trading_engines" && write.data.kill_switch === true));
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

test("typed engine binding GET exhaustion remains a scoped read checkpoint with its exact diagnostic path", async () => {
  const error = new readErrors.LiveReadUnavailable("COINOPS_EXECUTOR_BINDING_READ_UNAVAILABLE",
    "executor_binding/engine", 2, 503, "PGRST001");
  const transient = fixture(error, undefined, "engine-b");
  assert.equal((await transient.execute()).status, "RETRY");
  assert.ok(transient.writes.every(write => !write.data.kill_switch));
  const alert = transient.writes.find(write => write.table === "robot_v1_live_alerts")!;
  assert.equal(alert.data.trading_engine_id, "engine-b");
  assert.deepEqual(alert.data.details, { run_id: transient.run.id, stage: "RECONCILE_ORDERS", source: "ENGINE",
    root_code: error.code, read_path: "executor_binding/engine", read_attempts: 2, http_status: 503, provider_code: "PGRST001" });
  const stale = fixture(error, new Date(Date.now() - 301000).toISOString(), "engine-b");
  await assert.rejects(stale.execute(), /COINOPS_LIVE_EXECUTOR_READ_STALE/);
  assert.ok(stale.writes.filter(write => write.table === "trading_engines")
    .every(write => write.filters.id === "engine-b" && write.data.kill_switch === true));
});

test("normal advance performs no empty budget-alert UPDATE when the exact metadata target is absent", async () => {
  const f = fixture(new Error("unused"), undefined, "engine-b", false, { absent: true });
  assert.equal((await f.execute()).status, "OK");
  assert.equal(f.effects.arm, 1);
  assert.equal(f.effects.reconcileOrder, 1);
  assert.equal(f.writes.some(write => write.table === "robot_v1_live_alerts"
    && write.filters.alert_key === `LIVE_RUN:${f.run.id}:ACCOUNT_ORDER_BUDGET`), false);
  assert.equal(f.writes.some(write => write.data.kill_switch), false);
  assert.equal(f.writes.find(write => write.table === "robot_v1_live_runs")!.data.last_error, null);
});

test("normal balance/fee/budget HOLD does not clear an existing budget warning or repeat financial work", async () => {
  for (const next of ["QUOTE_BALANCE_HOLD", "BNB_FEE_BALANCE_HOLD", "KILL_SWITCH", "ENTRY_FILLED_DURING_REPLACEMENT"]) {
    const f = fixture(new Error("unused"), undefined, "engine-b", false, { next });
    assert.equal((await f.execute()).status, "OK");
    assert.equal(f.effects.arm, 1);
    assert.equal(f.effects.reconcileOrder, 1);
    assert.equal(f.writes.some(write => write.table === "robot_v1_live_alerts"
      && write.filters.alert_key === `LIVE_RUN:${f.run.id}:ACCOUNT_ORDER_BUDGET`), false);
    assert.equal(f.writes.some(write => write.data.kill_switch), false);
  }
});

test("normal advance metadata CAS 503 preserves diagnostic evidence without retrying its financial step", async () => {
  const f = fixture(new Error("unused"), undefined, "engine-b", false, { writeFailure: "transient" });
  await assert.rejects(f.execute(), /COINOPS_LIVE_ACCOUNT_BUDGET_ALERT_RESOLVE_RETRY/);
  assert.equal(f.effects.arm, 1, "metadata retry cannot repeat entry planning/dispatch");
  assert.equal(f.effects.reconcileOrder, 1, "metadata retry cannot replay order reconciliation");
  assert.equal(f.effects.protect, 1, "metadata retry cannot replay TP creation");
  const attempts = f.writes.filter(write => write.table === "robot_v1_live_alerts"
    && write.filters.alert_key === `LIVE_RUN:${f.run.id}:ACCOUNT_ORDER_BUDGET`);
  assert.equal(attempts.length, 2, "only exact metadata CAS receives a bounded retry");
  assert.equal(attempts[0].data.resolved_at, attempts[1].data.resolved_at, "one immutable resolution token");
  const critical = f.writes.find(write => write.table === "robot_v1_live_alerts"
    && write.data.alert_key === `LIVE_RUN:${f.run.id}:CRITICAL`)!;
  assert.equal(critical.data.trading_engine_id, "engine-b");
  assert.deepEqual(critical.data.details, { run_id: f.run.id, stage: "RESOLVE_ACCOUNT_BUDGET_ALERT", source: "ENGINE",
    root_code: "COINOPS_LIVE_ACCOUNT_BUDGET_ALERT_RESOLVE_RETRY", metadata_path: "alert/account_budget/resolve",
    metadata_attempts: 2, http_status: 503, provider_code: "PGRST001" });
  assert.ok(f.writes.filter(write => write.table === "trading_engines")
    .every(write => write.filters.id === "engine-b" && write.data.kill_switch));
  assert.equal(f.writes.some(write => ["robot_v1_live_orders", "robot_v1_live_slots", "robot_v1_live_slot_accounts",
    "robot_v1_strategy_decisions", "account_order_budget_reservations"].includes(write.table)), false);
  const release = f.writes.find(write => write.table === "robot_v1_live_runs" && write.data.lease_owner === null)!;
  assert.equal(release.data.last_error, "COINOPS_LIVE_ACCOUNT_BUDGET_ALERT_RESOLVE_RETRY");
  assert.equal(release.data.last_reconciled_at, undefined, "metadata failure cannot fabricate completed freshness");
  assert.equal(JSON.stringify(critical).includes("Private provider payload"), false);
});

test("metadata permission failure is fail-closed and never converted into GET or financial retry", async () => {
  const f = fixture(new Error("unused"), undefined, "engine-a", false, { writeFailure: "permission" });
  await assert.rejects(f.execute(), /COINOPS_LIVE_ACCOUNT_BUDGET_ALERT_WRITE_FAILED/);
  assert.equal(f.effects.arm, 1);
  assert.equal(f.effects.reconcileOrder, 1);
  assert.equal(f.writes.filter(write => write.table === "robot_v1_live_alerts"
    && write.filters.alert_key === `LIVE_RUN:${f.run.id}:ACCOUNT_ORDER_BUDGET`).length, 1);
  const critical = f.writes.find(write => write.table === "robot_v1_live_alerts" && write.data.severity === "CRITICAL")!;
  assert.equal((critical.data.details as Record<string, unknown>).metadata_path, "alert/account_budget/resolve");
  assert.equal((critical.data.details as Record<string, unknown>).provider_code, "42501");
  assert.equal(f.writes.some(write => write.data.code === "COINOPS_LIVE_TRANSIENT_LEDGER_READ"), false);
  assert.equal(f.writes.some(write => write.data.kill_switch === false), false);
});
