import "server-only";

import { getCoinOpsServiceTenantId, getSupabaseDataSchema, getSupabaseEnv } from "@/lib/supabase/env";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { buildRuntimeObservation, type RuntimeObservation } from "./runtime-observation-contract";
import { loadOperatorRegistry, resolveOperatorEngine } from "@/lib/execution/operator-context-server";

/** Metadata only. Logging failure must never retry or change a financial action. */
export async function recordRuntimeObservation(input: RuntimeObservation): Promise<boolean> {
  try {
    if (getSupabaseDataSchema() !== "coinops" || new URL(getSupabaseEnv().supabaseUrl).hostname !== "otdfpmsegjxpqrzisfmi.supabase.co"
      || input.scope.tenantId !== getCoinOpsServiceTenantId()) throw new Error("COINOPS_OBSERVATION_SCOPE_INVALID");
    const service = createServiceRoleClient();
    const scope = { product_id: input.scope.productId, tenant_id: input.scope.tenantId, user_id: input.scope.userId };
    if (input.asset) {
      const engine = await resolveOperatorEngine(service, scope, { environment: input.environment, asset: input.asset,
        operator_id: input.operatorId, exchange_account_id: input.exchangeAccountId, trading_engine_id: input.tradingEngineId });
      input = { ...input, operatorId: engine.operator_id, exchangeAccountId: engine.exchange_account_id,
        tradingEngineId: engine.trading_engine_id, quoteAsset: engine.quote_asset };
    } else {
      const registry = await loadOperatorRegistry(service, scope);
      const accounts = registry.accounts.filter((account) => input.exchangeAccountId
        ? account.id === input.exchangeAccountId : account.is_legacy_default);
      if (accounts.length !== 1 || input.operatorId && input.operatorId !== registry.operator.id)
        throw new Error("COINOPS_OBSERVATION_ACCOUNT_DENIED");
      input = { ...input, operatorId: registry.operator.id, exchangeAccountId: accounts[0]!.id };
    }
    const payload = buildRuntimeObservation({ ...input, appCommitSha: process.env.VERCEL_GIT_COMMIT_SHA });
    const { error } = await service.from("report_runtime_observations")
      .upsert(payload, { onConflict: "product_id,tenant_id,user_id,event_key", ignoreDuplicates: true });
    if (error) throw new Error("COINOPS_OBSERVATION_PERSIST_FAILED");
    return true;
  } catch {
    console.error("COINOPS_OBSERVATION_PERSIST_FAILED");
    return false;
  }
}
