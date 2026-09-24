"use server";

import { actionEngine } from "./engine-action-context";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { advanceTestnetRun, pauseTestnetRun, replaceOwnedTestnetBuy, resumeTestnetRun, startTestnetRun } from "@/lib/execution/robot-v1-testnet-server";
import { BinanceSpotTestnetAdapter } from "@/lib/execution/binance-spot-testnet-adapter";
import { buildV1Grid, V1_TEST_PROFILE, type V1Asset } from "@/lib/execution/robot-v1";
import { getCoinOpsServiceTenantId, getSupabaseDataSchema } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";

async function currentUserId() {
  if (getSupabaseDataSchema() !== "coinops") throw new Error("COINOPS_TESTNET_SCHEMA_SCOPE_INVALID");
  const { data: { user } } = await createClient().auth.getUser();
  if (!user) redirect("/login");
  return user.id;
}

async function ownedRun(formData: FormData) {
  const userId = await currentUserId();
  const engine = await actionEngine(formData, "TESTNET");
  const runId = String(formData.get("run_id") || "");
  if (!/^[0-9a-f-]{36}$/.test(runId)) throw new Error("COINOPS_TESTNET_RUN_ID_INVALID");
  const { data, error } = await createServiceRoleClient().from("robot_v1_testnet_runs").select("id")
    .eq("id", runId).eq("trading_engine_id", engine.trading_engine_id).eq("tenant_id", getCoinOpsServiceTenantId()).eq("user_id", userId).eq("status", "ACTIVE").maybeSingle();
  if (error || !data) throw new Error("COINOPS_TESTNET_RUN_NOT_OWNED");
  return { runId, engine };
}

function assetOf(formData: FormData): V1Asset {
  const asset = String(formData.get("asset") || "");
  if (asset !== "BTC" && asset !== "SOL") throw new Error("COINOPS_TESTNET_ASSET_INVALID");
  return asset;
}

function positiveNumber(formData: FormData, field: string) {
  const raw = String(formData.get(field) || "").trim().replace(",", ".");
  const value = Number(raw);
  if (!raw || !Number.isFinite(value) || value <= 0) throw new Error("COINOPS_TESTNET_NEXT_PROFILE_INVALID");
  return value;
}

export async function startCoinOpsTestnet(formData: FormData) {
  const engine = await actionEngine(formData, "TESTNET", assetOf(formData));
  const userId = await currentUserId();
  const asset = assetOf(formData);
  try { await startTestnetRun(userId, asset, { exchange_account_id: engine.exchange_account_id, trading_engine_id: engine.trading_engine_id }); }
  catch (error) { redirect(`/automacao?view=testnet&testnet=check&testnetError=${error instanceof Error && /^COINOPS_TESTNET_[A-Z_]+$/.test(error.message) ? error.message : "COINOPS_TESTNET_START_FAILED"}`); }
  revalidatePath("/automacao");
  redirect("/automacao?view=testnet&testnet=check");
}

export async function controlCoinOpsTestnet(formData: FormData) {
  const userId = await currentUserId();
  const asset = assetOf(formData);
  const engine = await actionEngine(formData, "TESTNET", asset);
  const command = String(formData.get("command") || "");
  if (command !== "pause" && command !== "resume") throw new Error("COINOPS_TESTNET_COMMAND_INVALID");
  const runId = String(formData.get("run_id") || "");
  if (!/^[0-9a-f-]{36}$/.test(runId)) throw new Error("COINOPS_TESTNET_RUN_ID_INVALID");
  const { data: run, error } = await createServiceRoleClient().from("robot_v1_testnet_runs")
    .select("id,status").eq("id", runId).eq("tenant_id", getCoinOpsServiceTenantId())
    .eq("user_id", userId).eq("asset", asset).eq("trading_engine_id", engine.trading_engine_id)
    .eq("exchange_account_id", engine.exchange_account_id).in("status", ["ACTIVE", "PAUSED"]).single();
  if (error || !run) throw new Error("COINOPS_TESTNET_RUN_NOT_OWNED");
  try {
    if (command === "pause") await pauseTestnetRun(run.id);
    else await resumeTestnetRun(run.id);
  } catch (failure) {
    const code = failure instanceof Error && /^COINOPS_TESTNET_[A-Z_]+$/.test(failure.message)
      ? failure.message : "COINOPS_TESTNET_CONTROL_FAILED";
    redirect(`/automacao?view=testnet&testnet=check&testnetError=${code}`);
  }
  revalidatePath("/automacao");
  redirect("/automacao?view=testnet&testnet=check");
}

