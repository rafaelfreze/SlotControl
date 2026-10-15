import assert from "node:assert/strict";
import test from "node:test";
import { unresolvedInfrastructureBlock } from "./infrastructure-push-policy.ts";

const now = Date.parse("2026-10-15T14:45:00Z");
const ago = (seconds: number) => new Date(now - seconds * 1_000).toISOString();
const alert = { shard_id: "executor-03", code: "EXECUTOR_OFFLINE", severity: "CRITICAL", first_seen_at: ago(180) };
const check = { shard_id: "executor-03", shard_state: "OFFLINE", checked_at: ago(20) };
const incident = { shard_id: "executor-03", engine_id: null, account_id: null,
  incident_key: "SHARD:EXECUTOR_OFFLINE", detected_condition: "EXECUTOR_OFFLINE",
  opened_at: ago(180), last_seen_at: ago(20), state_after: "OFFLINE", result: "OPEN", resolved_at: null };

test("only a persistent, fresh, unresolved Watchdog executor outage escalates", () => {
  assert.equal(unresolvedInfrastructureBlock(alert, check, incident, now), true);
});
test("capacity, pressure, resource, backlog and market advisories remain panel-only", () => {
  for (const code of ["CAPACITY_LIMIT", "EXECUTOR_CAPACITY_WARNING", "BINANCE_WEIGHT_WARNING", "SCHEDULER_BACKLOG_WARNING", "EXECUTOR_RESOURCE_WARNING", "ENGINE_STALE"]) {
    assert.equal(unresolvedInfrastructureBlock({ ...alert, code }, check, incident, now), false, code);
  }
});
test("quick, recovered, recovering or stale/unconfirmed outages never notify", () => {
  assert.equal(unresolvedInfrastructureBlock({ ...alert, first_seen_at: ago(30) }, check, incident, now), false);
  assert.equal(unresolvedInfrastructureBlock(alert, { ...check, shard_state: "HEALTHY" }, incident, now), false);
  assert.equal(unresolvedInfrastructureBlock(alert, check, { ...incident, resolved_at: ago(5) }, now), false);
  assert.equal(unresolvedInfrastructureBlock(alert, check, { ...incident, result: "RECOVERING" }, now), false);
  assert.equal(unresolvedInfrastructureBlock(alert, { ...check, checked_at: ago(200) }, incident, now), false);
  assert.equal(unresolvedInfrastructureBlock(alert, null, incident, now), false);
  assert.equal(unresolvedInfrastructureBlock(alert, check, null, now), false);
});
test("cross-shard and malformed/future incident evidence cannot escalate", () => {
  assert.equal(unresolvedInfrastructureBlock(alert, { ...check, shard_id: "executor-02" }, incident, now), false);
  assert.equal(unresolvedInfrastructureBlock(alert, check, { ...incident, shard_id: "executor-02" }, now), false);
  assert.equal(unresolvedInfrastructureBlock(alert, check, { ...incident, engine_id: "engine-a" }, now), false);
  assert.equal(unresolvedInfrastructureBlock(alert, check, { ...incident, account_id: "account-a" }, now), false);
  assert.equal(unresolvedInfrastructureBlock(alert, check, { ...incident, opened_at: "bad" }, now), false);
  assert.equal(unresolvedInfrastructureBlock(alert, check, { ...incident, last_seen_at: new Date(now + 60_000).toISOString() }, now), false);
});
