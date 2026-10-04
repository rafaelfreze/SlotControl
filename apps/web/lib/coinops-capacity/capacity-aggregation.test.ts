import assert from "node:assert/strict";
import test from "node:test";
import { collectIndependentShards, shardLedgerMetrics, type CapacityLedger } from "./capacity-aggregation.ts";

const now = Date.parse("2026-09-26T19:30:00Z");
const ledger: CapacityLedger = {
  accounts: [{ id: "A", executor_shard_id: "executor-01" }, { id: "B", executor_shard_id: "executor-02" },
    { id: "pending", executor_shard_id: "executor-02" }],
  engines: [{ id: "A-BTC", exchange_account_id: "A", executor_shard_id: "executor-01" }, { id: "B-SOL", exchange_account_id: "B", executor_shard_id: "executor-02" }],
  runs: [{ trading_engine_id: "A-BTC", status: "ACTIVE", created_at: new Date(now - 60_000).toISOString(), last_reconciled_at: null },
    { trading_engine_id: "B-SOL", status: "ACTIVE", created_at: new Date(now - 180_000).toISOString(), last_reconciled_at: null }],
  alerts: [{ trading_engine_id: "B-SOL" }],
};
test("backlog, alerts and account registry comparisons are shard-local", () => {
  const a = shardLedgerMetrics("executor-01", ledger, now);
  const b = shardLedgerMetrics("executor-02", ledger, now);
  assert.deepEqual(a.engineIds, ["A-BTC"]);
  assert.deepEqual(b.accountIds, ["B"]);
  assert.equal(b.assignedAccountCount, 1);
  assert.equal(a.schedulerBacklog, 0);
  assert.equal(a.errorsLast5m, 0);
  assert.equal(b.schedulerBacklog, 1);
  assert.equal(b.errorsLast5m, 1);
  assert.equal(a.validRuns && b.validRuns, true);
});
test("empty executor has truthful empty ledger, duplicate or missing run fails registry proof", () => {
  assert.equal(shardLedgerMetrics("executor-03", ledger, now).validRuns, true);
  assert.equal(shardLedgerMetrics("executor-01", { ...ledger, runs: [] }, now).validRuns, false);
  assert.equal(shardLedgerMetrics("executor-01", { ...ledger, runs: [...ledger.runs, ledger.runs[0]] }, now).validRuns, false);
  assert.equal(shardLedgerMetrics("executor-03", { ...ledger,
    engines: [{ ...ledger.engines[0], executor_shard_id: undefined }] }, now).validRuns, false);
});
test("offline shard and collector exception do not suppress healthy shard sample", async () => {
  const observed: string[] = [];
  const result = await collectIndependentShards(["executor-02", "executor-01"], async (id) => {
    if (id === "executor-02") throw new Error("offline");
    observed.push(id); return { healthy: true };
  });
  assert.deepEqual(observed, ["executor-01"]);
  assert.equal(result[0].ok, false);
  assert.equal(result[1].ok, true);
});

test("one account has independent engine budgets and failures on different IPs", () => {
  const multi: CapacityLedger = { ...ledger, engines: [ledger.engines[1],
    { id: "B-SOL-2", exchange_account_id: "B", executor_shard_id: "executor-03" }],
    runs: [ledger.runs[1], { ...ledger.runs[0], trading_engine_id: "B-SOL-2" }] };
  assert.deepEqual(shardLedgerMetrics("executor-02", multi, now).engineIds, ["B-SOL"]);
  const third = shardLedgerMetrics("executor-03", multi, now);
  assert.deepEqual(third.engineIds, ["B-SOL-2"]);
  assert.deepEqual(third.accountIds, ["B"]);
  assert.equal(third.schedulerBacklog, 0);
  assert.equal(third.errorsLast5m, 0);
});
