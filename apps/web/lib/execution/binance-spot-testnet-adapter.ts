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
type OrderPayload = { orderId?: number | string; clientOrderId?: string; origClientOrderId?: string; symbol?: string; side?: string; status?: string; executedQty?: string; cummulativeQuoteQty?: string; price?: string; code?: number };
type TradePayload = { id?: number | string; orderId?: number | string; qty?: string; quoteQty?: string; commission?: string; commissionAsset?: string; isBuyer?: boolean };
export type TestnetTrade = { id: string; quantity: number; quoteQuantity: number; commission: number; commissionAsset: string; isBuyer: boolean };

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
function cancelClientId(originalClientId: string) { return `COV1-C-${createHmac("sha256", "coinops-testnet-cancel-id").update(originalClientId).digest("hex").slice(0, 18)}`; }

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

  static diagnosticFromEnvironment() {
    const apiKey = process.env.BINANCE_TESTNET_API_KEY?.trim();
    const apiSecret = process.env.BINANCE_TESTNET_API_SECRET?.trim();
    if (!apiKey || !apiSecret) throw new Error("COINOPS_TESTNET_CREDENTIALS_MISSING");
    return new BinanceSpotTestnetAdapter({ apiKey, apiSecret });
  }

  /** Binance validates TRADE permission and filters without entering an order. */
  async checkTradePermission() {
    const response = await this.signedRequest("POST", "/api/v3/order/test", { symbol: "SOLUSDC", side: "BUY", type: "MARKET", quoteOrderQty: "10" });
    return { ok: response.ok, error: response.ok ? null : `BINANCE_TEST_ORDER_HTTP_${response.status}_${response.code ?? "UNKNOWN"}` };
  }

  /** Short-lived subscription probe. Persistent order events need a separate worker. */
  async checkUserStreamPermission(): Promise<{ ok: boolean; error: string | null }> {
    if (typeof WebSocket === "undefined") return { ok: false, error: "TESTNET_WEBSOCKET_RUNTIME_UNAVAILABLE" };
    const timestamp = await this.reads.getServerTime();
    const signature = createHmac("sha256", this.credentials.apiSecret).update(`apiKey=${this.credentials.apiKey}&timestamp=${timestamp}`).digest("hex");
    return new Promise((resolve) => {
      let settled = false;
      const socket = new WebSocket("wss://ws-api.testnet.binance.vision/ws-api/v3");
      const finish = (result: { ok: boolean; error: string | null }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        socket.close();
        resolve(result);
      };
      const timeout = setTimeout(() => finish({ ok: false, error: "TESTNET_USER_STREAM_TIMEOUT" }), 8000);
      socket.addEventListener("open", () => socket.send(JSON.stringify({ id: "coinops-stream-probe", method: "userDataStream.subscribe.signature", params: { apiKey: this.credentials.apiKey, timestamp, signature } })));
      socket.addEventListener("message", (event) => {
        try {
          const message = JSON.parse(String(event.data)) as { id?: string; status?: number; error?: { code?: number } };
          if (message.id !== "coinops-stream-probe") return;
          finish({ ok: message.status === 200, error: message.status === 200 ? null : `TESTNET_USER_STREAM_${message.status ?? "UNKNOWN"}_${message.error?.code ?? "UNKNOWN"}` });
        } catch { finish({ ok: false, error: "TESTNET_USER_STREAM_INVALID_RESPONSE" }); }
      });
      socket.addEventListener("error", () => finish({ ok: false, error: "TESTNET_USER_STREAM_NETWORK_ERROR" }));
      socket.addEventListener("close", () => finish({ ok: false, error: "TESTNET_USER_STREAM_CLOSED" }));
    });
  }

  async getOwnedOrder(symbol: string, clientOrderId: string): Promise<TestnetOrder | null> {
    verifyOwned(symbol, clientOrderId);
    const response = await this.signedRequest("GET", "/api/v3/order", { symbol, origClientOrderId: clientOrderId });
    if (response.code === -2013) return null;
    if (!response.ok) throw new Error(`COINOPS_TESTNET_ORDER_QUERY_HTTP_${response.status}`);
    return normalizeOrder(response.payload as OrderPayload, clientOrderId);
  }

  /** Recover a previously persisted owned exchange ID after Binance changes its client ID on cancel. */
  async getKnownOrderById(symbol: string, clientOrderId: string, expectedOrderId: string): Promise<TestnetOrder | null> {
    verifyOwned(symbol, clientOrderId);
    if (!/^\d+$/.test(expectedOrderId)) throw new Error("COINOPS_TESTNET_ORDER_ID_INVALID");
    const response = await this.signedRequest("GET", "/api/v3/order", { symbol, orderId: expectedOrderId });
    if (response.code === -2013) return null;
    if (!response.ok) throw new Error(`COINOPS_TESTNET_ORDER_QUERY_HTTP_${response.status}`);
    const payload = response.payload as OrderPayload;
    if (String(payload.orderId) !== expectedOrderId || payload.symbol !== symbol || (payload.clientOrderId !== clientOrderId && payload.status !== "CANCELED")) throw new Error("COINOPS_TESTNET_KNOWN_ORDER_MISMATCH");
    return normalizeOrder({ ...payload, clientOrderId }, clientOrderId);
  }

  async getOwnedTrades(symbol: string, clientOrderId: string, orderId: string): Promise<TestnetTrade[]> {
    const owned = await this.getOwnedOrder(symbol, clientOrderId);
    if (!owned || owned.orderId !== orderId) throw new Error("COINOPS_TESTNET_OWNED_ORDER_NOT_FOUND");
    const response = await this.signedRequest("GET", "/api/v3/myTrades", { symbol, orderId, limit: "100" });
    if (!response.ok || !Array.isArray(response.payload)) throw new Error(`COINOPS_TESTNET_TRADES_HTTP_${response.status}`);
    return (response.payload as TradePayload[]).map((trade) => {
      const quantity = Number(trade.qty), quoteQuantity = Number(trade.quoteQty), commission = Number(trade.commission);
      if (String(trade.orderId) !== orderId || !trade.id || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(quoteQuantity) || quoteQuantity <= 0 || !Number.isFinite(commission) || commission < 0 || !trade.commissionAsset) throw new Error("COINOPS_TESTNET_TRADE_INVALID");
      return { id: String(trade.id), quantity, quoteQuantity, commission, commissionAsset: trade.commissionAsset, isBuyer: Boolean(trade.isBuyer) };
    });
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
      if (response.ok) return normalizeOrder(response.payload as OrderPayload, input.clientOrderId);
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
    const current = await this.getOwnedOrder(symbol, clientOrderId) || await this.getKnownOrderById(symbol, clientOrderId, expectedOrderId);
    if (!current || current.orderId !== expectedOrderId) throw new Error("COINOPS_TESTNET_OWNED_ORDER_NOT_FOUND");
    if (current.status !== "NEW") return current;
    try {
      const response = await this.signedRequest("DELETE", "/api/v3/order", { symbol, orderId: expectedOrderId, origClientOrderId: clientOrderId, newClientOrderId: cancelClientId(clientOrderId), cancelRestrictions: "ONLY_NEW" });
      if (response.ok) {
        const payload = response.payload as OrderPayload;
        if (payload.origClientOrderId === clientOrderId && payload.clientOrderId === cancelClientId(clientOrderId) && String(payload.orderId) === expectedOrderId && payload.status === "CANCELED") return normalizeOrder({ ...payload, clientOrderId }, clientOrderId);
      }
      const recovered = await this.getKnownOrderById(symbol, clientOrderId, expectedOrderId);
      if (recovered && recovered.status !== "NEW") return recovered;
      throw new Error(`COINOPS_TESTNET_CANCEL_HTTP_${response.status}`);
    } catch (error) {
      const recovered = await this.getKnownOrderById(symbol, clientOrderId, expectedOrderId).catch(() => null);
      if (recovered && recovered.status !== "NEW") return recovered;
      throw error;
    }
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
    const body = await response.json().catch(() => ({})) as OrderPayload | TradePayload[];
    return { ok: response.ok, status: response.status, code: Array.isArray(body) ? undefined : body.code, payload: body };
  }
}

