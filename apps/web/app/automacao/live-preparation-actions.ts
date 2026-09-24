"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { getCoinOpsServiceTenantId, getSupabaseDataSchema, getSupabaseEnv } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";

function amount(value: FormDataEntryValue | null) {
  const number = Number(String(value ?? "").trim().replace(",", "."));
  if (!Number.isFinite(number) || number <= 0 || number > 1_000_000
    || Math.abs(Math.round(number * 100) - number * 100) > 1e-7)
    throw new Error("COINOPS_LIVE_CAP_INVALID");
  return number;
}
async function context() {
  if (getSupabaseDataSchema() !== "coinops"
    || new URL(getSupabaseEnv().supabaseUrl).hostname !== "otdfpmsegjxpqrzisfmi.supabase.co")
    throw new Error("COINOPS_LIVE_BACKEND_INVALID");
  const tenantId = getCoinOpsServiceTenantId();
  if (!tenantId) throw new Error("COINOPS_LIVE_SCOPE_INVALID");
  const client = createClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user) redirect("/login");
  const { data: scope, error } = await client.from("strategies").select("product_id")
    .eq("tenant_id", tenantId).eq("user_id", user.id).limit(1).maybeSingle();
  if (error || !scope) throw new Error("COINOPS_LIVE_SCOPE_INVALID");
  return { productId: scope.product_id as string, tenantId, userId: user.id };
}

/** Changes BRL authorization only. It cannot toggle LIVE or call Binance. */
export async function saveLiveAssetCaps(formData: FormData) {
  const scope = await context();
  const asset = formData.get("asset");
  if (asset !== "BTC" && asset !== "SOL") throw new Error("COINOPS_LIVE_ASSET_INVALID");
  const capital = amount(formData.get("capital_brl"));
  const order = amount(formData.get("order_cap_brl"));
  const exposure = amount(formData.get("exposure_cap_brl"));
  if (order > exposure || exposure > capital) throw new Error("COINOPS_LIVE_CAP_INVALID");
  const service = createServiceRoleClient();
  const { data: rows, error: readError } = await service.from("robot_v1_live_preparations")
    .select("id,asset,max_total_exposure_brl,config_version,updated_at")
    .eq("product_id", scope.productId).eq("tenant_id", scope.tenantId).eq("user_id", scope.userId);
  const { data: global, error: globalError } = await service.from("robot_v1_live_global_caps")
    .select("max_total_live_exposure_brl")
    .eq("product_id", scope.productId).eq("tenant_id", scope.tenantId).eq("user_id", scope.userId).single();
  if (readError || globalError || !global || !rows || rows.length !== 2) throw new Error("COINOPS_LIVE_CONFIG_UNAVAILABLE");
  const current = rows.find((row) => row.asset === asset);
  if (!current || exposure + Number(rows.find((row) => row.asset !== asset)?.max_total_exposure_brl) > Number(global.max_total_live_exposure_brl))
    throw new Error("COINOPS_LIVE_GLOBAL_CAP_EXCEEDED");
  const { data: saved, error } = await service.from("robot_v1_live_preparations").update({
    configured_live_capital_brl: capital, max_order_notional_brl: order,
    max_total_exposure_brl: exposure, config_version: current.config_version + 1,
    updated_at: new Date().toISOString(),
  }).eq("id", current.id).eq("product_id", scope.productId).eq("tenant_id", scope.tenantId)
    .eq("user_id", scope.userId).eq("updated_at", current.updated_at).select("id").maybeSingle();
  if (error || !saved) throw new Error("COINOPS_LIVE_CONFIG_CONFLICT");
  revalidatePath("/automacao");
}

export async function saveLiveGlobalCap(formData: FormData) {
  const scope = await context();
  const cap = amount(formData.get("global_cap_brl"));
  const service = createServiceRoleClient();
  const { data: assets, error: assetsError } = await service.from("robot_v1_live_preparations")
    .select("asset,max_total_exposure_brl")
    .eq("product_id", scope.productId).eq("tenant_id", scope.tenantId).eq("user_id", scope.userId);
  const { data: current, error: currentError } = await service.from("robot_v1_live_global_caps")
    .select("config_version,updated_at")
    .eq("product_id", scope.productId).eq("tenant_id", scope.tenantId).eq("user_id", scope.userId).single();
  if (assetsError || currentError || !current || !assets || assets.length !== 2
    || cap < assets.reduce((sum, row) => sum + Number(row.max_total_exposure_brl), 0))
    throw new Error("COINOPS_LIVE_GLOBAL_CAP_INVALID");
  const { data: saved, error } = await service.from("robot_v1_live_global_caps").update({
    max_total_live_exposure_brl: cap, config_version: current.config_version + 1,
    updated_at: new Date().toISOString(),
  }).eq("product_id", scope.productId).eq("tenant_id", scope.tenantId).eq("user_id", scope.userId)
    .eq("updated_at", current.updated_at).select("product_id").maybeSingle();
  if (error || !saved) throw new Error("COINOPS_LIVE_CONFIG_CONFLICT");
  revalidatePath("/automacao");
}
