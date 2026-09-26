import { createHmac } from "node:crypto";

import { BinanceReadOnlyError, BinanceSpotAdapter } from "../../web/lib/execution/binance-spot-adapter.ts";
import { ExecutorRejection } from "./security.mjs";
import { EXECUTOR_CAPS } from "./preparation.mjs";
import { getProductionRestrictedSpotStatus } from "./binance-readonly.mjs";
import { assertEngineOrder, engineOrderPrefix } from "./account-registry.mjs";

const BASE = "https://api.binance.com";
const OWNED_ID = /^COR1-(BTC|SOL)-([1-9]|1[0-9]|2[0-5])-([1-9][0-9]*)-(BUY|SELL)-[a-f0-9]{14}$/;
const DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,12})?$/;
const ACTIVE = new Set(["NEW", "PARTIALLY_FILLED"]);

function positive(value) { return typeof value === "number" && Number.isFinite(value) && value > 0; }
function exactStep(value, step) { return Math.abs(value / step - Math.round(value / step)) < 1e-7; }
function ownedId(symbol, clientOrderId, side) {
  const match = OWNED_ID.exec(clientOrderId ?? "");
  if (!match || symbol !== `${match[1]}BRL` || (side && match[4] !== side))
    throw new ExecutorRejection("EXECUTOR_ORDER_NOT_OWNED", 403);
  return match;
}
function normalizeOrder(payload, clientOrderId, engine = null) {
  if (!payload || payload.clientOrderId !== clientOrderId || !/^\d+$/.test(String(payload.orderId))
    || !(engine ? payload.symbol === engine.symbol : ["BTCBRL", "SOLBRL"].includes(payload.symbol)) || !["BUY", "SELL"].includes(payload.side)
    || typeof payload.status !== "string") throw new ExecutorRejection("EXECUTOR_ORDER_RESPONSE_INVALID", 503);
  if (engine) assertEngineOrder(engine, payload.symbol, clientOrderId, payload.side);
  else ownedId(payload.symbol, clientOrderId, payload.side);
  const executedQuantity = Number(payload.executedQty ?? 0);
  const cumulativeQuoteQuantity = Number(payload.cummulativeQuoteQty ?? 0);
  const price = Number(payload.price ?? 0);
  if (![executedQuantity, cumulativeQuoteQuantity, price].every((value) => Number.isFinite(value) && value >= 0))
    throw new ExecutorRejection("EXECUTOR_ORDER_RESPONSE_INVALID", 503);
  return { orderId: String(payload.orderId), clientOrderId, symbol: payload.symbol,
    side: payload.side, status: payload.status, executedQuantity, cumulativeQuoteQuantity, price };
}

/** Production transport exists only on the fixed-IP VPS. It never accepts an
 * exchange host, asset, or client order namespace from arbitrary callers. */
export class BinanceLiveTransport {
  constructor({ apiKey, apiSecret, fetcher = fetch, now = Date.now, engine = null, sharedAccountRead = null }) {
    if (!apiKey || !apiSecret) throw new ExecutorRejection("EXECUTOR_BINANCE_CREDENTIALS_MISSING", 503);
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.fetcher = fetcher;
    this.now = now;
    this.reads = new BinanceSpotAdapter({ apiKey, apiSecret }, { fetcher, now, maxReadRetries: 0 });
    this.offset = null;
    this.engine = engine;
    this.sharedAccountRead = sharedAccountRead;
  }

  ownership(symbol, id, side) {
    if (this.engine) {
      const owned = assertEngineOrder(this.engine, symbol, id, side);
      return [id, this.engine.base_asset, owned.slot, null, owned.side];
    }
    return ownedId(symbol, id, side);
  }

