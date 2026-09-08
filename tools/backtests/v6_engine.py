"""Motor V6 local: grade V2 fixa e redistribuição somente do excedente mensal."""

from __future__ import annotations

import math
import statistics
from dataclasses import dataclass

from v2_grid_engine import Candle
from v5_engine import V5Config, V5Engine


@dataclass(frozen=True)
class V6Config(V5Config):
    """`monthly_cap=None` desliga a redistribuição e é o controle B do V5."""

    adaptive_ath: bool = False
    redistribute_monthly: bool = False
    monthly_cap: int | None = 3


def gini(values: list[float]) -> float:
    """Coeficiente de Gini para valores não negativos; zero para distribuição uniforme."""

    if not values or all(value == 0 for value in values):
        return 0.0
    ordered = sorted(values)
    total = sum(ordered)
    return sum((2 * index - len(ordered) - 1) * value for index, value in enumerate(ordered, 1)) / (len(ordered) * total)


class V6Engine(V5Engine):
    """Mantém o motor V2; apenas substitui o fechamento mensal de capital."""

    def __init__(self, config: V6Config):
        super().__init__(config)
        self.config: V6Config
        self._days_open_ge_25: set[str] = set()
        self._days_open_ge_40: set[str] = set()
        self._months_as_donor = {slot.slot_id: 0 for slot in self.slots}
        self._months_as_receiver = {slot.slot_id: 0 for slot in self.slots}
        for slot in self.slots:
            slot.real_gains_month = 0
            slot.monthly_received_equivalent = 0.0
            slot.monthly_donated_equivalent = 0.0
            slot.months_as_donor = 0
            slot.months_as_receiver = 0

    def _sell(self, slot, when) -> None:
        before = slot.real_gains
        super()._sell(slot, when)
        if slot.real_gains != before:
            slot.real_gains_month += 1

    def _update_saturation(self, candle: Candle) -> None:
        super()._update_saturation(candle)
        opened = len(self._open())
        if opened >= 25:
            self._days_open_ge_25.add(candle.time.date().isoformat())
        if opened >= 40:
            self._days_open_ge_40.add(candle.time.date().isoformat())

    def _distribution(self) -> dict[str, float]:
        values = [slot.value for slot in self.slots]
        operational = [float(slot.operational_gains) for slot in self.slots]
        mean = statistics.mean(values)
        return {
            "largest_slot": max(values),
            "smallest_slot": min(values),
            "median_slot": statistics.median(values),
            "mean_slot": mean,
            "stddev_slot": statistics.pstdev(values),
            "coefficient_variation": statistics.pstdev(values) / mean if mean else 0.0,
            "gini_slot_value": gini(values),
            "gini_operational_gains": gini(operational),
        }

    def _monthly_equivalent(self, slot) -> float:
        # O ganho real não muda; apenas sua concentração econômica do mês é reduzida
        # quando uma parcela é transferida para outro slot.
        return float(slot.real_gains_month) - float(slot.monthly_donated_equivalent) + float(slot.monthly_received_equivalent)

    def _redistribute_month(self) -> dict[str, float]:
        cap = self.config.monthly_cap
        if cap is None:
            return {
                "monthly_excess_gains": 0.0,
                "redistributed_gain_equivalent": 0.0,
                "redistributed_value": 0.0,
                "locked_monthly_excess": 0.0,
                "unredistributed_monthly_excess": 0.0,
            }

        before = sum(slot.value for slot in self.slots)
        excess_by_slot = {slot.slot_id: max(0, slot.real_gains_month - cap) for slot in self.slots}
        monthly_excess = float(sum(excess_by_slot.values()))
        locked = float(sum(excess_by_slot[slot.slot_id] for slot in self._open()))
        transferred_equiv = transferred_value = 0.0
        month_donors: set[int] = set()
        month_receivers: set[int] = set()

        # Só o excedente REAL deste mês torna-se doável, e somente quando livre no fechamento.
        donors = sorted(
            (slot for slot in self._free() if excess_by_slot[slot.slot_id] > 0),
            key=lambda slot: (-excess_by_slot[slot.slot_id], -slot.operational_gains, -slot.value, slot.slot_id),
        )
        for donor in donors:
            available = excess_by_slot[donor.slot_id]
            # Ordena os recebedores uma vez para este doador e preenche cada um
            # até o teto. Assim, 10/0/0/0 resulta em 3/3/3/1, e 7/2/0 em 3/3/3.
            receivers = sorted(
                (
                    slot
                    for slot in self._free()
                    if slot.slot_id != donor.slot_id and self._monthly_equivalent(slot) < cap
                ),
                key=lambda slot: (
                    self._monthly_equivalent(slot),
                    slot.operational_gains,
                    slot.value,
                    slot.slot_id,
                ),
            )
            for receiver in receivers:
                while available > 0 and self._monthly_equivalent(receiver) < cap:
                    donor_value_before = donor.value
                    receiver_value_before = receiver.value
                    donor_operational_before = donor.operational_gains
                    receiver_operational_before = receiver.operational_gains
                    donor.value /= 1.0 + self.config.gain_rate
                    value = donor_value_before - donor.value
                    receiver.value += value
                    donor.operational_gains -= 1
                    receiver.operational_gains += 1
                    donor.monthly_donated_equivalent += 1.0
                    receiver.monthly_received_equivalent += 1.0
                    donor.donated += value
                    receiver.received += value
                    self.total_redistributed += value
                    transferred_equiv += 1.0
                    transferred_value += value
                    available -= 1
                    excess_by_slot[donor.slot_id] = available
                    month_donors.add(donor.slot_id)
                    month_receivers.add(receiver.slot_id)
                    self.redistributions.append(
                        {
                            "month": self._month,
                            "donor_slot": donor.slot_id,
                            "receiver_slot": receiver.slot_id,
                            "donor_real_gains_month": donor.real_gains_month,
                            "donor_real_gains_total": donor.real_gains,
                            "receiver_real_gains_month": receiver.real_gains_month,
                            "donor_value_before": donor_value_before,
                            "donor_value_after": donor.value,
                            "receiver_value_before": receiver_value_before,
                            "receiver_value_after": receiver.value,
                            "gain_equivalent": 1.0,
                            "value_transferred": value,
                            "donor_operational_before": donor_operational_before,
                            "donor_operational_after": donor.operational_gains,
                            "receiver_operational_before": receiver_operational_before,
                            "receiver_operational_after": receiver.operational_gains,
                        }
                    )

        after = sum(slot.value for slot in self.slots)
        if not math.isclose(before, after, abs_tol=1e-8, rel_tol=1e-12):
            raise AssertionError("redistribuição V6 não conservou valor")
        for slot_id in month_donors:
            self._months_as_donor[slot_id] += 1
        for slot_id in month_receivers:
            self._months_as_receiver[slot_id] += 1
        # Não existe dívida: o que não foi possível redistribuir encerra neste mês.
        unredistributed = monthly_excess - locked - transferred_equiv
        return {
            "monthly_excess_gains": monthly_excess,
            "redistributed_gain_equivalent": transferred_equiv,
            "redistributed_value": transferred_value,
            "locked_monthly_excess": locked,
            "unredistributed_monthly_excess": unredistributed,
        }

    def _close_month(self, candle: Candle) -> None:
        if not self._month_stats:
            return
        redistribution = self._redistribute_month()
        stats = self._month_stats
        equivalents = [self._monthly_equivalent(slot) for slot in self.slots]
        row = {
            "month": stats["month"],
            "real_gains": stats["exits"],
            "entries": stats["entries"],
            "exits": stats["exits"],
            "max_open_slots": stats["max_open"],
            "average_open_slots": stats["open_sum"] / stats["candles"] if stats["candles"] else 0.0,
            "candle_count": stats["candles"],
            "open_slots_end": len(self._open()),
            "cycles": stats["cycles"],
            "equity_start": stats["equity_start"],
            "equity_end": self.equity(candle.close),
            "realized_profit": stats["profit"],
            "realized_profit_total": self.realized_profit,
            "open_pnl": self.open_pnl(candle.close),
            **redistribution,
            "slots_with_0_monthly_equivalent": sum(value == 0 for value in equivalents),
            "slots_with_1": sum(0 < value <= 1 for value in equivalents),
            "slots_with_2": sum(1 < value <= 2 for value in equivalents),
            "slots_with_3_or_more": sum(value > 2 for value in equivalents),
            **self._distribution(),
        }
        self.monthly.append(row)
        for slot in self.slots:
            slot.real_gains_month = 0
            slot.monthly_received_equivalent = 0.0
            slot.monthly_donated_equivalent = 0.0
