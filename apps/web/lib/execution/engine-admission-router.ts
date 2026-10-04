import type { EngineAdmissionOption } from "./engine-admission-options.ts";
import { rankEngineAdmissionOptions } from "./engine-admission-options.ts";

export type EngineAdmissionShard = { id: string; ip: string };
export type EngineAdmissionDependencies = {
  preview: (shardId: string, count: number) => Promise<{ code: string; projected_percent?: unknown }>;
  validatedConnection: (shard: EngineAdmissionShard) => Promise<boolean>;
};

/** All registered eligible candidates, never just the account's bootstrap.
 * A failed shard is UNKNOWN for that shard and cannot poison a healthy sibling.
 * This is routing presentation, not a capacity formula or reservation. */
export async function discoverEngineAdmissionOptions(shards: readonly EngineAdmissionShard[], count: number,
  dependencies: EngineAdmissionDependencies): Promise<EngineAdmissionOption[]> {
  if (!Number.isSafeInteger(count) || count < 1 || count > 2147483647
    || new Set(shards.map((row) => row.id)).size !== shards.length
    || shards.some((row) => !/^executor-[0-9]{2,4}$/.test(row.id) || !row.ip))
    throw new Error("COINOPS_ENGINE_ADMISSION_SCOPE_DENIED");
  const options = await Promise.all(shards.map(async (shard) => {
    const [capacity, connection] = await Promise.allSettled([
      dependencies.preview(shard.id, count), dependencies.validatedConnection(shard),
    ]);
    const decision = capacity.status === "fulfilled" ? capacity.value : null;
    const capacityCode = ["CAPACITY_OK", "CAPACITY_REQUIRED", "CAPACITY_UNKNOWN"].includes(decision?.code ?? "")
      ? decision!.code : "CAPACITY_UNKNOWN";
    const pressure = decision?.projected_percent;
    return { shardId: shard.id, ip: shard.ip, capacityCode,
      projectedPercent: typeof pressure === "number" && Number.isFinite(pressure) && pressure >= 0 ? pressure : null,
      credential: connection.status === "fulfilled" && connection.value === true ? "VALIDATED" as const : "VALIDATION_REQUIRED" as const };
  }));
  return rankEngineAdmissionOptions(options);
}
