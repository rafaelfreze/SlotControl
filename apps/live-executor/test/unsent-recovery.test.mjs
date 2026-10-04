import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attestNeverDispatched, assertUnsentFence } from "../src/unsent-recovery.mjs";
import { withWriteIdempotency, sha256 } from "../src/security.mjs";

const now = 1791144000000, key = "ENGINE:fixture-original-order", old = new Date(now - 180000).toISOString();
const fresh = () => mkdtemp(join(tmpdir(), "coinops-unsent-proof-"));
test("durable absence plus exact GET fences old requests and preserves a new dispatch", async () => {
  const directory = await fresh(); let reads = 0, posts = 0;
  await attestNeverDispatched({ directory, key, dispatchedAt: old, now: () => now, query: async () => { reads++; return null; } });
  assert.equal(reads, 1); assert.throws(() => assertUnsentFence(directory, key, now - 1), /FENCED/);
  assert.doesNotThrow(() => assertUnsentFence(directory, key, now + 1));
  const result = await withWriteIdempotency({ directory, key, bodyHash: "hash", beforeClaim: () => assertUnsentFence(directory, key, now + 1),
    recover: async () => null, execute: async () => { posts++; return { orderId: "1" }; } });
  assert.equal(result.replayed, false); assert.equal(posts, 1);
  await assert.rejects(attestNeverDispatched({ directory, key, dispatchedAt: old, now: () => now, query: async () => null }), /CLAIM_EXISTS/);
});
test("pending/completed/corrupt claims, real exchange order, recent dispatch and failed GET never prove unsent", async () => {
  for (const extension of ["pending", "json"]) {
    const directory = await fresh(); await writeFile(join(directory, `${sha256(key)}.${extension}`), "corrupt", { mode: 0o600 });
    let reads = 0;
    await assert.rejects(attestNeverDispatched({ directory, key, dispatchedAt: old, now: () => now, query: async () => { reads++; return null; } }), /CLAIM_EXISTS/);
    assert.equal(reads, 0);
  }
  await assert.rejects(attestNeverDispatched({ directory: await fresh(), key, dispatchedAt: new Date(now - 89999).toISOString(), now: () => now, query: async () => null }), /TOO_RECENT/);
  await assert.rejects(attestNeverDispatched({ directory: await fresh(), key, dispatchedAt: old, now: () => now, query: async () => ({ orderId: "existing" }) }), /ORDER_EXISTS/);
  await assert.rejects(attestNeverDispatched({ directory: await fresh(), key, dispatchedAt: old, now: () => now, query: async () => { throw new Error("GET_TIMEOUT"); } }), /GET_TIMEOUT/);
});
test("claim racing the GET is denied; order-scoped fence cannot affect a sibling engine", async () => {
  const directory = await fresh();
  await assert.rejects(attestNeverDispatched({ directory, key, dispatchedAt: old, now: () => now,
    query: async () => { await writeFile(join(directory, `${sha256(key)}.pending`), "claim", { mode: 0o600 }); return null; } }), /CLAIM_EXISTS/);
  assert.doesNotThrow(() => assertUnsentFence(directory, "ENGINE:other-same-symbol-engine", now - 1));
  assert.equal(await readFile(join(directory, `${sha256(key)}.pending`), "utf8"), "claim");
});

test("old request waking between beforeClaim and final POST is fenced and leaves no uncertain claim", async () => {
  const directory = await fresh(); let posts = 0;
  await assert.rejects(withWriteIdempotency({ directory, key, bodyHash: "hash", provablyUnsent: () => posts === 0,
    beforeClaim: () => attestNeverDispatched({ directory, key, dispatchedAt: old, now: () => now, query: async () => null }),
    recover: async () => null, execute: async () => { assertUnsentFence(directory, key, now - 1); posts++; } }), /FENCED/);
  assert.equal(posts, 0);
  await assert.rejects(readFile(join(directory, `${sha256(key)}.pending`)), { code: "ENOENT" });
});
