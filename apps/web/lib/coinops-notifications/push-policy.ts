export type AlertSeverity = "INFO" | "WARNING" | "CRITICAL";

export function pushDeliveryErrorCode(status?: number) {
  if (status === 404 || status === 410) return "COINOPS_PUSH_SUBSCRIPTION_EXPIRED";
  if (status === 401 || status === 403) return "COINOPS_PUSH_PROVIDER_AUTH_FAILED";
  if (status === 429) return "COINOPS_PUSH_PROVIDER_THROTTLED";
  return "COINOPS_PUSH_PROVIDER_UNAVAILABLE";
}

export function shouldPush(severity: AlertSeverity, warningEnabled: boolean) {
  return severity === "CRITICAL" || severity === "WARNING" && warningEnabled;
}

export function pushIncidentKey(alertId: string, openedAt: string, subscriptionId: string) {
  return `${alertId}:${openedAt}:${subscriptionId}`;
}

export function alertDeepLink(accountId: string, symbol: string, environment: "REAL" | "TESTNET" = "REAL", alertId?: string, engineId?: string) {
  if (!/^[0-9a-f-]{36}$/i.test(accountId) || !/^[A-Z0-9]{4,20}$/.test(symbol))
    throw new Error("COINOPS_PUSH_SCOPE_INVALID");
  if (alertId && !/^[0-9a-f-]{36}$/i.test(alertId)) throw new Error("COINOPS_PUSH_ALERT_ID_INVALID");
  if (engineId && !/^[0-9a-f-]{36}$/i.test(engineId)) throw new Error("COINOPS_PUSH_ENGINE_ID_INVALID");
  return `/automacao?view=${environment === "REAL" ? "live" : "testnet"}&account=${encodeURIComponent(accountId)}&market=${encodeURIComponent(symbol)}&tab=alerts${alertId ? `&alert=${encodeURIComponent(alertId)}` : ""}${engineId ? `&engine=${encodeURIComponent(engineId)}` : ""}#premium-operations`;
}

export function publicPushReason(code: string) {
  const known: Record<string, string> = {
    COINOPS_LIVE_RESET_FAILED: "Falha na transição do ciclo",
    STRATEGY_PRICE_INVARIANT_FAILED: "Preço estratégico divergente",
    COINOPS_STRATEGY_PRICE_INVARIANT_FAILED: "Preço estratégico divergente",
    ENGINE_HEARTBEAT_STALE: "Robô sem reconciliação recente",
    ENGINE_KILL_SWITCH_ON: "Kill switch acionado",
    TESTNET_PUSH_PROBE: "Teste controlado de alerta Testnet",
    COINOPS_LIVE_TP_MISSING: "Posição sem proteção TP",
    COINOPS_LIVE_RECONCILIATION_FAILED: "Falha de reconciliação",
    COINOPS_LIVE_ORDER_REJECTED: "Ordem rejeitada",
    COINOPS_LIVE_LEDGER_READ_FAILED: "Falha de leitura do ledger",
    COINOPS_LIVE_LEDGER_READ_STALE: "Leitura do ledger sem recuperação",
    COINOPS_LIVE_ACCOUNT_BUDGET_ALERT_RESOLVE_FAILED: "Falha ao encerrar aviso operacional",
    COINOPS_MONTHLY_GAIN_LEDGER_UNAVAILABLE: "Totais mensais indisponíveis",
  };
  return known[code] ?? "Robô requer atenção operacional";
}

/** Error codes are allowlisted identifiers, never a provider body or arbitrary message. */
export function publicBlockedPushReason(code: string) {
  const reason = publicPushReason(code);
  if (reason !== "Robô requer atenção operacional") return reason;
  return /^(?:COINOPS|WATCHDOG|ENGINE)_[A-Z0-9_]{1,110}$/.test(code)
    ? code : "Bloqueio operacional confirmado";
}

export function validPushEndpoint(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
    const host = url.hostname.toLowerCase();
    return host === "fcm.googleapis.com" || host === "updates.push.services.mozilla.com"
      || host === "web.push.apple.com" || host.endsWith(".push.apple.com")
      || host.endsWith(".notify.windows.com");
  } catch { return false; }
}
