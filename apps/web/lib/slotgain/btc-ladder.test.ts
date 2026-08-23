import assert from "node:assert/strict";
import test from "node:test";

import {
  BtcLadderDomainError,
  buildBtcLadderPreview,
  compoundOperationalValue,
  reverseOperationalGains,
  type BtcLadderSlot
} from "./btc-ladder.ts";

type TestSlot = BtcLadderSlot & {
  btc_qty: number | null;
  entry: number | null;
  target: number | null;
  opened_at: string | null;
};

function slot(id: string, operationalGains: number, overrides: Partial<TestSlot> = {}): TestSlot {
  const rate = overrides.gain_rate ?? 0.012;
  const value = overrides.operational_value_usdt
    ?? compoundOperationalValue(10, rate, operationalGains);
  return {
    id,
    asset: "BTC",
    slot_number: id.charCodeAt(0) - 64,
    sort_order: id.charCodeAt(0) - 64,
    status: "gain",
    real_gains: operationalGains,
    operational_gains: operationalGains,
    operational_value_usdt: value,
    gain_unit_usdt: Number((value * rate).toFixed(8)),
    gain_rate: rate,
    btc_qty: null,
    entry: null,
    target: null,
    opened_at: null,
    ...overrides
  };
}

function after(preview: ReturnType<typeof buildBtcLadderPreview<TestSlot>>, id: string) {
  const result = preview.ranking_after.find((item) => item.id === id);
  assert.ok(result, `Slot ${id} ausente no ranking final.`);
  return result;
}

test("BTC base 10 compoe 1,2% para 0, 1, 2 e N gains", () => {
  assert.equal(compoundOperationalValue(10, 0.012, 0), 10);
  assert.equal(compoundOperationalValue(10, 0.012, 1), 10.12);
  assert.equal(compoundOperationalValue(10, 0.012, 2), 10.24144);
  assert.equal(compoundOperationalValue(10, 0.012, 24), Number((10 * 1.012 ** 24).toFixed(8)));
});

test("SOL base 25 compoe 5,5% para 0, 1, 2, 3 e N gains", () => {
  assert.equal(compoundOperationalValue(25, 0.055, 0), 25);
  assert.equal(compoundOperationalValue(25, 0.055, 1), 26.375);
  assert.equal(compoundOperationalValue(25, 0.055, 2), 27.825625);
  assert.equal(compoundOperationalValue(25, 0.055, 3), 29.35603437);
  assert.equal(compoundOperationalValue(25, 0.055, 9), Number((25 * 1.055 ** 9).toFixed(8)));
});

test("slots da mesma composicao produzem o mesmo saldo", () => {
  assert.equal(slot("A", 8).operational_value_usdt, slot("B", 8).operational_value_usdt);
});

test("aporte muda legitimamente a base e o gain seguinte compoe sobre o total", () => {
  const beforeContribution = compoundOperationalValue(10, 0.012, 8);
  const afterContribution = Number((beforeContribution + 5).toFixed(8));
  assert.equal(
    compoundOperationalValue(afterContribution, 0.012, 1),
    Number((afterContribution * 1.012).toFixed(8))
  );
  assert.notEqual(compoundOperationalValue(afterContribution, 0.012, 1), compoundOperationalValue(10, 0.012, 9));
});

test("reversao composta e o inverso exato dentro da precisao persistida", () => {
  const value = compoundOperationalValue(10, 0.012, 20);
  assert.ok(Math.abs(reverseOperationalGains(value, 0.012, 4) - compoundOperationalValue(10, 0.012, 16)) <= 1.1e-8);
});

test("A20/B10 referencia14 resulta A16/B14 e conserva caixa", () => {
  const preview = buildBtcLadderPreview({
    referenceOperationalGains: 14,
    slots: [slot("A", 20), slot("B", 10)]
  });
  assert.equal(after(preview, "A").operational_gains, 16);
  assert.equal(after(preview, "B").operational_gains, 14);
  assert.equal(preview.transfers.length, 1);
  assert.equal(preview.transfers[0]?.debited_usdt, preview.transfers[0]?.credited_usdt);
  assert.ok(Math.abs(preview.equity_difference_usdt) <= 1e-8);
});

test("cascata prioriza o recebedor mais proximo e usa todos os doadores", () => {
  const preview = buildBtcLadderPreview({
    referenceOperationalGains: 14,
    slots: [slot("A", 20), slot("B", 10), slot("C", 12), slot("D", 18), slot("E", 11)]
  });
  assert.equal(after(preview, "A").operational_gains, 14);
  assert.equal(after(preview, "D").operational_gains, 15);
  assert.ok(preview.transfers.some((item) => item.donor_slot_id === "A"));
  assert.ok(preview.transfers.some((item) => item.donor_slot_id === "D"));
  assert.equal(preview.is_conserved, true);
});

