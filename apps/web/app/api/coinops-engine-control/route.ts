import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

import { syncInactiveBinanceAccount } from "@/lib/execution/binance-account-registry-server";
import { loadLiveEngineExecutorStatus } from "@/lib/execution/live-executor-health";
import { buildLiveSizing, parseLiveRules } from "@/lib/execution/live-preparation";
import { operatorAccountSnapshot, operatorExecutorAdmin } from "@/lib/execution/operator-executor-admin";
import { validateEnginePlan, type EnginePlanInput } from "@/lib/execution/operator-engine-plan";
import { resolveOperatorEngine } from "@/lib/execution/operator-context-server";
import { advanceLiveRun, pauseLiveRun, prepareLiveCycle, resumeLiveRun } from "@/lib/execution/robot-v1-live-server";
import { pauseTestnetRun, resumeTestnetRun, startTestnetRun } from "@/lib/execution/robot-v1-testnet-server";
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
type Environment = "REAL" | "TESTNET";

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
    .select("is_legacy_default").eq("operator_id", scope.operator.id)
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
    || !["REAL", "TESTNET"].includes(environment))
    throw new Error("COINOPS_ENGINE_CREDENTIAL_NOT_VALIDATED");
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
  return { account: account.display_name, accountId: account.id, environment, quote: plan.quote,
    capital: plan.capital, free, outsideCoinOps: Number((free - plan.capital).toFixed(2)),
    observedAt: snapshot.observed_at, executorIp: snapshot.executor_ip,
    engines, status: engines.every((item) => item.validSlots === 25)
      ? "PREVIEW_NO_WRITE" as const : "NOT_EXECUTABLE" as const };
}

export async function GET() {
  try {
    const { operator, service } = await adminScope();
    const [accounts, engines, caps, runs, testnetRuns, profiles, checks, readyChecks, preparations, alerts] = await Promise.all([
      service.from("exchange_accounts")
        .select("id,display_name,status,kill_switch,is_legacy_default")
        .eq("operator_id", operator.id).order("created_at"),
      service.from("trading_engines")
        .select("id,exchange_account_id,environment,symbol,quote_asset,status,kill_switch,hard_cap_quote,config")
        .eq("operator_id", operator.id).in("environment", ["REAL", "TESTNET"]).order("symbol"),
      service.from("account_quote_caps").select("exchange_account_id,quote_asset,hard_cap_quote")
        .eq("operator_id", operator.id),
      service.from("robot_v1_live_runs")
        .select("id,trading_engine_id,status,last_error,last_reconciled_at,created_at")
        .eq("operator_id", operator.id).in("status", ["PREPARING", "ACTIVE", "PAUSED"]),
      service.from("robot_v1_testnet_runs")
        .select("id,trading_engine_id,status,last_error,last_reconciled_at,created_at")
        .eq("operator_id", operator.id).in("status", ["ACTIVE", "PAUSED"]),
      service.from("robot_v1_ath_profiles")
        .select("trading_engine_id,gain_rate,normal_spacing_rate,post_ath_spacing_rate,config_version")
        .eq("operator_id", operator.id).in("environment", ["REAL", "TESTNET"]),
      service.from("account_onboarding_checks")
        .select("exchange_account_id,status,evidence,checked_at")
        .eq("operator_id", operator.id).eq("check_key", "BINANCE_CREDENTIAL")
        .order("checked_at", { ascending: false }).limit(100),
      service.from("account_onboarding_checks")
        .select("trading_engine_id,status,checked_at")
        .eq("operator_id", operator.id).eq("check_key", "TESTNET_READY")
        .order("checked_at", { ascending: false }).limit(100),
      service.from("robot_v1_live_preparations")
        .select("trading_engine_id,live_enabled,kill_switch")
        .eq("operator_id", operator.id),
      service.from("robot_v1_live_alerts").select("trading_engine_id")
        .eq("operator_id", operator.id).is("resolved_at", null),
    ]);
    if ([accounts, engines, caps, runs, testnetRuns, profiles, checks, readyChecks, preparations, alerts].some((item) => item.error))
      throw new Error("COINOPS_ENGINE_STATUS_UNAVAILABLE");
    const runIds = (runs.data ?? []).map((run) => run.id);
    const testnetRunIds = (testnetRuns.data ?? []).map((run) => run.id);
    const [slots, orders] = runIds.length ? await Promise.all([
      service.from("robot_v1_live_slots").select("run_id,trading_engine_id,entry_state")
        .in("run_id", runIds),
      service.from("robot_v1_live_orders").select("run_id,trading_engine_id,side,status")
        .in("run_id", runIds).in("status", ["NEW", "PARTIALLY_FILLED"]),
    ]) : [{ data: [], error: null }, { data: [], error: null }];
    const [testnetSlots, testnetOrders] = testnetRunIds.length ? await Promise.all([
      service.from("robot_v1_testnet_slots").select("run_id,trading_engine_id,entry_state")
        .in("run_id", testnetRunIds),
      service.from("robot_v1_testnet_orders").select("run_id,trading_engine_id,side,status")
        .in("run_id", testnetRunIds).in("status", ["NEW", "PARTIALLY_FILLED"]),
    ]) : [{ data: [], error: null }, { data: [], error: null }];
    if (slots.error || orders.error || testnetSlots.error || testnetOrders.error)
      throw new Error("COINOPS_ENGINE_STATUS_UNAVAILABLE");
    const validation = new Map<string, { valid: boolean; environment: Environment | null }>();
    for (const row of checks.data ?? []) if (!validation.has(row.exchange_account_id))
      validation.set(row.exchange_account_id, { valid: row.status === "PASS" && row.evidence?.status === "PASS",
        environment: ["REAL", "TESTNET"].includes(row.evidence?.environment)
          ? row.evidence.environment as Environment : null });
    const accountById = new Map((accounts.data ?? []).map((item) => [item.id, item]));
    return json({ accounts: (accounts.data ?? []).map((item) => ({ ...item,
      credentialValidated: validation.get(item.id)?.valid ?? false,
      environment: validation.get(item.id)?.environment ?? null })),
      engines: (engines.data ?? []).map((item) => {
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
          evidence: { physicalSlots: runSlots.length, open, residentTp: tp, nextBuy, recent, clean },
          profile: profiles.data?.find((profile) => profile.trading_engine_id === item.id) ?? null };
      }),
      caps: caps.data ?? [] });
  } catch { return json({ error: "COINOPS_ENGINE_ADMIN_UNAVAILABLE" }, 403); }
}