  async signed(method, path, fields = {}) {
    if (this.offset === null) this.offset = (await this.reads.getServerTime()) - this.now();
    const params = new URLSearchParams({ ...fields, recvWindow: "5000", timestamp: String(this.now() + this.offset) });
    params.set("signature", createHmac("sha256", this.apiSecret).update(params.toString()).digest("hex"));
    let response;
    try {
      response = await this.fetcher(`${BASE}${path}${method === "GET" ? `?${params}` : ""}`, {
        method, cache: "no-store", signal: AbortSignal.timeout(8000),
        headers: { accept: "application/json", "X-MBX-APIKEY": this.apiKey,
          ...(method === "GET" ? {} : { "content-type": "application/x-www-form-urlencoded" }) },
        ...(method === "GET" ? {} : { body: params.toString() }),
      });
    } catch { throw new ExecutorRejection("EXECUTOR_BINANCE_RESULT_UNKNOWN", 503); }
    const body = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, code: body?.code, body };
  }

  async safetySnapshot(symbol) {
    if (this.engine ? symbol !== this.engine.symbol : symbol !== "BTCBRL" && symbol !== "SOLBRL")
      throw new ExecutorRejection("EXECUTOR_SYMBOL_DENIED", 403);
    // Retry only a complete GET snapshot after a transient read failure. A
    // partially observed snapshot is never reused for an order decision.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const accountPromise = this.sharedAccountRead
          ? this.sharedAccountRead(() => this.reads.getAccount()) : this.reads.getAccount();
        const [permission, account, filters, price, openOrders, bnbBrlPrice] = await Promise.all([
          getProductionRestrictedSpotStatus({ apiKey: this.apiKey, apiSecret: this.apiSecret,
            fetcher: this.fetcher, adapter: this.reads, accountPromise }),
          accountPromise, this.reads.getSymbolInfo(symbol), this.reads.getMarketPrice(symbol),
          this.reads.getOpenOrders(symbol),
          this.reads.getMarketPrice(`BNB${this.engine?.quote_asset ?? "BRL"}`).catch(() => null),
        ]);
        if (permission === "UNVERIFIED" && attempt === 0) continue;
        if (permission !== "SPOT_RESTRICTED" || !account.canTrade)
          throw new ExecutorRejection("EXECUTOR_PRODUCTION_PERMISSION_DENIED", 503);
        if (this.engine && (filters.baseAsset !== this.engine.base_asset || filters.quoteAsset !== this.engine.quote_asset))
          throw new ExecutorRejection("EXECUTOR_MARKET_IDENTITY_MISMATCH", 503);
        return { account, filters, price, openOrders, bnbBrlPrice };
      } catch (error) {
        if (attempt === 0 && error instanceof BinanceReadOnlyError && error.retryable) continue;
        throw error;
      }
    }
    throw new ExecutorRejection("EXECUTOR_PRODUCTION_PERMISSION_DENIED", 503);
  }

  /** Existing Shadow-vs-Production audit reads through the whitelisted IPv4.
   * Manual BTCUSDT/SOLUSDT orders are observed only; this path has no writes. */
  async legacyReconciliationSnapshot() {
    const [permission, account, capabilities, btcInfo, solInfo, btcPrice, solPrice,
      btcOrders, solOrders, btcTrades, solTrades] = await Promise.all([
      getProductionRestrictedSpotStatus({ apiKey: this.apiKey, apiSecret: this.apiSecret, fetcher: this.fetcher }),
      this.reads.getAccount(), this.reads.getCapabilities(),
      this.reads.getSymbolInfo("BTCUSDT"), this.reads.getSymbolInfo("SOLUSDT"),
      this.reads.getMarketPrice("BTCUSDT"), this.reads.getMarketPrice("SOLUSDT"),
      this.reads.getOpenOrders("BTCUSDT"), this.reads.getOpenOrders("SOLUSDT"),
      this.reads.getTrades("BTCUSDT"), this.reads.getTrades("SOLUSDT"),
    ]);
    if (permission !== "SPOT_RESTRICTED" || !account.canTrade || !capabilities.ipRestricted
      || capabilities.withdrawalsEnabled)
      throw new ExecutorRejection("EXECUTOR_PRODUCTION_PERMISSION_DENIED", 503);
    return { capabilities, account, filters: { BTCUSDT: btcInfo, SOLUSDT: solInfo },
      prices: { BTCUSDT: btcPrice, SOLUSDT: solPrice },
      orders: [...btcOrders, ...solOrders], trades: [...btcTrades, ...solTrades] };
  }

  async queryOrder(symbol, clientOrderId, expectedOrderId = null) {
    this.ownership(symbol, clientOrderId);
    const params = expectedOrderId
      ? { symbol, orderId: String(expectedOrderId) }
      : { symbol, origClientOrderId: clientOrderId };
    if (expectedOrderId && !/^\d+$/.test(String(expectedOrderId)))
      throw new ExecutorRejection("EXECUTOR_ORDER_ID_INVALID", 400);
    const response = await this.signed("GET", "/api/v3/order", params);
    if (response.code === -2013) return null;
    if (!response.ok) throw new ExecutorRejection("EXECUTOR_ORDER_QUERY_FAILED", 503);
    const body = response.body;
    if (body.symbol !== symbol || !expectedOrderId && body.clientOrderId !== clientOrderId)
      throw new ExecutorRejection("EXECUTOR_ORDER_IDENTITY_MISMATCH", 503);
    if (expectedOrderId && (String(body.orderId) !== String(expectedOrderId)
      || body.clientOrderId !== clientOrderId && body.status !== "CANCELED"))
      throw new ExecutorRejection("EXECUTOR_ORDER_IDENTITY_MISMATCH", 503);
    return normalizeOrder({ ...body, clientOrderId }, clientOrderId, this.engine);
  }

  async ownedTrades(symbol, clientOrderId, orderId) {
    const owned = await this.queryOrder(symbol, clientOrderId, orderId);
    if (!owned || owned.orderId !== String(orderId)) throw new ExecutorRejection("EXECUTOR_ORDER_NOT_FOUND", 503);
    // REST myTrades accepts symbol+orderId, but not orderId+fromId. An order
    // with 1000 fills is deliberately held for manual reconciliation rather
    // than silently accepting an incomplete page.
    const response = await this.signed("GET", "/api/v3/myTrades", {
      symbol, orderId: String(orderId), limit: "1000" });
    if (!response.ok || !Array.isArray(response.body)) throw new ExecutorRejection("EXECUTOR_TRADES_QUERY_FAILED", 503);
    if (response.body.length >= 1000) throw new ExecutorRejection("EXECUTOR_TRADES_PAGE_LIMIT", 503);
    const trades = new Map();
    for (const trade of response.body) {
        const id = String(trade.id), quantity = Number(trade.qty), quoteQuantity = Number(trade.quoteQty), commission = Number(trade.commission);
        if (String(trade.orderId) !== String(orderId) || !/^\d+$/.test(id) || !positive(quantity)
          || !positive(quoteQuantity) || !Number.isFinite(commission) || commission < 0
          || typeof trade.commissionAsset !== "string" || !trade.commissionAsset
          || trade.isBuyer !== (owned.side === "BUY") || !Number.isFinite(Number(trade.time)))
          throw new ExecutorRejection("EXECUTOR_TRADE_INVALID", 503);
        const row = { id, quantity, quoteQuantity, commission, commissionAsset: trade.commissionAsset,
          isBuyer: trade.isBuyer, filledAt: new Date(Number(trade.time)).toISOString() };
        if (trades.has(id) && JSON.stringify(trades.get(id)) !== JSON.stringify(row))
          throw new ExecutorRejection("EXECUTOR_TRADE_ID_COLLISION", 503);
        trades.set(id, row);
    }
    return [...trades.values()];
  }

  async testOrderPermission(symbol, quoteOrderQty) {
    if (!positive(quoteOrderQty) || quoteOrderQty > EXECUTOR_CAPS[symbol.slice(0, -3)]?.orderBrl)
      throw new ExecutorRejection("EXECUTOR_HARD_CAP_DENIED", 403);
    const response = await this.signed("POST", "/api/v3/order/test", {
      symbol, side: "BUY", type: "MARKET", quoteOrderQty: String(quoteOrderQty) });
    if (!response.ok) throw new ExecutorRejection("EXECUTOR_SPOT_TRADE_PERMISSION_DENIED", 503);
    return true;
  }

  /** Query-first, one dispatch only. A lost outcome stays unknown until the
   * exact client ID is observed; callers must never submit a second ID. */
  async createOwnedOrder(input, { allowCreate, tradingEnabled, killSwitch }) {
    const { symbol, clientOrderId, side, purpose } = input;
    const match = this.ownership(symbol, clientOrderId, side);
    if (purpose !== (side === "SELL" ? "TP" : input.type === "MARKET" ? "INITIAL" : "ENTRY"))
      throw new ExecutorRejection("EXECUTOR_PURPOSE_INVALID", 403);
    const existing = await this.queryOrder(symbol, clientOrderId);
    if (existing) return existing;
    if (!allowCreate) throw new ExecutorRejection("EXECUTOR_SUBMISSION_OUTCOME_UNKNOWN", 503);
    if (!tradingEnabled || killSwitch && side !== "SELL")
      throw new ExecutorRejection("EXECUTOR_TRADING_DISABLED", 403);
    const snapshot = await this.safetySnapshot(symbol);
    if (side === "BUY" && (!snapshot.bnbBrlPrice
      || !snapshot.account.balances.some((balance) => balance.asset === "BNB" && balance.free > 0.00001)))
      throw new ExecutorRejection("EXECUTOR_BNB_FEE_RESERVE_MISSING", 503);
    const observedOwn = snapshot.openOrders.filter((order) => order.clientOrderId?.startsWith(this.engine ? engineOrderPrefix(this.engine) : `COR1-${match[1]}-`))
      .map((order) => order.clientOrderId).sort();
    const expectedOwn = Array.isArray(input.expectedOwnedOpenIds)
      ? [...input.expectedOwnedOpenIds].sort() : null;
    if (!expectedOwn || new Set(expectedOwn).size !== expectedOwn.length
      || JSON.stringify(observedOwn) !== JSON.stringify(expectedOwn))
      throw new ExecutorRejection("EXECUTOR_UNRECONCILED_OWNED_ORDER", 503);
    const hard = this.engine ? { exposureBrl: this.engine.hard_cap_quote, orderBrl: this.engine.max_order_quote } : EXECUTOR_CAPS[match[1]];
    const maxAsset = Number(input.assetCapBrl), maxGlobal = Number(input.globalCapBrl);
    const beforeAsset = Number(input.assetExposureBeforeBrl), beforeGlobal = Number(input.globalExposureBeforeBrl);
    if (!positive(maxAsset) || maxAsset > hard.exposureBrl || !positive(maxGlobal) || maxGlobal > (this.engine?.account_cap_quote ?? EXECUTOR_CAPS.globalBrl)
      || !Number.isFinite(beforeAsset) || beforeAsset < 0 || !Number.isFinite(beforeGlobal) || beforeGlobal < 0
      || beforeAsset > maxAsset || beforeGlobal > maxGlobal)
      throw new ExecutorRejection("EXECUTOR_HARD_CAP_DENIED", 403);
    let fields, notional;
    if (input.type === "MARKET" && side === "BUY") {
      const quote = String(input.quoteOrderQty ?? "");
      notional = Number(quote);
      if (!DECIMAL.test(quote) || !positive(notional) || !snapshot.account.balances.some((b) => b.asset === (this.engine?.quote_asset ?? "BRL") && b.free + 1e-8 >= notional))
        throw new ExecutorRejection("EXECUTOR_MARKET_BUY_INVALID", 403);
      fields = { symbol, side, type: "MARKET", quoteOrderQty: quote };
    } else if (input.type === "LIMIT" && (side === "BUY" || side === "SELL")) {
      const quantity = String(input.quantity ?? ""), price = String(input.price ?? "");
      const q = Number(quantity), p = Number(price);
      notional = q * p;
      if (!DECIMAL.test(quantity) || !DECIMAL.test(price) || !positive(q) || !positive(p)
        || q < snapshot.filters.minQuantity || q > snapshot.filters.maxQuantity
        || !exactStep(q, snapshot.filters.quantityStep) || !exactStep(p, snapshot.filters.priceTick)
        || notional + 1e-8 < snapshot.filters.minNotional)
        throw new ExecutorRejection("EXECUTOR_LIMIT_FILTER_INVALID", 403);
      if (side === "BUY" && !snapshot.account.balances.some((b) => b.asset === (this.engine?.quote_asset ?? "BRL") && b.free + 1e-8 >= notional))
        throw new ExecutorRejection("EXECUTOR_QUOTE_BALANCE_INSUFFICIENT", 403);
      if (side === "SELL") {
        const source = this.ownership(symbol, input.sourceBuyClientOrderId, "BUY");
        if (source[2] !== match[2] || !/^\d+$/.test(String(input.sourceBuyOrderId ?? "")))
          throw new ExecutorRejection("EXECUTOR_TP_SOURCE_UNVERIFIED", 403);
        const ownBuy = await this.queryOrder(symbol, input.sourceBuyClientOrderId, input.sourceBuyOrderId);
        if (!ownBuy || ownBuy.side !== "BUY" || ownBuy.executedQuantity + 1e-10 < q)
          throw new ExecutorRejection("EXECUTOR_TP_SOURCE_UNVERIFIED", 403);
        if (!snapshot.account.balances.some((b) => b.asset === match[1] && b.free + 1e-10 >= q))
          throw new ExecutorRejection("EXECUTOR_TP_BASE_BALANCE_INSUFFICIENT", 403);
      }
      fields = { symbol, side, type: "LIMIT", timeInForce: "GTC", quantity, price };
    } else throw new ExecutorRejection("EXECUTOR_ORDER_TYPE_DENIED", 403);
    if (!positive(notional) || side === "BUY" && (notional > hard.orderBrl + 1e-8
      || beforeAsset + notional > maxAsset + 1e-8 || beforeGlobal + notional > maxGlobal + 1e-8))
      throw new ExecutorRejection("EXECUTOR_HARD_CAP_DENIED", 403);
    // TP may be protective while kill switch is ON, never an unowned SELL.
    if (killSwitch && side === "SELL" && !input.sourceBuyClientOrderId)
      throw new ExecutorRejection("EXECUTOR_PROTECTION_UNVERIFIED", 403);
    const response = await this.signed("POST", "/api/v3/order", { ...fields,
      newClientOrderId: clientOrderId, newOrderRespType: "FULL" });
    if (response.ok) return normalizeOrder(response.body, clientOrderId, this.engine);
    const recovered = await this.queryOrder(symbol, clientOrderId);
    if (recovered) return recovered;
    throw new ExecutorRejection("EXECUTOR_ORDER_POST_UNKNOWN", 503);
  }

  async cancelOwnedBuy({ symbol, clientOrderId, orderId }, { tradingEnabled, killSwitch }) {
    this.ownership(symbol, clientOrderId, "BUY");
    if (!tradingEnabled) throw new ExecutorRejection("EXECUTOR_TRADING_DISABLED", 403);
    const current = await this.queryOrder(symbol, clientOrderId, orderId);
    if (!current) throw new ExecutorRejection("EXECUTOR_ORDER_NOT_FOUND", 503);
    if (!ACTIVE.has(current.status)) throw new ExecutorRejection("EXECUTOR_CANCEL_NOT_ACTIVE", 403);
    await this.safetySnapshot(symbol);
    const response = await this.signed("DELETE", "/api/v3/order", {
      symbol, orderId: String(orderId), origClientOrderId: clientOrderId,
      ...(current.status === "NEW" ? { cancelRestrictions: "ONLY_NEW" } : {}) });
    if (response.ok && response.body.origClientOrderId === clientOrderId
      && String(response.body.orderId) === String(orderId) && response.body.status === "CANCELED")
      return normalizeOrder({ ...response.body, clientOrderId }, clientOrderId, this.engine);
    const recovered = await this.queryOrder(symbol, clientOrderId, orderId);
    if (recovered?.status === "CANCELED") return recovered;
    throw new ExecutorRejection("EXECUTOR_CANCEL_OUTCOME_UNKNOWN", 503);
  }
}
