import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const premium = readFileSync(new URL("./premium-automation.tsx", import.meta.url), "utf8");
test("Home consumes isolated current ledger and optional history without rebuilding trading", () => {
  assert.match(page, /loadLegacyLiveDashboard\(supabase, createServiceRoleClient\(\),/);
  assert.match(page, /operatorId: registry\.operator\.id/);
  assert.match(page, /nativeLiveReadPromise, legacySnapshot\.unavailableAssets/);
  assert.match(page, /legacySnapshot\.historyUnavailableAssets/);
  assert.doesNotMatch(page, /loadLegacyLiveData|events\.error \|\| alerts\.error/);
  assert.match(premium, /Histórico de atividades temporariamente indisponível/);
  assert.match(premium, /live-history:\$\{engine\.engineId\}/);
});
test("only a typed registry observation timeout opts into automatic page recovery", () => {
  assert.match(page, /error instanceof LiveReadUnavailable && error\.code === "COINOPS_OPERATOR_REGISTRY_READ_TIMEOUT"/);
  assert.match(page, /transient\.digest = AUTOMATION_READ_TRANSIENT_DIGEST/);
  assert.match(page, /throw error/);
});
