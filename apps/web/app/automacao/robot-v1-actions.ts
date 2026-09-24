"use server";

import { actionEngine } from "./engine-action-context";
import type { EngineContext } from "@/lib/execution/operator-context";

import { createHash } from "node:crypto";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { runConfiguredRobotV1Shadow } from "@/lib/execution/robot-v1-shadow-server";
import { BinanceSpotAdapter } from "@/lib/execution/binance-spot-adapter";
import { V1_RULES, V1_TEST_PROFILE, assertV1ShadowParameters, buildV1Grid, calculateV1SlotNotional, type V1Asset, type V1ShadowParameters } from "@/lib/execution/robot-v1";
import { getCoinOpsServiceTenantId } from "@/lib/supabase/env";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";

type Scope = { productId: string; tenantId: string; userId: string };
type Config = { id: string; capital_usdc: number | string; next_capital_usdc: number | string | null; gain_rate: number | string; entry_spacing: number | string; next_gain_rate: number | string | null; next_entry_spacing: number | string | null; kill_switch: boolean; pause_new_entries: boolean; shadow_test_started_at: string | null; shadow_test_target_end_at: string | null };

function assetOf(formData: FormData): V1Asset { const asset = String(formData.get("asset") || ""); if (asset !== "BTC" && asset !== "SOL") throw new Error("COINOPS_V1_ASSET_INVALID"); return asset; }
function capitalOf(formData: FormData) { const capital = Number(String(formData.get("capital_usdc") || "").replace(",", ".")); calculateV1SlotNotional(capital); return capital; }
function percentOf(formData: FormData, field: "gain_percent" | "spacing_percent") { const value = Number(String(formData.get(field) || "").replace(",", ".")); if (!Number.isFinite(value)) throw new Error("COINOPS_V1_PARAMETERS_INVALID"); return value / 100; }
function parametersOf(formData: FormData): V1ShadowParameters { return assertV1ShadowParameters({ gainRate: percentOf(formData, "gain_percent"), entrySpacing: percentOf(formData, "spacing_percent") }); }
function configParameters(config: Config): V1ShadowParameters { return assertV1ShadowParameters({ gainRate: Number(config.gain_rate), entrySpacing: Number(config.entry_spacing) }); }
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

async function configFor(service: ReturnType<typeof createServiceRoleClient>, scope: Scope, asset: V1Asset, engine: EngineContext) {
  const { data, error } = await service.from("robot_v1_configs").select("id,capital_usdc,next_capital_usdc,gain_rate,entry_spacing,next_gain_rate,next_entry_spacing,kill_switch,pause_new_entries,shadow_test_started_at,shadow_test_target_end_at").eq("product_id", scope.productId).eq("tenant_id", scope.tenantId).eq("user_id", scope.userId).eq("asset", asset).eq("trading_engine_id", engine.trading_engine_id).maybeSingle();
  if (error) throw error;
  return data as Config | null;
}

