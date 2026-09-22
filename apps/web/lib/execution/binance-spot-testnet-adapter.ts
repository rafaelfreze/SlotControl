import { createHmac } from "node:crypto";

import { BinanceSpotAdapter } from "./binance-spot-adapter.ts";

export const BINANCE_SPOT_TESTNET_BASE_URL = "https://testnet.binance.vision";
const TESTNET_SYMBOLS = new Set(["BTCUSDC", "SOLUSDC"]);
const OWNED_CLIENT_ID = /^COV1-(BTC|SOL)-\d+(?:-\d+)?-(BUY|SELL)-[a-f0-9]{18}$/;
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type Credentials = { apiKey: string; apiSecret: string };
type LimitOrder = { type: "LIMIT"; symbol: "BTCUSDC" | "SOLUSDC"; side: "BUY" | "SELL"; quantity: string; price: string; clientOrderId: string; maxNotional: number };
type MarketBuy = { type: "MARKET"; symbol: "BTCUSDC" | "SOLUSDC"; side: "BUY"; quoteOrderQty: string; clientOrderId: string; maxNotional: number };
export type TestnetOrderRequest = LimitOrder | MarketBuy;
export type TestnetOrder = { orderId: string; clientOrderId: string; symbol: string; side: "BUY" | "SELL"; status: string; executedQuantity: number; cumulativeQuoteQuantity: number; price: number };
type OrderPayload = { orderId?: number | string; clientOrderId?: string; symbol?: string; side?: string; status?: string; executedQty?: string; cummulativeQuoteQty?: string; price?: string; code?: number };

function decimal(value: string) { return /^\d+(?:\.\d{1,12})?$/.test(value) && Number(value) > 0; }
function verifyOwned(symbol: string, clientOrderId: string) {
  if (!TESTNET_SYMBOLS.has(symbol) || !OWNED_CLIENT_ID.test(clientOrderId)) throw new Error("COINOPS_TESTNET_ORDER_NOT_OWNED");
  const asset = symbol.slice(0, -4);
  if (!clientOrderId.startsWith(`COV1-${asset}-`)) throw new Error("COINOPS_TESTNET_SYMBOL_MISMATCH");
}
function normalizeOrder(payload: OrderPayload, requestedClientId: string): TestnetOrder {
  if (!payload.orderId || payload.clientOrderId !== requestedClientId || !payload.symbol || !payload.status || (payload.side !== "BUY" && payload.side !== "SELL")) throw new Error("COINOPS_TESTNET_ORDER_RESPONSE_INVALID");
  return { orderId: String(payload.orderId), clientOrderId: payload.clientOrderId, symbol: payload.symbol, side: payload.side, status: payload.status, executedQuantity: Number(payload.executedQty || 0), cumulativeQuoteQuantity: Number(payload.cummulativeQuoteQty || 0), price: Number(payload.price || 0) };
}

/** Separate fictitious-money transport. Its origin cannot be configured to
 * Production; Production credentials are never read by this class. */
export class BinanceSpotTestnetAdapter {
  readonly reads: BinanceSpotAdapter;
  private readonly fetcher: FetchLike;
  private readonly credentials: Credentials;
  private readonly now: () => number;
  private serverTimeOffsetMs = 0;
  private hasServerTime = false;

  constructor(credentials: Credentials, options: { fetcher?: FetchLike; now?: () => number } = {}) {
    if (!credentials.apiKey || !credentials.apiSecret) throw new Error("COINOPS_TESTNET_CREDENTIALS_MISSING");
    this.credentials = credentials;
    this.fetcher = options.fetcher || fetch;
    this.now = options.now || Date.now;
    this.reads = new BinanceSpotAdapter(credentials, { fetcher: this.fetcher, now: this.now, baseUrl: BINANCE_SPOT_TESTNET_BASE_URL, marketDataBaseUrl: BINANCE_SPOT_TESTNET_BASE_URL });
  }

  static fromEnvironment() {
    if (process.env.COINOPS_TESTNET_ENABLED !== "true") throw new Error("COINOPS_TESTNET_DISABLED");
    const apiKey = process.env.BINANCE_TESTNET_API_KEY?.trim();
    const apiSecret = process.env.BINANCE_TESTNET_API_SECRET?.trim();
    if (!apiKey || !apiSecret) throw new Error("COINOPS_TESTNET_CREDENTIALS_MISSING");
    return new BinanceSpotTestnetAdapter({ apiKey, apiSecret });
  }

  static readsFromEnvironment() {
    const apiKey = process.env.BINANCE_TESTNET_API_KEY?.trim();
    const apiSecret = process.env.BINANCE_TESTNET_API_SECRET?.trim();
    if (!apiKey || !apiSecret) throw new Error("COINOPS_TESTNET_CREDENTIALS_MISSING");
    return new BinanceSpotAdapter({ apiKey, apiSecret }, { baseUrl: BINANCE_SPOT_TESTNET_BASE_URL, marketDataBaseUrl: BINANCE_SPOT_TESTNET_BASE_URL });
  }

  async getOwnedOrder(symbol: string, clientOrderId: string): Promise<TestnetOrder | null> {
    verifyOwned(symbol, clientOrderId);
    const response = await this.signedRequest("GET", "/api/v3/order", { symbol, origClientOrderId: clientOrderId });
    if (response.code === -2013) return null;
    if (!response.ok) throw new Error(`COINOPS_TESTNET_ORDER_QUERY_HTTP_${response.status}`);
    return normalizeOrder(response.payload, clientOrderId);
  }

