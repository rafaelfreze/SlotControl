import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { assertAthProfileIdentity, athProfileRecoveryProof } from "./ath-profile-read.ts";
import { boundedLedgerRead, observeLedgerRecord } from "./live-ledger-read.ts";
import { LiveLedgerReadFailed, LiveReadUnavailable } from "./live-read-error.ts";
import { isAthProfileReadRecovery, mayRecoverReadOutage, verifiedReadRecoveryAlert } from "./live-read-recovery.ts";

const owner = { product_id: "p", tenant_id: "t", user_id: "u", operator_id: "o",
  exchange_account_id: "a", trading_engine_id: "e", asset: "SOL", quote_asset: "BRL" };
const profile = { ...owner, id: "profile", environment: "REAL", config_version: 3,
  gain_rate: .055, normal_spacing_rate: .015, post_ath_spacing_rate: .03,
  regime: "NORMAL", transition_key: null, ath_price: 296, ath_source: "HISTORY",
  updated_at: "2026-11-02T13:00:00Z", next_config_version: null, next_gain_rate: null,
  next_normal_spacing_rate: null, next_post_ath_spacing_rate: null };
const run = { ...owner, config_version: 3, gain_rate: .055, entry_regime: "NORMAL", entry_spacing: .015,
  ath_transition_key: null, config_snapshot: { gain_rate: .055, normal_spacing_rate: .015,
    post_ath_spacing_rate: .03, regime: "NORMAL", source_config_version: 3, ath_price: 296, ath_source: "HISTORY" } };
const legacy = { code: "COINOPS_ATH_PROFILE_UNAVAILABLE", alert_key: "LIVE_RUN:r:CRITICAL",
  first_seen_at: "2026-11-02T17:23:36Z", last_seen_at: "2026-11-02T17:23:36Z",
  details: { stage: "ATH_TRANSITION", root_code: "COINOPS_ATH_PROFILE_UNAVAILABLE" } };

function loader(responses: Array<{ data: unknown; error: unknown; status: number }>) {
  const calls: Array<Record<string, unknown>> = [];
  const service = { from(table: string) {
    assert.equal(table, "robot_v1_ath_profiles"); const filters: Record<string, unknown> = {};
    const q = { select: () => q, eq: (key: string, value: unknown) => { filters[key] = value; return q; },
      single: () => q, abortSignal: (signal: AbortSignal) => { assert.equal(signal.aborted, false); return q; },
      then: (resolve: (value: unknown) => unknown) => {
        const response = responses[Math.min(calls.length, responses.length - 1)]; calls.push(filters);
        return Promise.resolve(response).then(resolve);
      } };
    return q;
  } };
  const deps: Record<string, unknown> = { "./operator-context-server": { resolveOperatorEngine: async () => ({
    ...owner, symbol: "SOLBRL", ath_reference_symbol: "SOLUSDC" }) },
    "./live-ledger-read": { boundedLedgerRead, observeLedgerRecord }, "./ath-profile-read": { assertAthProfileIdentity } };
  const compiled = ts.transpileModule(readFileSync(new URL("./ath-profile-server.ts", import.meta.url), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: Record<string, unknown> = {};
  new Function("require", "exports", compiled)((name: string) => deps[name] ?? {}, exports);
  const load = exports.loadAthProfile as (...args: unknown[]) => Promise<Record<string, unknown>>;
  return { calls, load: () => load(service, { productId: "p", tenantId: "t", userId: "u",
    operatorId: "o", exchangeAccountId: "a", tradingEngineId: "e" }, "REAL", "SOL") };
}

test("REAL ATH GET retries503 once with exact ownership; never retries profile writes", async () => {
  const f = loader([{ data: null, error: { message: "unavailable" }, status: 503 },
    { data: profile, error: null, status: 200 }]);
  assert.equal((await f.load()).normal_spacing_rate, .015);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[0], { product_id: "p", tenant_id: "t", user_id: "u", environment: "REAL", asset: "SOL", trading_engine_id: "e" });
});

test("outage exhaustion retains typed evidence; permission/schema/missing/foreign data fail closed", async () => {
  const outage = loader([{ data: null, error: { message: "503" }, status: 503 }]);
  await assert.rejects(outage.load(), (e: unknown) => e instanceof LiveReadUnavailable
    && e.path === "ledger/ath_profile" && e.attempts === 2 && e.httpStatus === 503);
  assert.equal(outage.calls.length, 2);
  for (const response of [{ data: null, error: { code: "42501" }, status: 403 },
    { data: null, error: { code: "42P01" }, status: 404 }]) {
    const f = loader([response]); await assert.rejects(f.load(), LiveLedgerReadFailed); assert.equal(f.calls.length, 1);
  }
  for (const data of [null, { ...profile, trading_engine_id: "sibling" }, { ...profile, normal_spacing_rate: 0 }]) {
    const f = loader([{ data, error: null, status: 200 }]);
    await assert.rejects(f.load(), /COINOPS_ATH_PROFILE_(MISSING|INVALID)/); assert.equal(f.calls.length, 1);
  }
});

test("only exact legacy ATH GET or typed exhausted ATH stage may reach guarded recovery", () => {
  assert.equal(isAthProfileReadRecovery(legacy.code, legacy.details), true);
  assert.equal(mayRecoverReadOutage("ACTIVE", "OK", legacy.code, legacy.details), true);
  assert.deepEqual(verifiedReadRecoveryAlert("ACTIVE", "r", [legacy]), legacy);
  for (const details of [{ ...legacy.details, stage: "CONFIG_UPDATE" }, { ...legacy.details, http_status: 503 },
    { ...legacy.details, root_code: "OTHER" }]) assert.equal(isAthProfileReadRecovery(legacy.code, details), false);
  const typed = { stage: "ATH_TRANSITION", root_code: "COINOPS_LIVE_LEDGER_READ_UNAVAILABLE",
    read_path: "ledger/ath_profile", read_attempts: 2, http_status: 503 };
  const code = "COINOPS_LIVE_LEDGER_READ_STALE";
  assert.equal(mayRecoverReadOutage("ACTIVE", "OK", code, typed), true);
  for (const patch of [{ http_status: 403 }, { http_status: 526 }, { provider_code: "42501" },
    { read_attempts: 3 }, { read_attempts: undefined }, { stage: "ARM_ENTRY" }])
    assert.equal(mayRecoverReadOutage("ACTIVE", "OK", code, { ...typed, ...patch }), false);
  assert.equal(mayRecoverReadOutage("PAUSED", "OK", legacy.code, legacy.details), false);
});

test("BTC/SOL proof binds individual strategy, owner, regime/version and concurrent profile changes", () => {
  for (const asset of ["BTC", "SOL"]) {
    const p = { ...profile, asset }, r = { ...run, asset };
    const proof = athProfileRecoveryProof(p, r); assert.equal(proof, athProfileRecoveryProof({ ...p }, r));
    for (const changes of [{ trading_engine_id: "sibling" }, { exchange_account_id: "other" },
      { environment: "SHADOW" }, { config_version: 4 }, { normal_spacing_rate: .03 },
      { regime: "POST_ATH" }, { transition_key: "new" }, { next_config_version: 4 },
      { ath_price: 300 }, { ath_source: "OTHER" }]) assert.throws(() => athProfileRecoveryProof({ ...p, ...changes }, r));
    assert.notEqual(proof, athProfileRecoveryProof({ ...p, updated_at: "2026-11-02T13:01:00Z" }, r));
  }
});
