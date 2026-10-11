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

const PERMISSION_READ_FLAGS = ["enableReading", "enableSpotAndMarginTrading", "ipRestrict"];
const PERMISSION_DISABLED_FLAGS = ["enableWithdrawals", "enableInternalTransfer", "permitsUniversalTransfer",
  "enableMargin", "enableFutures", "enableVanillaOptions", "enablePortfolioMarginTrading", "enableFixApiTrade"];
const safeProviderCode = (value) => Number.isSafeInteger(value) && Math.abs(value) <= 100_000 ? value : null;
const invalidProviderCode = (body) => body && typeof body === "object"
  && Object.hasOwn(body, "code") && safeProviderCode(body.code) === null;
const TRANSIENT_PERMISSION_PROVIDER_CODES = new Set([-1000, -1001, -1006, -1007, -1008]);
const permissionGatewayUnavailable = (httpStatus, providerCode) => [502, 503, 504].includes(httpStatus)
  && (providerCode === null || TRANSIENT_PERMISSION_PROVIDER_CODES.has(providerCode));
const unavailablePermissionRead = (path, httpStatus = null, providerCode = null) => ({
  status: "READ_UNAVAILABLE", readEvidence: { path, http_status: httpStatus, provider_code: safeProviderCode(providerCode) },
});

function permissionAdapterFailure(error, path, evidence) {
  if (error?.code === "BINANCE_RATE_LIMITED" || [-1003, -1015].includes(evidence?.provider_code))
    return { status: "RATE_LIMITED" };
  if (error?.code === "BINANCE_NETWORK_UNAVAILABLE") return unavailablePermissionRead(path);
  const gateway = /^BINANCE_HTTP_(502|503|504)$/.exec(error?.code ?? "");
  return gateway && evidence && !evidence.invalid_provider_code
    && permissionGatewayUnavailable(evidence.http_status, evidence.provider_code)
    ? unavailablePermissionRead(path, evidence.http_status, evidence.provider_code) : { status: "UNVERIFIED" };
}

/** Complete GET-only permission observation. Missing/unsafe grants and auth
 * denial are never treated as transient. Only transport/gateway failure has a
 * typed unavailable result; no response body, URL, key or message escapes. */
export async function observeProductionRestrictedSpotStatus({ apiKey, apiSecret, fetcher = fetch, account: observedAccount }) {
  if (!apiKey || !apiSecret) return { status: "UNVERIFIED" };
  const adapterFailures = new Map();
  const adapterFetcher = async (url, init) => {
    const response = await fetcher(url, init);
    if (!response.ok) {
      // The adapter intentionally normalizes many provider errors to HTTP. Keep
      // only the numeric code so a structural rejection cannot inherit retry.
      const body = await response.clone().json().catch(() => null);
      adapterFailures.set(new URL(url).pathname, { http_status: response.status, provider_code: safeProviderCode(body?.code),
        invalid_provider_code: Boolean(invalidProviderCode(body)) });
    }
    return response;
  };
  const adapter = new BinanceSpotAdapter({ apiKey, apiSecret }, { fetcher: adapterFetcher, maxReadRetries: 0 });
  let serverTime;
  try { serverTime = await adapter.getServerTime(); }
  catch (error) { return permissionAdapterFailure(error, "/api/v3/time", adapterFailures.get("/api/v3/time")); }
  const query = new URLSearchParams({ recvWindow: "5000", timestamp: String(serverTime) });
  query.set("signature", createHmac("sha256", apiSecret).update(query.toString()).digest("hex"));
  const [accountRead, restrictionRead] = await Promise.all([
    Promise.resolve(observedAccount ?? adapter.getAccount())
      .then((account) => ({ account }), (error) => ({ failure: permissionAdapterFailure(error, "/api/v3/account", adapterFailures.get("/api/v3/account")) })),
    // Any rejection inside this fetch boundary means this GET was not observed;
    // it is not evidence of disabled permissions or a trading write outcome.
    Promise.resolve().then(() => fetcher(`${BINANCE_SPOT}/sapi/v1/account/apiRestrictions?${query}`, {
      method: "GET", cache: "no-store", signal: AbortSignal.timeout(8000),
      headers: { accept: "application/json", "X-MBX-APIKEY": apiKey },
    })).then((response) => ({ response }), () => ({ failure: unavailablePermissionRead("/sapi/v1/account/apiRestrictions") })),
  ]);
  // A known inability to trade wins over a concurrent inconclusive observation.
  if (accountRead.account && accountRead.account.canTrade !== true) return { status: "UNSAFE" };
  const response = restrictionRead.response;
  if (!response) return accountRead.failure && accountRead.failure.status !== "READ_UNAVAILABLE"
    ? accountRead.failure : restrictionRead.failure;
  if (response.status === 429 || response.status === 418) return { status: "RATE_LIMITED" };
  let flags;
  try { flags = await response.json(); }
  catch (error) {
    if (![401, 403, 418, 429].includes(response.status)
      && (error instanceof TypeError || error instanceof DOMException && ["AbortError", "TimeoutError"].includes(error.name)))
      return accountRead.failure && accountRead.failure.status !== "READ_UNAVAILABLE" ? accountRead.failure
        : unavailablePermissionRead("/sapi/v1/account/apiRestrictions", response.status);
    // Invalid JSON/flags are not proof of an outage and remain fail-closed.
    flags = null;
  }
  const providerCode = safeProviderCode(flags?.code);
  if (providerCode === -1003 || providerCode === -1015) return { status: "RATE_LIMITED" };
  if (!response.ok) {
    // An authentication/signature rejection must not inherit gateway retry.
    if ([401, 403].includes(response.status) || [-2014, -2015, -1022].includes(providerCode))
      return { status: "UNVERIFIED" };
    if (invalidProviderCode(flags)) return { status: "UNVERIFIED" };
    if (permissionGatewayUnavailable(response.status, providerCode)) return accountRead.failure
      && accountRead.failure.status !== "READ_UNAVAILABLE" ? accountRead.failure
      : unavailablePermissionRead("/sapi/v1/account/apiRestrictions", response.status, providerCode);
    return { status: "UNVERIFIED" };
  }
  if (!flags || Array.isArray(flags) || typeof flags !== "object"
    || [...PERMISSION_READ_FLAGS, ...PERMISSION_DISABLED_FLAGS].some((name) => typeof flags[name] !== "boolean"))
    return { status: "UNVERIFIED" };
  if (!PERMISSION_READ_FLAGS.every((name) => flags[name] === true)
    || !PERMISSION_DISABLED_FLAGS.every((name) => flags[name] === false)) return { status: "UNSAFE" };
  if (accountRead.failure) return accountRead.failure;
  return { status: "SPOT_RESTRICTED" };
}

/** Preserve the public health contract. Unknown availability is never healthy. */
export async function getProductionRestrictedSpotStatus(input) {
  const observation = await observeProductionRestrictedSpotStatus(input);
  return observation.status === "READ_UNAVAILABLE" ? "UNVERIFIED" : observation.status;
}

export async function observeEgressIp(fetcher = fetch) {
  try {
    const result = await getJson(fetcher, "https://api.ipify.org?format=json");
    return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(result.ip ?? "") ? result.ip : null;
  } catch { return null; }
}
