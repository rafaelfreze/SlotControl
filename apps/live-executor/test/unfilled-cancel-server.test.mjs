import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createExecutorHandler } from "../src/server.mjs";
import { requestSignature, sha256 } from "../src/security.mjs";
import { validateExecutorRegistry } from "../src/account-registry.mjs";
import { registryFixture, credentialEnvironment, intentContext } from "./registry-fixture.mjs";

const NOW = Date.parse("2026-09-28T02:00:00.000Z");
const SECRET = "test-only-cancel-secret-with-sufficient-entropy";
const CLIENT = "COR1-BTC-2-1-BUY-0123456789abcd";
const ORDER = { symbol: "BTCBRL", clientOrderId: CLIENT, orderId: 123, side: "BUY",
  status: "NEW", executedQty: "0", cummulativeQuoteQty: "0", price: "437000" };

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "coinops-unfilled-cancel-"));
  const rawRegistry = registryFixture();
  const registry = validateExecutorRegistry({ ...rawRegistry,
    legacy_account_id: rawRegistry.engines[0].exchange_account_id });
  for (const engine of registry.engines) engine.execution_allowed = true;
  const engine = registry.engines[0];
  const calls = [];
  let order = { ...ORDER }, uncertain = false;
  const fetcher = async (url, init = {}) => {
    const parsed = new URL(url), method = init.method ?? "GET";
    calls.push({ path: parsed.pathname, method,
      params: init.body ? new URLSearchParams(init.body) : parsed.searchParams });
    if (parsed.hostname.includes("ipify")) return Response.json({ ip: "203.0.113.10" });
    if (parsed.pathname === "/api/v3/time") return Response.json({ serverTime: NOW });
    if (parsed.pathname === "/api/v3/account") return Response.json({ canTrade: true, balances: [
      { asset: "BRL", free: "730", locked: "0" }, { asset: "BTC", free: "0", locked: "0" },
      { asset: "BNB", free: "0.005", locked: "0" }] });
    if (parsed.pathname === "/sapi/v1/account/apiRestrictions") return Response.json({
      ipRestrict: true, enableReading: true, enableSpotAndMarginTrading: true,
      enableWithdrawals: false, enableInternalTransfer: false, permitsUniversalTransfer: false,
      enableMargin: false, enableFutures: false, enableVanillaOptions: false,
      enablePortfolioMarginTrading: false, enableFixApiTrade: false });
    if (parsed.pathname === "/api/v3/exchangeInfo") return Response.json({ symbols: [{
      symbol: "BTCBRL", status: "TRADING", baseAsset: "BTC", quoteAsset: "BRL", filters: [
        { filterType: "LOT_SIZE", minQty: "0.00001", maxQty: "100", stepSize: "0.00001" },
        { filterType: "PRICE_FILTER", minPrice: "1", maxPrice: "10000000", tickSize: "1" },
        { filterType: "NOTIONAL", minNotional: "10" }] }] });
    if (parsed.pathname === "/api/v3/ticker/price") return Response.json({
      symbol: parsed.searchParams.get("symbol"), price: "437000" });
    if (parsed.pathname === "/api/v3/openOrders") return Response.json([]);
    if (parsed.pathname === "/api/v3/order" && method === "GET") return Response.json(order);
    if (parsed.pathname === "/api/v3/order" && method === "DELETE") {
      if (uncertain) throw new Error("LOST_DELETE_ACK");
      order = { ...order, status: "CANCELED" };
      return Response.json({ ...order, origClientOrderId: CLIENT });
    }
    throw new Error(`Unexpected ${method} ${parsed.pathname}`);
  };
  const server = createServer(createExecutorHandler({ secret: SECRET, stateDirectory: directory,
    expectedEgressIp: "203.0.113.10", registry, credentialEnvironment, fetcher,
    now: () => NOW, tradingEnabled: true, killSwitch: false, logger: () => {} }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const send = async (path = "/v1/cancel-order", patch = {}, keyOverride = null) => {
    const key = keyOverride ?? (path === "/v1/cancel-order"
      ? `${patch.onlyUnfilled === false ? "CANCEL" : "CANCEL_UNFILLED"}:${CLIENT}` : `STATE:${randomUUID()}`);
    const body = JSON.stringify({ ...intentContext(engine, key), ...(path === "/v1/cancel-order"
      ? { clientOrderId: CLIENT, orderId: "123", onlyUnfilled: true } : {}), ...patch });
    const nonce = randomUUID().replaceAll("-", "");
    const headers = { "content-type": "application/json", "x-coinops-timestamp": String(NOW),
      "x-coinops-nonce": nonce, "x-coinops-body-sha256": sha256(body),
      "x-coinops-signature": requestSignature(SECRET, "POST", path, NOW, nonce, body),
      "x-coinops-idempotency-key": key };
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`,
      { method: "POST", headers, body });
    return { status: response.status, body: await response.json() };
  };
  return { directory, registry, engine, calls, send,
    setOrder: (patch) => { order = { ...order, ...patch }; },
    loseAck: () => { uncertain = true; },
    close: () => new Promise((resolve) => server.close(resolve)) };
}

test("signed ONLY_NEW cancellation preserves request identity, replays and rejects a changed mode", async () => {
  const scenario = await fixture();
  try {
    const first = await scenario.send();
    assert.equal(first.status, 200);
    assert.equal(first.body.order.status, "CANCELED");
    assert.equal(first.body.order.executedQuantity, 0);
    assert.equal(first.body.replayed, false);
    assert.equal((await scenario.send()).body.replayed, true);
    const changed = await scenario.send("/v1/cancel-order", { onlyUnfilled: false }, `CANCEL_UNFILLED:${CLIENT}`);
    assert.equal(changed.status, 400);
    assert.equal(changed.body.error, "EXECUTOR_IDEMPOTENCY_KEY_INVALID");
    const identityChanged = await scenario.send("/v1/cancel-order", { orderId: "456" });
    assert.equal(identityChanged.status, 409);
    assert.equal(identityChanged.body.error, "EXECUTOR_IDEMPOTENCY_CONFLICT");
    assert.equal(scenario.calls.filter((call) => call.method === "DELETE").length, 1);
  } finally { await scenario.close(); }
});

test("preserved partial observation does not occupy the existing protective cancellation key", async () => {
  const scenario = await fixture();
  try {
    scenario.setOrder({ status: "PARTIALLY_FILLED", executedQty: "0.00001", cummulativeQuoteQty: "4.37" });
    const resize = await scenario.send();
    assert.equal(resize.status, 200);
    assert.equal(resize.body.order.status, "PARTIALLY_FILLED");
    assert.equal(scenario.calls.filter((call) => call.method === "DELETE").length, 0);
    const protective = await scenario.send("/v1/cancel-order", { onlyUnfilled: false });
    assert.equal(protective.status, 200);
    assert.equal(protective.body.order.status, "CANCELED");
    assert.equal(protective.body.order.executedQuantity, 0.00001);
    assert.equal(scenario.calls.filter((call) => call.method === "DELETE").length, 1);
  } finally { await scenario.close(); }
});

for (const recoveredStatus of ["CANCELED", "PARTIALLY_FILLED", "FILLED"]) {
  test(`uncertain ONLY_NEW claim resolves ${recoveredStatus} by GET without repeating DELETE`, async () => {
    const scenario = await fixture();
    try {
      scenario.loseAck();
      const failed = await scenario.send();
      assert.equal(failed.status, 503);
      assert.equal(failed.body.error, "EXECUTOR_CANCEL_OUTCOME_UNKNOWN");
      const stillUnknown = await scenario.send();
      assert.equal(stillUnknown.status, 503);
      assert.equal(stillUnknown.body.error, "EXECUTOR_WRITE_OUTCOME_UNKNOWN");
      scenario.setOrder({ status: recoveredStatus,
        executedQty: recoveredStatus === "CANCELED" ? "0" : "0.00001",
        cummulativeQuoteQty: recoveredStatus === "CANCELED" ? "0" : "4.37" });
      const recovered = await scenario.send();
      assert.equal(recovered.status, 200);
      assert.equal(recovered.body.order.status, recoveredStatus);
      assert.equal(recovered.body.replayed, true);
      assert.equal(scenario.calls.filter((call) => call.method === "DELETE").length, 1);
    } finally { await scenario.close(); }
  });
}

test("state advertises safe cancel support and exact effective legacy caps without cache", async () => {
  const scenario = await fixture();
  try {
    const first = await scenario.send("/v1/state");
    assert.equal(first.status, 200);
    assert.equal(first.body.supports_unfilled_buy_cancel, true);
    assert.deepEqual(first.body.execution_caps, { engine: 450, account: 725, max_order: 18 });
    await writeFile(join(scenario.directory, "dynamic-registry.json"), JSON.stringify({
      version: 1, engines: [], credentials: {}, capital_overrides: [{
        operator_id: scenario.engine.operator_id, exchange_account_id: scenario.engine.exchange_account_id,
        quote_asset: "BRL", account_cap_quote: 775, engines: scenario.registry.engines.map((engine) => ({
          trading_engine_id: engine.trading_engine_id, symbol: engine.symbol,
          hard_cap_quote: engine.hard_cap_quote + (engine.symbol === "BTCBRL" ? 50 : 0),
          max_order_quote: engine.max_order_quote + (engine.symbol === "BTCBRL" ? 50 : 0) })) }] }),
    { mode: 0o600 });
    const updated = await scenario.send("/v1/state");
    assert.equal(updated.status, 200);
    assert.deepEqual(updated.body.execution_caps, { engine: 500, account: 775, max_order: 68 });
    assert.ok(scenario.calls.every((call) => call.method === "GET"));
    assert.equal(JSON.stringify(updated.body).includes("fictional"), false);
  } finally { await scenario.close(); }
});
