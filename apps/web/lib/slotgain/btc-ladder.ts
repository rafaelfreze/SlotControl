const EPSILON = 1e-9;

function round8(value: number) {
  return Number(value.toFixed(8));
}

export type BtcLadderSlot = {
  id: string;
  asset: "BTC";
  slot_number: number;
  sort_order: number;
  status: string;
  real_gains: number;
  operational_gains: number;
  operational_value_usdt: number;
  gain_unit_usdt: number;
};

export type RankedBtcLadderSlot<TSlot extends BtcLadderSlot = BtcLadderSlot> = TSlot & {
  rank: number;
  reference_difference_gains: number;
  excess_gains: number;
  deficit_gains: number;
};

export type BtcLadderTransfer = {
  donor_slot_id: string;
  receiver_slot_id: string;
  donor_status: string;
  receiver_status: string;
  amount_usdt: number;
  debited_usdt: number;
  credited_usdt: number;
  donor_gain_equivalent: number;
  receiver_gain_equivalent: number;
  donor_operational_before: number;
  donor_operational_after: number;
  receiver_operational_before: number;
  receiver_operational_after: number;
  donor_value_before_usdt: number;
  donor_value_after_usdt: number;
  receiver_value_before_usdt: number;
  receiver_value_after_usdt: number;
};

export type BtcLadderPreview<TSlot extends BtcLadderSlot = BtcLadderSlot> = {
  reference_operational_gains: number;
  ranking_before: RankedBtcLadderSlot<TSlot>[];
  transfers: BtcLadderTransfer[];
  ranking_after: RankedBtcLadderSlot<TSlot>[];
  total_transferred_usdt: number;
  equity_before_usdt: number;
  equity_after_usdt: number;
  equity_difference_usdt: number;
  is_conserved: boolean;
  can_confirm: boolean;
  remaining_excess_gains: number;
  remaining_excess_usdt: number;
  remaining_deficit_gains: number;
  remaining_deficit_usdt: number;
};

export class BtcLadderDomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BtcLadderDomainError";
  }
}

function isFiniteNonNegative(value: number) {
  return Number.isFinite(value) && value >= 0;
}

function compareSlots(first: BtcLadderSlot, second: BtcLadderSlot) {
  return second.operational_gains - first.operational_gains
    || first.slot_number - second.slot_number
    || first.sort_order - second.sort_order
    || first.id.localeCompare(second.id);
}

function validateSlot(slot: BtcLadderSlot) {
  if (!slot.id.trim()) {
    throw new BtcLadderDomainError("Todo slot BTC precisa de um id.");
  }
  if (slot.asset !== "BTC") {
    throw new BtcLadderDomainError(`Slot ${slot.id}: somente BTC e aceito pela escada.`);
  }
  if (!Number.isInteger(slot.slot_number) || slot.slot_number <= 0) {
    throw new BtcLadderDomainError(`Slot ${slot.id}: slot_number invalido.`);
  }
  if (!Number.isInteger(slot.sort_order) || slot.sort_order < 0) {
    throw new BtcLadderDomainError(`Slot ${slot.id}: sort_order invalido.`);
  }
  if (!slot.status.trim()) {
    throw new BtcLadderDomainError(`Slot ${slot.id}: status invalido.`);
  }
  if (!Number.isInteger(slot.real_gains) || slot.real_gains < 0) {
    throw new BtcLadderDomainError(`Slot ${slot.id}: real_gains invalido.`);
  }
  if (!isFiniteNonNegative(slot.operational_gains)) {
    throw new BtcLadderDomainError(`Slot ${slot.id}: operational_gains invalido.`);
  }
  if (!isFiniteNonNegative(slot.operational_value_usdt)) {
    throw new BtcLadderDomainError(`Slot ${slot.id}: operational_value_usdt invalido.`);
  }
  if (!Number.isFinite(slot.gain_unit_usdt) || slot.gain_unit_usdt <= 0) {
    throw new BtcLadderDomainError(`Slot ${slot.id}: gain_unit_usdt deve ser positivo.`);
  }
}

