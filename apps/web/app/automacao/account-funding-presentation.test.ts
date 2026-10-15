import assert from "node:assert/strict";
import test from "node:test";

import type { FundingResidentBuy, FundingSummary } from "../../lib/execution/account-funding.ts";
import { fundingPresentation, fundingSnapshotStale, type FundingPresentationEngine } from "./account-funding-presentation.ts";

const now = Date.parse("2026-10-15T22:00:00Z"), at = new Date(now).toISOString();
const accountId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function residentProof(changes: Partial<FundingResidentBuy> = {}): FundingResidentBuy {
  return { engineId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", runId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    executorShardId: "executor-02", clientOrderId: "C2-bbbbbbbbbb-7-B-test", exchangeOrderId: "123",
    price: 500, quantity: .022, executedQuantity: 0, reservedQuote: 11, ...changes };
}

function summary(changes: Partial<FundingSummary> = {}): FundingSummary {
  return { accountId, accountName: "Conta sintética", currency: "BRL", engineCount: 1, slotCount: 25,
    status: "SHORTFALL", observedAt: at, ledgerTarget: 275, pending: 0, configuredCap: 275,
    positionCost: 63.97, buyReserved: 11, spotFree: 200, spotLocked: 11, cashRequired: 200.03,
    deficit: .03, coverage: 274.97, bnbFree: .001, bnbStatus: "AVAILABLE", issues: [],
    residentBuys: [residentProof()], ...changes };
}

function engine(changes: Partial<FundingPresentationEngine> = {}): FundingPresentationEngine {
  return { engineId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", accountId, currency: "BRL", environment: "REAL",
    engineStatus: "ACTIVE", status: "ACTIVE", killSwitch: false,
    health: { healthy: true, tone: "ok", label: "OPERACIONAL", reason: "Reconciliação confirmada" },
    alerts: [], activeIssueCount: 0, lastCheck: at, cycleId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    executorShardId: "executor-02", nextCount: 1,
    orders: [{ id: "C2-bbbbbbbbbb-7-B-test", exchangeId: "123", slotNumber: 7, side: "BUY", purpose: "ENTRY",
      status: "NEW", price: 500, quantity: .022, executedQuantity: 0, quote: 0, at,
      resident: true, raw: { trades_reconciled: true } }], ...changes };
}

const warning = (row: FundingSummary, engines: FundingPresentationEngine[] = [engine()], readError = false) =>
  assert.equal(fundingPresentation(row, engines, now, readError).tone, "warning");

test("complete BRL differences through R$50 are neutral observations, not covered principal", () => {
  for (const deficit of [.03, 49.99, 50]) {
    const row = summary({ deficit, cashRequired: 200 + deficit }), engines = [engine()];
    const before = structuredClone({ row, engines });
    assert.deepEqual(fundingPresentation(row, engines, now), {
      tone: "observation", label: "OBSERVAÇÃO · DIFERENÇA ATÉ R$50",
    });
    assert.deepEqual({ row, engines }, before);
    assert.equal(row.status, "SHORTFALL"); assert.equal(row.deficit, deficit);
  }
});

test("the BRL observation never inherits to other currencies or excess, malformed, zero deficits", () => {
  for (const changes of [
    { currency: "USDT" }, { currency: "USDC" }, { deficit: 50.00000001 }, { deficit: 0 },
    { deficit: -1 }, { deficit: NaN }, { cashRequired: Infinity }, { spotFree: null },
    { spotFree: -1 }, { ledgerTarget: null }, { coverage: null }, { bnbFree: null },
    { slotCount: 24 }, { engineCount: 0 }, { engineCount: 1.5 },
  ]) warning(summary(changes));
});

test("old, future, missing and invalid snapshots never become a neutral observation", () => {
  const current = summary();
  assert.equal(fundingSnapshotStale(current, now), false);
  assert.equal(fundingSnapshotStale(summary({ observedAt: new Date(now - 30_000).toISOString() }), now), false);
  assert.equal(fundingSnapshotStale(summary({ observedAt: new Date(now + 2_000).toISOString() }), now), false);
  for (const observedAt of [null, "not-a-date", new Date(now - 30_001).toISOString(), new Date(now + 2_001).toISOString()]) {
    const row = summary({ observedAt });
    assert.equal(fundingSnapshotStale(row, now), true); warning(row);
  }
  assert.equal(fundingSnapshotStale(current, NaN), true);
  assert.equal(fundingPresentation(current, [engine()], NaN).tone, "warning");
});

