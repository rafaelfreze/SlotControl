import { createHmac } from "node:crypto";

import {
  type ExchangeAccount,
  type ExchangeAdapter,
  type ExchangeApiCapabilities,
  type ExchangeBalance,
  type ExchangeMarketPrice,
  type ExchangeOrder,
  type ExchangeOrderRequest,
  type ExchangeSymbolInfo,
  type ExchangeTrade,
  LiveExecutionBlockedError
} from "./types.ts";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type Sleep = (milliseconds: number) => Promise<void>;
type BinanceErrorPayload = { code?: number; msg?: string };
type BinanceAccountPayload = { canTrade?: boolean; canWithdraw?: boolean; canDeposit?: boolean; updateTime?: number; balances?: Array<{ asset?: string; free?: string; locked?: string }> };
type BinanceRestrictionsPayload = { enableReading?: boolean; enableSpotAndMarginTrading?: boolean; enableWithdrawals?: boolean; ipRestrict?: boolean };
type BinanceOrderPayload = { orderId?: number | string; symbol?: string; side?: string; status?: string; executedQty?: string; price?: string; clientOrderId?: string; updateTime?: number };
type BinanceTradePayload = { id?: number | string; orderId?: number | string; symbol?: string; qty?: string; price?: string; quoteQty?: string; time?: number; isBuyer?: boolean; isMaker?: boolean };
type BinanceExchangeInfo = { symbols?: Array<{ symbol?: string; baseAsset?: string; quoteAsset?: string; filters?: Array<{ filterType?: string; minQty?: string; maxQty?: string; minNotional?: string; notional?: string; stepSize?: string; tickSize?: string }> }> };

export class BinanceReadOnlyError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, retryable = false) {
    super(code);
    this.name = "BinanceReadOnlyError";
    this.code = code;
    this.retryable = retryable;
  }
}

export type BinanceReadOnlyCredentials = { apiKey: string; apiSecret: string };
export type BinanceSpotAdapterOptions = { fetcher?: FetchLike; now?: () => number; sleep?: Sleep; baseUrl?: string; maxReadRetries?: number };

const defaultSleep: Sleep = async (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const BINANCE_BASE_URL = "https://api.binance.com";
const READ_RECV_WINDOW_MS = 5_000;

function finiteNumber(value: string | number | undefined, code: string) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new BinanceReadOnlyError(code);
  return number;
}

function optionalIso(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? new Date(value).toISOString() : null;
}

function normalizeOrder(payload: BinanceOrderPayload): ExchangeOrder {
  const side = payload.side === "BUY" || payload.side === "SELL" ? payload.side : null;
  if (!payload.orderId || !payload.symbol || !side || !payload.status) throw new BinanceReadOnlyError("BINANCE_ORDER_INVALID");
  return { id: String(payload.orderId), symbol: payload.symbol, side, status: payload.status, executedQuantity: finiteNumber(payload.executedQty, "BINANCE_ORDER_INVALID"), price: payload.price && Number(payload.price) > 0 ? finiteNumber(payload.price, "BINANCE_ORDER_INVALID") : null, clientOrderId: payload.clientOrderId || null, updateTime: optionalIso(payload.updateTime) };
}

function normalizeTrade(payload: BinanceTradePayload): ExchangeTrade {
  if (!payload.id || !payload.orderId || !payload.symbol || typeof payload.isBuyer !== "boolean") throw new BinanceReadOnlyError("BINANCE_TRADE_INVALID");
  return { id: String(payload.id), orderId: String(payload.orderId), symbol: payload.symbol, side: payload.isBuyer ? "BUY" : "SELL", quantity: finiteNumber(payload.qty, "BINANCE_TRADE_INVALID"), price: finiteNumber(payload.price, "BINANCE_TRADE_INVALID"), quoteQuantity: finiteNumber(payload.quoteQty, "BINANCE_TRADE_INVALID"), time: optionalIso(payload.time), isMaker: Boolean(payload.isMaker) };
}

export function normalizeToStep(value: number, step: number) {
  if (![value, step].every(Number.isFinite) || value < 0 || step <= 0) throw new BinanceReadOnlyError("BINANCE_PRECISION_INVALID");
  const decimals = Math.max(0, (String(step).split(".")[1] || "").length);
  return Number((Math.floor((value + Number.EPSILON) / step) * step).toFixed(decimals));
}

export const normalizePriceToTick = normalizeToStep;

/** GET-only authenticated adapter. No POST, DELETE, transfer, withdrawal, conversion or order transport exists here. */
export class BinanceSpotAdapter implements ExchangeAdapter {
  private readonly fetcher: FetchLike;
  private readonly now: () => number;
  private readonly sleep: Sleep;
  private readonly baseUrl: string;
  private readonly maxReadRetries: number;
  private readonly credentials: BinanceReadOnlyCredentials | null;
  private serverTimeOffsetMs = 0;
  private hasServerTime = false;

