import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import * as slotTopology from "./engine-slot-topology.ts";

type Row = Record<string, any>;
const NOW = Date.parse("2026-10-16T20:00:00Z");

/** Test the actual checkpoint orchestration, with no credentials, environment
 * or remote clients. The independent SQL harness verifies the RPC's guards. */
function fixture(options: { count?: number; pendingFill?: boolean; lostLease?: boolean;
  unprotected?: boolean; rpcError?: string; foreignRpc?: boolean } = {}) {
  const calls: string[] = [], releases: Row[] = [];
  const run: Row = { id: "run-a", operator_id: "operator-a", exchange_account_id: "account-a",
    trading_engine_id: "engine-a", symbol: "SOLBRL", quote_asset: "BRL", tenant_id: "tenant",
    slot_count: options.count ?? 100, engine: { executor_shard_id: "executor-03", slot_count: options.count ?? 100 },
    last_reconciled_at: "2026-10-16T19:59:00Z", lease_owner: "lease-a", lease_until: "2026-10-16T20:03:00Z" };
  const checkpoint: Row = { contract: "LARGE_ENGINE_PROGRESS_V1", run_id: run.id,
    operator_id: run.operator_id, exchange_account_id: run.exchange_account_id,
    trading_engine_id: options.foreignRpc ? "foreign" : run.trading_engine_id, symbol: run.symbol,
    quote_asset: run.quote_asset, executor_shard_id: "executor-03", slot_count: run.slot_count,
    phase: "CREDIT_SLOTS", started_at: "2026-10-16T19:56:00Z", observed_at: new Date(NOW).toISOString(),
    settled_orders: 200, credited_gains: 100, operation_total: 100 };
  const service = { rpc: async (name: string, args: Row) => {
    calls.push("rpc"); assert.equal(name, "record_live_reconciliation_checkpoint");
    assert.deepEqual(args, { p_run_id: run.id, p_lease_owner: run.lease_owner,
      p_phase: "CREDIT_SLOTS", p_quantity_step: .001 });
    return { data: options.rpcError ? null : checkpoint,
      error: options.rpcError ? { message: options.rpcError } : null };
  }, from: (name: string) => {
    assert.equal(name, "robot_v1_live_runs");
    const query = { update: (values: Row) => { releases.push(values); return query; },
      eq: () => query, then: (resolve: (value: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve) };
    return query;
  } };
  const deps: Row = { "./engine-slot-topology": slotTopology,
    "./live-executor-transport": { readLiveExecutorState: async () => {
      calls.push("state"); return { filters: { quantityStep: .001 }, observed_at: new Date(NOW).toISOString() };
    } }, "./robot-v1-live-cycle": { LIVE_TERMINAL_ORDER_STATUSES: new Set(["FILLED"]) } };
  class Clock extends Date { static now() { return NOW; } }
  const source = readFileSync(new URL("./robot-v1-live-server.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022 } }).outputText;
  const runtime: Row = {};
  new Function("require", "exports", "Date", "calls", "options", `${compiled}
    renewLease=async()=>{calls.push('lease');if(options.lostLease)throw new Error('COINOPS_LIVE_LEASE_LOST');};
    runRows=async()=>{calls.push('ledger');return {orders:options.pendingFill?[{executed_quantity:1,trades_reconciled:false}]:[]};};
    assertAllPositionsProtected=async()=>{calls.push('protection');if(options.unprotected)throw new Error('COINOPS_LIVE_OPEN_WITHOUT_RESIDENT_TP');};
    Object.assign(exports,{checkpointLargeEngineProgress,release});`)(
    (name: string) => deps[name] ?? {}, runtime, Clock, calls, options);
  return { run, checkpoint, calls, releases,
    checkpointNow: (elapsed: number, force = false) => runtime.checkpointLargeEngineProgress(service, run, NOW - elapsed, "CREDIT_SLOTS", force),
    release: (completed: boolean) => runtime.release(service, run, null, completed) };
}

test("legacy engines and a large engine before its deadline never add a checkpoint or protection read", async () => {
  for (const [count, elapsed] of [[25, 999_999], [100, 119_999]]) {
    const f = fixture({ count }); assert.equal(await f.checkpointNow(elapsed), false);
    assert.deepEqual(f.calls, []);
  }
});

test("checkpoint requires fresh protection proof and a renewed exact lease before its independent SQL guard", async () => {
  const f = fixture(); assert.equal(await f.checkpointNow(120_000), true);
  assert.deepEqual(f.calls, ["lease", "ledger", "state", "protection", "lease", "rpc"]);
  assert.deepEqual(f.run.reconciliation_checkpoint, f.checkpoint);
});

test("a concentrated settlement can checkpoint before the deadline but cannot bypass protection or affect legacy25", async () => {
  const f = fixture(); assert.equal(await f.checkpointNow(500, true), true);
  assert.deepEqual(f.calls, ["lease", "ledger", "state", "protection", "lease", "rpc"]);
  const legacy = fixture({ count: 25 });
  assert.equal(await legacy.checkpointNow(500, true), false); assert.deepEqual(legacy.calls, []);
  const paused = fixture(); paused.run.status = "PAUSED";
  assert.equal(await paused.checkpointNow(150_000, true), false); assert.deepEqual(paused.calls, []);
  const unsafe = fixture({ unprotected: true });
  await assert.rejects(unsafe.checkpointNow(500, true), /OPEN_WITHOUT_RESIDENT_TP/);
  assert.equal(unsafe.calls.includes("rpc"), false);
});

test("lost lease, missing TP and an unsettled fill never persist a healthy progress checkpoint", async () => {
  for (const options of [{ lostLease: true }, { unprotected: true }, { pendingFill: true }]) {
    const f = fixture(options);
    await assert.rejects(f.checkpointNow(120_000), /LEASE_LOST|OPEN_WITHOUT_RESIDENT_TP|PROGRESS_UNSETTLED/);
    assert.equal(f.calls.includes("rpc"), false);
    assert.equal(f.run.reconciliation_checkpoint, undefined);
  }
});

test("a foreign SQL result is rejected and a stale episode retains its exact fail-closed code", async () => {
  const foreign = fixture({ foreignRpc: true });
  await assert.rejects(foreign.checkpointNow(120_000), /COINOPS_LIVE_LARGE_ENGINE_PROGRESS_UNSAFE/);
  assert.equal(foreign.run.reconciliation_checkpoint, undefined);
  const stale = fixture({ rpcError: "COINOPS_LIVE_LARGE_ENGINE_PROGRESS_STALE" });
  await assert.rejects(stale.checkpointNow(120_000), /COINOPS_LIVE_LARGE_ENGINE_PROGRESS_STALE/);
});

test("yield never manufactures last_reconciled_at; only a completed normal run clears the checkpoint", async () => {
  const f = fixture(); await f.checkpointNow(120_000);
  await f.release(false);
  assert.equal(f.releases[0].last_reconciled_at, undefined);
  assert.equal(f.releases[0].reconciliation_checkpoint, undefined);
  await f.release(true);
  assert.equal(typeof f.releases[1].last_reconciled_at, "string");
  assert.equal(f.releases[1].reconciliation_checkpoint, null);
});