test("read failure, incomplete evidence and BNB shortage remain attention even inside tolerance", () => {
  warning(summary(), [engine()], true);
  for (const changes of [
    { status: "INCOMPLETE" as const }, { issues: ["ORDER_OUTCOME_AMBIGUOUS"] },
    { issues: ["BNB_UNAVAILABLE"] }, { bnbStatus: "LOW" as const }, { bnbStatus: "UNKNOWN" as const },
  ]) warning(summary(changes));
});

test("a small full-grid deficit cannot hide an actual next-order funding alert or unsafe runtime", () => {
  const changes: Array<Partial<FundingPresentationEngine>> = [
    { engineStatus: "BLOCKED" }, { status: "PAUSED" }, { status: "PREPARING" }, { killSwitch: true },
    { health: { healthy: false, tone: "attention", label: "AGUARDANDO SALDO", reason: "Saldo Spot insuficiente" } },
    { alerts: [{ code: "COINOPS_LIVE_QUOTE_BALANCE_INSUFFICIENT", severity: "WARNING", at }] },
    { alerts: [{ code: "COINOPS_LIVE_BNB_FEE_RESERVE_MISSING", severity: "WARNING", at }] },
    { alerts: [{ code: "COINOPS_LIVE_SUBMISSION_OUTCOME_UNKNOWN", severity: "CRITICAL", at }] },
    { activeIssueCount: 1 }, { cycleId: null }, { executorShardId: null }, { lastCheck: null },
    { lastCheck: "not-a-date" }, { lastCheck: new Date(now - 180_001).toISOString() },
    { lastCheck: new Date(now + 2_001).toISOString() },
  ];
  for (const change of changes) warning(summary(), [engine(change)]);
  assert.equal(fundingPresentation(summary(), [engine({ lastCheck: new Date(now - 180_000).toISOString() })], now).tone,
    "observation");
});

test("unfunded or unconfirmed NEXT BUY remains warning without inventing another strategy decision", () => {
  warning(summary({ buyReserved: 0 }));
  const empty = engine({ nextCount: 0, orders: [] });
  assert.deepEqual(fundingPresentation(summary({ spotFree: 0, cashRequired: 11, deficit: 11, buyReserved: 0 }), [empty], now), {
    tone: "warning", label: "PRÓXIMA BUY / OPERAÇÃO NÃO CONFIRMADA",
  });
  warning(summary(), [engine({ nextCount: 0 })]);
  warning(summary(), [engine({ nextCount: 2 })]);
  warning(summary(), [engine({ orders: [] })]);
  const duplicate = engine(); duplicate.orders.push({ ...duplicate.orders[0], id: "another-buy", exchangeId: "456" });
  warning(summary(), [duplicate]);
});

test("resident BUY identity, nonterminal quantity and finite positive pricing are required", () => {
  const changes: Array<Partial<FundingPresentationEngine["orders"][number]>> = [
    { resident: false }, { exchangeId: null }, { exchangeId: "" }, { id: "" }, { side: "SELL" },
    { status: "CANCELED" }, { status: "FILLED" }, { price: null }, { price: 0 }, { price: -1 }, { price: Infinity },
    { quantity: null }, { quantity: 0 }, { quantity: -1 }, { quantity: NaN },
    { executedQuantity: null }, { executedQuantity: -.001 }, { executedQuantity: .022 }, { executedQuantity: .023 },
  ];
  for (const change of changes) {
    const current = engine(); Object.assign(current.orders[0], change);
    warning(summary(), [current]);
  }
  const partial = engine();
  Object.assign(partial.orders[0], { status: "PARTIALLY_FILLED", executedQuantity: .001 });
  assert.equal(fundingPresentation(summary({ buyReserved: 10.5,
    residentBuys: [residentProof({ executedQuantity: .001, reservedQuote: 10.5 })] }), [partial], now).tone, "observation");
});

test("any ambiguous order or unreconciled fill prevents neutralizing a different resident BUY", () => {
  for (const status of ["PREPARED", "UNKNOWN", "SUBMITTING", "PENDING_CANCEL"]) {
    const current = engine();
    current.orders.push({ ...current.orders[0], id: `pending-${status}`, exchangeId: null, status, resident: false });
    warning(summary(), [current]);
  }
  for (const raw of [{ trades_reconciled: false }, {}, null]) {
    const current = engine();
    current.orders.push({ ...current.orders[0], id: "tp-fill", side: "SELL", purpose: "TP", status: "FILLED",
      resident: false, executedQuantity: .022, raw });
    warning(summary(), [current]);
  }
});

