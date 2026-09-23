"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { parseAthPercent, type AthEnvironment } from "@/lib/execution/ath-regime";
import { getCoinOpsServiceTenantId, getSupabaseDataSchema } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";

const environmentOf = (raw: FormDataEntryValue | null): AthEnvironment => {
  if (raw !== "SHADOW" && raw !== "TESTNET" && raw !== "REAL") throw new Error("COINOPS_ATH_ENVIRONMENT_INVALID");
  return raw;
};

/** Saves only queued percentages. It never toggles LIVE, changes an OPEN TP,
 * calls Binance or activates a profile within an active cycle. */
export async function saveAthNextProfile(formData: FormData) {
  if (getSupabaseDataSchema() !== "coinops") throw new Error("COINOPS_ATH_SCHEMA_INVALID");
  const tenantId = getCoinOpsServiceTenantId();
  if (!tenantId) throw new Error("COINOPS_ATH_TENANT_INVALID");
  const client = createClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user) redirect("/login");
  const environment = environmentOf(formData.get("environment"));
  const asset = String(formData.get("asset") || "");
  if (asset !== "BTC" && asset !== "SOL") throw new Error("COINOPS_ATH_ASSET_INVALID");
  const gainRate = parseAthPercent(String(formData.get("gain_percent") || ""));
  const normalSpacing = parseAthPercent(String(formData.get("normal_spacing_percent") || ""));
  const postAthSpacing = parseAthPercent(String(formData.get("post_ath_spacing_percent") || ""));
  const floorRaw = String(formData.get("ath_floor_reference") || "").trim();
  const floor = floorRaw ? Number(floorRaw.replace(",", ".")) : null;
  if (floor !== null && (!Number.isFinite(floor) || floor <= 0)) throw new Error("COINOPS_ATH_FLOOR_INVALID");
  const { data: scope, error: scopeError } = await client.from("strategies").select("product_id")
    .eq("tenant_id", tenantId).eq("user_id", user.id).limit(1).maybeSingle();
  if (scopeError || !scope) throw new Error("COINOPS_ATH_SCOPE_INVALID");
  const service = createServiceRoleClient();
  const query = service.from("robot_v1_ath_profiles").select("id,config_version,next_config_version,updated_at,ath_price")
    .eq("product_id", scope.product_id).eq("tenant_id", tenantId).eq("user_id", user.id)
    .eq("environment", environment).eq("asset", asset);
  const { data: current, error: loadError } = await query.single();
  if (loadError || !current) throw new Error("COINOPS_ATH_PROFILE_UNAVAILABLE");
  if (floor !== null && current.ath_price !== null && floor >= Number(current.ath_price))
    throw new Error("COINOPS_ATH_FLOOR_INVALID");
  const version = Number(current.next_config_version ?? current.config_version) + 1;
  const { data: saved, error: saveError } = await service.from("robot_v1_ath_profiles").update({
    next_gain_rate: gainRate, next_normal_spacing_rate: normalSpacing,
    next_post_ath_spacing_rate: postAthSpacing, next_config_version: version,
    ...(floor === null ? {} : { ath_floor_reference: floor, ath_floor_source: "USER_CONFIG",
      ath_floor_defined_at: new Date().toISOString() }),
    updated_at: new Date().toISOString(),
  }).eq("id", current.id).eq("product_id", scope.product_id).eq("tenant_id", tenantId)
    .eq("user_id", user.id).eq("updated_at", current.updated_at).select("id").maybeSingle();
  if (saveError || !saved) throw new Error("COINOPS_ATH_PROFILE_CONFLICT");
  const { error: eventError } = await service.from("robot_v1_ath_events").upsert({
    profile_id: current.id, product_id: scope.product_id, tenant_id: tenantId, user_id: user.id,
    environment, asset, event_key: `STRATEGY_CONFIG_SAVED:${version}`,
    event_type: "STRATEGY_CONFIG_SAVED", details: { next_config_version: version,
      gain_rate: gainRate, normal_spacing_rate: normalSpacing, post_ath_spacing_rate: postAthSpacing,
      floor_reference: floor },
  }, { onConflict: "profile_id,event_key", ignoreDuplicates: true });
  if (eventError) throw new Error("COINOPS_ATH_PROFILE_AUDIT_FAILED");
  revalidatePath("/automacao");
}
