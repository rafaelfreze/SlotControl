import assert from "node:assert/strict";
import test from "node:test";

import { buildRuntimeObservation, safeObservationError, testnetSnapshotMetrics, type RuntimeObservation } from "./runtime-observation-contract.ts";

const observation: RuntimeObservation = {
  scope: { productId: "10000000-0000-4000-8000-000000000001", tenantId: "20000000-0000-4000-8000-000000000002", userId: "30000000-0000-4000-8000-000000000003" },
  source: "SHADOW_ENGINE", environment: "SHADOW", asset: "SOL", symbol: "SOLUSDC", reference: "run-at-UTC-time",
  startedAt: "2026-09-23T00:00:00Z", finishedAt: "2026-09-23T00:00:02Z", status: "COMPLETED",
  metrics: { config_id: "40000000-0000-4000-8000-000000000004", cycles_started: 0, slots_updated: 1, candles_processed: 5, gain_rate: "0.005", entry_spacing: "0.01", capital_usdc: "250", kill_switch: false, pause_new_entries: false },
};

test("runtime observation contains actual run timing, counters, effective rules and source version", () => {
  const row = buildRuntimeObservation(observation);
  assert.equal(row.observation_version, 1);
  assert.equal(row.environment, "SHADOW");
  assert.equal(row.started_at, "2026-09-23T00:00:00.000Z");
  assert.equal(row.finished_at, "2026-09-23T00:00:02.000Z");
  assert.equal(row.metrics.candles_processed, 5);
  assert.equal(row.metrics.gain_rate, 0.005);
  assert.equal(row.metrics.single_active_entry, true);
  assert.equal(row.metrics.compounding, true);
  assert.equal(row.metrics.expected_interval_seconds, 300);
});

test("same observation retry dedupes while a different owner produces a different event key", () => {
  const first = buildRuntimeObservation(observation);
  assert.equal(buildRuntimeObservation({ ...observation }).event_key, first.event_key);
  assert.notEqual(buildRuntimeObservation({ ...observation, scope: { ...observation.scope, userId: "30000000-0000-4000-8000-000000000099" } }).event_key, first.event_key);
});

test("observation rejects inverted time and mixed execution environments", () => {
  assert.throws(() => buildRuntimeObservation({ ...observation, finishedAt: "2026-09-22T00:00:00Z" }), /TIME_INVALID/);
  assert.throws(() => buildRuntimeObservation({ ...observation, environment: "TESTNET" }), /ENVIRONMENT_INVALID/);
});

test("failed and skipped engine executions preserve their true outcome without raw error messages", () => {
  assert.equal(buildRuntimeObservation({ ...observation, status: "SKIPPED" }).status, "SKIPPED");
  const row = buildRuntimeObservation({ ...observation, status: "FAILED", error: new Error("Authorization: Bearer never-export-this") });
  assert.equal(row.status, "FAILED");
  assert.equal(row.error_code, "COINOPS_RUNTIME_OBSERVATION_ERROR");
  assert.equal(safeObservationError("COINOPS_TESTNET_RECONCILIATION_FAILED"), "COINOPS_TESTNET_RECONCILIATION_FAILED");
  assert.equal(safeObservationError("ABCDEFGHIJKLMNOPQRSTUVWXYZ"), "COINOPS_RUNTIME_OBSERVATION_ERROR");
});

test("snapshot allowlist drops credentials, private identifiers and arbitrary diagnostic payloads", () => {
  const dangerous = {
    ok: true, account: { canTrade: true, canWithdraw: false, canDeposit: true, apiSecret: "never-export-this", email: "private@example.test" },
    balances: [{ asset: "USDC", free: 9900, locked: 100, total: 10000, token: "never-export-this" }, { asset: "PRIVATE_ASSET", free: 55 }],
    probes: [{ symbol: "SOLUSDC", available: true, filters: { minQuantity: 0.001, maxQuantity: 100, minNotional: 5, quantityStep: 0.001, priceTick: 0.01, apiKey: "never-export-this" }, market: { price: 118, observedAt: "2026-09-23T00:00:00Z" }, openOrderCount: 2, ownedOpenOrderCount: 1, headers: { authorization: "never-export-this" } }],
    tradePermission: { ok: true, apiKey: "never-export-this" }, userStreamPermission: { ok: true, token: "never-export-this" },
    apiKey: "never-export-this", rawResponse: "never-export-this",
  };
  const metrics = testnetSnapshotMetrics(dangerous);
  assert.deepEqual(metrics.permissions, { USER_DATA: true, TRADE: true, USER_STREAM: true });
  assert.equal((metrics.balances as unknown[]).length, 1);
  assert.equal(metrics.stream_observation_kind, "SUBSCRIPTION_PERMISSION_PROBE");
  const text = JSON.stringify(buildRuntimeObservation({ ...observation, source: "TESTNET_DIAGNOSTIC", environment: "TESTNET", metrics: dangerous }));
  for (const secret of ["never-export-this", "apiKey", "apiSecret", "authorization", "private@example", "PRIVATE_ASSET"]) assert.ok(!text.includes(secret));
  assert.ok(!JSON.stringify(buildRuntimeObservation({ ...observation, metrics: { ...observation.metrics, apiKey: "never-export-this" } })).includes("never-export-this"));
});
