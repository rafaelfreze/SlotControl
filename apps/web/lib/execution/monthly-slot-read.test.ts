import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as policy from "./monthly-slot-policy.ts";
import * as reads from "./live-ledger-read.ts";
import * as errors from "./live-read-error.ts";

type Row = Record<string, unknown>;
type Failure = { code: string; status: number; persistent?: boolean };
function fixture(engineId = "engine-a", failures: Record<string, Failure> = {},
  instant = "2026-10-07T20:02:00Z") {
  const scope = { product_id: "product", tenant_id: "tenant", user_id: "user", asset: "BTC",
    operator_id: "operator", exchange_account_id: "same-account", trading_engine_id: engineId };
  const engine = { ...scope, legacy_compatible: false, executor_shard_id: engineId === "engine-a" ? "executor-02" : "executor-03" };
  const slots = Array.from({ length: 25 }, (_, i) => ({ slot_number: i + 1, balance_brl: 220,
    gain_count: i === 1 ? 1 : 0, entry_state: i < 5 ? "OPEN" : i === 5 ? "ARMED" : "PLANNED" }));
  const totals: Row[] = [{ slot_number: 2, physical_slot_id: `REAL:${engineId}:2`,
    lifetime_gain_count: 1, monthly_gain_count: 1, period_key: policy.monthlyPeriodKey(instant),
    market_gain_count: 1, manual_gain_count: 0, monthly_market_gain_count: 1, monthly_manual_gain_count: 0 }];
  const targets: Row[] = [{ monthly_target: 7 }];
  const attempts: Record<string, number> = {};
  const service = { from(table: string) {
    const filters: Row = {};
    const chain = { select: () => chain, limit: () => chain,
      eq: (key: string, value: unknown) => { filters[key] = value; return chain; },
      abortSignal: (signal: AbortSignal) => { assert.ok(signal instanceof AbortSignal); return chain; },
      then: (resolve: (value: unknown) => unknown) => {
        for (const key of ["product_id", "tenant_id", "user_id", "operator_id", "exchange_account_id", "trading_engine_id"])
          assert.equal(filters[key], scope[key as keyof typeof scope]);
        if (table === "robot_v1_slot_gain_totals") {
          assert.equal(filters.environment, "REAL"); assert.equal(filters.asset, "BTC");
        } else assert.equal(table, "robot_v1_live_preparations");
        const attempt = attempts[table] = (attempts[table] ?? 0) + 1;
        const failure = failures[table];
        return Promise.resolve(failure && (attempt === 1 || failure.persistent)
          ? { data: null, error: { code: failure.code, message: "PRIVATE", details: "PRIVATE" }, status: failure.status }
          : { data: table === "robot_v1_slot_gain_totals" ? totals : targets, error: null, status: 200 }).then(resolve);
      } };
    return chain;
  } };
  const deps: Record<string, unknown> = { "./monthly-slot-policy": policy,
    "./live-ledger-read": reads, "./live-read-error": errors,
    "./operator-context-server": { resolveOperatorEngine: async () => engine } };
  const compiled = ts.transpileModule(readFileSync(new URL("./monthly-slot-server.ts", import.meta.url), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: Record<string, unknown> = {};
  new Function("require", "exports", compiled)((name: string) => deps[name] ?? {}, exports);
  return { slots, totals, targets, attempts, read: () =>
    (exports.loadMonthlySlotStatuses as (...args: unknown[]) => Promise<policy.MonthlySlotStatus[]>)(service, "REAL", scope, slots, instant) };
}

test("Dete-shaped monthly GET outage retries the complete target/totals snapshot without changing gains or slots", async () => {
  const f = fixture("engine-a", { robot_v1_slot_gain_totals: { code: "PGRST003", status: 504 } });
  const before = JSON.stringify(f.slots);
  const result = await f.read();
  assert.equal(f.attempts.robot_v1_live_preparations, 2);
  assert.equal(f.attempts.robot_v1_slot_gain_totals, 2);
  assert.equal(result.length, 25);
  assert.equal(result[1].lifetimeGainCount, 1); assert.equal(result[1].monthlyGainCount, 1);
  assert.equal(result[1].monthlyGainTarget, 7); assert.equal(result[1].physicalSlotId, "REAL:engine-a:2");
  assert.equal(JSON.stringify(f.slots), before);
  assert.equal(result.filter(row => row.entryState === "OPEN").length, 5);
  assert.equal(result.filter(row => row.entryState === "ARMED").length, 1);
});

test("target transient GET retries; persistent monthly outage retains typed resource/status/attempt without a financial write", async () => {
  const target = fixture("engine-a", { robot_v1_live_preparations: { code: "", status: 503 } });
  assert.equal((await target.read()).length, 25);
  assert.equal(target.attempts.robot_v1_slot_gain_totals, 2);
  const down = fixture("engine-a", { robot_v1_slot_gain_totals: { code: "PGRST003", status: 504, persistent: true } });
  await assert.rejects(down.read(), error => {
    assert.ok(error instanceof errors.LiveReadUnavailable);
    assert.equal(error.path, "ledger/monthly_gains"); assert.equal(error.attempts, 2);
    const evidence = errors.liveFailureEvidence(error, "RECYCLE_SLOTS", "LIVE_CRON");
    assert.equal(evidence.http_status, 504); assert.equal(evidence.provider_code, "PGRST003");
    assert.ok(!JSON.stringify(evidence).includes("PRIVATE")); return true;
  });
});

test("monthly permission/schema denial cannot hide behind a parallel transient error", async () => {
  for (const code of ["42501", "42P01", "PGRST204"]) {
    const f = fixture("engine-a", { robot_v1_live_preparations: { code, status: 403 },
      robot_v1_slot_gain_totals: { code: "PGRST003", status: 504 } });
    await assert.rejects(f.read(), errors.LiveLedgerReadFailed);
    assert.equal(f.attempts.robot_v1_slot_gain_totals, 1);
    assert.equal(f.attempts.robot_v1_live_preparations, 1);
  }
});

test("missing/duplicate target, ambiguous/foreign facts and lifetime mismatch remain fail-closed", async () => {
  const cases: Array<(f: ReturnType<typeof fixture>) => void> = [
    f => { f.targets.length = 0; }, f => { f.targets.push({ monthly_target: 7 }); },
    f => { f.totals.push({ ...f.totals[0] }); }, f => { f.totals[0].slot_number = 26; },
    f => { f.totals[0].physical_slot_id = "REAL:engine-b:2"; },
    f => { f.totals[0].period_key = "2026-09"; }, f => { f.totals[0].lifetime_gain_count = 0; },
    f => { f.slots[24].slot_number = 1; },
  ];
  for (const change of cases) {
    const f = fixture(); change(f);
    await assert.rejects(f.read(), /MONTHLY_TARGET_UNAVAILABLE|MONTHLY_GAIN_LEDGER_AMBIGUOUS|MONTHLY_GAIN_LEDGER_MISMATCH|LEDGER_INCOMPLETE/);
    assert.ok(Object.values(f.attempts).every(attempt => attempt === 1));
  }
});

test("same account and symbol in separate engines/shards never share monthly facts", async () => {
  for (const id of ["engine-a", "engine-b"]) {
    const f = fixture(id);
    const result = await f.read();
    assert.ok(result.every(slot => slot.physicalSlotId.startsWith(`REAL:${id}:`)));
  }
});

test("calendar rollover preserves lifetime, physical identity, OPEN and ARMED while monthly counters reset", async () => {
  for (const instant of ["2026-10-01T04:00:00Z", "2027-01-01T04:00:00Z"]) {
    const f = fixture("engine-a", {}, instant);
    f.totals[0].monthly_gain_count = 0; f.totals[0].monthly_market_gain_count = 0;
    const result = await f.read();
    assert.equal(result[1].lifetimeGainCount, 1); assert.equal(result[1].monthlyGainCount, 0);
    assert.equal(result[1].physicalSlotId, "REAL:engine-a:2");
    assert.equal(result[1].timezone, "America/Campo_Grande");
    assert.equal(result.filter(row => row.entryState === "OPEN").length, 5);
    assert.equal(result.filter(row => row.entryState === "ARMED").length, 1);
  }
  const empty = fixture(); empty.totals.length = 0; empty.slots[1].gain_count = 0;
  assert.ok((await empty.read()).every(row => row.monthlyGainCount === 0 && row.lifetimeGainCount === 0));
});
