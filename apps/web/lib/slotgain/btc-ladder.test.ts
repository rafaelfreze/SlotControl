import assert from "node:assert/strict";
import test from "node:test";

import {
  BtcLadderDomainError,
  buildBtcLadderPreview,
  gainEquivalentToUsdt,
  usdtToGainEquivalent,
  type BtcLadderSlot
} from "./btc-ladder.ts";

type TestSlot = BtcLadderSlot & {
  btc_qty: number | null;
  entry: number | null;
  target: number | null;
  opened_at: string | null;
};

function slot(id: string, operationalGains: number, overrides: Partial<TestSlot> = {}): TestSlot {
  return {
    id,
    asset: "BTC",
    slot_number: id.charCodeAt(0) - 64,
    sort_order: id.charCodeAt(0) - 64,
    status: "gain",
    real_gains: operationalGains,
    operational_gains: operationalGains,
    operational_value_usdt: 10 + operationalGains * 0.1,
    gain_unit_usdt: 0.1,
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

test("A20/B10 com referencia explicita 14 resulta em A16/B14", () => {
  const preview = buildBtcLadderPreview({
    referenceOperationalGains: 14,
    slots: [slot("A", 20), slot("B", 10)]
  });

  assert.equal(after(preview, "A").operational_gains, 16);
  assert.equal(after(preview, "B").operational_gains, 14);
  assert.equal(preview.transfers.length, 1);
  assert.equal(preview.transfers[0]?.amount_usdt, 0.4);
});

test("cascata prioriza o recebedor mais proximo da referencia", () => {
  const preview = buildBtcLadderPreview({
    referenceOperationalGains: 14,
    slots: [slot("A", 20), slot("B", 10), slot("C", 12)]
  });

  assert.deepEqual(preview.transfers.map((item) => `${item.donor_slot_id}->${item.receiver_slot_id}`), ["A->C", "A->B"]);
  assert.equal(after(preview, "A").operational_gains, 14);
  assert.equal(after(preview, "B").operational_gains, 14);
  assert.equal(after(preview, "C").operational_gains, 14);
});

test("a referencia e assistida e explicita, sem derivacao oculta da meta mensal", () => {
  const slots = [slot("A", 20), slot("B", 10)];
  const atFourteen = buildBtcLadderPreview({ referenceOperationalGains: 14, slots });
  const atFifteen = buildBtcLadderPreview({ referenceOperationalGains: 15, slots });

  assert.equal(atFourteen.reference_operational_gains, 14);
  assert.equal(after(atFourteen, "A").operational_gains, 16);
  assert.equal(atFifteen.reference_operational_gains, 15);
  assert.equal(after(atFifteen, "A").operational_gains, 15);
  assert.equal(after(atFifteen, "B").operational_gains, 15);
});

test("doador OPEN participa sem alterar real_gains ou a posicao executada", () => {
  const open = slot("A", 20, {
    status: "aberto",
    real_gains: 20,
    btc_qty: 0.00042,
    entry: 63_100,
    target: 63_731,
    opened_at: "2026-08-08T10:00:00.000Z"
  });
  const preview = buildBtcLadderPreview({
    referenceOperationalGains: 14,
    slots: [open, slot("B", 10)]
  });
  const donorAfter = after(preview, "A");

  assert.equal(donorAfter.status, "aberto");
  assert.equal(donorAfter.real_gains, 20);
  assert.equal(donorAfter.operational_gains, 16);
  assert.equal(donorAfter.btc_qty, open.btc_qty);
  assert.equal(donorAfter.entry, open.entry);
  assert.equal(donorAfter.target, open.target);
  assert.equal(donorAfter.opened_at, open.opened_at);
});

test("recebedor OPEN participa sem reescrever a posicao executada", () => {
  const openReceiver = slot("B", 10, {
    status: "aberto",
    real_gains: 8,
    btc_qty: 0.0002,
    entry: 62_500,
    target: 63_125,
    opened_at: "2026-08-08T11:00:00.000Z"
  });
  const preview = buildBtcLadderPreview({
    referenceOperationalGains: 14,
    slots: [slot("A", 20), openReceiver]
  });
  const receiverAfter = after(preview, "B");

  assert.equal(receiverAfter.status, "aberto");
  assert.equal(receiverAfter.real_gains, 8);
  assert.equal(receiverAfter.operational_gains, 14);
  assert.equal(receiverAfter.btc_qty, openReceiver.btc_qty);
  assert.equal(receiverAfter.entry, openReceiver.entry);
  assert.equal(receiverAfter.target, openReceiver.target);
  assert.equal(receiverAfter.opened_at, openReceiver.opened_at);
});

test("a previa nunca altera real_gains de nenhum participante", () => {
  const slots = [
    slot("A", 20, { real_gains: 31 }),
    slot("B", 10, { real_gains: 4 }),
    slot("C", 12, { real_gains: 9 })
  ];
  const preview = buildBtcLadderPreview({ referenceOperationalGains: 14, slots });

  for (const original of slots) {
    assert.equal(after(preview, original.id).real_gains, original.real_gains);
  }
});

test("unidades diferentes so redistribuem equivalentes inteiros para os dois slots", () => {
  const preview = buildBtcLadderPreview({
    referenceOperationalGains: 14,
    slots: [
      slot("A", 20, { gain_unit_usdt: 0.1 }),
      slot("B", 12, { gain_unit_usdt: 0.2 })
    ]
  });
  const transfer = preview.transfers[0];

  assert.ok(transfer);
  assert.equal(transfer.amount_usdt, 0.4);
  assert.equal(transfer.donor_gain_equivalent, 4);
  assert.equal(transfer.receiver_gain_equivalent, 2);
  assert.equal(after(preview, "A").operational_gains, 16);
  assert.equal(after(preview, "B").operational_gains, 14);
});

test("unidade diferente consome todo excedente inteiro e preserva o residual no saldo recebedor", () => {
  const preview = buildBtcLadderPreview({
    referenceOperationalGains: 14,
    slots: [
      slot("A", 20, { gain_unit_usdt: 0.12, operational_value_usdt: 12.4 }),
      slot("B", 10, { real_gains: 10, gain_unit_usdt: 0.132, operational_value_usdt: 11.32 })
    ]
  });

  assert.equal(preview.transfers.length, 1);
  assert.equal(preview.transfers[0].donor_gain_equivalent, 4);
  assert.equal(preview.transfers[0].receiver_gain_equivalent, 3);
  assert.equal(preview.transfers[0].amount_usdt, 0.48);
  assert.equal(after(preview, "A").operational_gains, 16);
  assert.equal(after(preview, "B").operational_gains, 13);
  assert.equal(after(preview, "B").operational_value_usdt, 11.8);
  assert.ok(Math.abs(preview.equity_difference_usdt) <= 1e-9);
});

test("todos os doadores acima da referencia entregam o excedente elegivel", () => {
  const preview = buildBtcLadderPreview({
    referenceOperationalGains: 21,
    slots: [
      slot("A", 31, { gain_unit_usdt: 0.12, operational_value_usdt: 14.16430223 }),
      slot("B", 24, { slot_number: 2, gain_unit_usdt: 0.16535392, operational_value_usdt: 13.28921868 }),
      slot("C", 16, { slot_number: 3, gain_unit_usdt: 0.12, operational_value_usdt: 12.07507021 }),
      slot("D", 4, { slot_number: 4, gain_unit_usdt: 0.12, operational_value_usdt: 10.48870933 })
    ]
  });

  assert.deepEqual(preview.transfers.map((item) => item.donor_slot_id), ["A", "A", "B"]);
  assert.equal(after(preview, "A").operational_gains, 21);
  assert.equal(after(preview, "B").operational_gains, 21);
  assert.equal(after(preview, "C").operational_gains, 21);
  assert.equal(after(preview, "D").operational_gains, 13);
  assert.equal(preview.remaining_excess_gains, 0);
  assert.ok(preview.ranking_after.every((item) => Number.isInteger(item.operational_gains)));
  assert.ok(Math.abs(preview.equity_difference_usdt) <= 1e-9);
});

test("unidades diferentes usam o maior multiplo comum que caiba na escada", () => {
  const preview = buildBtcLadderPreview({
    referenceOperationalGains: 14,
    slots: [
      slot("A", 20, { gain_unit_usdt: 0.12, operational_value_usdt: 12.4 }),
      slot("B", 12, { gain_unit_usdt: 0.18, operational_value_usdt: 12.16 })
    ]
  });
  const transfer = preview.transfers[0];

  assert.ok(transfer);
  assert.equal(transfer.amount_usdt, 0.36);
  assert.equal(transfer.donor_gain_equivalent, 3);
  assert.equal(transfer.receiver_gain_equivalent, 2);
  assert.equal(after(preview, "A").operational_gains, 17);
  assert.equal(after(preview, "B").operational_gains, 14);
  assert.ok(preview.ranking_after.every((item) => Number.isInteger(item.operational_gains)));
});

test("aporte usa a unidade pos-aporte para nao inflar gains operacionais", () => {
  const baseValue = 10;
  const growthBefore = 0;
  const amountUsdt = 1;
  const gainRate = 0.01;
  const gainUnitBefore = (baseValue + growthBefore) * gainRate;
  const gainUnitAfter = (baseValue + growthBefore + amountUsdt) * gainRate;
  const gainEquivalent = usdtToGainEquivalent(amountUsdt, gainUnitAfter);

  assert.equal(gainUnitBefore, 0.1);
  assert.equal(gainUnitAfter, 0.11);
  assert.ok(gainEquivalent < usdtToGainEquivalent(amountUsdt, gainUnitBefore));
  assert.ok(Math.abs(gainEquivalentToUsdt(gainEquivalent, gainUnitAfter) - amountUsdt) <= 1e-9);
});

test("debito e credito conservam o patrimonio exatamente dentro da tolerancia", () => {
  const preview = buildBtcLadderPreview({
    referenceOperationalGains: 14,
    slots: [slot("A", 20), slot("B", 10), slot("C", 12)]
  });
  const debited = preview.transfers.reduce((sum, item) => sum + item.amount_usdt, 0);
  const credited = preview.transfers.reduce((sum, item) => sum + item.amount_usdt, 0);

  assert.equal(debited, credited);
  assert.ok(preview.transfers.every((item) => item.debited_usdt === item.credited_usdt));
  assert.equal(preview.is_conserved, true);
  assert.ok(Math.abs(preview.equity_difference_usdt) <= 1e-9);
});

test("excesso permanece disponivel quando nao existe recebedor elegivel", () => {
  const preview = buildBtcLadderPreview({
    referenceOperationalGains: 14,
    slots: [slot("A", 20), slot("B", 15)]
  });

  assert.deepEqual(preview.transfers, []);
  assert.equal(preview.can_confirm, false);
  assert.equal(preview.remaining_excess_gains, 7);
  assert.equal(preview.remaining_deficit_gains, 0);
});

test("ranking e desempates permanecem deterministas", () => {
  const preview = buildBtcLadderPreview({
    referenceOperationalGains: 14,
    slots: [
      slot("C", 14, { slot_number: 2, sort_order: 1 }),
      slot("B", 14, { slot_number: 1, sort_order: 2 }),
      slot("A", 14, { slot_number: 1, sort_order: 1 })
    ]
  });

  assert.deepEqual(preview.ranking_before.map((item) => item.id), ["A", "B", "C"]);
  assert.deepEqual(preview.ranking_after.map((item) => item.id), ["A", "B", "C"]);
});

test("entradas financeiras ou identidades invalidas sao bloqueadas", () => {
  assert.throws(
    () => buildBtcLadderPreview({ referenceOperationalGains: -1, slots: [slot("A", 20)] }),
    BtcLadderDomainError
  );
  assert.throws(
    () => buildBtcLadderPreview({ referenceOperationalGains: 14.5, slots: [slot("A", 20)] }),
    BtcLadderDomainError
  );
  assert.throws(
    () => buildBtcLadderPreview({ referenceOperationalGains: 14, slots: [slot("A", 14.66)] }),
    BtcLadderDomainError
  );
  assert.throws(
    () => buildBtcLadderPreview({ referenceOperationalGains: 14, slots: [slot("A", 20, { gain_unit_usdt: 0 })] }),
    BtcLadderDomainError
  );
  assert.throws(
    () => buildBtcLadderPreview({ referenceOperationalGains: 14, slots: [slot("A", 20), slot("A", 10)] }),
    BtcLadderDomainError
  );
  assert.throws(
    () => buildBtcLadderPreview({
      referenceOperationalGains: 14,
      slots: [{ ...slot("A", 20), asset: "SOL" } as unknown as TestSlot]
    }),
    BtcLadderDomainError
  );
});
