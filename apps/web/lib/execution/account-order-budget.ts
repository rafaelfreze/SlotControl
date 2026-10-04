/** Binance ORDERS is account-global (all keys, IPs and API transports).
 * This projection never adds IP request-weight budgets or assumes that a fill
 * has released a counter. Only a signed fresh observation can lower usage. */
export type AccountOrderInterval = { intervalMs: number; limit: number; count: number };
export type AccountOrderBudget = { accountId: string; observedAt: number; serverTime: number;
  intervals: AccountOrderInterval[];
  restrictions: string[];
  exchangeOrders?: { limit: number; openOrders: number; externalOrders: number } | null;
  symbols: Record<string, { maxOrders: number; openOrders: number; externalOrders: number;
    selfTradePrevention: "EXPIRE_TAKER" | null }> };
export type AccountOrderReservation = { accountId: string; engineId: string; clientOrderId: string;
  reservedAt: number; acknowledgedAt?: number | null; protectionOrders?: number };
export type AccountOrderBudgetDecision = { code: "PASS" | "ACCOUNT_ORDER_BUDGET_UNKNOWN" | "ACCOUNT_ORDER_CAPACITY_REQUIRED";
  reason: string; intervals: Array<{ intervalMs: number; projected: number; limit: number }> };

export function accountOrderBudgetDecision(sample: AccountOrderBudget | null,
  reservations: readonly AccountOrderReservation[], input: { accountId: string; newOrders: number;
    newEngineSymbol?: string; existingEnginesForSymbol?: number; existingEnginesForAccount?: number;
    newEngines?: number }, now = Date.now()): AccountOrderBudgetDecision {
  const unknown = (reason: string): AccountOrderBudgetDecision => ({ code: "ACCOUNT_ORDER_BUDGET_UNKNOWN", reason, intervals: [] });
  if (!sample || sample.accountId !== input.accountId || !Number.isFinite(now)
    || !Number.isFinite(sample.observedAt) || now - sample.observedAt > 30_000 || sample.observedAt > now + 2000
    || !Number.isFinite(sample.serverTime) || Math.abs(sample.serverTime - sample.observedAt) > 2000
    || !Number.isSafeInteger(input.newOrders) || input.newOrders < 1
    || !Array.isArray(sample.restrictions) || sample.restrictions.some((value) => typeof value !== "string")
    || !sample.intervals.length || sample.intervals.some((interval) =>
      !Number.isSafeInteger(interval.intervalMs) || interval.intervalMs <= 0
      || !Number.isSafeInteger(interval.limit) || interval.limit <= 0
      || !Number.isSafeInteger(interval.count) || interval.count < 0)
    || new Set(sample.intervals.map((interval) => interval.intervalMs)).size !== sample.intervals.length)
    return unknown("fresh signed account ORDERS observation required");
  if (sample.restrictions.length) return unknown(`account-specific filter projection required: ${sample.restrictions.join(", ")}`);
  const own = new Map<string, AccountOrderReservation>();
  for (const row of reservations.filter((row) => row.accountId === input.accountId)) {
    if (!Number.isFinite(row.reservedAt) || row.reservedAt > now + 2000 || !row.engineId || !row.clientOrderId
      || row.acknowledgedAt != null && (!Number.isFinite(row.acknowledgedAt) || row.acknowledgedAt < row.reservedAt))
      return unknown("reservation ownership invalid");
    if (!Number.isSafeInteger(row.protectionOrders ?? 0) || (row.protectionOrders ?? 0) < 0)
      return unknown("protective order reserve invalid");
    const previous = own.get(row.clientOrderId);
    if (previous && (previous.engineId !== row.engineId || previous.reservedAt !== row.reservedAt
      || previous.acknowledgedAt !== row.acknowledgedAt
      || (previous.protectionOrders ?? 0) !== (row.protectionOrders ?? 0))) return unknown("reservation identity collision");
    own.set(row.clientOrderId, row);
  }
  const projected = sample.intervals.map((interval) => {
    const sampledWindow = Math.floor(sample.serverTime / interval.intervalMs);
    const offset = sample.serverTime - sample.observedAt;
    const currentWindow = Math.floor((now + offset) / interval.intervalMs);
    // At a window boundary, fresh counters must be observed again. Neither a
    // reload nor a local clock is evidence that Binance has reset the counter.
    if (sampledWindow !== currentWindow) return null;
    // A sample can race a reserved-but-not-dispatched POST. Such reservations
    // never disappear just because the sample was taken after reservation.
    const outstanding = [...own.values()].reduce((count, row) => count + (row.protectionOrders ?? 0)
      + Number(row.acknowledgedAt == null || row.acknowledgedAt >= sample.observedAt
        && Math.floor((row.acknowledgedAt + offset) / interval.intervalMs) === currentWindow), 0);
    return { intervalMs: interval.intervalMs, projected: interval.count + outstanding + input.newOrders, limit: interval.limit };
  });
  if (projected.some((row) => row === null)) return unknown("account ORDERS interval rolled over; refresh required");
  const intervals = projected as NonNullable<typeof projected[number]>[];
  const unobserved = [...own.values()].reduce((count, row) => count + (row.protectionOrders ?? 0)
    + Number(row.acknowledgedAt == null || row.acknowledgedAt >= sample.observedAt), 0);
  if (sample.exchangeOrders) {
    const exchange = sample.exchangeOrders;
    if (![exchange.limit, exchange.openOrders, exchange.externalOrders].every((value) => Number.isSafeInteger(value) && value >= 0)
      || exchange.limit <= 0 || exchange.externalOrders > exchange.openOrders)
      return unknown("exchange MAX_NUM_ORDERS observation invalid");
    if (input.newEngineSymbol && (!Number.isSafeInteger(input.existingEnginesForAccount)
      || input.existingEnginesForAccount! < 0 || !Number.isSafeInteger(input.newEngines) || input.newEngines! < 1))
      return unknown("complete account-wide engine inventory required for global resident-order projection");
    const residentProjection = Math.max(exchange.openOrders + unobserved + input.newOrders,
      input.newEngineSymbol ? exchange.externalOrders + 26 * (input.existingEnginesForAccount! + input.newEngines!) : 0);
    if (residentProjection > exchange.limit)
      return { code: "ACCOUNT_ORDER_CAPACITY_REQUIRED", reason: "exchange resident-order filter exhausted", intervals };
  }
  if (input.newEngineSymbol) {
    const symbol = sample.symbols[input.newEngineSymbol];
    if (!symbol || ![symbol.maxOrders, symbol.openOrders, symbol.externalOrders,
      input.existingEnginesForSymbol, input.newEngines].every((value) => Number.isSafeInteger(value) && Number(value) >= 0)
      || symbol.maxOrders <= 0 || symbol.externalOrders > symbol.openOrders)
      return unknown("fresh symbol MAX_NUM_ORDERS and external order observation required");
    if (symbol.selfTradePrevention !== "EXPIRE_TAKER")
      return unknown("maker-preserving self-trade prevention must be supported and enforced before admission");
    // One TP per physical slot and one NEXT BUY per independent engine. This
    // is a Binance filter projection, never a quota on engines/accounts.
    if (Math.max(symbol.openOrders + unobserved + input.newOrders,
      symbol.externalOrders + 26 * (input.existingEnginesForSymbol! + input.newEngines!)) > symbol.maxOrders)
      return { code: "ACCOUNT_ORDER_CAPACITY_REQUIRED", reason: "projected resident orders exceed symbol MAX_NUM_ORDERS", intervals };
  }
  return { code: intervals.some((row) => row.projected > row.limit) ? "ACCOUNT_ORDER_CAPACITY_REQUIRED" : "PASS",
    reason: intervals.some((row) => row.projected > row.limit) ? "shared account ORDERS budget exhausted" : "shared account ORDERS and resident-order budgets preserved", intervals };
}