test("doador OPEN preserva real_gains e snapshot da posicao", () => {
  const donor = slot("A", 20, {
    status: "aberto",
    real_gains: 31,
    btc_qty: 0.00042,
    entry: 63_100,
    target: 63_857.2,
    opened_at: "2026-08-23T10:00:00.000Z"
  });
  const preview = buildBtcLadderPreview({
    referenceOperationalGains: 14,
    slots: [donor, slot("B", 10)]
  });
  const result = after(preview, "A");
  assert.equal(result.real_gains, 31);
  assert.equal(result.status, "aberto");
  assert.equal(result.btc_qty, donor.btc_qty);
  assert.equal(result.entry, donor.entry);
  assert.equal(result.target, donor.target);
  assert.equal(result.opened_at, donor.opened_at);
});

test("doador reduz saldo pelo inverso composto em vez de manter valor antigo", () => {
  const donor = slot("A", 30);
  const preview = buildBtcLadderPreview({
    referenceOperationalGains: 21,
    slots: [donor, slot("B", 12)]
  });
  const transfer = preview.transfers[0];
  assert.ok(transfer);
  assert.equal(transfer.donor_value_after_usdt, reverseOperationalGains(
    donor.operational_value_usdt,
    donor.gain_rate,
    transfer.donor_gain_equivalent
  ));
  assert.ok(transfer.donor_value_after_usdt < transfer.donor_value_before_usdt);
});

test("unidades diferentes mantem gains inteiros e residual financeiro no recebedor", () => {
  const donor = slot("A", 20, { gain_rate: 0.012, operational_value_usdt: 12.4, gain_unit_usdt: 0.1488 });
  const receiver = slot("B", 10, { gain_rate: 0.02, operational_value_usdt: 11.32, gain_unit_usdt: 0.2264 });
  const preview = buildBtcLadderPreview({ referenceOperationalGains: 14, slots: [donor, receiver] });
  assert.ok(preview.transfers.length > 0);
  assert.ok(preview.ranking_after.every((item) => Number.isInteger(item.operational_gains)));
  assert.ok(Math.abs(preview.equity_difference_usdt) <= 1e-8);
});

test("real_gains nunca muda na previa", () => {
  const slots = [slot("A", 20, { real_gains: 50 }), slot("B", 10, { real_gains: 4 })];
  const preview = buildBtcLadderPreview({ referenceOperationalGains: 14, slots });
  assert.equal(after(preview, "A").real_gains, 50);
  assert.equal(after(preview, "B").real_gains, 4);
});

test("excesso permanece quando nao existe recebedor", () => {
  const preview = buildBtcLadderPreview({
    referenceOperationalGains: 14,
    slots: [slot("A", 20), slot("B", 15)]
  });
  assert.equal(preview.can_confirm, false);
  assert.equal(preview.remaining_excess_gains, 7);
});

test("ranking tem desempate deterministico", () => {
  const preview = buildBtcLadderPreview({
    referenceOperationalGains: 14,
    slots: [
      slot("C", 14, { slot_number: 2, sort_order: 1 }),
      slot("B", 14, { slot_number: 1, sort_order: 2 }),
      slot("A", 14, { slot_number: 1, sort_order: 1 })
    ]
  });
  assert.deepEqual(preview.ranking_before.map((item) => item.id), ["A", "B", "C"]);
});

test("entradas invalidas sao bloqueadas", () => {
  assert.throws(() => buildBtcLadderPreview({ referenceOperationalGains: 0, slots: [slot("A", 20)] }), BtcLadderDomainError);
  assert.throws(() => buildBtcLadderPreview({ referenceOperationalGains: 14.5, slots: [slot("A", 20)] }), BtcLadderDomainError);
  assert.throws(() => buildBtcLadderPreview({ referenceOperationalGains: 14, slots: [slot("A", 14.66)] }), BtcLadderDomainError);
  assert.throws(() => buildBtcLadderPreview({ referenceOperationalGains: 14, slots: [slot("A", 20, { gain_rate: 0 })] }), BtcLadderDomainError);
  assert.throws(() => buildBtcLadderPreview({ referenceOperationalGains: 14, slots: [slot("A", 20), slot("A", 10)] }), BtcLadderDomainError);
});
