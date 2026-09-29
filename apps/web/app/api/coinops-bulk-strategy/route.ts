import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

import { parseAthPercent } from "@/lib/execution/ath-regime";
import { isIdentity } from "@/lib/execution/operator-context";
import { loadOperatorRegistry } from "@/lib/execution/operator-context-server";
import { getCoinOpsServiceTenantId, getSupabaseDataSchema } from "@/lib/supabase/env";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const preferredRegion = "gru1";
export const maxDuration = 60;
const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
const json = (data: unknown, status = 200) => NextResponse.json(data, { status, headers });
type Service = ReturnType<typeof createServiceRoleClient>;
type Scope = { operator: { id: string; product_id: string; tenant_id: string; user_id: string };
  service: Service };
type Draft = { action: "preview" | "apply" | "rollback_preview" | "rollback_apply" | "resume";
  engineIds?: string[]; postAthPercent?: string; previewHash?: string;
  requestId?: string; rollbackOf?: string; batchId?: string };

async function adminScope(): Promise<Scope> {
  if (getSupabaseDataSchema() !== "coinops") throw new Error("COINOPS_BULK_SCHEMA_DENIED");
  const tenantId = getCoinOpsServiceTenantId();
  const client = createClient();
  const user = (await client.auth.getUser()).data.user;
  if (!user || !tenantId) throw new Error("COINOPS_BULK_AUTH_REQUIRED");
  if (user.app_metadata?.coinops_role === "VIEWER") throw new Error("COINOPS_BULK_ADMIN_DENIED");
  // Viewers have a separate binding; only an active owning operator can enter.
  const op = await client.from("operators").select("id,product_id,tenant_id,user_id,kill_switch")
    .eq("tenant_id", tenantId).eq("user_id", user.id).eq("status", "ACTIVE").single();
  if (op.error || !op.data || op.data.kill_switch) throw new Error("COINOPS_BULK_ADMIN_DENIED");
  return { operator: op.data, service: createServiceRoleClient() };
}

function sameOrigin(request: NextRequest) {
  if (process.env.VERCEL_ENV !== "production" || request.nextUrl.hostname !== "cripto-flax.vercel.app"
    || request.headers.get("origin") !== request.nextUrl.origin
    || request.headers.get("sec-fetch-site") === "cross-site"
    || request.headers.get("content-type")?.split(";")[0] !== "application/json"
    || request.headers.get("x-coinops-admin-intent") !== "bulk-strategy")
    throw new Error("COINOPS_BULK_ORIGIN_DENIED");
}

async function readPaged(service: Service, table: "robot_v1_ath_profiles" | "robot_v1_live_runs"
  | "robot_v1_live_slots" | "robot_v1_live_orders", columns: string, field: string, ids: string[],
  statuses?: string[]) {
  const result: Record<string, unknown>[] = [];
  for (let offset = 0; offset < ids.length; offset += 80) {
    const chunk = ids.slice(offset, offset + 80);
    for (let page = 0; ; page += 500) {
      let query = service.from(table).select(columns).in(field, chunk).order("id").range(page, page + 499);
      if (statuses) query = query.in("status", statuses);
      const response = await query;
      if (response.error || !response.data) throw new Error("COINOPS_BULK_PREVIEW_READ_FAILED");
      result.push(...response.data as unknown as Record<string, unknown>[]);
      if (response.data.length < 500) break;
    }
  }
  return result;
}

async function rollbackTargets(scope: Scope, rollbackOf: string) {
  if (!isIdentity(rollbackOf)) throw new Error("COINOPS_BULK_ROLLBACK_INVALID");
  const batch = await scope.service.from("strategy_bulk_batches").select("id,status")
    .eq("id", rollbackOf).eq("operator_id", scope.operator.id).single();
  if (batch.error || !batch.data || !["APPLIED", "PARTIAL"].includes(batch.data.status))
    throw new Error("COINOPS_BULK_ROLLBACK_DENIED");
  const items: Array<{ trading_engine_id: string; old_values: { post_ath_spacing_rate: number };
    new_values: { post_ath_spacing_rate: number }; strategy_version_after: number }> = [];
  for (let page = 0; ; page += 500) {
    const result = await scope.service.from("strategy_bulk_engine_updates")
      .select("trading_engine_id,old_values,new_values,strategy_version_after")
      .eq("batch_id", rollbackOf).eq("status", "APPLIED")
      .order("trading_engine_id").range(page, page + 499);
    if (result.error || !result.data) throw new Error("COINOPS_BULK_ROLLBACK_READ_FAILED");
    items.push(...result.data);
    if (result.data.length < 500) break;
  }
  if (!items.length) throw new Error("COINOPS_BULK_ROLLBACK_EMPTY");
  return new Map(items.map((item) => [item.trading_engine_id, {
    target: Number(item.old_values?.post_ath_spacing_rate),
    expectedRate: Number(item.new_values?.post_ath_spacing_rate),
    expectedVersion: item.strategy_version_after,
  }]));
}