export async function saveCoinOpsTestnetNextCycle(formData: FormData) {
  const userId = await currentUserId();
  const asset = assetOf(formData);
  const { runId, engine } = await ownedRun(formData);
  const preset = formData.get("preset") === "quick";
  const capital = preset ? V1_TEST_PROFILE.capitalUsdc : positiveNumber(formData, "capital_usdc");
  const gainRate = preset ? V1_TEST_PROFILE.gainRate : positiveNumber(formData, "gain_percent") / 100;
  const entrySpacing = preset ? V1_TEST_PROFILE.entrySpacing : positiveNumber(formData, "spacing_percent") / 100;
  if (capital > 2500 || gainRate < 0.001 || gainRate > 0.20 || entrySpacing < 0.001 || entrySpacing > 0.20) throw new Error("COINOPS_TESTNET_NEXT_PROFILE_INVALID");
  const service = createServiceRoleClient();
  const { data: run, error: runError } = await service.from("robot_v1_testnet_runs")
    .select("id,product_id,tenant_id,user_id,asset,symbol,slot_notional_usdc")
    .eq("id", runId).eq("tenant_id", getCoinOpsServiceTenantId()).eq("user_id", userId).eq("asset", asset).eq("status", "ACTIVE").single();
  if (runError || !run || run.symbol !== engine.symbol || asset !== engine.base_asset) throw new Error("COINOPS_TESTNET_RUN_NOT_OWNED");
  const { data: slots, error: slotError } = await service.from("robot_v1_testnet_slots").select("slot_number,balance_usdc")
    .eq("run_id", runId).eq("tenant_id", run.tenant_id).order("slot_number");
  if (slotError || slots?.length !== 25) throw new Error("COINOPS_TESTNET_PLAN_INCOMPLETE");
  const adapter = BinanceSpotTestnetAdapter.fromAccount(engine, runId, []).reads;
  const [filters, market] = await Promise.all([adapter.getSymbolInfo(run.symbol), adapter.getMarketPrice(run.symbol)]);
  const delta = capital / 25 - Number(run.slot_notional_usdc);
  const balances = slots.map((slot) => Number(slot.balance_usdc) + delta);
  if (balances.some((balance) => balance <= 0 || balance > 100)) throw new Error("COINOPS_TESTNET_NEXT_CAPITAL_INVALID");
  buildV1Grid(asset, capital, market.price, filters, { gainRate, entrySpacing }, balances);
  const { data: saved, error } = await service.from("robot_v1_testnet_runs").update({ next_capital_usdc: capital, next_gain_rate: gainRate, next_entry_spacing: entrySpacing })
    .eq("id", runId).eq("product_id", run.product_id).eq("tenant_id", run.tenant_id).eq("user_id", userId).eq("asset", asset).eq("status", "ACTIVE").is("lease_owner", null).select("id").maybeSingle();
  if (error || !saved) throw new Error("COINOPS_TESTNET_NEXT_PROFILE_SAVE_FAILED");
  revalidatePath("/automacao");
}

export async function reconcileCoinOpsTestnet(formData: FormData) {
  const { runId } = await ownedRun(formData);
  try { await advanceTestnetRun(runId, "MANUAL_RECONCILIATION"); }
  catch (error) { redirect(`/automacao?view=testnet&testnet=check&testnetError=${error instanceof Error && /^COINOPS_TESTNET_[A-Z_]+$/.test(error.message) ? error.message : "COINOPS_TESTNET_RECONCILIATION_FAILED"}`); }
  revalidatePath("/automacao");
  redirect("/automacao?view=testnet&testnet=check");
}

export async function replaceCoinOpsTestnetBuy(formData: FormData) {
  const { runId } = await ownedRun(formData);
  try { await replaceOwnedTestnetBuy(runId); }
  catch (error) { redirect(`/automacao?view=testnet&testnet=check&testnetError=${error instanceof Error && /^COINOPS_TESTNET_[A-Z_]+$/.test(error.message) ? error.message : "COINOPS_TESTNET_REPLACE_FAILED"}`); }
  revalidatePath("/automacao");
  redirect("/automacao?view=testnet&testnet=check");
}
