import { MONTHLY_SLOT_TARGET } from "../../lib/execution/monthly-slot-policy.ts";
import { reconcileV1PhysicalSlotAccounts, summarizeV1ShadowOperations } from "../../lib/execution/robot-v1-audit.ts";
import { summarizeTestnetLedgerTotals, summarizeTestnetResults, testnetDiagnosticIssue, testnetPresentationHealth } from "../../lib/slotgain/testnet-results.ts";
import { selectTestnetAssetData } from "../../lib/slotgain/testnet-asset-view.ts";
import type { Props } from "./automation-mobile";

/** Read-only view models. They never produce strategy decisions or dispatch actions. */
export type PremiumEnvironment = "REAL" | "SHADOW" | "TESTNET";
export type PremiumHealth = { tone: "ok" | "attention" | "error"; label: string; reason: string; healthy: boolean };
export type PremiumEvent = { id: string; type: string; slotNumber: number | null; at: string; details: Record<string, unknown> };
export type PremiumOrder = {
  id: string; exchangeId: string | null; slotNumber: number; side: string; purpose: string; status: string;
  price: number | null; quantity: number | null; executedQuantity: number | null; quote: number | null;
  at: string | null; resident: boolean; raw: unknown;
};
export type PremiumSlot = {
  number: number; physicalId: string | null; rank: number | null; group: string | null; groupRank: number | null;
  state: string; label: string; tone: "open" | "armed" | "planned" | "warning" | "error" | "closed";
  entryPrice: number | null; currentPrice: number | null; tpPrice: number | null; quantity: number | null;
  balance: number | null; committed: number | null; reserved: number | null; realizedPnl: number | null;
  openPnl: number | null; fees: number | null; gains: number | null; monthlyGains: number | null; goal: number;
  targetReached: boolean; eligible: boolean | null; operationSequence: number | null; nextAction: string;
  orders: PremiumOrder[]; events: PremiumEvent[]; historicalCount: number; raw: unknown;
};
export type PremiumAsset = {
  asset: "BTC" | "SOL"; symbol: string; currency: string; environment: PremiumEnvironment;
  price: number | null; capital: number | null; committed: number | null; reserved: number | null;
  exposure: number | null; freeCapital: number | null; realizedPnl: number | null; openPnl: number | null;
  fees: number | null; gains: number | null; monthlyGains: number | null; goal: number; regime: string | null;
  gainRate: number | null; spacingRate: number | null; cap: number | null; health: PremiumHealth;
  status: string; lastCheck: string | null; cycleId: string | null; slots: PremiumSlot[];
  orders: PremiumOrder[]; events: PremiumEvent[]; alerts: Array<{ code: string; severity: string; at: string | null }>;
  openCount: number; nextCount: number; plannedCount: number; tpCount: number;
  historicalCount: number; activeIssueCount: number; raw: unknown;
};

const ACTIVE_ORDERS = new Set(["PREPARED", "NEW", "PARTIALLY_FILLED"]);
const ACTIVE_CYCLES = new Set(["STARTING", "GRID_ACTIVE", "POSITIONS_ACTIVE", "RESETTING"]);
const OPEN_SHADOW = new Set(["OPEN", "TP_ACTIVE", "PARTIALLY_FILLED"]);
const number = (value: unknown): number | null => value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);
const sum = (values: Array<number | null>): number | null => values.some((value) => value === null) ? null : values.reduce<number>((total, value) => total + (value ?? 0), 0);
const add = (left: number | null, right: number | null) => left === null || right === null ? null : left + right;
const difference = (left: number | null, right: number | null) => left === null || right === null ? null : left - right;
const fresh = (at: string | null | undefined, now: number, maxAge = 180_000) => Boolean(at && Number.isFinite(Date.parse(at)) && now - Date.parse(at) >= -60_000 && now - Date.parse(at) <= maxAge);
const rawField = (row: unknown, key: string): unknown => row && typeof row === "object" ? (row as Record<string, unknown>)[key] : undefined;
const rawText = (row: unknown, key: string): string | null => typeof rawField(row, key) === "string" ? rawField(row, key) as string : null;

