"""Política V3 de meta mensal com redistribuição financeira conservativa."""

from __future__ import annotations

import math
from dataclasses import dataclass

from v2_grid_engine import Candle, GridConfig, RecyclableLinearGridEngine, Slot, slot_priority


@dataclass
class GrowthReserve:
    value: float = 0.0
    gain_equivalent: int = 0


class RedistributionTargetEngine(RecyclableLinearGridEngine):
    """Motor V2 inalterado no trading; somente substitui o fechamento mensal."""

    def __init__(self, config: GridConfig, use_reserve: bool = True):
        super().__init__(config, "heuristic")
        self.use_reserve = use_reserve
        self.reserve = GrowthReserve()
        self.redistributions: list[dict] = []
        self.total_received = {slot.slot_id: 0.0 for slot in self.slots}
        self.total_donated = {slot.slot_id: 0.0 for slot in self.slots}
        self.months_at_target = {slot.slot_id: 0 for slot in self.slots}

    def _free_ordered(self) -> list[Slot]:
        return sorted((slot for slot in self.slots if slot.position is None), key=slot_priority)

    def _receiver(self, target: int) -> Slot | None:
        candidates = [slot for slot in self._free_ordered() if slot.operational_gains < target]
        return candidates[0] if candidates else None

    def _record_transfer(self, month: str, donor: Slot | str, receiver: Slot | str, donor_before: int | str, donor_after: int | str, receiver_before: int | str, receiver_after: int | str, value: float, real_gains: int | str) -> None:
        self.redistributions.append({
            "month": month,
            "donor_slot": donor.slot_id if isinstance(donor, Slot) else donor,
            "receiver_slot": receiver.slot_id if isinstance(receiver, Slot) else receiver,
            "donor_real_gains": real_gains,
            "donor_operational_before": donor_before,
            "donor_operational_after": donor_after,
            "receiver_operational_before": receiver_before,
            "receiver_operational_after": receiver_after,
            "gain_equivalent_transferred": 1,
            "value_transferred": value,
        })

    def _shave_one_gain(self, donor: Slot) -> float:
        """Remove um gain operacional do doador e retorna o capital correspondente."""
        if donor.position is not None:
            raise AssertionError("slot aberto não pode doar redistribuição")
        if donor.operational_gains <= 0:
            raise AssertionError("não há gain operacional para transferir")
        before = donor.value
        donor.value = before / (1.0 + self.config.gain_rate)
        donor.operational_gains -= 1
        return before - donor.value

    def _take_free_excess(self, target: int, month: str) -> tuple[int, float, set[int], set[int]]:
        donor_ids: set[int] = set()
        receiver_ids: set[int] = set()
        value_total = 0.0
        equivalents = 0
        # Ordem determinística dos doadores: maior excedente/gain, valor, número.
        donors = sorted((slot for slot in self._free_ordered() if slot.operational_gains > target), key=slot_priority)
        for donor in donors:
            while donor.operational_gains > target:
                receiver = self._receiver(target)
                if receiver is None and not self.use_reserve:
                    # Sem reserva, excedente sem destino continua no doador; patrimônio não é queimado.
                    break
                donor_before = donor.operational_gains
                value = self._shave_one_gain(donor)
                donor_ids.add(donor.slot_id)
                self.total_donated[donor.slot_id] += value
                value_total += value
                equivalents += 1
                if receiver is None:
                    self.reserve.value += value
                    self.reserve.gain_equivalent += 1
                    self._record_transfer(month, donor, "GROWTH_RESERVE", donor_before, donor.operational_gains, "", "", value, donor.real_gains)
                else:
                    receiver_before = receiver.operational_gains
                    receiver.value += value
                    receiver.operational_gains += 1
                    receiver_ids.add(receiver.slot_id)
                    self.total_received[receiver.slot_id] += value
                    self._record_transfer(month, donor, receiver, donor_before, donor.operational_gains, receiver_before, receiver.operational_gains, value, donor.real_gains)
        return equivalents, value_total, donor_ids, receiver_ids

    def _use_reserve(self, target: int, month: str) -> tuple[float, set[int]]:
        if not self.use_reserve or self.reserve.gain_equivalent <= 0:
            return 0.0, set()
        used = 0.0
        receiver_ids: set[int] = set()
        while self.reserve.gain_equivalent > 0:
            receiver = self._receiver(target)
            if receiver is None:
                break
            before = receiver.operational_gains
            amount = self.reserve.value if self.reserve.gain_equivalent == 1 else self.reserve.value / self.reserve.gain_equivalent
            self.reserve.value -= amount
            self.reserve.gain_equivalent -= 1
            receiver.value += amount
            receiver.operational_gains += 1
            receiver_ids.add(receiver.slot_id)
            self.total_received[receiver.slot_id] += amount
            used += amount
            self._record_transfer(month, "GROWTH_RESERVE", receiver, "", "", before, receiver.operational_gains, amount, "")
        if self.reserve.gain_equivalent == 0:
            # O último lançamento usa o saldo completo, evitando resíduo financeiro artificial.
            self.reserve.value = 0.0
        return used, receiver_ids

    def _close_month(self, candle: Candle) -> None:
        if self._month is None:
            return
        target = self._month_number * self.config.monthly_target
        free = self._free_ordered()
        reserve_before = self.reserve.value
        equity_before = self._equity_at(candle.close) + reserve_before
        operational_before = sum(slot.value for slot in self.slots) + self.reserve.value
        excess_equiv, redistributed_value, donors, receivers = self._take_free_excess(target, self._month)
        reserve_used, reserve_receivers = self._use_reserve(target, self._month)
        receivers.update(reserve_receivers)
        operational_after_redistribution = sum(slot.value for slot in self.slots) + self.reserve.value
        if not math.isclose(operational_before, operational_after_redistribution, abs_tol=1e-9, rel_tol=1e-12):
            raise AssertionError("redistribuição/reserva alterou o patrimônio operacional")

        free = self._free_ordered()
        topup = 0.0
        missing: int | str = ""
        leader = free[0] if free else None
        leader_before: int | str = leader.operational_gains if leader else ""
        reason = "TARGET_ALREADY_MET" if any(slot.operational_gains >= target for slot in free) else ""
        if not free:
            reason = "NO_FREE_SLOT"
            self.topups.append({"month": self._month, "target": target, "slot_id": "NO_FREE_SLOT", "operational_gains_before": "", "missing_gains": "", "value_before": "", "topup": 0.0, "value_after": "", "reason": reason})
        elif not reason:
            assert leader is not None
            missing = target - leader.operational_gains
            value_before = leader.value
            factor = math.pow(1.0 + self.config.gain_rate, missing)
            topup = value_before * (factor - 1.0)
            leader.value += topup
            leader.operational_gains = target
            leader.total_topup += topup
            reason = "APPLIED"
            self.topups.append({"month": self._month, "target": target, "slot_id": leader.slot_id, "operational_gains_before": leader_before, "missing_gains": missing, "value_before": value_before, "topup": topup, "value_after": leader.value, "reason": reason})
        else:
            self.topups.append({"month": self._month, "target": target, "slot_id": leader.slot_id if leader else "NO_FREE_SLOT", "operational_gains_before": leader_before, "missing_gains": "", "value_before": leader.value if leader else "", "topup": 0.0, "value_after": leader.value if leader else "", "reason": reason})
        if leader is not None:
            leader.months_as_leader += 1
        at_target_ids = {slot.slot_id for slot in self.slots if slot.operational_gains >= target}
        for slot_id in at_target_ids:
            self.months_at_target[slot_id] += 1
        locked_excess = sum(max(0, slot.operational_gains - target) for slot in self.slots if slot.position is not None)
        self.monthly.append({
            "month": self._month,
            "target": target,
            "real_gains_month": len(self.trades) - self._month_start_trades,
            "real_gains_total": len(self.trades),
            "free_slots": len(free),
            "open_slots": len(self._open()),
            "donor_slots": len(donors),
            "receiver_slots": len(receivers),
            "excess_gain_equivalent": excess_equiv,
            "redistributed_value": redistributed_value,
            "reserve_before": reserve_before,
            "reserve_used": reserve_used,
            "reserve_after": self.reserve.value,
            "leader_slot": leader.slot_id if leader else "NO_FREE_SLOT",
            "leader_operational_before": leader_before,
            "leader_operational_after": leader.operational_gains if leader else "",
            "external_missing_gains": missing,
            "external_topup": topup,
            "equity_before": equity_before,
            "equity_after": self._equity_at(candle.close) + self.reserve.value,
            "locked_excess_gain_equivalent": locked_excess,
            "slots_at_target": len(at_target_ids),
        })