  constructor(credentialsOrFetcher: BinanceReadOnlyCredentials | FetchLike | null = null, options: BinanceSpotAdapterOptions = {}) {
    if (typeof credentialsOrFetcher === "function") {
      this.credentials = null;
      this.fetcher = options.fetcher || credentialsOrFetcher;
    } else {
      this.credentials = credentialsOrFetcher;
      this.fetcher = options.fetcher || fetch;
    }
    this.now = options.now || Date.now;
    this.sleep = options.sleep || defaultSleep;
    this.baseUrl = options.baseUrl || BINANCE_BASE_URL;
    this.maxReadRetries = options.maxReadRetries ?? 1;
  }

  static fromEnvironment() {
    const apiKey = process.env.BINANCE_API_KEY?.trim();
    const apiSecret = process.env.BINANCE_API_SECRET?.trim();
    if (!apiKey || !apiSecret) throw new BinanceReadOnlyError("BINANCE_READ_ONLY_CONNECTION_NOT_CONFIGURED");
    return new BinanceSpotAdapter({ apiKey, apiSecret });
  }

  static maskApiKey(apiKey: string | null | undefined) {
    return !apiKey ? null : apiKey.length <= 8 ? "••••" : `••••${apiKey.slice(-4)}`;
  }

  async getServerTime() {
    const payload = await this.readJson<{ serverTime?: number }>("/api/v3/time");
    const serverTime = finiteNumber(payload.serverTime, "BINANCE_SERVER_TIME_INVALID");
    this.serverTimeOffsetMs = serverTime - this.now();
    this.hasServerTime = true;
    return serverTime;
  }

  async getAccount(): Promise<ExchangeAccount> {
    const payload = await this.signedRead<BinanceAccountPayload>("/api/v3/account");
    return { canTrade: Boolean(payload.canTrade), canWithdraw: Boolean(payload.canWithdraw), canDeposit: Boolean(payload.canDeposit), updateTime: optionalIso(payload.updateTime), balances: this.normalizeBalances(payload.balances || []) };
  }

  async getBalances() { return (await this.getAccount()).balances; }

  async getCapabilities(): Promise<ExchangeApiCapabilities> {
    const payload = await this.signedRead<BinanceRestrictionsPayload>("/sapi/v1/account/apiRestrictions");
    return { readEnabled: payload.enableReading !== false, tradingEnabled: Boolean(payload.enableSpotAndMarginTrading), withdrawalsEnabled: Boolean(payload.enableWithdrawals), ipRestricted: typeof payload.ipRestrict === "boolean" ? payload.ipRestrict : null };
  }

  async getMarketPrice(symbol: string): Promise<ExchangeMarketPrice> {
    const payload = await this.readJson<{ symbol?: string; price?: string }>("/api/v3/ticker/price", { symbol });
    const price = finiteNumber(payload.price, "BINANCE_MARKET_PRICE_INVALID");
    if (payload.symbol !== symbol || price <= 0) throw new BinanceReadOnlyError("BINANCE_MARKET_PRICE_INVALID");
    return { symbol, price, observedAt: new Date(this.now() + this.serverTimeOffsetMs).toISOString() };
  }

  async getSymbolInfo(symbol: string): Promise<ExchangeSymbolInfo> {
    const payload = await this.readJson<BinanceExchangeInfo>("/api/v3/exchangeInfo", { symbol });
    const item = payload.symbols?.find((candidate) => candidate.symbol === symbol);
    const lot = item?.filters?.find((filter) => filter.filterType === "MARKET_LOT_SIZE") || item?.filters?.find((filter) => filter.filterType === "LOT_SIZE");
    const notional = item?.filters?.find((filter) => filter.filterType === "MIN_NOTIONAL" || filter.filterType === "NOTIONAL");
    const price = item?.filters?.find((filter) => filter.filterType === "PRICE_FILTER");
    const minQuantity = finiteNumber(lot?.minQty, "BINANCE_SYMBOL_INFO_INVALID");
    const maxQuantity = finiteNumber(lot?.maxQty, "BINANCE_SYMBOL_INFO_INVALID");
    const quantityStep = finiteNumber(lot?.stepSize, "BINANCE_SYMBOL_INFO_INVALID");
    const minNotional = finiteNumber(notional?.minNotional ?? notional?.notional, "BINANCE_SYMBOL_INFO_INVALID");
    const priceTick = finiteNumber(price?.tickSize, "BINANCE_SYMBOL_INFO_INVALID");
    if (!item?.baseAsset || !item.quoteAsset || minQuantity <= 0 || maxQuantity <= 0 || quantityStep <= 0 || minNotional <= 0 || priceTick <= 0) throw new BinanceReadOnlyError("BINANCE_SYMBOL_INFO_INVALID");
    return { symbol, baseAsset: item.baseAsset, quoteAsset: item.quoteAsset, minQuantity, maxQuantity, minNotional, quantityStep, priceTick };
  }

