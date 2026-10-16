import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const originalPath = new URL("../migrations/20260924141913_add_multi_account_operator_engine_isolation.sql", import.meta.url);
const fixedPath = new URL("../migrations/20261016175026_large_engine_reconciliation_progress_checkpoint.sql", import.meta.url);
function extract(path) {
  const source = readFileSync(path, "utf8").replaceAll("\r\n", "\n");
  const start = source.indexOf("create or replace function coinops.sync_robot_v1_live_order(");
  assert.ok(start >= 0);
  const end = source.indexOf("end $$;", start);
  assert.ok(end > start);
  return source.slice(start, end + "end $$;".length);
}

test("queued order sync changes only its post-lock lease-expiry check to wall-clock time", () => {
  const original = extract(originalPath), fixed = extract(fixedPath);
  assert.equal(original.split("v_run.lease_until<=now()").length, 2);
  assert.equal(fixed, original.replace("v_run.lease_until<=now()", "v_run.lease_until<=clock_timestamp()"));
  assert.equal(fixed.split("clock_timestamp()").length, 2);
  const runLock = fixed.indexOf("select * into strict v_run from coinops.robot_v1_live_runs where id=v_order.run_id for update;");
  const leaseCheck = fixed.indexOf("v_run.lease_until<=clock_timestamp()");
  const firstFillWrite = fixed.indexOf("insert into coinops.robot_v1_live_fills");
  assert.ok(runLock > 0 && runLock < leaseCheck && leaseCheck < firstFillWrite);
  assert.match(fixed.slice(runLock, leaseCheck), /v_run\.lease_owner is distinct from p_lease_owner/);
});

test("the static replacement preserves all financial accounting, ownership, arguments and privileges", () => {
  const original = extract(originalPath), fixed = extract(fixedPath);
  // No transaction-start timestamp used for fee valuation or accounting is
  // rewritten. Only the lease's current authority needs wall-clock semantics.
  assert.equal((fixed.match(/now\(\)/g) ?? []).length, (original.match(/now\(\)/g) ?? []).length - 1);
  assert.match(fixed, /security definer set search_path=''/);
  assert.match(fixed, /COINOPS_LIVE_FILL_IDENTITY_COLLISION/);
  assert.match(fixed, /COINOPS_LIVE_POSITION_OVERSOLD/);
  assert.match(fixed, /on conflict \(exchange_account_id,symbol,exchange_trade_id\) do nothing/);
});
