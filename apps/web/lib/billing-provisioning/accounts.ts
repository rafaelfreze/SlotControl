import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { billingService } from "@/lib/saas-billing/server";
import { getCoinOpsServiceTenantId } from "@/lib/supabase/env";
import { createPasswordViewerIdentity } from "@/app/api/coinops-viewers/password-user";
import { AccountError, accountMarker, receiveAccountRequest, type AccountInput } from "./accounts-contract";
import { accountResult, assertProvisionUser, centralTrialPayload, localProvisionActor } from "./accounts-support";
import { reportProvisioningFailure, type ProvisioningStage } from "./diagnostics";
const product = "coinops";
export async function receiveAccounts(request: Request) {
  let db: SupabaseClient;
  try { db = billingService() as unknown as SupabaseClient; }
  catch (error) { reportProvisioningFailure("service_client", error); throw error; }
  return receiveAccountRequest(request, product, {
    consume: async nonce => { const claim = await db.rpc("claim_saas_billing_nonce", { p_nonce: nonce }); if (claim.error) reportProvisioningFailure("nonce_claim", claim.error); return { data: !claim.error, error: claim.error }; },
    // No exchange, account, trading or balance operation belongs to signup.
    catalog: async () => [],
    create: async (input: AccountInput) => {
      let stage: ProvisioningStage = "actor_resolution";
      const report = (step: ProvisioningStage, error: unknown) => reportProvisioningFailure(step, error, input.request_id);
      try {
      const actor = await localProvisionActor(db, product, getCoinOpsServiceTenantId(), report), marker = accountMarker(input);
      stage = "existing_access_read";
      const prior = await db.from("viewer_access").select("user_id,status,deleted_at,operator_id").eq("operator_id", actor.operatorId!).eq("email", input.email).maybeSingle();
      if (prior.error) { report(stage, prior.error); throw new AccountError("account_readback_unavailable"); }
      let id = prior.data?.user_id;
      if (prior.data) {
        if (prior.data.status !== "ACTIVE" || prior.data.deleted_at) throw new AccountError("account_access_unavailable", 409);
        stage = "account_auth_read";
        await assertProvisionUser(db, id!, marker, error => report(stage, error));
      } else {
        stage = "identity_create";
        const user = await createPasswordViewerIdentity(db, { operation: "CREATE_WITH_PASSWORD", requestId: input.request_id, email: input.email, password: input.password, companyName: input.company_name, ownerName: input.owner_name, whatsapp: input.whatsapp }, actor.id, actor.operatorId!, marker, report);
        id = user.id;
      }
      stage = "account_auth_read";
      const user = await assertProvisionUser(db, id!, marker, error => report(stage, error));
      stage = "account_access_read";
      const access = await db.from("viewer_access").select("user_id,operator_id,status,deleted_at,company_name").eq("user_id", user.id).maybeSingle();
      if (access.error) report(stage, access.error);
      if (access.error || access.data?.operator_id !== actor.operatorId || access.data?.status !== "ACTIVE" || access.data?.deleted_at) throw new AccountError("account_access_unavailable", 409);
      stage = "account_result";
      return accountResult(input, user.id, centralTrialPayload(input, access.data.company_name || input.company_name, user.id, user.created_at), Boolean(prior.data), "https://cripto-flax.vercel.app/login");
      } catch (error) { report(stage, error); throw error; }
    },
  });
}
