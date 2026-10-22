import assert from "node:assert/strict";
import test from "node:test";
import { assertResetRecoveryMilestone, readResetRecoveryMilestone,
  type ResetRecoveryMilestone, type ResetRecoveryRun } from "./live-reset-recovery.ts";
import { LiveLedgerReadFailed, LiveReadUnavailable } from "./live-read-error.ts";

const NOW = Date.parse("2026-10-22T12:00:00.000Z");
const INVALID = /COINOPS_LIVE_RESET_RECOVERY_MILESTONE_INVALID/;
const READ_FAILED = /COINOPS_LIVE_RESET_RECOVERY_MILESTONE_READ_FAILED/;
const run = (): ResetRecoveryRun => ({ id: "current-run", product_id: "product-a", tenant_id: "tenant-a",
  user_id: "user-a", operator_id: "operator-a", exchange_account_id: "shared-account",
  trading_engine_id: "engine-01", quote_asset: "BRL", created_at: "2026-10-02T15:00:00.000Z",
  previous_run_id: "64b267d0-3897-4783-a07e-69c427472f81" });
const milestone = (): ResetRecoveryMilestone => {
  const current = run();
  return { product_id: current.product_id, tenant_id: current.tenant_id, user_id: current.user_id,
    operator_id: current.operator_id, exchange_account_id: current.exchange_account_id,
    trading_engine_id: current.trading_engine_id, quote_asset: current.quote_asset,
    run_id: current.id, event_key: `RESET_RECOVERED:${current.previous_run_id}`, event_type: "RESET_RECOVERED",
    slot_number: null, observed_at: "2026-10-02T15:00:07.972718+00:00",
    details: { previous_run_id: current.previous_run_id!, open_positions: 1, resident_buy_count: 1 } };
};
type Outcome = { data?: unknown; error: unknown; status?: number } | { thrown: unknown } | { pending: true };
function fixture(outcomes: Outcome[] = [{ data: [milestone()], error: null, status: 200 }]) {
  const calls: { table: string; columns: string; filters: Record<string, unknown>; limit: number; signal: AbortSignal }[] = [];
  const service = { from(table: string) {
    let columns = "", limit = 0; let signal: AbortSignal;
    const filters: Record<string, unknown> = {};
    const query = {
      select(value: string) { columns = value; return query; },
      eq(key: string, value: unknown) { filters[key] = value; return query; },
      limit(value: number) { limit = value; return query; },
      abortSignal(value: AbortSignal) { signal = value; return query; },
      then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) {
        const operation = async () => {
          const outcome = outcomes[calls.length];
          calls.push({ table, columns, filters, limit, signal });
          if (outcome && "pending" in outcome) return new Promise(() => {});
          if (outcome && "thrown" in outcome) throw outcome.thrown;
          return outcome;
        };
        return operation().then(resolve, reject);
      },
    };
    return query;
  } } as unknown as Parameters<typeof readResetRecoveryMilestone>[0];
  return { service, calls };
}

test("old reset milestone preserves its original snapshot when current OPEN count has grown", async () => {
  const expected = milestone(), f = fixture(); let writes = 0;
  const currentOpenPositions = 5;
  const existing = await readResetRecoveryMilestone(f.service, run(), { slotCount: 25 }, NOW);
  // The authoritative caller appends only an absent milestone, not a second
  // snapshot with today's count under the same immutable key.
  if (!existing) writes++;
  assert.equal(currentOpenPositions, 5); assert.equal(existing?.details.open_positions, 1);
  assert.equal(existing?.observed_at, expected.observed_at); assert.equal(writes, 0);
  assert.deepEqual(existing, expected); assert.equal(f.calls.length, 1);
});

test("one GET is scoped by full ownership plus run/key with limit two and deadline", async () => {
  const f = fixture(); let renewals = 0;
  await readResetRecoveryMilestone(f.service, run(), { slotCount: 25, renewLease: async () => { renewals++; } }, NOW);
  assert.equal(renewals, 1); assert.equal(f.calls.length, 1);
  const call = f.calls[0], current = run();
  assert.equal(call.table, "robot_v1_live_events"); assert.equal(call.limit, 2);
  assert.deepEqual(call.filters, { run_id: current.id, event_key: `RESET_RECOVERED:${current.previous_run_id}`,
    product_id: current.product_id, tenant_id: current.tenant_id, user_id: current.user_id,
    operator_id: current.operator_id, exchange_account_id: current.exchange_account_id,
    trading_engine_id: current.trading_engine_id, quote_asset: current.quote_asset });
  assert.ok(call.signal instanceof AbortSignal); assert.equal(call.signal.aborted, false);
  assert.deepEqual(new Set(call.columns.split(",")), new Set(Object.keys(milestone())));
});

