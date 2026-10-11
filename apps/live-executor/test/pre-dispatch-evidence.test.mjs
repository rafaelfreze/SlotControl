import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, stat, utimes, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHmac } from "node:crypto";
import { historicalPreDispatchProof, historicalPreDispatchRuntimePin,
  HISTORICAL_REJECTION_RUNTIME, HISTORICAL_REJECTION_FINGERPRINT,
  HISTORICAL_BNB_REJECTION_RUNTIME, HISTORICAL_BNB_REJECTION_FINGERPRINT } from "../src/pre-dispatch-evidence.mjs";
import { attestNeverDispatched, assertUnsentFence } from "../src/unsent-recovery.mjs";
import { sha256 } from "../src/security.mjs";

const secret = "offline-only-historical-proof-with-entropy";
const engine = { operator_id: "operator", exchange_account_id: "account", trading_engine_id: "engine-a",
  executor_shard_id: "executor-02", symbol: "SOLBRL" };
const now = Date.now(), dispatchedAt = new Date(now - 180_000).toISOString();
const key = "ENGINE:exact-original-order", clientOrderId = "C2-fixture-4-B-0123456789abcd", decisionId = "d".repeat(64);
const record = { ...engine, environment: "REAL", action: "CREATE_ORDER", decision_id: decisionId,
  result: "EXECUTOR_QUOTE_BALANCE_INSUFFICIENT", http_status: 403, request_id: "10000000-0000-4000-8000-000000000001",
  idempotency_key_hash: sha256(clientOrderId).slice(0, 12), timestamp: new Date(now - 178_000).toISOString() };

async function fixture(bnb = false) {
  const directory = await mkdtemp(join(tmpdir(), "coinops-pre-post-proof-")), base = join(directory, sha256(key));
  await writeFile(`${base}.pending`, "a".repeat(64), { mode: 0o600 });
  await utimes(`${base}.pending`, new Date(now - 179_000), new Date(now - 179_000));
  const input = { secret, engine, clientOrderId, decisionId, dispatchedAt, claimKey: key,
    pendingHash: "a".repeat(64), pendingMtime: (await stat(`${base}.pending`)).mtimeMs,
    records: [bnb ? { ...record, result: "EXECUTOR_BNB_FEE_RESERVE_MISSING", http_status: 503 } : record],
    runtimeSha: bnb ? HISTORICAL_BNB_REJECTION_RUNTIME : HISTORICAL_REJECTION_RUNTIME,
    runtimeFingerprint: bnb ? HISTORICAL_BNB_REJECTION_FINGERPRINT : HISTORICAL_REJECTION_FINGERPRINT };
  const value = historicalPreDispatchProof(input);
  await writeFile(`${base}.pre-post-evidence`, JSON.stringify(value), { mode: 0o600 });
  return { directory, base, input, value, args: { directory, key, dispatchedAt, now: () => now,
    historical: { secret, scope: { ...engine, clientOrderId, decisionId } } } };
}

test("only pinned runtime and one exact scoped pre-POST rejection import; never timeout, POST unknown, mixed ownership or retries", async () => {
  const { input } = await fixture();
  for (const patch of [{ runtimeSha: "b".repeat(40) }, { runtimeFingerprint: "b".repeat(64) },
    { pendingHash: "broken" }, { records: [] }, { records: [record, record] },
    ...[{ result: "EXECUTOR_ORDER_POST_UNKNOWN" }, { http_status: 503 }, { trading_engine_id: "engine-b" },
      { executor_shard_id: "executor-03" }, { idempotency_key_hash: "wrong" }].map(changed => ({ records: [{ ...record, ...changed }] }))])
    assert.throws(() => historicalPreDispatchProof({ ...input, ...patch }), /UNPROVEN/);
});

test("new BNB evidence is restricted to exact runtime fingerprint, BNB503, ownership, unique journal identity and claim time", async () => {
  const f = await fixture(true), bnb = f.input.records[0];
  assert.equal(f.value.proof.rejection_code, "EXECUTOR_BNB_FEE_RESERVE_MISSING");
  assert.equal(f.value.proof.rejection_http_status, 503);
  assert.ok(historicalPreDispatchRuntimePin(HISTORICAL_REJECTION_RUNTIME, HISTORICAL_REJECTION_FINGERPRINT));
  assert.equal(historicalPreDispatchRuntimePin(HISTORICAL_BNB_REJECTION_RUNTIME, HISTORICAL_REJECTION_FINGERPRINT), null);
  for (const patch of [{ runtimeSha: HISTORICAL_REJECTION_RUNTIME },
    { runtimeFingerprint: HISTORICAL_REJECTION_FINGERPRINT },
    { pendingMtime: Date.parse(dispatchedAt) - 2_001 }, { pendingMtime: Date.parse(bnb.timestamp) + 1 },
    { records: [bnb, bnb] }, { records: [bnb, { ...bnb, trading_engine_id: "engine-b" }] },
    { records: [bnb, { ...bnb, decision_id: "e".repeat(64) }] },
    ...[{ result: "EXECUTOR_QUOTE_BALANCE_INSUFFICIENT", http_status: 403 },
      { http_status: 403 }, { result: "EXECUTOR_ORDER_POST_UNKNOWN" }, { result: "EXECUTOR_UNAVAILABLE" },
      { exchange_account_id: "account-b" }, { operator_id: "operator-b" }, { symbol: "BTCUSDT" },
      { executor_shard_id: "executor-03" }, { environment: "TESTNET" }, { request_id: "invalid" },
      { timestamp: new Date(Date.parse(dispatchedAt) + 35_001).toISOString() }]
      .map(changed => ({ records: [{ ...bnb, ...changed }] }))]) {
    assert.throws(() => historicalPreDispatchProof({ ...f.input, ...patch }), /UNPROVEN/);
  }
});

