"use server";

import { createHash } from "node:crypto";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { runConfiguredRobotV1Shadow } from "@/lib/execution/robot-v1-shadow-server";
import { BinanceSpotAdapter } from "@/lib/execution/binance-spot-adapter";
import { V1_RULES, calculateV1SlotNotional, type V1Asset } from "@/lib/execution/robot-v1";
import { getCoinOpsServiceTenantId } from "@/lib/supabase/env";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";

type Scope = { productId: string; tenantId: string; userId: string };
type Config = { id: string; capital_usdc: number | string; next_capital_usdc: number | string | null; kill_switch: boolean; pause_new_entries: boolean; shadow_test_started_at: string | null; shadow_test_target_end_at: string | null };

function assetOf(formData: FormData): V1Asset { const asset = String(formData.get("asset") || ""); if (asset !== "BTC" && asset !== "SOL") throw new Error("COINOPS_V1_ASSET_INVALID"); return asset; }
function capitalOf(formData: FormData) { const capital = Number(String(formData.get("capital_usdc") || "").replace(",", ".")); calculateV1SlotNotional(capital); return capital; }
function auditKey(configId: string, type: string, reference: string) { return createHash("sha256").update(`coinops-v1-control|${configId}|${type}|${reference}`).digest("hex"); }

async function userScope(): Promise<Scope> {
  if (!isSupabaseConfigured()) redirect("/login?setup=missing-env");
  const authenticated = createClient();
  const { data: { user } } = await authenticated.auth.getUser();
  if (!user) redirect("/login");
  const tenantId = getCoinOpsServiceTenantId();
  if (!tenantId) throw new Error("COINOPS_V1_TENANT_SCOPE_REQUIRED");
  const service = createServiceRoleClient();
  const { data, error } = await service.from("strategies").select("product_id,tenant_id,user_id").eq("tenant_id", tenantId).eq("user_id", user.id).limit(1).maybeSingle();
  if (error) throw error;
  if (!data || typeof data.product_id !== "string" || data.tenant_id !== tenantId || data.user_id !== user.id) throw new Error("COINOPS_V1_SCOPE_UNAVAILABLE");
  const productId = String(data.product_id);
  return { productId, tenantId, userId: user.id };
}

async function addAudit(service: ReturnType<typeof createServiceRoleClient>, scope: Scope, configId: string, type: string, previous: Record<string, unknown>, next: Record<string, unknown>) {
  const { error } = await service.from("robot_v1_audit_events").upsert({
    product_id: scope.productId, tenant_id: scope.tenantId, user_id: scope.userId, config_id: configId, event_type: type,
    previous_state: previous, next_state: next, idempotency_key: auditKey(configId, type, `${JSON.stringify(previous)}:${JSON.stringify(next)}:${Date.now()}`)
  }, { onConflict: "product_id,tenant_id,user_id,idempotency_key", ignoreDuplicates: true });
  if (error) throw error;
}

async function configFor(service: ReturnType<typeof createServiceRoleClient>, scope: Scope, asset: V1Asset) {
  const { data, error } = await service.from("robot_v1_configs").select("id,capital_usdc,next_capital_usdc,kill_switch,pause_new_entries,shadow_test_started_at,shadow_test_target_end_at").eq("product_id", scope.productId).eq("tenant_id", scope.tenantId).eq("user_id", scope.userId).eq("asset", asset).maybeSingle();
  if (error) throw error;
  return data as Config | null;
}

