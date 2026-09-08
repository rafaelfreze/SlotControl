"""Motor V7 local: aporte mensal proporcional apenas em posições BTC abertas."""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime

from v2_grid_engine import Candle
from v5_engine import EPS, V5Config, V5Engine


@dataclass(frozen=True)
class V7Config(V5Config):
    adaptive_ath: bool = False
    redistribute_monthly: bool = False
    topup_enabled: bool = False
    topup_rate: float = 0.02
    monthly_topup_cap: float = 1000.0


@dataclass
class V7Position:
    level_id: int
    cycle_id: int
    anchor: float
    original_entry_price: float
    average_cost: float
    target: float
    opened_at: datetime
    cost_basis: float
    btc_qty: float

    @property
    def entry(self) -> float:
        """Compatibilidade com o motor de níveis; não muda após aportes."""

        return self.original_entry_price


class V7Engine(V5Engine):
    def __init__(self, config: V7Config, scenario: str):
        super().__init__(config)
        self.config: V7Config
        self.scenario = scenario
        self.cumulative_topups = 0.0
        self.cumulative_btc_bought_from_topups = 0.0
        self.monthly_topups: list[dict] = []
        self.topups_by_slot: list[dict] = []
        self._days_open_80: set[str] = set()

    def _free(self):
        # V7 usa explicitamente gains reais antes do valor operacional.
        return sorted((slot for slot in self.slots if slot.position is None), key=lambda slot: (-slot.real_gains, -slot.value, slot.slot_id))

    def equity(self, price: float) -> float:
        return sum(slot.value for slot in self.slots if slot.position is None) + sum(slot.position.btc_qty * price for slot in self.slots if slot.position)

    def open_pnl(self, price: float) -> float:
        return sum(slot.position.btc_qty * price - slot.position.cost_basis for slot in self.slots if slot.position)

    def btc_holdings(self) -> float:
        return sum(slot.position.btc_qty for slot in self.slots if slot.position)

    def _buy(self, slot, level_id: int, price: float, when: datetime, reason: str) -> None:
        super()._buy(slot, level_id, price, when, reason)
        original = slot.position
        assert original is not None
        slot.position = V7Position(
            level_id=original.level_id,
            cycle_id=original.cycle_id,
            anchor=original.anchor,
            original_entry_price=original.entry,
            average_cost=original.entry,
            target=original.target,
            opened_at=original.opened_at,
            cost_basis=original.value_at_entry,
            btc_qty=original.btc_qty,
        )

    def _sell(self, slot, when: datetime) -> None:
        position: V7Position | None = slot.position
        if position is None:
            return
        proceeds = position.btc_qty * position.target
        profit = proceeds - position.cost_basis
        if not math.isclose(profit, position.cost_basis * self.config.gain_rate, abs_tol=1e-8, rel_tol=1e-12):
            raise AssertionError("venda V7 não respeitou ganho líquido de 1%")
        slot.value = proceeds
        slot.real_gains += 1
        slot.operational_gains += 1
        slot.times_sold += 1
        self.realized_profit += profit
        self.cumulative_btc_sold += position.btc_qty
        del self.open_by_level[position.level_id]
        slot.position = None
        self.trades.append(
            {
                "scenario": self.scenario,
                "cycle_id": self.cycle_id,
                "slot_id": slot.slot_id,
                "grid_level": position.level_id,
                "anchor": position.anchor,
                "entry_timestamp": position.opened_at.isoformat(),
                "entry_price": position.original_entry_price,
                "average_cost_at_sale": position.average_cost,
                "btc_qty": position.btc_qty,
                "cost_basis": position.cost_basis,
                "target_price": position.target,
                "exit_timestamp": when.isoformat(),
                "exit_price": position.target,
                "duration_minutes": (when - position.opened_at).total_seconds() / 60,
                "slot_value_after": slot.value,
                "realized_profit": profit,
                "real_gain_number_slot": slot.real_gains,
                "real_gain_number_global": len(self.trades) + 1,
            }
        )
        if self._month_stats:
            self._month_stats["exits"] += 1
            self._month_stats["profit"] += profit
        self._event("SELL", when, slot_id=slot.slot_id, level_id=position.level_id, level_distance=self.levels[position.level_id].distance, trigger=position.original_entry_price, entry_price=position.original_entry_price, target=position.target, exit_price=position.target, reason="gain_target", open_slots=len(self._open()), armed_before=False, armed_after=False)
        if not self._open():
            self.cycles.append({"scenario": self.scenario, "cycle_id": self.cycle_id, "start": self._cycle_start.isoformat() if self._cycle_start else "", "end": when.isoformat(), "anchor": self.anchor, "trades": sum(1 for trade in self.trades if trade["cycle_id"] == self.cycle_id), "status": "COMPLETE"})
            self.complete_cycles += 1
            if self._month_stats:
                self._month_stats["cycles"] += 1
            self.anchor = None
            self.armed.clear()
            self.pending_cycle = True
        else:
            self.armed.add(position.level_id)
            self._event("REARM", when, slot_id=slot.slot_id, level_id=position.level_id, level_distance=self.levels[position.level_id].distance, trigger=position.original_entry_price, reason="post_sale_rearm", open_slots=len(self._open()), armed_before=False, armed_after=True)

    def _update_saturation(self, candle: Candle) -> None:
        super()._update_saturation(candle)
        if len(self._open()) >= math.ceil(self.config.slots * 0.8):
            self._days_open_80.add(candle.time.date().isoformat())

    def _apply_monthly_topups(self, candle: Candle) -> dict:
        positions = [(slot, slot.position) for slot in self.slots if slot.position is not None]
        total_cost = sum(position.cost_basis for _, position in positions)
        desired_total = total_cost * self.config.topup_rate
        cap = self.config.monthly_topup_cap
        if not self.config.topup_enabled or not positions:
            effective_rate = actual_total = 0.0
        elif desired_total <= cap + EPS:
            effective_rate = self.config.topup_rate
            actual_total = desired_total
        else:
            effective_rate = cap / total_cost
            actual_total = cap
        cap_hit = bool(self.config.topup_enabled and desired_total > cap + EPS)
        total_btc_added = 0.0
        for slot, position in positions:
            desired = position.cost_basis * self.config.topup_rate
            actual = position.cost_basis * effective_rate
            old_average = position.average_cost
            old_cost = position.cost_basis
            old_qty = position.btc_qty
            old_target = position.target
            added_btc = actual / candle.close if actual else 0.0
            position.cost_basis += actual
            position.btc_qty += added_btc
            position.average_cost = position.cost_basis / position.btc_qty
            position.target = position.average_cost * (1.0 + self.config.gain_rate)
            total_btc_added += added_btc
            if actual:
                self.topups_by_slot.append(
                    {
                        "month": self._month,
                        "scenario": self.scenario,
                        "slot_id": slot.slot_id,
                        "cycle_id": position.cycle_id,
                        "grid_level": position.level_id,
                        "original_entry_price": position.original_entry_price,
                        "old_average_cost": old_average,
                        "old_cost_basis": old_cost,
                        "old_btc_qty": old_qty,
                        "market_price": candle.close,
                        "desired_topup": desired,
                        "actual_topup": actual,
                        "effective_rate": effective_rate,
                        "additional_btc": added_btc,
                        "new_btc_qty": position.btc_qty,
                        "new_cost_basis": position.cost_basis,
                        "new_average_cost": position.average_cost,
                        "old_target": old_target,
                        "new_target": position.target,
                        "distance_to_target_before_pct": (old_target / candle.close - 1.0) * 100,
                        "distance_to_target_after_pct": (position.target / candle.close - 1.0) * 100,
                        "distance_reduction_pct_points": (old_target - position.target) / candle.close * 100,
                    }
                )
        if actual_total and not math.isclose(sum(row["actual_topup"] for row in self.topups_by_slot if row["month"] == self._month), actual_total, abs_tol=1e-8, rel_tol=1e-12):
            raise AssertionError("aporte mensal V7 não fechou por slot")
        self.cumulative_topups += actual_total
        self.cumulative_btc_bought_from_topups += total_btc_added
        result = {
            "month": self._month,
            "scenario": self.scenario,
            "open_slots": len(positions),
            "total_open_cost_before": total_cost,
            "desired_rate": self.config.topup_rate,
            "desired_total": desired_total,
            "monthly_cap": cap,
            "effective_rate": effective_rate,
            "actual_total": actual_total,
            "cap_hit": cap_hit,
            "btc_price": candle.close,
            "total_btc_added": total_btc_added,
            "total_open_cost_after": total_cost + actual_total,
        }
        self.monthly_topups.append(result)
        return result

    def _close_month(self, candle: Candle) -> None:
        if not self._month_stats:
            return
        topup = self._apply_monthly_topups(candle)
        stats = self._month_stats
        self.monthly.append(
            {
                "month": stats["month"],
                "scenario": self.scenario,
                "entries": stats["entries"],
                "exits": stats["exits"],
                "real_gains": stats["exits"],
                "max_open_slots": stats["max_open"],
                "average_open_slots": stats["open_sum"] / stats["candles"] if stats["candles"] else 0.0,
                "candle_count": stats["candles"],
                "open_slots_end": len(self._open()),
                "cycles": stats["cycles"],
                "equity_start": stats["equity_start"],
                "topup_usdt": topup["actual_total"],
                "cumulative_topup_usdt": self.cumulative_topups,
                "cap_hit": topup["cap_hit"],
                "effective_topup_rate": topup["effective_rate"],
                "realized_profit": stats["profit"],
                "realized_profit_total": self.realized_profit,
                "unrealized_pnl": self.open_pnl(candle.close),
                "equity_end": self.equity(candle.close),
                "btc_holdings_end": self.btc_holdings(),
            }
        )
