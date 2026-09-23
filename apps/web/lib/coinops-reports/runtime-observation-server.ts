import "server-only";

import { getCoinOpsServiceTenantId, getSupabaseDataSchema, getSupabaseEnv } from "@/lib/supabase/env";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { buildRuntimeObservation, type RuntimeObservation } from "./runtime-observation-contract";

/** Metadata only. Logging failure must never retry or change a financial action. */
export async function recordRuntimeObservation(input: RuntimeObservation): Promise<boolean> {
  try {
    if (getSupabaseDataSchema() !== "coinops" || new URL(getSupabaseEnv().supabaseUrl).hostname !== "otdfpmsegjxpqrzisfmi.supabase.co"
      || input.scope.tenantId !== getCoinOpsServiceTenantId()) throw new Error("COINOPS_OBSERVATION_SCOPE_INVALID");
    const payload = buildRuntimeObservation({ ...input, appCommitSha: process.env.VERCEL_GIT_COMMIT_SHA });
    const { error } = await createServiceRoleClient().from("report_runtime_observations")
      .upsert(payload, { onConflict: "product_id,tenant_id,user_id,event_key", ignoreDuplicates: true });
    if (error) throw new Error("COINOPS_OBSERVATION_PERSIST_FAILED");
    return true;
  } catch {
    console.error("COINOPS_OBSERVATION_PERSIST_FAILED");
    return false;
  }
}
