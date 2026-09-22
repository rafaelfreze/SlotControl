import { createHmac } from "node:crypto";

import { assertV1Symbol } from "./robot-v1.ts";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export const BINANCE_SPOT_TESTNET_BASE_URL = "https://testnet.binance.vision";

export type TestnetLimitOrder = { symbol: "BTCUSDC" | "SOLUSDC"; side: "BUY" | "SELL"; quantity: number; price: number; clientOrderId: string };
export type TestnetOrderResult = { orderId: string; clientOrderId: string; status: string; executedQuantity: number };

/** Separate write capability for Binance Spot Testnet only. It never reads
 * Production credentials or accepts manual USDT pairs. */
export class BinanceSpotTestnetAdapter {
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly fetcher: FetchLike;
  private readonly now: () => number;

  private constructor(apiKey: string, apiSecret: string, fetcher: FetchLike = fetch, now: () => number = Date.now) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.fetcher = fetcher;
    this.now = now;
  }

  static fromEnvironment() {
    const apiKey = process.env.BINANCE_TESTNET_API_KEY?.trim();
    const apiSecret = process.env.BINANCE_TESTNET_API_SECRET?.trim();
    if (!apiKey || !apiSecret) throw new Error("COINOPS_TESTNET_CREDENTIALS_NOT_CONFIGURED");
    return new BinanceSpotTestnetAdapter(apiKey, apiSecret);
  }

  static forTest(apiKey: string, apiSecret: string, fetcher: FetchLike, now: () => number = Date.now) {
    return new BinanceSpotTestnetAdapter(apiKey, apiSecret, fetcher, now);
  }

  async createLimitOrder(input: TestnetLimitOrder): Promise<TestnetOrderResult> {
    assertV1Symbol(input.symbol);
    if (![input.quantity, input.price].every(Number.isFinite) || input.quantity <= 0 || input.price <= 0 || !input.clientOrderId.startsWith("COV1-")) throw new Error("COINOPS_TESTNET_ORDER_INVALID");
    const existing = await this.getOwnedOrder(input.symbol, input.clientOrderId);
    if (existing) return existing;
    return this.signedWrite("POST", "/api/v3/order", { symbol: input.symbol, side: input.side, type: "LIMIT", timeInForce: "GTC", quantity: String(input.quantity), price: String(input.price), newClientOrderId: input.clientOrderId });
  }

  async cancelOwnedOrder(symbol: string, orderId: string, clientOrderId: string): Promise<TestnetOrderResult> {
    assertV1Symbol(symbol);
    if (!orderId || !clientOrderId.startsWith("COV1-")) throw new Error("COINOPS_TESTNET_OWNERSHIP_REQUIRED");
    const existing = await this.getOwnedOrder(symbol, clientOrderId);
    if (!existing || existing.orderId !== orderId) throw new Error("COINOPS_TESTNET_OWNED_ORDER_NOT_FOUND");
    return this.signedWrite("DELETE", "/api/v3/order", { symbol, orderId, origClientOrderId: clientOrderId });
  }

  /** Reconciliation before mutation is mandatory even on Testnet. */
  async getOwnedOrder(symbol: string, clientOrderId: string): Promise<TestnetOrderResult | null> {
    assertV1Symbol(symbol);
    if (!clientOrderId.startsWith("COV1-")) throw new Error("COINOPS_TESTNET_OWNERSHIP_REQUIRED");
    const query = new URLSearchParams({ symbol, origClientOrderId: clientOrderId, recvWindow: "5000", timestamp: String(this.now()) });
    query.set("signature", createHmac("sha256", this.apiSecret).update(query.toString()).digest("hex"));
    const response = await this.fetcher(`${BINANCE_SPOT_TESTNET_BASE_URL}/api/v3/order?${query.toString()}`, { method: "GET", headers: { "X-MBX-APIKEY": this.apiKey, accept: "application/json" } });
    const payload = await response.json().catch(() => ({})) as { orderId?: number | string; clientOrderId?: string; status?: string; executedQty?: string };
    if (response.status === 400 || response.status === 404) return null;
    if (!response.ok || !payload.orderId || payload.clientOrderId !== clientOrderId || !payload.status) throw new Error("COINOPS_TESTNET_ORDER_RECOVERY_FAILED");
    return { orderId: String(payload.orderId), clientOrderId: payload.clientOrderId, status: payload.status, executedQuantity: Number(payload.executedQty || 0) };
  }

  private async signedWrite(method: "POST" | "DELETE", path: string, params: Record<string, string>): Promise<TestnetOrderResult> {
    const query = new URLSearchParams({ ...params, recvWindow: "5000", timestamp: String(this.now()) });
    query.set("signature", createHmac("sha256", this.apiSecret).update(query.toString()).digest("hex"));
    const response = await this.fetcher(`${BINANCE_SPOT_TESTNET_BASE_URL}${path}?${query.toString()}`, { method, headers: { "X-MBX-APIKEY": this.apiKey, accept: "application/json" } });
    const payload = await response.json().catch(() => ({})) as { orderId?: number | string; clientOrderId?: string; status?: string; executedQty?: string; code?: number };
    if (!response.ok || !payload.orderId || !payload.clientOrderId || !payload.status) throw new Error("COINOPS_TESTNET_ORDER_FAILED");
    return { orderId: String(payload.orderId), clientOrderId: payload.clientOrderId, status: payload.status, executedQuantity: Number(payload.executedQty || 0) };
  }
}
