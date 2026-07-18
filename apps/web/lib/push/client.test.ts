import assert from "node:assert/strict";
import test from "node:test";

import { activePushSubscriptionCount, getPushCapability, getPushPlatform, isStandaloneApp, shouldCreatePushSubscription } from "./client-state.ts";

test("detecta iPhone instalado como PWA e não bloqueia Android ou desktop", () => {
  assert.equal(getPushPlatform("Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X)"), "ios");
  assert.equal(getPushPlatform("Mozilla/5.0 (Linux; Android 14)"), "android");
  assert.equal(isStandaloneApp(false, true), true);
  assert.equal(getPushCapability({ secure: true, hasServiceWorker: true, hasPushManager: true, hasNotification: true, platform: "ios", standalone: false }), "requires-pwa");
  assert.equal(getPushCapability({ secure: true, hasServiceWorker: true, hasPushManager: true, hasNotification: true, platform: "android", standalone: false }), "ready");
});

test("distingue suporte, HTTPS e inscrição existente", () => {
  assert.equal(getPushCapability({ secure: false, hasServiceWorker: true, hasPushManager: true, hasNotification: true, platform: "desktop", standalone: false }), "insecure");
  assert.equal(getPushCapability({ secure: true, hasServiceWorker: false, hasPushManager: true, hasNotification: true, platform: "desktop", standalone: false }), "unsupported");
  assert.equal(shouldCreatePushSubscription({ endpoint: "https://push.example/subscription" } as PushSubscription), false);
  assert.equal(shouldCreatePushSubscription(null), true);
});

test("contador considera apenas inscrições ativas e não duplica a mesma inscrição", () => {
  const endpoint = "https://push.example/subscription";
  assert.equal(activePushSubscriptionCount([]), 0);
  assert.equal(activePushSubscriptionCount([{ endpoint, is_active: true, revoked_at: null }]), 1);
  assert.equal(activePushSubscriptionCount([{ endpoint, is_active: true, revoked_at: null }, { endpoint, is_active: true, revoked_at: null }]), 1);
  assert.equal(activePushSubscriptionCount([{ endpoint, is_active: false, revoked_at: "2026-07-18T00:00:00.000Z" }]), 0);
});
