import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

import { isIdentity } from "@/lib/execution/operator-context";
import { loadOperatorRegistry } from "@/lib/execution/operator-context-server";
import { formatStrategyParameterValue, isParameterCompatible, parseStrategyParameterValue,
  strategyParameterAffectsCurrentLadder,
  strategyParameter, STRATEGY_PARAMETERS, type StrategyParameterDefinition,
  type StrategyParameterKey } from "@/lib/execution/strategy-parameter-registry";
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
  engineIds?: string[]; parameterKey?: string; value?: string; valuesByAsset?: Record<string, string>;
  previewHash?: string; requestId?: string; rollbackOf?: string; batchId?: string };
type Profile = { id: string; trading_engine_id: string; config_version: number; gain_rate: number | string;
  normal_spacing_rate: number | string; post_ath_spacing_rate: number | string;
  regime: string; next_config_version: number | null };

async function adminScope(): Promise<Scope> {
  if (getSupabaseDataSchema() !== "coinops") throw new Error("COINOPS_BULK_SCHEMA_DENIED");
  const tenantId = getCoinOpsServiceTenantId(), client = createClient();
  const user = (await client.auth.getUser()).data.user;
  if (!user || !tenantId) throw new Error("COINOPS_BULK_AUTH_REQUIRED");
  if (user.app_metadata?.coinops_role === "VIEWER") throw new Error("COINOPS_BULK_ADMIN_DENIED");
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
  | "robot_v1_live_slots" | "robot_v1_live_orders" | "robot_v1_live_preparations",
  columns: string, field: string, ids: string[],
  statuses?: string[]) {
  const result: Record<string, unknown>[] = [];
  if (!ids.length) return result;
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

function valueFrom(definition: StrategyParameterDefinition, profile: Profile | undefined,
  preparation: Record<string, unknown> | undefined): number | null {
  if (definition.storage.table === "PREPARATION") return preparation ? Number(preparation.monthly_target) : null;
  if (!profile) return null;
  return Number(profile[definition.storage.column as "gain_rate" | "normal_spacing_rate" | "post_ath_spacing_rate"]);
}

async function rollbackTargets(scope: Scope, rollbackOf: string) {
  if (!isIdentity(rollbackOf)) throw new Error("COINOPS_BULK_ROLLBACK_INVALID");
  const batch = await scope.service.from("strategy_bulk_batches").select("id,status")
    .eq("id", rollbackOf).eq("operator_id", scope.operator.id).single();
  if (batch.error || !batch.data || !["APPLIED", "PARTIAL"].includes(batch.data.status))
    throw new Error("COINOPS_BULK_ROLLBACK_DENIED");
  const items: Array<{ trading_engine_id: string; parameter_key: string; old_values: Record<string, number>;
    new_values: Record<string, number>; strategy_version_after: number }> = [];
  for (let page = 0; ; page += 500) {
    const result = await scope.service.from("strategy_bulk_engine_updates")
      .select("trading_engine_id,parameter_key,old_values,new_values,strategy_version_after")
      .eq("batch_id", rollbackOf).eq("status", "APPLIED")
      .order("trading_engine_id").range(page, page + 499);
    if (result.error || !result.data) throw new Error("COINOPS_BULK_ROLLBACK_READ_FAILED");
    items.push(...result.data);
    if (result.data.length < 500) break;
  }
  if (!items.length) throw new Error("COINOPS_BULK_ROLLBACK_EMPTY");
  const keys = new Set(items.map((item) => item.parameter_key));
  if (keys.size !== 1) throw new Error("COINOPS_BULK_ROLLBACK_INVALID");
  const parameterKey = [...keys][0] as StrategyParameterKey;
  strategyParameter(parameterKey);
  return { parameterKey, targets: new Map(items.map((item) => [item.trading_engine_id, {
    target: Number(item.old_values?.[parameterKey]), expectedValue: Number(item.new_values?.[parameterKey]),
    expectedVersion: item.strategy_version_after,
  }])) };
}

function desiredValue(draft: Draft, definition: StrategyParameterDefinition, asset: string): number {
  if (draft.valuesByAsset) {
    const allowed = new Set<string>(definition.markets);
    if (Object.keys(draft.valuesByAsset).some((key) => !allowed.has(key)))
      throw new Error("COINOPS_BULK_MARKET_VALUE_INVALID");
    return parseStrategyParameterValue(definition, draft.valuesByAsset[asset]);
  }
  return parseStrategyParameterValue(definition, draft.value);
}

async function preview(scope: Scope, draft: Draft) {
  const rollback = draft.action.startsWith("rollback_");
  const rollbackPlan = rollback ? await rollbackTargets(scope, String(draft.rollbackOf ?? "")) : null;
  const definition = strategyParameter(rollbackPlan?.parameterKey ?? draft.parameterKey);
  const ids = rollback ? [...rollbackPlan!.targets.keys()] : draft.engineIds;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 5000
    || new Set(ids).size !== ids.length || ids.some((id) => !isIdentity(id)))
    throw new Error("COINOPS_BULK_SELECTION_INVALID");
  const registry = await loadOperatorRegistry(scope.service, scope.operator);
  const shardIds = [...new Set(registry.accounts.map((account) => account.executor_shard_id)
    .filter((id): id is string => !!id))];
  const samples = shardIds.length ? await scope.service.from("executor_capacity_samples")
    .select("shard_id,heartbeat_at").in("shard_id", shardIds) : { data: [], error: null };
  if (samples.error || !samples.data) throw new Error("COINOPS_BULK_EXECUTOR_HEALTH_UNAVAILABLE");
  const heartbeatByShard = new Map(samples.data.map((sample) => [sample.shard_id, Date.parse(sample.heartbeat_at)]));
  const engines = new Map(registry.engines.filter((engine) => engine.environment === "REAL")
    .map((engine) => [engine.id, engine]));
  if (ids.some((id) => !engines.has(id))) throw new Error("COINOPS_BULK_ENGINE_SCOPE_DENIED");
  const [profiles, runs, preparations] = await Promise.all([
    readPaged(scope.service, "robot_v1_ath_profiles",
      "id,trading_engine_id,config_version,gain_rate,normal_spacing_rate,post_ath_spacing_rate,regime,next_config_version",
      "trading_engine_id", ids),
    readPaged(scope.service, "robot_v1_live_runs",
      "id,trading_engine_id,status,last_error,lease_until,last_reconciled_at,entry_regime,config_version",
      "trading_engine_id", ids, ["ACTIVE", "PAUSED"]),
    readPaged(scope.service, "robot_v1_live_preparations", "id,trading_engine_id,monthly_target",
      "trading_engine_id", ids),
  ]);
  const runIds = runs.map((run) => String(run.id));
  const [slots, orders] = await Promise.all([
    readPaged(scope.service, "robot_v1_live_slots", "id,run_id,entry_state,position_quantity", "run_id", runIds),
    readPaged(scope.service, "robot_v1_live_orders",
      "id,run_id,side,status,exchange_order_id,executed_quantity", "run_id", runIds,
      ["PREPARED", "NEW", "PARTIALLY_FILLED"]),
  ]);
  const rows = ids.map((id) => {
    const engine = engines.get(id)!;
    const account = registry.accounts.find((item) => item.id === engine.exchange_account_id)!;
    const profile = profiles.find((item) => item.trading_engine_id === id) as Profile | undefined;
    const preparation = preparations.find((item) => item.trading_engine_id === id);
    const ownRuns = runs.filter((item) => item.trading_engine_id === id);
    const run = ownRuns.length === 1 ? ownRuns[0] : null;
    const ownSlots = slots.filter((item) => item.run_id === run?.id);
    const ownOrders = orders.filter((item) => item.run_id === run?.id);
    const rollbackTarget = rollbackPlan?.targets.get(id);
    const desired = rollbackTarget?.target ?? desiredValue(draft, definition, engine.base_asset);
    const current = valueFrom(definition, profile, preparation);
    const changeRequired = current !== null && Math.abs(current - desired) > 1e-10;
    const affectsResidentBuy = strategyParameterAffectsCurrentLadder(definition,
      run?.entry_regime as string | null | undefined);
    const partialBuys = ownOrders.filter((item) => item.side === "BUY" && item.status === "PARTIALLY_FILLED").length;
    const reasons = [account.status !== "ACTIVE" || account.kill_switch ? "ACCOUNT_GATE" : null,
      !account.executor_shard_id || !Number.isFinite(heartbeatByShard.get(account.executor_shard_id))
        || Date.now() - heartbeatByShard.get(account.executor_shard_id)! > 3 * 60_000 ? "EXECUTOR_STALE" : null,
      engine.status !== "ACTIVE" || engine.kill_switch ? "ENGINE_GATE" : null,
      engine.strategy_config_pending ? "CONFIG_UPDATE_PENDING" : null,
      !isParameterCompatible(definition, engine.base_asset) ? "PARAMETER_MARKET_INCOMPATIBLE" : null,
      !run || run.status !== "ACTIVE" ? "RUN_NOT_ACTIVE" : null,
      run?.last_error ? "RUN_ERROR" : null,
      !run?.last_reconciled_at || Date.now() - Date.parse(String(run.last_reconciled_at)) > 5 * 60_000
        ? "RECONCILIATION_STALE" : null,
      !profile ? "PROFILE_MISSING" : null,
      !preparation ? "PREPARATION_MISSING" : null,
      profile?.next_config_version != null ? "QUEUED_SINGLE_EDIT" : null,
      affectsResidentBuy && partialBuys ? "PARTIAL_BUY_REQUIRES_RECOVERY" : null,
      rollbackTarget && (profile?.config_version !== rollbackTarget.expectedVersion
        || current === null || Math.abs(current - rollbackTarget.expectedValue) > 1e-10) ? "ROLLBACK_DIVERGED" : null,
      !Number.isFinite(desired) ? "VALUE_INVALID" : null,
    ].filter((reason): reason is string => !!reason);
    const residentBuys = ownOrders.filter((item) => item.side === "BUY" && item.status !== "PREPARED").length;
    const preparedBuys = ownOrders.filter((item) => item.side === "BUY" && item.status === "PREPARED").length;
    return { engineId: id, accountId: account.id, account: account.display_name,
      symbol: engine.symbol, asset: engine.base_asset, runId: run?.id ?? null,
      profileId: profile?.id ?? null, versionBefore: profile?.config_version ?? null,
      currentValue: current, newValue: desired, currentDisplay: formatStrategyParameterValue(definition, current),
      newDisplay: formatStrategyParameterValue(definition, desired), changeRequired,
      regime: profile?.regime ?? null, openPositions: ownSlots.filter((item) => Number(item.position_quantity) > 0).length,
      activeTps: ownOrders.filter((item) => item.side === "SELL").length, residentBuys, preparedBuys,
      partialBuys, nextBuyReconciliations: affectsResidentBuy ? residentBuys + preparedBuys : 0, reasons };
  });
  const changedRows = rows.filter((row) => row.changeRequired);
  const marketSummary = definition.markets.flatMap((asset) => {
    const assetRows = rows.filter((row) => row.asset === asset);
    if (!assetRows.length) return [];
    const currentValues = [...new Set(assetRows.map((row) => row.currentDisplay))];
    const newValues = [...new Set(assetRows.map((row) => row.newDisplay))];
    return [{ asset, current: currentValues.length === 1 ? currentValues[0] : "Múltiplos valores atuais",
      next: newValues.length === 1 ? newValues[0] : "Múltiplos valores novos", engineCount: assetRows.length }];
  });
  const hash = createHash("sha256").update(JSON.stringify({ parameter: definition.key, rows })).digest("hex");
  return { status: "PREVIEW_NO_WRITE" as const, parameter: definition,
    accountCount: new Set(rows.map((row) => row.accountId)).size, engineCount: rows.length,
    changedEngineCount: changedRows.length, unchangedEngineCount: rows.length - changedRows.length,
    rows, marketSummary, previewHash: hash,
    nextBuyReconciliations: changedRows.reduce((sum, row) => sum + row.nextBuyReconciliations, 0),
    changed: `${definition.label} conforme ${definition.applyPolicy}. ${changedRows.length} motor(es) receberão nova versão.`,
    preserved: "Posições OPEN, fills, custos, histórico, slots e TP protetor existente.",
    canApply: changedRows.length > 0 && changedRows.every((row) => row.reasons.length === 0),
    rollbackOf: rollback ? draft.rollbackOf : null };
}

