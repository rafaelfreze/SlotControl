"""V4: V2 de trading + V3 de redistribuição + teto mensal de aporte."""

from __future__ import annotations

import math

from v2_grid_engine import Candle, GridConfig, RecyclableLinearGridEngine, Slot, slot_priority


class CappedContributionEngine(RecyclableLinearGridEngine):
    def __init__(self, config: GridConfig, monthly_brl_cap: float, fx_by_month: dict[str, float], use_reserve: bool = True):
        super().__init__(config, "heuristic")
        self.monthly_brl_cap, self.fx_by_month, self.use_reserve = monthly_brl_cap, fx_by_month, use_reserve
        self.reserve_value = 0.0
        self.reserve_gain_equivalent = 0.0
        self.redistributions: list[dict] = []
        self.total_received = {slot.slot_id: 0.0 for slot in self.slots}
        self.total_donated = {slot.slot_id: 0.0 for slot in self.slots}
        self.months_at_target = {slot.slot_id: 0 for slot in self.slots}
        self.cumulative_btc_bought = 0.0
        self.cumulative_btc_sold = 0.0

    def _buy(self, slot: Slot, level: int, price: float, when, reason: str) -> None:
        super()._buy(slot, level, price, when, reason)
        assert slot.position is not None
        self.cumulative_btc_bought += slot.position.btc_qty

    def _sell(self, slot: Slot, when) -> None:
        if slot.position:
            self.cumulative_btc_sold += slot.position.btc_qty
        super()._sell(slot, when)

    def current_btc_holdings(self) -> float:
        return sum(slot.position.btc_qty for slot in self.slots if slot.position)

    def _free(self) -> list[Slot]:
        return sorted((slot for slot in self.slots if slot.position is None), key=slot_priority)

    def _receiver(self, target: float) -> Slot | None:
        below = [slot for slot in self._free() if slot.operational_gains < target - 1e-12]
        return below[0] if below else None

    def _record_transfer(self, month: str, donor, receiver, donor_before, donor_after, receiver_before, receiver_after, equivalent: float, value: float, donor_real) -> None:
        self.redistributions.append({"month": month, "donor_slot": donor.slot_id if isinstance(donor, Slot) else donor, "receiver_slot": receiver.slot_id if isinstance(receiver, Slot) else receiver, "donor_real_gains": donor_real, "donor_operational_before": donor_before, "donor_operational_after": donor_after, "receiver_operational_before": receiver_before, "receiver_operational_after": receiver_after, "gain_equivalent_transferred": equivalent, "value_transferred": value})

    def _transfer_from_donor(self, donor: Slot, amount_gains: float) -> float:
        if donor.position is not None:
            raise AssertionError("slot aberto não pode doar")
        before = donor.value
        donor.value = before / math.pow(1.0 + self.config.gain_rate, amount_gains)
        donor.operational_gains -= amount_gains
        return before - donor.value

    def _redistribute(self, target: float, month: str) -> tuple[float, float, set[int], set[int]]:
        transferred_equiv = transferred_value = 0.0
        donors: set[int] = set()
        receivers: set[int] = set()
        donor_list = sorted((slot for slot in self._free() if slot.operational_gains > target + 1e-12), key=slot_priority)
        for donor in donor_list:
            while donor.operational_gains > target + 1e-12:
                receiver = self._receiver(target)
                if receiver is None and not self.use_reserve:
                    break
                excess = donor.operational_gains - target
                capacity = (target - receiver.operational_gains) if receiver else excess
                equivalent = min(excess, capacity, 1.0)
                before = donor.operational_gains
                value = self._transfer_from_donor(donor, equivalent)
                donors.add(donor.slot_id)
                self.total_donated[donor.slot_id] += value
                transferred_equiv += equivalent
                transferred_value += value
                if receiver is None:
                    self.reserve_value += value
                    self.reserve_gain_equivalent += equivalent
                    self._record_transfer(month, donor, "GROWTH_RESERVE", before, donor.operational_gains, "", "", equivalent, value, donor.real_gains)
                else:
                    receiver_before = receiver.operational_gains
                    receiver.operational_gains += equivalent
                    receiver.value += value
                    receivers.add(receiver.slot_id)
                    self.total_received[receiver.slot_id] += value
                    self._record_transfer(month, donor, receiver, before, donor.operational_gains, receiver_before, receiver.operational_gains, equivalent, value, donor.real_gains)
        return transferred_equiv, transferred_value, donors, receivers

    def _apply_reserve(self, target: float, month: str) -> tuple[float, float, set[int]]:
        used_value = used_equiv = 0.0
        receivers: set[int] = set()
        if not self.use_reserve:
            return used_value, used_equiv, receivers
        while self.reserve_gain_equivalent > 1e-12:
            receiver = self._receiver(target)
            if receiver is None:
                break
            equivalent = min(self.reserve_gain_equivalent, target - receiver.operational_gains, 1.0)
            amount = self.reserve_value if equivalent >= self.reserve_gain_equivalent - 1e-12 else self.reserve_value * equivalent / self.reserve_gain_equivalent
            before = receiver.operational_gains
            self.reserve_value -= amount
            self.reserve_gain_equivalent -= equivalent
            receiver.value += amount
            receiver.operational_gains += equivalent
            self.total_received[receiver.slot_id] += amount
            receivers.add(receiver.slot_id)
            used_value += amount
            used_equiv += equivalent
            self._record_transfer(month, "GROWTH_RESERVE", receiver, "", "", before, receiver.operational_gains, equivalent, amount, "")
        if self.reserve_gain_equivalent <= 1e-12:
            self.reserve_gain_equivalent = self.reserve_value = 0.0
        return used_value, used_equiv, receivers

    def _close_month(self, candle: Candle) -> None:
        if self._month is None:
            return
        month = self._month
        target = float(self._month_number * self.config.monthly_target)
        usd_brl = self.fx_by_month[month]
        cap_usdt = self.monthly_brl_cap / usd_brl
        reserve_before = self.reserve_value
        equity_before = self._equity_at(candle.close) + self.reserve_value
        conserved_before = sum(slot.value for slot in self.slots) + self.reserve_value
        eq_transferred, value_transferred, donors, receivers = self._redistribute(target, month)
        reserve_used_value, reserve_used_eq, reserve_receivers = self._apply_reserve(target, month)
        receivers.update(reserve_receivers)
        conserved_after = sum(slot.value for slot in self.slots) + self.reserve_value
        if not math.isclose(conserved_before, conserved_after, abs_tol=1e-9, rel_tol=1e-12):
            raise AssertionError("redistribuição criou/destruiu patrimônio")
        free = self._free()
        leader = free[0] if free else None
        actual = required = unused = gain_added = 0.0
        hit_cap = False
        reason = "NO_FREE_SLOT" if leader is None else "TARGET_ALREADY_MET" if any(slot.operational_gains >= target - 1e-12 for slot in free) else ""
        leader_before = leader.operational_gains if leader else ""
        value_before = leader.value if leader else ""
        if leader is not None and not reason:
            missing = target - leader.operational_gains
            required = leader.value * (math.pow(1.0 + self.config.gain_rate, missing) - 1.0)
            actual = min(required, cap_usdt)
            hit_cap = actual >= cap_usdt - 1e-10 and required > actual + 1e-10
            new_value = leader.value + actual
            gain_added = math.log(new_value / leader.value) / math.log(1.0 + self.config.gain_rate) if actual else 0.0
            leader.value = new_value
            leader.operational_gains += gain_added
            if actual >= required - 1e-10:
                leader.operational_gains = target
            leader.total_topup += actual
            unused = required - actual
            reason = "APPLIED_CAPPED" if hit_cap else "APPLIED_FULL"
        if actual * usd_brl > self.monthly_brl_cap + 1e-7:
            raise AssertionError("teto mensal BRL excedido")
        self.topups.append({"month": month, "target": target, "usd_brl": usd_brl, "cap_brl": self.monthly_brl_cap, "cap_usdt": cap_usdt, "slot_id": leader.slot_id if leader else "NO_FREE_SLOT", "operational_before": leader_before, "required_topup_usdt": required, "actual_topup_usdt": actual, "unused_required_usdt": unused, "value_before": value_before, "value_after": leader.value if leader else "", "gain_equivalent_added": gain_added, "hit_cap": hit_cap, "reason": reason})
        if leader:
            leader.months_as_leader += 1
        at_target = [slot for slot in self.slots if slot.operational_gains >= target - 1e-10]
        for slot in at_target:
            self.months_at_target[slot.slot_id] += 1
        locked_excess = sum(max(0.0, slot.operational_gains - target) for slot in self.slots if slot.position)
        self.monthly.append({"month": month, "target": target, "usd_brl": usd_brl, "cap_brl": self.monthly_brl_cap, "cap_usdt": cap_usdt, "real_gains_month": len(self.trades) - self._month_start_trades, "real_gains_total": len(self.trades), "free_slots": len(free), "open_slots": len(self._open()), "donor_slots": len(donors), "receiver_slots": len(receivers), "excess_gain_equivalent": eq_transferred, "redistributed_value": value_transferred, "reserve_before": reserve_before, "reserve_used": reserve_used_value, "reserve_after": self.reserve_value, "leader_slot": leader.slot_id if leader else "NO_FREE_SLOT", "leader_operational_before": leader_before, "leader_operational_after": leader.operational_gains if leader else "", "required_topup_usdt": required, "external_topup": actual, "unused_required_usdt": unused, "hit_cap": hit_cap, "equity_before": equity_before, "equity_after": self._equity_at(candle.close) + self.reserve_value, "slots_at_target": len(at_target), "locked_excess_gain_equivalent": locked_excess})