test("BNB historical proof archives only its original claim; replay is safe and siblings are not fenced", async () => {
  const f = await fixture(true);
  await writeFile(join(f.directory, `${sha256("ENGINE:sibling")}.pending`), "sibling", { mode: 0o600 });
  await attestNeverDispatched({ ...f.args, query: async () => null });
  const archives = (await readdir(f.directory)).filter(name => name.endsWith(".rejected"));
  assert.equal(archives.length, 1);
  assert.equal(await readFile(join(f.directory, archives[0]), "utf8"), f.input.pendingHash);
  assert.equal(await readFile(join(f.directory, `${sha256("ENGINE:sibling")}.pending`), "utf8"), "sibling");
  assert.doesNotThrow(() => assertUnsentFence(f.directory, "ENGINE:sibling", now - 1));
  assert.equal(await attestNeverDispatched({ ...f.args, query: async () => null }), true);
});

test("even a signed BNB proof with wrong pin/status/code, changed mtime, race or financial outcome remains fail-closed", async () => {
  for (const variant of ["pin", "code", "status", "no-status", "mtime", "race", "completed", "existing", "timeout"]) {
    const f = await fixture(true);
    if (["pin", "code", "status", "no-status"].includes(variant)) {
      const proof = { ...f.value.proof };
      if (variant === "pin") proof.runtimeFingerprint = HISTORICAL_REJECTION_FINGERPRINT;
      if (variant === "code") proof.rejection_code = "EXECUTOR_UNAVAILABLE";
      if (variant === "status") proof.rejection_http_status = 403;
      if (variant === "no-status") delete proof.rejection_http_status;
      const signature = createHmac("sha256", secret)
        .update(`COINOPS_PRE_POST_JOURNAL_V1\n${JSON.stringify(proof)}`).digest("hex");
      await writeFile(`${f.base}.pre-post-evidence`, JSON.stringify({ proof, signature }));
    }
    if (variant === "mtime") await utimes(`${f.base}.pending`, new Date(now), new Date(now));
    if (variant === "completed") await writeFile(`${f.base}.json`, "{}");
    await assert.rejects(attestNeverDispatched({ ...f.args, query: async () => {
      if (variant === "timeout") throw new Error("GET_TIMEOUT");
      if (variant === "race") await writeFile(`${f.base}.pending`, "b".repeat(64));
      return variant === "existing" ? { orderId: "accepted" } : null;
    } }));
    assert.ok(await readFile(`${f.base}.pending`));
  }
});

test("signed legacy rejection plus exact GET fences and ARCHIVES the claim, never deletes history or changes sibling", async () => {
  const f = await fixture(); let reads = 0;
  await attestNeverDispatched({ ...f.args, query: async () => { reads++; return null; } });
  assert.equal(reads, 1);
  await assert.rejects(readFile(`${f.base}.pending`), { code: "ENOENT" });
  const archived = (await readdir(f.directory)).find(name => name.endsWith(".rejected"));
  assert.equal(await readFile(join(f.directory, archived), "utf8"), "a".repeat(64));
  assert.throws(() => assertUnsentFence(f.directory, key, now - 1), /FENCED/);
  assert.doesNotThrow(() => assertUnsentFence(f.directory, "ENGINE:sibling-same-account-symbol", now - 1));
  // Retry after process crash between archive and returning the receipt is safe.
  assert.equal(await attestNeverDispatched({ ...f.args, query: async () => null }), true);
});

test("foreign/tampered proof, changed claim, completed claim, real order or failing GET preserve pending and block", async () => {
  for (const variant of ["foreign", "tampered", "changed", "completed", "existing", "timeout", "race"]) {
    const f = await fixture();
    if (variant === "foreign") f.args.historical.scope.trading_engine_id = "engine-b";
    if (variant === "tampered") await writeFile(`${f.base}.pre-post-evidence`, JSON.stringify({ ...f.value, signature: "0".repeat(64) }));
    if (variant === "changed") await writeFile(`${f.base}.pending`, "b".repeat(64));
    if (variant === "completed") await writeFile(`${f.base}.json`, "{}");
    await assert.rejects(attestNeverDispatched({ ...f.args, query: async () => {
      if (variant === "timeout") throw new Error("GET_TIMEOUT");
      if (variant === "race") await writeFile(`${f.base}.pending`, "b".repeat(64));
      return variant === "existing" ? { orderId: "accepted" } : null;
    } }));
    assert.ok(await readFile(`${f.base}.pending`));
  }
});

test("PostgREST +00:00 and ISO Z are the same exact dispatch instant; another millisecond never releases a claim", async () => {
  const valid = await fixture();
  await attestNeverDispatched({ ...valid.args, dispatchedAt: dispatchedAt.replace("Z", "+00:00"), query: async () => null });
  const changed = await fixture();
  await assert.rejects(attestNeverDispatched({ ...changed.args,
    dispatchedAt: new Date(Date.parse(dispatchedAt) + 1).toISOString(), query: async () => null }), /EVIDENCE_INVALID/);
  assert.ok(await readFile(`${changed.base}.pending`));
});
