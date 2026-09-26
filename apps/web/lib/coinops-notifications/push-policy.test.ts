import assert from "node:assert/strict";
import { test } from "node:test";
import { alertDeepLink, publicPushReason, pushDeliveryErrorCode, pushIncidentKey, shouldPush, validPushEndpoint } from "./push-policy.ts";

test("classifies provider failures without exposing endpoint or response content", () => {
  assert.equal(pushDeliveryErrorCode(410), "COINOPS_PUSH_SUBSCRIPTION_EXPIRED");
  assert.equal(pushDeliveryErrorCode(403), "COINOPS_PUSH_PROVIDER_AUTH_FAILED");
  assert.equal(pushDeliveryErrorCode(429), "COINOPS_PUSH_PROVIDER_THROTTLED");
  assert.equal(pushDeliveryErrorCode(503), "COINOPS_PUSH_PROVIDER_UNAVAILABLE");
});

test("push only for operational warning/critical, not info", () => {
  assert.equal(shouldPush("CRITICAL", false), true);
  assert.equal(shouldPush("WARNING", true), true);
  assert.equal(shouldPush("WARNING", false), false);
  assert.equal(shouldPush("INFO", true), false);
});
test("incident key is per alert opening and device", () => {
  assert.equal(pushIncidentKey("a", "t1", "d"), pushIncidentKey("a", "t1", "d"));
  assert.notEqual(pushIncidentKey("a", "t1", "d"), pushIncidentKey("a", "t2", "d"));
  assert.notEqual(pushIncidentKey("a", "t1", "d"), pushIncidentKey("a", "t1", "e"));
});
test("deep link scopes account and market and never accepts arbitrary URL", () => {
  assert.equal(alertDeepLink("6918a0fa-39fd-423a-bc60-ee8d8ecffb25", "SOLBRL"),
    "/automacao?view=live&account=6918a0fa-39fd-423a-bc60-ee8d8ecffb25&market=SOLBRL&tab=alerts#premium-operations");
  assert.match(alertDeepLink("6918a0fa-39fd-423a-bc60-ee8d8ecffb25", "BTCUSDT", "TESTNET"), /view=testnet.*tab=alerts/);
  assert.match(alertDeepLink("6918a0fa-39fd-423a-bc60-ee8d8ecffb25", "BTCUSDT", "TESTNET",
    "5580c011-6ff1-44bd-b568-85932b424ceb"), /alert=5580c011-6ff1-44bd-b568-85932b424ceb/);
  assert.throws(() => alertDeepLink("https://evil.test", "BTCBRL"));
  assert.throws(() => alertDeepLink("6918a0fa-39fd-423a-bc60-ee8d8ecffb25", "../evil"));
});
test("push payload uses allowlisted public reasons", () => {
  assert.equal(publicPushReason("COINOPS_LIVE_RESET_FAILED"), "Falha na transição do ciclo");
  assert.equal(publicPushReason("SECRET_VALUE"), "Robô requer atenção operacional");
});
test("subscription endpoints cannot target internal hosts", () => {
  assert.equal(validPushEndpoint("https://fcm.googleapis.com/fcm/send/id"), true);
  assert.equal(validPushEndpoint("https://web.push.apple.com/Q"), true);
  assert.equal(validPushEndpoint("http://localhost/push"), false);
  assert.equal(validPushEndpoint("https://169.254.169.254/push"), false);
});
