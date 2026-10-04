import { randomUUID } from "node:crypto";
import { assertOperationalEnvironment } from "@/lib/execution/testnet-policy";
import { NextRequest, NextResponse } from "next/server";

import { syncInactiveBinanceAccount } from "@/lib/execution/binance-account-registry-server";
import { requireAccountIdentityBinding } from "@/lib/execution/binance-identity-server";
import { BinanceSpotTestnetAdapter } from "@/lib/execution/binance-spot-testnet-adapter";
import { loadLiveEngineExecutorStatus } from "@/lib/execution/live-executor-health";
import { buildLiveSizing, parseLiveRules } from "@/lib/execution/live-preparation";
import { operatorAccountSnapshot, operatorExecutorAdmin } from "@/lib/execution/operator-executor-admin";
import { validateEnginePlan, type EnginePlanInput } from "@/lib/execution/operator-engine-plan";
import { resolveOperatorEngine } from "@/lib/execution/operator-context-server";
import { pauseLiveRun, prepareLiveCycle, resumeLiveRun } from "@/lib/execution/robot-v1-live-server";
import { pauseTestnetRun, resumeTestnetRun, startTestnetRun } from "@/lib/execution/robot-v1-testnet-server";
import { getCoinOpsServiceTenantId, getSupabaseDataSchema } from "@/lib/supabase/env";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { createClient } from "@/lib/supabase/server";
import { previewAccountCapacity, reserveEngineCapacity } from "@/lib/coinops-capacity/capacity-server";
import { engineCatalogAccount } from "@/lib/execution/engine-account-catalog";
import { activationAdmissionFromEvidence } from "@/lib/coinops-capacity/activation-admission-view";
import { loadEngineAdmissionOptions } from "@/lib/execution/engine-admission-router-server";
import { allocatedCapital, previewEngineAppend, provisionEngineAppend, type AppendPlanInput } from "@/lib/execution/engine-append-server";
import { allocationSnapshotFingerprint } from "@/lib/execution/engine-append-exposure";
import { resolveExecutorForConnection } from "@/lib/execution/executor-shards-server";
import { collectAccountOrderBudget, previewAccountOrderBudget } from "@/lib/execution/account-order-budget-server";
import { completeLedgerRead } from "@/lib/execution/complete-ledger-read";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const preferredRegion = "gru1";
export const maxDuration = 60;

const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
const json = (data: unknown, status = 200) => NextResponse.json(data, { status, headers });
type Service = ReturnType<typeof createServiceRoleClient>;
type Scope = { operator: { id: string; product_id: string; tenant_id: string; user_id: string };
  service: Service };
type Environment = "REAL" | "TESTNET";
async function paged<T extends { id: string }>(page: Parameters<typeof completeLedgerRead<T>>[0]) {
  return { data: await completeLedgerRead(page, "COINOPS_ENGINE_STATUS_UNAVAILABLE"), error: null };
}
async function runRows<T extends { id: string }>(ids: string[], page: (ids: string[], start: number, end: number) => ReturnType<Parameters<typeof completeLedgerRead<T>>[0]>) {
  const data: T[] = [];
  for (let offset = 0; offset < ids.length; offset += 200) {
    const group = ids.slice(offset, offset + 200);
    data.push(...await completeLedgerRead((start, end) => page(group, start, end), "COINOPS_ENGINE_STATUS_UNAVAILABLE"));
  }
  if (new Set(data.map((row) => row.id)).size !== data.length) throw new Error("COINOPS_ENGINE_STATUS_UNAVAILABLE");
  return { data, error: null };
}

async function adminScope(): Promise<Scope> {
  if (getSupabaseDataSchema() !== "coinops") throw new Error("COINOPS_ENGINE_SCHEMA_DENIED");
  const tenantId = getCoinOpsServiceTenantId();
  const db = createClient();
  const user = (await db.auth.getUser()).data.user;
  if (!user || !tenantId) throw new Error("COINOPS_ENGINE_AUTH_REQUIRED");
  const op = await db.from("operators").select("id,product_id,tenant_id,user_id,kill_switch")
    .eq("tenant_id", tenantId).eq("user_id", user.id).eq("status", "ACTIVE").single();
  if (op.error || !op.data || op.data.kill_switch)
    throw new Error("COINOPS_ENGINE_OPERATOR_DENIED");
  return { operator: op.data, service: createServiceRoleClient() };
}

function sameOrigin(request: NextRequest) {
  if (process.env.VERCEL_ENV !== "production"
    || request.nextUrl.hostname !== "cripto-flax.vercel.app"
    || request.headers.get("origin") !== request.nextUrl.origin
    || request.headers.get("sec-fetch-site") === "cross-site"
    || request.headers.get("content-type")?.split(";")[0] !== "application/json"
    || request.headers.get("x-coinops-admin-intent") !== "engine-control")
    throw new Error("COINOPS_ENGINE_ORIGIN_DENIED");
}

async function ownedAccount(scope: Scope, accountId: string) {
  const result = await scope.service.from("exchange_accounts")
    .select("id,operator_id,display_name,status,kill_switch,is_legacy_default,credential_ref")
    .eq("id", accountId).eq("operator_id", scope.operator.id).single();
  if (result.error || !result.data || result.data.is_legacy_default)
    throw new Error("COINOPS_ENGINE_ACCOUNT_DENIED");
  return result.data;
}