async function preview(scope: Scope, draft: Draft) {
  const rollback = draft.action.startsWith("rollback_");
  const targetRates = rollback ? await rollbackTargets(scope, String(draft.rollbackOf ?? "")) : null;
  const rate = rollback ? null : parseAthPercent(String(draft.postAthPercent ?? ""));
  const ids = rollback ? [...targetRates!.keys()] : draft.engineIds;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 5000
    || new Set(ids).size !== ids.length || ids.some((id) => !isIdentity(id)))
    throw new Error("COINOPS_BULK_SELECTION_INVALID");
  const registry = await loadOperatorRegistry(scope.service, scope.operator);
  const shardIds = [...new Set(registry.accounts.map((account) => account.executor_shard_id)
    .filter((id): id is string => !!id))];
  const samples = shardIds.length ? await scope.service.from("executor_capacity_samples")
    .select("shard_id,heartbeat_at").in("shard_id", shardIds) : { data: [], error: null };
  if (samples.error || !samples.data) throw new Error("COINOPS_BULK_EXECUTOR_HEALTH_UNAVAILABLE");
  const heartbeatByShard = new Map(samples.data.map((sample) => [sample.shard_id,
    Date.parse(sample.heartbeat_at)]));
  const engines = new Map(registry.engines.filter((engine) => engine.environment === "REAL")
    .map((engine) => [engine.id, engine]));
  if (ids.some((id) => !engines.has(id))) throw new Error("COINOPS_BULK_ENGINE_SCOPE_DENIED");
  const [profiles, runs] = await Promise.all([
    readPaged(scope.service, "robot_v1_ath_profiles",
      "id,trading_engine_id,config_version,post_ath_spacing_rate,regime,next_config_version", "trading_engine_id", ids),
    readPaged(scope.service, "robot_v1_live_runs",
      "id,trading_engine_id,status,last_error,lease_until,last_reconciled_at,entry_regime,config_version",
      "trading_engine_id", ids, ["ACTIVE", "PAUSED"]),
  ]);
  const runIds = runs.map((run) => String(run.id));
  const [slots, orders] = await Promise.all([
    readPaged(scope.service, "robot_v1_live_slots", "id,run_id,entry_state,position_quantity",
      "run_id", runIds),
    readPaged(scope.service, "robot_v1_live_orders",
      "id,run_id,side,status,exchange_order_id,executed_quantity",
      "run_id", runIds, ["PREPARED", "NEW", "PARTIALLY_FILLED"]),
  ]);
  const rows = ids.map((id) => {
    const engine = engines.get(id)!;
    const account = registry.accounts.find((item) => item.id === engine.exchange_account_id)!;
    const profile = profiles.find((item) => item.trading_engine_id === id);
    const ownRuns = runs.filter((item) => item.trading_engine_id === id);
    const run = ownRuns.length === 1 ? ownRuns[0] : null;
    const ownSlots = slots.filter((item) => item.run_id === run?.id);
    const ownOrders = orders.filter((item) => item.run_id === run?.id);
    const rollbackTarget = targetRates?.get(id);
    const desired = rollbackTarget?.target ?? rate!;
    const reasons = [account.status !== "ACTIVE" || account.kill_switch ? "ACCOUNT_GATE" : null,
      !account.executor_shard_id || !Number.isFinite(heartbeatByShard.get(account.executor_shard_id))
        || Date.now() - heartbeatByShard.get(account.executor_shard_id)! > 3 * 60_000
        ? "EXECUTOR_STALE" : null,
      engine.status !== "ACTIVE" || engine.kill_switch ? "ENGINE_GATE" : null,
      engine.strategy_config_pending ? "CONFIG_UPDATE_PENDING" : null,
      !run || run.status !== "ACTIVE" ? "RUN_NOT_ACTIVE" : null,
      run?.last_error ? "RUN_ERROR" : null,
      !run?.last_reconciled_at || Date.now() - Date.parse(String(run.last_reconciled_at)) > 5 * 60_000
        ? "RECONCILIATION_STALE" : null,
      !profile ? "PROFILE_MISSING" : null,
      profile?.next_config_version != null ? "QUEUED_SINGLE_EDIT" : null,
      profile && Number(profile.post_ath_spacing_rate) === desired ? "UNCHANGED" : null,
      rollbackTarget && profile && (profile.config_version !== rollbackTarget.expectedVersion
        || Number(profile.post_ath_spacing_rate) !== rollbackTarget.expectedRate)
        ? "ROLLBACK_DIVERGED" : null,
      !Number.isFinite(desired) || desired < 0.001 || desired > 0.2 ? "RATE_INVALID" : null,
    ].filter((reason): reason is string => !!reason);
    return { engineId: id, accountId: account.id, account: account.display_name,
      symbol: engine.symbol, asset: engine.base_asset, runId: run?.id ?? null,
      profileId: profile?.id ?? null, versionBefore: profile?.config_version ?? null,
      oldRate: profile ? Number(profile.post_ath_spacing_rate) : null, newRate: desired,
      regime: profile?.regime ?? null, openPositions: ownSlots.filter((item) => Number(item.position_quantity) > 0).length,
      activeTps: ownOrders.filter((item) => item.side === "SELL").length,
      residentBuys: ownOrders.filter((item) => item.side === "BUY" && item.status !== "PREPARED").length,
      preparedBuys: ownOrders.filter((item) => item.side === "BUY" && item.status === "PREPARED").length,
      partialBuys: ownOrders.filter((item) => item.side === "BUY" && item.status === "PARTIALLY_FILLED").length,
      reasons };
  });
  const hash = createHash("sha256").update(JSON.stringify(rows)).digest("hex");
  return { status: "PREVIEW_NO_WRITE" as const, parameter: "post_ath_spacing_rate",
    accountCount: new Set(rows.map((row) => row.accountId)).size,
    engineCount: rows.length, rows, previewHash: hash,
    changed: "Spacing pós-ATH para decisões futuras; BUY incompatível somente após reconciliação sob lease.",
    preserved: "Posições OPEN, fills, custo, slots, histórico e TP protetor existente.",
    canApply: rows.every((row) => row.reasons.length === 0), rollbackOf: rollback ? draft.rollbackOf : null };
}

