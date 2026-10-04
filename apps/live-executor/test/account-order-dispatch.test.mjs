import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExecutorHandler } from "../src/server.mjs";
import { enableAccountOrderPolicy } from "../src/account-order-policy.mjs";
import { requestSignature, sha256 } from "../src/security.mjs";
import { ACCOUNT_B, engineFixture, credentialEnvironment } from "./registry-fixture.mjs";
import { liveClientOrderId } from "../../web/lib/execution/robot-v1-live-cycle.ts";
import { accountBudgetPermitHeaders } from "../../web/lib/execution/account-order-budget-permit.ts";

test("installed account gate rejects missing/expired permit before POST, preserves idempotency and maker STP", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coinops-budget-dispatch-"));
  const secret = "fictional-dispatch-gate-HMAC-secret-123456789012345";
  const start = Date.parse("2026-10-04T15:00:01Z"); let clock = start, expireDuringReads = false;
  const engine = { ...engineFixture("BTCBRL", ACCOUNT_B, 103, false), execution_allowed: true,
    executor_shard_id: "executor-03" };
  const registry = { version: 1, executor_shard_id: "executor-03", engines: [engine],
    credentials: { [engine.credential_ref]: { api_key_env: "FIXTURE_B_KEY", api_secret_env: "FIXTURE_B_SECRET" } } };
  const clientOrderId = liveClientOrderId(engine.trading_engine_id, "BTC", 1, 1, "BUY", 1,
    { exchange_account_id: ACCOUNT_B, trading_engine_id: engine.trading_engine_id, base_asset: "BTC", legacy_compatible: false });
  const body = JSON.stringify({ operator_id: engine.operator_id, exchange_account_id: ACCOUNT_B,
    trading_engine_id: engine.trading_engine_id, environment: "REAL", executor_shard_id: "executor-03",
    symbol: "BTCBRL", quote_asset: "BRL", decision_id: clientOrderId, idempotency_key: clientOrderId,
    clientOrderId, side: "BUY", purpose: "INITIAL", type: "MARKET", quoteOrderQty: "17.50",
    expectedOwnedOpenIds: [], assetCapBrl: 450, globalCapBrl: 725, assetExposureBeforeBrl: 0, globalExposureBeforeBrl: 0 });
  const calls = []; let observed = null;
  const fetcher = async (url, init = {}) => {
    const parsed = new URL(url), method = init.method ?? "GET";
    calls.push({ path: parsed.pathname, method, params: init.body ? new URLSearchParams(init.body) : parsed.searchParams });
    if (parsed.host === "api.ipify.org") return Response.json({ ip: "203.0.113.33" });
    if (parsed.pathname === "/api/v3/time") return Response.json({ serverTime: clock });
    if (parsed.pathname === "/api/v3/order" && method === "GET")
      return observed ? Response.json(observed) : Response.json({ code: -2013 }, { status: 400 });
    if (parsed.pathname === "/api/v3/account") return Response.json({ canTrade: true, balances: [
      { asset: "BRL", free: "1000", locked: "0" }, { asset: "BNB", free: "0.005", locked: "0" }] });
    if (parsed.pathname === "/sapi/v1/account/apiRestrictions") return Response.json({ ipRestrict: true,
      enableReading: true, enableSpotAndMarginTrading: true, enableWithdrawals: false, enableInternalTransfer: false,
      permitsUniversalTransfer: false, enableMargin: false, enableFutures: false, enableVanillaOptions: false,
      enablePortfolioMarginTrading: false, enableFixApiTrade: false });
    if (parsed.pathname === "/api/v3/exchangeInfo") {
      if (expireDuringReads) clock += 2000;
      return Response.json({ symbols: [{ symbol: "BTCBRL", status: "TRADING", baseAsset: "BTC", quoteAsset: "BRL",
        allowedSelfTradePreventionModes: ["NONE", "EXPIRE_TAKER", "EXPIRE_MAKER"], filters: [
          { filterType: "LOT_SIZE", minQty: "0.00001", maxQty: "100", stepSize: "0.00001" },
          { filterType: "PRICE_FILTER", minPrice: "1", maxPrice: "10000000", tickSize: "1" },
          { filterType: "NOTIONAL", minNotional: "10" }] }] });
    }
    if (parsed.pathname === "/api/v3/ticker/price") return Response.json({ symbol: parsed.searchParams.get("symbol"), price: "5000" });
    if (parsed.pathname === "/api/v3/openOrders") return Response.json([]);
    if (parsed.pathname === "/api/v3/order" && method === "POST") {
      observed = { symbol: "BTCBRL", clientOrderId, orderId: 123, side: "BUY", status: "FILLED",
        executedQty: "0.00004", cummulativeQuoteQty: "17.50", price: "0" };
      return Response.json(observed);
    }
    throw new Error("unexpected mock route");
  };
  const server = createServer(createExecutorHandler({ secret, stateDirectory: directory, registry, credentialEnvironment,
    shardId: "executor-03", expectedEgressIp: "203.0.113.33", fetcher, now: () => clock,
    tradingEnabled: true, killSwitch: false, logger: () => {} }));
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const path = "/v1/create-order";
  async function send(permit = {}) {
    const nonce = randomUUID().replaceAll("-", "");
    return fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: "POST", body,
      headers: { "content-type": "application/json", "x-coinops-timestamp": String(clock), "x-coinops-nonce": nonce,
        "x-coinops-body-sha256": sha256(body), "x-coinops-signature": requestSignature(secret, "POST", path, clock, nonce, body),
        "x-coinops-idempotency-key": clientOrderId, ...permit } });
  }
  const permit = (expiresAt = clock + 1000) => accountBudgetPermitHeaders(secret, { code: "PASS",
    operatorId: engine.operator_id, accountId: ACCOUNT_B, engineId: engine.trading_engine_id,
    shardId: "executor-03", clientOrderId, expiresAt }, { ...JSON.parse(body) }, body, clock);
  try {
    await enableAccountOrderPolicy(directory, engine, "executor-03");
    assert.equal((await send()).status, 403);
    assert.equal(calls.filter((call) => call.path === "/api/v3/order").length, 0);
    expireDuringReads = true;
    const expired = await send(permit());
    assert.equal(expired.status, 403);
    assert.equal((await expired.json()).error, "EXECUTOR_ACCOUNT_ORDER_BUDGET_PERMIT_DENIED");
    assert.deepEqual(await readdir(join(directory, "orders")), []);
    assert.equal(calls.filter((call) => call.method === "POST").length, 0);
    expireDuringReads = false;
    const first = await send(permit(clock + 8000));
    assert.equal(first.status, 200);
    assert.equal((await first.json()).order.clientOrderId, clientOrderId);
    clock += 9000;
    assert.equal((await send()).status, 200, "old exact receipt does not require a new POST permit");
    const posts = calls.filter((call) => call.method === "POST");
    assert.equal(posts.length, 1);
    assert.equal(posts[0].params.get("selfTradePreventionMode"), "EXPIRE_TAKER");
  } finally {
    await new Promise((done) => server.close(done));
    await rm(directory, { recursive: true, force: true });
  }
});