async function accountEnvironment(scope: Scope, accountId: string): Promise<Environment> {
  const account = await scope.service.from("exchange_accounts")
    .select("is_legacy_default,onboarding_environment,executor_shard_id")
    .eq("operator_id", scope.operator.id)
    .eq("id", accountId).single();
  if (account.error || !account.data) throw new Error("COINOPS_ENGINE_ACCOUNT_DENIED");
  // Rafael predates self-service credential checks. His account identity is
  // still resolved server-side; this exception never applies to new accounts.
  if (account.data.is_legacy_default) return "REAL";
  const check = await scope.service.from("account_onboarding_checks")
    .select("status,evidence").eq("operator_id", scope.operator.id)
    .eq("exchange_account_id", accountId).eq("check_key", "BINANCE_CREDENTIAL")
    .order("checked_at", { ascending: false }).limit(1).maybeSingle();
  const environment = check.data?.evidence?.environment;
  if (check.error || check.data?.status !== "PASS" || check.data?.evidence?.status !== "PASS"
    || !["REAL", "TESTNET"].includes(environment)
    || !account.data.executor_shard_id
    || account.data.onboarding_environment && account.data.onboarding_environment !== environment)
    throw new Error("COINOPS_ENGINE_CREDENTIAL_NOT_VALIDATED");
  assertOperationalEnvironment(environment);
  return environment as Environment;
}

async function planPreview(scope: Scope, input: EnginePlanInput) {
  const plan = validateEnginePlan(input);
  const account = await ownedAccount(scope, plan.accountId);
  const environment = await accountEnvironment(scope, plan.accountId);
  if (environment === "TESTNET" ? plan.quote === "BRL" : plan.quote === "USDC")
    throw new Error("COINOPS_ENGINE_MARKET_DENIED");
  if (account.status !== "INACTIVE" || !account.kill_switch)
    throw new Error("COINOPS_ENGINE_ACCOUNT_NOT_INACTIVE");
  const existing = await scope.service.from("trading_engines").select("id")
    .eq("exchange_account_id", plan.accountId).limit(1);
  if (existing.error || existing.data?.length)
    throw new Error("COINOPS_ENGINE_ALREADY_CONFIGURED");
  const snapshot = await operatorAccountSnapshot(scope.operator.id, plan.accountId, plan.quote,
    plan.engines.map((engine) => engine.symbol), account.credential_ref, environment);
  const free = snapshot.balances.find((item) => item.asset === plan.quote)?.free;
  if (free === undefined || free + 1e-8 < plan.capital)
    throw new Error("COINOPS_ENGINE_BALANCE_INSUFFICIENT");
  const engines = plan.engines.map((engine) => {
    const market = snapshot.markets.find((item) => item.symbol === engine.symbol)!;
    if (market.open_orders.length) throw new Error("COINOPS_ENGINE_EXISTING_MARKET_ORDERS");
    const sizing = buildLiveSizing(parseLiveRules(market.rules), market.price, {
      asset: engine.asset, symbol: engine.symbol, quote_asset: plan.quote,
      slot_count: 25, gain_rate: engine.gain, normal_spacing_rate: engine.spacing,
      post_ath_spacing_rate: engine.postAth, regime: "NORMAL", monthly_target: engine.monthlyTarget,
      configured_live_capital_brl: engine.capital,
      max_order_notional_brl: engine.capital, max_total_exposure_brl: engine.capital,
      config_version: 1, live_enabled: false, updated_at: snapshot.observed_at,
    }, plan.capital, market.observed_at, Date.now(), {
      engineCap: engine.capital, orderCap: engine.capital,
      accountCap: plan.capital, quoteAsset: plan.quote,
    });
    return { symbol: engine.symbol, asset: engine.asset, capital: engine.capital,
      allocation: engine.allocation, gain: engine.gain, spacing: engine.spacing,
      postAth: engine.postAth, monthlyTarget: engine.monthlyTarget,
      currentPrice: market.price, minNotional: sizing.rules.minNotional,
      minQuantity: sizing.rules.minQuantity, quantityStep: sizing.rules.quantityStep,
      priceTick: sizing.rules.priceTick, recommendedPerSlot: sizing.recommendedSlotBrl,
      minimumCapital: sizing.minimumCapitalBrl, validSlots: sizing.validSlots,
      firstEntry: sizing.slots.find((slot) => slot.operationalRank === 1)?.entryPriceBrl,
      firstTp: sizing.slots.find((slot) => slot.operationalRank === 1)?.tpPriceBrl,
      nextBuy: sizing.slots.find((slot) => slot.operationalRank === 2)?.entryPriceBrl,
      planned: sizing.dryRun.planned, strategyVersion: sizing.dryRun.strategyVersion };
  });
  // Testnet also consumes this shard's resources. Never manufacture an OK when
  // telemetry is unavailable merely because its exchange funds are fictitious.
  const capacity = await previewAccountCapacity(scope.service, plan.accountId, plan.engines.length, environment);
  return { account: account.display_name, accountId: account.id, environment, quote: plan.quote,
    capital: plan.capital, free, outsideCoinOps: Number((free - plan.capital).toFixed(2)),
    observedAt: snapshot.observed_at, executorIp: snapshot.executor_ip,
    capacity, engines, status: engines.every((item) => item.validSlots === 25)
      ? "PREVIEW_NO_WRITE" as const : "NOT_EXECUTABLE" as const };
}

