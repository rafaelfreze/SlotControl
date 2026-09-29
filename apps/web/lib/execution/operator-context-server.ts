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
  const operatorId = op.data.id;
  const pageSize = 500;
  async function pages(table: "exchange_accounts" | "trading_engines", columns: string) {
    const rows: Record<string, unknown>[] = [];
    for (let offset = 0; ; offset += pageSize) {
      const result = await client.from(table).select(columns).eq("operator_id", operatorId)
        .order("id").range(offset, offset + pageSize - 1);
      if (result.error || !result.data) throw new Error("COINOPS_OPERATOR_REGISTRY_UNAVAILABLE");
      rows.push(...result.data as unknown as Record<string, unknown>[]);
      if (result.data.length < pageSize) return rows;
    }
  }
  const [accounts, engines] = await Promise.all([
    pages("exchange_accounts", "id,operator_id,display_name,status,is_legacy_default,kill_switch,executor_shard_id"),
    pages("trading_engines", "id,operator_id,exchange_account_id,environment,symbol,base_asset,quote_asset,status,kill_switch,strategy_config_pending,hard_cap_quote,legacy_compatible,ath_reference_symbol"),
  ]);
  // Disabled/revoked accounts remain in the ledger for audit, but must not
  // reappear in operational selectors or be resolved through a stale URL.
  const registry = visibleOperatorRegistry({ operator: op.data, accounts,
    engines } as unknown as DomainRegistry);
  assertDomainRegistry(registry, scope);
  return registry;
}

export async function resolveOperatorEngine(client: Client, scope: OperatorScope, selection: EngineSelection) {
  return resolveEngineContext(await loadOperatorRegistry(client, scope), selection);
}
