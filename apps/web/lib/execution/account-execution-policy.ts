export const ENGINE_ISOLATION_CONTRACT = "ENGINE_ISOLATION_V2";
export type PolicyShardProof = { shardId: string; ip: string; version: string; observedAt: number;
  healthy: boolean; credentialValidated: boolean; protocol: number; contract: string };
export type ExecutionPolicyRecord = { request_id: string; executor_version: string;
  required_shards: string[]; status: "PREPARING" | "ACTIVE" };
export type PolicyDependencies = {
  inspect: (shardId: string) => Promise<PolicyShardProof>;
  stage: (version: string, shards: string[]) => Promise<ExecutionPolicyRecord>;
  enable: (shard: PolicyShardProof, requestId: string) => Promise<{ shardId: string; ip: string;
    version: string; contract: string; enabled: boolean }>;
  record: (shard: PolicyShardProof, policy: ExecutionPolicyRecord) => Promise<ExecutionPolicyRecord>;
  now?: () => number;
};
function assertProof(proof: PolicyShardProof, shardId: string, now: number) {
  if (proof.shardId !== shardId || !/^executor-[0-9]{2,4}$/.test(shardId)
    || !/^[a-f0-9]{40}$/.test(proof.version) || !proof.ip || !proof.healthy
    || !proof.credentialValidated || proof.contract !== ENGINE_ISOLATION_CONTRACT || proof.protocol !== 1
    || !Number.isFinite(proof.observedAt) || proof.observedAt > now + 2000 || now - proof.observedAt > 30_000)
    throw new Error("COINOPS_ENGINE_ISOLATION_PREFLIGHT_REQUIRED");
}
/** Only an explicit confirmed append may enable this monotonic account policy.
 * Preflight ALL hosts before staging. PREPARING requires permits before any
 * marker is enabled. A partial result resumes, never disables or moves engines.
 * Sequential configuration writes; a timeout leaves PREPARING and resumes
 * without pretending that an unrecorded marker succeeded. */
export async function advanceAccountExecutionPolicy(shardIds: readonly string[], dependencies: PolicyDependencies) {
  const now = dependencies.now ?? Date.now;
  const ids = [...new Set(shardIds)].sort();
  if (!ids.length || ids.length !== shardIds.length) throw new Error("COINOPS_ENGINE_ISOLATION_SCOPE_DENIED");
  const proofs = await Promise.all(ids.map(async (id) => {
    const proof = await dependencies.inspect(id); assertProof(proof, id, now()); return proof;
  }));
  const version = proofs[0].version;
  if (proofs.some((proof) => proof.version !== version)) throw new Error("COINOPS_ENGINE_ISOLATION_RUNTIME_PARITY_REQUIRED");
  const policy = await dependencies.stage(version, ids);
  if (policy.executor_version !== version || JSON.stringify([...policy.required_shards].sort()) !== JSON.stringify(ids)
    || !["PREPARING", "ACTIVE"].includes(policy.status) || !/^[0-9a-f-]{36}$/i.test(policy.request_id))
    throw new Error("COINOPS_ENGINE_ISOLATION_REPLAY_MISMATCH");
  // Freshness is rechecked after the stage commit, before each marker write.
  for (const proof of proofs) {
    assertProof(proof, proof.shardId, now());
    const installed = await dependencies.enable(proof, policy.request_id);
    if (installed.shardId !== proof.shardId || installed.ip !== proof.ip || installed.version !== version
      || installed.contract !== ENGINE_ISOLATION_CONTRACT || installed.enabled !== true)
      throw new Error("COINOPS_ENGINE_ISOLATION_PROOF_DENIED");
    const recorded = await dependencies.record(proof, policy);
    if (recorded.request_id !== policy.request_id || recorded.executor_version !== version
      || JSON.stringify([...recorded.required_shards].sort()) !== JSON.stringify(ids))
      throw new Error("COINOPS_ENGINE_ISOLATION_REPLAY_MISMATCH");
    policy.status = recorded.status;
  }
  if (policy.status !== "ACTIVE") throw new Error("COINOPS_ENGINE_ISOLATION_INCOMPLETE");
  return policy;
}
