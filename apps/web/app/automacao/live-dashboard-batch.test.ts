import assert from "node:assert/strict";
import test from "node:test";
import { readLiveDashboardBatch } from "./live-dashboard-batch.ts";
import type { EngineContext } from "../../lib/execution/operator-context";

test("only the complete canonical engine RPC certifies pause display completeness", async () => {
  const context = { operator_id: "operator-fixture", trading_engine_id: "engine-fixture", environment: "REAL" } as EngineContext;
  const payload = { run: null, slots: [], orders: [], accounts: [], events: [], alerts: [], monthlyGains: [], preparation: null };
  const client = { rpc(name: string, input: unknown) {
    assert.equal(name, "dashboard_live_engine_reads");
    assert.deepEqual(input, { p_operator_id: context.operator_id, p_engine_ids: [context.trading_engine_id] });
    return { abortSignal: async () => ({ data: [{ engine_id: context.trading_engine_id, payload }], error: null }) };
  } } as unknown as Parameters<typeof readLiveDashboardBatch>[0];
  assert.equal((await readLiveDashboardBatch(client, [context])).get(context.trading_engine_id)?.displayProtectionComplete, true);
});

test("partial or foreign canonical batch rows are rejected rather than certified", async () => {
  const context = { operator_id: "operator-fixture", trading_engine_id: "engine-fixture", environment: "REAL" } as EngineContext;
  for (const data of [[], [{ engine_id: "foreign", payload: {} }], [{ engine_id: context.trading_engine_id, payload: {} }]]) {
    const client = { rpc: () => ({ abortSignal: async () => ({ data, error: null }) }) } as unknown as Parameters<typeof readLiveDashboardBatch>[0];
    await assert.rejects(readLiveDashboardBatch(client, [context]), /COINOPS_ENGINE_BATCH/);
  }
});
