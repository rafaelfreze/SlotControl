import type { NotificationPreferences, PushNotificationContent, PushOutboxRecord } from "./types";

function asNumber(value: unknown) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function asText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function formatCurrency(value: unknown) {
  const number = asNumber(value);
  if (number === null) {
    return null;
  }

  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(number);
}

function formatPercent(value: unknown) {
  const number = asNumber(value);
  if (number === null) {
    return null;
  }

  return `${new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 }).format(number * 100)}%`;
}

export function isNotificationEnabled(preferences: NotificationPreferences, outbox: Pick<PushOutboxRecord, "event_type" | "origin" | "asset">) {
  if (!preferences.global_enabled) {
    return false;
  }

  if (outbox.origin === "manual" && !preferences.manual_events_enabled) {
    return false;
  }

  if (outbox.origin === "automatic" && !preferences.automatic_events_enabled) {
    return false;
  }

  if (outbox.event_type === "test") {
    return true;
  }

  if (outbox.asset === "BTC") {
    return outbox.event_type === "slot_entry" ? preferences.btc_entry_enabled : preferences.btc_exit_enabled;
  }

  if (outbox.asset === "SOL") {
    return outbox.event_type === "slot_entry" ? preferences.sol_entry_enabled : preferences.sol_exit_enabled;
  }

  return false;
}

export function buildPushNotification(outbox: PushOutboxRecord, preferences: Pick<NotificationPreferences, "privacy_mode">): PushNotificationContent {
  const payload = outbox.payload || {};
  const asset = outbox.asset || asText(payload.asset) || "BTC";
  const slotNumber = asNumber(payload.slotNumber);
  const slotLabel = slotNumber === null ? "Um slot" : `Slot ${String(slotNumber).padStart(2, "0")}`;
  const origin = outbox.origin === "automatic" ? "automática" : "manual";
  const url = asText(payload.url) || "/slots";
  const tag = `slot-control:${outbox.event_id}`;

  if (outbox.event_type === "test") {
    return {
      title: asText(payload.title) || "Teste de notificações do Slot Control",
      body: asText(payload.body) || "As notificações deste celular estão configuradas. Toque para abrir o painel.",
      tag,
      url,
      data: { eventId: outbox.event_id, url }
    };
  }

  if (preferences.privacy_mode) {
    const body = outbox.event_type === "slot_entry"
      ? `Um slot de ${asset} foi aberto. Toque para visualizar.`
      : `Um slot de ${asset} foi fechado com gain. Toque para visualizar.`;
    return {
      title: outbox.event_type === "slot_entry" ? `Entrada ${asset} confirmada` : `Saída ${asset} confirmada`,
      body,
      tag,
      url,
      data: { eventId: outbox.event_id, asset, eventType: outbox.event_type, slotId: outbox.slot_id, url }
    };
  }

  if (outbox.event_type === "slot_entry") {
    const price = formatCurrency(payload.entryPrice);
    return {
      title: asset === "BTC" ? "🟠 Entrada BTC confirmada" : "🟣 Entrada SOL confirmada",
      body: `${slotLabel} aberto${price ? ` em ${price}` : ""} • Entrada ${origin}`,
      tag,
      url,
      data: { eventId: outbox.event_id, asset, eventType: outbox.event_type, slotId: outbox.slot_id, url }
    };
  }

  const parts = [`${slotLabel} fechado`];
  const gainRate = formatPercent(payload.gainRate);
  const realizedProfit = formatCurrency(payload.realizedProfit);
  if (gainRate) parts.push(`Gain +${gainRate}`);
  if (realizedProfit) parts.push(`Lucro ${realizedProfit}`);

  return {
    title: "✅ Saída " + asset + " com gain",
    body: parts.join(" • "),
    tag,
    url,
    data: { eventId: outbox.event_id, asset, eventType: outbox.event_type, slotId: outbox.slot_id, url }
  };
}

export function urlBase64ToUint8Array(base64String: string) {
  const padded = base64String.padEnd(Math.ceil(base64String.length / 4) * 4, "=");
  const base64 = padded.replace(/-/g, "+").replace(/_/g, "/");
  const rawData = globalThis.atob(base64);
  return Uint8Array.from(rawData, (character) => character.charCodeAt(0));
}

export function classifyPushError(error: unknown) {
  const statusCode = typeof error === "object" && error !== null && "statusCode" in error
    ? Number((error as { statusCode?: unknown }).statusCode)
    : null;
  const message = error instanceof Error ? error.message : "Falha desconhecida no envio push";

  return {
    statusCode: Number.isFinite(statusCode) ? statusCode : null,
    code: statusCode === 404 || statusCode === 410 ? "subscription_expired" : statusCode && statusCode >= 500 ? "provider_transient" : "push_error",
    message: message.slice(0, 400),
    expired: statusCode === 404 || statusCode === 410,
    transient: statusCode === null || statusCode === 408 || statusCode === 425 || statusCode === 429 || statusCode >= 500
  };
}
