import assert from "node:assert/strict";
import test from "node:test";
import { recordVerifiedReadRecovery } from "./watchdog-recovery-audit.ts";

const scope = { shardId: "executor-02", accountId: "account-a", engineId: "engine-a", runId: "run-a",
  alertCode: "COINOPS_LIVE_MONITOR_EXECUTOR_UNHEALTHY", alertSeenAt: "2026-09-27T00:00:12.000Z" };
const now = "2026-09-27T01:00:00.000Z";
function fixture(failure = false, prior: Record<string, unknown>[] = [{ action: "DETECTED" }]) {
  const writes: Array<Record<string, unknown>> = [];
  const service = { from(table: string) {
    assert.equal(table, "watchdog_incidents");
    const filters: Record<string, unknown> = {};
    let update: Record<string, unknown> | null = null;
    const chain = { select: () => chain,
      eq: (key: string, value: unknown) => { filters[key] = value; return chain; },
      is: (key: string, value: unknown) => { filters[key] = value; return chain; },
      like: (key: string, value: unknown) => { filters[key] = value; return chain; },
      update: (data: Record<string, unknown>) => { update = data; return chain; },
      then: (resolve: (value: unknown) => unknown) => {
        assert.equal(filters.shard_id, scope.shardId); assert.equal(filters.account_id, scope.accountId);
        assert.equal(filters.engine_id, scope.engineId); assert.equal(filters.incident_key, `${scope.runId}:%`);
        assert.equal(filters.resolved_at, null);
        if (update) writes.push(update);
        return Promise.resolve({ error: failure ? { message: "not logged" } : null,
          data: update ? [{ incident_id: "incident-a" }]
            : [{ incident_id: "incident-a", actions_taken: prior, last_recovery_attempt_at: null }] }).then(resolve);
      } };
    return chain;
  } } as unknown as Parameters<typeof recordVerifiedReadRecovery>[0];
  return { service, writes };
}

test("successful cron recovery records the exact incident but waits for watchdog validation", async () => {
  const scenario = fixture();
  assert.equal(await recordVerifiedReadRecovery(scenario.service, scope, now), "RECORDED");
  assert.equal(scenario.writes.length, 1);
  assert.equal(scenario.writes[0].result, "RECOVERING");
  assert.equal(scenario.writes[0].state_after, "RECOVERING");
  assert.equal(scenario.writes[0].resolved_at, undefined);
  assert.equal(scenario.writes[0].last_recovery_attempt_at, now);
  const actions = scenario.writes[0].actions_taken as Array<Record<string, unknown>>;
  assert.equal(actions[0].action, "DETECTED");
  assert.equal(actions[1].action, "VERIFIED_READ_RECOVERY");
  assert.equal(actions[1].source_alert_code, scope.alertCode);
});

test("repeated audit does not duplicate a recovery already recorded for this incident", async () => {
  const scenario = fixture(false, [{ action: "VERIFIED_READ_RECOVERY", recovery_id: `${scope.runId}:${scope.alertSeenAt}` }]);
  assert.equal(await recordVerifiedReadRecovery(scenario.service, scope, now), "RECORDED");
  assert.equal(scenario.writes.length, 0);
});

test("audit outage is reported without throwing into the successful trading recovery", async () => {
  const scenario = fixture(true);
  const original = console.error;
  const logs: string[] = [];
  try {
    console.error = (message: string) => logs.push(message);
    assert.equal(await recordVerifiedReadRecovery(scenario.service, scope, now), "AUDIT_FAILED");
  } finally { console.error = original; }
  assert.equal(scenario.writes.length, 0);
  assert.equal(logs.length, 1);
  assert.ok(!logs[0].includes("not logged"));
});
