import { ExecutorRejection } from "./security.mjs";
import { createHash } from "node:crypto";

const INTERVAL = { SECOND: 1000, MINUTE: 60_000, HOUR: 3_600_000, DAY: 86_400_000 };
const fail = () => { throw new ExecutorRejection("EXECUTOR_ACCOUNT_ORDER_BUDGET_UNKNOWN", 503); };
const integer = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum;
const SYMBOL_FILTERS = new Set(["PRICE_FILTER", "PERCENT_PRICE", "PERCENT_PRICE_BY_SIDE", "LOT_SIZE",
  "MIN_NOTIONAL", "NOTIONAL", "ICEBERG_PARTS", "MARKET_LOT_SIZE", "MAX_NUM_ORDERS",
  "MAX_NUM_ALGO_ORDERS", "MAX_NUM_ICEBERG_ORDERS", "TRAILING_DELTA", "MAX_NUM_ORDER_LISTS", "MAX_NUM_ORDER_AMENDS"]);
const EXCHANGE_FILTERS = new Set(["EXCHANGE_MAX_NUM_ORDERS", "EXCHANGE_MAX_NUM_ALGO_ORDERS",
  "EXCHANGE_MAX_NUM_ICEBERG_ORDERS", "EXCHANGE_MAX_NUM_ORDER_LISTS"]);
const validateFilters = (rows) => {
  if (!Array.isArray(rows) || rows.some((row) => !row || typeof row.filterType !== "string")
    || new Set(rows.map((row) => row.filterType)).size !== rows.length) fail();
  return rows;
};

/** Explicit signed observation only. No order history, write, assumed reset,
 * per-IP summation or inference from another API Key's local counters. */
export async function readAccountOrderBudget(transport, symbols) {
  if (!Array.isArray(symbols) || !symbols.length || new Set(symbols).size !== symbols.length
    || symbols.some((symbol) => !/^(BTC|SOL)(BRL|USDT)$/.test(symbol))) fail();
  if (transport.offset === null) transport.offset = await transport.reads.getServerTime() - transport.now();
  const observedAt = transport.now(), serverTime = observedAt + transport.offset;
  const usage = await transport.signed("GET", "/api/v3/rateLimit/order");
  if (!usage.ok || !Array.isArray(usage.body) || !usage.body.length) fail();
  const intervals = usage.body.map((row) => {
    if (row.rateLimitType !== "ORDERS" || !INTERVAL[row.interval]
      || !integer(row.intervalNum, 1) || !integer(row.limit, 1) || !integer(row.count)) fail();
    const intervalMs = INTERVAL[row.interval] * row.intervalNum;
    if (!integer(intervalMs, 1) || Math.floor(serverTime / intervalMs)
      !== Math.floor((transport.now() + transport.offset) / intervalMs)) fail();
    return { intervalMs, limit: row.limit, count: row.count };
  });
  if (new Set(intervals.map((row) => row.intervalMs)).size !== intervals.length) fail();
  const params = new URLSearchParams({ symbols: JSON.stringify(symbols) });
  const response = await transport.fetcher(`https://data-api.binance.vision/api/v3/exchangeInfo?${params}`,
    { method: "GET", cache: "no-store", signal: AbortSignal.timeout(8000) });
  const info = await response.json();
  if (!response.ok || !Array.isArray(info.symbols) || !Array.isArray(info.exchangeFilters)) fail();
  const restrictions = new Set();
  const globalFilters = [...validateFilters(info.exchangeFilters)];
  // Public exchangeInfo does not expose account-specific MAX_ASSET. Query the
  // signed account filters on explicit onboarding only, never per render/cron.
  const limits = [];
  for (const symbol of symbols) {
    const rows = info.symbols.filter((row) => row.symbol === symbol && row.status === "TRADING");
    if (rows.length !== 1) fail();
    const relevant = await transport.signed("GET", "/api/v3/myFilters", { symbol });
    if (!relevant.ok || !relevant.body || !Array.isArray(relevant.body.assetFilters)) fail();
    const all = [...validateFilters(rows[0].filters), ...validateFilters(relevant.body.symbolFilters)];
    const filters = all.filter((row) => row.filterType === "MAX_NUM_ORDERS");
    if (!filters.length || filters.some((row) => !integer(row.maxNumOrders, 1))) fail();
    for (const filter of all) if (!SYMBOL_FILTERS.has(filter.filterType)) restrictions.add(`${symbol}:${filter.filterType}`);
    for (const filter of relevant.body.assetFilters) {
      if (!filter || typeof filter.filterType !== "string" || typeof filter.asset !== "string") fail();
      // Until account-global position/value projection is implemented, the
      // presence of MAX_ASSET/MAX_POSITION blocks admission, not old engines.
      restrictions.add(`${filter.asset}:${filter.filterType}`);
    }
    globalFilters.push(...validateFilters(relevant.body.exchangeFilters));
    const modes = rows[0].allowedSelfTradePreventionModes;
    limits.push({ symbol, maxOrders: Math.min(...filters.map((filter) => filter.maxNumOrders)),
      selfTradePrevention: Array.isArray(modes) && modes.includes("EXPIRE_TAKER") ? "EXPIRE_TAKER" : null });
  }
  for (const filter of globalFilters) if (!EXCHANGE_FILTERS.has(filter.filterType)) restrictions.add(`ACCOUNT:${filter.filterType}`);
  const global = globalFilters.filter((row) => row.filterType === "EXCHANGE_MAX_NUM_ORDERS");
  if (global.some((row) => !integer(row.maxNumOrders, 1))) fail();
  // All-account openOrders is requested only when a real exchange-wide filter
  // requires it. Otherwise fetch just the admitted native markets, not history.
  const orders = global.length ? await transport.reads.getOpenOrders()
    : (await Promise.all(symbols.map((symbol) => transport.reads.getOpenOrders(symbol)))).flat();
  if (orders.some((order) => !order.id || !order.symbol || !["NEW", "PARTIALLY_FILLED"].includes(order.status))
    || new Set(orders.map((order) => `${order.symbol}:${order.id}`)).size !== orders.length) fail();
  if (transport.now() - observedAt > 30_000 || Math.abs(transport.offset) > 2000
    || intervals.some((row) => Math.floor(serverTime / row.intervalMs)
      !== Math.floor((transport.now() + transport.offset) / row.intervalMs))) fail();
  return { observedAt, serverTime, intervals, restrictions: [...restrictions].sort(),
    symbols: limits.map((row) => ({ ...row, openOrders: orders.filter((order) => order.symbol === row.symbol) })),
    exchangeOrders: global.length ? { limit: Math.min(...global.map((filter) => filter.maxNumOrders)), openOrders: orders } : null };
}

