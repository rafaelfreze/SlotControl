import { BinanceSpotAdapter } from "../../web/lib/execution/binance-spot-adapter.ts";
import { createHmac } from "node:crypto";

const BINANCE_PUBLIC = "https://data-api.binance.vision";
const BINANCE_SPOT = "https://api.binance.com";
const SYMBOLS = ["BTCBRL", "SOLBRL"];

async function getJson(fetcher, url) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetcher(url, { method: "GET", cache: "no-store",
        signal: AbortSignal.timeout(4_000), headers: { accept: "application/json" } });
      if (response.ok) return response.json();
      if (attempt === 0 && response.status >= 500) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        continue;
      }
      throw new Error("EXECUTOR_BINANCE_GET_FAILED");
    } catch (error) {
      if (attempt === 1 || error instanceof Error && error.message === "EXECUTOR_BINANCE_GET_FAILED")
        throw error;
    }
  }
  throw new Error("EXECUTOR_BINANCE_GET_FAILED");
}

export async function getPublicMarket(fetcher = fetch, now = Date.now, symbols = SYMBOLS,
  host = BINANCE_SPOT) {
  if (!Array.isArray(symbols) || !symbols.length || symbols.some((symbol) => !/^[A-Z0-9]{4,40}$/.test(symbol)))
    throw new Error("EXECUTOR_MARKET_SCOPE_INVALID");
  if (![BINANCE_SPOT, "https://testnet.binance.vision"].includes(host))
    throw new Error("EXECUTOR_MARKET_HOST_DENIED");
  const publicHost = host === BINANCE_SPOT ? BINANCE_PUBLIC : host;
  const clockRequest = async () => {
    const started = now();
    const value = await getJson(fetcher, `${host}/api/v3/time`);
    return { value, midpoint: (started + now()) / 2 };
  };
  const [info, prices, clock] = await Promise.all([
    getJson(fetcher, `${publicHost}/api/v3/exchangeInfo?symbols=${encodeURIComponent(JSON.stringify(symbols))}`),
    getJson(fetcher, `${publicHost}/api/v3/ticker/price?symbols=${encodeURIComponent(JSON.stringify(symbols))}`),
    clockRequest(),
  ]);
  const observedAt = new Date(now()).toISOString();
  const driftMs = Number(clock.value.serverTime) - clock.midpoint;
  if (!Number.isFinite(driftMs) || Math.abs(driftMs) > 2_000)
    throw new Error("EXECUTOR_CLOCK_DRIFT");
  const markets = symbols.map((symbol) => {
    const raw = info.symbols?.find((row) => row.symbol === symbol);
    const priceBrl = Number(prices.find((row) => row.symbol === symbol)?.price);
    if (!raw || raw.status !== "TRADING" || !Number.isFinite(priceBrl) || priceBrl <= 0)
      throw new Error("EXECUTOR_MARKET_UNAVAILABLE");
    return { raw, priceBrl, observedAt };
  });
  return { markets, observedAt, driftMs };
}

export async function getProductionRestrictedSpotStatus({ apiKey, apiSecret, fetcher = fetch,
  adapter = null, accountPromise = null }) {
  if (!apiKey || !apiSecret) return "UNVERIFIED";
  try {
    const reader = adapter ?? new BinanceSpotAdapter({ apiKey, apiSecret }, { fetcher, maxReadRetries: 0 });
    const query = new URLSearchParams({ recvWindow: "5000", timestamp: String(await reader.getServerTime()) });
    query.set("signature", createHmac("sha256", apiSecret).update(query.toString()).digest("hex"));
    const [account, response] = await Promise.all([
      accountPromise ?? reader.getAccount(),
      fetcher(`${BINANCE_SPOT}/sapi/v1/account/apiRestrictions?${query}`, {
        method: "GET", cache: "no-store", signal: AbortSignal.timeout(8000),
        headers: { accept: "application/json", "X-MBX-APIKEY": apiKey },
      }),
    ]);
    if (!response.ok) return "UNVERIFIED";
    const flags = await response.json();
    return account.canTrade && flags.enableReading === true
      && flags.enableSpotAndMarginTrading === true && flags.ipRestrict === true
      && flags.enableWithdrawals === false && flags.enableInternalTransfer === false
      && flags.permitsUniversalTransfer === false && flags.enableMargin === false
      && flags.enableFutures === false && flags.enableVanillaOptions === false
      && flags.enablePortfolioMarginTrading === false && flags.enableFixApiTrade === false
      ? "SPOT_RESTRICTED" : "UNSAFE";
  } catch { return "UNVERIFIED"; }
}

export async function observeEgressIp(fetcher = fetch) {
  try {
    const result = await getJson(fetcher, "https://api.ipify.org?format=json");
    return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(result.ip ?? "") ? result.ip : null;
  } catch { return null; }
}