test("absence is returned only for a successful complete empty collection and is not cached", async () => {
  const f = fixture([{ data: [milestone()], error: null, status: 200 }, { data: [], error: null, status: 200 }]);
  assert.ok(await readResetRecoveryMilestone(f.service, run(), { slotCount: 25 }, NOW));
  assert.equal(await readResetRecoveryMilestone(f.service, run(), { slotCount: 25 }, NOW), null);
  assert.equal(f.calls.length, 2);
});

test("proof is copied and frozen instead of letting a caller mutate the historical snapshot", () => {
  const original = milestone();
  const proof = assertResetRecoveryMilestone(run(), original, 25, NOW);
  original.details.open_positions = 5;
  assert.equal(proof.details.open_positions, 1);
  assert.ok(Object.isFrozen(proof)); assert.ok(Object.isFrozen(proof.details));
  assert.equal(proof.observed_at, "2026-10-02T15:00:07.972718+00:00");
});

test("all foreign identity boundaries fail even if the provider ignores the request filters", async () => {
  for (const key of ["product_id", "tenant_id", "user_id", "operator_id", "exchange_account_id",
    "trading_engine_id", "quote_asset", "run_id", "event_key"] as const) {
    const f = fixture([{ data: [{ ...milestone(), [key]: "FOREIGN" }], error: null, status: 200 }]);
    await assert.rejects(readResetRecoveryMilestone(f.service, run(), { slotCount: 25 }, NOW), INVALID, key);
    assert.equal(f.calls.length, 1);
  }
});

test("two same-symbol engines on different shards cannot use each other's milestone", () => {
  const sibling = { ...run(), id: "sibling-run", trading_engine_id: "engine-03" };
  assert.throws(() => assertResetRecoveryMilestone(sibling, milestone(), 25, NOW), INVALID);
  assert.throws(() => assertResetRecoveryMilestone(run(), { ...milestone(), run_id: sibling.id,
    trading_engine_id: sibling.trading_engine_id }, 25, NOW), INVALID);
});

test("wrong type, slot, extra event fields and malformed collections remain blocked", async () => {
  for (const bad of [{ ...milestone(), event_type: "RECONCILED" }, { ...milestone(), slot_number: 1 },
    { ...milestone(), unexpected: true }, { ...milestone(), details: null }])
    assert.throws(() => assertResetRecoveryMilestone(run(), bad, 25, NOW), INVALID);
  for (const data of [null, {}, [milestone(), milestone()], [null], ["invalid"]]) {
    const f = fixture([{ data, error: null, status: 200 }]);
    await assert.rejects(readResetRecoveryMilestone(f.service, run(), { slotCount: 25 }, NOW),
      /COINOPS_LIVE_(?:RESET_RECOVERY_MILESTONE_INVALID|LEDGER_INCOMPLETE)/);
  }
});

test("details require exactly the historical predecessor, integer OPEN 1..N, and one resident BUY", () => {
  const expected = milestone();
  for (const details of [null, [], {}, { ...expected.details, previous_run_id: "FOREIGN" },
    { ...expected.details, previous_run_id: null }, { ...expected.details, unexpected: "extra" },
    { ...expected.details, resident_buy_count: 0 }, { ...expected.details, resident_buy_count: 2 },
    { ...expected.details, resident_buy_count: "1" },
    ...[0, -1, 26, 1.1, NaN, Infinity, "1", null].map(open_positions => ({ ...expected.details, open_positions }))])
    assert.throws(() => assertResetRecoveryMilestone(run(), { ...expected, details }, 25, NOW), INVALID);
  for (const slotCount of [25, 50, 100]) {
    const details = { ...expected.details, open_positions: slotCount };
    assert.equal(assertResetRecoveryMilestone(run(), { ...expected, details }, slotCount, NOW).details.open_positions, slotCount);
    assert.throws(() => assertResetRecoveryMilestone(run(), { ...expected, details: { ...details,
      open_positions: slotCount + 1 } }, slotCount, NOW), INVALID);
  }
});

test("historical timestamp has no freshness expiry but cannot predate creation or come from the future", () => {
  assert.ok(assertResetRecoveryMilestone(run(), milestone(), 25, NOW));
  for (const observed_at of ["invalid", "2026", "2026-10-02T14:59:59.999Z", "2026-10-22T12:00:00.001Z"])
    assert.throws(() => assertResetRecoveryMilestone(run(), { ...milestone(), observed_at }, 25, NOW), INVALID);
  for (const created_at of ["invalid", "2026", "2026-10-22T12:00:00.001Z"])
    assert.throws(() => assertResetRecoveryMilestone({ ...run(), created_at }, milestone(), 25, NOW), INVALID);
  for (const previous_run_id of [null, "invalid", run().id])
    assert.throws(() => assertResetRecoveryMilestone({ ...run(), previous_run_id }, milestone(), 25, NOW), INVALID);
  assert.throws(() => assertResetRecoveryMilestone(run(), milestone(), 25, NaN), INVALID);
});

