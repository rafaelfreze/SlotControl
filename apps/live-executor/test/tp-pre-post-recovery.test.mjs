import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { BinanceLiveTransport } from "../src/binance-live.mjs";
import { createExecutorHandler } from "../src/server.mjs";
import { ExecutorPreDispatchRejection, ExecutorRejection, requestSignature, sha256 } from "../src/security.mjs";
import { engineFixture, ACCOUNT_B, credentialEnvironment } from "./registry-fixture.mjs";
import { liveClientOrderId } from "../../web/lib/execution/robot-v1-live-cycle.ts";
import { verifyAccountOrderUnsentProof } from "../../web/lib/execution/account-order-unsent-proof.ts";

test("signed pre-POST TP/BUY rejection has a scoped receipt and no pending claim; uncertain POST retains claim", async () => {
  const secret = "fictional-test-only-tp-rate-limit-secret-12345";
  const engine = { ...engineFixture("BTCBRL", ACCOUNT_B, 103, false), execution_allowed: true, executor_shard_id: "executor-02" };
  const registry = { version: 1, executor_shard_id: "executor-02", engines: [engine],
    credentials: { [engine.credential_ref]: { api_key_env: "FIXTURE_B_KEY", api_secret_env: "FIXTURE_B_SECRET" } } };
  const directory = await mkdtemp(join(tmpdir(), "coinops-tp-pre-post-"));
  const original = BinanceLiveTransport.prototype.createOwnedOrder, query = BinanceLiveTransport.prototype.queryOrder;
  let uncertain = false, executions = 0;
  BinanceLiveTransport.prototype.createOwnedOrder = async function () {
    executions++; this.orderPostAttempted = uncertain;
    throw uncertain ? new ExecutorRejection("EXECUTOR_BINANCE_RESULT_UNKNOWN", 503)
      : new ExecutorPreDispatchRejection("EXECUTOR_RATE_LIMITED_BEFORE_POST", 503);
  };
  BinanceLiveTransport.prototype.queryOrder = async () => null;
  const server = createServer(createExecutorHandler({ secret, registry, credentialEnvironment, shardId: "executor-02",
    stateDirectory: directory, expectedEgressIp: "203.0.113.22", tradingEnabled: true, killSwitch: false,
    fetcher: async url => { assert.equal(new URL(url).host, "api.ipify.org"); return Response.json({ ip: "203.0.113.22" }); }, logger: () => {} }));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const send = async (side, slot, path = "/v1/create-order", purpose = side === "SELL" ? "TP" : "ENTRY") => {
    const client = liveClientOrderId(engine.trading_engine_id, "BTC", slot, 1, side, 1,
      { exchange_account_id: ACCOUNT_B, trading_engine_id: engine.trading_engine_id, base_asset: "BTC", legacy_compatible: false });
    const nonce = randomUUID(), now = Date.now(), key = client;
    const data = { operator_id: engine.operator_id, exchange_account_id: ACCOUNT_B, trading_engine_id: engine.trading_engine_id,
      executor_shard_id: "executor-02", environment: "REAL", symbol: "BTCBRL", quote_asset: "BRL", side, purpose,
      decision_id: "d".repeat(64), idempotency_key: key, clientOrderId: client, type: "LIMIT", quantity: ".001", price: "100000",
      dispatched_at: new Date(now - 180_000).toISOString() };
    const body = JSON.stringify(data);
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: "POST", body,
      headers: { "content-type": "application/json", "x-coinops-timestamp": String(now), "x-coinops-nonce": nonce,
        "x-coinops-body-sha256": sha256(body), "x-coinops-signature": requestSignature(secret, "POST", path, now, nonce, body),
        "x-coinops-idempotency-key": key } });
    return { response, payload: await response.json(), body, scope: { ...data, request_nonce: nonce } };
  };
  try {
    for (const side of ["BUY", "SELL"]) {
      const f = await send(side, 1);
      assert.equal(f.response.status, 503); assert.equal(f.payload.error, "EXECUTOR_RATE_LIMITED_BEFORE_POST");
      assert.equal(verifyAccountOrderUnsentProof(secret, f.payload.unsent_proof, {
        operator_id: engine.operator_id, exchange_account_id: ACCOUNT_B, trading_engine_id: engine.trading_engine_id,
        executor_shard_id: "executor-02", environment: "REAL", symbol: "BTCBRL", clientOrderId: f.scope.clientOrderId,
        decision_id: f.scope.decision_id, request_nonce: f.scope.request_nonce }, f.body).outcome, "NOT_SUBMITTED");
      assert.equal((await readdir(join(directory, "orders"))).filter(n => n.endsWith(".pending")).length, 0);
    }
    const proof = await send("SELL", 1, "/v1/prove-unsent-order");
    assert.equal(proof.response.status, 200); assert.equal(proof.payload.order, null); assert.ok(proof.payload.unsent_proof);
    const invalid = await send("SELL", 1, "/v1/prove-unsent-order", "ENTRY");
    assert.equal(invalid.response.status, 403);
    uncertain = true;
    const unknown = await send("SELL", 2);
    assert.equal(unknown.payload.unsent_proof, undefined);
    assert.equal((await readdir(join(directory, "orders"))).filter(n => n.endsWith(".pending")).length, 1);
    assert.equal((await send("SELL", 2, "/v1/prove-unsent-order")).response.status, 409);
    assert.equal(executions, 3, "attestation never executes an order");
  } finally {
    BinanceLiveTransport.prototype.createOwnedOrder = original; BinanceLiveTransport.prototype.queryOrder = query;
    await new Promise(resolve => server.close(resolve));
  }
});
