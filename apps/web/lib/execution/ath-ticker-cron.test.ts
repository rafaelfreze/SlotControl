import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { mayRecoverReadOutage } from "./live-read-recovery.ts";

const alert = { code: "COINOPS_LIVE_EXECUTOR_READ_STALE", details: {
  stage: "ATH_TRANSITION", root_code: "COINOPS_LIVE_ATH_PRICE_TIMEOUT",
  read_path: "market/ath_ticker/BTCUSDT", read_attempts: 2, http_status: null } };

function fixture(options: { mode?: string; reconciled?: string; details?: Record<string, unknown>;
  code?: string; paused?: boolean; resumeDenied?: boolean } = {}) {
  const resumed: unknown[][] = [], audits: Record<string, unknown>[] = [], advances: string[] = [];
  const runs = ["a", "b"].map(id => ({ id: `run-${id}`, user_id: "user", operator_id: "operator",
    exchange_account_id: `account-${id}`, trading_engine_id: `engine-${id}`, asset: "BTC",
    symbol: "BTCUSDT", quote_asset: "USDT", status: options.paused && id === "a" ? "PAUSED" : "ACTIVE" }));
  const service = { from(table: string) {
    const filters: Record<string, unknown> = {};
    const result = () => ({ error: null, data: table === "operators" ? [{ id: "operator" }]
      : table === "trading_engines" ? runs.map(run => ({ id: run.trading_engine_id,
        operator_id: run.operator_id, exchange_account_id: run.exchange_account_id,
        executor_shard_id: run.id === "run-a" ? "executor-02" : "executor-01" }))
      : table === "robot_v1_live_runs" ? runs
      : table === "robot_v1_live_alerts" ? filters.trading_engine_id === "engine-a"
        ? { code: options.code ?? alert.code, details: options.details ?? alert.details } : null
      : assert.fail(`unexpected table ${table}`) });
    const query = { select: () => query, eq: (key: string, value: unknown) => { filters[key] = value; return query; },
      in: () => query, is: () => query, order: () => query,
      maybeSingle: async () => result(), then: (done: (value: unknown) => unknown) => Promise.resolve(result()).then(done) };
    return query;
  } };
  const deps: Record<string, unknown> = {
    "next/server": { NextResponse: { json: (body: unknown) => body } },
    "./robot-v1-live-server": {
      advanceLiveRun: async (id: string) => { advances.push(id); return { status: options.reconciled ?? "OK" }; },
      auditLiveRun: async () => ({ status: "OK" }),
      resumeLiveRun: async (...args: unknown[]) => { resumed.push(args);
        if (options.resumeDenied) throw Error("COINOPS_LIVE_TP_UNPROTECTED");
        return { status: "RESUMED", recovered_alert_code: options.code ?? alert.code,
          recovered_alert_last_seen_at: "2026-11-13T17:40:29Z" };
      },
    },
    "./sharded-engine-map": { shardedEngineMap: async (items: unknown[], _key: unknown, _n: number,
      work: (item: unknown) => unknown) => Promise.all(items.map(work)) },
    "./live-read-recovery": { mayRecoverReadOutage },
    "../supabase/env": { getCoinOpsServiceTenantId: () => "tenant", getSupabaseDataSchema: () => "coinops" },
    "../supabase/service-role": { createServiceRoleClient: () => service },
    "../coinops-watchdog/watchdog-recovery-audit": { recordVerifiedReadRecovery: async (_service: unknown,
      scope: Record<string, unknown>) => { audits.push(scope); return "RECORDED"; } },
    "./live-cron-log-policy": { liveCronLog: () => null },
  };
  const compiled = ts.transpileModule(readFileSync(new URL("./live-cron-server.ts", import.meta.url), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: Record<string, unknown> = {};
  new Function("require", "exports", "process", compiled)((name: string) => deps[name] ?? {}, exports,
    { env: { CRON_SECRET: "isolated-fixture", COINOPS_LIVE_CRON_ENABLED: "true" } });
  const handle = exports.handleLiveCron as (...args: unknown[]) => Promise<{ reports: Array<Record<string, unknown>> }>;
  return { run: () => handle({ headers: { get: () => "Bearer isolated-fixture" } }, options.mode ?? "EXECUTION"),
    resumed, audits, advances };
}

test("normal server cron automatically resumes the typed outage and records exact Watchdog identity; sibling stays independent", async () => {
  const f = fixture(), result = await f.run();
  assert.deepEqual(f.advances.sort(), ["run-a", "run-b"]);
  assert.deepEqual(f.resumed, [["run-a", "user", "BTC", "VERIFIED_READ_RECOVERY"]]);
  assert.deepEqual(f.audits, [{ shardId: "executor-02", accountId: "account-a", engineId: "engine-a", runId: "run-a",
    alertCode: alert.code, alertSeenAt: "2026-11-13T17:40:29Z", action: "VERIFIED_READ_RECOVERY" }]);
  assert.equal(result.reports.find(r => r.run_id === "run-a")?.status, "RECOVERED");
  assert.equal(result.reports.find(r => r.run_id === "run-b")?.status, "OK");
});

test("rate-limited observation and exact legacy pre-dispatch outage recover through normal cron, not a second trader", async () => {
  const root = "EXECUTOR_BINANCE_RATE_LIMITED";
  for (const [code, details] of [
    ["COINOPS_LIVE_ARM_ENTRY_FAILED", { stage: "ARM_ENTRY", root_code: root }],
    ["COINOPS_LIVE_EXECUTOR_READ_STALE", { stage: "ARM_ENTRY", root_code: root, read_path: "/v1/state", read_attempts: 1, http_status: 503 }],
  ] as const) {
    const f = fixture({ code, details }), result = await f.run();
    assert.equal(result.reports.find(r => r.run_id === "run-a")?.status, "RECOVERED");
    assert.equal(result.reports.find(r => r.run_id === "run-b")?.status, "OK");
    assert.equal(f.resumed[0][3], "VERIFIED_READ_RECOVERY");
    assert.equal(f.audits[0].alertCode, code); assert.equal(f.audits[0].engineId, "engine-a");
    for (const denied of [{ reconciled: "RETRY" }, { paused: true }, { mode: "MONITOR" },
      { details: { ...details, read_path: "/v1/create-order" } }]) {
      const blocked = fixture({ code, details, ...denied }); await blocked.run();
      assert.equal(blocked.resumed.length, 0); assert.equal(blocked.audits.length, 0);
    }
  }
});

test("cron never resumes on partial reconciliation, intentional pause, monitor, hard failure or generic legacy cause", async () => {
  for (const options of [{ reconciled: "RETRY" }, { paused: true }, { mode: "MONITOR" },
    { details: { ...alert.details, http_status: 403 } },
    { code: "COINOPS_LIVE_ATH_TRANSITION_FAILED", details: { stage: "ATH_TRANSITION", root_code: "UNCLASSIFIED_FAILURE" } }]) {
    const f = fixture(options); await f.run(); assert.equal(f.resumed.length, 0); assert.equal(f.audits.length, 0);
  }
  const denied = fixture({ resumeDenied: true }), result = await denied.run();
  assert.equal(denied.audits.length, 0);
  assert.equal(result.reports.find(r => r.run_id === "run-a")?.status, "FAILED");
  assert.equal(result.reports.find(r => r.run_id === "run-b")?.status, "OK");
});
