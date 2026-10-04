/** Pure presentation of canonical server-side decisions. No frontend formula,
 * account-primary preference, fabricated capacity or executor fallback. */
export type EngineAdmissionOption = { shardId: string; ip: string; capacityCode: string;
  projectedPercent: number | null; credential: "VALIDATED" | "VALIDATION_REQUIRED" };

export function rankEngineAdmissionOptions(options: readonly EngineAdmissionOption[]) {
  const eligible = (option: EngineAdmissionOption) => option.capacityCode === "CAPACITY_OK";
  return [...options].sort((a, b) => Number(eligible(b)) - Number(eligible(a))
    || (eligible(a) && eligible(b) ? Number(b.credential === "VALIDATED") - Number(a.credential === "VALIDATED") : 0)
    || (a.projectedPercent ?? Infinity) - (b.projectedPercent ?? Infinity)
    || a.shardId.localeCompare(b.shardId));
}
