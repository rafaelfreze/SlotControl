/** Immutable physical topology, independent of strategy spacing or account/shard.
 * 100 is the software validation ceiling for this release, NOT evidence of
 * executor certification. Admission must independently approve the workload. */
export const DEFAULT_ENGINE_SLOT_COUNT = 25;
export const MIN_ENGINE_SLOT_COUNT = 2;
export const MAX_ENGINE_SLOT_COUNT = 100;

export function validateEngineSlotCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)
    || value < MIN_ENGINE_SLOT_COUNT || value > MAX_ENGINE_SLOT_COUNT)
    throw new Error("COINOPS_ENGINE_SLOT_COUNT_INVALID");
  return value;
}

/** Never infer the configured count from a possibly partial ledger response.
 * Missing legacy metadata means 25 only; conflicting snapshots fail closed. */
export function configuredEngineSlotCount(engine: { slot_count?: unknown; config?: unknown }): number {
  const config = engine.config && typeof engine.config === "object" && !Array.isArray(engine.config)
    ? engine.config as Record<string, unknown> : null;
  const column = engine.slot_count === undefined ? undefined : validateEngineSlotCount(engine.slot_count);
  const snapshot = config?.slot_count === undefined ? undefined : validateEngineSlotCount(config.slot_count);
  if (column !== undefined && snapshot !== undefined && column !== snapshot)
    throw new Error("COINOPS_ENGINE_SLOT_COUNT_MISMATCH");
  return column ?? snapshot ?? DEFAULT_ENGINE_SLOT_COUNT;
}

export function hasCompletePhysicalSlotSet(numbers: readonly number[], count: number): boolean {
  validateEngineSlotCount(count);
  return numbers.length === count && new Set(numbers).size === count
    && numbers.every(value => Number.isSafeInteger(value) && value >= 1 && value <= count);
}