function validateInput(referenceOperationalGains: number, slots: readonly BtcLadderSlot[]) {
  if (!Number.isFinite(referenceOperationalGains) || referenceOperationalGains <= 0) {
    throw new BtcLadderDomainError("A referencia operacional deve ser um numero positivo.");
  }

  const ids = new Set<string>();
  for (const slot of slots) {
    validateSlot(slot);
    if (ids.has(slot.id)) {
      throw new BtcLadderDomainError(`O slot ${slot.id} foi informado mais de uma vez.`);
    }
    ids.add(slot.id);
  }
}

export function gainEquivalentToUsdt(gainEquivalent: number, gainUnitUsdt: number) {
  if (!isFiniteNonNegative(gainEquivalent) || !Number.isFinite(gainUnitUsdt) || gainUnitUsdt <= 0) {
    throw new BtcLadderDomainError("Conversao de gain para USDT recebeu valores invalidos.");
  }
  return round8(gainEquivalent * gainUnitUsdt);
}

export function usdtToGainEquivalent(amountUsdt: number, gainUnitUsdt: number) {
  if (!isFiniteNonNegative(amountUsdt) || !Number.isFinite(gainUnitUsdt) || gainUnitUsdt <= 0) {
    throw new BtcLadderDomainError("Conversao de USDT para gain recebeu valores invalidos.");
  }
  return round8(amountUsdt / gainUnitUsdt);
}

function rankSlots<TSlot extends BtcLadderSlot>(slots: readonly TSlot[], referenceOperationalGains: number) {
  return [...slots]
    .sort(compareSlots)
    .map((slot, index) => {
      const referenceDifference = round8(slot.operational_gains - referenceOperationalGains);
      return {
        ...slot,
        rank: index + 1,
        reference_difference_gains: referenceDifference,
        excess_gains: Math.max(referenceDifference, 0),
        deficit_gains: Math.max(-referenceDifference, 0)
      } as RankedBtcLadderSlot<TSlot>;
    });
}

function sumOperationalValue(slots: readonly BtcLadderSlot[]) {
  return round8(slots.reduce((total, slot) => total + slot.operational_value_usdt, 0));
}

function summarizeRemaining(slots: readonly BtcLadderSlot[], referenceOperationalGains: number) {
  return slots.reduce(
    (summary, slot) => {
      const difference = slot.operational_gains - referenceOperationalGains;
      if (difference > EPSILON) {
        summary.excessGains = round8(summary.excessGains + difference);
        summary.excessUsdt = round8(summary.excessUsdt + gainEquivalentToUsdt(difference, slot.gain_unit_usdt));
      } else if (difference < -EPSILON) {
        const deficit = -difference;
        summary.deficitGains = round8(summary.deficitGains + deficit);
        summary.deficitUsdt = round8(summary.deficitUsdt + gainEquivalentToUsdt(deficit, slot.gain_unit_usdt));
      }
      return summary;
    },
    { excessGains: 0, excessUsdt: 0, deficitGains: 0, deficitUsdt: 0 }
  );
}

