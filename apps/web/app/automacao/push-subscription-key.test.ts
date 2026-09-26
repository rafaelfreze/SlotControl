import assert from "node:assert/strict";
import { test } from "node:test";
import { createECDH } from "node:crypto";
import { applicationKey, subscriptionUsesKey } from "./push-subscription-key.ts";

test("keeps an iPhone subscription only when it uses the current VAPID public key", () => {
  const first = createECDH("prime256v1"); first.generateKeys();
  const second = createECDH("prime256v1"); second.generateKeys();
  const publicKey = first.getPublicKey("base64url", "uncompressed");
  const matching = { options: { applicationServerKey: applicationKey(publicKey).buffer } } as Pick<PushSubscription, "options">;
  const old = { options: { applicationServerKey: applicationKey(second.getPublicKey("base64url", "uncompressed")).buffer } } as Pick<PushSubscription, "options">;
  assert.equal(subscriptionUsesKey(matching, publicKey), true);
  assert.equal(subscriptionUsesKey(old, publicKey), false);
  assert.equal(subscriptionUsesKey({ options: { applicationServerKey: null } } as Pick<PushSubscription, "options">, publicKey), false);
});
