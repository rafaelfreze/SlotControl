import "server-only";

import { readLiveExecutorState } from "./live-executor-transport";
import { parseLiveRules, type RawLiveSymbol } from "./live-preparation";

const PUBLIC_SPOT = "https://data-api.binance.vision";
const SYMBOLS = ["BTCBRL", "SOLBRL"] as const;
type PriceRow = { symbol?: string; price?: string };

/** Market data is public; signed Production reads stay on the fixed-IP executor. */
export async function loadLiveProductionSnapshot() {
  const [infoResponse, priceResponse, btc, sol] = await Promise.all([
    fetch(`${PUBLIC_SPOT}/api/v3/exchangeInfo?symbols=${encodeURIComponent(JSON.stringify(SYMBOLS))}`,
      { method: "GET", cache: "no-store", signal: AbortSignal.timeout(8_000) }),
    fetch(`${PUBLIC_SPOT}/api/v3/ticker/price?symbols=${encodeURIComponent(JSON.stringify(SYMBOLS))}`,
      { method: "GET", cache: "no-store", signal: AbortSignal.timeout(8_000) }),
    readLiveExecutorState("BTCBRL").catch(() => null),
    readLiveExecutorState("SOLBRL").catch(() => null),
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
  const account = btc && sol && btc.balances.find((row) => row.asset === "BRL")?.total
    === sol.balances.find((row) => row.asset === "BRL")?.total ? btc : null;
  const balance = account?.balances.find((row) => row.asset === "BRL");
  return { source: "Binance public market GET + signed Production GET via fixed-IP CoinOps executor",
    observedAt, markets, brlFree: account ? balance?.free ?? 0 : null,
    brlLocked: account ? balance?.locked ?? 0 : null,
    // Binance updateTime is the last account mutation, not the time of this GET.
    balanceObservedAt: account ? observedAt : null,
    permissions: account ? "SPOT_RESTRICTED" as const : "UNVERIFIED" as const,
    ipRestricted: account ? true : null };
}