export async function GET(request: NextRequest) {
  try {
    const { operator, service } = await adminScope();
    // PostgREST limits rows per request. Page the admin catalog instead of
    // silently hiding the 1,001st account or tying it to executor-01.
    const accountRows = [];
    for (let offset = 0; ; offset += 500) {
      const page = await service.from("exchange_accounts")
        .select("id,display_name,status,kill_switch,is_legacy_default,onboarding_environment,executor_shard_id")
        .eq("operator_id", operator.id).in("status", ["ACTIVE", "INACTIVE"])
        .order("created_at").order("id").range(offset, offset + 499);
      if (page.error) throw new Error("COINOPS_ENGINE_STATUS_UNAVAILABLE");
      accountRows.push(...(page.data ?? []));
      if ((page.data?.length ?? 0) < 500) break;
    }
    const accountId = request.nextUrl.searchParams.get("accountId") ?? "";
    if (accountId && !accountRows.some((item) => item.id === accountId))
      throw new Error("COINOPS_ENGINE_ACCOUNT_DENIED");
    // Historical accounts predate persisted environment assignment. Resolve
    // only those records (plus the selected account) from their latest check.
    // All newly assigned accounts use onboarding_environment directly.
    const checkIds = [...new Set(accountRows.filter((item) =>
      !item.onboarding_environment || item.id === accountId).map((item) => item.id))];
    const checkResults = await Promise.all(checkIds.map(async (id) => ({ id,
      result: await service.from("account_onboarding_checks")
        .select("status,evidence").eq("operator_id", operator.id)
        .eq("exchange_account_id", id).eq("check_key", "BINANCE_CREDENTIAL")
        .order("checked_at", { ascending: false }).limit(1).maybeSingle(),
    })));
    if (checkResults.some((item) => item.result.error))
      throw new Error("COINOPS_ENGINE_STATUS_UNAVAILABLE");
    const checkByAccount = new Map(checkResults.map((item) => [item.id, item.result.data]));
    const accounts = accountRows.map((item) => engineCatalogAccount(item,
      checkByAccount.get(item.id) ?? null));
    if (!accountId) return json({ accounts, engines: [], caps: [] });
    const [engines, caps, runs, testnetRuns, profiles, readyChecks, preparations, alerts] = await Promise.all([
      paged((start, end) => service.from("trading_engines")
        .select("id,exchange_account_id,environment,symbol,quote_asset,status,kill_switch,hard_cap_quote,config,executor_shard_id,created_at")
        .eq("operator_id", operator.id).eq("exchange_account_id", accountId)
        .eq("environment", "REAL").order("id").range(start, end)),
      service.from("account_quote_caps").select("exchange_account_id,quote_asset,hard_cap_quote")
        .eq("operator_id", operator.id).eq("exchange_account_id", accountId),
      paged((start, end) => service.from("robot_v1_live_runs")
        .select("id,trading_engine_id,status,last_error,last_reconciled_at,created_at")
        .eq("operator_id", operator.id).eq("exchange_account_id", accountId)
        .in("status", ["PREPARING", "ACTIVE", "PAUSED"]).order("id").range(start, end)),
      paged((start, end) => service.from("robot_v1_testnet_runs")
        .select("id,trading_engine_id,status,last_error,last_reconciled_at,created_at")
        .eq("operator_id", operator.id).eq("exchange_account_id", accountId)
        .in("status", ["ACTIVE", "PAUSED"]).order("id").range(start, end)),
      paged((start, end) => service.from("robot_v1_ath_profiles")
        .select("id,trading_engine_id,gain_rate,normal_spacing_rate,post_ath_spacing_rate,config_version")
        .eq("operator_id", operator.id).eq("exchange_account_id", accountId)
        .in("environment", ["REAL", "TESTNET"]).order("id").range(start, end)),
      service.from("account_onboarding_checks")
        .select("trading_engine_id,status,checked_at")
        .eq("operator_id", operator.id).eq("exchange_account_id", accountId)
        .eq("check_key", "TESTNET_READY")
        .order("checked_at", { ascending: false }).limit(100),
      paged((start, end) => service.from("robot_v1_live_preparations")
        .select("id,trading_engine_id,live_enabled,kill_switch")
        .eq("operator_id", operator.id).eq("exchange_account_id", accountId).order("id").range(start, end)),
      paged((start, end) => service.from("robot_v1_live_alerts").select("id,trading_engine_id")
        .eq("operator_id", operator.id).eq("exchange_account_id", accountId)
        .is("resolved_at", null).order("id").range(start, end)),
    ]);
    if ([engines, caps, runs, testnetRuns, profiles, readyChecks, preparations, alerts].some((item) => item.error))
      throw new Error("COINOPS_ENGINE_STATUS_UNAVAILABLE");
    const runIds = (runs.data ?? []).map((run) => run.id);
    const testnetRunIds = (testnetRuns.data ?? []).map((run) => run.id);
    const [slots, orders] = runIds.length ? await Promise.all([
      runRows(runIds, (ids, start, end) => service.from("robot_v1_live_slots").select("id,run_id,trading_engine_id,entry_state")
        .eq("operator_id", operator.id).eq("exchange_account_id", accountId).in("run_id", ids).order("id").range(start, end)),
      runRows(runIds, (ids, start, end) => service.from("robot_v1_live_orders").select("id,run_id,trading_engine_id,side,status")
        .eq("operator_id", operator.id).eq("exchange_account_id", accountId).in("run_id", ids).in("status", ["NEW", "PARTIALLY_FILLED"]).order("id").range(start, end)),
    ]) : [{ data: [], error: null }, { data: [], error: null }];
    const [testnetSlots, testnetOrders] = testnetRunIds.length ? await Promise.all([
      runRows(testnetRunIds, (ids, start, end) => service.from("robot_v1_testnet_slots").select("id,run_id,trading_engine_id,entry_state")
        .eq("operator_id", operator.id).eq("exchange_account_id", accountId).in("run_id", ids).order("id").range(start, end)),
      runRows(testnetRunIds, (ids, start, end) => service.from("robot_v1_testnet_orders").select("id,run_id,trading_engine_id,side,status")
        .eq("operator_id", operator.id).eq("exchange_account_id", accountId).in("run_id", ids).in("status", ["NEW", "PARTIALLY_FILLED"]).order("id").range(start, end)),
    ]) : [{ data: [], error: null }, { data: [], error: null }];
    if (slots.error || orders.error || testnetSlots.error || testnetOrders.error)
      throw new Error("COINOPS_ENGINE_STATUS_UNAVAILABLE");
    // Per-engine persisted capacity only. No Binance collection or hysteresis
    // clock mutation on GET; account bootstrap is not routing authority.
    const engineAdmissions = new Map(await Promise.all((engines.data ?? []).filter((engine) => engine.environment === "REAL"
      && (runs.data ?? []).some((run) => run.trading_engine_id === engine.id && run.status === "PREPARING"))
      .map(async (engine) => {
        const read = engine.executor_shard_id ? await service.rpc("preview_executor_admission", {
          p_shard_id: engine.executor_shard_id, p_environment: "REAL", p_engines: 1, p_exclude_engine: engine.id,
        }) : null;
        return [engine.id, activationAdmissionFromEvidence(read?.error ? null : read?.data)] as const;
      })));
    const accountById = new Map(accounts.map((item) => [item.id, item]));
    return json({ accounts,
      engines: (engines.data ?? []).filter((item) => accountById.has(item.exchange_account_id)).map((item) => {
        const isTestnet = item.environment === "TESTNET";
        const run = (isTestnet ? testnetRuns.data : runs.data)?.find((row) => row.trading_engine_id === item.id) ?? null;
        const runSlots = (isTestnet ? testnetSlots.data : slots.data ?? [])?.filter((row) => row.run_id === run?.id) ?? [];
        const runOrders = (isTestnet ? testnetOrders.data : orders.data ?? [])?.filter((row) => row.run_id === run?.id) ?? [];
        const open = runSlots.filter((row) => row.entry_state === "OPEN").length;
        const tp = runOrders.filter((row) => row.side === "SELL").length;
        const nextBuy = runOrders.filter((row) => row.side === "BUY").length;
        const prep = preparations.data?.find((row) => row.trading_engine_id === item.id);
        const clean = !run?.last_error && !(alerts.data ?? []).some((row) => row.trading_engine_id === item.id);
        const recent = !!run?.last_reconciled_at && Date.now() - Date.parse(run.last_reconciled_at) < 10 * 60_000;
        const account = accountById.get(item.exchange_account_id);
        const operational = run?.status === "ACTIVE" && item.status === "ACTIVE" && !item.kill_switch
          && account?.status === "ACTIVE" && !account.kill_switch && (isTestnet || prep?.live_enabled && !prep.kill_switch)
          && clean && recent && runSlots.length === 25 && open > 0 && tp === open && nextBuy === 1;
        const ready = isTestnet ? !run && item.status === "INACTIVE" && item.kill_switch
          && readyChecks.data?.some((row) => row.trading_engine_id === item.id && row.status === "PASS")
          : run?.status === "PREPARING" && !run.last_error && runSlots.length === 25
            && prep?.kill_switch && !prep.live_enabled;
        return { ...item, run, operational: Boolean(operational), ready: Boolean(ready),
          activationAdmission: engineAdmissions.get(item.id) ?? null,
          evidence: { physicalSlots: runSlots.length, open, residentTp: tp, nextBuy, recent, clean },
          profile: profiles.data?.find((profile) => profile.trading_engine_id === item.id) ?? null };
      }),
      caps: caps.data ?? [] });
  } catch { return json({ error: "COINOPS_ENGINE_ADMIN_UNAVAILABLE" }, 403); }
}