function slotState(state: string, reached = false): Pick<PremiumSlot, "state" | "label" | "tone" | "nextAction"> {
  if (state === "OPEN") return { state, label: "ABERTO", tone: "open", nextAction: "Aguardar TP" };
  if (state === "NEXT_BUY" || state === "ARMED") return { state: "NEXT_BUY", label: "PRÓXIMA BUY", tone: "armed", nextAction: "Aguardar fill" };
  if (state === "ACTIVE_ERROR" || state === "ERROR") return { state: "ACTIVE_ERROR", label: "REVISAR", tone: "error", nextAction: "Auditar ocorrência" };
  if (reached) return { state: "TARGET_REACHED", label: "META BATIDA", tone: "warning", nextAction: "Aguardar próximo mês" };
  if (state === "REENTRY_WAITING" || state === "CLOSED") return { state: "REENTRY_WAITING", label: "REENTRADA", tone: "planned", nextAction: "Aguardar preço / reentrada" };
  if (state === "MISSED") return { state, label: "NÍVEL ATRAVESSADO", tone: "warning", nextAction: "Consultar evidência" };
  return { state: "PLANNED", label: "PLANEJADO", tone: "planned", nextAction: "Aguardar sua vez" };
}

function normalizeOrder(row: {
  client_order_id: string; exchange_order_id: string | null; slot_number: number; side: string; purpose: string;
  status: string; price: number | string | null; requested_quantity: number | string | null;
  executed_quantity: number | string; cumulative_quote: number | string;
}): PremiumOrder {
  const quantity = number(row.executed_quantity), quote = number(row.cumulative_quote);
  return { id: row.client_order_id, exchangeId: row.exchange_order_id, slotNumber: row.slot_number,
    side: row.side, purpose: row.purpose, status: row.status,
    price: number(row.price) ?? (quantity && quote !== null ? quote / quantity : null),
    quantity: number(row.requested_quantity) ?? quantity, executedQuantity: quantity, quote,
    at: rawText(row, "updated_at") ?? rawText(row, "created_at"),
    resident: ["NEW", "PARTIALLY_FILLED"].includes(row.status) && Boolean(row.exchange_order_id), raw: row };
}

function eventsFor(rows: Array<{ event_type: string; slot_number: number | null; observed_at: string; details: Record<string, unknown> }>): PremiumEvent[] {
  return rows.map((row, index) => ({ id: `${row.observed_at}:${row.event_type}:${row.slot_number}:${index}`,
    type: row.event_type, slotNumber: row.slot_number, at: row.observed_at, details: row.details }));
}

function emptyAsset(asset: "BTC" | "SOL", environment: PremiumEnvironment): PremiumAsset {
  return { asset, symbol: `${asset}${environment === "REAL" ? "BRL" : "USDC"}`, currency: environment === "REAL" ? "BRL" : "USDC", environment,
    price: null, capital: null, committed: null, reserved: null, exposure: null, freeCapital: null, realizedPnl: null,
    openPnl: null, fees: null, gains: null, monthlyGains: null, goal: MONTHLY_SLOT_TARGET[asset], regime: null,
    gainRate: null, spacingRate: null, cap: null,
    health: { healthy: false, tone: "attention", label: "SEM EVIDÊNCIA", reason: "Sem ciclo e ledger disponíveis neste ambiente." },
    status: "NOT_STARTED", lastCheck: null, cycleId: null, slots: [], orders: [], events: [], alerts: [],
    openCount: 0, nextCount: 0, plannedCount: 0, tpCount: 0, historicalCount: 0, activeIssueCount: 0, raw: null };
}

