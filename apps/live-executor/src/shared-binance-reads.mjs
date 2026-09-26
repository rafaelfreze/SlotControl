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

/** A read-only account balance may be reused for at most one second for the
 * same account and key. Write paths never use this map and always perform a
 * fresh safety snapshot before dispatch. Failures are never cached. */
export function sharedAccountRead(pending, accountId, apiKey, read, now = Date.now) {
  const key = `${accountId}|${createHash("sha256").update(apiKey).digest("hex")}`;
  const existing = pending.get(key);
  if (existing?.request) return existing.request;
  if (existing?.until > now()) return Promise.resolve(existing.value);
  if (existing) pending.delete(key);
  if (pending.size >= 256) pending.delete(pending.keys().next().value);
  const request = Promise.resolve().then(read);
  pending.set(key, { request });
  request.then((value) => {
    if (pending.get(key)?.request === request)
      pending.set(key, { value, until: now() + 1_000 });
  }, () => {
    if (pending.get(key)?.request === request) pending.delete(key);
  });
  return request;
}
