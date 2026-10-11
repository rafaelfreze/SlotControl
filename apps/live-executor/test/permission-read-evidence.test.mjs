import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createExecutorHandler, productionPermissionReadEvidence } from "../src/server.mjs";
import { ExecutorRejection, requestSignature, sha256 } from "../src/security.mjs";
import { registryFixture, credentialEnvironment, intentContext } from "./registry-fixture.mjs";

const CODE = "EXECUTOR_PRODUCTION_PERMISSION_READ_UNAVAILABLE";
const evidence = { path: "/sapi/v1/account/apiRestrictions", http_status: 503, provider_code: -1000 };
const rejection = (code = CODE, readEvidence = evidence) => Object.assign(new ExecutorRejection(code, 503), { readEvidence });

test("only the typed permission observation serializes fixed-path bounded numeric evidence", () => {
  assert.deepEqual(productionPermissionReadEvidence(rejection(CODE, { ...evidence,
    message: "private", url: "https://api.binance.com?signature=secret", token: "private" })), evidence);
  for (const path of ["/api/v3/time", "/api/v3/account", evidence.path]) {
    assert.deepEqual(productionPermissionReadEvidence(rejection(CODE, { path, http_status: 200, provider_code: null })),
      { path, http_status: 200, provider_code: null });
    assert.deepEqual(productionPermissionReadEvidence(rejection(CODE, { path, http_status: null, provider_code: null })),
      { path, http_status: null, provider_code: null });
  }
  for (const readEvidence of [null, [], {}, { ...evidence, path: `${evidence.path}?signature=private` },
    { ...evidence, http_status: "503" }, { ...evidence, http_status: 600 },
    { ...evidence, provider_code: "-1000" }, { ...evidence, provider_code: -100_001 }])
    assert.equal(productionPermissionReadEvidence(rejection(CODE, readEvidence)), null);
  assert.equal(productionPermissionReadEvidence(rejection("EXECUTOR_PRODUCTION_PERMISSION_DENIED")), null);
  assert.equal(productionPermissionReadEvidence(Object.assign(new Error(CODE), { status: 503, readEvidence: evidence })), null);
});

test("signed READ_STATE and journal retain provider evidence without exposing signed URLs or error bodies", async () => {
  const registry = registryFixture(), engine = registry.engines[0];
  const secret = "fictional-test-only-hmac-permission-evidence";
  const stateDirectory = await mkdtemp(join(tmpdir(), "coinops-permission-evidence-"));
  const calls = [], events = [];
  let providerCode = -1000;
  const fetcher = async (url, init) => {
    const path = new URL(url).pathname; calls.push({ path, method: init?.method });
    if (path === "/api/v3/time") return Response.json({ serverTime: Date.now() });
    if (path === "/api/v3/account") return Response.json({ canTrade: true, balances: [] });
    if (path === "/sapi/v1/account/apiRestrictions")
      return Response.json({ code: providerCode, msg: "private signed URL signature=never-export" }, { status: 503 });
    if (path === "/api/v3/exchangeInfo") return Response.json({ symbols: [{ symbol: "BTCBRL", status: "TRADING",
      baseAsset: "BTC", quoteAsset: "BRL", filters: [
        { filterType: "LOT_SIZE", minQty: "0.00001", maxQty: "9000", stepSize: "0.00001" },
        { filterType: "PRICE_FILTER", minPrice: "1", maxPrice: "10000000", tickSize: "1" },
        { filterType: "NOTIONAL", minNotional: "10" }] }] });
    if (path === "/api/v3/ticker/price") return Response.json({ symbol: new URL(url).searchParams.get("symbol"), price: "430000" });
    if (path === "/api/v3/openOrders") return Response.json([]);
    assert.fail(`Unexpected fixture GET ${path}`);
  };
  const server = createServer(createExecutorHandler({ secret, registry, credentialEnvironment, stateDirectory,
    expectedEgressIp: "203.0.113.10", fetcher, logger: event => events.push(event) }));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const send = async () => {
    const path = "/v1/state", key = `fixture-state-${randomUUID()}`, timestamp = Date.now();
    const body = JSON.stringify(intentContext(engine, key)), nonce = randomUUID().replaceAll("-", "");
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: "POST", body,
      headers: { "content-type": "application/json", "x-coinops-timestamp": String(timestamp),
        "x-coinops-nonce": nonce, "x-coinops-body-sha256": sha256(body), "x-coinops-idempotency-key": key,
        "x-coinops-signature": requestSignature(secret, "POST", path, timestamp, nonce, body) } });
    return { status: response.status, body: await response.json() };
  };
  try {
    const result = await send();
    assert.equal(result.status, 503); assert.equal(result.body.error, CODE);
    assert.deepEqual(result.body.read_evidence, evidence);
    assert.deepEqual(events.at(-1).read_evidence, evidence);
    providerCode = -2015;
    const denied = await send();
    assert.equal(denied.body.error, "EXECUTOR_PRODUCTION_PERMISSION_DENIED");
    assert.equal(denied.body.read_evidence, undefined);
    assert.equal(events.at(-1).read_evidence, undefined);
    assert.ok(calls.every(call => call.method === "GET"));
    assert.ok(!JSON.stringify([result, denied, events]).match(/signature=|never-export|fictional-test-only|private signed/));
  } finally { await new Promise(resolve => server.close(resolve)); }
});
