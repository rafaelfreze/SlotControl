type DailyCandle = { symbol: string; candle_open_at: string; open_price: number; high_price: number; low_price: number; close_price: number };

/** Public market data for the dashboard, cached for one hour. Never uses account credentials. */
export async function getDailyMarketCandles(symbol: "BTCUSDC" | "SOLUSDC"): Promise<DailyCandle[]> {
  const url = `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=1d&limit=30`;
  const response = await fetch(url, { next: { revalidate: 3600 } });
  if (!response.ok) throw new Error(`BINANCE_DAILY_CANDLES_HTTP_${response.status}`);
  const rows: unknown = await response.json();
  if (!Array.isArray(rows)) throw new Error("BINANCE_DAILY_CANDLES_INVALID");
  return rows.map((row): DailyCandle => {
    if (!Array.isArray(row) || row.length < 5) throw new Error("BINANCE_DAILY_CANDLES_INVALID");
    const [time, open, high, low, close] = row;
    const values = [open, high, low, close].map(Number);
    if (!Number.isFinite(Number(time)) || values.some((value) => !Number.isFinite(value) || value <= 0) || values[2] > values[1]) throw new Error("BINANCE_DAILY_CANDLES_INVALID");
    return { symbol, candle_open_at: new Date(Number(time)).toISOString(), open_price: values[0], high_price: values[1], low_price: values[2], close_price: values[3] };
  });
}
