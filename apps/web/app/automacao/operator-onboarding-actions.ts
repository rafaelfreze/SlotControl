"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { getCoinOpsServiceTenantId, getSupabaseDataSchema } from "@/lib/supabase/env";
import { resolveOperatorEngine } from "@/lib/execution/operator-context-server";
import { loadLiveProductionSnapshot } from "@/lib/execution/live-preparation-server";
import { syncInactiveBinanceAccount } from "@/lib/execution/binance-account-registry-server";
import { validateAccountDraft, type AccountDraft } from "./operator-onboarding";

async function operatorScope() {
  if (getSupabaseDataSchema() !== "coinops") throw new Error("COINOPS_ONBOARDING_SCHEMA_DENIED");
  const client = createClient(), user = (await client.auth.getUser()).data.user;
  const tenantId = getCoinOpsServiceTenantId();
  if (!user || !tenantId) throw new Error("COINOPS_ONBOARDING_AUTH_REQUIRED");
  const op = await client.from("operators").select("id,product_id,tenant_id,user_id,status")
    .eq("tenant_id", tenantId).eq("user_id", user.id).eq("status", "ACTIVE").single();
  if (op.error || !op.data) throw new Error("COINOPS_ONBOARDING_OPERATOR_DENIED");
  return { operator: op.data, service: createServiceRoleClient() };
}

/** Administrative preparation only. Partial retries remain INACTIVE and never dispatch. */
export async function saveAccountOnboardingDraft(input: AccountDraft) {
  const draft = validateAccountDraft(input), { operator, service } = await operatorScope();
  const existing = await service.from("exchange_accounts").select("id,operator_id,display_name,status,kill_switch,is_legacy_default")
    .eq("id", draft.accountId).maybeSingle();
  if (existing.error) throw new Error("COINOPS_ONBOARDING_READ_FAILED");
  if (existing.data && (existing.data.operator_id !== operator.id || existing.data.status !== "INACTIVE"
    || existing.data.kill_switch !== true || existing.data.is_legacy_default || existing.data.display_name !== draft.displayName))
    throw new Error("COINOPS_ONBOARDING_EXISTING_ACCOUNT_DENIED");
  const account = await service.from("exchange_accounts").upsert({ id: draft.accountId, operator_id: operator.id,
    display_name: draft.displayName, status: "INACTIVE", kill_switch: true, is_legacy_default: false,
    credential_ref: `account_${draft.accountId.replaceAll("-", "")}`, executor_profile: "coinops-fixed-ip" },
  { onConflict: "id", ignoreDuplicates: true });
  if (account.error) throw new Error("COINOPS_ONBOARDING_DRAFT_SAVE_FAILED");
  const config = { slot_count: 25, initial_capital_quote: draft.capital, gain_rate: draft.gain,
    normal_spacing_rate: draft.spacing, post_ath_spacing_rate: draft.postAth, monthly_target: draft.base === "BTC" ? 7 : 2 };
  const engine = await service.from("trading_engines").upsert({ id: draft.engineId, operator_id: operator.id,
    exchange_account_id: draft.accountId, environment: draft.environment, symbol: draft.symbol,
    base_asset: draft.base, quote_asset: draft.quote, ath_reference_symbol: draft.symbol,
    status: "INACTIVE", kill_switch: true, legacy_compatible: false, hard_cap_quote: draft.engineCap, config },
  { onConflict: "id", ignoreDuplicates: true });
  if (engine.error) throw new Error("COINOPS_ONBOARDING_ENGINE_SAVE_FAILED");
  const saved = await service.from("trading_engines").select("operator_id,exchange_account_id,environment,symbol,hard_cap_quote,status,kill_switch,config")
    .eq("id", draft.engineId).single();
  if (saved.error || !saved.data || saved.data.operator_id !== operator.id || saved.data.exchange_account_id !== draft.accountId
    || saved.data.environment !== draft.environment || saved.data.symbol !== draft.symbol
    || Number(saved.data.hard_cap_quote) !== draft.engineCap || saved.data.status !== "INACTIVE" || saved.data.kill_switch !== true
    || Object.entries(config).some(([key, value]) => saved.data.config?.[key] !== value))
    throw new Error("COINOPS_ONBOARDING_RETRY_MISMATCH");
  const cap = await service.from("account_quote_caps").upsert({ operator_id: operator.id,
    exchange_account_id: draft.accountId, quote_asset: draft.quote, hard_cap_quote: draft.accountCap },
  { onConflict: "exchange_account_id,quote_asset", ignoreDuplicates: true });
  if (cap.error) throw new Error("COINOPS_ONBOARDING_CAP_SAVE_FAILED");
  const storedCap = await service.from("account_quote_caps").select("hard_cap_quote")
    .eq("operator_id", operator.id).eq("exchange_account_id", draft.accountId).eq("quote_asset", draft.quote).single();
  if (storedCap.error || !storedCap.data || Number(storedCap.data.hard_cap_quote) !== draft.accountCap)
    throw new Error("COINOPS_ONBOARDING_RETRY_MISMATCH");
  const check = await service.from("account_onboarding_checks").upsert({ operator_id: operator.id,
    exchange_account_id: draft.accountId, trading_engine_id: draft.engineId, check_key: "DRAFT_CONFIG", status: "PASS",
    evidence: { mode: "INACTIVE_DRAFT", symbol: draft.symbol, quote_asset: draft.quote, trading_enabled: false },
    created_by: operator.user_id, idempotency_key: `draft:${draft.engineId}` },
  { onConflict: "exchange_account_id,idempotency_key", ignoreDuplicates: true });
  if (check.error) throw new Error("COINOPS_ONBOARDING_CHECK_SAVE_FAILED");
  if (draft.environment === "REAL") {
    const credential = await service.from("account_onboarding_checks").select("evidence")
      .eq("operator_id", operator.id).eq("exchange_account_id", draft.accountId)
      .eq("check_key", "BINANCE_CREDENTIAL").order("checked_at", { ascending: false }).limit(1);
    if (credential.error) throw new Error("COINOPS_ONBOARDING_CREDENTIAL_READ_FAILED");
    if (credential.data?.[0] && credential.data[0].evidence?.status !== "REMOVED")
      await syncInactiveBinanceAccount(service, operator.id, draft.accountId,
        `account_${draft.accountId.replaceAll("-", "")}`, "REAL");
  }
  revalidatePath("/automacao");
  return { accountId: draft.accountId, engineId: draft.engineId, status: "INACTIVE" as const };
}

