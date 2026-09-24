import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { latestOnboardingChecks, validateAccountDraft, type AccountDraft, type OnboardingCheck } from "./operator-onboarding.ts";

const account = "10000000-0000-4000-8000-000000000001", engine = "20000000-0000-4000-8000-000000000001";
const draft: AccountDraft = { accountId: account, engineId: engine, displayName: "Fictícia A", environment: "REAL",
  symbol: "BTCUSDT", capital: "100", engineCap: "120", accountCap: "200", gainPercent: "1.2", spacingPercent: "1", postAthPercent: "5" };
test("onboarding draft validates native caps and explicit immutable IDs without activating", () => {
  const parsed = validateAccountDraft(draft);
  assert.equal(parsed.quote, "USDT"); assert.equal(parsed.capital, 100); assert.equal(parsed.gain, .012);
  for (const changed of [{ accountId: "ALL" }, { engineId: account }, { capital: "201" }, { engineCap: "300" },
    { symbol: "ETHBTC" }, { gainPercent: "NaN" }, { spacingPercent: "0" }, { environment: "TESTNET", symbol: "BTCBRL" }])
    assert.throws(() => validateAccountDraft({ ...draft, ...changed } as AccountDraft));
});
test("onboarding never borrows a PASS from another account or engine", () => {
  const row: OnboardingCheck = { exchange_account_id: account, trading_engine_id: engine,
    check_key: "READ_ONLY", status: "PASS", checked_at: "2026-09-24T14:00:00Z" };
  assert.equal(latestOnboardingChecks([row], account, engine).find((item) => item.key === "READ_ONLY")?.evidence?.status, "PASS");
  assert.equal(latestOnboardingChecks([row], "B", engine).find((item) => item.key === "READ_ONLY")?.evidence, null);
  assert.equal(latestOnboardingChecks([row], account, "B").find((item) => item.key === "READ_ONLY")?.evidence, null);
  assert.equal(latestOnboardingChecks([row, { ...row, status: "FAIL", checked_at: "2026-09-24T15:00:00Z" }], account, engine)
    .find((item) => item.key === "READ_ONLY")?.evidence?.status, "FAIL");
});
test("administrative writers authenticate the operator and never activate, accept secrets or dispatch orders", () => {
  const action = readFileSync(new URL("./operator-onboarding-actions.ts", import.meta.url), "utf8");
  const panel = readFileSync(new URL("./operator-onboarding-panel.tsx", import.meta.url), "utf8");
  assert.match(action, /auth\.getUser\(\)/);
  assert.match(action, /eq\("user_id", user\.id\)\.eq\("status", "ACTIVE"\)/);
  assert.match(action, /status: "INACTIVE", kill_switch: true/);
  assert.match(action, /loadLiveProductionSnapshot\(engine\)/);
  assert.match(action, /snapshot\.exchange_account_id !== engine\.exchange_account_id/);
  assert.doesNotMatch(action, /(?:createOrder|cancelOrder|startLive|advanceLive)\s*\(/);
  assert.doesNotMatch(panel, /name="(?:credential_ref|apiKey|apiSecret|api_key|api_secret)"/);
  assert.doesNotMatch(panel, /type="checkbox"/);
});
