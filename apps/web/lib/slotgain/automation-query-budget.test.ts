import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("../../app/automacao/page.tsx", import.meta.url), "utf8");
const sync = readFileSync(new URL("../../app/automacao/use-automation-live-sync.ts", import.meta.url), "utf8");
const errorPage = readFileSync(new URL("../../app/automacao/error.tsx", import.meta.url), "utf8");

test("Testnet event feed reads only the selected run instead of sorting all historical runs", () => {
  const eventReads = [...page.matchAll(/supabase\.from\("robot_v1_testnet_events"\)\.select\("id,run_id,event_type,slot_number,observed_at,details"\)([\s\S]*?)\.limit\((?:40|100)\)/g)];
  assert.equal(eventReads.length, 2);
  for (const [, query] of eventReads) {
    assert.match(query, /\.eq\("tenant_id", tenantId\)\.eq\("user_id", userId\)/);
    assert.match(query, /\.eq\("run_id", run\.id\)/);
    assert.doesNotMatch(query, /\.in\("run_id", runIds\)/);
  }
});

test("legacy candle history is scoped and live refresh has a bounded request gap", () => {
  assert.match(page, /from\("robot_v1_market_candles"\)[\s\S]*?\.eq\("product_id", productId\)\.eq\("tenant_id", tenantId\)\.eq\("user_id", user\.id\)/);
  assert.match(sync, /MIN_REFRESH_GAP_MS = 15_000/);
  assert.match(sync, /lastRefreshRequested\.current >= MIN_REFRESH_GAP_MS/);
  assert.match(errorPage, /estado operacional não está confirmado/);
});
