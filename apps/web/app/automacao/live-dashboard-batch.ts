import type { EngineContext } from "@/lib/execution/operator-context";
import type { createClient } from "@/lib/supabase/server";
import type { LiveAssetData } from "./automation-mobile";

export type DashboardLiveRead = Omit<LiveAssetData, "run" | "monthlyGains"> & {
  run: LiveAssetData["run"] | null;
  monthlyGains: Array<LiveAssetData["monthlyGains"][number] & { period_key: string }>;
  preparation: { liveEnabled: boolean; killSwitch: boolean; monthlyTarget?: number } | null;
};

/** One bounded request per group, not nine requests per engine. RLS stays on. */
export async function readLiveDashboardBatch(client: ReturnType<typeof createClient>, contexts: EngineContext[]) {
  const reads = new Map<string, DashboardLiveRead>();
  for (let offset = 0; offset < contexts.length; offset += 32) {
    const batch = contexts.slice(offset, offset + 32);
    if (batch.some((item) => item.operator_id !== batch[0].operator_id || item.environment !== "REAL"))
      throw new Error("COINOPS_ENGINE_SCOPE_DENIED");
    const response = await client.rpc("dashboard_live_engine_reads", {
      p_operator_id: batch[0].operator_id, p_engine_ids: batch.map((item) => item.trading_engine_id),
    }).abortSignal(AbortSignal.timeout(6_000));
    if (response.error || !Array.isArray(response.data))
      throw new Error("COINOPS_ENGINE_BATCH_UNAVAILABLE");
    const expected = new Set(batch.map((item) => item.trading_engine_id));
    for (const row of response.data as Array<{ engine_id: string; payload: DashboardLiveRead }>) {
      if (!expected.has(row.engine_id) || reads.has(row.engine_id))
        throw new Error("COINOPS_ENGINE_BATCH_SCOPE_INVALID");
      const value = row.payload;
      if (!value || ![value.slots, value.orders, value.accounts, value.events, value.alerts, value.monthlyGains].every(Array.isArray))
        throw new Error("COINOPS_ENGINE_BATCH_UNAVAILABLE");
      reads.set(row.engine_id, value);
    }
    if (batch.some((item) => !reads.has(item.trading_engine_id)))
      throw new Error("COINOPS_ENGINE_BATCH_UNAVAILABLE");
  }
  return reads;
}
