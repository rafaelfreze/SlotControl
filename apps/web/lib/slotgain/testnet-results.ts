/** Read-only presentation of the persisted Testnet ledger, never an execution plan. */
import { buildTestnetMissedOccurrences, summarizeTemporalMissed } from "../coinops-reports/missed-level-temporal.ts";

export type TestnetOperationalState = "OPEN" | "NEXT_BUY" | "REENTRY_WAITING" | "PLANNED" | "ACTIVE_ERROR";
type TemporalContext = { asset?: string; cycleId?: string; events?: Parameters<typeof buildTestnetMissedOccurrences>[0] };
export type TestnetResultSlot = {
  slot_number: number; entry_state: string; target_buy_price?: number | string;
  balance_usdc: number | string; gain_count: number; net_profit_usdc: number | string;
  missed_at: string | null; operation_sequence?: number; entry_origin?: string;
  entry_reference_price?: number | string; last_take_profit_price?: number | string | null;
  created_at?: string; updated_at?: string;
};
export type TestnetResultOrder = {
  slot_number: number; side: string; purpose: string; revision: number; operation_sequence?: number;
  client_order_id: string; exchange_order_id: string | null; status: string;
  requested_quantity: number | string | null; price: number | string | null;
  executed_quantity: number | string; cumulative_quote: number | string;
  fee_base?: number | string; fee_quote?: number | string; fee_other?: unknown[];
  created_at: string; updated_at: string;
};
const active = new Set(["PREPARED", "NEW", "PARTIALLY_FILLED"]);
const amount = (value: number | string | null | undefined) => Number(value) || 0;

type TestnetLedgerCycle = { cycleId: string; slots: TestnetResultSlot[] };

/** Credited ledger totals survive reentry. These are cycle/slot accumulators,
 * not individual trades, and must never be inferred from the current state. */
export function summarizeTestnetLedgerTotals(current: TestnetLedgerCycle | null, history: TestnetLedgerCycle[] = []) {
  const seenCycles = new Set<string>();
  const rows: Array<{ cycleId: string; slot_number: number; current: boolean; gains: number; realizedProfit: number }> = [];
  for (const cycle of [...(current ? [current] : []), ...history]) {
    if (seenCycles.has(cycle.cycleId)) continue;
    seenCycles.add(cycle.cycleId);
    const seenSlots = new Set<number>();
    for (const slot of cycle.slots) {
      if (seenSlots.has(slot.slot_number)) continue;
      seenSlots.add(slot.slot_number);
      rows.push({ cycleId: cycle.cycleId, slot_number: slot.slot_number, current: cycle.cycleId === current?.cycleId,
        gains: amount(slot.gain_count), realizedProfit: amount(slot.net_profit_usdc) });
    }
  }
  return { rows, realizedRows: rows.filter((row) => row.gains !== 0 || row.realizedProfit !== 0),
    gains: rows.reduce((sum, row) => sum + row.gains, 0),
    realizedProfit: rows.reduce((sum, row) => sum + row.realizedProfit, 0) };
}

