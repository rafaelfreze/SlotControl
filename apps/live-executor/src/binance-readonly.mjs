import { BinanceSpotAdapter } from "../../web/lib/execution/binance-spot-adapter.ts";

const BINANCE_PUBLIC = "https://data-api.binance.vision";
const BINANCE_SPOT = "https://api.binance.com";
const SYMBOLS = ["BTCBRL", "SOLBRL"];

async function getJson(fetcher, url) {
  const response = await fetcher(url, { method: "GET", cache: "no-store", signal: AbortSignal.timeout(6_000),
    headers: { accept: "application/json" } });
  if (!response.ok) throw new Error("EXECUTOR_BINANCE_GET_FAILED");
  return response.json();
}

export async function getPublicMarket(fetcher = fetch, now = Date.now) {
  const [info, prices, clock] = await Promise.all([
    getJson(fetcher, `${BINANCE_PUBLIC}/api/v3/exchangeInfo?symbols=${encodeURIComponent(JSON.stringify(SYMBOLS))}`),
    getJson(fetcher, `${BINANCE_PUBLIC}/api/v3/ticker/price?symbols=${encodeURIComponent(JSON.stringify(SYMBOLS))}`),
    getJson(fetcher, `${BINANCE_SPOT}/api/v3/time`),
  ]);
  const observedAt = new Date(now()).toISOString();
  const driftMs = Number(clock.serverTime) - now();
  if (!Number.isFinite(driftMs) || Math.abs(driftMs) > 2_000)
    throw new Error("EXECUTOR_CLOCK_DRIFT");
  const markets = SYMBOLS.map((symbol) => {
    const raw = info.symbols?.find((row) => row.symbol === symbol);
    const priceBrl = Number(prices.find((row) => row.symbol === symbol)?.price);
    if (!raw || raw.status !== "TRADING" || !Number.isFinite(priceBrl) || priceBrl <= 0)
      throw new Error("EXECUTOR_MARKET_UNAVAILABLE");
    return { raw, priceBrl, observedAt };
  });
  return { markets, observedAt, driftMs };
}

export async function getProductionReadOnlyStatus({ apiKey, apiSecret, fetcher = fetch }) {
  if (!apiKey || !apiSecret) return "UNVERIFIED";
  try {
    const adapter = new BinanceSpotAdapter({ apiKey, apiSecret }, { fetcher, maxReadRetries: 0 });
    const [account, capabilities] = await Promise.all([adapter.getAccount(), adapter.getCapabilities()]);
    return account && capabilities.readEnabled && !capabilities.tradingEnabled
      && !capabilities.withdrawalsEnabled ? "READ_ONLY" : "UNSAFE";
  } catch { return "UNVERIFIED"; }
}

export async function observeEgressIp(fetcher = fetch) {
  try {
    const result = await getJson(fetcher, "https://api.ipify.org?format=json");
    return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(result.ip ?? "") ? result.ip : null;
  } catch { return null; }
}
