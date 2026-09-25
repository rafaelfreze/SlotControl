import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";

import { allocateBulkSlots, projectSlotAdjustment } from "@/lib/execution/live-adjustment-plans";
import { operatorAccountSnapshot, operatorExecutorAdmin } from "@/lib/execution/operator-executor-admin";
import { isIdentity } from "@/lib/execution/operator-context";
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
type Scope = { service: Service; operator: { id: string; user_id: string; product_id: string; tenant_id: string } };
type Engine = { id: string; exchange_account_id: string; operator_id: string; symbol: string;
  quote_asset: "BRL" | "USDT"; base_asset: "BTC" | "SOL"; status: string;
  hard_cap_quote: number | string };
type Run = { id: string; trading_engine_id: string; status: string; last_error: string | null;
  last_reconciled_at: string | null; lease_until: string | null };
type Slot = { id: string; trading_engine_id: string; slot_number: number; operation_sequence: number;
  entry_state: string; position_committed_brl: number | string };
type SlotAccount = { trading_engine_id: string; slot_number: number; balance_quote: number | string;
  contribution_quote: number | string; gain_count: number };
type Draft = { action: "PREVIEW" | "CONFIRM" | "REVERSE_PREVIEW" | "REVERSE_CONFIRM" | "PLAN_SAVE" | "PLAN_DISABLE";
  kind?: "MANUAL_GAIN" | "CAPITAL"; accountId: string; quote: "BRL" | "USDT";
  engineId?: string; slotNumber?: number; gainUnits?: number; amount?: number;
  shares?: Array<{ engineId: string; amount: number }>;
  originCurrency?: "BRL" | "USDT"; originAmount?: number;
  fxObservedAt?: string; evidence?: string; reason: string; requestId: string;
  previewHash?: string; originalId?: string; monthlyAmount?: number; btcPercent?: number;
  startMonth?: string; horizonMonths?: number };

async function adminScope(): Promise<Scope> {
  if (getSupabaseDataSchema() !== "coinops") throw new Error("COINOPS_ADJUSTMENT_SCHEMA_DENIED");
  const tenantId = getCoinOpsServiceTenantId();
  const user = (await createClient().auth.getUser()).data.user;
  if (!user || !tenantId) throw new Error("COINOPS_ADJUSTMENT_AUTH_REQUIRED");
  const db = createClient();
  const op = await db.from("operators").select("id,product_id,tenant_id,user_id,kill_switch")
    .eq("tenant_id", tenantId).eq("user_id", user.id).eq("status", "ACTIVE").single();
  if (op.error || !op.data || op.data.kill_switch) throw new Error("COINOPS_ADJUSTMENT_ADMIN_DENIED");
  return { operator: op.data, service: createServiceRoleClient() };
}

function sameOrigin(request: NextRequest) {
  if (process.env.VERCEL_ENV !== "production" || request.nextUrl.hostname !== "cripto-flax.vercel.app"
    || request.headers.get("origin") !== request.nextUrl.origin
    || request.headers.get("sec-fetch-site") === "cross-site"
    || request.headers.get("content-type")?.split(";")[0] !== "application/json"
    || request.headers.get("x-coinops-admin-intent") !== "live-adjustment")
    throw new Error("COINOPS_ADJUSTMENT_ORIGIN_DENIED");
}

function exactCents(value: unknown, allowZero = false) {
  const number = Number(value), cents = Math.round(number * 100);
  if (!Number.isSafeInteger(cents) || cents < (allowZero ? 0 : 1)
    || Math.abs(number * 100 - cents) > 1e-7) throw new Error("COINOPS_ADJUSTMENT_AMOUNT_INVALID");
  return cents / 100;
}

