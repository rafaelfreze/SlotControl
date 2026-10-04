import type { createServiceRoleClient } from "../supabase/service-role";
import { completeLedgerRead } from "./complete-ledger-read.ts";
import { resolveExecutorForConnection, parseExecutorValidatedVersions } from "./executor-shards-server.ts";
import { operatorConnectionAdmin } from "./operator-executor-admin.ts";
import { accountConnectionProof } from "./account-connection-proof.ts";
import { claimAccountIdentity } from "./binance-identity-server";
import { advanceAccountExecutionPolicy, ENGINE_ISOLATION_CONTRACT, type ExecutionPolicyRecord } from "./account-execution-policy.ts";
type Service = ReturnType<typeof createServiceRoleClient>;
const denied = "COINOPS_ENGINE_ISOLATION_PREFLIGHT_REQUIRED";

/** Called only from an ADMIN-confirmed append; all Binance requests are GET.
 * Never rotates/copies a key, modifies an old engine or pauses its recovery. */
export async function ensureAccountExecutionPolicy(service: Service, operatorId: string,
  accountId: string, destination: string, requestId: string) {
  const engines = await completeLedgerRead<{ id: string; executor_shard_id: string }>(async (start, end) => service.from("trading_engines")
    .select("id,executor_shard_id").eq("operator_id", operatorId).eq("exchange_account_id", accountId)
    .eq("environment", "REAL").order("id").range(start, end), denied);
  const ids = [...new Set([...engines.map((engine) => engine.executor_shard_id), destination])].sort();
  const targets = new Map<string, Awaited<ReturnType<typeof resolveExecutorForConnection>>>();
  return advanceAccountExecutionPolicy(ids, {
    inspect: async (id) => {
      const target = await resolveExecutorForConnection(operatorId, accountId, id);
      const response = await fetch(`${target.base}/health`, { cache: "no-store", signal: AbortSignal.timeout(5000) });
      const health = await response.json();
      const observedAt = Date.parse(health.clock), now = Date.now();
      const version = health.actual_executor_version ?? health.version;
      if (!response.ok || health.executor_shard_id !== id || health.healthy !== true
        || health.environment !== "BINANCE_PRODUCTION_PREPARED" || health.binance_connectivity !== "OK"
        || health.egress_ipv4 !== target.ip || health.egress_ipv4_verified !== true
        || typeof health.clock_drift_ms !== "number" || Math.abs(health.clock_drift_ms) > 2000
        || !Number.isFinite(observedAt) || observedAt > now + 2000 || now - observedAt > 30_000
        || !parseExecutorValidatedVersions(target.validatedVersion)?.includes(version)) throw new Error(denied);
      const validation = await operatorConnectionAdmin<Record<string, unknown>>(operatorId, accountId, id,
        "/v1/admin/credentials", { operation: "REVALIDATE" }, "CREDENTIAL");
      const evidence = accountConnectionProof(validation, target, operatorId, accountId);
      await claimAccountIdentity(service, operatorId, accountId, "REAL", validation.uidHash);
      const saved = await service.from("account_executor_connections").update({ status: "VALIDATED",
        checked_at: evidence.validated_at, validation_evidence: evidence }).eq("operator_id", operatorId)
        .eq("exchange_account_id", accountId).eq("executor_shard_id", id).eq("environment", "REAL")
        .select("exchange_account_id").single();
      if (saved.error || !saved.data) throw new Error(denied);
      targets.set(id, target);
      return { shardId: id, ip: target.ip, version, observedAt: Math.min(observedAt, Date.parse(String(evidence.validated_at))),
        healthy: true, credentialValidated: true, protocol: health.account_order_budget_protocol,
        contract: health.isolation_contract };
    },
    stage: async (version, required) => {
      const prior = await service.from("account_execution_policies").select("request_id,status,executor_version,required_shards")
        .eq("operator_id", operatorId).eq("exchange_account_id", accountId).maybeSingle();
      if (prior.error) throw new Error(denied);
      // Resume the original partial policy, even after a refreshed plan's UUID.
      const same = prior.data?.executor_version === version
        && JSON.stringify([...prior.data.required_shards].sort()) === JSON.stringify(required);
      if (prior.data?.status === "PREPARING" && !same) throw new Error("COINOPS_ENGINE_ISOLATION_PREPARING");
      const result = await service.rpc("stage_account_execution_policy", { p_operator_id: operatorId,
        p_account_id: accountId, p_destination: destination, p_executor_version: version,
        p_request_id: same ? prior.data!.request_id : requestId });
      if (result.error || !result.data) throw new Error("COINOPS_ENGINE_ISOLATION_STAGE_FAILED");
      return result.data as ExecutionPolicyRecord;
    },
    enable: async (proof) => {
      const result = await operatorConnectionAdmin<Record<string, unknown>>(operatorId, accountId, proof.shardId,
        "/v1/admin/account-policy", { contract: ENGINE_ISOLATION_CONTRACT, executor_version: proof.version }, "ACCOUNT_POLICY");
      if (result.operator_id !== operatorId || result.exchange_account_id !== accountId || result.environment !== "REAL")
        throw new Error("COINOPS_ENGINE_ISOLATION_PROOF_DENIED");
      return { shardId: String(result.executor_shard_id), ip: String(result.executor_ip), version: String(result.executor_version),
        contract: String(result.contract), enabled: result.enabled === true };
    },
    record: async (proof, policy) => {
      if (targets.get(proof.shardId)?.ip !== proof.ip) throw new Error(denied);
      const result = await service.rpc("record_account_execution_policy", { p_operator_id: operatorId,
        p_account_id: accountId, p_request_id: policy.request_id, p_shard_id: proof.shardId,
        p_executor_version: proof.version, p_ip: proof.ip, p_enabled: true });
      if (result.error || !result.data) throw new Error("COINOPS_ENGINE_ISOLATION_RECORD_FAILED");
      return result.data as ExecutionPolicyRecord;
    },
  });
}
