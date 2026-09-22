"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { advanceTestnetRun, replaceOwnedTestnetBuy, startTestnetRun } from "@/lib/execution/robot-v1-testnet-server";
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
  const runId = String(formData.get("run_id") || "");
  if (!/^[0-9a-f-]{36}$/.test(runId)) throw new Error("COINOPS_TESTNET_RUN_ID_INVALID");
  const { data, error } = await createServiceRoleClient().from("robot_v1_testnet_runs").select("id")
    .eq("id", runId).eq("tenant_id", getCoinOpsServiceTenantId()).eq("user_id", userId).eq("status", "ACTIVE").maybeSingle();
  if (error || !data) throw new Error("COINOPS_TESTNET_RUN_NOT_OWNED");
  return runId;
}

export async function startCoinOpsTestnet() {
  const userId = await currentUserId();
  try { await startTestnetRun(userId); }
  catch (error) { redirect(`/automacao?view=testnet&testnet=check&testnetError=${error instanceof Error && /^COINOPS_TESTNET_[A-Z_]+$/.test(error.message) ? error.message : "COINOPS_TESTNET_START_FAILED"}`); }
  revalidatePath("/automacao");
  redirect("/automacao?view=testnet&testnet=check");
}

export async function reconcileCoinOpsTestnet(formData: FormData) {
  const runId = await ownedRun(formData);
  try { await advanceTestnetRun(runId); }
  catch (error) { redirect(`/automacao?view=testnet&testnet=check&testnetError=${error instanceof Error && /^COINOPS_TESTNET_[A-Z_]+$/.test(error.message) ? error.message : "COINOPS_TESTNET_RECONCILIATION_FAILED"}`); }
  revalidatePath("/automacao");
  redirect("/automacao?view=testnet&testnet=check");
}

export async function replaceCoinOpsTestnetBuy(formData: FormData) {
  const runId = await ownedRun(formData);
  try { await replaceOwnedTestnetBuy(runId); }
  catch (error) { redirect(`/automacao?view=testnet&testnet=check&testnetError=${error instanceof Error && /^COINOPS_TESTNET_[A-Z_]+$/.test(error.message) ? error.message : "COINOPS_TESTNET_REPLACE_FAILED"}`); }
  revalidatePath("/automacao");
  redirect("/automacao?view=testnet&testnet=check");
}