export async function GET(request: NextRequest) {
  try {
    const scope = await adminScope();
    const batchId = request.nextUrl.searchParams.get("batch");
    if (!batchId) {
      const recent = await scope.service.from("strategy_bulk_batches")
        .select("id,status,created_at,admission_cursor,selected_count,rollback_of")
        .eq("operator_id", scope.operator.id).eq("created_by", scope.operator.user_id)
        .order("created_at", { ascending: false }).limit(20);
      if (recent.error || !recent.data) throw new Error("COINOPS_BULK_RECENT_UNAVAILABLE");
      return json({ recentBatches: recent.data,
        activeBatches: recent.data.filter((row) => ["PENDING", "APPLYING", "PARTIAL", "BLOCKED_SAFE"].includes(row.status)),
        pendingAdmissions: recent.data.filter((row) => row.admission_cursor < row.selected_count) });
    }
    if (!isIdentity(batchId)) throw new Error("COINOPS_BULK_BATCH_INVALID");
    const batch = await scope.service.from("strategy_bulk_batches")
      .select("id,status,created_at,applied_at,rollback_of,admission_cursor,admission_failures,selected_count")
      .eq("id", batchId).eq("operator_id", scope.operator.id).single();
    if (batch.error || !batch.data) throw new Error("COINOPS_BULK_BATCH_UNAVAILABLE");
    const items: Array<{ trading_engine_id: string; symbol: string; strategy_version_before: number;
      strategy_version_after: number; status: string; error_code: string | null; applied_at: string | null }> = [];
    for (let page = 0; ; page += 500) {
      const result = await scope.service.from("strategy_bulk_engine_updates")
        .select("trading_engine_id,symbol,strategy_version_before,strategy_version_after,status,error_code,applied_at")
        .eq("batch_id", batchId).eq("operator_id", scope.operator.id)
        .order("trading_engine_id").range(page, page + 499);
      if (result.error || !result.data) throw new Error("COINOPS_BULK_STATUS_UNAVAILABLE");
      items.push(...result.data);
      if (result.data.length < 500) break;
    }
    const selected = Number(batch.data.selected_count);
    const admissionFailures = batch.data.admission_failures ?? {};
    return json({ batch: { id: batch.data.id, status: batch.data.status,
      created_at: batch.data.created_at, applied_at: batch.data.applied_at,
      rollback_of: batch.data.rollback_of, admission_cursor: batch.data.admission_cursor },
      engines: [...items, ...Object.entries(admissionFailures).map(([engineId, code]) => ({
        trading_engine_id: engineId, symbol: "—", strategy_version_before: 0,
        strategy_version_after: 0, status: "FAILED", error_code: String(code), applied_at: null }))],
      counts: { selected, applied: items.filter((item) => item.status === "APPLIED").length,
        pending: selected - items.filter((item) => item.status === "APPLIED" || item.status === "BLOCKED_SAFE").length
          - Object.keys(admissionFailures).length,
        blocked: items.filter((item) => item.status === "BLOCKED_SAFE").length,
        failed: Object.keys(admissionFailures).length } });
  } catch (error) {
    const code = error instanceof Error && /^COINOPS_[A-Z0-9_]+$/.test(error.message)
      ? error.message : "COINOPS_BULK_STATUS_FAILED";
    return json({ error: code }, code.includes("AUTH") ? 401 : 403);
  }
}