  async getOpenOrders(symbol?: string) {
    const payload = await this.signedRead<BinanceOrderPayload[]>("/api/v3/openOrders", symbol ? { symbol } : {});
    return payload.map(normalizeOrder);
  }

  async getOrder(symbol: string, orderId: string) {
    try { return normalizeOrder(await this.signedRead<BinanceOrderPayload>("/api/v3/order", { symbol, orderId })); }
    catch (error) { if (error instanceof BinanceReadOnlyError && error.code === "BINANCE_HTTP_400") return null; throw error; }
  }

  async getTrades(symbol: string) {
    const payload = await this.signedRead<BinanceTradePayload[]>("/api/v3/myTrades", { symbol, limit: "100" });
    return payload.map(normalizeTrade);
  }

  async createOrder(_input: ExchangeOrderRequest): Promise<ExchangeOrder> { throw new LiveExecutionBlockedError(); }
  async cancelOrder(_symbol: string, _orderId: string): Promise<ExchangeOrder> { throw new LiveExecutionBlockedError(); }

  private normalizeBalances(rows: BinanceAccountPayload["balances"]): ExchangeBalance[] {
    return (rows || []).map((balance) => {
      const free = finiteNumber(balance.free, "BINANCE_BALANCE_INVALID");
      const locked = finiteNumber(balance.locked, "BINANCE_BALANCE_INVALID");
      if (!balance.asset || free < 0 || locked < 0) throw new BinanceReadOnlyError("BINANCE_BALANCE_INVALID");
      return { asset: balance.asset, free, locked, total: Number((free + locked).toFixed(12)) };
    });
  }

  private async signedRead<T>(path: string, params: Record<string, string> = {}, retriedClockDrift = false): Promise<T> {
    if (!this.credentials) throw new BinanceReadOnlyError("BINANCE_READ_ONLY_CONNECTION_NOT_CONFIGURED");
    if (!this.hasServerTime) await this.getServerTime();
    const query = new URLSearchParams({ ...params, recvWindow: String(READ_RECV_WINDOW_MS), timestamp: String(this.now() + this.serverTimeOffsetMs) });
    query.set("signature", createHmac("sha256", this.credentials.apiSecret).update(query.toString()).digest("hex"));
    try {
      return await this.readJson<T>(path, Object.fromEntries(query.entries()), { "X-MBX-APIKEY": this.credentials.apiKey });
    } catch (error) {
      if (!retriedClockDrift && error instanceof BinanceReadOnlyError && error.code === "BINANCE_CLOCK_DRIFT") {
        this.serverTimeOffsetMs = 0;
        this.hasServerTime = false;
        await this.getServerTime();
        return this.signedRead<T>(path, params, true);
      }
      throw error;
    }
  }

  private async readJson<T>(path: string, params: Record<string, string> = {}, headers?: Record<string, string>) {
    const query = new URLSearchParams(params);
    const url = `${this.baseUrl}${path}${query.size ? `?${query.toString()}` : ""}`;
    for (let attempt = 0; attempt <= this.maxReadRetries; attempt += 1) {
      let response: Response;
      try { response = await this.fetcher(url, { method: "GET", cache: "no-store", headers: { accept: "application/json", ...headers } }); }
      catch { if (attempt < this.maxReadRetries) { await this.sleep(100 * (attempt + 1)); continue; } throw new BinanceReadOnlyError("BINANCE_NETWORK_UNAVAILABLE", true); }
      const payload = await response.json().catch(() => ({})) as T & BinanceErrorPayload;
      if (response.ok) return payload as T;
      const code = this.errorCode(response.status, payload);
      if ((response.status === 429 || response.status >= 500) && attempt < this.maxReadRetries) { await this.sleep(100 * (attempt + 1)); continue; }
      throw new BinanceReadOnlyError(code, response.status === 429 || response.status >= 500);
    }
    throw new BinanceReadOnlyError("BINANCE_READ_UNEXPECTED");
  }

  private errorCode(status: number, payload: BinanceErrorPayload) {
    if (payload.code === -1021) return "BINANCE_CLOCK_DRIFT";
    if (payload.code === -1022) return "BINANCE_INVALID_SIGNATURE";
    if (payload.code === -2015 || payload.code === -2014) return "BINANCE_INVALID_CREDENTIALS";
    if (status === 429) return "BINANCE_RATE_LIMITED";
    if (status === 401 || status === 403) return "BINANCE_AUTHORIZATION_DENIED";
    return `BINANCE_HTTP_${status}`;
  }
}
