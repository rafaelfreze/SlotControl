import "server-only";
import { unstable_cache } from "next/cache";

/** Public display-only LOT_SIZE evidence; never used to authorize trading.
 * Cache key contains the symbol and stores the real collection time. */
export const readPublicSymbolRule = unstable_cache(async (symbol: string) => {
  if (!/^(BTC|SOL)(BRL|USDT|USDC)$/.test(symbol)) return null;
  try {
    const response = await fetch(`https://data-api.binance.vision/api/v3/exchangeInfo?symbol=${symbol}`, {
      cache: "no-store", signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return null;
    const body = await response.json() as { symbols?: Array<{ symbol: string; filters: Array<{ filterType: string; stepSize?: string }> }> };
    const row = body.symbols?.find((item) => item.symbol === symbol);
    const quantityStep = Number(row?.filters.find((item) => item.filterType === "LOT_SIZE")?.stepSize);
    return quantityStep > 0 && Number.isFinite(quantityStep) ? { symbol, quantityStep, observedAt: new Date().toISOString() } : null;
  } catch { return null; }
}, ["coinops-public-display-symbol-rule-v1"], { revalidate: 300 });
