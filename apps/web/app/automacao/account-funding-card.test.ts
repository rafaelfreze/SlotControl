import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const premium = readFileSync(new URL("./premium-automation.tsx", import.meta.url), "utf8");
const card = readFileSync(new URL("./account-funding-card.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("./account-funding-card.css", import.meta.url), "utf8");

test("full funding diagnostic shares the selected account balance read without eager ALL requests", () => {
  assert.match(premium, /selection\.accountId === "ALL" \|\| view/);
  assert.match(premium, /coinops-live-balances\?account=/);
  assert.match(premium, /includeFunding \? "&funding=1" : ""/);
  assert.match(premium, /now - previous >= 60_000/);
  assert.match(premium, /changedAccount \|\| explicitRefresh \|\| newFundingAlert/);
  assert.match(premium, /fundingAlertSignature/);
  assert.match(premium, /summaries: cached/);
  assert.match(premium, /funding\.summaries/);
  assert.doesNotMatch(premium, /coinops-live-balances\?account=ALL/);
});

test("quote and BNB warnings expose a read-only full-account command", () => {
  for (const code of ["COINOPS_LIVE_QUOTE_BALANCE_INSUFFICIENT", "COINOPS_LIVE_BNB_FEE_RESERVE_MISSING", "COINOPS_LIVE_BNB_FEE_BALANCE_UNAVAILABLE"])
    assert.match(premium, new RegExp(code));
  assert.match(premium, /changeSelection\(\{ accountId: item\.accountId, symbol: "ALL" \}\)/);
  assert.match(card, /todos os motores e mercados da conta/);
  assert.doesNotMatch(card, /setInterval|method: "POST"|method: "PATCH"|sendMessage|sendPush|cancelOrder|placeOrder/);
});

test("native currencies, pending allocation, fee guard and principal snapshot remain distinct", () => {
  assert.match(card, /BUY residentes já reservadas/);
  assert.match(card, /Aportes pendentes · ainda não aplicados/);
  assert.match(card, /Somente principal · fees futuras não estimadas/);
  assert.match(card, /não atômica/);
  assert.match(card, /saldo Earn não é caixa Spot/);
  assert.match(card, /status === "INCOMPLETE"/);
  assert.match(card, /!known \|\| oldSnapshot/);
  assert.match(card, /LEITURA ANTIGA \/ NÃO CONFIRMADA/);
  assert.match(card, /!stale\(summary, now\) && summary\.status === "COVERED"/);
  assert.match(card, /known\.some\(\(summary\) => stale\(summary, Date\.now\(\)\)\)/);
  assert.match(card, /now - Date\.parse\(summary\.observedAt\) > 30_000/);
});

test("client message is copied only on click in a closable drawer and touch targets remain accessible", () => {
  assert.match(card, /navigator\.clipboard\.writeText/);
  assert.match(card, /onClick=\{\(\) => void copy\(\)\}/);
  assert.match(card, /Nenhuma mensagem foi enviada/);
  assert.match(card, /PremiumDrawer open=\{open\}/);
  assert.match(card, /textarea readOnly aria-label/);
  assert.match(css, /min-height:44px/);
  assert.match(css, /font-size:16px/);
});
