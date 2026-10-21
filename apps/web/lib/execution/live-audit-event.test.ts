import assert from "node:assert/strict";
import test from "node:test";
import { appendLiveAuditEvent, LiveAuditEventPersistError, type LiveAuditEventRow } from "./live-audit-event.ts";

const row = (): LiveAuditEventRow => ({ product_id: "product-a", tenant_id: "tenant-a", user_id: "user-a",
  operator_id: "operator-a", exchange_account_id: "account-shared", trading_engine_id: "engine-01",
  run_id: "run-engine-01", quote_asset: "USDT", event_key: "RECONCILED:2026-10-21T13:28",
  event_type: "RECONCILED", slot_number: null, details: { source: "LIVE_CRON", next: "EXISTING_BUY",
    nested: { amounts: [1, 2, 3], verified: true } } });
type Outcome = { result?: { data?: unknown; error: unknown; status?: number }; thrown?: unknown;
  commit?: boolean; before?: () => void; pending?: boolean };

function fixture(writePlan: Outcome[] = [], readPlan: Outcome[] = []) {
  const writes: { row: LiveAuditEventRow; options: unknown; signal: AbortSignal }[] = [];
  const reads: { filters: Record<string, unknown>; columns: string; limit: number; signal: AbortSignal }[] = [];
  const stored = new Map<string, LiveAuditEventRow>();
  const sequence: string[] = [];
  const service = { from(table: string) {
    assert.equal(table, "robot_v1_live_events");
    let mutation: LiveAuditEventRow | null = null, options: unknown, columns = "", bound = 0;
    let signal: AbortSignal;
    const filters: Record<string, unknown> = {};
    const query = {
      upsert(value: LiveAuditEventRow, config: unknown) { mutation = value; options = config; return query; },
      select(value: string) { columns = value; return query; },
      eq(key: string, value: unknown) { filters[key] = value; return query; },
      limit(value: number) { bound = value; return query; },
      abortSignal(value: AbortSignal) { signal = value; return query; },
      then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) {
        const operation = async () => {
          assert.ok(signal instanceof AbortSignal);
          if (mutation) {
            sequence.push("WRITE");
            writes.push({ row: mutation, options, signal });
            const outcome = writePlan[writes.length - 1];
            if (!outcome || outcome.commit) {
              const key = `${mutation.run_id}:${mutation.event_key}`;
              if (!stored.has(key)) stored.set(key, JSON.parse(JSON.stringify(mutation)));
            }
            outcome?.before?.();
            if (outcome?.pending) return new Promise(() => {});
            if (outcome?.thrown) throw outcome.thrown;
            return outcome?.result ?? { data: null, error: null, status: 201 };
          }
          sequence.push("READBACK");
          reads.push({ filters, columns, limit: bound, signal });
          const outcome = readPlan[reads.length - 1];
          outcome?.before?.();
          if (outcome?.pending) return new Promise(() => {});
          if (outcome?.thrown) throw outcome.thrown;
          return outcome?.result ?? { error: null, status: 200, data: [...stored.values()].filter(value =>
            Object.entries(filters).every(([key, expected]) => value[key as keyof LiveAuditEventRow] === expected)) };
        };
        return operation().then(resolve, reject);
      },
    };
    return query;
  } } as unknown as Parameters<typeof appendLiveAuditEvent>[0];
  return { service, writes, reads, stored, sequence };
}
const transient = (status = 503): Outcome => ({ result: { error: { code: "PGRST003", message: "private provider payload" }, status } });
const checkError = (expected: Partial<LiveAuditEventPersistError>) => (error: unknown) => {
  assert.ok(error instanceof LiveAuditEventPersistError);
  for (const [key, value] of Object.entries(expected)) assert.equal(error[key as keyof LiveAuditEventPersistError], value, key);
  return true;
};

test("immediate acknowledgment inserts one immutable scoped event without an extra read", async () => {
  const f = fixture();
  assert.deepEqual(await appendLiveAuditEvent(f.service, row()), { status: "ACKNOWLEDGED", writeAttempts: 1 });
  assert.equal(f.writes.length, 1); assert.equal(f.reads.length, 0); assert.equal(f.stored.size, 1);
  assert.deepEqual(f.writes[0].options, { onConflict: "run_id,event_key", ignoreDuplicates: true });
});

