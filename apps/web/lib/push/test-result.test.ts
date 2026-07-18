import assert from "node:assert/strict";
import test from "node:test";

import {
  emptyPushTestResult,
  getPushTestResultMessage,
  isValidPushSubscriptionData
} from "./test-result.ts";

test("não apresenta sucesso quando não há assinatura válida", () => {
  const result = emptyPushTestResult({ subscriptionsFound: 0 });

  assert.equal(result.ok, false);
  assert.match(getPushTestResultMessage(result), /Nenhum dispositivo/);
});

test("apresenta sucesso somente quando o provedor aceitou ao menos um envio", () => {
  const result = emptyPushTestResult({
    ok: true,
    subscriptionsFound: 1,
    attempted: 1,
    deliveredToProvider: 1,
    results: [{ endpointHost: "web.push.apple.com", success: true, statusCode: 201, errorCode: null, message: null }]
  });

  assert.match(getPushTestResultMessage(result), /aceita pelo provedor/);
});

test("reporta envio parcial e subscriptions expiradas", () => {
  const result = emptyPushTestResult({
    subscriptionsFound: 2,
    attempted: 2,
    deliveredToProvider: 1,
    failed: 1,
    removedExpired: 1
  });

  assert.match(getPushTestResultMessage(result), /1 de 2/);
  assert.match(getPushTestResultMessage(result), /inválida foi removida/);
});

test("conta como válida somente a assinatura completa com endpoint HTTPS", () => {
  assert.equal(isValidPushSubscriptionData({ endpoint: "https://web.push.apple.com/device", p256dh: "key", auth: "auth" }), true);
  assert.equal(isValidPushSubscriptionData({ endpoint: "http://web.push.apple.com/device", p256dh: "key", auth: "auth" }), false);
  assert.equal(isValidPushSubscriptionData({ endpoint: "https://web.push.apple.com/device", p256dh: "", auth: "auth" }), false);
});
