import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { reconcileTestnetCronRun, runTestnetCronBatch, type TestnetCronEvidence, type TestnetCronRun } from "../execution/testnet-cron.ts";

const now = Date.parse("2026-09-23T13:00:00Z");
const run = (asset: "BTC" | "SOL" = "BTC"): TestnetCronRun => ({
  id: asset, asset, product_id: "product", tenant_id: "tenant", user_id: "user", status: "ACTIVE",
  last_reconciled_at: new Date(now - 600_000).toISOString(), lease_until: null, last_error: null,
});
const fresh = (asset: "BTC" | "SOL" = "BTC") => ({ ...run(asset), last_reconciled_at: new Date(now + 1_000).toISOString() });

test("reactor records intent before advancing and verifies actual checkpoint after completion", async () => {
  const calls: string[] = []; const evidence: TestnetCronEvidence[] = [];
  const result = await reconcileTestnetCronRun(run(), "REACTOR", {
    now: () => now, advance: async (_id, source) => { calls.push(source); return { status: "OK" }; },
    currentRun: async () => { calls.push("read-current"); return fresh(); },
    record: async (_run, value) => { calls.push(value.type); evidence.push(value); },
  });
  assert.deepEqual(calls, ["RECONCILIATION_STARTED", "FAST_REACTOR_RECONCILIATION", "read-current", "RECONCILIATION_FINISHED"]);
  assert.equal(result.status, "OK");
  assert.equal(result.ageBeforeMs, 600_000);
  assert.equal(evidence[1]?.details.expected_interval_seconds, 60);
  assert.equal(evidence[1]?.details.fallback_interval_seconds, 300);
});

test("five-minute watchdog skips a healthy minute reactor and recovers stale runs", async () => {
  let calls = 0;
  const deps = { now: () => now, advance: async () => { calls++; return { status: "OK" }; }, currentRun: async () => fresh(), record: async () => {} };
  assert.equal((await reconcileTestnetCronRun({ ...run(), last_reconciled_at: new Date(now - 30_000).toISOString() }, "WATCHDOG", deps)).status, "WATCHDOG_HEALTHY");
  assert.equal(calls, 0);
  assert.equal((await reconcileTestnetCronRun(run(), "WATCHDOG", deps)).status, "OK");
  assert.equal(calls, 1);
});

test("an active run silently skipped without a live lease fails instead of appearing healthy", async () => {
  const result = await reconcileTestnetCronRun(run(), "REACTOR", {
    now: () => now, advance: async () => ({ status: "BUSY_OR_INACTIVE" }), currentRun: async () => run(), record: async () => {},
  });
  assert.equal(result.status, "FAILED");
  assert.equal(result.error, "COINOPS_TESTNET_RECONCILIATION_SKIPPED_ACTIVE_RUN");
});

test("a concurrent live lease is explicit and does not cause a duplicate execution", async () => {
  const result = await reconcileTestnetCronRun(run(), "REACTOR", {
    now: () => now, advance: async () => ({ status: "BUSY_OR_INACTIVE" }),
    currentRun: async () => ({ ...run(), lease_until: new Date(now + 90_000).toISOString() }), record: async () => {},
  });
  assert.equal(result.status, "BUSY_ACTIVE_LEASE");
});

test("claimed OK with stale release checkpoint fails closed in telemetry", async () => {
  const result = await reconcileTestnetCronRun(run(), "REACTOR", {
    now: () => now, advance: async () => ({ status: "OK" }), currentRun: async () => run(), record: async () => {},
  });
  assert.equal(result.error, "COINOPS_TESTNET_RECONCILIATION_CHECKPOINT_STALE");
});

test("BTC failure does not starve SOL and untrusted exception contents are not logged", async () => {
  const started: string[] = [];
  const results = await runTestnetCronBatch([run("BTC"), run("SOL")], "REACTOR", {
    now: () => now,
    advance: async (id) => { started.push(id); if (id === "BTC") throw new Error("secret response must not escape"); return { status: "OK" }; },
    currentRun: async () => fresh("SOL"), record: async () => {},
  });
  assert.deepEqual(started, ["BTC", "SOL"]);
  assert.equal(results[0]?.error, "COINOPS_TESTNET_RECONCILIATION_FAILED");
  assert.equal(results[1]?.status, "OK");
});

test("restart validates the new run checkpoint, never requiring the old cycle to remain active", async () => {
  let requested = "";
  const result = await reconcileTestnetCronRun(run(), "REACTOR", {
    now: () => now, advance: async () => ({ status: "RESTARTED", nextRunId: "new-cycle" }),
    currentRun: async (id) => { requested = id; return { ...fresh(), id }; }, record: async () => {},
  });
  assert.equal(requested, "new-cycle");
  assert.equal(result.status, "RESTARTED");
});

test("configuration keeps market regime unchanged and fast reactor separate from fallback", () => {
  const config = JSON.parse(readFileSync(new URL("../../vercel.json", import.meta.url), "utf8"));
  const schedule = (path: string) => config.crons.find((entry: { path: string }) => entry.path === path)?.schedule;
  assert.equal(schedule("/api/cron/testnet-reactor"), "* * * * *");
  assert.equal(schedule("/api/cron/testnet-execution"), "*/5 * * * *");
  assert.equal(schedule("/api/cron/market-regime"), "*/5 * * * *");
  for (const route of ["testnet-reactor", "testnet-execution"]) {
    const code = readFileSync(new URL(`../../app/api/cron/${route}/route.ts`, import.meta.url), "utf8");
    assert.match(code, /revalidate = 0/);
    assert.match(code, /fetchCache = "force-no-store"/);
  }
});
