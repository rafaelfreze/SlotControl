/** Read-only presentation of the persisted Testnet ledger, never an execution plan. */
export type TestnetResultSlot = {
  slot_number: number; entry_state: string; target_buy_price?: number | string;
  balance_usdc: number | string; gain_count: number; net_profit_usdc: number | string;
  missed_at: string | null; created_at?: string; updated_at?: string;
};
export type TestnetResultOrder = {
  slot_number: number; side: string; purpose: string; revision: number;
  client_order_id: string; exchange_order_id: string | null; status: string;
  requested_quantity: number | string | null; price: number | string | null;
  executed_quantity: number | string; cumulative_quote: number | string;
  fee_base?: number | string; fee_quote?: number | string; fee_other?: unknown[];
  created_at: string; updated_at: string;
};
const active = new Set(["PREPARED", "NEW", "PARTIALLY_FILLED"]);
const amount = (value: number | string | null | undefined) => Number(value) || 0;

export function summarizeTestnetResults(slots: TestnetResultSlot[], orders: TestnetResultOrder[], marketPrice: number | null, initialPerSlot: number | null) {
  const rows = [...slots].sort((a, b) => a.slot_number - b.slot_number).map((slot) => {
    const slotOrders = orders.filter((order) => order.slot_number === slot.slot_number);
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
    const hasUnknownFees = slotOrders.some((order) => Boolean(order.fee_other?.length));
    const positionCost = netBought > 0 ? buyCost * remainingQuantity / netBought : 0;
    // A prepared local intent has no exchange reservation. For a resident BUY,
    // only its unfilled quantity is reserved; fills already belong to positionCost.
    const reservedBuyCapital = buys.filter((order) => active.has(order.status) && Boolean(order.exchange_order_id))
      .reduce((sum, order) => sum + Math.max(0, amount(order.requested_quantity) - amount(order.executed_quantity)) * amount(order.price), 0);
    const openPnl = closed || remainingQuantity === 0 ? 0 : marketPrice && !hasUnknownFees ? remainingQuantity * marketPrice - positionCost : null;
    return {
      ...slot, orders: slotOrders, buy: currentBuy, tp: currentTp, closed,
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
    openSlots: rows.filter((row) => !row.closed && row.remainingQuantity > 0).length,
    armedSlots: rows.filter((row) => row.entry_state === "ARMED").length,
    plannedSlots: rows.filter((row) => row.entry_state === "PLANNED").length,
    missedLevels: rows.filter((row) => row.missed_at).length
  };
}
