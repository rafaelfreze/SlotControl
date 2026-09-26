import { NextRequest, NextResponse } from "next/server";

import { asShardMetrics, capacityScope } from "@/lib/coinops-capacity/capacity-server";
import { shardReservedWeight } from "@/lib/coinops-capacity/admission-reservations";
import { assessShardCapacity, decideShardAdmission, DEFAULT_CAPACITY_POLICY } from "@/lib/coinops-capacity/capacity-manager";
import { capacityWarningMuted } from "@/lib/coinops-capacity/capacity-warning-mute";
import { getCoinOpsServiceTenantId, getSupabaseDataSchema } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "gru1";
const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" };

async function adminOperatorId() {
  if (getSupabaseDataSchema() !== "coinops" || !getCoinOpsServiceTenantId())
    return { error: "COINOPS_CAPACITY_SCOPE_INVALID", status: 503 } as const;
  const db = createClient();
  const user = (await db.auth.getUser()).data.user;
  if (!user) return { error: "AUTH_REQUIRED", status: 401 } as const;
  const operator = await db.from("operators").select("id").eq("tenant_id", getCoinOpsServiceTenantId())
    .eq("user_id", user.id).eq("status", "ACTIVE").maybeSingle();
  if (operator.error || !operator.data)
    return { error: "COINOPS_CAPACITY_ADMIN_DENIED", status: 403 } as const;
  return { operatorId: operator.data.id } as const;
}

export async function GET() {
  const auth = await adminOperatorId();
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status, headers });
  try {
    const service = capacityScope();
    const [shards, samples, alerts, reservations, mutes] = await Promise.all([
      service.from("executor_shards").select("id,egress_ipv4,enabled,binance_limit_per_min,admission_ratio,incremental_engine_weight").order("id"),
      service.from("executor_capacity_samples").select("*"),
      service.from("executor_capacity_alerts").select("shard_id,code,severity,first_seen_at")
        .is("resolved_at", null),
      service.from("executor_capacity_admissions").select("shard_id,environment,reserved_weight")
        .eq("environment", "REAL").gt("expires_at", new Date().toISOString()),
      service.from("executor_capacity_warning_mutes").select("shard_id")
        .eq("operator_id", auth.operatorId),
    ]);
    if (shards.error || samples.error || alerts.error || reservations.error || mutes.error)
      throw new Error("COINOPS_CAPACITY_READ_FAILED");
    const mutedPairs = new Set((mutes.data ?? []).map((item) => `${auth.operatorId}:${item.shard_id}`));
    return NextResponse.json({ shards: (shards.data ?? []).map((shard) => {
      const sample = (samples.data ?? []).find((item) => item.shard_id === shard.id) ?? null;
      const policy = { ...DEFAULT_CAPACITY_POLICY,
        binanceLimitPerMinute: Number(shard.binance_limit_per_min),
        admissionRatio: Number(shard.admission_ratio) };
      const metrics = sample && shard.enabled ? asShardMetrics(sample) : null;
      const assessment = assessShardCapacity(metrics, policy);
      const reservedWeight = shardReservedWeight(shard.id, "REAL", reservations.data ?? []);
      const admission = decideShardAdmission(metrics, Number(shard.incremental_engine_weight) + reservedWeight, policy);
      const dualEngineAdmission = decideShardAdmission(metrics,
        Number(shard.incremental_engine_weight) * 2 + reservedWeight, policy);
      const warningsMuted = mutedPairs.has(`${auth.operatorId}:${shard.id}`);
      return { id: shard.id, state: assessment.state, action: assessment.action, warningsMuted,
        egressIp: String(shard.egress_ipv4), reservedWeight,
        binanceWeightCurrent: sample?.binance_weight_current ?? null,
        binanceWeightAverage: sample?.binance_weight_average ?? null,
        binanceWeightPeak: sample?.binance_weight_peak ?? null,
        binanceLimit: Number(shard.binance_limit_per_min), binancePercent: assessment.binancePercent,
        cpuPercent: sample?.cpu_percent ?? null, ramUsedMb: sample?.ram_used_mb ?? null,
        ramLimitMb: sample?.ram_limit_mb ?? null,
        schedulerBacklog: sample?.scheduler_backlog ?? null,
        reconciliationAgeMs: sample?.reconciliation_age_ms ?? null,
        accountCount: sample?.account_count ?? 0, engineCount: sample?.engine_count ?? 0,
        observedAt: sample?.observed_at ?? null,
        heartbeatAt: sample?.heartbeat_at ?? null,
        executorVersion: sample?.executor_version ?? null,
        canAddEngine: assessment.state === "HEALTHY" && admission.allowed, admissionReason: admission.reason,
        canAddTwoEngineAccount: assessment.state === "HEALTHY" && dualEngineAdmission.allowed,
        alerts: (alerts.data ?? []).filter((item) => item.shard_id === shard.id
          && !capacityWarningMuted(item, auth.operatorId, mutedPairs)) };
    }) }, { headers });
  } catch {
    return NextResponse.json({ error: "COINOPS_CAPACITY_UNAVAILABLE" }, { status: 503, headers });
  }
}

export async function POST(request: NextRequest) {
  if (request.headers.get("origin") !== request.nextUrl.origin
    || request.headers.get("sec-fetch-site") === "cross-site"
    || request.headers.get("content-type")?.split(";")[0] !== "application/json"
    || request.headers.get("x-coinops-admin-intent") !== "capacity-warning-mute")
    return NextResponse.json({ error: "COINOPS_CAPACITY_ORIGIN_DENIED" }, { status: 403, headers });
  const auth = await adminOperatorId();
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status, headers });
  let input: { action?: unknown; shardId?: unknown };
  try { input = await request.json(); } catch {
    return NextResponse.json({ error: "COINOPS_CAPACITY_INPUT_INVALID" }, { status: 400, headers });
  }
  if (!/^(MUTE_WARNINGS|UNMUTE_WARNINGS)$/.test(String(input.action))
    || typeof input.shardId !== "string" || !/^executor-[0-9]{2,}$/.test(input.shardId))
    return NextResponse.json({ error: "COINOPS_CAPACITY_INPUT_INVALID" }, { status: 400, headers });
  try {
    const service = capacityScope();
    const shard = await service.from("executor_shards").select("id")
      .eq("id", input.shardId).maybeSingle();
    if (shard.error || !shard.data) throw new Error("COINOPS_CAPACITY_SHARD_INVALID");
    const result = input.action === "MUTE_WARNINGS"
      ? await service.from("executor_capacity_warning_mutes")
        .upsert({ operator_id: auth.operatorId, shard_id: input.shardId },
          { onConflict: "operator_id,shard_id", ignoreDuplicates: true })
      : await service.from("executor_capacity_warning_mutes")
        .delete().eq("operator_id", auth.operatorId).eq("shard_id", input.shardId);
    if (result.error) throw new Error("COINOPS_CAPACITY_MUTE_WRITE_FAILED");
    return NextResponse.json({ warningsMuted: input.action === "MUTE_WARNINGS" }, { headers });
  } catch {
    return NextResponse.json({ error: "COINOPS_CAPACITY_MUTE_UNAVAILABLE" }, { status: 503, headers });
  }
}