export function summarizeTestnetResults(slots: TestnetResultSlot[], orders: TestnetResultOrder[], marketPrice: number | null, initialPerSlot: number | null, context: TemporalContext = {}) {
  const events = (context.events || []).filter((event) => !context.cycleId || !(event.run_id || event.cycle_id) || (event.run_id || event.cycle_id) === context.cycleId);
  const missedOccurrences = buildTestnetMissedOccurrences(events, { asset: context.asset, cycleId: context.cycleId, fallbackSlots: slots });
  const temporalSummary = summarizeTemporalMissed(missedOccurrences);
  const rows = [...slots].sort((a, b) => a.slot_number - b.slot_number).map((slot) => {
    const sequence = slot.operation_sequence ?? 1;
    const slotOrders = orders.filter((order) => order.slot_number === slot.slot_number && (order.operation_sequence ?? 1) === sequence);
    const buys = slotOrders.filter((order) => order.side === "BUY");
    const sells = slotOrders.filter((order) => order.side === "SELL");
    const bought = buys.reduce((sum, order) => sum + amount(order.executed_quantity), 0);
    const netBought = buys.reduce((sum, order) => sum + amount(order.executed_quantity) - amount(order.fee_base), 0);
    const buyQuote = buys.reduce((sum, order) => sum + amount(order.cumulative_quote), 0);
    const buyCost = buyQuote + buys.reduce((sum, order) => sum + amount(order.fee_quote), 0);
    const sold = sells.reduce((sum, order) => sum + amount(order.executed_quantity), 0);
    const remainingQuantity = Math.max(0, netBought - sold);
    const currentBuy = buys.find((order) => active.has(order.status)) || buys.at(-1) || null;
    const currentTp = sells.find((order) => active.has(order.status)) || sells.filter((order) => amount(order.executed_quantity) > 0).at(-1) || null;
    const closed = slot.entry_state === "CLOSED";
    const temporalOccurrences = missedOccurrences.filter((occurrence) => occurrence.slot === slot.slot_number);
    const currentIssues = temporalOccurrences.filter((occurrence) => occurrence.is_active_issue
      && (occurrence.operation_sequence == null || occurrence.operation_sequence === sequence));
    const historicalOccurrences = temporalOccurrences.filter((occurrence) => occurrence.temporal_classification === "HISTORICAL_PRE_4_1");
    const historicalResolved = historicalOccurrences.length > 0 && historicalOccurrences.every((occurrence) => !occurrence.is_active_issue);
    const hasResidentBuy = buys.some((order) => active.has(order.status) && Boolean(order.exchange_order_id));
    const hasResidentTp = sells.some((order) => active.has(order.status) && Boolean(order.exchange_order_id));
    // A terminal historical event never replaces a current OPEN, armed BUY or
    // PLANNED state. MISSED is kept verbatim in details, not used as a position.
    const operationalState: TestnetOperationalState = (!closed && remainingQuantity > 1e-10) || slot.entry_state === "OPEN" ? "OPEN"
      : hasResidentBuy || slot.entry_state === "ARMED" ? "NEXT_BUY"
      : slot.entry_state === "MISSED" && (!historicalResolved || currentIssues.length > 0) ? "ACTIVE_ERROR"
      : slot.entry_origin === "REENTRY" || sequence > 1 || closed ? "REENTRY_WAITING" : "PLANNED";
    const hasUnknownFees = slotOrders.some((order) => Boolean(order.fee_other?.length));
    const positionCost = netBought > 0 ? buyCost * remainingQuantity / netBought : 0;
    // A prepared local intent has no exchange reservation. For a resident BUY,
    // only its unfilled quantity is reserved; fills already belong to positionCost.
    const reservedBuyCapital = buys.filter((order) => active.has(order.status) && Boolean(order.exchange_order_id))
      .reduce((sum, order) => sum + Math.max(0, amount(order.requested_quantity) - amount(order.executed_quantity)) * amount(order.price), 0);
    const openPnl = closed || remainingQuantity === 0 ? 0 : marketPrice && !hasUnknownFees ? remainingQuantity * marketPrice - positionCost : null;
    return {
      ...slot, orders: slotOrders, buy: currentBuy, tp: currentTp, closed,
      persisted_entry_state: slot.entry_state, operationalState, temporalOccurrences, historicalOccurrences, currentIssues,
      hasResidentBuy, hasResidentTp,
      initialBalance: initialPerSlot, balance: amount(slot.balance_usdc), gains: slot.gain_count,
      realizedProfit: amount(slot.net_profit_usdc), quantity: bought, remainingQuantity,
      averageEntry: bought > 0 ? buyQuote / bought : null,
      entryPrice: bought > 0 ? buyQuote / bought : amount(slot.target_buy_price) || null,
      takeProfitPrice: currentTp ? amount(currentTp.price) || null : null,
      positionCapital: closed ? 0 : positionCost, reservedBuyCapital,
      committedCapital: (closed ? 0 : positionCost) + reservedBuyCapital, openPnl,
      feesQuote: slotOrders.reduce((sum, order) => sum + amount(order.fee_quote), 0),
      hasUnknownFees, closedAt: closed ? currentTp?.updated_at || slot.updated_at || null : null
    };
  });
  // Persisted slot balances already include credited net profits (compounding).
  // Do not add gains or unrealized PnL again; these are robot-ledger amounts,
  // distinct from the entire fictitious exchange account's free/locked balances.
  const capital = rows.reduce((sum, row) => sum + row.balance, 0);
  const committedCapital = rows.reduce((sum, row) => sum + row.committedCapital, 0);
  return {
    rows, capital, initialCapital: initialPerSlot === null ? null : initialPerSlot * slots.length,
    committedCapital, freeCapital: Math.max(0, capital - committedCapital),
    reservedBuyCapital: rows.reduce((sum, row) => sum + row.reservedBuyCapital, 0),
    gains: rows.reduce((sum, row) => sum + row.gains, 0),
    completedOperations: rows.filter((row) => row.closed).length,
    realizedProfit: rows.reduce((sum, row) => sum + row.realizedProfit, 0),
    openPnl: rows.some((row) => row.openPnl === null) ? null : rows.reduce((sum, row) => sum + (row.openPnl || 0), 0),
    openSlots: rows.filter((row) => row.operationalState === "OPEN").length,
    armedSlots: rows.filter((row) => row.operationalState === "NEXT_BUY").length,
    reentryWaitingSlots: rows.filter((row) => row.operationalState === "REENTRY_WAITING").length,
    plannedSlots: rows.filter((row) => row.operationalState === "PLANNED").length,
    activeErrorSlots: rows.filter((row) => row.operationalState === "ACTIVE_ERROR").length,
    missedLevels: missedOccurrences.length, missedOccurrences, temporalSummary,
    slotInvariantValid: rows.length === 25 && new Set(rows.map((row) => row.slot_number)).size === 25 && rows.every((row) => Number.isInteger(row.slot_number) && row.slot_number >= 1 && row.slot_number <= 25),
    residentBuyCount: orders.filter((order) => order.side === "BUY" && active.has(order.status) && Boolean(order.exchange_order_id)).length,
    unprotectedOpenSlots: rows.filter((row) => row.operationalState === "OPEN" && !row.hasResidentTp).length
  };
}

