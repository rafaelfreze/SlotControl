import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { FUNDING_WARNING_AWARENESS_KEY, fundingOnlyBannerAcknowledged, fundingWarningFingerprint,
  readFundingWarningAwareness, updateFundingWarningAwareness } from "./funding-warning-awareness.ts";

const engineId = "20000000-0000-4000-8000-000000000002";
const warning = { code: "COINOPS_LIVE_QUOTE_BALANCE_INSUFFICIENT", severity: "WARNING", at: "2026-10-13T12:00:00Z" };
const storage = () => { const values = new Map<string, string>(); return {
  values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); },
}; };
const engine = () => ({ engineId, engineStatus: "ACTIVE", killSwitch: false,
  health: { label: "AGUARDANDO SALDO" }, activeIssueCount: 1, alerts: [warning] });

test("only canonical known funding WARNING incarnations can be acknowledged", () => {
  assert.ok(fundingWarningFingerprint(engineId, warning));
  assert.ok(fundingWarningFingerprint(engineId, { ...warning, code: "COINOPS_LIVE_BNB_FEE_RESERVE_MISSING" }));
  for (const severity of ["CRITICAL", "ERROR", "INFO"])
    assert.equal(fundingWarningFingerprint(engineId, { ...warning, severity }), null);
  for (const code of ["COINOPS_LIVE_BNB_FEE_BALANCE_UNAVAILABLE", "COINOPS_LIVE_QUOTE_BALANCE_UNAVAILABLE",
    "COINOPS_LIVE_SUBMISSION_OUTCOME_UNKNOWN", "COINOPS_ENGINE_LEDGER_UNAVAILABLE"])
    assert.equal(fundingWarningFingerprint(engineId, { ...warning, code }), null);
  assert.equal(fundingWarningFingerprint(engineId, { ...warning, at: null }), null);
});

test("new engine, code or warning timestamp reappears and reexibir is reversible", () => {
  const browser = storage(), fingerprint = fundingWarningFingerprint(engineId, warning)!;
  const acknowledged = new Set(updateFundingWarningAwareness(browser, [fingerprint], true));
  assert.equal(fundingOnlyBannerAcknowledged(engine(), acknowledged), true);
  assert.equal(fundingOnlyBannerAcknowledged({ ...engine(), alerts: [{ ...warning, at: "2026-10-13T12:01:00Z" }] }, acknowledged), false);
  assert.equal(fundingOnlyBannerAcknowledged({ ...engine(), engineId: "20000000-0000-4000-8000-000000000003" }, acknowledged), false);
  assert.equal(fundingOnlyBannerAcknowledged({ ...engine(), alerts: [{ ...warning, code: "COINOPS_LIVE_BNB_FEE_RESERVE_MISSING" }] }, acknowledged), false);
  assert.deepEqual(updateFundingWarningAwareness(browser, [fingerprint], false), []);
  assert.equal(readFundingWarningAwareness(storage()).length, 0); // another browser/device is independent
});

test("critical or non-alert operational problems cannot disappear behind an acknowledged funding warning", () => {
  const known = new Set([fundingWarningFingerprint(engineId, warning)!]);
  assert.equal(fundingOnlyBannerAcknowledged({ ...engine(), health: { label: "REVISAR LIVE" } }, known), false);
  assert.equal(fundingOnlyBannerAcknowledged({ ...engine(), activeIssueCount: 2 }, known), false);
  assert.equal(fundingOnlyBannerAcknowledged({ ...engine(), killSwitch: true }, known), false);
  assert.equal(fundingOnlyBannerAcknowledged({ ...engine(), engineStatus: "BLOCKED" }, known), false);
  assert.equal(fundingOnlyBannerAcknowledged({ ...engine(), alerts: [warning, { ...warning, code: "COINOPS_LIVE_SUBMISSION_OUTCOME_UNKNOWN", severity: "CRITICAL" }] }, known), false);
});

test("local preference stores no amount or payload and failed storage cannot silently acknowledge", () => {
  const browser = storage(), key = fundingWarningFingerprint(engineId, warning)!;
  updateFundingWarningAwareness(browser, [key], true);
  assert.deepEqual(JSON.parse(browser.getItem(FUNDING_WARNING_AWARENESS_KEY)!), [key]);
  assert.throws(() => updateFundingWarningAwareness({ getItem: () => null, setItem: () => { throw new Error("STORAGE_DENIED"); } }, [key], true));
  const source = readFileSync(new URL("./funding-warning-awareness.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /fetch\(|resolved_at|createServiceRoleClient|kill_switch|sendPush/);
  const premium = readFileSync(new URL("./premium-automation.tsx", import.meta.url), "utf8");
  assert.match(premium, /fundingOnlyBannerAcknowledged\(item, acknowledgedFunding\)/);
  assert.match(premium, /Aguardando saldo · ciente/);
  assert.match(premium, /ledger, notificações e operação continuam sem alterações/);
});
