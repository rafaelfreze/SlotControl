import { NextRequest, NextResponse } from "next/server";

import { simulateAth, type AthSimulationInput } from "@/lib/execution/ath-simulator";
import { getCoinOpsServiceTenantId, getSupabaseDataSchema } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Simulation only: authenticated scope check, no service role, no exchange
 * adapter and no mutation of an operational table. */
export async function POST(request: NextRequest) {
  if (getSupabaseDataSchema() !== "coinops") return NextResponse.json({ error: "SCHEMA_SCOPE_INVALID" }, { status: 503 });
  const user = (await createClient().auth.getUser()).data.user;
  if (!user) return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401 });
  const tenantId = getCoinOpsServiceTenantId();
  if (!tenantId) return NextResponse.json({ error: "TENANT_SCOPE_REQUIRED" }, { status: 403 });
  const { data: scope, error } = await createClient().from("strategies").select("product_id")
    .eq("tenant_id", tenantId).eq("user_id", user.id).limit(1).maybeSingle();
  if (error || !scope) return NextResponse.json({ error: "PRODUCT_SCOPE_REQUIRED" }, { status: 403 });
  if (Number(request.headers.get("content-length") || 0) > 64_000)
    return NextResponse.json({ error: "SIMULATION_TOO_LARGE" }, { status: 413 });
  let input: AthSimulationInput;
  try { input = await request.json() as AthSimulationInput; }
  catch { return NextResponse.json({ error: "SIMULATION_INPUT_INVALID" }, { status: 400 }); }
  try { return NextResponse.json(simulateAth(input), { headers: { "Cache-Control": "no-store" } }); }
  catch (simulationError) { return NextResponse.json({ error: simulationError instanceof Error ? simulationError.message : "SIMULATION_FAILED" }, { status: 400 }); }
}