test("known transient write failure reads exact scope before retrying only the captured event", async () => {
  const f = fixture([transient()]);
  let renewals = 0;
  const result = await appendLiveAuditEvent(f.service, row(), { renewLease: async () => { renewals++; } });
  assert.deepEqual(result, { status: "ACKNOWLEDGED", writeAttempts: 2 });
  assert.deepEqual(f.sequence, ["WRITE", "READBACK", "WRITE"]);
  assert.equal(renewals, 3); assert.equal(f.writes[0].row, f.writes[1].row);
  assert.equal(f.stored.size, 1);
  const expected = row();
  assert.deepEqual(f.reads[0].filters, Object.fromEntries(["product_id", "tenant_id", "user_id", "operator_id",
    "exchange_account_id", "trading_engine_id", "quote_asset", "run_id", "event_key"].map(key => [key, expected[key as keyof LiveAuditEventRow]])));
  assert.equal(f.reads[0].limit, 2);
  for (const field of [...Object.keys(f.reads[0].filters), "event_type", "slot_number", "details"])
    assert.ok(f.reads[0].columns.split(",").includes(field), field);
});

test("ACK lost after commit is confirmed by exact row with one write, not blindly resubmitted", async () => {
  const f = fixture([{ ...transient(), commit: true }]);
  assert.deepEqual(await appendLiveAuditEvent(f.service, row()), { status: "CONFIRMED_AFTER_UNCERTAIN", writeAttempts: 1 });
  assert.equal(f.writes.length, 1); assert.equal(f.reads.length, 1); assert.equal(f.stored.size, 1);
});

test("canonical readback accepts JSON key ordering and omitted undefined transport properties", async () => {
  const payload = row(); payload.details.optional = undefined;
  const existing = { ...row(), details: { nested: { verified: true, amounts: [1, 2, 3] }, next: "EXISTING_BUY", source: "LIVE_CRON" } };
  const f = fixture([transient()], [{ result: { error: null, status: 200, data: [existing] } }]);
  assert.equal((await appendLiveAuditEvent(f.service, payload)).status, "CONFIRMED_AFTER_UNCERTAIN");
  assert.equal(Object.hasOwn(f.writes[0].row.details, "optional"), false);
  assert.equal(Object.hasOwn(payload.details, "optional"), true);
});

test("an uncertain second response is also read back before reporting success or exhaustion", async () => {
  const committed = fixture([transient(), { ...transient(), commit: true }]);
  assert.equal((await appendLiveAuditEvent(committed.service, row())).writeAttempts, 2);
  assert.deepEqual(committed.sequence, ["WRITE", "READBACK", "WRITE", "READBACK"]);
  assert.equal(committed.stored.size, 1);
  const absent = fixture([transient(), transient()]);
  await assert.rejects(appendLiveAuditEvent(absent.service, row()), checkError({ phase: "WRITE", reason: "TRANSIENT_EXHAUSTED", attempts: 2,
    eventType: "RECONCILED", providerCode: "PGRST003", httpStatus: 503 }));
  assert.deepEqual(absent.sequence, ["WRITE", "READBACK", "WRITE", "READBACK"]);
});

test("hard permission, schema, constraint and unknown provider errors never inherit a 503 retry", async () => {
  for (const [code, status] of [["42501", 403], ["42P01", 404], ["23503", 409], ["UNKNOWN", 503], ["private-secret-code", 503]] as const) {
    const f = fixture([{ result: { error: { code, message: "do not expose me" }, status } }]);
    await assert.rejects(appendLiveAuditEvent(f.service, row()), checkError({ reason: "HARD_PROVIDER", phase: "WRITE", attempts: 1 }));
    assert.deepEqual(f.sequence, ["WRITE"]);
  }
});

test("known network/timeout exceptions observe before retry; arbitrary exceptions stay hard", async () => {
  for (const thrown of [new TypeError("fetch failed"), new DOMException("private timeout details", "TimeoutError"),
    Object.assign(new Error("private transport details"), { code: "ECONNRESET" })]) {
    const f = fixture([{ thrown }]);
    assert.equal((await appendLiveAuditEvent(f.service, row())).writeAttempts, 2);
    assert.deepEqual(f.sequence, ["WRITE", "READBACK", "WRITE"]);
  }
  const f = fixture([{ thrown: new TypeError("application bug with sensitive context") }]);
  await assert.rejects(appendLiveAuditEvent(f.service, row()), checkError({ reason: "HARD_PROVIDER" }));
  assert.deepEqual(f.sequence, ["WRITE"]);
});

