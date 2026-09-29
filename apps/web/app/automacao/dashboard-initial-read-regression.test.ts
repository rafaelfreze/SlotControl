import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const premium = readFileSync(new URL("./premium-automation.tsx", import.meta.url), "utf8");
const watchdog = readFileSync(new URL("./watchdog-card.tsx", import.meta.url), "utf8");
const sync = readFileSync(new URL("./use-automation-live-sync.ts", import.meta.url), "utf8");
const balances = readFileSync(new URL("../api/coinops-live-balances/route.ts", import.meta.url), "utf8");

test("all-account Binance balances load automatically without a manual gate", () => {
  assert.doesNotMatch(premium, /loadAllBalances|Consultar saldos das contas/);
  assert.match(premium, /coinops-live-balances\?account=/);
  assert.match(premium, /credentials: "same-origin"/);
  assert.match(premium, /Consultando saldos…/);
});

test("deferred server evidence is rendered as loading, never as a synthetic incident", () => {
  assert.match(premium, /initialHealthLoading/);
  assert.match(premium, /LIVE · ATUALIZANDO/);
  assert.match(premium, /!initialHealthLoading && !healthy && !paused/);
  assert.match(premium, /initialHealthLoading \? "ATUALIZANDO" : operational/);
  assert.match(premium, /initialHealthLoading \? "LIVE · ATUALIZANDO" : liveActive/);
  assert.match(watchdog, /loadState === "loading" \? "ATUALIZANDO"/);
  assert.doesNotMatch(watchdog, /SEM TELEMETRIA/);
  assert.match(sync, /"CONECTANDO"/);
  assert.match(sync, /subscriptionState === "connecting" \? "CONECTANDO"/);
});

test("balance endpoint shares Home authentication scope and has bounded read-only collection", () => {
  assert.match(balances, /from\("strategies"\)\.select\("product_id"\)/);
  assert.match(balances, /loadOperatorRegistry\(db/);
  assert.match(balances, /AbortSignal\.timeout\(5_000\)/);
  assert.match(balances, /readLiveExecutorState\(context, fetchState, resolve\)/);
  assert.doesNotMatch(balances, /createServiceRoleClient/);
});
