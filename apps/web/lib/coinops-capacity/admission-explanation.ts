export type AdmissionExplanation = {
  code: string; reason: string; projected_weight: number | null; projected_percent: number | null;
  admission_limit_weight: number; recovery_headroom_weight: number; remaining_weight: number | null;
  observed_weight: number | null; reserved_weight: number; incremental_weight: number;
  pressure_phase: string; additional_engines: number;
  policy: { version: string; binance_limit: number; admission_ratio: number; recovery_ratio: number;
    incremental_weight: number; incremental_source: string; peak_hold_minutes: number };
};
const reasons: Record<string, string> = {
  CAPACITY_TELEMETRY_MISSING_OR_STALE: "telemetria ausente ou desatualizada",
  EXECUTOR_RESOURCE_HEADROOM_LOW: "CPU/RAM sem margem",
  SCHEDULER_OR_RECONCILIATION_SLOW: "fila ou reconciliação atrasada",
  RECENT_TRANSPORT_ERRORS: "erros recentes no transporte; aguardar estabilização",
  CAPACITY_POLICY_PARITY: "política de capacidade não validada",
  EXECUTOR_CONFIG_PARITY: "configuração do executor não certificada",
  RUNTIME_PARITY: "runtime diferente da release certificada",
  WATCHDOG_DISCOVERY: "Watchdog sem evidência recente",
  ENGINE_RECOVERY_IN_PROGRESS: "recuperação de motor em andamento",
  TELEMETRY_ACTIVE: "telemetria sem confirmação atual",
  BINANCE_WEIGHT_TRACKING: "amostras Binance insuficientes",
};
export function explainAdmission(value?: AdmissionExplanation | null): string {
  if (!value) return "NÃO — decisão indisponível";
  const limit = value.policy.admission_ratio * 100;
  if (value.code === "CAPACITY_OK" && Number.isFinite(value.projected_percent))
    return `SIM — projeção ${Number(value.projected_percent).toFixed(1)}% ≤ limite ${limit.toFixed(0)}%; reserva ${Math.round(value.policy.recovery_ratio * 100)}% preservada`;
  if (value.reason === "PROJECTED_BINANCE_WEIGHT_ABOVE_ADMISSION_LIMIT" && Number.isFinite(value.projected_percent))
    return `NÃO — projeção ${Number(value.projected_percent).toFixed(1)}% > limite ${limit.toFixed(0)}%`;
  return `NÃO — ${reasons[value.reason] ?? "admissão ainda não validada"}`;
}

export function pressureExplanation(phase?: string) {
  if (phase === "TRANSIENT_SPIKE") return "Pico anterior acima da faixa atual/média. Mantido no cálculo por até 15 min; não é bloqueio permanente nem prova de pressão sustentada.";
  if (phase === "SUSTAINED_PRESSURE") return "Pressão sustentada: a média da janela também atingiu o limite de capacidade.";
  if (phase === "CAPACITY_LIMIT") return "Consumo atual atingiu a faixa de capacidade; novas admissões aguardam margem.";
  if (phase === "WARNING") return "Pouca margem para novas admissões. Motores atuais continuam operando.";
  return null;
}
