import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { readLiveDashboardBatch } from "./live-dashboard-batch.ts";
import { freshExecutorObservation } from "./executor-observation-freshness.ts";
import type { EngineContext } from "../../lib/execution/operator-context";
import type { LiveExecutorStatus } from "../../lib/execution/live-executor-health";

test("dashboard batches 65 engine identities into 3 bounded, scoped reads", async () => {
  const contexts = Array.from({ length: 65 }, (_, index) => ({ operator_id: "owner", environment: "REAL", trading_engine_id: String(index) })) as EngineContext[];
  const calls: string[][] = [];
  const client = { rpc(name: string, input: { p_operator_id: string; p_engine_ids: string[] }) {
    assert.equal(name, "dashboard_live_engine_reads"); assert.equal(input.p_operator_id, "owner");
    calls.push(input.p_engine_ids);
    return { abortSignal(signal: AbortSignal) {
      assert.equal(signal.aborted, false);
      return Promise.resolve({ error: null, data: input.p_engine_ids.map((engine_id) => ({ engine_id,
        payload: { run: null, preparation: null, slots: [], orders: [], accounts: [], events: [], alerts: [], monthlyGains: [] } })) });
    } };
  } } as unknown as Parameters<typeof readLiveDashboardBatch>[0];
  assert.equal((await readLiveDashboardBatch(client, contexts)).size, 65);
  assert.deepEqual(calls.map((call) => call.length), [32, 32, 1]);
  await assert.rejects(readLiveDashboardBatch(client, [contexts[0], { ...contexts[1], operator_id: "foreign" }]), /SCOPE_DENIED/);
});

test("missing, duplicate, foreign or failed engine results never become empty healthy data", async () => {
  const context = { operator_id: "owner", environment: "REAL", trading_engine_id: "engine" } as EngineContext;
  for (const response of [{ error: { code: "57014" }, data: null }, { error: null, data: [] },
    { error: null, data: [{ engine_id: "foreign", payload: {} }] },
    { error: null, data: [{ engine_id: "engine", payload: {} }] }]) {
    const client = { rpc: () => ({ abortSignal: async () => response }) } as unknown as Parameters<typeof readLiveDashboardBatch>[0];
    await assert.rejects(readLiveDashboardBatch(client, [context]), /COINOPS_ENGINE_BATCH/);
  }
});

test("signed health expires and cannot be refreshed by rendering or future timestamps", () => {
  const now = Date.parse("2026-09-29T20:00:00Z");
  const status = (age: number) => ({ gate: "LIVE_EXECUTOR_ACTIVE", ip: "fixture", health: { clock: new Date(now - age).toISOString() } }) as LiveExecutorStatus;
  assert.equal(freshExecutorObservation(status(10_000), now).gate, "LIVE_EXECUTOR_ACTIVE");
  for (const age of [75_000, 150_000, -3_000]) assert.equal(freshExecutorObservation(status(age), now).gate, "ATTENTION");
  assert.equal(freshExecutorObservation(undefined, now).health, null);
  const protectedStatus = { ...status(0), gate: "LIVE_EXECUTOR_PROTECTED" as const };
  assert.equal(freshExecutorObservation(protectedStatus, now).gate, "LIVE_EXECUTOR_PROTECTED");
});

test("closed editors and charts are absent from the critical Home read", () => {
  const read = (name: string) => readFileSync(new URL(name, import.meta.url), "utf8");
  const page = read("./page.tsx"), client = read("./premium-automation.tsx");
  assert.ok(!page.includes("dailyCandlesPromise"));
  assert.ok(!page.includes("scopedHealthPromise"));
  assert.match(page, /searchParams\?\.preparation === "check"/);
  assert.match(page, /searchParams\?\.testnet === "check"/);
  assert.match(client, /const BulkStrategyEditor = dynamic/);
  assert.match(client, /visited\.strategy \|\| panel === "strategy"/);
  assert.match(client, /visited\.adjustments \|\| panel === "adjustments"/);
  assert.match(client, /AbortSignal\.timeout\(20_000\)/);
  assert.match(read("./use-automation-live-sync.ts"), /if \(!connectedRef\.current\) setGeneration/);
  assert.match(read("../api/coinops-executor-observations/route.ts"), /private, no-store/);
});
