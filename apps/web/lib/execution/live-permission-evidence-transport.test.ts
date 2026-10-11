import assert from "node:assert/strict";
import test from "node:test";
import { readLiveExecutorState } from "./live-executor-transport.ts";
import { LiveReadUnavailable, ExecutorHttpError, liveFailureEvidence } from "./live-read-error.ts";

const engine = { operator_id: "00000000-0000-4000-8000-000000000001",
  exchange_account_id: "00000000-0000-4000-8000-000000000002",
  trading_engine_id: "00000000-0000-4000-8000-000000000003", symbol: "BTCBRL", quote_asset: "BRL" };
const target = { shardId: "executor-02", ip: "203.0.113.2", base: "https://203.0.113.2", secret: "x".repeat(32) };
const evidence = { path: "/sapi/v1/account/apiRestrictions", http_status: 503, provider_code: -1000 };

test("exhausted scoped GET keeps sanitized upstream evidence in the durable read checkpoint", async () => {
  let calls = 0;
  const fetcher = (async (url: unknown) => {
    calls++; assert.equal(new URL(String(url)).pathname, "/v1/state");
    return Response.json({ error: "EXECUTOR_PRODUCTION_PERMISSION_READ_UNAVAILABLE", read_evidence: {
      ...evidence, url: "https://api.binance.com?signature=private", message: "private", key: "private" } }, { status: 503 });
  }) as typeof fetch;
  await assert.rejects(readLiveExecutorState(engine, fetcher, async () => target), (error: unknown) => {
    assert.ok(error instanceof LiveReadUnavailable); assert.equal(error.attempts, 4);
    assert.deepEqual(error.readEvidence, evidence);
    const exported = liveFailureEvidence(error, "READ_STATE", "ENGINE");
    assert.equal(exported.provider_read_path, evidence.path); assert.equal(exported.provider_http_status, 503);
    assert.equal(exported.provider_code, -1000);
    assert.ok(!JSON.stringify(exported).match(/private|signature|https:/));
    return true;
  });
  assert.equal(calls, 4);
});

test("real permission denial cannot inherit provider evidence or retry from a concurrent gateway payload", async () => {
  let calls = 0;
  const fetcher = (async () => {
    calls++; return Response.json({ error: "EXECUTOR_PRODUCTION_PERMISSION_DENIED", read_evidence: evidence }, { status: 503 });
  }) as typeof fetch;
  await assert.rejects(readLiveExecutorState(engine, fetcher, async () => target), (error: unknown) => {
    assert.ok(error instanceof ExecutorHttpError); assert.equal(error.readEvidence, null);
    assert.ok(!(error instanceof LiveReadUnavailable)); return true;
  });
  assert.equal(calls, 1);
});
