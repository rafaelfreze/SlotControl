import "server-only";
import { createClient } from "../supabase/server";
import { createServiceRoleClient } from "../supabase/service-role";
import { getCoinOpsServiceTenantId, getSupabaseDataSchema } from "../supabase/env";

export function assetHealthService() {
  if (getSupabaseDataSchema() !== "coinops" || !getCoinOpsServiceTenantId())
    throw new Error("COINOPS_ASSET_HEALTH_SCOPE_INVALID");
  return createServiceRoleClient();
}
/** Public market facts only; access still requires an active CoinOps product membership. */
export async function requireAssetHealthAccess(adminOnly = false) {
  const service = assetHealthService();
  const { data: { user }, error } = await createClient().auth.getUser();
  if (error || !user) throw new Error("AUTH_REQUIRED");
  const tenantId = getCoinOpsServiceTenantId()!;
  if (user.app_metadata?.coinops_role === "VIEWER") {
    if (adminOnly) throw new Error("ADMIN_REQUIRED");
    const binding = await service.from("viewer_access").select("operator_id,exchange_account_id,status")
      .eq("user_id", user.id).eq("status", "ACTIVE").maybeSingle();
    if (binding.error || !binding.data) throw new Error("ACCESS_DENIED");
    const [operator, account] = await Promise.all([
      service.from("operators").select("id").eq("id", binding.data.operator_id)
        .eq("tenant_id", tenantId).eq("status", "ACTIVE").maybeSingle(),
      service.from("exchange_accounts").select("id").eq("id", binding.data.exchange_account_id)
        .eq("operator_id", binding.data.operator_id).eq("tenant_id", tenantId)
        .neq("status", "DISABLED").maybeSingle(),
    ]);
    if (operator.error || account.error || !operator.data || !account.data) throw new Error("ACCESS_DENIED");
    return { role: "VIEWER" as const };
  }
  const operator = await service.from("operators").select("id").eq("tenant_id", tenantId)
    .eq("user_id", user.id).eq("status", "ACTIVE").maybeSingle();
  if (operator.error || !operator.data) throw new Error("ACCESS_DENIED");
  return { role: "ADMIN" as const };
}
