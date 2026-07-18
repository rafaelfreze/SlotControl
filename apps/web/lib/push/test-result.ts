export type PushTestDeliveryResult = {
  endpointHost: string | null;
  success: boolean;
  statusCode: number | null;
  errorCode: string | null;
  message: string | null;
};

export type PushTestResult = {
  ok: boolean;
  rateLimited: boolean;
  subscriptionsFound: number;
  attempted: number;
  deliveredToProvider: number;
  failed: number;
  removedExpired: number;
  currentDeviceMatched: boolean;
  results: PushTestDeliveryResult[];
};

export function emptyPushTestResult(overrides: Partial<PushTestResult> = {}): PushTestResult {
  return {
    ok: false,
    rateLimited: false,
    subscriptionsFound: 0,
    attempted: 0,
    deliveredToProvider: 0,
    failed: 0,
    removedExpired: 0,
    currentDeviceMatched: false,
    results: [],
    ...overrides
  };
}

export function getPushTestResultMessage(result: PushTestResult) {
  if (result.rateLimited) {
    return "Aguarde alguns segundos antes de enviar outro teste.";
  }

  if (!result.subscriptionsFound) {
    return "Nenhum dispositivo com assinatura push válida foi encontrado. Ative novamente as notificações neste celular.";
  }

  if (result.deliveredToProvider > 0 && result.failed === 0) {
    return `Notificação aceita pelo provedor para ${result.deliveredToProvider} ${result.deliveredToProvider === 1 ? "dispositivo" : "dispositivos"}.`;
  }

  if (result.deliveredToProvider > 0) {
    const removed = result.removedExpired ? ` ${result.removedExpired} assinatura${result.removedExpired === 1 ? "" : "s"} inválida${result.removedExpired === 1 ? " foi removida" : "s foram removidas"}.` : "";
    return `Notificação aceita em ${result.deliveredToProvider} de ${result.attempted} dispositivos.${removed}`;
  }

  return "Não foi possível enviar a notificação. Verifique a assinatura deste dispositivo.";
}

export function normalizeUrlSafeBase64(value: string | null | undefined) {
  return (value || "")
    .trim()
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function isValidPushSubscriptionData(input: { endpoint?: string | null; p256dh?: string | null; auth?: string | null }) {
  return Boolean(
    input.endpoint?.startsWith("https://") &&
    /^[A-Za-z0-9_-]+$/.test(normalizeUrlSafeBase64(input.p256dh)) &&
    /^[A-Za-z0-9_-]+$/.test(normalizeUrlSafeBase64(input.auth))
  );
}
