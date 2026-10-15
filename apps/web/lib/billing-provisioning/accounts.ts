import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { billingService } from "@/lib/saas-billing/server";
import { getCoinOpsServiceTenantId } from "@/lib/supabase/env";
import { createPasswordViewerIdentity } from "@/app/api/coinops-viewers/password-user";
import { AccountError, accountMarker, receiveAccountRequest, type AccountInput } from "./accounts-contract";
import { accountResult, assertProvisionUser, centralTrialPayload, localProvisionActor } from "./accounts-support";
const product = "coinops";
export async function receiveAccounts(request: Request) {
  const db = billingService() as unknown as SupabaseClient;
  return receiveAccountRequest(request, product, {
    consume: async nonce => { const claim = await db.rpc("claim_saas_billing_nonce", { p_nonce: nonce }); return { data: !claim.error, error: claim.error }; },
    // No exchange, account, trading or balance operation belongs to signup.
    catalog: async () => [],
    create: async (input: AccountInput) => {
      const actor = await localProvisionActor(db, product, getCoinOpsServiceTenantId()), marker = accountMarker(input);
      const prior = await db.from("viewer_access").select("user_id,status,deleted_at,operator_id").eq("operator_id", actor.operatorId!).eq("email", input.email).maybeSingle();
      if (prior.error) throw new AccountError("account_readback_unavailable");
      let id = prior.data?.user_id;
      if (prior.data) {
        if (prior.data.status !== "ACTIVE" || prior.data.deleted_at) throw new AccountError("account_access_unavailable", 409);
        await assertProvisionUser(db, id!, marker);
      } else {
        const user = await createPasswordViewerIdentity(db, { operation: "CREATE_WITH_PASSWORD", requestId: input.request_id, email: input.email, password: input.password, companyName: input.company_name, ownerName: input.owner_name, whatsapp: input.whatsapp }, actor.id, actor.operatorId!, marker);
        id = user.id;
      }
      const user = await assertProvisionUser(db, id!, marker);
      const access = await db.from("viewer_access").select("user_id,operator_id,status,deleted_at,company_name").eq("user_id", user.id).maybeSingle();
      if (access.error || access.data?.operator_id !== actor.operatorId || access.data?.status !== "ACTIVE" || access.data?.deleted_at) throw new AccountError("account_access_unavailable", 409);
      return accountResult(input, user.id, centralTrialPayload(input, access.data.company_name || input.company_name, user.id, user.created_at), Boolean(prior.data), "https://cripto-flax.vercel.app/login");
    },
  });
}
