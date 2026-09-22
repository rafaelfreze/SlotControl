import type { ExchangeBalance, ExchangeOrder, ExchangeTrade } from "./types.ts";

export type ReconciliationClassification =
  | "MATCH"
  | "EXPECTED_ONLY"
  | "EXCHANGE_ONLY"
  | "QUANTITY_MISMATCH"
  | "PRICE_MISMATCH"
  | "STATUS_MISMATCH"
  | "UNKNOWN";

export type ReconciliationIntent = {
  id: string;
  idempotencyKey: string;
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  observedMarketPrice: number;
  status: string;
};

export type ReconciliationItem = {
  classification: ReconciliationClassification;
  entityType: "INTENT" | "ORDER" | "TRADE" | "BALANCE";
  intentId: string | null;
  exchangeReference: string | null;
  symbol: string | null;
  details: Record<string, unknown>;
};

const EPSILON = 0.00000001;

function quantitiesMatch(expected: number, actual: number) {
  return Math.abs(expected - actual) <= Math.max(EPSILON, expected * 0.000001);
}

function pricesMatch(expected: number, actual: number | null) {
  return actual !== null && Math.abs(expected - actual) <= Math.max(0.01, expected * 0.0005);
}

/**
 * No historical Binance order/trade is guessed to belong to a CoinOps slot.
 * Correlation only happens when a future exchange order carries the exact
 * deterministic clientOrderId generated from the persisted Shadow intent.
 */
export function reconcileShadowWithExchange(input: {
  intents: ReconciliationIntent[];
  orders: ExchangeOrder[];
  trades: ExchangeTrade[];
  balances: ExchangeBalance[];
}) {
  const items: ReconciliationItem[] = [];
  const byClientOrderId = new Map(input.orders.filter((order) => order.clientOrderId).map((order) => [order.clientOrderId!, order]));
  const referencedOrders = new Set<string>();

  for (const intent of input.intents) {
    const order = byClientOrderId.get(intent.idempotencyKey);
    if (!order) {
      items.push({ classification: "EXPECTED_ONLY", entityType: "INTENT", intentId: intent.id, exchangeReference: null, symbol: intent.symbol, details: { shadowStatus: intent.status, expectedQuantity: intent.quantity, expectedPrice: intent.observedMarketPrice } });
      continue;
    }
    referencedOrders.add(order.id);
    const classification: ReconciliationClassification =
      order.status === "PARTIALLY_FILLED" ? "STATUS_MISMATCH"
        : !quantitiesMatch(intent.quantity, order.executedQuantity) ? "QUANTITY_MISMATCH"
          : !pricesMatch(intent.observedMarketPrice, order.price) ? "PRICE_MISMATCH"
            : order.status === "FILLED" ? "MATCH" : "STATUS_MISMATCH";
    items.push({ classification, entityType: "ORDER", intentId: intent.id, exchangeReference: order.id, symbol: order.symbol, details: { exchangeStatus: order.status, expectedQuantity: intent.quantity, executedQuantity: order.executedQuantity, expectedPrice: intent.observedMarketPrice, exchangePrice: order.price } });
  }

  for (const order of input.orders) {
    if (referencedOrders.has(order.id)) continue;
    items.push({ classification: "EXCHANGE_ONLY", entityType: "ORDER", intentId: null, exchangeReference: order.id, symbol: order.symbol, details: { status: order.status, quantity: order.executedQuantity, clientOrderId: order.clientOrderId } });
  }
  for (const trade of input.trades) {
    items.push({ classification: "EXCHANGE_ONLY", entityType: "TRADE", intentId: null, exchangeReference: trade.id, symbol: trade.symbol, details: { orderId: trade.orderId, side: trade.side, quantity: trade.quantity, price: trade.price, time: trade.time } });
  }
  for (const balance of input.balances.filter((balance) => ["BTC", "SOL", "USDT"].includes(balance.asset))) {
    items.push({ classification: "UNKNOWN", entityType: "BALANCE", intentId: null, exchangeReference: balance.asset, symbol: null, details: { free: balance.free, locked: balance.locked, total: balance.total } });
  }

  const summary = items.reduce<Record<ReconciliationClassification, number>>((result, item) => {
    result[item.classification] += 1;
    return result;
  }, { MATCH: 0, EXPECTED_ONLY: 0, EXCHANGE_ONLY: 0, QUANTITY_MISMATCH: 0, PRICE_MISMATCH: 0, STATUS_MISMATCH: 0, UNKNOWN: 0 });
  return { items, summary };
}
