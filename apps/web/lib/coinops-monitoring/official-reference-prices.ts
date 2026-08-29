export type OfficialReferencePrices = {
  BTC: number;
  SOL: number;
  source: "BINANCE" | "COINGECKO";
};

const BINANCE_BTC_URL = "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT";
const BINANCE_SOL_URL = "https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT";
const COINGECKO_BTC_URL = "https://api.coingecko.com/api/v3/coins/bitcoin?localization=false&tickers=false&community_data=false&developer_data=false&sparkline=false";
const COINGECKO_SOL_URL = "https://api.coingecko.com/api/v3/coins/solana?localization=false&tickers=false&community_data=false&developer_data=false&sparkline=false";
const PRICE_FEED_TIMEOUT_MS = 4_000;

const positivePrice = (value: unknown) => {
  const price = Number(value);
  if (!Number.isFinite(price) || price <= 0) throw new Error("COINOPS_BASELINE_PRICE_INVALID");
  return price;
};

async function fetchJson<T>(fetcher: typeof fetch, url: string) {
  const response = await fetcher(url, {
    cache: "no-store",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(PRICE_FEED_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`COINOPS_PRICE_PROVIDER_HTTP_${response.status}`);
  return response.json() as Promise<T>;
}

async function fetchBinancePrices(fetcher: typeof fetch): Promise<OfficialReferencePrices> {
  const [btc, sol] = await Promise.all([
    fetchJson<{ price?: string }>(fetcher, BINANCE_BTC_URL),
    fetchJson<{ price?: string }>(fetcher, BINANCE_SOL_URL)
  ]);
  return { BTC: positivePrice(btc.price), SOL: positivePrice(sol.price), source: "BINANCE" };
}

async function fetchCoinGeckoPrices(fetcher: typeof fetch): Promise<OfficialReferencePrices> {
  const [btc, sol] = await Promise.all([
    fetchJson<{ market_data?: { current_price?: { usd?: number } } }>(fetcher, COINGECKO_BTC_URL),
    fetchJson<{ market_data?: { current_price?: { usd?: number } } }>(fetcher, COINGECKO_SOL_URL)
  ]);
  return {
    BTC: positivePrice(btc.market_data?.current_price?.usd),
    SOL: positivePrice(sol.market_data?.current_price?.usd),
    source: "COINGECKO"
  };
}

export async function fetchOfficialReferencePrices(fetcher: typeof fetch = fetch) {
  try {
    return await fetchBinancePrices(fetcher);
  } catch (binanceError) {
    try {
      const fallback = await fetchCoinGeckoPrices(fetcher);
      console.warn("[coinops-monitoring] official_reference_prices_fallback", {
        primary: "BINANCE",
        fallback: fallback.source,
        reason: binanceError instanceof Error ? binanceError.message : "BINANCE_UNAVAILABLE"
      });
      return fallback;
    } catch {
      throw new Error("COINOPS_BASELINE_PRICE_FEED_UNAVAILABLE");
    }
  }
}
