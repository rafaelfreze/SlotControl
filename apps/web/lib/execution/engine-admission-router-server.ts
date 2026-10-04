import type { createServiceRoleClient } from "../supabase/service-role";
import { completeLedgerRead } from "./complete-ledger-read.ts";
import { discoverEngineAdmissionOptions } from "./engine-admission-router.ts";
import { resolveExecutorForConnection } from "./executor-shards-server.ts";
type Service = ReturnType<typeof createServiceRoleClient>;
/** Persisted capacity/registry only. Never collect exchange data or reserve on
 * GET, advance hysteresis, prefer the bootstrap IP, or mutate any old engine. */
export async function loadEngineAdmissionOptions(service: Service, operatorId: string, accountId: string, count: number) {
  const account = await service.from("exchange_accounts").select("id,status,onboarding_environment")
    .eq("id", accountId).eq("operator_id", operatorId).single();
  if (account.error || !account.data || !["ACTIVE", "INACTIVE"].includes(account.data.status)
    || account.data.onboarding_environment && account.data.onboarding_environment !== "REAL")
    throw new Error("COINOPS_ENGINE_ACCOUNT_DENIED");
  const shards = await completeLedgerRead<{ id: string; egress_ipv4: string }>((start, end) => service.from("executor_shards")
    .select("id,egress_ipv4").eq("enabled", true).order("id").range(start, end), "COINOPS_CAPACITY_UNKNOWN");
  return discoverEngineAdmissionOptions(shards.map((shard) => ({ id: shard.id, ip: shard.egress_ipv4.replace(/\/32$/, "") })), count, {
    preview: async (id, engines) => {
      const result = await service.rpc("preview_executor_admission", { p_shard_id: id, p_environment: "REAL", p_engines: engines });
      if (result.error || !result.data) throw new Error("COINOPS_CAPACITY_UNKNOWN");
      const raw = result.data.projected_percent;
      return { code: result.data.code, projected_percent: typeof raw === "number" ? raw
        : typeof raw === "string" && raw.trim() ? Number(raw) : null };
    },
    validatedConnection: async (shard) => (await resolveExecutorForConnection(operatorId, accountId, shard.id)).ip === shard.ip,
  });
}
