import "server-only";
import type { createServiceRoleClient } from "@/lib/supabase/service-role";

type Service = ReturnType<typeof createServiceRoleClient>;
type IdentityConfig = { accountId: string; operatorId: string; shardId: "executor-01";
  environment: "REAL"; identityHash: string };
type ScopeAccount = { id: string; operator_id: string; status: string; executor_shard_id: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const required = () => new Error("COINOPS_BINANCE_IDENTITY_BOOTSTRAP_REQUIRED");

function initialConfig(raw: string): IdentityConfig[] {
  if (Buffer.byteLength(raw) > 8192) throw new Error("COINOPS_BINANCE_IDENTITY_BOOTSTRAP_INVALID");
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("COINOPS_BINANCE_IDENTITY_BOOTSTRAP_INVALID"); }
  if (!Array.isArray(value) || value.length !== 4)
    throw new Error("COINOPS_BINANCE_IDENTITY_BOOTSTRAP_INVALID");
  const keys = ["accountId", "operatorId", "shardId", "environment", "identityHash"];
  const accounts = new Set<string>(), identities = new Set<string>();
  for (const row of value) {
    if (!row || typeof row !== "object" || Array.isArray(row)
      || Object.keys(row).length !== keys.length || Object.keys(row).some((key) => !keys.includes(key))
      || typeof row.accountId !== "string" || typeof row.operatorId !== "string"
      || !UUID.test(row.accountId) || !UUID.test(row.operatorId)
      || row.shardId !== "executor-01" || row.environment !== "REAL"
      || typeof row.identityHash !== "string" || !HASH.test(row.identityHash)
      || accounts.has(row.accountId) || identities.has(row.identityHash))
      throw new Error("COINOPS_BINANCE_IDENTITY_BOOTSTRAP_INVALID");
    accounts.add(row.accountId); identities.add(row.identityHash);
  }
  return value as IdentityConfig[];
}

/** Only admission/bootstrap reads this inventory. Historical real cycles retain
 * identity ownership even if an account/engine is currently paused or disabled.
 * Testnet/Shadow and never-traded PREPARING cycles do not count as LIVE history. */
async function operatedRealAccounts(service: Service, tenantId: string) {
  if (!UUID.test(tenantId ?? "")) throw required();
  const operators = await service.from("operators").select("id,status")
    .eq("tenant_id", tenantId);
  if (operators.error || !operators.data) throw required();
  const owners = new Map(operators.data.map((row) => [row.id as string, row.status as string]));
  if (!owners.size) return { accounts: [] as ScopeAccount[], owners };
  const ownerIds = [...owners.keys()];
  const accountIds = new Set<string>();
  // PostgREST's result cap must not silently truncate historical ownership.
  for (const source of ["engines", "runs"] as const) {
    for (let offset = 0; ; offset += 500) {
      if (offset >= 20000) throw required();
      const query = source === "engines"
        ? service.from("trading_engines").select("exchange_account_id")
          .in("operator_id", ownerIds).eq("environment", "REAL")
          .in("status", ["ACTIVE", "PAUSED", "BLOCKED"])
        : service.from("robot_v1_live_runs").select("exchange_account_id")
          .in("operator_id", ownerIds).neq("status", "PREPARING");
      const result = await query.order("id").range(offset, offset + 499);
      if (result.error || !result.data) throw required();
      for (const row of result.data) {
        if (!UUID.test(row.exchange_account_id ?? "")) throw required();
        accountIds.add(row.exchange_account_id);
      }
      if (result.data.length < 500) break;
    }
  }
  const accounts: ScopeAccount[] = [];
  const ids = [...accountIds];
  for (let start = 0; start < ids.length; start += 100) {
    const batch = ids.slice(start, start + 100);
    const rows = await service.from("exchange_accounts")
      .select("id,operator_id,status,executor_shard_id").in("id", batch).in("operator_id", ownerIds);
    if (rows.error || rows.data?.length !== batch.length) throw required();
    accounts.push(...rows.data as ScopeAccount[]);
  }
  return { accounts, owners };
}

/** New admission only. A missing bootstrap can NEVER affect an existing job. */
export async function requireLiveIdentityCoverage(service: Service, tenantId: string) {
  const { accounts } = await operatedRealAccounts(service, tenantId);
  for (let start = 0; start < accounts.length; start += 100) {
    const batch = accounts.slice(start, start + 100);
    const bindings = await service.from("binance_account_identity_bindings")
      .select("exchange_account_id,operator_id,identity_hash").eq("environment", "REAL")
      .in("exchange_account_id", batch.map((row) => row.id));
    if (bindings.error || !bindings.data || batch.some((account) => !bindings.data.some((row) =>
      row.exchange_account_id === account.id && row.operator_id === account.operator_id && HASH.test(row.identity_hash))))
      throw required();
  }
}

/** Initial verified hashes are deployment configuration, never client input.
 * No credential, account status, registry, engine or order is modified. Remove
 * the temporary env only after coverage succeeds. Repeated collection is safe. */
export async function bootstrapInitialIdentityBindings(service: Service, tenantId: string,
  raw: string | undefined = process.env.COINOPS_INITIAL_IDENTITY_BINDINGS_JSON) {
  if (!raw) return { status: "NOT_CONFIGURED" as const, boundCount: 0, createdCount: 0 };
  const config = initialConfig(raw);
  const { accounts, owners } = await operatedRealAccounts(service, tenantId);
  const source = accounts.filter((row) => row.executor_shard_id === "executor-01" && row.status === "ACTIVE");
  // Check the complete manifest before the first claim. No partial validation,
  // browser hashes, foreign tenant, inactive account or second shard accepted.
  if (source.length !== 4 || config.some((row) => owners.get(row.operatorId) !== "ACTIVE"
    || !source.some((account) => account.id === row.accountId && account.operator_id === row.operatorId)))
    throw new Error("COINOPS_BINANCE_IDENTITY_BOOTSTRAP_SCOPE_DENIED");
  const existing = await service.from("binance_account_identity_bindings")
    .select("exchange_account_id,operator_id,identity_hash").eq("environment", "REAL")
    .in("exchange_account_id", config.map((row) => row.accountId));
  if (existing.error || !existing.data) throw required();
  const present = new Map(existing.data.map((row) => [row.exchange_account_id as string, row]));
  if (config.some((row) => { const found = present.get(row.accountId);
    return found && (found.operator_id !== row.operatorId || found.identity_hash !== row.identityHash); }))
    throw new Error("COINOPS_BINANCE_IDENTITY_BOOTSTRAP_CONFLICT");
  let createdCount = 0;
  for (const row of config) {
    if (present.has(row.accountId)) continue;
    const claim = await service.rpc("claim_binance_account_identity", { p_operator_id: row.operatorId,
      p_account_id: row.accountId, p_environment: "REAL", p_identity_hash: row.identityHash });
    if (claim.error || claim.data !== "BOUND") throw required();
    createdCount++;
  }
  await requireLiveIdentityCoverage(service, tenantId);
  return { status: "COMPLETE" as const, boundCount: 4, createdCount };
}