test("all same-account currency engines are checked across shards, independent of symbol filtering", () => {
  const secondProof = residentProof({ engineId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    runId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", executorShardId: "executor-03",
    clientOrderId: "C2-dddddddddd-8-B-test", exchangeOrderId: "456" });
  const row = summary({ engineCount: 2, slotCount: 50, buyReserved: 22,
    residentBuys: [residentProof(), secondProof] });
  const first = engine(), second = engine({ engineId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    executorShardId: "executor-03", cycleId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" });
  second.orders[0].id = "C2-dddddddddd-8-B-test"; second.orders[0].exchangeId = "456";
  assert.equal(fundingPresentation(row, [first, second], now).tone, "observation");
  warning(row, [first]); // A UI symbol filter must not make its sibling disappear.
  warning(row, [first, { ...second, alerts: [{ code: "COINOPS_LIVE_QUOTE_BALANCE_INSUFFICIENT", severity: "WARNING", at }] }]);
  warning(row, [first, { ...second, health: { healthy: false, tone: "attention", label: "REVISAR LIVE", reason: "Bloqueado" } }]);
  warning(row, [first, { ...second, engineId: first.engineId }]);
  warning(summary(), []);
});

test("a funding snapshot must attest each exact current resident BUY, not an older sibling snapshot", () => {
  warning(summary({ residentBuys: undefined }));
  warning(summary({ residentBuys: [] }));
  warning(summary({ residentBuys: [residentProof(), residentProof()] }));
  const second = engine({ engineId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    executorShardId: "executor-03", cycleId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" });
  second.orders[0].id = "C2-dddddddddd-8-B-test"; second.orders[0].exchangeId = "456";
  // New page says both are operating; the fresh funding snapshot only attests A.
  warning(summary({ engineCount: 2, slotCount: 50 }), [engine(), second]);
  // Two proofs for A cannot stand in for B, even when the counts agree.
  warning(summary({ engineCount: 2, slotCount: 50, buyReserved: 22,
    residentBuys: [residentProof(), residentProof()] }), [engine(), second]);
});

test("proof identity, current run/shard and exact Binance quantities cannot be substituted", () => {
  const changes: Array<Partial<FundingResidentBuy>> = [
    { engineId: "another-engine" }, { runId: "previous-run" }, { executorShardId: "executor-03" },
    { clientOrderId: "C2-bbbbbbbbbb-8-B-old-order" }, { exchangeOrderId: "456" },
    { price: 500.01 }, { price: NaN }, { quantity: .023 }, { quantity: Infinity },
    { executedQuantity: .001 }, { executedQuantity: NaN },
    { reservedQuote: 0 }, { reservedQuote: -1 }, { reservedQuote: NaN }, { reservedQuote: Infinity },
    { reservedQuote: 11.01 },
  ];
  for (const change of changes) warning(summary({ residentBuys: [residentProof(change)] }));
  // Current page has a replacement BUY; an older funding proof cannot certify it.
  const replaced = engine(); replaced.orders[0].id = "C2-bbbbbbbbbb-7-B-replacement";
  warning(summary(), [replaced]);
});

test("another account or currency cannot provide proof or poison an independently covered group", () => {
  const unrelated = engine({ engineId: "foreign", accountId: "another-account", status: "PAUSED", killSwitch: true });
  const usdt = engine({ engineId: "usdt-engine", currency: "USDT", status: "PAUSED", killSwitch: true });
  assert.equal(fundingPresentation(summary(), [engine(), unrelated, usdt], now).tone, "observation");
  warning(summary(), [unrelated, usdt]);
});

test("covered principal remains a separate fact and never repairs runtime or changes the input", () => {
  const row = summary({ status: "COVERED", deficit: 0, spotFree: 200.03, coverage: 275 }), before = structuredClone(row);
  assert.equal(fundingPresentation(row, [], now).tone, "covered");
  assert.deepEqual(row, before);
  warning({ ...row, bnbStatus: "LOW" });
  warning({ ...row, observedAt: new Date(now - 30_001).toISOString() });
  warning(row, [], true);
});
