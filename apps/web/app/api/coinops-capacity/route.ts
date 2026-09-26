import { NextResponse } from "next/server";

import { asShardMetrics, capacityScope } from "@/lib/coinops-capacity/capacity-server";
import { assessShardCapacity, decideShardAdmission, DEFAULT_CAPACITY_POLICY } from "@/lib/coinops-capacity/capacity-manager";
import { getCoinOpsServiceTenantId, getSupabaseDataSchema } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "gru1";
const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" };

export async function GET() {
  if (getSupabaseDataSchema() !== "coinops" || !getCoinOpsServiceTenantId())
    return NextResponse.json({ error: "COINOPS_CAPACITY_SCOPE_INVALID" }, { status: 503, headers });
  const db = createClient();
  const user = (await db.auth.getUser()).data.user;
  if (!user) return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401, headers });
  const operator = await db.from("operators").select("id").eq("tenant_id", getCoinOpsServiceTenantId())
    .eq("user_id", user.id).eq("status", "ACTIVE").maybeSingle();
  if (operator.error || !operator.data)
    return NextResponse.json({ error: "COINOPS_CAPACITY_ADMIN_DENIED" }, { status: 403, headers });
  try {
    const service = capacityScope();
    const [shards, samples, alerts] = await Promise.all([
      service.from("executor_shards").select("id,enabled,binance_limit_per_min,admission_ratio,incremental_engine_weight").order("id"),
      service.from("executor_capacity_samples").select("*"),
      service.from("executor_capacity_alerts").select("shard_id,code,severity,first_seen_at")
        .is("resolved_at", null),
    ]);
    if (shards.error || samples.error || alerts.error) throw new Error("COINOPS_CAPACITY_READ_FAILED");
    return NextResponse.json({ shards: (shards.data ?? []).map((shard) => {
      const sample = (samples.data ?? []).find((item) => item.shard_id === shard.id) ?? null;
      const policy = { ...DEFAULT_CAPACITY_POLICY,
        binanceLimitPerMinute: Number(shard.binance_limit_per_min),
        admissionRatio: Number(shard.admission_ratio) };
      const metrics = sample && shard.enabled ? asShardMetrics(sample) : null;
      const assessment = assessShardCapacity(metrics, policy);
      const admission = decideShardAdmission(metrics, Number(shard.incremental_engine_weight), policy);
      const dualEngineAdmission = decideShardAdmission(metrics,
        Number(shard.incremental_engine_weight) * 2, policy);
      return { id: shard.id, state: assessment.state, action: assessment.action,
        binanceWeightCurrent: sample?.binance_weight_current ?? null,
        binanceWeightAverage: sample?.binance_weight_average ?? null,
        binanceWeightPeak: sample?.binance_weight_peak ?? null,
        binanceLimit: Number(shard.binance_limit_per_min), binancePercent: assessment.binancePercent,
        cpuPercent: sample?.cpu_percent ?? null, ramUsedMb: sample?.ram_used_mb ?? null,
        ramLimitMb: sample?.ram_limit_mb ?? null,
        schedulerBacklog: sample?.scheduler_backlog ?? null,
        reconciliationAgeMs: sample?.reconciliation_age_ms ?? null,
        accountCount: assessment.accountCount, engineCount: assessment.engineCount,
        observedAt: sample?.observed_at ?? null,
        canAddEngine: admission.allowed, admissionReason: admission.reason,
        canAddTwoEngineAccount: dualEngineAdmission.allowed,
        alerts: (alerts.data ?? []).filter((item) => item.shard_id === shard.id) };
    }) }, { headers });
  } catch {
    return NextResponse.json({ error: "COINOPS_CAPACITY_UNAVAILABLE" }, { status: 503, headers });
  }
}
