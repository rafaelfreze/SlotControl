import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { forwardTestnetRequest, validateTestnetTransport } from "../src/testnet-transport.mjs";

const run_id = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const base = { environment: "TESTNET", symbol: "BTCUSDT", run_id };
const clientId = (slot, revision, side) => {
  const source = `coinops-testnet|${run_id}|BTC|${slot}|${side}|${revision}`;
  return `COV1-BTC-${slot}-${revision}-${side}-${createHash("sha256").update(source).digest("hex").slice(0, 18)}`;
};

test("Testnet transport accepts only exact owned Spot orders on its symbol", () => {
  const order = { ...base, method: "POST", path: "/api/v3/order", params: {
    symbol: "BTCUSDT", side: "BUY", type: "MARKET", quoteOrderQty: "16.76",
    newClientOrderId: clientId(1, 1, "BUY"), newOrderRespType: "FULL" } };
  assert.equal(validateTestnetTransport(order).method, "POST");
  for (const changed of [
    { environment: "REAL" }, { symbol: "SOLUSDT" }, { path: "/api/v3/allOrders" },
    { params: { ...order.params, symbol: "BTCBRL" } },
    { params: { ...order.params, newClientOrderId: clientId(2, 1, "BUY") + "x" } },
    { params: { ...order.params, newClientOrderId: "MANUAL" } },
    { params: { ...order.params, quoteOrderQty: "-1" } },
    { params: { ...order.params, side: "SELL" } },
  ]) assert.throws(() => validateTestnetTransport({ ...order, ...changed }), /EXECUTOR_TESTNET_/);
});

test("Testnet transport signs only the fixed Testnet host and does not return credentials", async () => {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url: String(url), method: options.method, body: options.body });
    return { ok: true, status: 200, json: async () => calls.length === 1
      ? { serverTime: 1_790_000_000_000 } : { canTrade: true } };
  };
  const result = await forwardTestnetRequest({ ...base, method: "GET", path: "/api/v3/account", params: {} },
    { apiKey: "F".repeat(64), apiSecret: "G".repeat(64) }, fetcher);
  assert.equal(result.binance_status, 200);
  assert.equal(result.payload.canTrade, true);
  assert.ok(calls.every((call) => call.url.startsWith("https://testnet.binance.vision/api/v3/")));
  assert.ok(!JSON.stringify(result).includes("G".repeat(64)));
});
