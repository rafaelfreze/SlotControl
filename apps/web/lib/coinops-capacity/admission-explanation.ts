export type AdmissionExplanation = {
  code: string; reason: string; projected_weight: number | null; projected_percent: number | null;
  admission_limit_weight: number; recovery_headroom_weight: number; remaining_weight: number | null;
  observed_weight: number | null; reserved_weight: number; incremental_weight: number;
  pressure_phase: string; additional_engines: number;
  sustained_weight?: number | null; current_weight?: number | null; peak_weight?: number | null;
  executor_state?: string; scale_action?: string; healthy_seconds?: number;
  decision_observed_at?: string | null; last_transition_at?: string | null;
  telemetry?: AdmissionTelemetry;
  policy: { version: string; binance_limit: number; admission_ratio: number; recovery_ratio: number;
    incremental_weight: number; incremental_source: string; peak_hold_minutes: number;
    pressure_window_minutes?: number; reopen_ratio?: number; reopen_healthy_seconds?: number;
    minimum_weight_samples?: number; telemetry_max_age_seconds?: number };
};
export type AdmissionTelemetry = {
  weight_samples: number | null; minimum_weight_samples: number | null;
  observed_at: string | null; weight_observed_at: string | null; heartbeat_at: string | null;
  timing: "FRESH" | "STALE" | "UNVERIFIED"; decision_matches_sample: boolean;
};

/** Diagnostic evidence only. The RPC remains the sole admission authority.
 * Samples and decisions are separate read snapshots: never imply that a fresh
 * short window is the only failed gate, or advance its persisted clock here. */
export function withAdmissionTelemetry(value: AdmissionExplanation | undefined,
  sample: Record<string, unknown> | null, now = Date.now()): AdmissionExplanation | undefined {
  if (!value) return value;
  const count = (input: unknown) => typeof input === "number" && Number.isSafeInteger(input) && input >= 0 ? input : null;
  const timestamp = (input: unknown) => typeof input === "string" && Number.isFinite(Date.parse(input)) ? input : null;
  const observedAt = timestamp(sample?.observed_at);
  const weightObservedAt = timestamp(sample?.weight_observed_at);
  const heartbeatAt = timestamp(sample?.heartbeat_at);
  const maxAge = count(value.policy.telemetry_max_age_seconds);
  const times = [observedAt, weightObservedAt, heartbeatAt];
  const timing = !Number.isFinite(now) || maxAge === null || maxAge === 0 || times.some((time) => !time)
    ? "UNVERIFIED" : times.some((time) => now - Date.parse(time!) > maxAge * 1000 || Date.parse(time!) - now > 10_000)
      ? "STALE" : "FRESH";
  const minimum = count(value.policy.minimum_weight_samples);
  return { ...value, telemetry: {
    weight_samples: count(sample?.binance_weight_samples), minimum_weight_samples: minimum && minimum > 0 ? minimum : null,
    observed_at: observedAt, weight_observed_at: weightObservedAt, heartbeat_at: heartbeatAt, timing,
    decision_matches_sample: observedAt !== null && timestamp(value.decision_observed_at) !== null
      && Date.parse(observedAt) === Date.parse(value.decision_observed_at!),
  } };
}

export function admissionTelemetryExplanation(value?: AdmissionExplanation | null): string | null {
  if (!value?.telemetry) return null;
  const telemetry = value.telemetry;
  const count = `${telemetry.weight_samples ?? "—"}/${telemetry.minimum_weight_samples ?? "—"}`;
  const window = telemetry.weight_samples !== null && telemetry.minimum_weight_samples !== null
    ? telemetry.weight_samples < telemetry.minimum_weight_samples ? "janela em formação" : "mínimo de amostras atingido"
    : "validando janela";
  if (telemetry.timing === "STALE") return `Amostras Binance ${count} · telemetria fora da validade; aguardando coleta server-side.`;
  if (telemetry.timing === "UNVERIFIED") return `Amostras Binance ${count} · datas da telemetria não confirmadas.`;
  return `Amostras Binance ${count} · ${window}; ${telemetry.decision_matches_sample
    ? "mesma amostra da decisão server-side" : "snapshot distinto da decisão; aguardando confirmação server-side"}.`;
}
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
  if (value.reason === "CAPACITY_TELEMETRY_MISSING_OR_STALE" && value.telemetry) {
    const telemetry = value.telemetry;
    if (telemetry.timing === "STALE") return "NÃO — telemetria fora da validade na amostra consultada";
    if (telemetry.timing === "FRESH" && telemetry.decision_matches_sample
      && telemetry.weight_samples !== null && telemetry.minimum_weight_samples !== null
      && telemetry.weight_samples < telemetry.minimum_weight_samples)
      return `NÃO — validação da telemetria/janela pendente; ${telemetry.weight_samples}/${telemetry.minimum_weight_samples} amostras reais`;
  }
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