/** Explicit authenticated preflight only. Coalesce identical account probes,
 * including different engines on this shard; do not create polling per render.
 * Another shard must still use the account-global control-plane lease. */
export function createAccountOrderBudgetReader({ now = Date.now, read = readAccountOrderBudget } = {}) {
  const entries = new Map();
  return async (scope, transport, symbols) => {
    if (!scope || ![scope.operator_id, scope.exchange_account_id].every((id) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id ?? ""))
      || scope.environment !== "REAL" || typeof transport.apiKey !== "string" || !transport.apiKey
      || !Array.isArray(symbols) || !symbols.length || new Set(symbols).size !== symbols.length
      || symbols.some((symbol) => !/^(BTC|SOL)(BRL|USDT)$/.test(symbol))) fail();
    const key = createHash("sha256").update(JSON.stringify([scope.operator_id,
      scope.exchange_account_id, scope.environment, transport.apiKey, [...symbols].sort()])).digest("hex");
    const previous = entries.get(key);
    if (previous && (previous.pending || previous.expires > now())) return structuredClone(await previous.value);
    if (previous?.failedUntil > now()) fail();
    // Never evict an in-flight probe and inadvertently execute it twice.
    if (!previous && entries.size >= 512) {
      for (const [id, entry] of entries) if (!entry.pending && entry.expires <= now()
        && entry.failedUntil <= now()) entries.delete(id);
      if (entries.size >= 512) fail();
    }
    const entry = { pending: true, expires: 0, failedUntil: 0, value: null };
    const value = (async () => {
      try {
        const result = await read(transport, [...symbols].sort());
        if (!Number.isFinite(result.observedAt) || !Number.isFinite(result.serverTime)
          || !Array.isArray(result.intervals) || !result.intervals.length) fail();
        const offset = result.serverTime - result.observedAt;
        entry.expires = Math.min(result.observedAt + 30_000,
          ...result.intervals.map((row) => {
            if (!integer(row.intervalMs, 1)) fail();
            return (Math.floor(result.serverTime / row.intervalMs) + 1) * row.intervalMs - offset;
          }));
        if (entry.expires <= now()) fail();
        return result;
      } catch (error) {
        entry.failedUntil = now() + 5000;
        throw error;
      } finally { entry.pending = false; }
    })();
    entry.value = value;
    entries.set(key, entry);
    return structuredClone(await value);
  };
}
