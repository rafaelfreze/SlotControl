const REASONS: Record<string, string> = {
  EXECUTOR_OFFLINE: "Executor sem heartbeat recente",
  EXECUTOR_CAPACITY_WARNING: "Capacidade exige atenção",
  BINANCE_WEIGHT_WARNING: "Orçamento Binance elevado; preparar novo executor/IP",
  SCHEDULER_BACKLOG_WARNING: "Fila de reconciliação atrasada",
  ENGINE_STALE: "Motor sem reconciliação recente",
  EXECUTOR_RESOURCE_WARNING: "CPU, memória ou telemetria exigem atenção",
  CAPACITY_LIMIT: "Capacidade atingida; novas ativações bloqueadas",
};
export function capacityAlertMessage(alert: { id: string; shard_id: string; code: string; first_seen_at: string }) {
  if (!/^executor-[0-9]{2,}$/.test(alert.shard_id) || !REASONS[alert.code]
    || !Number.isFinite(Date.parse(alert.first_seen_at))) throw new Error("COINOPS_CAPACITY_ALERT_INVALID");
  const time = new Date(alert.first_seen_at).toLocaleTimeString("pt-BR", {
    timeZone: "America/Campo_Grande", hour: "2-digit", minute: "2-digit" });
  return { title: "CoinOps — ALERTA",
    body: `${alert.shard_id.replace("executor-", "Executor ")} · ${REASONS[alert.code]} · ${time}`,
    url: `/automacao?view=live#infra-${alert.shard_id}`,
    tag: `capacity:${alert.id}:${alert.first_seen_at}` };
}