function liveAsset(data: Props, asset: "BTC" | "SOL", now: number): PremiumAsset {
  const base = emptyAsset(asset, "REAL"), live = data.liveAssetData?.[asset];
  const config = data.livePreparation?.configs.find((row) => row.asset === asset);
  const sizing = data.livePreparation?.sizing.find((row) => row.asset === asset);
  const price = number(sizing?.priceBrl);
  base.price = price; base.cap = number(config?.max_total_exposure_brl); base.regime = config?.regime ?? null;
  if (!live) return base;
  const orders = live.orders.map(normalizeOrder), events = eventsFor(live.events);
  const slots = live.slots.map((row): PremiumSlot => {
    const account = live.accounts.find((item) => item.slot_number === row.slot_number);
    const monthly = live.monthlyGains.find((item) => item.slot_number === row.slot_number);
    const gains = number(monthly?.lifetime_gain_count ?? account?.gain_count);
    const month = number(monthly?.monthly_gain_count) ?? (gains === 0 ? 0 : null);
    const slotOrders = orders.filter((item) => item.slotNumber === row.slot_number);
    const tp = slotOrders.find((item) => item.side === "SELL" && item.resident);
    const buys = slotOrders.filter((item) => item.side === "BUY" && ACTIVE_ORDERS.has(item.status));
    const reserved = sum(buys.map((item) => {
      const intended = number(rawField(item.raw, "reserved_notional_brl"))
        ?? number(rawField(item.raw, "requested_quote"))
        ?? (item.quantity !== null && item.price !== null ? item.quantity * item.price : null);
      return intended === null || item.quote === null ? null : Math.max(0, intended - item.quote);
    }));
    const committed = number(row.position_committed_brl), quantity = number(row.position_quantity);
    const marketPnl = number(account?.market_pnl_brl), fees = number(account?.fees_brl);
    const open = row.entry_state === "OPEN";
    // The ledger's committed amount includes the actual entry cost. Use the
    // last filled BUY for displayed entry price; target_buy_price is an intention.
    const filledBuy = [...slotOrders].reverse().find((item) => item.side === "BUY" && (item.executedQuantity ?? 0) > 0);
    const entry = open && filledBuy?.executedQuantity && filledBuy.quote !== null ? filledBuy.quote / filledBuy.executedQuantity : number(row.target_buy_price);
    return { number: row.slot_number, physicalId: null, rank: row.operational_rank,
      group: row.post_ath_group, groupRank: row.post_ath_group_rank,
      ...slotState(row.entry_state, month !== null && month >= base.goal), entryPrice: entry, currentPrice: price,
      tpPrice: tp?.price ?? null, quantity, balance: number(account?.balance_brl), committed, reserved,
      realizedPnl: difference(marketPnl, fees), fees, openPnl: open ? price === null || quantity === null || committed === null ? null : quantity * price - committed : 0,
      gains, monthlyGains: month, goal: base.goal, targetReached: month !== null && month >= base.goal,
      eligible: month === null ? null : month < base.goal, operationSequence: row.operation_sequence,
      orders: slotOrders, events: events.filter((item) => item.slotNumber === row.slot_number), historicalCount: 0,
      raw: { slot: row, account, monthly } };
  });
  const committed = sum(slots.map((slot) => slot.committed)), reserved = sum(slots.map((slot) => slot.reserved));
  const capital = live.accounts.length ? sum(live.accounts.map((row) => number(row.balance_brl))) : null;
  const quantityStep = number(sizing?.rules?.quantityStep);
  const unprotected = slots.filter((slot) => {
    if (slot.state !== "OPEN") return false;
    const tps = slot.orders.filter((order) => order.side === "SELL" && order.resident);
    if (tps.length !== 1 || slot.quantity === null || tps[0].quantity === null || tps[0].executedQuantity === null) return true;
    const remaining = tps[0].quantity - tps[0].executedQuantity;
    // Exchange rounding can leave dust below one official LOT_SIZE step. A
    // display check must not call that dust an unprotected executable position.
    return remaining > slot.quantity + 1e-10
      || slot.quantity - remaining >= (quantityStep ?? 1e-10) + 1e-10;
  }).length;
  const nextCount = orders.filter((order) => order.side === "BUY" && order.resident).length;
  const invariantFailed = slots.length !== 25 || new Set(slots.map((slot) => slot.number)).size !== 25
    || live.accounts.length !== 25 || slots.some((slot) => slot.number < 1 || slot.number > 25);
  const exposure = add(committed, reserved);
  const capExceeded = exposure !== null && base.cap !== null && exposure > base.cap + 1e-8;
  const missedCount = live.slots.filter((slot) => slot.missed_at).length;
  const activeIssue = Boolean(live.run.last_error) || live.alerts.length > 0 || unprotected > 0 || nextCount > 1 || invariantFailed || capExceeded;
  const executorActive = data.livePreparation?.executor?.gate === "LIVE_EXECUTOR_ACTIVE";
  const paused = rawField(config, "kill_switch") === true || config?.live_enabled === false;
  const healthy = !activeIssue && !paused && executorActive && live.run.status === "ACTIVE"
    && fresh(live.run.last_reconciled_at, now) && missedCount === 0;
  return { ...base, price, capital, committed, reserved, exposure: add(committed, reserved),
    freeCapital: difference(capital, add(committed, reserved)), realizedPnl: live.accounts.length ? sum(slots.map((slot) => slot.realizedPnl)) : null,
    fees: live.accounts.length ? sum(slots.map((slot) => slot.fees)) : null, openPnl: sum(slots.map((slot) => slot.openPnl)),
    gains: slots.length ? sum(slots.map((slot) => slot.gains)) : null, monthlyGains: slots.length ? sum(slots.map((slot) => slot.monthlyGains)) : null,
    regime: live.run.entry_regime, gainRate: number(live.run.gain_rate), spacingRate: number(live.run.entry_spacing),
    health: { healthy, tone: activeIssue ? "error" : healthy ? "ok" : "attention", label: activeIssue ? "REVISAR LIVE" : healthy ? "OPERACIONAL" : "EM ACOMPANHAMENTO",
      reason: live.run.last_error || (unprotected ? `${unprotected} posição com cobertura de TP a verificar.`
        : live.alerts.length ? "Alertas ativos no ledger." : invariantFailed ? "Evidência dos 25 slots e contas incompleta."
          : capExceeded ? "Exposição acima do hard cap configurado." : nextCount > 1 ? "Mais de uma BUY residente."
            : paused ? "Novas entradas protegidas pelo controle do ativo." : !executorActive ? "Executor LIVE sem confirmação operacional atual."
              : missedCount ? "Níveis atravessados requerem consulta à auditoria." : healthy ? "Ciclo reconciliado; posições protegidas." : "Estado atual requer evidência recente.") },
    status: live.run.status, lastCheck: live.run.last_reconciled_at, cycleId: live.run.id, slots, orders, events,
    alerts: live.alerts.map((row) => ({ code: row.code, severity: row.severity, at: row.last_seen_at })),
    openCount: slots.filter((slot) => slot.state === "OPEN").length, nextCount,
    plannedCount: live.slots.filter((slot) => slot.entry_state === "PLANNED").length,
    tpCount: orders.filter((order) => order.side === "SELL" && order.resident).length,
    activeIssueCount: live.alerts.length + unprotected + (live.run.last_error ? 1 : 0) + (invariantFailed ? 1 : 0) + (capExceeded ? 1 : 0) + (nextCount > 1 ? 1 : 0), raw: live };
}

