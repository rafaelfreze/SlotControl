import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { assertOperationalEnvironment, isRetiredTestnetView, isTestnetEnabled } from "../execution/testnet-policy.ts";
import { BinanceSpotTestnetAdapter } from "../execution/binance-spot-testnet-adapter.ts";

const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

test("retirement is deterministic: stale enabled flag and reload cannot reactivate Testnet", () => {
  const prior = process.env.COINOPS_TESTNET_ENABLED;
  try {
    for (const flag of ["true", "false", ""]) {
      process.env.COINOPS_TESTNET_ENABLED = flag;
      assert.equal(isTestnetEnabled(), false);
      assert.throws(() => assertOperationalEnvironment("TESTNET"), /COINOPS_TESTNET_DISABLED/);
      assert.doesNotThrow(() => assertOperationalEnvironment("REAL"));
      assert.doesNotThrow(() => assertOperationalEnvironment("SHADOW"));
      for (const factory of [() => BinanceSpotTestnetAdapter.fromEnvironment(),
        () => BinanceSpotTestnetAdapter.readsFromEnvironment(),
        () => BinanceSpotTestnetAdapter.diagnosticFromEnvironment()])
        assert.throws(factory, /COINOPS_TESTNET_DISABLED/);
    }
  } finally {
    if (prior === undefined) delete process.env.COINOPS_TESTNET_ENABLED;
    else process.env.COINOPS_TESTNET_ENABLED = prior;
  }
});

test("old Testnet links are retired before loaders, with no old account/engine selection reused", () => {
  assert.equal(isRetiredTestnetView({ view: "testnet" }), true);
  assert.equal(isRetiredTestnetView({ testnet: "check" }), true);
  assert.equal(isRetiredTestnetView({ view: "live", testnet: "check" }), true);
  assert.equal(isRetiredTestnetView({ view: "live" }), false);
  assert.equal(isRetiredTestnetView(), false);
  const page = source("app/automacao/page.tsx");
  assert.ok(page.indexOf('redirect("/automacao?view=live&account=ALL")') < page.indexOf("loadOperatorRegistry(supabase"));
});

test("menu and onboarding offer only REAL; Testnet push probe is unreachable server-side", () => {
  assert.match(source("app/automacao/premium-automation.tsx"), /visibleEnvironments = \["live"\]/);
  assert.doesNotMatch(source("app/automacao/binance-accounts-panel.tsx"), /<option value="TESTNET"/);
  assert.doesNotMatch(source("app/automacao/operator-onboarding-panel.tsx"), /<option value="TESTNET"/);
  const drafts = source("app/automacao/operator-onboarding-actions.ts");
  assert.ok(drafts.indexOf("assertOperationalEnvironment(input.environment)") < drafts.indexOf("const draft = validateAccountDraft(input)"));
  assert.match(source("app/api/coinops-binance-accounts/route.ts"), /assertOperationalEnvironment\(input.environment/);
  assert.match(source("app/api/coinops-engine-control/route.ts"), /assertOperationalEnvironment\(environment\)/);
  assert.match(source("app/automacao/engine-action-context.ts"), /assertOperationalEnvironment\(environment\)/);
  assert.match(source("app/api/coinops-push/route.ts"), /action === "TESTNET_PROBE"\) \{\s+assertOperationalEnvironment\("TESTNET"\)/);
});

test("Testnet cron is removed; REAL operational crons remain unchanged", () => {
  const config = JSON.parse(source("vercel.json"));
  assert.deepEqual(config.crons.map((row: { path: string; schedule: string }) => [row.path, row.schedule]), [
    ["/api/cron/market-regime", "*/5 * * * *"],
    ["/api/cron/exchange-reconciliation", "*/5 * * * *"],
    ["/api/cron/live-execution", "* * * * *"],
    ["/api/cron/live-monitor", "0 */6 * * *"],
    ["/api/cron/coinops-push", "* * * * *"],
    ["/api/cron/coinops-capacity", "* * * * *"],
    ["/api/cron/coinops-watchdog", "* * * * *"],
    ["/api/cron/coinops-finops", "17 */6 * * *"],
    ["/api/cron/coinops-asset-health", "7,37 * * * *"],
  ]);
  const cron = source("lib/execution/testnet-cron-server.ts");
  assert.ok(cron.indexOf("!isTestnetEnabled()") < cron.indexOf("createServiceRoleClient()"));
  assert.ok(cron.indexOf('status: "DISABLED"') < cron.indexOf("advance: advanceTestnetRun"));
  assert.match(source("app/api/coinops-testnet/diagnostic/route.ts"), /status: 410/);
  assert.match(source("lib/coinops-capacity/capacity-server.ts"), /if \(!isTestnetEnabled\(\)\) return/);
});

test("historical reports still read Testnet ledgers, not deleted or rewritten", () => {
  assert.match(source("lib/coinops-reports/source-server.ts"), /withTestnet \? load\("robot_v1_testnet_runs"/);
  assert.match(source("lib/coinops-reports/source-server.ts"), /load\("robot_v1_testnet_orders"/);
});
