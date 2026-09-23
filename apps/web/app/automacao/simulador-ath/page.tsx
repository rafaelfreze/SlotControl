import { redirect } from "next/navigation";

import { getCoinOpsServiceTenantId, getSupabaseDataSchema } from "@/lib/supabase/env";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";

import { AthSimulatorClient } from "./simulator-client";
import "./simulator.css";

export const metadata = { title: "Simulador ATH | CoinOps" };
export const dynamic = "force-dynamic";

export default async function AthSimulatorPage() {
  if (!isSupabaseConfigured()) redirect("/login?setup=missing-env");
  if (getSupabaseDataSchema() !== "coinops" || !getCoinOpsServiceTenantId()) throw new Error("COINOPS_ATH_SCOPE_INVALID");
  const { data: { user } } = await createClient().auth.getUser();
  if (!user) redirect("/login");
  return <AthSimulatorClient />;
}
