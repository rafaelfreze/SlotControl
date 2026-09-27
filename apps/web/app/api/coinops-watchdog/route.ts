import { NextResponse } from "next/server";
import { getCoinOpsServiceTenantId, getSupabaseDataSchema } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { aggregateWatchdogStatus } from "@/lib/coinops-watchdog/watchdog-status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" };

export async function GET() {
  if (getSupabaseDataSchema() !== "coinops" || !getCoinOpsServiceTenantId())
    return NextResponse.json({ error: "COINOPS_WATCHDOG_SCOPE_INVALID" }, { status: 503, headers });
  const user = (await createClient().auth.getUser()).data.user;
  if (!user) return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401, headers });
  const service = createServiceRoleClient();
  const operator = await service.from("operators").select("id").eq("tenant_id", getCoinOpsServiceTenantId())
    .eq("user_id", user.id).eq("status", "ACTIVE").maybeSingle();
  if (operator.error || !operator.data)
    return NextResponse.json({ error: "ADMIN_REQUIRED" }, { status: 403, headers });
  const [shards, checks, incidents, recoveries, criticalAlerts] = await Promise.all([
    service.from("executor_shards").select("id").eq("enabled", true),
    service.from("watchdog_checks").select("shard_id,checked_at,shard_state,healthy_engines,recovering_engines,blocked_engines,stale_engines"),
    service.from("watchdog_incidents")
      .select("incident_id,shard_id,market,detected_condition,result,opened_at,resolved_at")
      .order("opened_at", { ascending: false }).limit(1),
    service.from("watchdog_incidents").select("incident_id", { count: "exact", head: true })
      .eq("result", "RECOVERED").not("last_recovery_attempt_at", "is", null)
      .gte("resolved_at", new Date(Date.now() - 24 * 60 * 60_000).toISOString()),
    service.from("robot_v1_live_alerts").select("id", { count: "exact", head: true })
      .eq("tenant_id", getCoinOpsServiceTenantId()).eq("operator_id", operator.data.id)
      .eq("severity", "CRITICAL").is("resolved_at", null),
  ]);
  if (shards.error || checks.error || incidents.error || recoveries.error || criticalAlerts.error)
    return NextResponse.json({ error: "COINOPS_WATCHDOG_READ_FAILED" }, { status: 503, headers });
  return NextResponse.json({ ...aggregateWatchdogStatus((shards.data ?? []).map((item) => item.id),
    checks.data ?? [], criticalAlerts.count ?? 0), lastIncident: incidents.data?.[0] ?? null,
  autoRecoveries24h: recoveries.count ?? 0 }, { headers });
}