  async ensureOwnedOrder(input: TestnetOrderRequest): Promise<TestnetOrder> {
    verifyOwned(input.symbol, input.clientOrderId);
    if ((input.side === "BUY") !== input.clientOrderId.includes("-BUY-")) throw new Error("COINOPS_TESTNET_SIDE_MISMATCH");
    if (input.type === "LIMIT" && (!decimal(input.quantity) || !decimal(input.price))) throw new Error("COINOPS_TESTNET_ORDER_INVALID");
    const amount = input.type === "MARKET" ? Number(input.quoteOrderQty) : Number(input.quantity) * Number(input.price);
    if ((input.type === "MARKET" && !decimal(input.quoteOrderQty)) || !Number.isFinite(amount) || !Number.isFinite(input.maxNotional) || input.maxNotional <= 0 || amount <= 0 || amount > input.maxNotional + 1e-9) throw new Error("COINOPS_TESTNET_NOTIONAL_CAP");
    const existing = await this.getOwnedOrder(input.symbol, input.clientOrderId);
    if (existing) return existing;
    const params: Record<string, string> = input.type === "MARKET"
      ? { symbol: input.symbol, side: "BUY", type: "MARKET", quoteOrderQty: input.quoteOrderQty, newClientOrderId: input.clientOrderId, newOrderRespType: "FULL" }
      : { symbol: input.symbol, side: input.side, type: "LIMIT", timeInForce: "GTC", quantity: input.quantity, price: input.price, newClientOrderId: input.clientOrderId, newOrderRespType: "FULL" };
    try {
      const response = await this.signedRequest("POST", "/api/v3/order", params);
      if (response.ok) return normalizeOrder(response.payload, input.clientOrderId);
      // A timeout or duplicate-client-id response is not permission to send a
      // second order. Read the matching engine state before deciding.
      const recovered = await this.getOwnedOrder(input.symbol, input.clientOrderId);
      if (recovered) return recovered;
      throw new Error(`COINOPS_TESTNET_ORDER_POST_HTTP_${response.status}`);
    } catch (error) {
      const recovered = await this.getOwnedOrder(input.symbol, input.clientOrderId).catch(() => null);
      if (recovered) return recovered;
      throw error;
    }
  }

  async cancelOwnedOrder(symbol: string, expectedOrderId: string, clientOrderId: string): Promise<TestnetOrder | null> {
    const current = await this.getOwnedOrder(symbol, clientOrderId);
    if (!current || current.orderId !== expectedOrderId) throw new Error("COINOPS_TESTNET_OWNED_ORDER_NOT_FOUND");
    if (!["NEW", "PARTIALLY_FILLED"].includes(current.status)) return current;
    const response = await this.signedRequest("DELETE", "/api/v3/order", { symbol, origClientOrderId: clientOrderId });
    if (response.ok) return normalizeOrder(response.payload, clientOrderId);
    const recovered = await this.getOwnedOrder(symbol, clientOrderId);
    if (recovered && !["NEW", "PARTIALLY_FILLED"].includes(recovered.status)) return recovered;
    throw new Error(`COINOPS_TESTNET_CANCEL_HTTP_${response.status}`);
  }

  private async signedRequest(method: "GET" | "POST" | "DELETE", path: string, params: Record<string, string>) {
    if (!this.hasServerTime) {
      this.serverTimeOffsetMs = (await this.reads.getServerTime()) - this.now();
      this.hasServerTime = true;
    }
    const payload = new URLSearchParams({ ...params, recvWindow: "5000", timestamp: String(this.now() + this.serverTimeOffsetMs) });
    payload.set("signature", createHmac("sha256", this.credentials.apiSecret).update(payload.toString()).digest("hex"));
    const url = `${BINANCE_SPOT_TESTNET_BASE_URL}${path}${method === "GET" ? `?${payload.toString()}` : ""}`;
    let response: Response;
    try { response = await this.fetcher(url, { method, cache: "no-store", headers: { accept: "application/json", "X-MBX-APIKEY": this.credentials.apiKey, ...(method === "GET" ? {} : { "content-type": "application/x-www-form-urlencoded" }) }, ...(method === "GET" ? {} : { body: payload.toString() }) }); }
    catch { throw new Error("COINOPS_TESTNET_NETWORK_UNKNOWN_RESULT"); }
    const body = await response.json().catch(() => ({})) as OrderPayload;
    return { ok: response.ok, status: response.status, code: body.code, payload: body };
  }
}

/** Explicit, authenticated read probe; no order mutation or /sapi call. */
export async function diagnoseBinanceSpotTestnet() {
  const adapter = BinanceSpotTestnetAdapter.readsFromEnvironment();
  const account = await adapter.getAccount();
  const balances = account.balances.filter((item) => ["USDT", "USDC", "BTC", "SOL"].includes(item.asset));
  const symbols = ["SOLUSDC", "BTCUSDC", "SOLUSDT", "BTCUSDT"];
  const probes = await Promise.all(symbols.map(async (symbol) => {
    try {
      const [filters, market, orders] = await Promise.all([adapter.getSymbolInfo(symbol), adapter.getMarketPrice(symbol), adapter.getOpenOrders(symbol)]);
      return { symbol, available: true as const, filters, market, openOrderCount: orders.length, ownedOpenOrderCount: orders.filter((order) => order.clientOrderId?.startsWith("COV1-")).length };
    } catch (error) { return { symbol, available: false as const, error: error instanceof Error ? error.message : "UNKNOWN" }; }
  }));
  return { account: { canTrade: account.canTrade, canWithdraw: account.canWithdraw, canDeposit: account.canDeposit, updateTime: account.updateTime }, balances, probes, observedAt: new Date().toISOString() };
}
