import assert from "node:assert/strict";
import test from "node:test";
import { runShardedTestnetCronBatch, type TestnetCronRun } from "./testnet-cron.ts";

const at = Date.parse("2026-09-26T20:00:00Z");
const row = (id: string, shardId: string | null): TestnetCronRun => ({ id, asset: "BTC", product_id: "p",
  tenant_id: "t", user_id: "u", status: "ACTIVE", last_reconciled_at: new Date(at).toISOString(),
  lease_until: null, last_error: null, operator_id: "operator", exchange_account_id: `${shardId}:account`,
  trading_engine_id: id, executor_shard_id: shardId });

test("Testnet02 outage does not delay Rafael Testnet01, preserving each shard's two-wide batches", async () => {
  const runs = [row("02-a", "executor-02"), row("02-b", "executor-02"), row("02-c", "executor-02"),
    row("01-a", "executor-01"), row("01-b", "executor-01"), row("01-c", "executor-01")];
  const started: string[] = [], completed: string[] = [];
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const result = runShardedTestnetCronBatch(runs, "REACTOR", { now: () => at,
    advance: async (id) => { started.push(id); if (id.startsWith("02")) await blocked;
      completed.push(id); return { status: "RECONCILED" }; },
    currentRun: async (id) => runs.find((run) => run.id === id)!, record: async () => {} });
  for (let n = 0; n < 30; n++) await Promise.resolve();
  assert.deepEqual(completed, ["01-a", "01-b", "01-c"]);
  assert.deepEqual(started.filter((id) => id.startsWith("02")), ["02-a", "02-b"]);
  release();
  assert.deepEqual((await result).map((run) => run.runId), runs.map((run) => run.id));
});

test("missing shard and duplicate Testnet engine fail closed locally without dispatch", async () => {
  const duplicate = row("duplicate-a", "executor-02");
  const runs = [row("missing", null), duplicate, { ...duplicate, id: "duplicate-b" }, row("healthy", "executor-01")];
  const dispatched: string[] = [];
  const result = await runShardedTestnetCronBatch(runs, "REACTOR", { now: () => at,
    advance: async (id) => { dispatched.push(id); return { status: "RECONCILED" }; },
    currentRun: async (id) => runs.find((run) => run.id === id)!, record: async () => {} });
  assert.deepEqual(dispatched, ["healthy"]);
  assert.deepEqual(result.map((run) => run.status), ["FAILED", "FAILED", "FAILED", "RECONCILED"]);
});
