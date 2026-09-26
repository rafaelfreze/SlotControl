import "server-only";
import type { createServiceRoleClient } from "@/lib/supabase/service-role";

type Service = ReturnType<typeof createServiceRoleClient>;
type Environment = "REAL" | "TESTNET";

/** Hash input is exclusively an authenticated executor observation, never client JSON. */
export async function claimAccountIdentity(service: Service, operatorId: string, accountId: string,
  environment: Environment, identityHash: unknown) {
  if (typeof identityHash !== "string" || !/^[0-9a-f]{64}$/.test(identityHash))
    throw new Error("COINOPS_BINANCE_IDENTITY_REQUIRED");
  const result = await service.rpc("claim_binance_account_identity", { p_operator_id: operatorId,
    p_account_id: accountId, p_environment: environment, p_identity_hash: identityHash });
  if (result.error) throw new Error("COINOPS_BINANCE_IDENTITY_UNAVAILABLE");
  if (result.data !== "BOUND") throw new Error(["COINOPS_BINANCE_ACCOUNT_ALREADY_BOUND",
    "COINOPS_BINANCE_IDENTITY_CHANGED", "COINOPS_ADMIN_ACCOUNT_DENIED"].includes(result.data)
    ? result.data : "COINOPS_BINANCE_IDENTITY_REQUIRED");
}

/** Gate only new onboarding. Existing executor01 engines never depend on this
 * service to reconcile, recover, resume or keep operating. */
export async function requireAccountIdentityBinding(service: Service, operatorId: string,
  accountId: string, environment: Environment) {
  const account = await service.from("exchange_accounts")
    .select("operator_id,executor_shard_id,onboarding_environment").eq("id", accountId).single();
  if (account.error || !account.data || account.data.operator_id !== operatorId)
    throw new Error("COINOPS_ADMIN_ACCOUNT_DENIED");
  // Age, shard01 or a null onboarding marker is not an exemption: a newly
  // staged engine may belong to an older account. Existing ACTIVE runs bypass
  // admission at their callers; reconciliation/resume never invoke this gate.
  const identity = await service.from("binance_account_identity_bindings")
    .select("exchange_account_id").eq("exchange_account_id", accountId)
    .eq("operator_id", operatorId).eq("environment", environment).maybeSingle();
  if (identity.error || !identity.data) throw new Error("COINOPS_BINANCE_IDENTITY_REQUIRED");
  const [shard, credential] = await Promise.all([
    service.from("executor_shards").select("id,egress_ipv4")
      .eq("id", account.data.executor_shard_id).single(),
    service.from("account_onboarding_checks").select("status,evidence")
      .eq("operator_id", operatorId).eq("exchange_account_id", accountId)
      .eq("check_key", "BINANCE_CREDENTIAL").order("checked_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  const evidence = credential.data?.evidence;
  const expectedIp = String(shard.data?.egress_ipv4 ?? "").replace(/\/32$/, "");
  if (shard.error || credential.error || shard.data?.id !== account.data.executor_shard_id
    || !expectedIp || credential.data?.status !== "PASS" || evidence?.status !== "PASS"
    || evidence?.environment !== environment || evidence?.executor_ip !== expectedIp
    || evidence?.executor_shard_id !== account.data.executor_shard_id)
    throw new Error("COINOPS_BINANCE_CREDENTIAL_SHARD_VALIDATION_REQUIRED");
}