export async function saveRobotV1Capital(formData: FormData) {
  const scope = await userScope(); const service = createServiceRoleClient(); const asset = assetOf(formData); const capital = capitalOf(formData); const config = await configFor(service, scope, asset);
  const filters = await BinanceSpotAdapter.fromEnvironment().getSymbolInfo(V1_RULES[asset].symbol);
  if (capital / 25 < filters.minNotional) throw new Error("COINOPS_V1_MIN_NOTIONAL");
  const { data: activeCycle, error: activeError } = await service.from("robot_v1_cycles").select("id").eq("config_id", config?.id || "00000000-0000-0000-0000-000000000000").in("status", ["STARTING", "GRID_ACTIVE", "POSITIONS_ACTIVE", "RESETTING"]).maybeSingle();
  if (activeError) throw activeError;
  if (!config) {
    const { data: created, error } = await service.from("robot_v1_configs").insert({ product_id: scope.productId, tenant_id: scope.tenantId, user_id: scope.userId, asset, symbol: V1_RULES[asset].symbol, execution_mode: "SHADOW", capital_usdc: capital, kill_switch: true }).select("id").single();
    if (error) throw error;
    await addAudit(service, scope, created.id, "CAPITAL_CHANGED", {}, { capitalUsdc: capital, appliesTo: "CURRENT_CYCLE" });
  } else if (activeCycle?.id) {
    const { error } = await service.from("robot_v1_configs").update({ next_capital_usdc: capital }).eq("id", config.id).eq("product_id", scope.productId).eq("tenant_id", scope.tenantId).eq("user_id", scope.userId);
    if (error) throw error;
    await addAudit(service, scope, config.id, "CAPITAL_NEXT_CYCLE", { capitalUsdc: config.capital_usdc }, { nextCapitalUsdc: capital, cycleId: activeCycle.id });
  } else {
    const { error } = await service.from("robot_v1_configs").update({ capital_usdc: capital, next_capital_usdc: null }).eq("id", config.id).eq("product_id", scope.productId).eq("tenant_id", scope.tenantId).eq("user_id", scope.userId);
    if (error) throw error;
    await addAudit(service, scope, config.id, "CAPITAL_CHANGED", { capitalUsdc: config.capital_usdc }, { capitalUsdc: capital, appliesTo: "CURRENT_CYCLE" });
  }
  revalidatePath("/automacao");
}

export async function controlRobotV1Shadow(formData: FormData) {
  const scope = await userScope(); const service = createServiceRoleClient(); const asset = assetOf(formData); const command = String(formData.get("command") || ""); const config = await configFor(service, scope, asset);
  if (!config) throw new Error("COINOPS_V1_CONFIG_REQUIRED");
  const updateConfig = (values: Record<string, unknown>) => service.from("robot_v1_configs").update(values).eq("id", config.id).eq("product_id", scope.productId).eq("tenant_id", scope.tenantId).eq("user_id", scope.userId);
  if (command === "start") {
    const now = new Date(); const target = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const { error } = await updateConfig({ kill_switch: false, pause_new_entries: false, shadow_test_started_at: config.shadow_test_started_at || now.toISOString(), shadow_test_target_end_at: config.shadow_test_target_end_at || target.toISOString() });
    if (error) throw error;
    await addAudit(service, scope, config.id, "SHADOW_STARTED", { killSwitch: config.kill_switch, paused: config.pause_new_entries }, { capitalUsdc: config.capital_usdc, durationDays: 30 });
    await runConfiguredRobotV1Shadow(now);
  } else if (command === "pause") {
    const { error } = await updateConfig({ pause_new_entries: true }); if (error) throw error;
    await addAudit(service, scope, config.id, "PAUSED", { paused: config.pause_new_entries }, { paused: true });
  } else if (command === "resume") {
    const { error } = await updateConfig({ pause_new_entries: false, kill_switch: false }); if (error) throw error;
    await addAudit(service, scope, config.id, "RESUMED", { paused: config.pause_new_entries, killSwitch: config.kill_switch }, { paused: false, killSwitch: false });
  } else if (command === "kill") {
    const { error } = await updateConfig({ kill_switch: true }); if (error) throw error;
    await addAudit(service, scope, config.id, "KILL_SWITCH_ENABLED", { killSwitch: config.kill_switch }, { killSwitch: true });
  } else if (command === "reset") {
    const { data: active, error: activeError } = await service.from("robot_v1_cycles").select("id").eq("config_id", config.id).in("status", ["STARTING", "GRID_ACTIVE", "POSITIONS_ACTIVE", "RESETTING"]).maybeSingle();
    if (activeError) throw activeError;
    if (active) throw new Error("COINOPS_V1_RESET_ACTIVE_CYCLE_BLOCKED");
    await addAudit(service, scope, config.id, "RESET_ALLOWED", {}, { reset: "NO_ACTIVE_CYCLE" });
  } else throw new Error("COINOPS_V1_COMMAND_INVALID");
  revalidatePath("/automacao");
}
