import { isIP } from "node:net";

export type ExecutorShardConfig = {
  shardId: string; ip: string; base: string; secret: string; validatedVersion?: string;
};
export type ExecutorAccountResolver = (operatorId: string, accountId: string) => Promise<ExecutorShardConfig>;
type Environment = Record<string, string | undefined>;
const SHARD = /^executor-[0-9]{2,}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Server configuration only. A missing shard never falls back to a different IP. */
export function resolveExecutorShard(shardId: string, env: Environment = process.env): ExecutorShardConfig {
  if (!SHARD.test(shardId)) throw new Error("EXECUTOR_SHARD_INVALID");
  let configured: unknown;
  let mapping: Record<string, unknown> = {};
  // The established route remains independent even of a malformed new-shard
  // configuration. Never let an Executor02 rollout replace Executor01's IP/key.
  if (shardId === "executor-01") configured = {
    egressIp: env.LIVE_EXECUTOR_EGRESS_IP, baseUrl: env.LIVE_EXECUTOR_BASE_URL,
    hmacSecret: env.COINOPS_EXECUTOR_HMAC_SECRET, validatedVersion: env.LIVE_EXECUTOR_VALIDATED_VERSION,
  };
  else if (env.COINOPS_EXECUTOR_SHARDS_JSON) {
    let decoded: unknown;
    try { decoded = JSON.parse(env.COINOPS_EXECUTOR_SHARDS_JSON); }
    catch { throw new Error("EXECUTOR_SHARD_CONFIG_INVALID"); }
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded))
      throw new Error("EXECUTOR_SHARD_CONFIG_INVALID");
    mapping = decoded as Record<string, unknown>;
    configured = Object.hasOwn(mapping, shardId) ? mapping[shardId] : undefined;
  }
  if (!configured || typeof configured !== "object" || Array.isArray(configured))
    throw new Error("EXECUTOR_SHARD_NOT_CONFIGURED");
  const row = configured as Record<string, unknown>;
  if (typeof row.egressIp !== "string" || isIP(row.egressIp) !== 4
    || row.baseUrl !== `https://${row.egressIp}` || typeof row.hmacSecret !== "string"
    || Buffer.byteLength(row.hmacSecret) < 32
    || row.validatedVersion !== undefined && (typeof row.validatedVersion !== "string"
      || !/^[a-zA-Z0-9._-]{1,100}$/.test(row.validatedVersion)))
    throw new Error("EXECUTOR_SHARD_CONFIG_INVALID");
  // Reject a new shard aliasing an existing IP or HMAC domain, while never
  // breaking the established01 route because another shard is misconfigured.
  if (shardId !== "executor-01") {
    const other = Object.entries(mapping).filter(([id]) => id !== shardId).map(([, value]) => value)
      .concat([{ egressIp: env.LIVE_EXECUTOR_EGRESS_IP, hmacSecret: env.COINOPS_EXECUTOR_HMAC_SECRET }]);
    if (other.some((value) => value && typeof value === "object"
      && ((value as Record<string, unknown>).egressIp === row.egressIp
        || (value as Record<string, unknown>).hmacSecret === row.hmacSecret)))
      throw new Error("EXECUTOR_SHARD_CONFIG_COLLISION");
  }
  return { shardId, ip: row.egressIp, base: row.baseUrl, secret: row.hmacSecret,
    validatedVersion: row.validatedVersion as string | undefined };
}

type BoundAccount = { id: string; operator_id: string; executor_shard_id: string };
type BoundOperator = { id: string; tenant_id: string; status: string };
export function assertExecutorAccountBinding(operator: BoundOperator | null, account: BoundAccount | null,
  operatorId: string, accountId: string, tenantId: string) {
  if (!operator || operator.id !== operatorId || operator.tenant_id !== tenantId || operator.status !== "ACTIVE"
    || !account || account.id !== accountId || account.operator_id !== operatorId
    || !SHARD.test(account.executor_shard_id)) throw new Error("EXECUTOR_ACCOUNT_SHARD_DENIED");
  return account.executor_shard_id;
}

// ACTIVE bindings are immutable. Staged never-traded accounts may be explicitly
// reassigned: collapse their in-flight read only, never reuse its resolved value.
const bindings = new Map<string, { expires: number; value: Promise<{ shardId: string; ip: string; cacheable: boolean }> }>();
export async function resolveExecutorForAccount(operatorId: string, accountId: string): Promise<ExecutorShardConfig> {
  if (!UUID.test(operatorId ?? "") || !UUID.test(accountId ?? ""))
    throw new Error("EXECUTOR_ACCOUNT_SHARD_DENIED");
  const { getCoinOpsServiceTenantId, getSupabaseDataSchema } = await import("../supabase/env");
  const tenantId = getCoinOpsServiceTenantId();
  if (getSupabaseDataSchema() !== "coinops" || !tenantId) throw new Error("EXECUTOR_ACCOUNT_SHARD_DENIED");
  const cacheKey = `${tenantId}:${operatorId}:${accountId}`;
  let binding = bindings.get(cacheKey);
  if (!binding || binding.expires <= Date.now()) {
    const value = (async () => {
      const { createServiceRoleClient } = await import("../supabase/service-role");
      const service = createServiceRoleClient();
      const [operator, account] = await Promise.all([
        service.from("operators").select("id,tenant_id,status").eq("id", operatorId).eq("tenant_id", tenantId).single(),
        service.from("exchange_accounts").select("id,operator_id,executor_shard_id,status")
          .eq("id", accountId).eq("operator_id", operatorId).single(),
      ]);
      if (operator.error || account.error) throw new Error("EXECUTOR_ACCOUNT_SHARD_DENIED");
      const shardId = assertExecutorAccountBinding(operator.data, account.data, operatorId, accountId, tenantId);
      const shard = await service.from("executor_shards").select("id,egress_ipv4").eq("id", shardId).single();
      const ip = String(shard.data?.egress_ipv4 ?? "").replace(/\/32$/, "");
      if (shard.error || shard.data?.id !== shardId || isIP(ip) !== 4)
        throw new Error("EXECUTOR_ACCOUNT_SHARD_DENIED");
      return { shardId, ip, cacheable: account.data.status === "ACTIVE" };
    })();
    binding = { expires: Date.now() + 30_000, value };
    if (bindings.size >= 2048) bindings.clear();
    bindings.set(cacheKey, binding);
    value.catch(() => { if (bindings.get(cacheKey)?.value === value) bindings.delete(cacheKey); });
  }
  const bound = await binding.value;
  if (!bound.cacheable && bindings.get(cacheKey)?.value === binding.value) bindings.delete(cacheKey);
  const config = resolveExecutorShard(bound.shardId);
  if (config.ip !== bound.ip) throw new Error("EXECUTOR_SHARD_IP_MISMATCH");
  return config;
}

/** Executor01's durable request bytes stay unchanged across this rollout. */
export function withExecutorShard<T extends Record<string, unknown>>(payload: T, config: ExecutorShardConfig): T & { executor_shard_id?: string } {
  if (payload.executor_shard_id !== undefined && payload.executor_shard_id !== config.shardId)
    throw new Error("EXECUTOR_SHARD_SCOPE_MISMATCH");
  return config.shardId === "executor-01" ? payload : { ...payload, executor_shard_id: config.shardId };
}
