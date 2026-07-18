import assert from "node:assert/strict";
import test from "node:test";

import { buildPushNotification, classifyPushError, isNotificationEnabled, urlBase64ToUint8Array } from "./payload.ts";
import { DEFAULT_NOTIFICATION_PREFERENCES, type PushOutboxRecord } from "./types.ts";

function event(overrides: Partial<PushOutboxRecord> = {}): PushOutboxRecord {
  return {
    id: "outbox-1",
    event_id: "history:event-1",
    user_id: "user-1",
    event_type: "slot_entry",
    origin: "automatic",
    asset: "BTC",
    slot_id: "slot-1",
    operation_id: "operation-1",
    status: "pending",
    attempt_count: 1,
    payload: { slotNumber: 8, entryPrice: 63250, url: "/slots?asset=btc&slot=slot-1" },
    ...overrides
  };
}

test("gera payload de entrada BTC com dados persistidos", () => {
  const notification = buildPushNotification(event(), DEFAULT_NOTIFICATION_PREFERENCES);
  assert.equal(notification.title, "🟠 Entrada BTC confirmada");
  assert.match(notification.body, /Slot 08 aberto em/);
  assert.match(notification.body, /Entrada automática/);
});

test("gera payload de saída BTC", () => {
  const notification = buildPushNotification(event({ event_type: "slot_exit", payload: { slotNumber: 8, gainRate: 0.01, realizedProfit: 0.1 } }), DEFAULT_NOTIFICATION_PREFERENCES);
  assert.equal(notification.title, "✅ Saída BTC com gain");
  assert.match(notification.body, /Gain \+1%/);
  assert.match(notification.body, /Lucro/);
});

test("gera payloads SOL para entrada e saída", () => {
  const entry = buildPushNotification(event({ asset: "SOL", payload: { slotNumber: 4, entryPrice: 142.5 } }), DEFAULT_NOTIFICATION_PREFERENCES);
  const exit = buildPushNotification(event({ asset: "SOL", event_type: "slot_exit", payload: { slotNumber: 4, gainRate: 0.05 } }), DEFAULT_NOTIFICATION_PREFERENCES);
  assert.equal(entry.title, "🟣 Entrada SOL confirmada");
  assert.equal(exit.title, "✅ Saída SOL com gain");
});

test("modo privacidade não revela valores", () => {
  const notification = buildPushNotification(event(), { ...DEFAULT_NOTIFICATION_PREFERENCES, privacy_mode: true });
  assert.match(notification.body, /Toque para visualizar/);
  assert.doesNotMatch(notification.body, /63\.250/);
});

test("preferências filtram ativo e origem sem bloquear saída indevidamente", () => {
  const preferences = { ...DEFAULT_NOTIFICATION_PREFERENCES, global_enabled: true, btc_entry_enabled: false };
  assert.equal(isNotificationEnabled(preferences, event()), false);
  assert.equal(isNotificationEnabled(preferences, event({ event_type: "slot_exit" })), true);
  assert.equal(isNotificationEnabled({ ...preferences, automatic_events_enabled: false }, event()), false);
});

test("evento de teste ignora filtros de ativo, mas respeita ativação global", () => {
  assert.equal(isNotificationEnabled({ ...DEFAULT_NOTIFICATION_PREFERENCES, global_enabled: true }, event({ event_type: "test", origin: "test", asset: null })), true);
  assert.equal(isNotificationEnabled(DEFAULT_NOTIFICATION_PREFERENCES, event({ event_type: "test", origin: "test", asset: null })), false);
});

test("classifica subscription expirada e falha transitória", () => {
  assert.deepEqual(classifyPushError({ statusCode: 410, message: "Gone" }).expired, true);
  assert.deepEqual(classifyPushError({ statusCode: 503, message: "Unavailable" }).transient, true);
  assert.deepEqual(classifyPushError({ statusCode: 400, message: "Bad request" }).transient, false);
});

test("converte chave VAPID em bytes", () => {
  const originalAtob = globalThis.atob;
  globalThis.atob = (value: string) => Buffer.from(value, "base64").toString("binary");
  try {
    assert.deepEqual(Array.from(urlBase64ToUint8Array("AQIDBA")), [1, 2, 3, 4]);
  } finally {
    globalThis.atob = originalAtob;
  }
});

test("tag estável permite deduplicação visual por evento", () => {
  const first = buildPushNotification(event(), DEFAULT_NOTIFICATION_PREFERENCES);
  const retry = buildPushNotification(event(), DEFAULT_NOTIFICATION_PREFERENCES);
  assert.equal(first.tag, retry.tag);
});
