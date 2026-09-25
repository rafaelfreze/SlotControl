import { createHash, createHmac } from "node:crypto";
import { ExecutorRejection } from "./security.mjs";

const HOST = "https://testnet.binance.vision";
const SYMBOL = /^(BTC|SOL)(USDC|USDT)$/;
const CLIENT = /^COV1-(BTC|SOL)-(\d+)-(\d+)-(BUY|SELL)-[a-f0-9]{18}$/;
const ALLOWED = new Set([
  "GET:/api/v3/account", "GET:/api/v3/openOrders", "GET:/api/v3/order",
  "GET:/api/v3/myTrades", "POST:/api/v3/order/test",
  "POST:/api/v3/order", "DELETE:/api/v3/order",
]);
const allowedParams = new Set(["symbol", "orderId", "origClientOrderId", "fromId", "limit",
  "side", "type", "quoteOrderQty", "newClientOrderId", "newOrderRespType",
  "timeInForce", "quantity", "price", "cancelRestrictions"]);

function expectedClient(runId, match) {
  const [, asset, slot, revision, side] = match;
  const source = asset === "SOL"
    ? `coinops-testnet|${runId}|${Number(slot)}|${side}|${Number(revision)}`
    : `coinops-testnet|${runId}|BTC|${Number(slot)}|${side}|${Number(revision)}`;
  return `COV1-${asset}-${slot}-${revision}-${side}-${createHash("sha256").update(source).digest("hex").slice(0, 18)}`;
}

export function validateTestnetTransport(input) {
  const method = input.method, path = input.path, params = input.params;
  if (input.environment !== "TESTNET" || !ALLOWED.has(`${method}:${path}`)
    || !params || typeof params !== "object" || Array.isArray(params)
    || Object.entries(params).some(([key, value]) => !allowedParams.has(key)
      || typeof value !== "string" || value.length > 100)
    || (path !== "/api/v3/account" && !SYMBOL.test(params.symbol ?? ""))
    || (params.symbol && params.symbol !== input.symbol)
    || !SYMBOL.test(input.symbol ?? ""))
    throw new ExecutorRejection("EXECUTOR_TESTNET_SCOPE_DENIED", 403);
  if (method === "POST" && path === "/api/v3/order") {
    const match = CLIENT.exec(params.newClientOrderId ?? "");
    if (!match || match[1] !== input.symbol.slice(0, 3)
      || (params.side === "BUY") !== (match[4] === "BUY")
      || Number(match[2]) < 1 || Number(match[2]) > 25 || Number(match[3]) < 1
      || !["MARKET", "LIMIT"].includes(params.type)
      || params.type === "MARKET" && (params.side !== "BUY" || !positive(params.quoteOrderQty))
      || params.type === "LIMIT" && (!positive(params.price) || !positive(params.quantity))
      || !/^[0-9a-f-]{36}$/i.test(input.run_id ?? "")
      || expectedClient(input.run_id, match) !== params.newClientOrderId)
      throw new ExecutorRejection("EXECUTOR_TESTNET_ORDER_DENIED", 403);
  }
  if (method === "DELETE") {
    const match = CLIENT.exec(params.origClientOrderId ?? "");
    if (!match || match[1] !== input.symbol.slice(0, 3) || !/^\d+$/.test(params.orderId ?? "")
      || !/^COV1-C-[a-f0-9]{18}$/.test(params.newClientOrderId ?? "")
      || !/^[0-9a-f-]{36}$/i.test(input.run_id ?? "")
      || expectedClient(input.run_id, match) !== params.origClientOrderId
      || params.newClientOrderId !== `COV1-C-${createHmac("sha256", "coinops-testnet-cancel-id").update(params.origClientOrderId).digest("hex").slice(0, 18)}`
      || params.cancelRestrictions !== "ONLY_NEW")
      throw new ExecutorRejection("EXECUTOR_TESTNET_CANCEL_DENIED", 403);
  }
  if (method === "POST" && path === "/api/v3/order/test" &&
    (params.type !== "MARKET" || params.side !== "BUY" || !positive(params.quoteOrderQty)))
    throw new ExecutorRejection("EXECUTOR_TESTNET_PROBE_DENIED", 403);
  return { method, path, params };
}

function positive(value) { return typeof value === "string" && /^\d+(?:\.\d{1,12})?$/.test(value) && Number(value) > 0; }

/** The credential never crosses back to Vercel. Transport is Testnet-only and
 * accepts no arbitrary host, path or parameter. Binance errors are returned
 * as data so the existing recovery/idempotency code can inspect them. */
export async function forwardTestnetRequest(input, credential, fetcher = fetch) {
  const { method, path, params } = validateTestnetTransport(input);
  const timeResponse = await fetcher(`${HOST}/api/v3/time`, { method: "GET", cache: "no-store",
    signal: AbortSignal.timeout(8000) });
  const serverTime = Number((await timeResponse.json()).serverTime);
  if (!timeResponse.ok || !Number.isSafeInteger(serverTime))
    throw new ExecutorRejection("EXECUTOR_TESTNET_CLOCK_UNAVAILABLE", 503);
  const query = new URLSearchParams({ ...params, recvWindow: "5000", timestamp: String(serverTime) });
  query.set("signature", createHmac("sha256", credential.apiSecret).update(query.toString()).digest("hex"));
  const response = await fetcher(`${HOST}${path}${method === "GET" ? `?${query}` : ""}`, {
    method, cache: "no-store", signal: AbortSignal.timeout(8000),
    headers: { "X-MBX-APIKEY": credential.apiKey,
      ...(method === "GET" ? {} : { "content-type": "application/x-www-form-urlencoded" }) },
    ...(method === "GET" ? {} : { body: query.toString() }),
  });
  return { binance_status: response.status, payload: await response.json().catch(() => ({})) };
}