/** Explicit, authenticated read probe; no order mutation or /sapi call. */
export async function diagnoseBinanceSpotTestnet() {
  const testnet = BinanceSpotTestnetAdapter.diagnosticFromEnvironment();
  const adapter = testnet.reads;
  const account = await adapter.getAccount();
  const balances = account.balances.filter((item) => ["USDT", "USDC", "BTC", "SOL"].includes(item.asset));
  const symbols = ["SOLUSDC", "BTCUSDC", "SOLUSDT", "BTCUSDT"];
  const probes = await Promise.all(symbols.map(async (symbol) => {
    try {
      const [filters, market, orders] = await Promise.all([adapter.getSymbolInfo(symbol), adapter.getMarketPrice(symbol), adapter.getOpenOrders(symbol)]);
      return { symbol, available: true as const, filters, market, openOrderCount: orders.length, ownedOpenOrderCount: orders.filter((order) => order.clientOrderId?.startsWith("COV1-")).length };
    } catch (error) { return { symbol, available: false as const, error: error instanceof Error ? error.message : "UNKNOWN" }; }
  }));
  const [tradePermission, userStreamPermission] = await Promise.all([testnet.checkTradePermission(), testnet.checkUserStreamPermission()]);
  return { account: { canTrade: account.canTrade, canWithdraw: account.canWithdraw, canDeposit: account.canDeposit, updateTime: account.updateTime }, balances, probes, tradePermission, userStreamPermission, observedAt: new Date().toISOString() };
}
