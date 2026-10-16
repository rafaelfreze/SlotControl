/** Pure presentation of canonical server-side decisions. No frontend formula,
 * account-primary preference, fabricated capacity or executor fallback. */
export type EngineAdmissionOption = { shardId: string; ip: string; capacityCode: string;
  capacityReason?: "SLOT_WORKLOAD_UNCERTIFIED" | null;
  projectedPercent: number | null; credential: "VALIDATED" | "VALIDATION_REQUIRED" };

/** Explicit allowlist; provider payloads and free-form reasons never enter the UI. */
export function knownEngineCapacityReason(value: unknown): EngineAdmissionOption["capacityReason"] {
  return value === "SLOT_WORKLOAD_UNCERTIFIED" ? value : null;
}

export function engineWorkloadCertificationNotice(options: readonly EngineAdmissionOption[], slotCount: number): string | null {
  if (!Number.isSafeInteger(slotCount) || slotCount === 25
    || !options.some((option) => option.capacityCode === "CAPACITY_UNKNOWN"
      && option.capacityReason === "SLOT_WORKLOAD_UNCERTIFIED")) return null;
  return `A carga de ${slotCount} slots ainda não está certificada. Isso não significa que o executor esteja lotado. O novo motor aguarda certificação específica de capacidade e proteção; os motores existentes continuam inalterados.`;
}

export function rankEngineAdmissionOptions(options: readonly EngineAdmissionOption[]) {
  const eligible = (option: EngineAdmissionOption) => option.capacityCode === "CAPACITY_OK";
  return [...options].sort((a, b) => Number(eligible(b)) - Number(eligible(a))
    || (eligible(a) && eligible(b) ? Number(b.credential === "VALIDATED") - Number(a.credential === "VALIDATED") : 0)
    || (a.projectedPercent ?? Infinity) - (b.projectedPercent ?? Infinity)
    || a.shardId.localeCompare(b.shardId));
}
