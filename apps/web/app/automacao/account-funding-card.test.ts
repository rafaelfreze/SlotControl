import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import type { ReactElement, ReactNode } from "react";
import type { FundingSummary } from "../../lib/execution/account-funding.ts";
import type { FundingPresentationEngine } from "./account-funding-presentation.ts";

const premium = readFileSync(new URL("./premium-automation.tsx", import.meta.url), "utf8");
const card = readFileSync(new URL("./account-funding-card.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("./account-funding-card.css", import.meta.url), "utf8");
const presentation = readFileSync(new URL("./account-funding-presentation.ts", import.meta.url), "utf8");

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
  assert.match(presentation, /LEITURA ANTIGA \/ NÃO CONFIRMADA/);
  assert.match(presentation, /summary\.status === "COVERED"/);
  assert.match(card, /known\.some\(\(summary\) => stale\(summary, Date\.now\(\)\)\)/);
  assert.match(presentation, /now - at > 30_000/);
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

test("BRL administrative observation shares one visual classification without changing financial controls", () => {
  assert.match(card, /fundingResumeToleranceObservation\(summary, now\)/);
  assert.match(card, /<p role="note">\{fundingResumeToleranceObservation\(summary, now\)\}/);
  assert.match(card, /Falta para a grade completa <strong>\{money\(summary\.deficit, summary\.currency\)\}/);
  assert.match(card, /row\.presentation\.tone === "warning"/);
  assert.match(card, /px-badge--observation/);
  assert.match(css, /\.px-funding \.px-badge--observation\{color:#b7d5ed/);
  assert.match(card, /presentation\.label/g);
  assert.match(premium, /engines=\{engines\}/);
  assert.match(card, /fundingClientMessage\(summary, now\)/);
  assert.match(card, /known\.map\(\(summary\) => fundingClientMessage\(summary\)\)/);
  assert.doesNotMatch(card, /known\.map\(fundingClientMessage\)/);
});

const require = createRequire(import.meta.url);
const React = require("react"), { renderToStaticMarkup } = require("react-dom/server");
const now = Date.parse("2026-10-15T22:00:00Z"), at = new Date(now).toISOString();
function renderCard(options: { summary?: Partial<FundingSummary>; engine?: Partial<FundingPresentationEngine>; error?: boolean } = {}) {
  const proof = { engineId: "engine-a", runId: "run-a", executorShardId: "executor-02", clientOrderId: "C2-engine-8-B-own",
    exchangeOrderId: "123", price: 500, quantity: .022, executedQuantity: 0, reservedQuote: 11 };
  const summary: FundingSummary = { accountId: "account-a", accountName: "Renato sintético", currency: "BRL", engineCount: 1,
    slotCount: 25, status: "SHORTFALL", observedAt: at, ledgerTarget: 275, pending: 0, configuredCap: 275,
    positionCost: 63.97, buyReserved: 11, spotFree: 200, spotLocked: 11, cashRequired: 200.03, deficit: .03,
    coverage: 274.97, bnbFree: .001, bnbStatus: "AVAILABLE", issues: [], residentBuys: [proof], ...options.summary };
  const engine: FundingPresentationEngine = { engineId: proof.engineId, accountId: summary.accountId, currency: "BRL",
    environment: "REAL", engineStatus: "ACTIVE", killSwitch: false, status: "ACTIVE", cycleId: proof.runId,
    executorShardId: proof.executorShardId, lastCheck: at, health: { healthy: true, tone: "ok", label: "OPERACIONAL", reason: "Protegido" },
    alerts: [], activeIssueCount: 0, nextCount: 1,
    orders: [{ id: proof.clientOrderId, exchangeId: proof.exchangeOrderId, slotNumber: 8, side: "BUY", purpose: "ENTRY", status: "NEW",
      price: 500, quantity: .022, executedQuantity: 0, quote: 0, at, resident: true, raw: { trades_reconciled: true } }], ...options.engine };
  const loaded = { exports: {} as { AccountFundingCard: (props: unknown) => ReactElement } };
  const compiled = ts.transpileModule(card, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  new Function("require", "module", "exports", compiled)((id: string) => {
    if (id === "react") return { ...React, useState: (initial: unknown) => [initial === false ? true : initial, () => {}] };
    if (id.endsWith(".css")) return {};
    if (id === "@/lib/execution/account-funding") return require("../../lib/execution/account-funding.ts");
    if (id === "./account-funding-presentation") return require("./account-funding-presentation.ts");
    if (id === "./premium-primitives") return {
      PremiumDrawer: ({ children, title }: { children: ReactNode; title: string }) => React.createElement("aside", null,
        React.createElement("h2", null, title), children),
      displayMoney: (value: number | null, currency: string) => value === null ? "—" : `${currency} ${value.toFixed(2)}`,
      displayNumber: (value: number | null) => String(value), displayTime: (value: string | null) => value,
    };
    return require(id);
  }, loaded, loaded.exports);
  return renderToStaticMarkup(loaded.exports.AccountFundingCard({ accountName: "Renato sintético", summaries: [summary], engines: [engine],
    loading: false, error: options.error ?? false, now, refreshAvailableAt: 0, onRefresh() {} })) as string;
}

test("rendered R$0.03 card and open details are neutral, retain actual shortfall and never claim covered principal", () => {
  const html = renderCard();
  assert.doesNotMatch(html, /px-funding--attention|px-badge--warning|PRINCIPAL COBERTO/);
  assert.match(html, /px-badge--observation/);
  assert.equal(html.match(/OBSERVAÇÃO · DIFERENÇA ATÉ R\$50/g)?.length, 2, "summary and drawer agree");
  assert.match(html, /Falta para a grade completa <strong>BRL 0\.03/);
  assert.match(html, /Faltam 0,03 BRL de principal/);
});

test("rendered card keeps real funding, BNB, missing resident, stale and failed-read warnings visible", () => {
  for (const options of [
    { engine: { alerts: [{ code: "COINOPS_LIVE_QUOTE_BALANCE_INSUFFICIENT", severity: "WARNING", at }] } },
    { engine: { orders: [], nextCount: 0 }, summary: { spotFree: 0 } },
    { summary: { bnbStatus: "LOW" as const } }, { summary: { deficit: 50.01 } },
    { summary: { observedAt: new Date(now - 30_001).toISOString() } }, { error: true },
  ]) {
    const html = renderCard(options);
    assert.match(html, /px-funding--attention/); assert.match(html, /px-badge--warning/);
    assert.doesNotMatch(html, /px-badge--observation/);
  }
  const failed = renderCard({ error: true });
  assert.match(failed, /SALDO NÃO CONFIRMADO NESTA CONSULTA/);
  assert.match(failed, /disabled="">Copiar mensagem para o cliente/);
  assert.match(failed, /LEITURA ANTIGA \/ NÃO CONFIRMADA\. Atualize/);
});