/** A diagnostic is optional on persisted-ledger views. Explicit denials remain
 * actionable even when the diagnostic request itself completed successfully. */
export function testnetDiagnosticIssue(snapshot?: {
  ok?: boolean; error?: string | null;
  tradePermission?: { ok?: boolean };
  userStreamPermission?: { ok?: boolean };
  account?: { canTrade?: boolean };
} | null, actionError?: string | null): string | null {
  if (actionError) return actionError;
  if (snapshot?.ok === false) return snapshot.error || "Diagnóstico Testnet indisponível";
  if (snapshot?.account?.canTrade === false) return "Conta Testnet sem permissão para operar";
  if (snapshot?.tradePermission?.ok === false) return "Permissão TRADE Testnet não confirmada";
  if (snapshot?.userStreamPermission?.ok === false) return "Permissão USER_STREAM Testnet não confirmada";
  return null;
}

/** Health describes current, evidenced operation. Resolved pre-version history
 * remains visible but cannot create an active error or mask another failure. */
export function testnetPresentationHealth(result: ReturnType<typeof summarizeTestnetResults>, run: {
  status: string; last_error?: string | null; last_reconciled_at?: string | null;
  reset_started_at?: string | null; reset_completed_at?: string | null;
} | null | undefined, now = Date.now(), connectionError?: string | null) {
  const age = run?.last_reconciled_at ? now - Date.parse(run.last_reconciled_at) : NaN;
  const fresh = Number.isFinite(age) && age >= -60_000 && age <= 180_000;
  const invariantFailed = Boolean(run && result.rows.length && (!result.slotInvariantValid || result.residentBuyCount > 1 || result.armedSlots > 1 || result.unprotectedOpenSlots > 0));
  const activeFailure = Boolean(run?.last_error) || invariantFailed || result.temporalSummary.regressionCount > 0;
  if (activeFailure) return { tone: "error" as const, healthy: false, label: "DIVERGÊNCIA ATIVA", reason: run?.last_error || (invariantFailed ? "Invariante operacional exige revisão" : "Missed posterior à estratégia atual") };
  if (!run) return { tone: "attention" as const, healthy: false, label: "Não iniciado", reason: "Sem ciclo Testnet persistido" };
  if (connectionError || result.temporalSummary.activeIssueCount > 0 || result.activeErrorSlots > 0) return {
    tone: "attention" as const, healthy: false, label: "ATENÇÃO", reason: connectionError || "Ocorrência com evidência ou resolução pendente"
  };
  if (run.status === "PAUSED") return { tone: "attention" as const, healthy: false, label: "PAUSADO", reason: "Execução pausada" };
  if (run.reset_started_at && !run.reset_completed_at) return { tone: "attention" as const, healthy: false, label: "REINICIANDO CICLO", reason: "Reconciliação do reinício em andamento" };
  if (!fresh || run.status !== "ACTIVE" || !result.slotInvariantValid || result.openSlots === 0 || result.residentBuyCount !== 1) return {
    tone: "attention" as const, healthy: false, label: "ATENÇÃO", reason: !fresh ? "Reconciliação atual sem evidência recente" : "Estado operacional em reconciliação"
  };
  return { tone: "ok" as const, healthy: true, label: result.temporalSummary.historicalCount > 0 ? "Motor OK — ocorrências históricas preservadas" : "Motor OK", reason: "Estado atual reconciliado; Production READ-ONLY" };
}
