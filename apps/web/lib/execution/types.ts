export const SHADOW_EXECUTION_MODE = "SHADOW" as const;

export type ExecutionMode = typeof SHADOW_EXECUTION_MODE | "LIVE";
export type SupportedAsset = "BTC" | "SOL";
export type OrderSide = "BUY" | "SELL";

export type ExchangeSymbolInfo = {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  minQuantity: number;
  maxQuantity: number;
  minNotional: number;
  quantityStep: number;
  priceTick: number;
};

export type ExchangeMarketPrice = {
  symbol: string;
  price: number;
  observedAt: string;
};

export type ExchangeCandle = {
  openTime: string;
  closeTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
};

export type ExchangeBalance = {
  asset: string;
  free: number;
  locked: number;
  total: number;
};

export type ExchangeAccount = {
  canTrade: boolean;
  canWithdraw: boolean;
  canDeposit: boolean;
  updateTime: string | null;
  balances: ExchangeBalance[];
};

export type ExchangeApiCapabilities = {
  readEnabled: boolean;
  tradingEnabled: boolean;
  withdrawalsEnabled: boolean;
  ipRestricted: boolean | null;
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
  clientOrderId: string | null;
  updateTime: string | null;
};

export type ExchangeTrade = {
  id: string;
  symbol: string;
  orderId: string;
  side: OrderSide;
  quantity: number;
  price: number;
  quoteQuantity: number;
  time: string | null;
  isMaker: boolean;
};

/**
 * The only adapter shape used by phase 2 reconciliation. It intentionally
 * omits all mutation methods, so reconciliation code cannot accidentally
 * acquire an order-creation capability through its type surface.
 */
export interface ReadOnlyExchangeAdapter {
  getAccount(): Promise<ExchangeAccount>;
  getBalances(): Promise<ExchangeBalance[]>;
  getCapabilities(): Promise<ExchangeApiCapabilities>;
  getServerTime(): Promise<number>;
  getSymbolInfo(symbol: string): Promise<ExchangeSymbolInfo>;
  getMarketPrice(symbol: string): Promise<ExchangeMarketPrice>;
  getCandles(symbol: string, interval: "1m", startTime?: number): Promise<ExchangeCandle[]>;
  getOpenOrders(symbol?: string): Promise<ExchangeOrder[]>;
  getOrder(symbol: string, orderId: string): Promise<ExchangeOrder | null>;
  getTrades(symbol: string): Promise<ExchangeTrade[]>;
}

export interface ExchangeAdapter {
  getAccount(): Promise<ExchangeAccount>;
  getBalances(): Promise<ExchangeBalance[]>;
  getCapabilities(): Promise<ExchangeApiCapabilities>;
  getServerTime(): Promise<number>;
  getSymbolInfo(symbol: string): Promise<ExchangeSymbolInfo>;
  getMarketPrice(symbol: string): Promise<ExchangeMarketPrice>;
  getCandles(symbol: string, interval: "1m", startTime?: number): Promise<ExchangeCandle[]>;
  getOpenOrders(symbol?: string): Promise<ExchangeOrder[]>;
  getOrder(symbol: string, orderId: string): Promise<ExchangeOrder | null>;
  createOrder(input: ExchangeOrderRequest): Promise<ExchangeOrder>;
  cancelOrder(symbol: string, orderId: string): Promise<ExchangeOrder>;
  getTrades(symbol: string): Promise<ExchangeTrade[]>;
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