test("unsupported topology and malformed run are rejected before any query", async () => {
  for (const slotCount of [1, 101, 2.5, NaN]) {
    const f = fixture();
    await assert.rejects(readResetRecoveryMilestone(f.service, run(), { slotCount }, NOW), /COINOPS_ENGINE_SLOT_COUNT_INVALID/);
    assert.equal(f.calls.length, 0);
  }
  for (const key of ["id", "product_id", "tenant_id", "user_id", "operator_id", "exchange_account_id",
    "trading_engine_id", "quote_asset"] as const) {
    const f = fixture();
    await assert.rejects(readResetRecoveryMilestone(f.service, { ...run(), [key]: "" }, { slotCount: 25 }, NOW), INVALID);
    assert.equal(f.calls.length, 0);
  }
});

test("permission, schema and unknown provider failures stay hard without retry", async () => {
  const failures: Outcome[] = [
    { data: [], error: { code: "42501", message: "private permission detail" }, status: 403 },
    { data: [], error: { code: "42P01" }, status: 404 },
    { data: [], error: { code: "UNKNOWN" }, status: 503 },
    { data: [], error: null, status: 500 }, { thrown: new Error("private application error") },
  ];
  for (const outcome of failures) {
    const f = fixture([outcome]);
    await assert.rejects(readResetRecoveryMilestone(f.service, run(), { slotCount: 25 }, NOW), error => {
      assert.ok(error instanceof Error);
      assert.ok(error instanceof LiveLedgerReadFailed || READ_FAILED.test(error.message));
      assert.doesNotMatch(error.message, /private|42501|fetch failed/); return true;
    });
    assert.equal(f.calls.length, 1);
  }
});

test("a known 503 converges through the second scoped GET without replaying writes", async () => {
  const f = fixture([{ data: null, error: { code: "PGRST003" }, status: 503 },
    { data: [milestone()], error: null, status: 200 }]);
  let renewals = 0;
  const proof = await readResetRecoveryMilestone(f.service, run(), { slotCount: 25,
    renewLease: async () => { renewals++; } }, NOW);
  assert.deepEqual(proof, milestone()); assert.equal(f.calls.length, 2); assert.equal(renewals, 2);
  assert.deepEqual(f.calls[0].filters, f.calls[1].filters);
});

test("exhausted transient GETs retain the typed path and bounded observation count", async () => {
  for (const outcome of [
    { data: null, error: { code: "PGRST003" }, status: 503 },
    { thrown: new TypeError("fetch failed") },
    { thrown: new DOMException("private read failure", "TimeoutError") },
  ] satisfies Outcome[]) {
    const f = fixture([outcome, outcome]);
    await assert.rejects(readResetRecoveryMilestone(f.service, run(), { slotCount: 25 }, NOW), error => {
      assert.ok(error instanceof LiveReadUnavailable);
      assert.equal(error.code, "COINOPS_LIVE_LEDGER_READ_UNAVAILABLE");
      assert.equal(error.path, "ledger/reset_recovery_milestone"); assert.equal(error.attempts, 2);
      assert.doesNotMatch(error.message, /private|fetch failed/); return true;
    });
    assert.equal(f.calls.length, 2);
  }
});

test("lease loss retains the original fence error and prevents the metadata lookup", async () => {
  const f = fixture(), lost = new Error("COINOPS_LIVE_LEASE_LOST");
  await assert.rejects(readResetRecoveryMilestone(f.service, run(), { slotCount: 25,
    renewLease: async () => { throw lost; } }, NOW), error => error === lost);
  assert.equal(f.calls.length, 0);
});

test("hanging GETs are bounded by two real five-second sets without a write", { timeout: 15_000 }, async () => {
  const f = fixture([{ pending: true }, { pending: true }]), started = performance.now();
  const keepAlive = setTimeout(() => {}, 14_000);
  try {
    await assert.rejects(readResetRecoveryMilestone(f.service, run(), { slotCount: 25 }, NOW), error => {
      assert.ok(error instanceof LiveReadUnavailable); assert.equal(error.attempts, 2);
      assert.equal(error.path, "ledger/reset_recovery_milestone"); return true;
    });
    assert.ok(performance.now() - started >= 10_000 && performance.now() - started < 14_000);
    assert.equal(f.calls.length, 2); assert.ok(f.calls.every(call => call.signal.aborted));
  } finally { clearTimeout(keepAlive); }
});