export async function saveRobotV1Capital(formData: FormData) {
const scope = await userScope(); const service = createServiceRoleClient(); const asset = assetOf(formData); const engine = await actionEngine(formData, "SHADOW", asset, { product_id: scope.productId, tenant_id: scope.tenantId, user_id: scope.userId }); const capital = capitalOf(formData); const config = await configFor(service, scope, asset, engine);
  if (config?.shadow_test_started_at && capital !== Number(config.capital_usdc)) throw new Error("COINOPS_V1_CAPITAL_CHANGE_UNSUPPORTED");
  if (config?.shadow_test_started_at) return;
const filters = await BinanceSpotAdapter.fromEnvironment().getSymbolInfo(engine.symbol);
  if (capital / 25 < filters.minNotional) throw new Error("COINOPS_V1_MIN_NOTIONAL");
  const { data: activeCycle, error: activeError } = await service.from("robot_v1_cycles").select("id").eq("config_id", config?.id || "00000000-0000-0000-0000-000000000000").in("status", ["STARTING", "GRID_ACTIVE", "POSITIONS_ACTIVE", "RESETTING"]).maybeSingle();
  if (activeError) throw activeError;
  if (!config) {
    const defaults = V1_RULES[asset];
    const { data: created, error } = await service.from("robot_v1_configs").insert({ product_id: scope.productId, tenant_id: scope.tenantId, user_id: scope.userId, operator_id: engine.operator_id, exchange_account_id: engine.exchange_account_id, trading_engine_id: engine.trading_engine_id, quote_asset: engine.quote_asset, asset, symbol: engine.symbol, execution_mode: "SHADOW", capital_usdc: capital, gain_rate: defaults.gainRate, entry_spacing: defaults.entrySpacing, kill_switch: true }).select("id").single();
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

export async function saveRobotV1Parameters(formData: FormData) {
  const scope = await userScope(); const service = createServiceRoleClient(); const asset = assetOf(formData); const engine = await actionEngine(formData, "SHADOW", asset, { product_id: scope.productId, tenant_id: scope.tenantId, user_id: scope.userId }); const preset = formData.get("preset") === "quick";
  const capital = preset ? V1_TEST_PROFILE.capitalUsdc : capitalOf(formData);
  const parameters = preset ? { gainRate: V1_TEST_PROFILE.gainRate, entrySpacing: V1_TEST_PROFILE.entrySpacing } : parametersOf(formData);
  const config = await configFor(service, scope, asset, engine);
  if (capital > 2500) throw new Error("COINOPS_V1_CAPITAL_INVALID");
  const adapter = BinanceSpotAdapter.fromEnvironment();
const [filters, market] = await Promise.all([adapter.getSymbolInfo(engine.symbol), adapter.getMarketPrice(engine.symbol)]);
  if (capital / 25 < filters.minNotional) throw new Error("COINOPS_V1_MIN_NOTIONAL");
  if (!config) throw new Error("COINOPS_V1_CONFIG_REQUIRED");
  if (config.shadow_test_started_at) {
    const { data: accounts, error: accountsError } = await service.from("robot_v1_slot_accounts").select("slot_number,balance_usdc")
      .eq("config_id", config.id).eq("tenant_id", scope.tenantId).order("slot_number");
    if (accountsError || accounts?.length !== 25) throw new Error("COINOPS_V1_SLOT_ACCOUNT_INVALID");
    const delta = (capital - Number(config.capital_usdc)) / 25;
    const nextBalances = accounts.map((account) => Number(account.balance_usdc) + delta);
    if (nextBalances.some((balance) => balance <= 0 || balance > 100)) throw new Error("COINOPS_V1_NEXT_PROFILE_INVALID");
    buildV1Grid(asset, capital, market.price, filters, parameters, nextBalances);
  } else buildV1Grid(asset, capital, market.price, filters, parameters);
  const { data: activeCycle, error: activeError } = await service.from("robot_v1_cycles").select("id").eq("config_id", config.id).in("status", ["STARTING", "GRID_ACTIVE", "POSITIONS_ACTIVE", "RESETTING"]).maybeSingle();
  if (activeError) throw activeError;
  const next = { capitalUsdc: capital, gainRate: parameters.gainRate, entrySpacing: parameters.entrySpacing };
  if (activeCycle?.id || config.shadow_test_started_at) {
    const { error } = await service.from("robot_v1_configs").update({ next_capital_usdc: capital, next_gain_rate: parameters.gainRate, next_entry_spacing: parameters.entrySpacing }).eq("id", config.id).eq("product_id", scope.productId).eq("tenant_id", scope.tenantId).eq("user_id", scope.userId);
    if (error) throw error;
    await addAudit(service, scope, config.id, "PARAMETERS_NEXT_CYCLE", { capitalUsdc: config.capital_usdc, ...configParameters(config) }, { ...next, cycleId: activeCycle?.id || null });
  } else {
    const { error } = await service.from("robot_v1_configs").update({ capital_usdc: capital, gain_rate: parameters.gainRate, entry_spacing: parameters.entrySpacing, next_capital_usdc: null, next_gain_rate: null, next_entry_spacing: null }).eq("id", config.id).eq("product_id", scope.productId).eq("tenant_id", scope.tenantId).eq("user_id", scope.userId);
    if (error) throw error;
    await addAudit(service, scope, config.id, "CAPITAL_CHANGED", { capitalUsdc: config.capital_usdc, ...configParameters(config) }, { ...next, appliesTo: "CURRENT_CYCLE" });
  }
  revalidatePath("/automacao");
}

export async function controlRobotV1Shadow(formData: FormData) {
  const scope = await userScope(); const service = createServiceRoleClient(); const asset = assetOf(formData); const engine = await actionEngine(formData, "SHADOW", asset, { product_id: scope.productId, tenant_id: scope.tenantId, user_id: scope.userId }); const command = String(formData.get("command") || ""); const config = await configFor(service, scope, asset, engine);
  if (!config) throw new Error("COINOPS_V1_CONFIG_REQUIRED");
  const updateConfig = (values: Record<string, unknown>) => service.from("robot_v1_configs").update(values).eq("id", config.id).eq("product_id", scope.productId).eq("tenant_id", scope.tenantId).eq("user_id", scope.userId);
  if (command === "start") {
    const now = new Date(); const target = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const { error } = await updateConfig({ kill_switch: false, pause_new_entries: false, shadow_test_started_at: config.shadow_test_started_at || now.toISOString(), shadow_test_target_end_at: config.shadow_test_target_end_at || target.toISOString() });
    if (error) throw error;
    await addAudit(service, scope, config.id, "SHADOW_STARTED", { killSwitch: config.kill_switch, paused: config.pause_new_entries }, { capitalUsdc: config.capital_usdc, durationDays: 30 });
await runConfiguredRobotV1Shadow(now, engine);
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
  } else if (command === "restart") {
    if (formData.get("restart_confirmed") !== "yes") throw new Error("COINOPS_V1_RESTART_CONFIRMATION_REQUIRED");
    const { data: active, error: activeError } = await service.from("robot_v1_cycles").select("id").eq("config_id", config.id).in("status", ["STARTING", "GRID_ACTIVE", "POSITIONS_ACTIVE", "RESETTING"]).maybeSingle();
    if (activeError) throw activeError;
    const nextCapital = config.next_capital_usdc === null ? Number(config.capital_usdc) : Number(config.next_capital_usdc);
    const nextParameters = assertV1ShadowParameters({ gainRate: Number(config.next_gain_rate ?? config.gain_rate), entrySpacing: Number(config.next_entry_spacing ?? config.entry_spacing) });
    if (active?.id) {
      const { error } = await service.from("robot_v1_cycles").update({ status: "CYCLE_COMPLETE", completed_at: new Date().toISOString(), completion_reason: "TEST_RESTARTED" }).eq("id", active.id).eq("config_id", config.id);
      if (error) throw error;
    }
    const { error } = await updateConfig({ next_capital_usdc: nextCapital, next_gain_rate: nextParameters.gainRate, next_entry_spacing: nextParameters.entrySpacing, last_candle_open_at: null, kill_switch: false, pause_new_entries: false, shadow_test_started_at: config.shadow_test_started_at || new Date().toISOString(), shadow_test_target_end_at: config.shadow_test_target_end_at || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() });
    if (error) throw error;
    await addAudit(service, scope, config.id, "CYCLE_RESTARTED", { cycleId: active?.id || null }, { capitalUsdc: nextCapital, gainRate: nextParameters.gainRate, entrySpacing: nextParameters.entrySpacing, reason: "TEST_RESTARTED" });
await runConfiguredRobotV1Shadow(new Date(), engine);
  } else throw new Error("COINOPS_V1_COMMAND_INVALID");
  revalidatePath("/automacao");
}