type Intent = { action?: string; accountId?: string; engineId?: string;
  requestId?: string; quote?: string; capital?: string; engines?: EnginePlanInput["engines"];
  shardId?: string; previewHash?: string };

export async function POST(request: NextRequest) {
  try {
    sameOrigin(request);
    const raw = await request.text();
    if (Buffer.byteLength(raw) > 4096) throw new Error("COINOPS_ENGINE_BODY_TOO_LARGE");
    const input = JSON.parse(raw) as Intent;
    if (!input || !["PREVIEW", "PROVISION", "SYNC", "PREPARE", "ACTIVATE", "RECOVER", "PAUSE", "RESUME",
      "APPEND_OPTIONS", "APPEND_PREVIEW", "APPEND_PROVISION"].includes(input.action ?? ""))
      throw new Error("COINOPS_ENGINE_ACTION_INVALID");
    const scope = await adminScope();
    if (input.action === "APPEND_OPTIONS") return json({ options: await loadEngineAdmissionOptions(
      scope.service, scope.operator.id, String(input.accountId), 1) });
    if (input.action === "APPEND_PREVIEW") return json(await previewEngineAppend(scope.service, scope.operator.id, input as AppendPlanInput));
    if (input.action === "APPEND_PROVISION") return json(await provisionEngineAppend(scope.service, scope.operator.id, input as AppendPlanInput));
    if (input.action === "PREVIEW" || input.action === "PROVISION") {
      const planInput = input as EnginePlanInput;
      const preview = await planPreview(scope, planInput);
      if (input.action === "PREVIEW") return json(preview);
      if (preview.status !== "PREVIEW_NO_WRITE")
        throw new Error("COINOPS_ENGINE_SLOT_NOT_EXECUTABLE");
      const plan = validateEnginePlan(planInput);
      const created = await scope.service.rpc("stage_operator_engine_plan", {
        p_operator_id: scope.operator.id, p_account_id: plan.accountId,
        p_quote_asset: plan.quote, p_authorized_capital: plan.capital,
        p_environment: preview.environment,
        p_engines: plan.engines.map((engine) => ({ asset: engine.asset,
          capital: engine.capital, gain: engine.gain, spacing: engine.spacing,
          postAth: engine.postAth })), p_request_id: plan.requestId,
      });
      if (created.error || !Array.isArray(created.data) || created.data.length !== plan.engines.length)
        throw new Error("COINOPS_ENGINE_PROVISION_FAILED");
      await syncInactiveBinanceAccount(scope.service, scope.operator.id, plan.accountId,
        `account_${plan.accountId.replaceAll("-", "")}`, preview.environment);
      return json({ status: "INACTIVE_STAGED", engines: created.data, preview });
    }
    if (input.action === "SYNC") {
      if (!input.accountId) throw new Error("COINOPS_ENGINE_SCOPE_REQUIRED");
      const account = await ownedAccount(scope, input.accountId);
      if (account.status !== "INACTIVE" || !account.kill_switch)
        throw new Error("COINOPS_ENGINE_REGISTRY_SYNC_DENIED");
      const result = await syncInactiveBinanceAccount(scope.service, scope.operator.id,
        account.id, account.credential_ref!, await accountEnvironment(scope, account.id));
      return json(result);
    }
    if (!input.accountId || !input.engineId) throw new Error("COINOPS_ENGINE_SCOPE_REQUIRED");
    const environment = await accountEnvironment(scope, input.accountId);
    const engine = await resolveOperatorEngine(scope.service, scope.operator, {
      environment, exchange_account_id: input.accountId,
      trading_engine_id: input.engineId,
    });
    const asset = engine.base_asset as "BTC" | "SOL";
    if (!["BTC", "SOL"].includes(asset)
      || !(environment === "TESTNET" ? ["USDC", "USDT"] : ["BRL", "USDT"]).includes(engine.quote_asset))
      throw new Error("COINOPS_ENGINE_MARKET_DENIED");
    const account = await scope.service.from("exchange_accounts")
      .select("id,status,kill_switch,is_legacy_default,credential_ref")
      .eq("id", engine.exchange_account_id).eq("operator_id", scope.operator.id).single();
    if (account.error || !account.data) throw new Error("COINOPS_ENGINE_ACCOUNT_DENIED");
    if (environment === "TESTNET") {
      if (account.data.is_legacy_default || !["USDC", "USDT"].includes(engine.quote_asset))
        throw new Error("COINOPS_ENGINE_TESTNET_SCOPE_DENIED");
      if (input.action === "RECOVER") {
        // A failed activation can leave the gate closed before a cycle exists.
        // No order can be dispatched by startTestnetRun before its run is
        // persisted. Still require a fresh exchange snapshot and zero owned
        // resident orders; uncertain state remains blocked for investigation.
        if (engine.status !== "ACTIVE" || !engine.engine_kill_switch
          || account.data.status !== "ACTIVE" || account.data.kill_switch)
          throw new Error("COINOPS_ENGINE_RECOVERY_DENIED");
        const runs = await scope.service.from("robot_v1_testnet_runs").select("id")
          .eq("operator_id", scope.operator.id).eq("exchange_account_id", engine.exchange_account_id)
          .eq("trading_engine_id", engine.trading_engine_id).limit(1);
        const orders = await scope.service.from("robot_v1_testnet_orders").select("id")
          .eq("operator_id", scope.operator.id).eq("exchange_account_id", engine.exchange_account_id)
          .eq("trading_engine_id", engine.trading_engine_id).limit(1);
        if (runs.error || orders.error || runs.data?.length || orders.data?.length)
          throw new Error("COINOPS_ENGINE_RECOVERY_LEDGER_UNSAFE");
        const ready = await scope.service.from("account_onboarding_checks").select("status,evidence")
          .eq("operator_id", scope.operator.id).eq("exchange_account_id", engine.exchange_account_id)
          .eq("trading_engine_id", engine.trading_engine_id).eq("check_key", "TESTNET_READY")
          .order("checked_at", { ascending: false }).limit(1).maybeSingle();
        if (ready.error || ready.data?.status !== "PASS" || ready.data.evidence?.symbol !== engine.symbol)
          throw new Error("COINOPS_ENGINE_RECOVERY_READY_UNPROVEN");
        const snapshot = await operatorAccountSnapshot(scope.operator.id, engine.exchange_account_id,
          engine.quote_asset, [engine.symbol], account.data.credential_ref!, "TESTNET");
        if (!snapshot.markets[0] || snapshot.markets[0].open_orders.length)
          throw new Error("COINOPS_ENGINE_RECOVERY_EXCHANGE_UNSAFE");
        const free = snapshot.balances.find((balance) => balance.asset === engine.quote_asset)?.free ?? 0;
        const slotNotional = Math.floor(Number(engine.hard_cap_quote) * 100 / 25) / 100;
        if (!Number.isFinite(slotNotional) || free + 1e-8 < Number(engine.hard_cap_quote)
          || slotNotional < parseLiveRules(snapshot.markets[0].rules).minNotional)
          throw new Error("COINOPS_ENGINE_RECOVERY_CAP_UNSAFE");
        // Binance /order/test checks trading permission without placing an
        // order. Keep the gate closed if the credential cannot trade now.
        const probe = await BinanceSpotTestnetAdapter.fromAccount(engine, randomUUID(), [])
          .checkTradePermission(engine.symbol, slotNotional);
        if (!probe.ok) throw new Error("COINOPS_ENGINE_TESTNET_TRADE_PERMISSION_INVALID");
        const restored = await scope.service.from("trading_engines")
          .update({ status: "INACTIVE", kill_switch: true })
          .eq("operator_id", scope.operator.id).eq("exchange_account_id", engine.exchange_account_id)
          .eq("id", engine.trading_engine_id).eq("environment", "TESTNET")
          .eq("status", "ACTIVE").eq("kill_switch", true).select("id").maybeSingle();
        if (restored.error || !restored.data) throw new Error("COINOPS_ENGINE_RECOVERY_RACE");
        return json({ status: "READY", engineId: engine.trading_engine_id });
      }
      if (input.action === "PREPARE") {
        if (engine.status !== "INACTIVE" || !engine.engine_kill_switch
          || !["INACTIVE", "ACTIVE"].includes(account.data.status)
          || account.data.kill_switch !== (account.data.status === "INACTIVE"))
          throw new Error("COINOPS_ENGINE_PREPARATION_DENIED");
        const snapshot = await operatorAccountSnapshot(scope.operator.id, engine.exchange_account_id,
          engine.quote_asset, [engine.symbol], account.data.credential_ref!, "TESTNET");
        const free = snapshot.balances.find((balance) => balance.asset === engine.quote_asset)?.free ?? 0;
        if (free + 1e-8 < Number(engine.hard_cap_quote) || snapshot.markets[0]?.open_orders.length)
          throw new Error("COINOPS_ENGINE_TESTNET_PREPARATION_UNSAFE");
        const check = await scope.service.from("account_onboarding_checks").insert({
          operator_id: scope.operator.id, exchange_account_id: engine.exchange_account_id,
          trading_engine_id: engine.trading_engine_id, check_key: "TESTNET_READY", status: "PASS",
          evidence: { environment: "TESTNET", symbol: engine.symbol,
            observed_at: snapshot.observed_at, capital_quote: Number(engine.hard_cap_quote),
            mode: "GET_ONLY_NO_ORDER" }, created_by: scope.operator.user_id,
          idempotency_key: `testnet-ready:${randomUUID()}` });
        if (check.error) throw new Error("COINOPS_ENGINE_READY_AUDIT_FAILED");
        return json({ status: "READY", engineId: engine.trading_engine_id });
      }
      const current = await scope.service.from("robot_v1_testnet_runs")
        .select("id,status,last_error").eq("trading_engine_id", engine.trading_engine_id)
        .in("status", ["ACTIVE", "PAUSED"]).maybeSingle();
      if (current.error) throw new Error("COINOPS_ENGINE_RUN_UNAVAILABLE");
      if (input.action === "PAUSE") {
        if (!current.data) throw new Error("COINOPS_ENGINE_NOT_ACTIVE");
        return json(await pauseTestnetRun(current.data.id));
      }
      if (input.action === "RESUME") {
        if (!current.data) throw new Error("COINOPS_ENGINE_NOT_PAUSED");
        return json(await resumeTestnetRun(current.data.id));
      }
      if (input.action !== "ACTIVATE") throw new Error("COINOPS_ENGINE_ACTION_INVALID");
      if (current.data?.status === "ACTIVE") return json({ status: "ALREADY_ACTIVE", cycleId: current.data.id });
      if (current.data || engine.status !== "INACTIVE" || !engine.engine_kill_switch
        || !["INACTIVE", "ACTIVE"].includes(account.data.status))
        throw new Error("COINOPS_ENGINE_NOT_READY");
      const ready = await scope.service.from("account_onboarding_checks").select("status,evidence")
        .eq("operator_id", scope.operator.id).eq("exchange_account_id", engine.exchange_account_id)
        .eq("trading_engine_id", engine.trading_engine_id).eq("check_key", "TESTNET_READY")
        .order("checked_at", { ascending: false }).limit(1).maybeSingle();
      if (ready.error || ready.data?.status !== "PASS" || ready.data.evidence?.symbol !== engine.symbol)
        throw new Error("COINOPS_ENGINE_NOT_READY");
      // Fresh exchange state is mandatory immediately before the fictitious
      // first MARKET. Existing orders are never adopted into a new cycle.
      const snapshot = await operatorAccountSnapshot(scope.operator.id, engine.exchange_account_id,
        engine.quote_asset, [engine.symbol], account.data.credential_ref!, "TESTNET");
      const free = snapshot.balances.find((balance) => balance.asset === engine.quote_asset)?.free ?? 0;
      if (free + 1e-8 < Number(engine.hard_cap_quote) || snapshot.markets[0]?.open_orders.length)
        throw new Error("COINOPS_ENGINE_TESTNET_ACTIVATION_UNSAFE");
      await requireAccountIdentityBinding(scope.service, scope.operator.id, engine.exchange_account_id, "TESTNET");
      await reserveEngineCapacity(scope.service, engine.trading_engine_id, engine.exchange_account_id);
      if (account.data.status === "INACTIVE") {
        const opened = await scope.service.from("exchange_accounts")
          .update({ status: "ACTIVE", kill_switch: false }).eq("id", account.data.id)
          .eq("operator_id", scope.operator.id).eq("status", "INACTIVE").eq("kill_switch", true)
          .select("id").maybeSingle();
        if (opened.error || !opened.data) throw new Error("COINOPS_ENGINE_ACCOUNT_GATE_FAILED");
      } else if (account.data.kill_switch) throw new Error("COINOPS_ENGINE_ACCOUNT_GATE_FAILED");
      const opened = await scope.service.from("trading_engines")
        .update({ status: "ACTIVE", kill_switch: false }).eq("id", engine.trading_engine_id)
        .eq("exchange_account_id", engine.exchange_account_id).eq("environment", "TESTNET")
        .eq("status", "INACTIVE").eq("kill_switch", true).select("id").maybeSingle();
      if (opened.error || !opened.data) throw new Error("COINOPS_ENGINE_GATE_FAILED");
      try {
        const cycleId = await startTestnetRun(scope.operator.user_id, asset, {
          exchange_account_id: engine.exchange_account_id, trading_engine_id: engine.trading_engine_id });
        return json({ status: "ACTIVATING", cycleId });
      } catch (failure) {
        // Unknown dispatch outcome: preserve the ledger and block new entries.
        // Recovery will use the persisted client IDs; never send another BUY
        // from this request after an exception.
        await scope.service.from("trading_engines").update({ kill_switch: true })
          .eq("id", engine.trading_engine_id).eq("environment", "TESTNET");
        throw failure;
      }
    }
    if (input.action === "PREPARE") {
      if (engine.legacy_compatible || engine.status !== "INACTIVE")
        throw new Error("COINOPS_ENGINE_PREPARATION_DENIED");
      const health = await loadLiveEngineExecutorStatus(engine);
      if (health.gate !== "LIVE_EXECUTOR_READY")
        throw new Error("COINOPS_ENGINE_EXECUTOR_NOT_READY");
      const cycleId = await prepareLiveCycle(scope.operator.user_id, asset, {
        environment: "REAL", exchange_account_id: engine.exchange_account_id,
        trading_engine_id: engine.trading_engine_id });
      return json({ status: "READY", cycleId });
    }
    const runRead = await scope.service.from("robot_v1_live_runs")
      .select("id,status,last_error")
      .eq("trading_engine_id", engine.trading_engine_id)
      .in("status", ["PREPARING", "ACTIVE", "PAUSED"]).maybeSingle();
    if (runRead.error || !runRead.data) throw new Error("COINOPS_ENGINE_RUN_UNAVAILABLE");
    const run = runRead.data;
    if (input.action === "PAUSE") {
      if (run.status !== "ACTIVE") throw new Error("COINOPS_ENGINE_NOT_ACTIVE");
      return json(await pauseLiveRun(run.id, scope.operator.user_id, asset));
    }
    if (input.action === "RESUME") {
      // A fail-closed ACTIVE run may already have a reconciled successor, but
      // its BUY gate is still closed. Resume validates exchange/ledger again.
      if (!(["ACTIVE", "PAUSED"].includes(run.status) && (run.status === "PAUSED"
        || engine.engine_kill_switch))) throw new Error("COINOPS_ENGINE_NOT_PAUSED");
      return json(await resumeLiveRun(run.id, scope.operator.user_id, asset));
    }
    if (input.action !== "ACTIVATE" || engine.legacy_compatible
      || process.env.COINOPS_LIVE_CRON_ENABLED !== "true")
      throw new Error("COINOPS_ENGINE_ACTIVATION_DENIED");
    if (run.status === "ACTIVE") return json({ status: "ALREADY_ACTIVE", cycleId: run.id });
    if (run.status !== "PREPARING" || run.last_error)
      throw new Error("COINOPS_ENGINE_NOT_READY");
    const capRead = await scope.service.from("account_quote_caps")
      .select("hard_cap_quote").eq("exchange_account_id", engine.exchange_account_id)
      .eq("quote_asset", engine.quote_asset).single();
    const prepRead = await scope.service.from("robot_v1_live_preparations")
      .select("configured_live_capital_brl,kill_switch,live_enabled")
      .eq("trading_engine_id", engine.trading_engine_id).single();
    if (capRead.error || prepRead.error || !capRead.data || !prepRead.data
      || !prepRead.data.kill_switch || prepRead.data.live_enabled)
      throw new Error("COINOPS_ENGINE_CAP_UNAVAILABLE");
    if (!engine.executor_shard_id) throw new Error("EXECUTOR_ENGINE_SHARD_DENIED");
    const connection = await resolveExecutorForConnection(scope.operator.id, engine.exchange_account_id, engine.executor_shard_id);
    const snapshot = await operatorAccountSnapshot(scope.operator.id, engine.exchange_account_id,
      engine.quote_asset, [`BTC${engine.quote_asset}`, `SOL${engine.quote_asset}`], connection.credentialRef, "REAL", engine.trading_engine_id);
    const allocation = await allocatedCapital(scope.service, scope.operator.id, engine.exchange_account_id, engine.quote_asset, snapshot);
    const confirmed = await operatorAccountSnapshot(scope.operator.id, engine.exchange_account_id,
      engine.quote_asset, [`BTC${engine.quote_asset}`, `SOL${engine.quote_asset}`], connection.credentialRef, "REAL", engine.trading_engine_id);
    if (allocation.free + 1e-8 < allocation.requiredFree
      || allocationSnapshotFingerprint(snapshot) !== allocationSnapshotFingerprint(confirmed))
      throw new Error("COINOPS_ENGINE_ACTIVATION_ALLOCATION_DENIED");
    const free = snapshot.balances.find((item) => item.asset === engine.quote_asset)?.free ?? 0;
    const ownPrefix = `C2-${(await import("node:crypto")).createHash("sha256")
      .update(`${engine.exchange_account_id}|${engine.trading_engine_id}`).digest("hex").slice(0, 10)}-`;
    if (free + 1e-8 < Number(prepRead.data.configured_live_capital_brl)
      || snapshot.markets.flatMap((market) => market.open_orders).some((order) => order.clientOrderId?.startsWith(ownPrefix))
      || Number(engine.hard_cap_quote) > Number(capRead.data.hard_cap_quote))
      throw new Error("COINOPS_ENGINE_ACTIVATION_SNAPSHOT_DENIED");
    await requireAccountIdentityBinding(scope.service, scope.operator.id, engine.exchange_account_id, "REAL", engine.executor_shard_id);
    await collectAccountOrderBudget(scope.service, scope.operator.id, engine.exchange_account_id,
      engine.executor_shard_id, [engine.symbol]);
    // Resident engine is already in the account inventory. Its individual
    // dispatch cost is reserved later under the engine lease, before POST.
    const accountBudget = await previewAccountOrderBudget(scope.service, scope.operator.id, engine.exchange_account_id, [], [engine.symbol]);
    if (accountBudget.code !== "PASS") throw new Error(`COINOPS_${accountBudget.code}`);
    await reserveEngineCapacity(scope.service, engine.trading_engine_id, engine.exchange_account_id);
    if (account.data.status === "INACTIVE") {
      const opened = await scope.service.from("exchange_accounts")
        .update({ status: "ACTIVE", kill_switch: false })
        .eq("id", account.data.id).eq("status", "INACTIVE").eq("kill_switch", true)
        .select("id").single();
      if (opened.error || !opened.data) throw new Error("COINOPS_ENGINE_ACCOUNT_GATE_FAILED");
    } else if (account.data.status !== "ACTIVE" || account.data.kill_switch) {
      throw new Error("COINOPS_ENGINE_ACCOUNT_GATE_FAILED");
    }
    if (engine.status === "INACTIVE") {
      const opened = await scope.service.from("trading_engines")
        .update({ status: "ACTIVE", kill_switch: false })
        .eq("id", engine.trading_engine_id).eq("status", "INACTIVE")
        .eq("kill_switch", true).select("id").single();
      if (opened.error || !opened.data) throw new Error("COINOPS_ENGINE_GATE_FAILED");
    } else if (engine.status !== "ACTIVE") throw new Error("COINOPS_ENGINE_GATE_FAILED");
    const promoted = await operatorExecutorAdmin<{ status: string; trading_engine_id: string }>(
      "/v1/admin/promote", { operator_id: scope.operator.id,
        exchange_account_id: engine.exchange_account_id, trading_engine_id: engine.trading_engine_id,
        credential_ref: connection.credentialRef, environment: "REAL",
        symbol: engine.symbol, hard_cap_quote: Number(engine.hard_cap_quote),
        account_cap_quote: Number(capRead.data.hard_cap_quote),
        max_order_quote: Number(engine.hard_cap_quote) }, "PROMOTE");
    if (promoted.status !== "ACTIVE" || promoted.trading_engine_id !== engine.trading_engine_id)
      throw new Error("COINOPS_ENGINE_PROMOTION_FAILED");
    const health = await loadLiveEngineExecutorStatus(engine);
    if (health.gate !== "LIVE_EXECUTOR_ACTIVE")
      throw new Error("COINOPS_ENGINE_EXECUTOR_NOT_ACTIVE");
    const activated = await scope.service.rpc("activate_robot_v1_live_cycle", { p_run_id: run.id });
    if (activated.error || activated.data?.status !== "ACTIVE")
      throw new Error("COINOPS_ENGINE_ACTIVATION_FAILED");
    // Activation can already consume most of this request's 60-second budget.
    // The scheduled worker owns first dispatch with a fresh function deadline.
    return json({ status: "ACTIVATING", cycleId: run.id });
  } catch (error) {
    const code = error instanceof Error && /^(?:COINOPS|EXECUTOR)_[A-Z0-9_]+$/.test(error.message)
      ? error.message : "COINOPS_ENGINE_CONTROL_FAILED";
    return json({ error: code }, code.includes("AUTH") ? 401 : code.includes("UNAVAILABLE") ? 503 : 403);
  }
}
