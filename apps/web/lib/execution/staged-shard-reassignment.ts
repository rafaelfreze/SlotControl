type ReassignmentResult = { code: string; shardId: string; replayed?: boolean;
  executorIp?: string; credentialRequired?: boolean };
type Dependencies = { check: (preview: boolean, originRetired: boolean) => Promise<ReassignmentResult>;
  retire: () => Promise<void> };

/** No exchange operation. A successful replay must NEVER touch the previous shard. */
export async function reassignStagedAccount(dependencies: Dependencies) {
  const preview = await dependencies.check(true, false);
  if (preview.code === "REASSIGNED" && preview.replayed === true) return preview;
  if (preview.code !== "READY_TO_REASSIGN") throw new Error("COINOPS_STAGED_REASSIGNMENT_DENIED");
  await dependencies.retire();
  // DB validates capacity and never-traded state again under locks. Failure
  // leaves the source inactive with no runnable registry; retry is safe.
  const result = await dependencies.check(false, true);
  if (result.code !== "REASSIGNED") throw new Error("COINOPS_STAGED_REASSIGNMENT_DENIED");
  return result;
}

export function assertRetiredRegistry(result: Record<string, unknown>, operatorId: string,
  accountId: string, shardId: string) {
  if (result.operator_id !== operatorId || result.exchange_account_id !== accountId
    || result.environment !== "REAL" || result.trading_enabled !== false
    || result.status !== "INACTIVE" || result.registered_engines !== 0
    || shardId !== "executor-01" && result.executor_shard_id !== shardId
    || result.executor_shard_id !== undefined && result.executor_shard_id !== shardId)
    throw new Error("COINOPS_SOURCE_REGISTRY_RETIREMENT_FAILED");
}
