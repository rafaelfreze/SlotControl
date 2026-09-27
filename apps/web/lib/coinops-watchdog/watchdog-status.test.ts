import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateWatchdogStatus, type WatchdogCheck } from './watchdog-status.ts';
const now = Date.parse('2026-09-27T00:01:00Z');
const check: WatchdogCheck = { shard_id: 'executor-01', checked_at: new Date(now - 10_000).toISOString(),
  shard_state: 'HEALTHY', healthy_engines: 7, recovering_engines: 0, blocked_engines: 0, stale_engines: 0 };
test('live critical alert overrides a healthy sample before next watchdog tick', () => {
  assert.equal(aggregateWatchdogStatus(['executor-01'], [check], 0, now).status, 'HEALTHY');
  assert.equal(aggregateWatchdogStatus(['executor-01'], [check], 1, now).status, 'ATTENTION');
});
test('missing, old, invalid and future telemetry cannot claim health', () => {
  assert.equal(aggregateWatchdogStatus([], [], 0, now).status, 'STALE');
  assert.equal(aggregateWatchdogStatus(['executor-01', 'executor-02'], [check], 0, now).status, 'STALE');
  for (const checked_at of ['bad', new Date(now - 180_000).toISOString(), new Date(now + 60_000).toISOString()])
    assert.equal(aggregateWatchdogStatus(['executor-01'], [{ ...check, checked_at }], 0, now).status, 'STALE');
});
test('multi-shard freshness displays the oldest required check, not freshest sibling', () => {
  const old = { ...check, shard_id: 'executor-02', checked_at: new Date(now - 120_000).toISOString(),
    healthy_engines: 1, blocked_engines: 1, shard_state: 'BLOCKED' };
  const result = aggregateWatchdogStatus(['executor-01', 'executor-02'], [check, old], 1, now);
  assert.equal(result.status, 'ATTENTION');
  assert.equal(result.checkedAt, old.checked_at);
  assert.equal(result.engines.blocked, 1);
  assert.equal(result.executors.healthy, 1);
});