function testnetAsset(data: Props, asset: "BTC" | "SOL", now: number): PremiumAsset {
  const base = emptyAsset(asset, "TESTNET"), selected = selectTestnetAssetData(data, asset), run = selected.testnetRun;
  if (!run) return base;
  const probe = data.testnet?.ok ? data.testnet.probes.find((row) => row.symbol === run.symbol) : null;
  const price = probe?.available ? number(probe.market.price) : null;
  const result = summarizeTestnetResults(selected.testnetSlots, selected.testnetOrders, price, number(run.slot_notional_usdc), { asset, cycleId: run.id, events: selected.testnetEvents });
  const health = testnetPresentationHealth(result, run, now, testnetDiagnosticIssue(data.testnet, data.testnetActionError));
  const ledger = summarizeTestnetLedgerTotals({ cycleId: run.id, slots: selected.testnetSlots }, (selected.testnetHistory || []).map((row) => ({ cycleId: row.run.id, slots: row.slots })));
  const monthly = (data.monthlyGoals || []).filter((row) => row.environment === "TESTNET" && row.asset === asset);
  const orders = selected.testnetOrders.map(normalizeOrder), events = eventsFor(selected.testnetEvents);
  const slots = result.rows.map((row): PremiumSlot => {
    const goal = monthly.find((item) => item.physicalSlotNumber === row.slot_number);
    const history = ledger.rows.filter((item) => item.slot_number === row.slot_number);
    return { number: row.slot_number, physicalId: goal?.physicalSlotId ?? null,
      rank: number(rawField(row, "operational_rank")) ?? goal?.operationalRank ?? null,
      group: rawText(row, "post_ath_group"), groupRank: number(rawField(row, "post_ath_group_rank")),
      ...slotState(row.operationalState, goal?.monthlyTargetReached), entryPrice: row.entryPrice,
      currentPrice: price, tpPrice: row.hasResidentTp ? row.takeProfitPrice : null, quantity: row.closed ? 0 : row.remainingQuantity,
      balance: row.balance, committed: row.positionCapital, reserved: row.reservedBuyCapital,
      realizedPnl: sum(history.map((item) => item.realizedProfit)), openPnl: row.openPnl,
      fees: row.hasUnknownFees ? null : row.feesQuote, gains: goal?.lifetimeGainCount ?? sum(history.map((item) => item.gains)),
      monthlyGains: goal?.monthlyGainCount ?? null, goal: base.goal, targetReached: goal?.monthlyTargetReached ?? false,
      eligible: goal?.eligibleForNewEntry ?? null, operationSequence: row.operation_sequence ?? null,
      orders: orders.filter((item) => item.slotNumber === row.slot_number), events: events.filter((item) => item.slotNumber === row.slot_number),
      historicalCount: row.historicalOccurrences.length, raw: { slot: row, monthly: goal } };
  });
  return { ...base, price, capital: slots.length ? result.capital : null,
    committed: slots.length ? result.committedCapital - result.reservedBuyCapital : null,
    reserved: slots.length ? result.reservedBuyCapital : null, exposure: slots.length ? result.committedCapital : null,
    freeCapital: slots.length ? result.freeCapital : null, realizedPnl: slots.length ? ledger.realizedProfit : null,
    openPnl: slots.length ? result.openPnl : null, fees: slots.length ? sum(slots.map((row) => row.fees)) : null,
    gains: slots.length ? sum(slots.map((row) => row.gains)) : null, monthlyGains: slots.length ? sum(slots.map((row) => row.monthlyGains)) : null,
    regime: rawText(run, "entry_regime"), gainRate: number(run.gain_rate), spacingRate: number(run.entry_spacing),
    health: health.healthy ? { ...health, reason: "Estado Testnet reconciliado; fundos fictícios isolados." } : health,
    status: run.status, lastCheck: run.last_reconciled_at, cycleId: run.id, slots, orders, events,
    alerts: run.last_error ? [{ code: run.last_error, severity: "ERROR", at: run.last_reconciled_at }] : [],
    openCount: result.openSlots, nextCount: result.armedSlots, plannedCount: result.plannedSlots,
    tpCount: orders.filter((row) => row.side === "SELL" && row.resident).length,
    historicalCount: result.temporalSummary.historicalCount, activeIssueCount: result.temporalSummary.activeIssueCount + result.activeErrorSlots,
    raw: { ...selected, result, ledger } };
}