export async function POST(request: NextRequest) {
  try {
    sameOrigin(request);
    const scope = await adminScope();
    const draft = await request.json() as Draft;
    if (!draft || !["preview", "apply", "rollback_preview", "rollback_apply", "resume"].includes(draft.action)
      || Object.keys(draft).some((key) => !["action", "engineIds", "postAthPercent", "previewHash", "requestId", "rollbackOf", "batchId"].includes(key)))
      throw new Error("COINOPS_BULK_INPUT_INVALID");
    if (draft.action === "resume") {
      if (!isIdentity(draft.batchId)) throw new Error("COINOPS_BULK_BATCH_INVALID");
      const prior = await scope.service.from("strategy_bulk_batches")
        .select("id,operator_id,created_by").eq("id", draft.batchId)
        .eq("operator_id", scope.operator.id).eq("created_by", scope.operator.user_id).single();
      if (prior.error || !prior.data) throw new Error("COINOPS_BULK_BATCH_UNAVAILABLE");
      const resumed = await scope.service.rpc("admit_strategy_bulk_next", {
        p_batch_id: prior.data.id, p_created_by: scope.operator.user_id,
      });
      if (resumed.error || !resumed.data) throw new Error("COINOPS_BULK_ADMISSION_FAILED");
      return json({ status: "APPLYING", batchId: prior.data.id,
        selected: resumed.data.selected, admitted: resumed.data.admitted, failed: resumed.data.failed });
    }
    let existingBatchId: string | null = null;
    if (draft.action === "apply" || draft.action === "rollback_apply") {
      if (!isIdentity(draft.requestId)) throw new Error("COINOPS_BULK_REQUEST_ID_INVALID");
      const prior = await scope.service.from("strategy_bulk_batches")
        .select("id,request_payload,status").eq("operator_id", scope.operator.id)
        .eq("idempotency_key", draft.requestId).maybeSingle();
      if (prior.error) throw new Error("COINOPS_BULK_REPLAY_READ_FAILED");
      if (prior.data) {
        const savedScope = prior.data.request_payload?.scope;
        if (savedScope?.previewHash !== draft.previewHash
          || (prior.data.request_payload?.rollback_of ?? null) !== (draft.rollbackOf ?? null))
          throw new Error("COINOPS_BULK_IDEMPOTENCY_CONFLICT");
        existingBatchId = prior.data.id;
      }
    }
    if (draft.action === "preview" || draft.action === "rollback_preview")
      return json(await preview(scope, draft));
    if (!existingBatchId) {
      const plan = await preview(scope, draft);
      if (!plan.canApply || draft.previewHash !== plan.previewHash || !isIdentity(draft.requestId))
        throw new Error("COINOPS_BULK_PREVIEW_CONFLICT");
      const items = plan.rows.map((row) => ({ engine_id: row.engineId,
        expected_version: row.versionBefore, expected_run_id: row.runId,
        expected_profile_id: row.profileId, expected_regime: row.regime,
        expected_post_ath_spacing_rate: row.oldRate,
        new_post_ath_spacing_rate: row.newRate }));
      const saved = await scope.service.rpc("enqueue_strategy_bulk_post_ath", {
        p_operator_id: scope.operator.id, p_created_by: scope.operator.user_id,
        p_idempotency_key: draft.requestId,
        p_scope: { engineIds: plan.rows.map((row) => row.engineId), parameter: plan.parameter,
          previewHash: plan.previewHash }, p_engines: items, p_rollback_of: plan.rollbackOf,
      });
      if (saved.error || !saved.data) throw new Error("COINOPS_BULK_ENQUEUE_FAILED");
      existingBatchId = saved.data;
    }
    const admitted = await scope.service.rpc("admit_strategy_bulk_next", {
      p_batch_id: existingBatchId, p_created_by: scope.operator.user_id,
    });
    if (admitted.error || !admitted.data) throw new Error("COINOPS_BULK_ADMISSION_FAILED");
    return json({ status: "APPLYING", batchId: existingBatchId,
      selected: admitted.data.selected, admitted: admitted.data.admitted,
      failed: admitted.data.failed });
  } catch (error) {
    const code = error instanceof Error && /^COINOPS_[A-Z0-9_]+$/.test(error.message)
      ? error.message : "COINOPS_BULK_FAILED";
    return json({ error: code }, code.includes("AUTH") ? 401 : code.includes("PREVIEW_CONFLICT") ? 409 : 403);
  }
}
