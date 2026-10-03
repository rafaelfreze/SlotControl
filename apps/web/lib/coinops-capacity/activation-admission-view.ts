// Read model only: the persisted canonical RPC owns the decision and its clock.
export type ActivationAdmission = {
  code: "CAPACITY_OK" | "CAPACITY_REQUIRED" | "CAPACITY_UNKNOWN";
  reason: string | null;
  healthySeconds: number | null;
  requiredHealthySeconds: number | null;
  observedAt: string | null;
};

export function activationAdmissionFromEvidence(value: unknown): ActivationAdmission {
  const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const policy = row.policy && typeof row.policy === "object" ? row.policy as Record<string, unknown> : {};
  const numeric = (input: unknown) => typeof input === "number" && Number.isFinite(input) && input >= 0 ? input : null;
  return {
    code: row.code === "CAPACITY_OK" || row.code === "CAPACITY_REQUIRED" ? row.code : "CAPACITY_UNKNOWN",
    reason: typeof row.reason === "string" ? row.reason : null,
    healthySeconds: numeric(row.healthy_seconds),
    requiredHealthySeconds: numeric(policy.reopen_healthy_seconds),
    observedAt: typeof row.decision_observed_at === "string" ? row.decision_observed_at : null,
  };
}

export function activationAdmissionView(admission: ActivationAdmission | null | undefined) {
  if (admission?.code === "CAPACITY_OK") return { allowed: true, message: "Admissão disponível. A ativação revalida todos os gates antes de enviar ordens." };
  if (admission?.reason === "RECOVERY_STABILIZING") {
    const remaining = admission.healthySeconds !== null && admission.requiredHealthySeconds !== null
      ? Math.max(0, Math.ceil(admission.requiredHealthySeconds - admission.healthySeconds)) : null;
    return { allowed: false, message: `Preparado, aguardando estabilidade do executor${remaining === null ? "" : ` · faltavam ${remaining}s na última amostra`}. Não é falta de saldo. Atualize o estado para conferir a liberação server-side.` };
  }
  return { allowed: false, message: admission?.code === "CAPACITY_REQUIRED"
    ? "Preparado, mas a admissão está bloqueada pela política de segurança do executor. Atualize o estado para conferir o gate; não repita a ativação."
    : "Preparado, aguardando evidência de capacidade do executor. Atualize o estado; a ativação permanece protegida." };
}