export function buildBtcLadderPreview<TSlot extends BtcLadderSlot>(input: {
  referenceOperationalGains: number;
  slots: readonly TSlot[];
}): BtcLadderPreview<TSlot> {
  const { referenceOperationalGains, slots } = input;
  validateInput(referenceOperationalGains, slots);

  const rankingBefore = rankSlots(slots, referenceOperationalGains);
  const state = new Map(slots.map((slot) => [slot.id, { ...slot } as TSlot]));
  const donorIds = rankingBefore
    .filter((slot) => slot.operational_gains > referenceOperationalGains + EPSILON)
    .map((slot) => slot.id);
  const receiverIds = rankingBefore
    .filter((slot) => slot.operational_gains < referenceOperationalGains - EPSILON)
    .map((slot) => slot.id);
  const transfers: BtcLadderTransfer[] = [];

  for (const donorId of donorIds) {
    for (const receiverId of receiverIds) {
      const donor = state.get(donorId);
      const receiver = state.get(receiverId);
      if (!donor || !receiver) continue;

      const donorExcess = round8(donor.operational_gains - referenceOperationalGains);
      const receiverDeficit = round8(referenceOperationalGains - receiver.operational_gains);
      if (donorExcess <= EPSILON) break;
      if (receiverDeficit <= EPSILON) continue;

      const donorCapacityUsdt = gainEquivalentToUsdt(donorExcess, donor.gain_unit_usdt);
      const receiverNeedUsdt = gainEquivalentToUsdt(receiverDeficit, receiver.gain_unit_usdt);
      const amountUsdt = round8(Math.min(donorCapacityUsdt, receiverNeedUsdt));
      if (amountUsdt <= EPSILON) continue;
      if (amountUsdt > donor.operational_value_usdt) {
        throw new BtcLadderDomainError(`Slot ${donor.id}: valor operacional insuficiente para o debito proposto.`);
      }

      const donorGainEquivalent = usdtToGainEquivalent(amountUsdt, donor.gain_unit_usdt);
      const receiverGainEquivalent = usdtToGainEquivalent(amountUsdt, receiver.gain_unit_usdt);
      const donorOperationalAfter = round8(donor.operational_gains - donorGainEquivalent);
      const receiverOperationalAfter = round8(receiver.operational_gains + receiverGainEquivalent);
      const donorValueAfter = round8(donor.operational_value_usdt - amountUsdt);
      const receiverValueAfter = round8(receiver.operational_value_usdt + amountUsdt);

      transfers.push({
        donor_slot_id: donor.id,
        receiver_slot_id: receiver.id,
        donor_status: donor.status,
        receiver_status: receiver.status,
        amount_usdt: amountUsdt,
        debited_usdt: amountUsdt,
        credited_usdt: amountUsdt,
        donor_gain_equivalent: donorGainEquivalent,
        receiver_gain_equivalent: receiverGainEquivalent,
        donor_operational_before: donor.operational_gains,
        donor_operational_after: donorOperationalAfter,
        receiver_operational_before: receiver.operational_gains,
        receiver_operational_after: receiverOperationalAfter,
        donor_value_before_usdt: donor.operational_value_usdt,
        donor_value_after_usdt: donorValueAfter,
        receiver_value_before_usdt: receiver.operational_value_usdt,
        receiver_value_after_usdt: receiverValueAfter
      });

      state.set(donor.id, {
        ...donor,
        operational_gains: donorOperationalAfter,
        operational_value_usdt: donorValueAfter
      });
      state.set(receiver.id, {
        ...receiver,
        operational_gains: receiverOperationalAfter,
        operational_value_usdt: receiverValueAfter
      });
    }
  }

  const slotsAfter = slots.map((slot) => state.get(slot.id) as TSlot);
  const rankingAfter = rankSlots(slotsAfter, referenceOperationalGains);
  const equityBefore = sumOperationalValue(slots);
  const equityAfter = sumOperationalValue(slotsAfter);
  const equityDifference = round8(equityAfter - equityBefore);
  const isConserved = Math.abs(equityDifference) <= EPSILON;
  if (!isConserved) {
    throw new BtcLadderDomainError("A previa nao conservou o patrimonio operacional.");
  }

  const remaining = summarizeRemaining(slotsAfter, referenceOperationalGains);
  return {
    reference_operational_gains: referenceOperationalGains,
    ranking_before: rankingBefore,
    transfers,
    ranking_after: rankingAfter,
    total_transferred_usdt: round8(transfers.reduce((total, transfer) => total + transfer.amount_usdt, 0)),
    equity_before_usdt: equityBefore,
    equity_after_usdt: equityAfter,
    equity_difference_usdt: equityDifference,
    is_conserved: isConserved,
    can_confirm: transfers.length > 0 && isConserved,
    remaining_excess_gains: remaining.excessGains,
    remaining_excess_usdt: remaining.excessUsdt,
    remaining_deficit_gains: remaining.deficitGains,
    remaining_deficit_usdt: remaining.deficitUsdt
  };
}
