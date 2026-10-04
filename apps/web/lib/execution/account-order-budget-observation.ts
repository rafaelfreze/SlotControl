import type { AccountOrderBudget, AccountOrderInterval } from "./account-order-budget.ts";

type ObservedOrder = { id: string; symbol: string; clientOrderId: string | null; side: string; status: string };
export type BudgetObservation = { operator_id: string; exchange_account_id: string; environment: string;
  executor_shard_id: string; executor_ip: string; credential_ref: string; executor_version: string;
  observedAt: number; serverTime: number; intervals: AccountOrderInterval[]; restrictions: string[];
  symbols: Array<{ symbol: string; maxOrders: number; selfTradePrevention: "EXPIRE_TAKER" | null;
    openOrders: ObservedOrder[] }>;
  exchangeOrders: { limit: number; openOrders: ObservedOrder[] } | null };
export type KnownBudgetOrder = { id: string; operator_id: string; exchange_account_id: string;
  trading_engine_id: string; symbol: string; client_order_id: string; exchange_order_id: string | null; side: string };
export type BudgetEngineIdentity = { id: string; operator_id: string; exchange_account_id: string; symbol: string };

/** Count external orders conservatively. A prefix or symbol alone never proves
 * ownership. This read model cannot adopt/cancel/reconcile any observed order. */
export function projectAccountBudgetObservation(sample: BudgetObservation, input: {
  operatorId: string; accountId: string; shardId: string; ip: string; credentialRef: string;
  versions: readonly string[]; symbols: readonly string[]; engines: readonly BudgetEngineIdentity[];
  ledger: readonly KnownBudgetOrder[] }, now = Date.now()): AccountOrderBudget {
  const fail = (): never => { throw new Error("COINOPS_ACCOUNT_ORDER_BUDGET_OBSERVATION_INVALID"); };
  if (!sample || sample.operator_id !== input.operatorId || sample.exchange_account_id !== input.accountId
    || sample.environment !== "REAL" || sample.executor_shard_id !== input.shardId
    || sample.executor_ip !== input.ip || sample.credential_ref !== input.credentialRef
    || !input.versions.includes(sample.executor_version) || !Number.isFinite(now)
    || !Number.isFinite(sample.observedAt) || now - sample.observedAt > 30_000 || sample.observedAt > now + 2000
    || !Number.isSafeInteger(sample.serverTime) || Math.abs(sample.serverTime - sample.observedAt) > 2000
    || !Array.isArray(sample.intervals) || !sample.intervals.length
    || new Set(sample.intervals.map((row) => row.intervalMs)).size !== sample.intervals.length
    || !Array.isArray(sample.restrictions) || sample.restrictions.some((row) => typeof row !== "string")
    || !Array.isArray(sample.symbols) || sample.symbols.length !== input.symbols.length
    || !input.symbols.length || new Set(input.symbols).size !== input.symbols.length
    || new Set(sample.symbols.map((row) => row.symbol)).size !== sample.symbols.length
    || input.symbols.some((symbol) => !/^(BTC|SOL)(BRL|USDT)$/.test(symbol)
      || !sample.symbols.some((row) => row.symbol === symbol))) return fail();
  const offset = sample.serverTime - sample.observedAt;
  if (sample.intervals.some((row) => !Number.isSafeInteger(row.intervalMs) || row.intervalMs < 1
    || !Number.isSafeInteger(row.limit) || row.limit < 1 || !Number.isSafeInteger(row.count) || row.count < 0
    || Math.floor(sample.serverTime / row.intervalMs) !== Math.floor((now + offset) / row.intervalMs))) return fail();
  const engines = new Map(input.engines.map((row) => [row.id, row]));
  if (engines.size !== input.engines.length || input.engines.some((row) => !row.id
    || row.operator_id !== input.operatorId || row.exchange_account_id !== input.accountId)) return fail();
  const owned = new Map<string, KnownBudgetOrder>();
  for (const order of input.ledger) {
    const engine = engines.get(order.trading_engine_id);
    if (!engine || order.operator_id !== input.operatorId || order.exchange_account_id !== input.accountId
      || order.symbol !== engine.symbol || !order.client_order_id || !order.exchange_order_id
      || !["BUY", "SELL"].includes(order.side)) return fail();
    const key = `${order.symbol}:${order.exchange_order_id}`;
    if (owned.has(key)) return fail();
    owned.set(key, order);
  }
  function counts(orders: ObservedOrder[]) {
    if (!Array.isArray(orders) || new Set(orders.map((row) => `${row.symbol}:${row.id}`)).size !== orders.length
      || orders.some((row) => !row.id || !row.symbol || !["BUY", "SELL"].includes(row.side)
        || !["NEW", "PARTIALLY_FILLED"].includes(row.status))) return fail();
    const external = orders.filter((row) => {
      const known = owned.get(`${row.symbol}:${row.id}`);
      return !known || known.client_order_id !== row.clientOrderId || known.side !== row.side;
    }).length;
    return { openOrders: orders.length, externalOrders: external };
  }
  const symbols: AccountOrderBudget["symbols"] = {};
  for (const row of sample.symbols) {
    if (!Number.isSafeInteger(row.maxOrders) || row.maxOrders < 1
      || ![null, "EXPIRE_TAKER"].includes(row.selfTradePrevention)
      || !Array.isArray(row.openOrders) || row.openOrders.some((order) => order.symbol !== row.symbol)) return fail();
    symbols[row.symbol] = { maxOrders: row.maxOrders, selfTradePrevention: row.selfTradePrevention, ...counts(row.openOrders) };
  }
  if (sample.exchangeOrders && (!Number.isSafeInteger(sample.exchangeOrders.limit) || sample.exchangeOrders.limit < 1)) return fail();
  // If an exchange-wide filter requires the account-wide inventory, its native
  // subsets must agree with the same observation, not another partial response.
  if (sample.exchangeOrders) for (const row of sample.symbols) {
    const observed = sample.exchangeOrders.openOrders.filter((order) => order.symbol === row.symbol);
    if (JSON.stringify(observed) !== JSON.stringify(row.openOrders)) return fail();
  }
  return { accountId: input.accountId, observedAt: sample.observedAt, serverTime: sample.serverTime,
    intervals: sample.intervals.map((row) => ({ ...row })), restrictions: [...sample.restrictions], symbols,
    exchangeOrders: sample.exchangeOrders ? { limit: sample.exchangeOrders.limit, ...counts(sample.exchangeOrders.openOrders) } : null };
}
