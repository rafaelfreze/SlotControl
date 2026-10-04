import { createHash } from "node:crypto";
import type { OperatorExchangeSnapshot } from "./operator-executor-admin.ts";

export type AllocationSlot = { id: string; run_id: string; trading_engine_id: string; operation_sequence: number;
  position_quantity: number | string; position_committed_brl: number | string };
export type AllocationOrder = { id: string; run_id: string; slot_id: string; trading_engine_id: string;
  operation_sequence: number; client_order_id: string; exchange_order_id: string | null; side: string; purpose: string;
  executed_quantity: number | string; cumulative_quote: number | string; fee_base: number | string;
  fee_quote: number | string; trades_reconciled: boolean };
const fail = () => { throw new Error("COINOPS_ENGINE_APPEND_ALLOCATION_UNKNOWN"); };

/** Only exact ledger-owned orders observed now credit committed capital.
 * A stale OPEN after a SELL, a missing TP or a foreign/manual order never
 * credits free quote. The caller also requires two stable exchange reads. */
export function confirmedEngineCapitalExposure(engines: readonly { id: string; symbol: string; legacy_compatible?: boolean }[],
  slots: readonly AllocationSlot[], orders: readonly AllocationOrder[], snapshot: OperatorExchangeSnapshot) {
  const exposure = engines.map((engine) => ({ engineId: engine.id, position: 0, confirmedBuyHold: 0 }));
  const baseHolds = new Map<string, number>();
  const seen = new Set<string>();
  const actual = (order: AllocationOrder) => {
    const engine = engines.find((row) => row.id === order.trading_engine_id);
    if (!engine) return fail();
    const prefix = engine.legacy_compatible ? `COR1-${engine.symbol.replace(snapshot.quote_asset, "")}-`
      : `C2-${createHash("sha256").update(`${snapshot.exchange_account_id}|${engine.id}`).digest("hex").slice(0, 10)}-`;
    if (!order.client_order_id.startsWith(prefix)) return fail();
    const observed = snapshot.markets.find((market) => market.symbol === engine.symbol)?.open_orders
      .find((row) => row.side === order.side && row.clientOrderId === order.client_order_id
        && String(row.orderId ?? "") === order.exchange_order_id);
    if (!observed) return null;
    const key = `${engine.symbol}:${observed.orderId}`;
    if (seen.has(key) || !["NEW", "PARTIALLY_FILLED"].includes(observed.status)) return fail();
    seen.add(key);
    const [original, executed, price] = [observed.origQty, observed.executedQty, observed.price].map(Number);
    if (![original, executed, price].every(Number.isFinite) || original <= 0 || original < executed || executed < 0 || price <= 0)
      return fail();
    return { remaining: original - executed, price };
  };
  for (const slot of slots) {
    const own = exposure.find((row) => row.engineId === slot.trading_engine_id);
    if (!own) return fail();
    const quantity = Number(slot.position_quantity), committed = Number(slot.position_committed_brl);
    if (![quantity, committed].every((value) => Number.isFinite(value) && value >= 0)) return fail();
    if (!quantity) continue;
    const buys = orders.filter((row) => row.side === "BUY" && row.slot_id === slot.id && row.run_id === slot.run_id
      && row.trading_engine_id === own.engineId && row.operation_sequence === slot.operation_sequence && Number(row.executed_quantity) > 0);
    if (!buys.length || buys.some((row) => !row.trades_reconciled)) return fail();
    const netBought = buys.reduce((sum, row) => sum + Number(row.executed_quantity) - Number(row.fee_base), 0);
    const spent = buys.reduce((sum, row) => sum + Number(row.cumulative_quote) + Number(row.fee_quote), 0);
    if (![netBought, spent].every((value) => Number.isFinite(value) && value > 0) || quantity > netBought + 1e-12) return fail();
    let protectedQuantity = 0;
    for (const order of orders.filter((row) => row.side === "SELL" && row.purpose === "TP" && row.slot_id === slot.id
      && row.run_id === slot.run_id && row.trading_engine_id === own.engineId && row.operation_sequence === slot.operation_sequence)) {
      const observed = actual(order);
      if (observed) protectedQuantity += observed.remaining;
    }
    if (protectedQuantity > quantity + 1e-12) return fail();
    const base = engines.find((row) => row.id === own.engineId)!.symbol.replace(snapshot.quote_asset, "");
    baseHolds.set(base, (baseHolds.get(base) ?? 0) + protectedQuantity);
    own.position += Math.min(committed, spent) * Math.min(1, protectedQuantity / netBought);
  }
  for (const order of orders.filter((row) => row.side === "BUY")) {
    const own = exposure.find((row) => row.engineId === order.trading_engine_id);
    if (!own) return fail();
    const observed = actual(order);
    if (observed) own.confirmedBuyHold += observed.remaining * observed.price;
  }
  // The same locked balance cannot back two engines' supposed holds.
  for (const [asset, amount] of baseHolds) {
    const locked = snapshot.balances.find((row) => row.asset === asset)?.locked;
    if (locked === undefined || !Number.isFinite(locked) || locked + 1e-12 < amount) return fail();
  }
  const quoteLocked = snapshot.balances.find((row) => row.asset === snapshot.quote_asset)?.locked;
  if (quoteLocked === undefined || !Number.isFinite(quoteLocked)
    || quoteLocked + 1e-8 < exposure.reduce((sum, row) => sum + row.confirmedBuyHold, 0)) return fail();
  return exposure;
}

/** Ignore public price/time jitter, not wallet/order changes. No secret/PII. */
export function allocationSnapshotFingerprint(snapshot: OperatorExchangeSnapshot) {
  if (new Set(snapshot.balances.map((row) => row.asset)).size !== snapshot.balances.length
    || snapshot.balances.some((row) => !row.asset || ![row.free, row.locked].every((value) => Number.isFinite(value) && value >= 0))) return fail();
  const balances = snapshot.balances.map((row) => [row.asset, row.free, row.locked]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const orders = snapshot.markets.flatMap((market) => market.open_orders.map((row) =>
    [market.symbol, row.orderId, row.clientOrderId, row.side, row.status, Number(row.origQty), Number(row.executedQty), Number(row.price)]))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return createHash("sha256").update(JSON.stringify({ account: snapshot.exchange_account_id, quote: snapshot.quote_asset, balances, orders })).digest("hex");
}
