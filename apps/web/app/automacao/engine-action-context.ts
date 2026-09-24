import "server-only";

import { isIdentity, type EngineEnvironment, type OperatorScope } from "@/lib/execution/operator-context";
import { resolveOperatorEngine } from "@/lib/execution/operator-context-server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { createClient } from "@/lib/supabase/server";
import { getCoinOpsServiceTenantId } from "@/lib/supabase/env";

export type ActionEngineIds = { exchange_account_id: string; trading_engine_id: string };

export async function actionEngine(input: ActionEngineIds | FormData, environment: EngineEnvironment,
  asset?: string, scope?: OperatorScope) {
  const account = input instanceof FormData ? input.get("exchange_account_id") : input.exchange_account_id;
  const engine = input instanceof FormData ? input.get("trading_engine_id") : input.trading_engine_id;
  if (!isIdentity(account) || !isIdentity(engine)) throw new Error("COINOPS_ENGINE_EXPLICIT_SELECTION_REQUIRED");
  if (!scope) {
    const client = createClient();
    const { data: { user } } = await client.auth.getUser();
    const tenantId = getCoinOpsServiceTenantId();
    if (!user || !tenantId) throw new Error("COINOPS_ENGINE_AUTH_REQUIRED");
    const strategy = await client.from("strategies").select("product_id")
      .eq("tenant_id", tenantId).eq("user_id", user.id).limit(1).maybeSingle();
    if (strategy.error || !strategy.data) throw new Error("COINOPS_ENGINE_SCOPE_DENIED");
    scope = { product_id: strategy.data.product_id, tenant_id: tenantId, user_id: user.id };
  }
  return resolveOperatorEngine(createServiceRoleClient(), scope, { environment, asset,
    exchange_account_id: account, trading_engine_id: engine });
}

/** Legacy executors are not a fallback for an unprovisioned account/market. */
export function requireLegacyRuntime(context: Awaited<ReturnType<typeof actionEngine>>) {
  if (!context.legacy_compatible || !context.is_legacy_default)
    throw new Error("COINOPS_ENGINE_RUNTIME_NOT_PROVISIONED");
}
