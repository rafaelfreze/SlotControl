import assert from "node:assert/strict";
import test from "node:test";
import { readPartialTpCheckpointProof } from "./partial-tp-proof.ts";
import type { FastOrder, FastRun } from "./watchdog-policy.ts";
const run = { id: "run", status: "ACTIVE", reconciliation_checkpoint: { contract: "fixture" } } as FastRun;
const orders = Array.from({ length: 50 }, (_, i) => ({ id: `order-${i}`, side: "SELL", purpose: "TP",
  status: "PARTIALLY_FILLED", executed_quantity: .01, trades_reconciled: false })) as FastOrder[];
test("checkpointed partials use exactly one bounded database observation, not a call per order", async () => {
  let calls = 0;
  const result = await readPartialTpCheckpointProof((id, checkpoint, signal) => {
    calls++; assert.equal(id, run.id); assert.equal(checkpoint, run.reconciliation_checkpoint);
    assert.equal(signal.aborted, false); return Promise.resolve({ data: { proof: true }, error: null });
  }, run, 50, orders);
  assert.deepEqual(result, { proof: true }); assert.equal(calls, 1);
});
test("legacy25, paused, no checkpoint or no partials make no call; failure is never proof", async () => {
  const denied = () => { throw new Error("unexpected database call"); };
  for (const [r, count, rows] of [[run, 25, orders], [{ ...run, status: "PAUSED" }, 50, orders],
    [{ ...run, reconciliation_checkpoint: null }, 50, orders], [run, 50, []]] as const)
    assert.equal(await readPartialTpCheckpointProof(denied, r, count, [...rows]), null);
  assert.deepEqual(await readPartialTpCheckpointProof(() => Promise.resolve({ data: { misleading: true }, error: "503" }), run, 50, orders), { contract: "PARTIAL_TP_PROOF_UNAVAILABLE" });
  assert.deepEqual(await readPartialTpCheckpointProof(() => Promise.reject(new Error("timeout")), run, 50, orders), { contract: "PARTIAL_TP_PROOF_UNAVAILABLE" });
  assert.equal(await readPartialTpCheckpointProof(() => Promise.resolve({ data: null,
    error: { message: "COINOPS_LIVE_PARTIAL_TP_PROOF_UNSAFE" } }), run, 50, orders), null);
});
