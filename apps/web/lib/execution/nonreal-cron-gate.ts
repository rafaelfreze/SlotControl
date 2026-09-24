import "server-only";

import { getCoinOpsServiceTenantId, getSupabaseDataSchema } from "../supabase/env";
import { createServiceRoleClient } from "../supabase/service-role";

/** A paused environment must not poll exchanges or advance virtual cycles. */
export async function hasActiveNonRealEngine(environment: "SHADOW" | "TESTNET") {
  if (getSupabaseDataSchema() !== "coinops") throw new Error("COINOPS_CRON_SCHEMA_SCOPE_INVALID");
  const service = createServiceRoleClient();
  const { data: operators, error: operatorError } = await service.from("operators")
    .select("id").eq("tenant_id", getCoinOpsServiceTenantId()).eq("status", "ACTIVE");
  if (operatorError) throw new Error("COINOPS_CRON_OPERATOR_DISCOVERY_FAILED");
  if (!operators?.length) return false;
  const { data, error } = await service.from("trading_engines").select("id")
    .eq("environment", environment).eq("status", "ACTIVE")
    .in("operator_id", operators.map((operator) => operator.id)).limit(1);
  if (error) throw new Error("COINOPS_CRON_ENGINE_DISCOVERY_FAILED");
  return Boolean(data?.length);
}
