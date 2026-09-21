import { type ExchangeAdapter, type ExchangeMarketPrice, type ExchangeOrder, type ExchangeOrderRequest, type ExchangeSymbolInfo, LiveExecutionBlockedError } from "./types.ts";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

type BinanceExchangeInfo = {
  symbols?: Array<{
    symbol?: string;
    baseAsset?: string;
    quoteAsset?: string;
    filters?: Array<{ filterType?: string; minQty?: string; minNotional?: string; stepSize?: string }>;
  }>;
};

/**
 * Phase 1 adapter: public market metadata only. It deliberately contains no
 * authenticated transport, POST or DELETE implementation, so a real order
 * cannot be created or cancelled by this runtime.
 */
export class BinanceSpotAdapter implements ExchangeAdapter {
  private readonly fetcher: FetchLike;

  constructor(fetcher: FetchLike = fetch) {
    this.fetcher = fetcher;
  }

  async getMarketPrice(symbol: string): Promise<ExchangeMarketPrice> {
    const response = await this.fetcher(`https://api.binance.com/api/v3/ticker/price?symbol=${encodeURIComponent(symbol)}`, {
      cache: "no-store",
      headers: { accept: "application/json" }
    });
    if (!response.ok) throw new Error(`BINANCE_MARKET_PRICE_${response.status}`);
    const payload = await response.json() as { symbol?: string; price?: string };
    const price = Number(payload.price);
    if (payload.symbol !== symbol || !Number.isFinite(price) || price <= 0) throw new Error("BINANCE_MARKET_PRICE_INVALID");
    return { symbol, price, observedAt: new Date().toISOString() };
  }

  async getSymbolInfo(symbol: string): Promise<ExchangeSymbolInfo> {
    const response = await this.fetcher(`https://api.binance.com/api/v3/exchangeInfo?symbol=${encodeURIComponent(symbol)}`, {
      cache: "no-store",
      headers: { accept: "application/json" }
    });
    if (!response.ok) throw new Error(`BINANCE_SYMBOL_INFO_${response.status}`);
    const payload = await response.json() as BinanceExchangeInfo;
    const item = payload.symbols?.find((candidate) => candidate.symbol === symbol);
    const lot = item?.filters?.find((filter) => filter.filterType === "LOT_SIZE");
    const notional = item?.filters?.find((filter) => filter.filterType === "MIN_NOTIONAL" || filter.filterType === "NOTIONAL");
    const minQuantity = Number(lot?.minQty);
    const quantityStep = Number(lot?.stepSize);
    const minNotional = Number(notional?.minNotional);
    if (!item?.baseAsset || !item.quoteAsset || ![minQuantity, quantityStep, minNotional].every((value) => Number.isFinite(value) && value > 0)) {
      throw new Error("BINANCE_SYMBOL_INFO_INVALID");
    }
    return { symbol, baseAsset: item.baseAsset, quoteAsset: item.quoteAsset, minQuantity, minNotional, quantityStep };
  }

  async getAccount(): Promise<unknown> { return this.readOnlyUnavailable(); }
  async getBalances(): Promise<unknown[]> { return this.readOnlyUnavailable(); }
  async getOpenOrders(_symbol?: string): Promise<ExchangeOrder[]> { return this.readOnlyUnavailable(); }
  async getOrder(_symbol: string, _orderId: string): Promise<ExchangeOrder | null> { return this.readOnlyUnavailable(); }
  async getTrades(_symbol: string): Promise<unknown[]> { return this.readOnlyUnavailable(); }

  async createOrder(_input: ExchangeOrderRequest): Promise<ExchangeOrder> {
    throw new LiveExecutionBlockedError();
  }

  async cancelOrder(_symbol: string, _orderId: string): Promise<ExchangeOrder> {
    throw new LiveExecutionBlockedError();
  }

  private async readOnlyUnavailable(): Promise<never> {
    throw new Error("BINANCE_READ_ONLY_CONNECTION_NOT_CONFIGURED");
  }
}