test("readback hard errors, transient ambiguity or malformed collections block a second write", async () => {
  for (const [outcome, reason] of [[{ result: { error: { code: "42501" }, status: 403 } }, "HARD_PROVIDER"],
    [transient(), "READBACK_UNAVAILABLE"], [{ thrown: new DOMException("timeout", "TimeoutError") }, "READBACK_UNAVAILABLE"],
    [{ result: { data: null, error: null, status: 200 } }, "READBACK_MISMATCH"]] as const) {
    const f = fixture([transient()], [outcome]);
    await assert.rejects(appendLiveAuditEvent(f.service, row()), checkError({ reason, phase: "READBACK", attempts: 1 }));
    assert.deepEqual(f.sequence, ["WRITE", "READBACK"]);
  }
});

test("all ownership boundaries, event type, slot and details are checked even if a provider returns a foreign row", async () => {
  const expected = row();
  for (const key of ["product_id", "tenant_id", "user_id", "operator_id", "exchange_account_id", "trading_engine_id",
    "quote_asset", "run_id", "event_key", "event_type", "slot_number", "details"] as const) {
    const foreign = { ...expected, [key]: key === "slot_number" ? 8 : key === "details" ? { changed: true } : "OTHER" };
    const f = fixture([transient()], [{ result: { data: [foreign], error: null, status: 200 } }]);
    await assert.rejects(appendLiveAuditEvent(f.service, expected), checkError({ reason: "READBACK_MISMATCH", phase: "READBACK" }));
    assert.equal(f.writes.length, 1, key);
  }
  const duplicate = fixture([transient()], [{ result: { data: [expected, expected], error: null, status: 200 } }]);
  await assert.rejects(appendLiveAuditEvent(duplicate.service, expected), checkError({ reason: "READBACK_MISMATCH" }));
});

test("same account/symbol engines on different shards cannot acknowledge each other's events", async () => {
  const engine01 = row(), engine03 = { ...row(), trading_engine_id: "engine-03", run_id: "run-engine-03" };
  const f = fixture([transient()], [{ result: { error: null, status: 200, data: [engine03] } }]);
  await assert.rejects(appendLiveAuditEvent(f.service, engine01), checkError({ reason: "READBACK_MISMATCH" }));
  assert.equal(f.reads[0].filters.trading_engine_id, "engine-01");
  assert.equal(f.reads[0].filters.run_id, "run-engine-01");
  assert.equal(f.stored.size, 0);
});

test("payload is cloned once and immutable while the caller changes its original object", async () => {
  const original = row();
  const f = fixture([{ ...transient(), before: () => {
    original.details.source = "CHANGED";
    ((original.details.nested as { amounts: number[] }).amounts).push(999);
    original.event_key = "DIFFERENT_KEY";
  } }]);
  await appendLiveAuditEvent(f.service, original);
  assert.equal(f.writes[0].row.event_key, "RECONCILED:2026-10-21T13:28");
  assert.equal(f.writes[1].row.details.source, "LIVE_CRON");
  assert.deepEqual((f.writes[1].row.details.nested as { amounts: number[] }).amounts, [1, 2, 3]);
  assert.ok(Object.isFrozen(f.writes[0].row)); assert.ok(Object.isFrozen(f.writes[0].row.details));
});

test("repeated successful appends preserve one row and never update the first immutable record", async () => {
  const f = fixture();
  await appendLiveAuditEvent(f.service, row()); await appendLiveAuditEvent(f.service, row());
  assert.equal(f.stored.size, 1); assert.equal(f.writes.length, 2);
  assert.ok(f.writes.every(item => (item.options as { ignoreDuplicates: boolean }).ignoreDuplicates));
});

