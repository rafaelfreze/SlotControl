export const SHADOW_EXECUTION_MODE = "SHADOW" as const;

export type ExecutionMode = typeof SHADOW_EXECUTION_MODE | "LIVE";
export type SupportedAsset = "BTC" | "SOL";
export type OrderSide = "BUY" | "SELL";

export type ExchangeSymbolInfo = {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  minQuantity: number;
  minNotional: number;
  quantityStep: number;
};

export type ExchangeMarketPrice = {
  symbol: string;
  price: number;
  observedAt: string;
};

export type ExchangeOrderRequest = {
  symbol: string;
  side: OrderSide;
  quantity: number;
  clientOrderId: string;
};

export type ExchangeOrder = {
  id: string;
  symbol: string;
  side: OrderSide;
  status: string;
  executedQuantity: number;
  price: number | null;
};

export interface ExchangeAdapter {
  getAccount(): Promise<unknown>;
  getBalances(): Promise<unknown[]>;
  getSymbolInfo(symbol: string): Promise<ExchangeSymbolInfo>;
  getMarketPrice(symbol: string): Promise<ExchangeMarketPrice>;
  getOpenOrders(symbol?: string): Promise<ExchangeOrder[]>;
  getOrder(symbol: string, orderId: string): Promise<ExchangeOrder | null>;
  createOrder(input: ExchangeOrderRequest): Promise<ExchangeOrder>;
  cancelOrder(symbol: string, orderId: string): Promise<ExchangeOrder>;
  getTrades(symbol: string): Promise<unknown[]>;
}

export class LiveExecutionBlockedError extends Error {
  constructor() {
    super("COINOPS_LIVE_EXECUTION_BLOCKED_PHASE_1");
    this.name = "LiveExecutionBlockedError";
  }
}

export function assertShadowOnly(mode: ExecutionMode): asserts mode is typeof SHADOW_EXECUTION_MODE {
  if (mode !== SHADOW_EXECUTION_MODE) throw new LiveExecutionBlockedError();
}

export function assetSymbol(asset: SupportedAsset) {
  return asset === "BTC" ? "BTCUSDT" : "SOLUSDT";
}
