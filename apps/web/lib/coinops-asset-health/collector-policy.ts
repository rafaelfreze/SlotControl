import type { AssetHealthCadence, AssetHealthDashboard } from "./types";

export const COLLECTION_INTERVALS_MS: Record<AssetHealthCadence, number> = {
  FAST: 30 * 60_000, STRUCTURAL: 6 * 60 * 60_000, DEVELOPMENT: 24 * 60 * 60_000,
};
export type CollectorState = {
  last_run_at: string | null; last_success_at: string | null; status: string;
  cadence_completed_at: Partial<Record<AssetHealthCadence, string>>;
  source_failures?: number; watchdog_checked_at?: string | null; watchdog_status?: string | null;
};
/** Observe every minute, persist transitions immediately and a bounded liveness checkpoint.
 * Snapshot freshness still comes from last_success_at, never this observation. */
export function shouldPersistCollectorObservation(state: CollectorState, status: string, now: Date) {
  const last = Date.parse(state.watchdog_checked_at ?? "");
  return state.watchdog_status !== status || !Number.isFinite(last)
    || last > now.getTime() || now.getTime() - last >= COLLECTION_INTERVALS_MS.FAST;
}
export function dueCadences(state: CollectorState | null, now: Date): AssetHealthCadence[] {
  return (Object.keys(COLLECTION_INTERVALS_MS) as AssetHealthCadence[]).filter((key) => {
    const last = Date.parse(state?.cadence_completed_at?.[key] ?? "");
    return !Number.isFinite(last) || last > now.getTime() || now.getTime() - last >= COLLECTION_INTERVALS_MS[key] - 60_000;
  });
}
export function collectorStatus(state: CollectorState | null, now: Date): AssetHealthDashboard["collector"] {
  const last = Date.parse(state?.last_success_at ?? "");
  const age = now.getTime() - last;
  return {
    status: !state?.last_run_at ? "NOT_RUN" : !Number.isFinite(last) || age > 90 * 60_000 || age < -60_000 ? "STALE"
      : state.status === "FAILED" || state.status === "DEGRADED" ? "FAILED" : "HEALTHY",
    lastRunAt: state?.last_success_at ?? null,
    nextExpectedAt: Number.isFinite(last) ? new Date(last + COLLECTION_INTERVALS_MS.FAST).toISOString() : null,
  };
}
export function historyDays(value: string | null): 30 | 90 | 365 {
  return value === "90" ? 90 : value === "365" ? 365 : 30;
}