type Intent = { action?: string; accountId?: string; engineId?: string;
  requestId?: string; quote?: string; capital?: string; engines?: EnginePlanInput["engines"] };

export async function POST(request: NextRequest) {
  try {
    sameOrigin(request);
    const raw = await request.text();
    if (Buffer.byteLength(raw) > 4096) throw new Error("COINOPS_ENGINE_BODY_TOO_LARGE");
    const input = JSON.parse(raw) as Intent;
    if (!input || !["PREVIEW", "PROVISION", "SYNC", "PREPARE", "ACTIVATE", "PAUSE", "RESUME"].includes(input.action ?? ""))
      throw new Error("COINOPS_ENGINE_ACTION_INVALID");
    const scope = await adminScope();
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
      if (account.data.is_legacy_default || engine.status !== "INACTIVE")
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
    if (input.action !== "ACTIVATE" || account.data.is_legacy_default
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
    const snapshot = await operatorAccountSnapshot(scope.operator.id, engine.exchange_account_id,
      engine.quote_asset, [engine.symbol]);
    const free = snapshot.balances.find((item) => item.asset === engine.quote_asset)?.free ?? 0;
    const ownPrefix = `C2-${(await import("node:crypto")).createHash("sha256")
      .update(`${engine.exchange_account_id}|${engine.trading_engine_id}`).digest("hex").slice(0, 10)}-`;
    if (free + 1e-8 < Number(prepRead.data.configured_live_capital_brl)
      || snapshot.markets[0]?.open_orders.some((order) => order.clientOrderId?.startsWith(ownPrefix))
      || Number(engine.hard_cap_quote) > Number(capRead.data.hard_cap_quote))
      throw new Error("COINOPS_ENGINE_ACTIVATION_SNAPSHOT_DENIED");
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
        credential_ref: account.data.credential_ref, environment: "REAL",
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
    // The normal server-side worker owns order dispatch/recovery. Kick it once;
    // a timeout cannot replay an order because client IDs and ledger are durable.
    const first = await advanceLiveRun(run.id, "OPERATOR_ACTIVATE");
    return json({ status: "ACTIVATING", cycleId: run.id, reconciliation: first });
  } catch (error) {
    const code = error instanceof Error && /^(?:COINOPS|EXECUTOR)_[A-Z0-9_]+$/.test(error.message)
      ? error.message : "COINOPS_ENGINE_CONTROL_FAILED";
    return json({ error: code }, code.includes("AUTH") ? 401 : code.includes("UNAVAILABLE") ? 503 : 403);
  }
}