async function verifyBrlUsdtConversion(originBrl: number, receivedUsdt: number) {
  const response = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=USDTBRL",
    { cache: "no-store", signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error("COINOPS_ADJUSTMENT_FX_REFERENCE_UNAVAILABLE");
  const quote = await response.json() as { symbol?: string; price?: string };
  const referenceRate = Number(quote.price), effectiveRate = originBrl / receivedUsdt;
  if (quote.symbol !== "USDTBRL" || !Number.isFinite(referenceRate) || referenceRate <= 0
    || Math.abs(effectiveRate / referenceRate - 1) > 0.05)
    throw new Error("COINOPS_ADJUSTMENT_FX_RATE_MISMATCH");
  return { referenceRate, effectiveRate, observedAt: new Date().toISOString(),
    source: "BINANCE_SPOT_USDTBRL_PUBLIC_GET" };
}

function inputGuard(input: Draft) {
  if (!isIdentity(input.accountId) || !isIdentity(input.requestId)
    || !["BRL", "USDT"].includes(input.quote)
    || input.reason?.trim().length < 3 || input.reason.trim().length > 160)
    throw new Error("COINOPS_ADJUSTMENT_INPUT_INVALID");
}

async function loadAccount(scope: Scope, accountId: string, quote: string) {
  const [account, engines, cap] = await Promise.all([
    scope.service.from("exchange_accounts")
      .select("id,operator_id,display_name,status,is_legacy_default,credential_ref")
      .eq("id", accountId).eq("operator_id", scope.operator.id).single(),
    scope.service.from("trading_engines")
      .select("id,exchange_account_id,operator_id,symbol,quote_asset,base_asset,status,hard_cap_quote")
      .eq("exchange_account_id", accountId).eq("operator_id", scope.operator.id)
      .eq("environment", "REAL").eq("quote_asset", quote).order("symbol"),
    scope.service.from("account_quote_caps").select("hard_cap_quote")
      .eq("exchange_account_id", accountId).eq("operator_id", scope.operator.id)
      .eq("quote_asset", quote).single(),
  ]);
  if (account.error || engines.error || cap.error || !account.data || !cap.data
    || account.data.status !== "ACTIVE" || !engines.data?.length
    || engines.data.some((engine) => engine.status !== "ACTIVE"))
    throw new Error("COINOPS_ADJUSTMENT_ACCOUNT_UNAVAILABLE");
  return { account: account.data, engines: engines.data as Engine[], cap: Number(cap.data.hard_cap_quote) };
}

function fingerprint(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

async function inspect(scope: Scope, accountId: string, quote: "BRL" | "USDT") {
  const loaded = await loadAccount(scope, accountId, quote);
  const ids = loaded.engines.map((engine) => engine.id);
  const runs = await scope.service.from("robot_v1_live_runs")
    .select("id,trading_engine_id,status,last_error,last_reconciled_at,lease_until")
    .in("trading_engine_id", ids).in("status", ["ACTIVE", "PAUSED"]);
  if (runs.error || runs.data?.length !== ids.length)
    throw new Error("COINOPS_ADJUSTMENT_LEDGER_UNHEALTHY");
  const runIds = runs.data.map((run) => run.id);
  const [slotRows, accounts, orderRows, totals, alerts] = await Promise.all([
    scope.service.from("robot_v1_live_slots")
      .select("id,trading_engine_id,slot_number,operation_sequence,entry_state,position_committed_brl")
      .in("run_id", runIds),
    scope.service.from("robot_v1_live_slot_accounts")
      .select("trading_engine_id,slot_number,balance_quote,contribution_quote,gain_count")
      .in("trading_engine_id", ids),
    scope.service.from("robot_v1_live_orders")
      .select("trading_engine_id,client_order_id,side,status,reserved_notional_brl")
      .in("run_id", runIds).in("status", ["NEW", "PARTIALLY_FILLED", "PREPARED", "SUBMITTING"]),
    scope.service.from("robot_v1_slot_gain_totals")
      .select("trading_engine_id,slot_number,lifetime_gain_count,monthly_gain_count")
      .in("trading_engine_id", ids).eq("environment", "REAL"),
    scope.service.from("robot_v1_live_alerts").select("id,trading_engine_id")
      .in("trading_engine_id", ids).is("resolved_at", null).limit(1),
  ]);
  if ([slotRows, accounts, orderRows, totals, alerts].some((result) => result.error)
    || slotRows.data?.length !== ids.length * 25
    || accounts.data?.length !== ids.length * 25 || alerts.data?.length)
    throw new Error("COINOPS_ADJUSTMENT_LEDGER_UNHEALTHY");
  const runList = runs.data as Run[];
  if (runList.some((run) => run.last_error || !run.last_reconciled_at
    || Date.now() - Date.parse(run.last_reconciled_at) > 10 * 60_000))
    throw new Error("COINOPS_ADJUSTMENT_RECONCILIATION_STALE");
  const snapshot = await operatorAccountSnapshot(scope.operator.id, accountId, quote,
    loaded.engines.map((engine) => engine.symbol), loaded.account.credential_ref);
  const ownOpen = (orderRows.data ?? []).filter((order) => ["NEW", "PARTIALLY_FILLED"].includes(order.status));
  if ((orderRows.data ?? []).some((order) => ["PREPARED", "SUBMITTING"].includes(order.status)))
    throw new Error("COINOPS_ADJUSTMENT_ORDER_UNCERTAIN");
  const exchangeOwn = snapshot.markets.flatMap((market) => market.open_orders.filter((order) =>
    order.clientOrderId?.startsWith("C2-") || order.clientOrderId?.startsWith("COR1-"))
    .map((order) => order.clientOrderId));
  const ledgerOwn = ownOpen.map((order) => order.client_order_id);
  if (exchangeOwn.length !== ledgerOwn.length
    || exchangeOwn.some((id) => !ledgerOwn.includes(id))
    || ledgerOwn.some((id) => !exchangeOwn.includes(id)))
    throw new Error("COINOPS_ADJUSTMENT_EXCHANGE_LEDGER_DIVERGENCE");
  const free = snapshot.balances.find((row) => row.asset === quote)?.free;
  if (free === undefined || !Number.isFinite(free)) throw new Error("COINOPS_ADJUSTMENT_BALANCE_UNAVAILABLE");
  const exposure = (slotRows.data ?? []).reduce((sum, row) => sum + Number(row.position_committed_brl), 0)
    + ownOpen.filter((order) => order.side === "BUY")
      .reduce((sum, order) => sum + Number(order.reserved_notional_brl), 0);
  const uncommitted = Math.max(0, loaded.cap - exposure);
  const availableForNewCapital = Math.max(0, Math.floor((free - uncommitted + 1e-8) * 100) / 100);
  return { ...loaded, runs: runList, slots: slotRows.data as Slot[],
    slotAccounts: accounts.data as SlotAccount[], totals: totals.data ?? [],
    free, exposure, availableForNewCapital, observedAt: snapshot.observed_at,
    executorIp: snapshot.executor_ip, openOrders: exchangeOwn.length };
}

function allocationInput(state: Awaited<ReturnType<typeof inspect>>, engineId: string,
  slotNumber: number, amount: number, gainUnits: number) {
  const account = state.slotAccounts.find((item) => item.trading_engine_id === engineId
    && item.slot_number === slotNumber);
  const slot = state.slots.find((item) => item.trading_engine_id === engineId
    && item.slot_number === slotNumber);
  const total = state.totals.find((item) => item.trading_engine_id === engineId
    && item.slot_number === slotNumber);
  if (!account || !slot) throw new Error("COINOPS_ADJUSTMENT_SLOT_MISSING");
  return { engineId, slotNumber, amount, gainUnits, balanceBefore: Number(account.balance_quote),
    operationSequence: slot.operation_sequence,
    monthlyBefore: Number(total?.monthly_gain_count ?? 0),
    lifetimeBefore: Number(total?.lifetime_gain_count ?? 0),
    open: slot.entry_state === "OPEN", committed: Number(slot.position_committed_brl) };
}

async function preview(scope: Scope, input: Draft) {
  if (!input.kind || !["MANUAL_GAIN", "CAPITAL"].includes(input.kind))
    throw new Error("COINOPS_ADJUSTMENT_KIND_INVALID");
  const state = await inspect(scope, input.accountId, input.quote);
  let allocations: ReturnType<typeof allocationInput>[];
  let amount = 0, origin = 0;
  let fxReference: Awaited<ReturnType<typeof verifyBrlUsdtConversion>> | null = null;
  if (input.kind === "MANUAL_GAIN") {
    if (!isIdentity(input.engineId) || !Number.isInteger(input.slotNumber)
      || input.slotNumber! < 1 || input.slotNumber! > 25
      || !Number.isInteger(input.gainUnits) || input.gainUnits! < 1 || input.gainUnits! > 25
      || !state.engines.some((engine) => engine.id === input.engineId))
      throw new Error("COINOPS_ADJUSTMENT_GAIN_INVALID");
    allocations = [allocationInput(state, input.engineId!, input.slotNumber!, 0, input.gainUnits!)];
  } else {
    amount = exactCents(input.amount);
    if (state.account.is_legacy_default) throw new Error("COINOPS_ADJUSTMENT_LEGACY_CAP_DENIED");
    if (amount > state.availableForNewCapital)
      throw new Error("APORTE_BLOQUEADO_SALDO_INSUFICIENTE");
    if (input.slotNumber !== undefined) {
      if (!isIdentity(input.engineId) || !Number.isInteger(input.slotNumber)
        || input.slotNumber < 1 || input.slotNumber > 25
        || !state.engines.some((engine) => engine.id === input.engineId))
        throw new Error("COINOPS_ADJUSTMENT_SLOT_INVALID");
      allocations = [allocationInput(state, input.engineId!, input.slotNumber, amount, 0)];
    } else {
      const shares = input.shares ?? [];
      if (shares.length < 1 || shares.length > 2
        || shares.some((share) => !state.engines.some((engine) => engine.id === share.engineId)))
        throw new Error("COINOPS_ADJUSTMENT_DISTRIBUTION_INVALID");
      allocations = allocateBulkSlots(amount, shares).map((slot) =>
        allocationInput(state, slot.engineId, slot.slotNumber, slot.amount, 0));
    }
    if (allocations.reduce((sum, row) => sum + Math.round(row.amount * 100), 0) !== Math.round(amount * 100))
      throw new Error("COINOPS_ADJUSTMENT_DISTRIBUTION_INVALID");
    if ((input.originCurrency ?? input.quote) === input.quote) origin = amount;
    else if (input.originCurrency === "BRL" && input.quote === "USDT") {
      origin = exactCents(input.originAmount);
      if (!input.evidence || input.evidence.trim().length < 8
        || !input.fxObservedAt || !Number.isFinite(Date.parse(input.fxObservedAt))
        || Date.now() - Date.parse(input.fxObservedAt) > 10 * 60_000
        || Date.parse(input.fxObservedAt) - Date.now() > 10_000)
        throw new Error("COINOPS_ADJUSTMENT_FX_EVIDENCE_REQUIRED");
      fxReference = await verifyBrlUsdtConversion(origin, amount);
    } else throw new Error("COINOPS_ADJUSTMENT_CURRENCY_INVALID");
  }
  const after = allocations.map((row) => ({ ...projectSlotAdjustment(row),
    target: state.engines.find((engine) => engine.id === row.engineId)?.base_asset === "BTC" ? 7 : 2 }));
  const payload = { accountId: input.accountId, quote: input.quote, kind: input.kind,
    amount, origin, originCurrency: input.originCurrency ?? input.quote,
    fxAt: input.fxObservedAt ?? null, evidence: input.evidence?.trim() ?? null,
    reason: input.reason.trim(), requestId: input.requestId, accountCap: state.cap,
    free: state.free, exposure: state.exposure, allocations: after };
  return { ...payload, account: state.account.display_name,
    availableForNewCapital: state.availableForNewCapital,
    afterCap: Number((state.cap + amount).toFixed(2)),
    outsideCoinOps: Number(Math.max(0, state.availableForNewCapital - amount).toFixed(2)),
    openCount: after.filter((row) => row.open).length,
    pendingForNextOperation: after.reduce((sum, row) => sum + row.pendingForNextOperation, 0),
    observedAt: state.observedAt, executorIp: state.executorIp,
    fxReference,
    previewHash: fingerprint(payload), noExchangeWrite: true };
}

async function existingBatch(scope: Scope, accountId: string, requestId: string) {
  const found = await scope.service.from("robot_v1_live_adjustment_batches")
    .select("id,kind,quote_asset,origin_currency,origin_amount,amount_quote,reason,reversal_of")
    .eq("operator_id", scope.operator.id).eq("exchange_account_id", accountId)
    .eq("request_id", requestId).maybeSingle();
  if (found.error) throw new Error("COINOPS_ADJUSTMENT_LEDGER_UNAVAILABLE");
  return found.data;
}

async function verifyReplay(scope: Scope, input: Draft, existing: NonNullable<Awaited<ReturnType<typeof existingBatch>>>) {
  if (existing.kind !== input.kind || existing.quote_asset !== input.quote
    || existing.reason !== input.reason.trim()
    || Number(existing.amount_quote) !== Number(input.amount ?? 0)
    || existing.origin_currency !== (input.originCurrency ?? input.quote)
    || Number(existing.origin_amount) !== Number(input.originCurrency === input.quote
      ? input.amount ?? 0 : input.originAmount ?? 0))
    throw new Error("COINOPS_ADJUSTMENT_REPLAY_CONFLICT");
  const recorded = await scope.service.from("robot_v1_live_adjustment_items")
    .select("trading_engine_id,slot_number,amount_quote,gain_units")
    .eq("batch_id", existing.id).order("trading_engine_id").order("slot_number");
  if (recorded.error || !recorded.data) throw new Error("COINOPS_ADJUSTMENT_LEDGER_UNAVAILABLE");
  const expected = input.kind === "MANUAL_GAIN"
    ? [{ engineId: input.engineId, slotNumber: input.slotNumber, amount: 0, gainUnits: input.gainUnits }]
    : input.slotNumber !== undefined
      ? [{ engineId: input.engineId, slotNumber: input.slotNumber, amount: input.amount, gainUnits: 0 }]
      : allocateBulkSlots(exactCents(input.amount), input.shares ?? []).map((item) => ({ ...item, gainUnits: 0 }));
  const sorted = expected.sort((a, b) => String(a.engineId).localeCompare(String(b.engineId))
    || Number(a.slotNumber) - Number(b.slotNumber));
  if (recorded.data.length !== sorted.length || recorded.data.some((item, index) =>
    item.trading_engine_id !== sorted[index].engineId
    || item.slot_number !== sorted[index].slotNumber
    || Number(item.amount_quote) !== sorted[index].amount
    || Number(item.gain_units) !== sorted[index].gainUnits))
    throw new Error("COINOPS_ADJUSTMENT_REPLAY_CONFLICT");
}

async function changeCaps(scope: Scope, state: Awaited<ReturnType<typeof inspect>>,
  allocations: Array<{ engineId: string; amount: number }>, targetAccountCap: number) {
  const list = state.engines.map((engine) => ({ trading_engine_id: engine.id, symbol: engine.symbol,
    expected_hard_cap_quote: Number(engine.hard_cap_quote),
    target_hard_cap_quote: Number((Number(engine.hard_cap_quote)
      + allocations.filter((item) => item.engineId === engine.id)
        .reduce((sum, item) => sum + item.amount, 0)).toFixed(2)) }));
  return operatorExecutorAdmin<{ status: string }>("/v1/admin/capital", {
    operator_id: scope.operator.id, exchange_account_id: state.account.id,
    credential_ref: state.account.credential_ref, environment: "REAL", quote_asset: state.engines[0].quote_asset,
    expected_account_cap_quote: state.cap, target_account_cap_quote: targetAccountCap,
    engines: list,
  }, "CAPITAL");
}

async function syncRecordedCaps(scope: Scope, accountId: string, quote: "BRL" | "USDT",
  originalId: string, reversal: boolean) {
  const loaded = await loadAccount(scope, accountId, quote);
  const items = await scope.service.from("robot_v1_live_adjustment_items")
    .select("trading_engine_id,amount_quote").eq("batch_id", originalId);
  if (items.error || !items.data?.length) throw new Error("COINOPS_ADJUSTMENT_CAP_SYNC_PENDING");
  const changes = new Map<string, number>();
  for (const item of items.data) changes.set(item.trading_engine_id,
    (changes.get(item.trading_engine_id) ?? 0) + Number(item.amount_quote));
  const delta = [...changes.values()].reduce((sum, value) => sum + value, 0);
  const sign = reversal ? 1 : -1;
  const result = await operatorExecutorAdmin<{ status: string }>("/v1/admin/capital", {
    operator_id: scope.operator.id, exchange_account_id: accountId,
    credential_ref: loaded.account.credential_ref, environment: "REAL", quote_asset: quote,
    expected_account_cap_quote: Number((loaded.cap + sign * delta).toFixed(2)),
    target_account_cap_quote: loaded.cap,
    engines: loaded.engines.map((engine) => ({ trading_engine_id: engine.id, symbol: engine.symbol,
      expected_hard_cap_quote: Number((Number(engine.hard_cap_quote)
        + sign * (changes.get(engine.id) ?? 0)).toFixed(2)),
      target_hard_cap_quote: Number(engine.hard_cap_quote) })),
  }, "CAPITAL");
  if (result.status !== "UPDATED") throw new Error("COINOPS_ADJUSTMENT_CAP_SYNC_PENDING");
}

export async function GET() {
  try {
    const scope = await adminScope();
    const [accounts, engines, caps, runs, slotAccounts, slots, totals, batches, plans] = await Promise.all([
      scope.service.from("exchange_accounts").select("id,display_name,status,is_legacy_default")
        .eq("operator_id", scope.operator.id).eq("status", "ACTIVE").order("display_name"),
      scope.service.from("trading_engines")
        .select("id,exchange_account_id,symbol,quote_asset,base_asset,status,hard_cap_quote")
        .eq("operator_id", scope.operator.id).eq("environment", "REAL").order("symbol"),
      scope.service.from("account_quote_caps").select("exchange_account_id,quote_asset,hard_cap_quote")
        .eq("operator_id", scope.operator.id),
      scope.service.from("robot_v1_live_runs").select("id,trading_engine_id,status,last_reconciled_at,last_error")
        .eq("operator_id", scope.operator.id).in("status", ["ACTIVE", "PAUSED"]),
      scope.service.from("robot_v1_live_slot_accounts")
        .select("trading_engine_id,slot_number,balance_quote,contribution_quote,market_pnl_quote,fees_quote,gain_count")
        .eq("operator_id", scope.operator.id),
      scope.service.from("robot_v1_live_slots")
        .select("run_id,trading_engine_id,slot_number,entry_state,position_committed_brl")
        .eq("operator_id", scope.operator.id),
      scope.service.from("robot_v1_slot_gain_totals")
        .select("trading_engine_id,slot_number,lifetime_gain_count,monthly_gain_count")
        .eq("operator_id", scope.operator.id).eq("environment", "REAL"),
      scope.service.from("robot_v1_live_adjustment_batches")
        .select("id,exchange_account_id,kind,quote_asset,origin_currency,origin_amount,amount_quote,reason,reversal_of,created_at")
        .eq("operator_id", scope.operator.id).order("created_at", { ascending: false }).limit(1000),
      scope.service.from("robot_v1_live_contribution_plans")
        .select("id,exchange_account_id,quote_asset,revision,status,origin_currency,monthly_amount_origin,btc_percent,sol_percent,start_month,horizon_months,reason,created_at")
        .eq("operator_id", scope.operator.id).order("created_at", { ascending: false }).limit(100),
    ]);
    if ([accounts, engines, caps, runs, slotAccounts, slots, totals, batches, plans].some((item) => item.error)
      || batches.data?.length === 1000 || plans.data?.length === 100)
      throw new Error("COINOPS_ADJUSTMENT_STATUS_UNAVAILABLE");
    const currentRunIds = new Set((runs.data ?? []).map((run) => run.id));
    return json({ accounts: accounts.data, engines: engines.data, caps: caps.data,
      runs: runs.data, slotAccounts: slotAccounts.data,
      slots: (slots.data ?? []).filter((slot) => currentRunIds.has(slot.run_id)),
      totals: totals.data, batches: batches.data, plans: plans.data });
  } catch { return json({ error: "COINOPS_ADJUSTMENT_ADMIN_UNAVAILABLE" }, 403); }
}

export async function POST(request: NextRequest) {
  try {
    sameOrigin(request);
    const raw = await request.text();
    if (Buffer.byteLength(raw) > 8192) throw new Error("COINOPS_ADJUSTMENT_BODY_TOO_LARGE");
    const input = JSON.parse(raw) as Draft;
    if (!input || !["PREVIEW", "CONFIRM", "REVERSE_PREVIEW", "REVERSE_CONFIRM", "PLAN_SAVE", "PLAN_DISABLE"].includes(input.action))
      throw new Error("COINOPS_ADJUSTMENT_ACTION_INVALID");
    inputGuard(input);
    const scope = await adminScope();
    if (input.action === "PLAN_SAVE" || input.action === "PLAN_DISABLE") {
      await loadAccount(scope, input.accountId, input.quote);
      const amount = exactCents(input.monthlyAmount);
      if (!Number.isInteger(input.btcPercent) || input.btcPercent! < 0 || input.btcPercent! > 100
        || !Number.isInteger(input.horizonMonths) || input.horizonMonths! < 1 || input.horizonMonths! > 120
        || !/^\d{4}-(0[1-9]|1[0-2])-01$/.test(input.startMonth ?? "")
        || !["BRL", "USDT"].includes(input.originCurrency ?? ""))
        throw new Error("COINOPS_CONTRIBUTION_PLAN_INPUT_DENIED");
      const saved = await scope.service.rpc("save_live_contribution_plan", {
        p_operator_id: scope.operator.id, p_account_id: input.accountId,
        p_created_by: scope.operator.user_id, p_quote_asset: input.quote,
        p_action: input.action === "PLAN_SAVE" ? "ACTIVE" : "DISABLED",
        p_origin_currency: input.originCurrency, p_monthly_amount_origin: amount,
        p_btc_percent: input.btcPercent, p_start_month: input.startMonth,
        p_horizon_months: input.horizonMonths, p_reason: input.reason.trim(),
        p_request_id: input.requestId,
      });
      if (saved.error || !saved.data) throw new Error(saved.error?.message ?? "COINOPS_CONTRIBUTION_PLAN_FAILED");
      return json({ ...saved.data, noExchangeWrite: true, noLedgerContribution: true });
    }
    if (input.action === "PREVIEW" || input.action === "CONFIRM") {
      if (input.action === "CONFIRM") {
        const existing = await existingBatch(scope, input.accountId, input.requestId);
        if (existing) {
          await verifyReplay(scope, input, existing);
          if (existing.kind === "CAPITAL")
            await syncRecordedCaps(scope, input.accountId, input.quote, existing.id, false);
          return json({ status: "REPLAYED", id: existing.id });
        }
      }
      const result = await preview(scope, input);
      if (input.action === "PREVIEW") return json(result);
      if (!input.previewHash || input.previewHash !== result.previewHash)
        throw new Error("COINOPS_ADJUSTMENT_PREVIEW_STALE");
      const state = await inspect(scope, input.accountId, input.quote);
      const fxRate = result.fxReference ? Number(result.fxReference.effectiveRate.toFixed(8)) : null;
      const evidence = result.fxReference
        ? `${result.evidence}; ${result.fxReference.source}; USDTBRL=${result.fxReference.referenceRate}; observed_at=${result.fxReference.observedAt}`
        : result.evidence;
      const saved = await scope.service.rpc("apply_live_operator_adjustment", {
        p_operator_id: scope.operator.id, p_account_id: input.accountId,
        p_created_by: scope.operator.user_id, p_kind: input.kind,
        p_quote_asset: input.quote, p_origin_currency: result.originCurrency,
        p_origin_amount: result.origin, p_amount_quote: result.amount,
        p_fx_rate: fxRate, p_fx_observed_at: result.fxReference?.observedAt ?? null,
        p_evidence: evidence, p_reason: result.reason,
        p_allocations: result.allocations.map((item) => ({ engineId: item.engineId,
          slotNumber: item.slotNumber, amount: item.amount, gainUnits: item.gainUnits,
          balanceBefore: item.balanceBefore, operationSequence: item.operationSequence,
          monthlyBefore: item.monthlyBefore, lifetimeBefore: item.lifetimeBefore })),
        p_expected_account_cap: result.accountCap, p_request_id: input.requestId,
      });
      if (saved.error || !saved.data) throw new Error(saved.error?.message ?? "COINOPS_ADJUSTMENT_APPLY_FAILED");
      if (input.kind === "CAPITAL") {
        try {
          const changed = await changeCaps(scope, state, result.allocations, result.afterCap);
          if (changed.status !== "UPDATED") throw new Error("COINOPS_ADJUSTMENT_CAP_SYNC_PENDING");
        } catch { throw new Error("COINOPS_ADJUSTMENT_CAP_SYNC_PENDING"); }
      }
      revalidatePath("/automacao"); revalidatePath("/relatorios");
      return json(saved.data);
    }
    if (!isIdentity(input.originalId)) throw new Error("COINOPS_ADJUSTMENT_REVERSAL_INVALID");
    const original = await scope.service.from("robot_v1_live_adjustment_batches")
      .select("id,exchange_account_id,kind,quote_asset,origin_amount,amount_quote,reversal_of")
      .eq("id", input.originalId).eq("operator_id", scope.operator.id)
      .eq("exchange_account_id", input.accountId).single();
    if (original.error || !original.data || original.data.kind === "REVERSAL"
      || original.data.quote_asset !== input.quote)
      throw new Error("COINOPS_ADJUSTMENT_REVERSAL_INVALID");
    const reversed = await scope.service.from("robot_v1_live_adjustment_batches")
      .select("id,request_id,reason").eq("reversal_of", input.originalId).maybeSingle();
    if (reversed.error) throw new Error("COINOPS_ADJUSTMENT_LEDGER_UNAVAILABLE");
    if (reversed.data) {
      if (input.action !== "REVERSE_CONFIRM" || reversed.data.request_id !== input.requestId
        || reversed.data.reason !== input.reason.trim())
        throw new Error("COINOPS_ADJUSTMENT_ALREADY_REVERSED");
      if (original.data.kind === "CAPITAL")
        await syncRecordedCaps(scope, input.accountId, input.quote, input.originalId!, true);
      return json({ status: "REPLAYED", id: reversed.data.id });
    }
    const state = await inspect(scope, input.accountId, input.quote);
    const items = await scope.service.from("robot_v1_live_adjustment_items")
      .select("trading_engine_id,slot_number,amount_quote,gain_units,operation_sequence,created_at")
      .eq("batch_id", input.originalId).order("slot_number");
    if (items.error || !items.data?.length) throw new Error("COINOPS_ADJUSTMENT_REVERSAL_INVALID");
    const after = items.data.map((item) => {
      const current = allocationInput(state, item.trading_engine_id, item.slot_number, 0, 0);
      if (current.operationSequence !== item.operation_sequence
        || current.balanceBefore < Number(item.amount_quote)
        || current.lifetimeBefore < Number(item.gain_units))
        throw new Error("COINOPS_ADJUSTMENT_REVERSAL_COMMITTED");
      return { ...current, delta: -Number(item.amount_quote), gainUnits: -Number(item.gain_units) };
    });
    const previewPayload = { accountId: input.accountId, originalId: input.originalId,
      reason: input.reason.trim(), requestId: input.requestId, cap: state.cap,
      free: state.free, after };
    const previewHash = fingerprint(previewPayload);
    if (input.action === "REVERSE_PREVIEW")
      return json({ ...previewPayload, previewHash, noExchangeWrite: true });
    if (input.previewHash !== previewHash) throw new Error("COINOPS_ADJUSTMENT_PREVIEW_STALE");
    const applied = await scope.service.rpc("reverse_live_operator_adjustment", {
      p_operator_id: scope.operator.id, p_account_id: input.accountId,
      p_created_by: scope.operator.user_id, p_original_id: input.originalId,
      p_reason: input.reason.trim(), p_request_id: input.requestId,
    });
    if (applied.error || !applied.data) throw new Error(applied.error?.message ?? "COINOPS_ADJUSTMENT_REVERSAL_FAILED");
    if (original.data.kind === "CAPITAL") {
      try { await syncRecordedCaps(scope, input.accountId, input.quote, input.originalId!, true); }
      catch { throw new Error("COINOPS_ADJUSTMENT_CAP_SYNC_PENDING"); }
    }
    revalidatePath("/automacao"); revalidatePath("/relatorios");
    return json(applied.data);
  } catch (error) {
    const code = error instanceof Error && /^(?:COINOPS|EXECUTOR|APORTE)_[A-Z0-9_]+$/.test(error.message)
      ? error.message : "COINOPS_ADJUSTMENT_FAILED";
    return json({ error: code }, code.includes("AUTH") ? 401 : code.includes("UNAVAILABLE") ? 503 : 403);
  }
}