test("lease loss remains its original error and prevents subsequent mutation or checkpoint lookup", async () => {
  for (const failureAt of [1, 2, 3]) {
    const f = fixture([transient()]); let renewal = 0;
    const lost = new Error("COINOPS_LIVE_LEASE_LOST");
    await assert.rejects(appendLiveAuditEvent(f.service, row(), { renewLease: async () => {
      if (++renewal === failureAt) throw lost;
    } }), error => error === lost);
    assert.deepEqual(f.sequence, failureAt === 1 ? [] : failureAt === 2 ? ["WRITE"] : ["WRITE", "READBACK"]);
  }
});

test("invalid or nonfinite/cyclic payload fails before IO; error evidence contains no private payload", async () => {
  for (const details of [{ invalid: NaN }, { invalid: Infinity }, { invalid: BigInt(1) }, { invalid: () => {} },
    { invalid: new Date() }]) {
    const f = fixture();
    await assert.rejects(appendLiveAuditEvent(f.service, { ...row(), details }), checkError({ reason: "PAYLOAD_INVALID", attempts: 0 }));
    assert.equal(f.writes.length, 0);
  }
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  await assert.rejects(appendLiveAuditEvent(fixture().service, { ...row(), details: cyclic }), checkError({ reason: "PAYLOAD_INVALID" }));
  const f = fixture([{ result: { error: { code: "private-secret-code", message: "private-secret-message" }, status: 403 } }]);
  try { await appendLiveAuditEvent(f.service, row()); assert.fail("must reject"); }
  catch (error) {
    assert.ok(error instanceof LiveAuditEventPersistError);
    assert.equal(error.providerCode, null);
    assert.equal(error.eventKey, "RECONCILED:2026-10-21T13:28");
    assert.doesNotMatch(`${error.message}${JSON.stringify(error)}`, /private-secret|account-shared/);
  }
});

test("error metadata exposes only the two safe audit key shapes, never order/client payload keys", () => {
  const reason = "TRANSIENT_EXHAUSTED";
  assert.equal(new LiveAuditEventPersistError("WRITE", reason, 2, "RECONCILED", undefined,
    "RECONCILED:2026-10-21T13:28").eventKey, "RECONCILED:2026-10-21T13:28");
  const reset = "RESET_RECOVERED:00112233-4455-6677-8899-aabbccddeeff";
  assert.equal(new LiveAuditEventPersistError("WRITE", reason, 2, "RESET_RECOVERED", undefined, reset).eventKey, reset);
  for (const [type, key] of [["FLOW_OWNER", "FLOW_OWNER:client-private"], ["RECONCILED", "private-client-id"],
    ["RESET_RECOVERED", "RESET_RECOVERED:invalid"], ["OTHER", "RECONCILED:2026-10-21T13:28"]])
    assert.equal(new LiveAuditEventPersistError("WRITE", reason, 2, type, undefined, key).eventKey, null);
});

test("actual request deadlines bound hanging writes and leave time for mandatory readback", { timeout: 8_000 }, async () => {
  const f = fixture([{ pending: true }, { pending: true }]);
  const keepAlive = setTimeout(() => {}, 7_000), started = performance.now();
  try {
    await assert.rejects(appendLiveAuditEvent(f.service, row()), checkError({ reason: "TRANSIENT_EXHAUSTED", phase: "WRITE", attempts: 2 }));
    const elapsed = performance.now() - started;
    assert.ok(elapsed >= 5_000 && elapsed < 7_000, `bounded two sets: ${elapsed}`);
    assert.deepEqual(f.sequence, ["WRITE", "READBACK", "WRITE", "READBACK"]);
    assert.ok(f.writes.every(write => write.signal.aborted));
    assert.equal(f.stored.size, 0);
  } finally { clearTimeout(keepAlive); }
});

test("a hanging readback fails closed without a second write", { timeout: 7_000 }, async () => {
  const f = fixture([transient()], [{ pending: true }]);
  const keepAlive = setTimeout(() => {}, 6_000), started = performance.now();
  try {
    await assert.rejects(appendLiveAuditEvent(f.service, row()), checkError({ reason: "READBACK_UNAVAILABLE", phase: "READBACK", attempts: 1 }));
    assert.ok(performance.now() - started < 6_000);
    assert.deepEqual(f.sequence, ["WRITE", "READBACK"]);
    assert.equal(f.reads[0].signal.aborted, true);
  } finally { clearTimeout(keepAlive); }
});
