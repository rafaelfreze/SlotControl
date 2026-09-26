import { createHash } from "node:crypto";

/** Coalesce public GETs. Exchange filters alone have a one-second cache;
 * prices and server time always require a fresh request after completion. */
export function createSharedPublicFetcher(fetcher, now = Date.now) {
  const pending = new Map();
  const filters = new Map();
  return async (url, init = {}) => {
    const parsed = new URL(url);
    const publicMarket = parsed.hostname === "data-api.binance.vision"
      && ["/api/v3/exchangeInfo", "/api/v3/ticker/price"].includes(parsed.pathname);
    const publicClock = parsed.hostname === "api.binance.com" && parsed.pathname === "/api/v3/time";
    if (init.method !== "GET" || new Headers(init.headers).has("x-mbx-apikey")
      || !publicMarket && !publicClock)
      return fetcher(url, init);
    const key = parsed.href;
    const filterRequest = parsed.hostname === "data-api.binance.vision"
      && parsed.pathname === "/api/v3/exchangeInfo";
    const cached = filterRequest ? filters.get(key) : null;
    if (cached && cached.until > now()) return cached.response.clone();
    if (cached) filters.delete(key);
    let request = pending.get(key);
    if (!request) {
      request = Promise.resolve().then(() => fetcher(url, init)).then((response) => {
        if (filterRequest && response.ok && typeof response.clone === "function") {
          if (filters.size >= 256) filters.delete(filters.keys().next().value);
          filters.set(key, { response: response.clone(), until: now() + 1_000 });
        }
        return response;
      });
      pending.set(key, request);
      request.then(() => pending.delete(key), () => pending.delete(key));
    }
    const response = await request;
    return typeof response.clone === "function" ? response.clone() : response;
  };
}

/** Account snapshots may be shared only across simultaneous read-only engine states
 * for the same CoinOps account and key. Write paths never use this map. */
export function sharedAccountRead(pending, accountId, apiKey, read) {
  const key = `${accountId}|${createHash("sha256").update(apiKey).digest("hex")}`;
  let request = pending.get(key);
  if (!request) {
    request = Promise.resolve().then(read);
    pending.set(key, request);
    request.then(() => pending.delete(key), () => pending.delete(key));
  }
  return request;
}
