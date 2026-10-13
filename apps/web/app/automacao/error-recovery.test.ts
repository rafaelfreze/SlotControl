import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { AUTOMATION_READ_TRANSIENT_DIGEST, claimAutomationReadRecovery, clearAutomationReadRecovery,
  planAutomationReadRecovery } from "./automation-read-recovery.ts";

const source = readFileSync(new URL("./error.tsx", import.meta.url), "utf8");
const premium = readFileSync(new URL("./premium-automation.tsx", import.meta.url), "utf8");
const storage = () => {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
};

test("transient panel reads have two attempts per episode, never replenished by focus or time", () => {
  const session = storage();
  assert.deepEqual(planAutomationReadRecovery(session, "/automacao", AUTOMATION_READ_TRANSIENT_DIGEST), { attempt: 1, delay: 5_000 });
  assert.equal(claimAutomationReadRecovery(session, "/automacao", AUTOMATION_READ_TRANSIENT_DIGEST), true);
  assert.deepEqual(planAutomationReadRecovery(session, "/automacao", AUTOMATION_READ_TRANSIENT_DIGEST), { attempt: 2, delay: 15_000 });
  assert.equal(claimAutomationReadRecovery(session, "/automacao", AUTOMATION_READ_TRANSIENT_DIGEST), true);
  for (let focus = 0; focus < 10; focus++) {
    assert.equal(planAutomationReadRecovery(session, "/automacao", AUTOMATION_READ_TRANSIENT_DIGEST), null);
    assert.equal(claimAutomationReadRecovery(session, "/automacao", AUTOMATION_READ_TRANSIENT_DIGEST), false);
  }
});

test("successful page ends an episode so a later transient incident is recoverable again", () => {
  const session = storage(); session.setItem("unrelated", "preserved");
  claimAutomationReadRecovery(session, "/automacao", AUTOMATION_READ_TRANSIENT_DIGEST);
  claimAutomationReadRecovery(session, "/automacao", AUTOMATION_READ_TRANSIENT_DIGEST);
  clearAutomationReadRecovery(session, "/automacao");
  assert.deepEqual(planAutomationReadRecovery(session, "/automacao", AUTOMATION_READ_TRANSIENT_DIGEST), { attempt: 1, delay: 5_000 });
  assert.equal(session.getItem("unrelated"), "preserved");
  assert.match(premium, /clearAutomationReadRecovery\(window\.sessionStorage, window\.location\.pathname\)/);
});

test("unknown, auth, permission and schema failures cannot request automatic page recovery", () => {
  for (const digest of [undefined, "1820357831", "COINOPS_ACCOUNT_SCOPE_DENIED", "COINOPS_OPERATOR_SCOPE_UNAVAILABLE", "42501", "42703"]) {
    const session = storage();
    assert.equal(planAutomationReadRecovery(session, "/automacao", digest), null);
    assert.equal(claimAutomationReadRecovery(session, "/automacao", digest), false);
    assert.equal(session.values.size, 0);
  }
  assert.equal(planAutomationReadRecovery(storage(), "/meu-coinops", AUTOMATION_READ_TRANSIENT_DIGEST), null);
});

test("blocked storage and malformed budgets remain explicit manual-only recovery", () => {
  const unavailable = { getItem: () => { throw new Error("STORAGE_DISABLED"); }, setItem: () => {}, removeItem: () => {} };
  assert.equal(planAutomationReadRecovery(unavailable, "/automacao", AUTOMATION_READ_TRANSIENT_DIGEST), null);
  const session = storage();
  session.setItem("coinops-automation-read-recovery-v2:/automacao", "not-json");
  assert.equal(planAutomationReadRecovery(session, "/automacao", AUTOMATION_READ_TRANSIENT_DIGEST), null);
});

test("boundary requests fresh RSC GET and reset together, visible/online only, no financial action", () => {
  assert.match(source, /startTransition\(\(\) => \{ router\.refresh\(\); reset\(\); \}\)/);
  assert.match(source, /document\.visibilityState !== "visible"/);
  assert.match(source, /!window\.navigator\.onLine/);
  assert.match(source, /claimAutomationReadRecovery/);
  assert.match(source, /previousError\.current !== error \|\| sawPending\.current/);
  assert.match(source, /disabled=\{isPending\}/);
  assert.doesNotMatch(source, /setInterval|location\.reload|method: "POST"|placeOrder|cancelOrder|coinops-automation-auto-retry-v1/);
});