function shadowAsset(data: Props, asset: "BTC" | "SOL", now: number): PremiumAsset {
  const base = emptyAsset(asset, "SHADOW"), config = data.configs.find((row) => row.asset === asset && row.execution_mode === "SHADOW");
  if (!config) return base;
  const cycles = data.cycles.filter((row) => row.config_id === config.id), cycle = cycles.find((row) => ACTIVE_CYCLES.has(row.status));
  const currentSlots = data.slots.filter((row) => row.cycle_id === cycle?.id), accounts = data.slotAccounts.filter((row) => row.config_id === config.id);
  const testCycles = new Set(cycles.filter((row) => !config.shadow_test_started_at || Date.parse(row.started_at) >= Date.parse(config.shadow_test_started_at)).map((row) => row.id));
  const operations = data.operations.filter((row) => testCycles.has(row.cycle_id));
  const accounting = summarizeV1ShadowOperations(operations.map((row) => ({ grossQuotePnl: row.gross_quote_pnl, estimatedQuoteFees: row.estimated_quote_fees, netQuotePnl: row.net_quote_pnl })));
  const monthly = (data.monthlyGoals || []).filter((row) => row.environment === "SHADOW" && row.asset === asset);
  const price = number(config.last_market_price);
  const events: PremiumEvent[] = data.events.filter((row) => testCycles.has(row.cycle_id)).map((row, index) => ({
    id: `${row.cycle_id}:${row.observed_at}:${index}`, type: row.event_type, at: row.observed_at,
    slotNumber: data.slots.find((slot) => slot.id === row.slot_id)?.slot_number ?? number(row.next_state?.slotNumber), details: row.next_state || {} }));
  const orders: PremiumOrder[] = currentSlots.flatMap((row) => {
    const open = OPEN_SHADOW.has(row.status), armed = row.status === "PENDING" && row.entry_state === "ARMED";
    const buy: PremiumOrder = { id: row.buy_client_order_id, exchangeId: null, slotNumber: row.slot_number,
      side: "BUY", purpose: row.operation_sequence > 1 ? "REENTRY" : row.slot_number === 1 ? "INITIAL" : "ENTRY",
      status: open ? "FILLED" : armed ? "ARMED" : row.status, price: number(row.average_fill_price ?? row.buy_price),
      quantity: number(row.requested_quantity), executedQuantity: number(row.executed_quantity),
      quote: number(row.executed_quantity) !== null && number(row.average_fill_price) !== null ? Number(row.executed_quantity) * Number(row.average_fill_price) : null,
      at: row.buy_triggered_at ?? row.armed_at, resident: false, raw: row };
    return [buy, ...(row.sell_client_order_id ? [{ id: row.sell_client_order_id, exchangeId: null,
      slotNumber: row.slot_number, side: "SELL", purpose: "TP", status: open ? "VIRTUAL_TP" : row.status,
      price: number(row.take_profit_price), quantity: number(row.executed_quantity), executedQuantity: null,
      quote: null, at: row.tp_triggered_at, resident: false, raw: row } satisfies PremiumOrder] : [])];
  });
  const slots = currentSlots.map((row): PremiumSlot => {
    const account = accounts.find((item) => item.slot_number === row.slot_number), goal = monthly.find((item) => item.physicalSlotNumber === row.slot_number);
    const open = OPEN_SHADOW.has(row.status), armed = row.status === "PENDING" && row.entry_state === "ARMED";
    const quantity = open ? number(row.executed_quantity) : 0, entry = number(row.average_fill_price ?? row.buy_price);
    const committed = open ? quantity === null || entry === null ? null : quantity * entry : 0;
    const reserved = armed ? number(row.requested_quantity) === null || number(row.buy_price) === null ? null : Number(row.requested_quantity) * Number(row.buy_price) : 0;
    return { number: row.slot_number, physicalId: goal?.physicalSlotId ?? `SHADOW:${config.id}:${row.slot_number}`,
      rank: number(rawField(row, "operational_rank")) ?? goal?.operationalRank ?? null,
      group: rawText(row, "post_ath_group"), groupRank: number(rawField(row, "post_ath_group_rank")),
      ...slotState(open ? "OPEN" : armed ? "NEXT_BUY" : row.missed_at ? "MISSED" : row.operation_sequence > 1 ? "REENTRY_WAITING" : "PLANNED", goal?.monthlyTargetReached),
      entryPrice: entry, currentPrice: price, tpPrice: number(row.take_profit_price), quantity,
      balance: number(account?.balance_usdc), committed, reserved, realizedPnl: number(account?.net_profit_usdc),
      openPnl: open ? price === null || quantity === null || committed === null ? null : quantity * price - committed : 0,
      fees: number(account?.fees_usdc), gains: goal?.lifetimeGainCount ?? number(account?.gain_count),
      monthlyGains: goal?.monthlyGainCount ?? null, goal: base.goal, targetReached: goal?.monthlyTargetReached ?? false,
      eligible: goal?.eligibleForNewEntry ?? null, operationSequence: row.operation_sequence,
      orders: orders.filter((item) => item.slotNumber === row.slot_number), events: events.filter((item) => item.slotNumber === row.slot_number),
      historicalCount: 0, raw: { slot: row, account, monthly: goal, operations: operations.filter((item) => item.physical_slot_number === row.slot_number) } };
  });
  const committed = sum(slots.map((row) => row.committed)), reserved = sum(slots.map((row) => row.reserved));
  const capital = accounts.length ? sum(accounts.map((row) => number(row.balance_usdc))) : null;
  const activeIssue = Boolean(config.last_engine_error || config.grid_error || config.grid_status === "INVALID") || slots.some((row) => row.state === "MISSED");
  let accountingValid = false;
  try { accountingValid = reconcileV1PhysicalSlotAccounts(accounts, operations); } catch { /* malformed evidence remains attention */ }
  // Shadow is serviced by the five-minute market-regime cron, not the faster
  // exchange reconciler. Allow its normal cadence plus one minute of tolerance.
  const healthy = !activeIssue && Boolean(cycle) && !config.kill_switch && !config.pause_new_entries && accountingValid && config.grid_status === "VALID" && fresh(config.last_engine_at, now, 360_000);
  return { ...base, price, capital, committed: cycle ? committed : null, reserved: cycle ? reserved : null,
    exposure: cycle ? add(committed, reserved) : null, freeCapital: cycle ? difference(capital, add(committed, reserved)) : null,
    realizedPnl: accounts.length ? accounting.netProfit : null, fees: accounts.length ? accounting.estimatedFees : null,
    openPnl: cycle ? sum(slots.map((row) => row.openPnl)) : null,
    gains: accounts.length ? monthly.length === 25 ? sum(monthly.map((row) => row.lifetimeGainCount)) : sum(accounts.map((row) => number(row.gain_count))) : null,
    monthlyGains: monthly.length === 25 ? sum(monthly.map((row) => row.monthlyGainCount)) : null,
    regime: rawText(cycle, "entry_regime"), gainRate: number(cycle?.gain_rate ?? config.gain_rate), spacingRate: number(cycle?.entry_spacing ?? config.entry_spacing),
    health: { healthy, tone: activeIssue ? "error" : healthy ? "ok" : "attention",
      label: activeIssue ? "REVISAR MOTOR" : healthy ? "OPERACIONAL" : config.kill_switch ? "PROTEGIDO" : config.pause_new_entries ? "PAUSADO" : "EM ACOMPANHAMENTO",
      reason: config.last_engine_error || config.grid_error || (healthy ? "Simulação virtual consistente." : "Consulte o estado e a evidência do motor Shadow.") },
    status: cycle?.status ?? "NOT_STARTED", lastCheck: config.last_engine_at, cycleId: cycle?.id ?? null,
    slots, orders, events, alerts: config.last_engine_error ? [{ code: config.last_engine_error, severity: "ERROR", at: config.last_engine_at }] : [],
    openCount: slots.filter((row) => row.state === "OPEN").length, nextCount: slots.filter((row) => row.state === "NEXT_BUY").length,
    plannedCount: currentSlots.filter((row) => row.status === "PENDING" && row.entry_state !== "ARMED" && !row.missed_at).length,
    tpCount: currentSlots.filter((row) => OPEN_SHADOW.has(row.status) && row.take_profit_price !== null).length,
    activeIssueCount: (config.last_engine_error ? 1 : 0) + currentSlots.filter((row) => row.missed_at).length,
    raw: { config, cycle, accounts, operations } };
}

export function buildPremiumAssets(data: Props, environment: PremiumEnvironment, now = Date.now()): PremiumAsset[] {
  return (["BTC", "SOL"] as const).map((asset) => environment === "REAL" ? liveAsset(data, asset, now)
    : environment === "TESTNET" ? testnetAsset(data, asset, now) : shadowAsset(data, asset, now));
}