/** Only authenticated GETs; evidence is generated here, never accepted from a checkbox. */
export async function verifyAccountOnboardingReadOnly(input: { accountId: string; engineId: string }) {
  const { operator, service } = await operatorScope();
  const engine = await resolveOperatorEngine(service, operator, { environment: "REAL",
    exchange_account_id: input.accountId, trading_engine_id: input.engineId });
  let status: "PASS" | "FAIL" = "FAIL", code = "COINOPS_ONBOARDING_READ_ONLY_FAILED";
  try {
    const snapshot = await loadLiveProductionSnapshot(engine);
    if (snapshot.exchange_account_id !== engine.exchange_account_id || !snapshot.engine_ids.includes(engine.trading_engine_id)
      || snapshot.quote_asset !== engine.quote_asset || !snapshot.balanceObservedAt)
      throw new Error("COINOPS_ONBOARDING_EVIDENCE_SCOPE_INVALID");
    status = "PASS"; code = "GET_AUTHENTICATED_NO_WRITE";
  } catch (error) {
    if (error instanceof Error && /^(?:EXECUTOR|COINOPS)_[A-Z0-9_]+$/.test(error.message)) code = error.message;
  }
  const check = await service.from("account_onboarding_checks").insert({ operator_id: operator.id,
    exchange_account_id: engine.exchange_account_id, trading_engine_id: engine.trading_engine_id,
    check_key: "READ_ONLY", status, evidence: { code, symbol: engine.symbol, quote_asset: engine.quote_asset, mode: "GET_ONLY" },
    created_by: operator.user_id, idempotency_key: `readonly:${randomUUID()}` });
  if (check.error) throw new Error("COINOPS_ONBOARDING_CHECK_SAVE_FAILED");
  revalidatePath("/automacao"); return { status, code };
}
