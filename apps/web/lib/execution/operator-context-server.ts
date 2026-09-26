import "server-only";

import type { createServiceRoleClient } from "../supabase/service-role";
import { assertDomainRegistry, resolveEngineContext, visibleOperatorRegistry, type DomainRegistry, type EngineSelection,
  type OperatorScope } from "./operator-context";

type Client = ReturnType<typeof createServiceRoleClient>;

/** Accepts authenticated/RLS or service clients, but never discovers a user or
 * tenant from browser IDs. Callers supply their already authenticated scope. */
export async function loadOperatorRegistry(client: Client, scope: OperatorScope): Promise<DomainRegistry> {
  const op = await client.from("operators").select("id,product_id,tenant_id,user_id,status,kill_switch")
    .eq("product_id", scope.product_id).eq("tenant_id", scope.tenant_id).eq("user_id", scope.user_id).single();
  if (op.error || !op.data) throw new Error("COINOPS_OPERATOR_SCOPE_UNAVAILABLE");
  const [accounts, engines] = await Promise.all([
    client.from("exchange_accounts").select("id,operator_id,display_name,status,is_legacy_default,kill_switch")
      .eq("operator_id", op.data.id).order("id"),
    client.from("trading_engines").select("id,operator_id,exchange_account_id,environment,symbol,base_asset,quote_asset,status,kill_switch,hard_cap_quote,legacy_compatible,ath_reference_symbol")
      .eq("operator_id", op.data.id).order("id"),
  ]);
  if (accounts.error || engines.error || !accounts.data || !engines.data) throw new Error("COINOPS_OPERATOR_REGISTRY_UNAVAILABLE");
  // Disabled/revoked accounts remain in the ledger for audit, but must not
  // reappear in operational selectors or be resolved through a stale URL.
  const registry = visibleOperatorRegistry({ operator: op.data, accounts: accounts.data,
    engines: engines.data } as DomainRegistry);
  assertDomainRegistry(registry, scope);
  return registry;
}

export async function resolveOperatorEngine(client: Client, scope: OperatorScope, selection: EngineSelection) {
  return resolveEngineContext(await loadOperatorRegistry(client, scope), selection);
}
