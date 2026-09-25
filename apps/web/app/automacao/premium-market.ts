import type { Candle } from "./automation-mobile";

/** Presentation-only public GET. No credentials, order API or strategy dependency. */
export async function getPremiumMarketCandles(symbol: "BTCBRL" | "SOLBRL" | "BTCUSDT" | "SOLUSDT"): Promise<Candle[]> {
  try {
    const response = await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=1d&limit=30`, {
      next: { revalidate: 300 }, signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return [];
    const rows: unknown = await response.json();
    if (!Array.isArray(rows)) return [];
    return rows.flatMap((row): Candle[] => {
      if (!Array.isArray(row) || row.length < 5) return [];
      const [at, open, high, low, close] = row.map(Number);
      if (![at, open, high, low, close].every(Number.isFinite) || Math.min(open, high, low, close) <= 0 || low > high) return [];
      return [{ symbol, candle_open_at: new Date(at).toISOString(), open_price: open, high_price: high, low_price: low, close_price: close }];
    });
  } catch { return []; }
}
