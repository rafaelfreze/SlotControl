import "server-only";

import { BinanceSpotAdapter } from "./binance-spot-adapter";
import { parseLiveRules, type RawLiveSymbol } from "./live-preparation";

const PUBLIC_SPOT = "https://data-api.binance.vision";
const SYMBOLS = ["BTCBRL", "SOLBRL"] as const;
type PriceRow = { symbol?: string; price?: string };

/** All three requests are GET. No Production order/cancel/transfer transport is reachable here. */
export async function loadLiveProductionSnapshot() {
  let adapter: BinanceSpotAdapter | null = null;
  try { adapter = BinanceSpotAdapter.fromEnvironment(); } catch { /* Public market data still remains available. */ }
  const [infoResponse, priceResponse, account, capabilities] = await Promise.all([
    fetch(`${PUBLIC_SPOT}/api/v3/exchangeInfo?symbols=${encodeURIComponent(JSON.stringify(SYMBOLS))}`,
      { method: "GET", cache: "no-store", signal: AbortSignal.timeout(8_000) }),
    fetch(`${PUBLIC_SPOT}/api/v3/ticker/price?symbols=${encodeURIComponent(JSON.stringify(SYMBOLS))}`,
      { method: "GET", cache: "no-store", signal: AbortSignal.timeout(8_000) }),
    adapter?.getAccount().catch(() => null) ?? Promise.resolve(null),
    adapter?.getCapabilities().catch(() => null) ?? Promise.resolve(null),
  ]);
  if (!infoResponse.ok || !priceResponse.ok) throw new Error("COINOPS_LIVE_PUBLIC_MARKET_UNAVAILABLE");
  const info = await infoResponse.json() as { symbols?: RawLiveSymbol[] };
  const prices = await priceResponse.json() as PriceRow[];
  const observedAt = new Date().toISOString();
  const markets = SYMBOLS.map((symbol) => {
    const raw = info.symbols?.find((item) => item.symbol === symbol);
    const ticker = prices.find((item) => item.symbol === symbol);
    if (!raw || !ticker || !Number.isFinite(Number(ticker.price)) || Number(ticker.price) <= 0)
      throw new Error(`COINOPS_LIVE_${symbol}_UNAVAILABLE`);
    return { rules: parseLiveRules(raw), priceBrl: Number(ticker.price) };
  });
  const balance = account?.balances.find((row) => row.asset === "BRL");
  return { source: `${PUBLIC_SPOT}/api/v3/exchangeInfo + /api/v3/ticker/price; Binance signed GET /api/v3/account`,
    observedAt, markets, brlFree: account ? balance?.free ?? 0 : null,
    brlLocked: account ? balance?.locked ?? 0 : null,
    // Binance updateTime is the last account mutation, not the time of this GET.
    balanceObservedAt: account ? observedAt : null,
    permissions: capabilities === null ? "UNVERIFIED" as const
      : capabilities.tradingEnabled || capabilities.withdrawalsEnabled ? "UNSAFE" as const : "READ_ONLY" as const,
    ipRestricted: capabilities?.ipRestricted ?? null };
}
