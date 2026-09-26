import assert from "node:assert/strict";
import test from "node:test";
import { credentialOnboardingOperation } from "./credential-onboarding.ts";

test("new or failed credential attempts use CONNECT, not replacement of a missing vault file", () => {
  for (const value of [null, undefined, {}, { evidence: {} },
    { evidence: { status: "FAIL" } }, { evidence: { status: "PASS" } }])
    assert.equal(credentialOnboardingOperation(value), "CONNECT");
});
test("saved PASS or WARNING credentials may be replaced after existing backend guards", () => {
  for (const status of ["PASS", "WARNING"])
    assert.equal(credentialOnboardingOperation({ evidence: { status, fingerprint: "abc123" } }), "REPLACE");
});
test("removal evidence never masquerades as a currently stored credential", () => {
  for (const status of ["REMOVED", "NO_CHANGE"])
    assert.equal(credentialOnboardingOperation({ evidence: { status, fingerprint: "old-fingerprint" } }), "CONNECT");
});
