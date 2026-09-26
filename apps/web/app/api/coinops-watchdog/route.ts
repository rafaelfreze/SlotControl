import { NextResponse } from "next/server";
import { getCoinOpsServiceTenantId, getSupabaseDataSchema } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";

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
  const [shards, checks, incidents, recoveries] = await Promise.all([
    service.from("executor_shards").select("id").eq("enabled", true),
    service.from("watchdog_checks").select("shard_id,checked_at,shard_state,healthy_engines,recovering_engines,blocked_engines,stale_engines"),
    service.from("watchdog_incidents")
      .select("incident_id,shard_id,market,detected_condition,result,opened_at,resolved_at")
      .order("opened_at", { ascending: false }).limit(1),
    service.from("watchdog_incidents").select("incident_id", { count: "exact", head: true })
      .eq("result", "RECOVERED").not("last_recovery_attempt_at", "is", null)
      .gte("resolved_at", new Date(Date.now() - 24 * 60 * 60_000).toISOString()),
  ]);
  if (shards.error || checks.error || incidents.error || recoveries.error)
    return NextResponse.json({ error: "COINOPS_WATCHDOG_READ_FAILED" }, { status: 503, headers });
  const enabled = new Set((shards.data ?? []).map((item) => item.id));
  const rows = (checks.data ?? []).filter((item) => enabled.has(item.shard_id));
  const latest = rows.reduce<string | null>((current, item) =>
    !current || Date.parse(item.checked_at) > Date.parse(current) ? item.checked_at : current, null);
  const fresh = rows.length === enabled.size && rows.every((item) =>
    Date.now() - Date.parse(item.checked_at) < 3 * 60_000);
  return NextResponse.json({ status: fresh
    ? rows.every((item) => item.shard_state === "HEALTHY") ? "HEALTHY" : "ATTENTION"
    : "STALE", checkedAt: latest,
  engines: { healthy: rows.reduce((n, row) => n + row.healthy_engines, 0),
    recovering: rows.reduce((n, row) => n + row.recovering_engines, 0),
    blocked: rows.reduce((n, row) => n + row.blocked_engines, 0),
    stale: rows.reduce((n, row) => n + row.stale_engines, 0) },
  executors: { healthy: rows.filter((row) => row.shard_state === "HEALTHY").length,
    total: enabled.size }, lastIncident: incidents.data?.[0] ?? null,
  autoRecoveries24h: recoveries.count ?? 0 }, { headers });
}
