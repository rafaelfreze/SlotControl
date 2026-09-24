import "server-only";

import { readLiveExecutorState } from "./live-executor-transport";
import { parseLiveRules, type RawLiveSymbol } from "./live-preparation";
import type { EngineContext } from "./operator-context";

const PUBLIC_SPOT = "https://data-api.binance.vision";
type PriceRow = { symbol?: string; price?: string };

/** Market data is public; signed Production reads stay on the fixed-IP executor. */
export async function loadLiveProductionSnapshot(selection: EngineContext | EngineContext[]) {
  const engines = Array.isArray(selection) ? selection : [selection];
  const first = engines[0];
  if (!first || engines.some((engine) => engine.environment !== "REAL"
    || engine.exchange_account_id !== first.exchange_account_id || engine.quote_asset !== first.quote_asset))
    throw new Error("COINOPS_LIVE_SNAPSHOT_SCOPE_MIXED");
  const symbols = engines.map((engine) => engine.symbol);
  if (new Set(symbols).size !== symbols.length) throw new Error("COINOPS_LIVE_SNAPSHOT_DUPLICATE_ENGINE");
  const [infoResponse, priceResponse, observations] = await Promise.all([
    fetch(`${PUBLIC_SPOT}/api/v3/exchangeInfo?symbols=${encodeURIComponent(JSON.stringify(symbols))}`,
      { method: "GET", cache: "no-store", signal: AbortSignal.timeout(8_000) }),
    fetch(`${PUBLIC_SPOT}/api/v3/ticker/price?symbols=${encodeURIComponent(JSON.stringify(symbols))}`,
      { method: "GET", cache: "no-store", signal: AbortSignal.timeout(8_000) }),
    Promise.all(engines.map((engine) => readLiveExecutorState(engine).catch(() => null))),
  ]);
  if (!infoResponse.ok || !priceResponse.ok) throw new Error("COINOPS_LIVE_PUBLIC_MARKET_UNAVAILABLE");
  const info = await infoResponse.json() as { symbols?: RawLiveSymbol[] };
  const prices = await priceResponse.json() as PriceRow[];
  const observedAt = new Date().toISOString();
  const markets = symbols.map((symbol) => {
    const raw = info.symbols?.find((item) => item.symbol === symbol);
    const ticker = prices.find((item) => item.symbol === symbol);
    if (!raw || !ticker || !Number.isFinite(Number(ticker.price)) || Number(ticker.price) <= 0)
      throw new Error(`COINOPS_LIVE_${symbol}_UNAVAILABLE`);
    return { rules: parseLiveRules(raw), priceBrl: Number(ticker.price), priceQuote: Number(ticker.price),
      trading_engine_id: engines.find((engine) => engine.symbol === symbol)!.trading_engine_id };
  });
  const candidate = observations[0];
  const account = candidate && observations.every((row) => row && row.exchange_account_id === first.exchange_account_id
    && row.balances.find((balance) => balance.asset === first.quote_asset)?.total
      === candidate.balances.find((balance) => balance.asset === first.quote_asset)?.total) ? candidate : null;
  const balance = account?.balances.find((row) => row.asset === first.quote_asset);
  return { source: "Binance public market GET + signed Production GET via fixed-IP CoinOps executor",
    observedAt, markets, exchange_account_id: first.exchange_account_id, quote_asset: first.quote_asset,
    operator_id: first.operator_id, engine_ids: engines.map((engine) => engine.trading_engine_id),
    quoteFree: account ? balance?.free ?? 0 : null, quoteLocked: account ? balance?.locked ?? 0 : null,
    brlFree: first.quote_asset === "BRL" && account ? balance?.free ?? 0 : null,
    brlLocked: first.quote_asset === "BRL" && account ? balance?.locked ?? 0 : null,
    // Binance updateTime is the last account mutation, not the time of this GET.
    balanceObservedAt: account ? observedAt : null,
    permissions: account ? "SPOT_RESTRICTED" as const : "UNVERIFIED" as const,
    ipRestricted: account ? true : null };
}
