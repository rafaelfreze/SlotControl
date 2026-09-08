"""Motor local: meta acumulada 7/mês, equalização com doadores inclusive abertos."""

from __future__ import annotations

import math
import statistics
from dataclasses import dataclass
from datetime import datetime

from v2_grid_engine import Candle
from v5_engine import EPS, V5Config, V5Engine


@dataclass(frozen=True)
class Meta7Config(V5Config):
    slots: int = 25
    adaptive_ath: bool = False
    redistribute_monthly: bool = False
    gains_per_month: int = 7
    equalize: bool = False


@dataclass
class DebitPosition:
    level_id: int
    cycle_id: int
    anchor: float
    entry: float
    target: float
    opened_at: datetime
    value_at_entry: float
    btc_qty: float
    redistribution_debit_balance: float = 0.0


class Meta7EqualizationEngine(V5Engine):
    """Trading V2 inalterado; equalização ocorre após o último candle UTC do mês."""

    def __init__(self, config: Meta7Config, scenario: str):
        super().__init__(config)
        self.config: Meta7Config
        self.scenario = scenario
        self.cumulative_topup = 0.0
        self.total_redistributed = 0.0
        self.total_debited_open_positions = 0.0
        self.redistributions: list[dict] = []
        self.external_topups: list[dict] = []
        self._month_number = 0

    def _free(self):
        # Um saldo liquidado negativo não é apto para uma nova compra.
        return sorted((slot for slot in self.slots if slot.position is None and slot.value > EPS), key=lambda slot: (-slot.operational_gains, -slot.value, slot.slot_id))

    def equity(self, price: float) -> float:
        free = sum(slot.value for slot in self.slots if slot.position is None)
        opened = sum(slot.position.btc_qty * price - slot.position.redistribution_debit_balance for slot in self.slots if slot.position)
        return free + opened

    def open_pnl(self, price: float) -> float:
        return sum(slot.position.btc_qty * price - slot.position.value_at_entry - slot.position.redistribution_debit_balance for slot in self.slots if slot.position)

    def _buy(self, slot, level_id: int, price: float, when: datetime, reason: str) -> None:
        super()._buy(slot, level_id, price, when, reason)
        base = slot.position
        assert base is not None
        slot.position = DebitPosition(base.level_id, base.cycle_id, base.anchor, base.entry, base.target, base.opened_at, base.value_at_entry, base.btc_qty)

    def _sell(self, slot, when: datetime) -> None:
        position: DebitPosition | None = slot.position
        if position is None:
            return
        gross_proceeds = position.btc_qty * position.target
        realized = gross_proceeds - position.value_at_entry
        settled_value = gross_proceeds - position.redistribution_debit_balance
        if not math.isclose(realized, position.value_at_entry * self.config.gain_rate, abs_tol=1e-8, rel_tol=1e-12):
            raise AssertionError("venda não respeitou 1% líquido")
        slot.value = settled_value
        slot.real_gains += 1
        slot.operational_gains += 1
        slot.times_sold += 1
        self.realized_profit += realized
        self.cumulative_btc_sold += position.btc_qty
        del self.open_by_level[position.level_id]
        slot.position = None
        self.trades.append({"scenario": self.scenario, "cycle_id": self.cycle_id, "slot_id": slot.slot_id, "grid_level": position.level_id, "anchor": position.anchor, "entry_timestamp": position.opened_at.isoformat(), "entry_price": position.entry, "btc_qty": position.btc_qty, "cost_basis": position.value_at_entry, "target_price": position.target, "exit_timestamp": when.isoformat(), "exit_price": position.target, "duration_minutes": (when-position.opened_at).total_seconds()/60, "gross_proceeds": gross_proceeds, "debit_settled": position.redistribution_debit_balance, "slot_value_after": settled_value, "realized_profit": realized, "real_gain_number_slot": slot.real_gains, "real_gain_number_global": len(self.trades)+1})
        if self._month_stats:
            self._month_stats["exits"] += 1; self._month_stats["profit"] += realized
        self._event("SELL", when, slot_id=slot.slot_id, level_id=position.level_id, level_distance=self.levels[position.level_id].distance, trigger=position.entry, entry_price=position.entry, target=position.target, exit_price=position.target, reason="gain_target", open_slots=len(self._open()), armed_before=False, armed_after=False)
        if not self._open():
            self.cycles.append({"scenario": self.scenario, "cycle_id": self.cycle_id, "start": self._cycle_start.isoformat() if self._cycle_start else "", "end": when.isoformat(), "anchor": self.anchor, "trades": sum(1 for row in self.trades if row["cycle_id"]==self.cycle_id), "status":"COMPLETE"})
            self.complete_cycles += 1
            if self._month_stats: self._month_stats["cycles"] += 1
            self.anchor=None; self.armed.clear(); self.pending_cycle=True
        else:
            self.armed.add(position.level_id)
            self._event("REARM", when, slot_id=slot.slot_id, level_id=position.level_id, level_distance=self.levels[position.level_id].distance, trigger=position.entry, reason="post_sale_rearm", open_slots=len(self._open()), armed_before=False, armed_after=True)

    def _transfer_one(self, donor, receiver, target: int) -> float:
        donor_before = donor.operational_gains; receiver_before = receiver.operational_gains
        donor_value_before = donor.value
        donor.value /= 1.0 + self.config.gain_rate
        transferred = donor_value_before - donor.value
        donor.operational_gains -= 1
        receiver.value += transferred
        receiver.operational_gains += 1
        donor_open = donor.position is not None
        if donor_open:
            donor.position.redistribution_debit_balance += transferred
            self.total_debited_open_positions += transferred
        donor.donated += transferred; receiver.received += transferred
        self.total_redistributed += transferred
        self.redistributions.append({"month": self._month, "donor_slot": donor.slot_id, "donor_status": "OPEN" if donor_open else "FREE", "receiver_slot": receiver.slot_id, "target": target, "donor_real_gains": donor.real_gains, "donor_operational_before": donor_before, "donor_operational_after": donor.operational_gains, "receiver_operational_before": receiver_before, "receiver_operational_after": receiver.operational_gains, "gain_equivalent": 1.0, "value_transferred": transferred, "donor_debit_balance_after": donor.position.redistribution_debit_balance if donor_open else 0.0})
        return transferred

    def _equalize(self, target: int) -> dict:
        if not self.config.equalize:
            return {"donors":0,"open_donors":0,"receivers":0,"redistributed_value":0.0,"redistributed_gain_equivalent":0.0}
        before = self.equity(self._last_candle.close)
        donors = sorted((slot for slot in self.slots if slot.operational_gains > target), key=lambda slot: (-(slot.operational_gains-target), -slot.value, slot.slot_id))
        receivers_used: set[int] = set(); open_donors: set[int] = set(); moved=value=0.0
        for donor in donors:
            if donor.position: open_donors.add(donor.slot_id)
            while donor.operational_gains > target:
                receivers = [slot for slot in self._free() if slot.slot_id != donor.slot_id and slot.operational_gains < target]
                if not receivers: break
                receiver = sorted(receivers, key=lambda slot: (-slot.operational_gains, -slot.value, slot.slot_id))[0]
                value += self._transfer_one(donor, receiver, target); moved += 1.0; receivers_used.add(receiver.slot_id)
        after = self.equity(self._last_candle.close)
        if not math.isclose(before, after, abs_tol=1e-8, rel_tol=1e-12): raise AssertionError("equalização não conservou patrimônio")
        return {"donors":len(donors),"open_donors":len(open_donors),"receivers":len(receivers_used),"redistributed_value":value,"redistributed_gain_equivalent":moved}

    def _external_topup(self, target: int) -> dict:
        eligible = [slot for slot in self._free() if slot.operational_gains < target]
        if not self.config.equalize or not eligible:
            return {"slot_id":"", "operational_before":"", "missing_gains":0, "value_before":0.0, "topup_value":0.0, "value_after":0.0}
        slot = sorted(eligible, key=lambda item: (-item.operational_gains, -item.value, item.slot_id))[0]
        before = slot.value; missing = target-slot.operational_gains; after = before*(1.01**missing); topup=after-before
        slot.value=after; slot.operational_gains=target; self.cumulative_topup += topup
        row={"month":self._month,"target":target,"slot_id":slot.slot_id,"operational_before":target-missing,"missing_gains":missing,"value_before":before,"topup_value":topup,"value_after":after}
        self.external_topups.append(row)
        return {**row}

    def _close_month(self, candle: Candle) -> None:
        if not self._month_stats: return
        self._month_number += 1; target=self._month_number*self.config.gains_per_month
        equal=self._equalize(target); topup=self._external_topup(target)
        stats=self._month_stats
        self.monthly.append({"month":stats["month"],"target":target,"real_gains_month":stats["exits"],"real_gains_total":len(self.trades),**equal,"external_topup":topup["topup_value"],"cumulative_topup":self.cumulative_topup,"slots_at_target":sum(slot.operational_gains==target for slot in self.slots),"slots_below_target":sum(slot.operational_gains<target for slot in self.slots),"slots_above_target_after":sum(slot.operational_gains>target for slot in self.slots),"equity_end":self.equity(candle.close),"open_slots":len(self._open()),"realized_profit":stats["profit"],"realized_profit_total":self.realized_profit,"open_pnl":self.open_pnl(candle.close),"candle_count":stats["candles"]})
