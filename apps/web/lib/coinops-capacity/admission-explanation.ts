export type AdmissionExplanation = {
  code: string; reason: string; projected_weight: number | null; projected_percent: number | null;
  admission_limit_weight: number; recovery_headroom_weight: number; remaining_weight: number | null;
  observed_weight: number | null; reserved_weight: number; incremental_weight: number;
  pressure_phase: string; additional_engines: number;
  sustained_weight?: number | null; current_weight?: number | null; peak_weight?: number | null;
  executor_state?: string; scale_action?: string; healthy_seconds?: number;
  decision_observed_at?: string | null; last_transition_at?: string | null;
  policy: { version: string; binance_limit: number; admission_ratio: number; recovery_ratio: number;
    incremental_weight: number; incremental_source: string; peak_hold_minutes: number;
    pressure_window_minutes?: number; reopen_ratio?: number; reopen_healthy_seconds?: number };
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
  BINANCE_WEIGHT_CRITICAL_NOW: "consumo atual crítico; bloqueio imediato",
  BINANCE_PROJECTED_CRITICAL_NOW: "projeção atual crítica; bloqueio imediato",
  HYSTERESIS_EVIDENCE_MISSING: "aguardando histórico server-side",
  RECOVERY_MARGIN_NOT_REACHED: "aguardando margem estável de recuperação",
};
export function explainAdmission(value?: AdmissionExplanation | null): string {
  if (!value) return "NÃO — decisão indisponível";
  const limit = value.policy.admission_ratio * 100;
  const sustained = value.sustained_weight === undefined || value.sustained_weight === null ? null
    : value.sustained_weight / value.policy.binance_limit * 100;
  const prefix = sustained === null ? "" : `pressão sustentada ${sustained.toFixed(1)}%, `;
  if (value.code === "CAPACITY_OK" && Number.isFinite(value.projected_percent))
    return `SIM — ${prefix}projeção ${Number(value.projected_percent).toFixed(1)}% ≤ limite ${limit.toFixed(0)}%; reserva ${Math.round(value.policy.recovery_ratio * 100)}% preservada`;
  if (["PROJECTED_BINANCE_WEIGHT_ABOVE_ADMISSION_LIMIT", "SUSTAINED_PROJECTION_ABOVE_ADMISSION_LIMIT"].includes(value.reason) && Number.isFinite(value.projected_percent))
    return `NÃO — ${prefix}projeção ${Number(value.projected_percent).toFixed(1)}% > limite ${limit.toFixed(0)}%`;
  if (value.reason === "RECOVERY_STABILIZING")
    return `NÃO — estabilização ${Math.floor((value.healthy_seconds ?? 0) / 60)}/${Math.round((value.policy.reopen_healthy_seconds ?? 600) / 60)} min; reabertura com projeção ≤ ${Math.round((value.policy.reopen_ratio ?? .60) * 100)}%`;
  return `NÃO — ${reasons[value.reason] ?? "admissão ainda não validada"}`;
}

export function pressureExplanation(phase?: string) {
  if (phase === "TRANSIENT_SPIKE") return "Pico transitório em observação. A admissão usa a média dos máximos por minuto da janela de 15 min; o pico isolado não fecha o gate.";
  if (phase === "SUSTAINED_PRESSURE") return "Pressão sustentada: a média dos máximos por minuto mais a nova carga excede a margem de admissão.";
  if (phase === "RECOVERY") return "Decisão persistida: a reabertura exige 10 min contínuos com projeção até 60%. Reload não reinicia nem acelera esse prazo.";
  if (phase === "CAPACITY_LIMIT") return "Consumo atual atingiu a faixa de capacidade; novas admissões aguardam margem.";
  if (phase === "WARNING") return "Pouca margem para novas admissões. Motores atuais continuam operando.";
  return null;
}
