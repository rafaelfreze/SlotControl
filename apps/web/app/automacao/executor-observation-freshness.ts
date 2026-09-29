import type { LiveExecutorStatus } from "@/lib/execution/live-executor-health";

/** Expiration is based on signed server time, not receipt/render time. */
export function freshExecutorObservation(status: LiveExecutorStatus | undefined, now: number): LiveExecutorStatus {
  const observed = Date.parse(status?.health?.clock ?? "");
  return status && Number.isFinite(observed) && observed <= now + 2_000 && now - observed < 75_000
    ? status : { gate: "ATTENTION", ip: status?.ip ?? null, health: null };
}
