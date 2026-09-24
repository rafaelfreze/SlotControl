import type { V1Asset } from "./robot-v1.ts";

export type HistoricalAth = {
  asset: V1Asset;
  symbol: string;
  price: number;
  observedAt: string;
  source: string;
  verifiedAt: string;
  fresh: boolean;
  candleCount: number;
};

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
const DAY_MS = 86_400_000;
const MAX_PAGES = 10;

/** Reads the complete confirmed Binance Spot USDC-pair daily history, not a
 * rolling 24h ticker. The current (unclosed) daily candle is excluded. */
export async function readBinanceHistoricalAth(asset: V1Asset, fetcher: Fetcher = fetch,
  now = Date.now(), marketSymbol = `${asset}USDC`): Promise<HistoricalAth> {
  if (asset !== "BTC" && asset !== "SOL" || !Number.isFinite(now) || now <= 0)
    throw new Error("COINOPS_ATH_MARKET_INPUT_INVALID");
  if (!new RegExp(`^${asset}[A-Z0-9]{2,20}$`).test(marketSymbol)) throw new Error("COINOPS_ATH_MARKET_INPUT_INVALID");
  const symbol = marketSymbol;
  let cursor = 0, lastOpen = -1, lastClose = -1, high = -Infinity, highAt = "", count = 0;
  let completed = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL("https://data-api.binance.vision/api/v3/klines");
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("interval", "1d");
    url.searchParams.set("limit", "1000");
    url.searchParams.set("startTime", String(cursor));
    const response = await fetcher(url.toString(), { cache: "no-store", signal: AbortSignal.timeout(12_000) });
    if (!response.ok) throw new Error("COINOPS_ATH_MARKET_HTTP_FAILED");
    const rows: unknown = await response.json();
    if (!Array.isArray(rows) || rows.length > 1000) throw new Error("COINOPS_ATH_MARKET_RESPONSE_INVALID");
    for (const row of rows) {
      if (!Array.isArray(row) || row.length < 7) throw new Error("COINOPS_ATH_MARKET_RESPONSE_INVALID");
      const openTime = Number(row[0]), candleHigh = Number(row[2]), closeTime = Number(row[6]);
      if (!Number.isInteger(openTime) || !Number.isInteger(closeTime) || !Number.isFinite(candleHigh)
        || candleHigh <= 0 || openTime <= lastOpen || closeTime <= openTime || openTime < cursor
        || closeTime > now + DAY_MS) throw new Error("COINOPS_ATH_MARKET_RESPONSE_INVALID");
      lastOpen = openTime;
      if (closeTime >= now) continue;
      count++; lastClose = closeTime;
      if (candleHigh > high) { high = candleHigh; highAt = new Date(closeTime).toISOString(); }
    }
    if (rows.length < 1000) { completed = true; break; }
    cursor = lastOpen + 1;
  }
  if (!completed || !count || !Number.isFinite(high)) throw new Error("COINOPS_ATH_HISTORY_INCOMPLETE");
  const fresh = lastClose > 0 && now - lastClose <= 2 * DAY_MS;
  return { asset, symbol, price: high, observedAt: highAt,
    source: `BINANCE_SPOT_${symbol}_CONFIRMED_1D_FULL_HISTORY`,
    verifiedAt: new Date(now).toISOString(), fresh, candleCount: count };
}
