import "server-only";
import { assetHealthService } from "./access";
import { collectorStatus, shouldPersistCollectorObservation, type CollectorState } from "./collector-policy";

/** Watchdog observes the collector only. This result MUST NOT enter engine recovery or admission. */
export async function monitorAssetHealthCollector() {
  const service = assetHealthService(), now = new Date();
  const read = await service.from("asset_health_collector_state").select("*").eq("id", "default").maybeSingle();
  if (read.error) return { status: "UNAVAILABLE", code: "ASSET_COLLECTOR_READ_FAILED" };
  const state = read.data as CollectorState | null;
  const result = { ...collectorStatus(state, now), sourceFailures: state?.source_failures ?? null };
  if (state && shouldPersistCollectorObservation(state, result.status, now)) {
    const saved = await service.from("asset_health_collector_state").update({
      watchdog_checked_at: now.toISOString(), watchdog_status: result.status,
    }).eq("id", "default");
    if (saved.error) return { ...result, code: "ASSET_COLLECTOR_MONITOR_WRITE_FAILED" };
  }
  return result;
}
