const BINANCE_HOSTS = new Set(["api.binance.com", "data-api.binance.vision"]);
const MAX_READ_WEIGHT_PER_MINUTE = 4_800; // reserve at least 1,200 of the 6,000 IP weight for writes/recovery

function weight(path) {
  switch (path) {
    case "/api/v3/time": return 1;
    case "/api/v3/ticker/price": return 2;
    case "/api/v3/openOrders": return 6; // symbol is mandatory in CoinOps snapshots
    case "/api/v3/order": return 4;
    case "/api/v3/account":
    case "/api/v3/exchangeInfo":
    case "/api/v3/myTrades": return 20;
    case "/sapi/v1/account/apiRestrictions": return 1;
    default: return 20; // unknown reads consume a conservative budget
  }
}

/** One fixed-IP process budget. It never delays a signed request past recvWindow.
 * Writes are untouched; exhausted reads fail closed until the next window. */
export function createBinanceReadBudgetFetcher(fetcher, now = Date.now, random = Math.random) {
  let minute = -1, reserved = 0, observed = 0, inFlight = 0, cooldownUntil = 0;
  return async (url, init = {}) => {
    const parsed = new URL(url);
    if (init.method !== "GET" || !BINANCE_HOSTS.has(parsed.hostname)) return fetcher(url, init);
    const currentMinute = Math.floor(now() / 60_000);
    if (currentMinute !== minute) {
      minute = currentMinute;
      reserved = 0;
      observed = 0;
      inFlight = 0;
    }
    const cost = weight(parsed.pathname);
    // The header can include traffic from other processes on the same IP.
    // Add local requests without responses so they cannot be hidden by it.
    if (now() < cooldownUntil || Math.max(reserved, observed + inFlight) + cost > MAX_READ_WEIGHT_PER_MINUTE)
      return Response.json({ code: -1003, msg: "LOCAL_READ_BUDGET" },
        { status: 429, headers: { "retry-after": String(Math.ceil(
          Math.max(0, (cooldownUntil > now() ? cooldownUntil : (minute + 1) * 60_000) - now()) / 1000)) } });
    reserved += cost;
    inFlight += cost;
    try {
      const response = await fetcher(url, init);
      if (Math.floor(now() / 60_000) === currentMinute) {
        const reported = Number(response.headers?.get?.("x-mbx-used-weight-1m"));
        if (Number.isFinite(reported) && reported >= 0) observed = Math.max(observed, reported);
      }
      if (response.status === 429 || response.status === 418) {
        const retryAfter = Number(response.headers?.get?.("retry-after"));
        const fallback = response.status === 418 ? 120_000 : 60_000;
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, 3_600_000) : fallback;
        cooldownUntil = Math.max(cooldownUntil, now() + waitMs + Math.floor(random() * 250));
      }
      return response;
    } finally {
      if (minute === currentMinute) inFlight -= cost;
    }
  };
}
