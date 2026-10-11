import assert from "node:assert/strict";
import test from "node:test";
import { getProductionRestrictedSpotStatus, observeProductionRestrictedSpotStatus } from "../src/binance-readonly.mjs";

const safe = { enableReading: true, enableSpotAndMarginTrading: true, ipRestrict: true,
  enableWithdrawals: false, enableInternalTransfer: false, permitsUniversalTransfer: false,
  enableMargin: false, enableFutures: false, enableVanillaOptions: false,
  enablePortfolioMarginTrading: false, enableFixApiTrade: false };

function fixture({ status = 200, body = safe, transportError = null, canTrade = true,
  accountError = false, clockError = false, jsonError = null, rawBody } = {}) {
  const calls = [];
  const fetcher = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push({ path, method: init.method });
    if (path === "/api/v3/time") {
      if (clockError) return Response.json({ code: typeof clockError === "number" ? clockError : -1000 }, { status: 503 });
      return Response.json({ serverTime: Date.now() });
    }
    if (path === "/api/v3/account") {
      if (accountError) return Response.json({ code: typeof accountError === "number" ? accountError : -1000 }, { status: 503 });
      return Response.json({ canTrade, balances: [] });
    }
    if (path === "/sapi/v1/account/apiRestrictions") {
      if (transportError) throw transportError;
      if (jsonError) return { status, ok: status >= 200 && status < 300,
        json: async () => { throw jsonError; } };
      if (rawBody !== undefined) return new Response(rawBody, { status });
      return Response.json(body, { status });
    }
    assert.fail(`Unexpected ${path}`);
  };
  return { input: { apiKey: "fixture-key", apiSecret: "fixture-secret", fetcher }, calls };
}

test("permission health contract remains unchanged while typed observations preserve availability evidence", async () => {
  const f = fixture({ status: 503, body: { code: -1000, msg: "private diagnostic" } });
  assert.equal(await getProductionRestrictedSpotStatus(f.input), "UNVERIFIED");
  assert.deepEqual(await observeProductionRestrictedSpotStatus(f.input), { status: "READ_UNAVAILABLE",
    readEvidence: { path: "/sapi/v1/account/apiRestrictions", http_status: 503, provider_code: -1000 } });
  assert.ok(f.calls.every(c => c.method === "GET"));
  assert.equal(await getProductionRestrictedSpotStatus(fixture().input), "SPOT_RESTRICTED");
});

test("known unsafe and incomplete grants do not become retryable, even with a concurrent account outage", async () => {
  for (const patch of [{ enableWithdrawals: true }, { ipRestrict: false }, { enableReading: false },
    { enableInternalTransfer: true }, { permitsUniversalTransfer: true }, { enableMargin: true },
    { enableFutures: true }, { enableVanillaOptions: true }, { enablePortfolioMarginTrading: true },
    { enableFixApiTrade: true }, { enableSpotAndMarginTrading: false }]) {
    assert.deepEqual(await observeProductionRestrictedSpotStatus(fixture({ body: { ...safe, ...patch } }).input),
      { status: "UNSAFE" });
    assert.deepEqual(await observeProductionRestrictedSpotStatus(fixture({ body: { ...safe, ...patch }, accountError: true }).input),
      { status: "UNSAFE" });
  }
  for (const body of [null, [], "invalid", { ...safe, enableWithdrawals: undefined },
    { ...safe, enableWithdrawals: "false" }])
    assert.deepEqual(await observeProductionRestrictedSpotStatus(fixture({ body }).input), { status: "UNVERIFIED" });
  assert.deepEqual(await observeProductionRestrictedSpotStatus(fixture({ rawBody: "not-json" }).input), { status: "UNVERIFIED" });
  assert.deepEqual(await observeProductionRestrictedSpotStatus(fixture({ canTrade: false,
    transportError: new TypeError("private") }).input), { status: "UNSAFE" });
});

test("auth/rate limits always fail closed and are never made retryable by HTTP gateway status", async () => {
  for (const status of [401, 403]) {
    assert.deepEqual(await observeProductionRestrictedSpotStatus(fixture({ status, body: { code: -2015 } }).input),
      { status: "UNVERIFIED" });
    assert.deepEqual(await observeProductionRestrictedSpotStatus(fixture({ status,
      jsonError: new DOMException("private", "TimeoutError") }).input), { status: "UNVERIFIED" });
  }
  for (const code of [-2014, -2015, -1022]) {
    assert.deepEqual(await observeProductionRestrictedSpotStatus(fixture({ status: 503, body: { code } }).input),
      { status: "UNVERIFIED" });
  }
  for (const code of [-1100, -9876, -1021]) {
    for (const options of [{ status: 503, body: { code } }, { clockError: code }, { accountError: code }])
      assert.deepEqual(await observeProductionRestrictedSpotStatus(fixture(options).input), { status: "UNVERIFIED" });
  }
  for (const code of ["-2015", "-1000", -100_001, "private-invalid-code"])
    assert.deepEqual(await observeProductionRestrictedSpotStatus(fixture({ status: 503, body: { code } }).input), { status: "UNVERIFIED" });
  for (const code of [-1000, -1001, -1006, -1007, -1008])
    assert.equal((await observeProductionRestrictedSpotStatus(fixture({ status: 503, body: { code } }).input)).status, "READ_UNAVAILABLE");
  assert.equal((await observeProductionRestrictedSpotStatus(fixture({ status: 502, rawBody: "gateway HTML" }).input)).status, "READ_UNAVAILABLE");
  for (const status of [429, 418])
    assert.deepEqual(await observeProductionRestrictedSpotStatus(fixture({ status }).input), { status: "RATE_LIMITED" });
  for (const code of [-1003, -1015])
    assert.deepEqual(await observeProductionRestrictedSpotStatus(fixture({ status: 503, body: { code } }).input), { status: "RATE_LIMITED" });
});

test("permission read evidence identifies clock/account/gateway failures without secrets or raw messages", async () => {
  for (const [options, path] of [[{ clockError: true }, "/api/v3/time"],
    [{ accountError: true }, "/api/v3/account"],
    [{ transportError: new DOMException("private signed URL", "TimeoutError") }, "/sapi/v1/account/apiRestrictions"],
    [{ jsonError: new DOMException("private stream timeout", "TimeoutError") }, "/sapi/v1/account/apiRestrictions"]]) {
    const observed = await observeProductionRestrictedSpotStatus(fixture(options).input);
    assert.equal(observed.status, "READ_UNAVAILABLE");
    assert.equal(observed.readEvidence.path, path);
    assert.ok(!JSON.stringify(observed).match(/private|fixture-secret|fixture-key|signature/));
  }
});

test("same account/symbol observations in different transports never share permission decisions", async () => {
  const blocked = fixture({ body: { ...safe, enableWithdrawals: true } });
  const protectedEngine = fixture();
  const [a, b] = await Promise.all([observeProductionRestrictedSpotStatus(blocked.input),
    observeProductionRestrictedSpotStatus(protectedEngine.input)]);
  assert.equal(a.status, "UNSAFE");
  assert.equal(b.status, "SPOT_RESTRICTED");
  assert.ok([...blocked.calls, ...protectedEngine.calls].every(c => c.method === "GET"));
});
