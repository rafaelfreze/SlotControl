import { LiveMarketReadFailed, LiveReadUnavailable } from "./live-read-error.ts";

const ORIGIN = "https://data-api.binance.vision";
const TRANSIENT_PROVIDER_CODES = new Set([-1000, -1001, -1006, -1007]);
export const ATH_TICKER_TRANSIENT_ROOTS = ["COINOPS_LIVE_ATH_PRICE_TIMEOUT",
  "COINOPS_LIVE_ATH_PRICE_NETWORK", "COINOPS_LIVE_ATH_PRICE_UNAVAILABLE"] as const;
export const athTickerReadPath = (symbol: string) => `market/ath_ticker/${symbol}`;
export const validAthTickerSymbol = (symbol: string) => /^(BTC|SOL)[A-Z0-9]{2,20}$/.test(symbol);
export const transientAthTickerProvider = (code: unknown) => code === null || code === undefined
  || typeof code === "string" && TRANSIENT_PROVIDER_CODES.has(Number(code)) && /^-\d{4}$/.test(code);
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** Public GET only. Retry the observation, never refreshAthProfile, a transition,
 * financial RPC, cancellation or order. No cache or quote/symbol fallback. */
export async function readAthTickerPrice(symbol: string, fetcher: Fetcher = fetch) {
  if (!validAthTickerSymbol(symbol)) throw new Error("COINOPS_LIVE_ATH_REFERENCE_INVALID");
  const path = athTickerReadPath(symbol);
  for (let attempt = 1; ; attempt++) {
    const deadline = AbortSignal.timeout(4_000);
    try {
      let response: Response, body: unknown;
      try {
        response = await fetcher(`${ORIGIN}/api/v3/ticker/price?symbol=${symbol}`, {
          method: "GET", cache: "no-store", redirect: "error", signal: deadline });
      } catch (error) {
        if (error instanceof DOMException && ["TimeoutError", "AbortError"].includes(error.name) || deadline.aborted)
          throw new LiveReadUnavailable(ATH_TICKER_TRANSIENT_ROOTS[0], path, attempt);
        if (error instanceof TypeError) throw new LiveReadUnavailable(ATH_TICKER_TRANSIENT_ROOTS[1], path, attempt);
        throw new LiveMarketReadFailed(path, attempt, null, null);
      }
      try { body = await response.json(); }
      catch (error) {
        // A timed-out error body cannot erase a real HTTP denial.
        if (!response.ok) body = null;
        else if (error instanceof DOMException && ["TimeoutError", "AbortError"].includes(error.name) || deadline.aborted)
          throw new LiveReadUnavailable(ATH_TICKER_TRANSIENT_ROOTS[0], path, attempt, response.status);
        else if (error instanceof TypeError)
          throw new LiveReadUnavailable(ATH_TICKER_TRANSIENT_ROOTS[1], path, attempt, response.status);
        else throw new LiveMarketReadFailed(path, attempt, response.status, null);
      }
      let provider: string | null = null;
      if (body && typeof body === "object" && !Array.isArray(body) && "code" in body) {
        if (!Number.isInteger(body.code) || Math.abs(Number(body.code)) > 100_000)
          throw new LiveMarketReadFailed(path, attempt, response.status, null);
        provider = String(body.code);
      }
      if (!response.ok) {
        if ([502, 503, 504].includes(response.status) && transientAthTickerProvider(provider))
          throw new LiveReadUnavailable(ATH_TICKER_TRANSIENT_ROOTS[2], path, attempt, response.status, provider);
        throw new LiveMarketReadFailed(path, attempt, response.status, provider);
      }
      if (!body || typeof body !== "object" || Array.isArray(body) || !("symbol" in body)
        || body.symbol !== symbol || !("price" in body) || typeof body.price !== "string"
        || !/^\d+(?:\.\d+)?$/.test(body.price) || !(Number(body.price) > 0) || !Number.isFinite(Number(body.price)))
        throw new LiveMarketReadFailed(path, attempt, response.status, provider);
      return { symbol, price: Number(body.price), observedAt: new Date().toISOString() };
    } catch (error) {
      if (!(error instanceof LiveReadUnavailable) || attempt >= 2) throw error;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
}
