import assert from "node:assert/strict";
import test from "node:test";
import { collectorStatus, shouldPersistCollectorObservation } from "./collector-policy.ts";
const state = { last_run_at: "2026-10-06T00:00:00Z", last_success_at: "2026-10-06T00:00:00Z",
  cadence_completed_at: {}, status: "HEALTHY", watchdog_status: "HEALTHY", watchdog_checked_at: "2026-10-06T00:00:00Z" };
test("healthy observation persists only bounded checkpoint, not every minute or five minutes", () => {
  for (const minute of [1, 5, 29]) assert.equal(shouldPersistCollectorObservation(state, "HEALTHY",
    new Date(`2026-10-06T00:${String(minute).padStart(2, "0")}:00Z`)), false);
  assert.equal(shouldPersistCollectorObservation(state, "HEALTHY", new Date("2026-10-06T00:30:00Z")), true);
});
test("failure/recovery transitions persist immediately, independent of checkpoint interval", () => {
  assert.equal(shouldPersistCollectorObservation(state, "FAILED", new Date("2026-10-06T00:01:00Z")), true);
  assert.equal(shouldPersistCollectorObservation({ ...state, watchdog_status: "FAILED" }, "HEALTHY",
    new Date("2026-10-06T00:01:00Z")), true);
});
test("missing/future observation is repaired but never makes stale collection fresh", () => {
  assert.equal(shouldPersistCollectorObservation({ ...state, watchdog_checked_at: null }, "HEALTHY",
    new Date("2026-10-06T00:01:00Z")), true);
  assert.equal(shouldPersistCollectorObservation(state, "HEALTHY", new Date("2026-10-05T23:59:00Z")), true);
  assert.equal(collectorStatus({ ...state, watchdog_checked_at: "2026-10-06T02:00:00Z" },
    new Date("2026-10-06T02:00:00Z")).status, "STALE");
});