export async function GET(request: NextRequest) {
  try {
    const scope = await adminScope(), batchId = request.nextUrl.searchParams.get("batch");
    if (!batchId) {
      const recent = await scope.service.from("strategy_bulk_batches")
        .select("id,status,created_at,admission_cursor,selected_count,rollback_of,request_payload")
        .eq("operator_id", scope.operator.id).eq("created_by", scope.operator.user_id)
        .order("created_at", { ascending: false }).limit(20);
      if (recent.error || !recent.data) throw new Error("COINOPS_BULK_RECENT_UNAVAILABLE");
      const batches = recent.data.map((row) => ({ ...row,
        parameter_key: row.request_payload?.scope?.parameterKey ?? row.request_payload?.scope?.parameter ?? null }));
      return json({ parameterRegistry: STRATEGY_PARAMETERS, recentBatches: batches,
        activeBatches: batches.filter((row) => ["PENDING", "APPLYING", "PARTIAL", "BLOCKED_SAFE"].includes(row.status)),
        pendingAdmissions: batches.filter((row) => row.admission_cursor < row.selected_count) });
    }
    if (!isIdentity(batchId)) throw new Error("COINOPS_BULK_BATCH_INVALID");
    const batch = await scope.service.from("strategy_bulk_batches")
      .select("id,status,created_at,applied_at,rollback_of,admission_cursor,admission_failures,selected_count,request_payload")
      .eq("id", batchId).eq("operator_id", scope.operator.id).single();
    if (batch.error || !batch.data) throw new Error("COINOPS_BULK_BATCH_UNAVAILABLE");
    const items: Array<{ trading_engine_id: string; symbol: string; parameter_key: string; apply_policy: string;
      strategy_version_before: number; strategy_version_after: number; status: string;
      error_code: string | null; applied_at: string | null }> = [];
    for (let page = 0; ; page += 500) {
      const result = await scope.service.from("strategy_bulk_engine_updates")
        .select("trading_engine_id,symbol,parameter_key,apply_policy,strategy_version_before,strategy_version_after,status,error_code,applied_at")
        .eq("batch_id", batchId).eq("operator_id", scope.operator.id)
        .order("trading_engine_id").range(page, page + 499);
      if (result.error || !result.data) throw new Error("COINOPS_BULK_STATUS_UNAVAILABLE");
      items.push(...result.data);
      if (result.data.length < 500) break;
    }
    const selected = Number(batch.data.selected_count), admissionFailures = batch.data.admission_failures ?? {};
    return json({ batch: { id: batch.data.id, status: batch.data.status,
      created_at: batch.data.created_at, applied_at: batch.data.applied_at, rollback_of: batch.data.rollback_of,
      admission_cursor: batch.data.admission_cursor,
      parameter_key: batch.data.request_payload?.scope?.parameterKey ?? batch.data.request_payload?.scope?.parameter },
      engines: [...items, ...Object.entries(admissionFailures).map(([engineId, code]) => ({
        trading_engine_id: engineId, symbol: "—", parameter_key: "—", apply_policy: "—",
        strategy_version_before: 0, strategy_version_after: 0, status: "FAILED",
        error_code: String(code), applied_at: null }))],
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
    const scope = await adminScope(), draft = await request.json() as Draft;
    if (!draft || !["preview", "apply", "rollback_preview", "rollback_apply", "resume"].includes(draft.action)
      || Object.keys(draft).some((key) => !["action", "engineIds", "parameterKey", "value", "valuesByAsset",
        "previewHash", "requestId", "rollbackOf", "batchId"].includes(key)))
      throw new Error("COINOPS_BULK_INPUT_INVALID");
    if (draft.action === "resume") {
      if (!isIdentity(draft.batchId)) throw new Error("COINOPS_BULK_BATCH_INVALID");
      const prior = await scope.service.from("strategy_bulk_batches")
        .select("id,operator_id,created_by").eq("id", draft.batchId)
        .eq("operator_id", scope.operator.id).eq("created_by", scope.operator.user_id).single();
      if (prior.error || !prior.data) throw new Error("COINOPS_BULK_BATCH_UNAVAILABLE");
      const resumed = await scope.service.rpc("admit_strategy_bulk_next", {
        p_batch_id: prior.data.id, p_created_by: scope.operator.user_id });
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
    if (draft.action === "preview" || draft.action === "rollback_preview") return json(await preview(scope, draft));
    if (!existingBatchId) {
      const plan = await preview(scope, draft);
      if (!plan.canApply || draft.previewHash !== plan.previewHash || !isIdentity(draft.requestId))
        throw new Error("COINOPS_BULK_PREVIEW_CONFLICT");
      const changed = plan.rows.filter((row) => row.changeRequired);
      const items = changed.map((row) => ({ engine_id: row.engineId,
        expected_version: row.versionBefore, expected_run_id: row.runId,
        expected_profile_id: row.profileId, expected_regime: row.regime,
        expected_value: row.currentValue, new_value: row.newValue }));
      const saved = await scope.service.rpc("enqueue_strategy_bulk_update", {
        p_operator_id: scope.operator.id, p_created_by: scope.operator.user_id,
        p_idempotency_key: draft.requestId,
        p_scope: { engineIds: changed.map((row) => row.engineId), parameterKey: plan.parameter.key,
          applyPolicy: plan.parameter.applyPolicy, previewHash: plan.previewHash },
        p_engines: items, p_rollback_of: plan.rollbackOf });
      if (saved.error || !saved.data) throw new Error("COINOPS_BULK_ENQUEUE_FAILED");
      existingBatchId = saved.data;
    }
    const admitted = await scope.service.rpc("admit_strategy_bulk_next", {
      p_batch_id: existingBatchId, p_created_by: scope.operator.user_id });
    if (admitted.error || !admitted.data) throw new Error("COINOPS_BULK_ADMISSION_FAILED");
    return json({ status: "APPLYING", batchId: existingBatchId,
      selected: admitted.data.selected, admitted: admitted.data.admitted, failed: admitted.data.failed });
  } catch (error) {
    const code = error instanceof Error && /^COINOPS_[A-Z0-9_]+$/.test(error.message)
      ? error.message : "COINOPS_BULK_FAILED";
    return json({ error: code }, code.includes("AUTH") ? 401 : code.includes("PREVIEW_CONFLICT") ? 409 : 403);
  }
}
