"""Motor V5 local: BTC, 50 slots, ATH sem lookahead e redistribuição sem aporte."""

from __future__ import annotations

import math
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime
from typing import Iterable

from v2_grid_engine import Candle, EPS


@dataclass(frozen=True)
class V5Config:
    slots: int = 50
    initial_value: float = 10.0
    gain_rate: float = 0.01
    adaptive_ath: bool = True
    redistribute_monthly: bool = False
    operational_cap: int = 3


@dataclass
class GridLevel:
    level_id: int
    distance: float
    trigger: float
    regime_created: str


@dataclass
class Position:
    level_id: int
    cycle_id: int
    anchor: float
    entry: float
    target: float
    opened_at: datetime
    value_at_entry: float

    @property
    def btc_qty(self) -> float:
        return self.value_at_entry / self.entry


@dataclass
class Slot:
    slot_id: int
    value: float
    real_gains: int = 0
    operational_gains: int = 0
    position: Position | None = None
    times_bought: int = 0
    times_sold: int = 0
    received: float = 0.0
    donated: float = 0.0


class V5Engine:
    """Grade incremental: níveis já criados são imutáveis; novos usam o regime atual."""

    def __init__(self, config: V5Config):
        self.config = config
        self.slots = [Slot(index, config.initial_value) for index in range(1, config.slots + 1)]
        self.ath = 0.0
        self.anchor: float | None = None
        self.cycle_id = 0
        self.pending_cycle = False
        self.levels: dict[int, GridLevel] = {}
        self.armed: set[int] = set()
        self.open_by_level: dict[int, Slot] = {}
        self.events: list[dict] = []
        self.trades: list[dict] = []
        self.cycles: list[dict] = []
        self.monthly: list[dict] = []
        self.redistributions: list[dict] = []
        self.max_open_slots = 0
        self.complete_cycles = 0
        self.realized_profit = 0.0
        self.cumulative_btc_bought = 0.0
        self.cumulative_btc_sold = 0.0
        self.total_redistributed = 0.0
        self._month: str | None = None
        self._month_stats: dict | None = None
        self._last_candle: Candle | None = None
        self._last_close: float | None = None
        self._days_at_full: set[str] = set()
        self._saturation_active: dict[int, dict | None] = {25: None, 40: None, config.slots: None}
        self.saturation: list[dict] = []
        self._cycle_start: datetime | None = None
        self._cycle_start_price = 0.0
        self._crashes: dict[str, dict] = {}

    def _free(self) -> list[Slot]:
        return sorted((slot for slot in self.slots if slot.position is None), key=lambda slot: (-slot.operational_gains, -slot.value, slot.slot_id))

    def _open(self) -> list[Slot]:
        return [slot for slot in self.slots if slot.position is not None]

    def equity(self, price: float) -> float:
        return sum(slot.value for slot in self.slots if slot.position is None) + sum(slot.position.value_at_entry * price / slot.position.entry for slot in self.slots if slot.position)

    def open_pnl(self, price: float) -> float:
        return sum(slot.position.value_at_entry * (price / slot.position.entry - 1.0) for slot in self.slots if slot.position)

    def btc_holdings(self) -> float:
        return sum(slot.position.btc_qty for slot in self.slots if slot.position)

    def regime_for_price(self, price: float, ath: float | None = None) -> str:
        observed_ath = self.ath if ath is None else ath
        if not self.config.adaptive_ath or observed_ath <= 0:
            return "FIXED_2"
        distance = price / observed_ath - 1.0
        if distance >= -0.20 - EPS:
            return "TOPO_4"
        if distance >= -0.40 - EPS:
            return "MEIO_2"
        return "FUNDO_2"

    def _spacing_for_next_level(self, last_distance: float) -> tuple[float, str]:
        if not self.config.adaptive_ath:
            return 0.02, "FIXED_2"
        assert self.anchor is not None
        # Tenta 4%; se esse próximo nível já cair fora do topo, continua com 2%
        # a partir da última fronteira. Isso preserva níveis já criados e evita salto.
        candidate_4 = last_distance + 0.04
        candidate_price = self.anchor * (1.0 - candidate_4)
        regime = self.regime_for_price(candidate_price)
        return (0.04, regime) if regime == "TOPO_4" else (0.02, regime)

    def _ensure_deeper_levels(self, end: float) -> None:
        assert self.anchor is not None
        while len(self.levels) < self.config.slots:
            last = self.levels[max(self.levels)]
            spacing, regime = self._spacing_for_next_level(last.distance)
            distance = last.distance + spacing
            trigger = self.anchor * (1.0 - distance)
            if trigger <= EPS or trigger < end - EPS:
                return
            level = GridLevel(last.level_id + 1, distance, trigger, regime)
            self.levels[level.level_id] = level
            self.armed.add(level.level_id)

    def _event(self, kind: str, when: datetime, **values) -> None:
        self.events.append({"timestamp": when.isoformat(), "event": kind, "cycle_id": self.cycle_id, "anchor": self.anchor, "ath": self.ath, **values})

    def _start_cycle(self, price: float, when: datetime) -> None:
        leader = self._free()[0]
        self.cycle_id += 1
        self.anchor = price
        self.levels = {0: GridLevel(0, 0.0, price, self.regime_for_price(price))}
        self.armed = {0}
        self.open_by_level = {}
        self.pending_cycle = False
        self._cycle_start = when
        self._cycle_start_price = price
        self._buy(leader, 0, price, when, "cycle_market_entry")

    def _buy(self, slot: Slot, level_id: int, price: float, when: datetime, reason: str) -> None:
        if slot.position is not None or level_id in self.open_by_level or level_id not in self.armed:
            raise AssertionError("entrada inválida: slot/nivel não disponível")
        level = self.levels[level_id]
        if not math.isclose(level.trigger, price, abs_tol=1e-8):
            raise AssertionError("entrada fora do trigger criado")
        position = Position(level_id, self.cycle_id, self.anchor or price, price, price * (1.0 + self.config.gain_rate), when, slot.value)
        slot.position = position
        slot.times_bought += 1
        self.open_by_level[level_id] = slot
        self.armed.remove(level_id)
        self.cumulative_btc_bought += position.btc_qty
        self.max_open_slots = max(self.max_open_slots, len(self._open()))
        if self._month_stats:
            self._month_stats["entries"] += 1
            self._month_stats["max_open"] = max(self._month_stats["max_open"], len(self._open()))
        self._event("BUY", when, slot_id=slot.slot_id, level_id=level_id, level_distance=level.distance, trigger=price, entry_price=price, target=position.target, reason=reason, open_slots=len(self._open()), armed_before=True, armed_after=False)

    def _sell(self, slot: Slot, when: datetime) -> None:
        position = slot.position
        if position is None:
            return
        before = slot.value
        slot.value *= 1.0 + self.config.gain_rate
        slot.real_gains += 1
        slot.operational_gains += 1
        slot.times_sold += 1
        self.realized_profit += slot.value - before
        self.cumulative_btc_sold += position.btc_qty
        del self.open_by_level[position.level_id]
        slot.position = None
        self.trades.append({"cycle_id": self.cycle_id, "slot_id": slot.slot_id, "grid_level": position.level_id, "anchor": position.anchor, "entry_timestamp": position.opened_at.isoformat(), "entry_price": position.entry, "btc_qty": position.btc_qty, "target_price": position.target, "exit_timestamp": when.isoformat(), "exit_price": position.target, "duration_minutes": (when - position.opened_at).total_seconds() / 60, "slot_value_before": before, "slot_value_after": slot.value, "real_gain_number_slot": slot.real_gains, "real_gain_number_global": len(self.trades) + 1})
        if self._month_stats:
            self._month_stats["exits"] += 1
            self._month_stats["profit"] += slot.value - before
        self._event("SELL", when, slot_id=slot.slot_id, level_id=position.level_id, level_distance=self.levels[position.level_id].distance, trigger=position.entry, entry_price=position.entry, target=position.target, exit_price=position.target, reason="gain_target", open_slots=len(self._open()), armed_before=False, armed_after=False)
        if not self._open():
            self.cycles.append({"cycle_id": self.cycle_id, "start": self._cycle_start.isoformat() if self._cycle_start else "", "end": when.isoformat(), "anchor": self.anchor, "trades": sum(1 for trade in self.trades if trade["cycle_id"] == self.cycle_id), "status": "COMPLETE"})
            self.complete_cycles += 1
            if self._month_stats:
                self._month_stats["cycles"] += 1
            self.anchor = None
            self.armed.clear()
            self.pending_cycle = True
        else:
            self.armed.add(position.level_id)
            self._event("REARM", when, slot_id=slot.slot_id, level_id=position.level_id, level_distance=self.levels[position.level_id].distance, trigger=position.entry, reason="post_sale_rearm", open_slots=len(self._open()), armed_before=False, armed_after=True)

    def _down(self, start: float, end: float, when: datetime) -> None:
        if self.anchor is None or end >= start - EPS:
            return
        self._ensure_deeper_levels(end)
        candidates = sorted((self.levels[level] for level in self.armed if end - EPS <= self.levels[level].trigger <= start + EPS), key=lambda level: level.trigger, reverse=True)
        for level in candidates:
            free = self._free()
            if not free:
                return
            self._buy(free[0], level.level_id, level.trigger, when, "downward_cross")

    def _up(self, start: float, end: float, when: datetime) -> None:
        if self.anchor is None or end <= start + EPS:
            return
        sells = sorted((slot for slot in self._open() if start - EPS <= slot.position.target <= end + EPS), key=lambda slot: slot.position.target)
        for slot in sells:
            if self.pending_cycle:
                return
            self._sell(slot, when)

    def _process_path(self, values: list[float], when: datetime) -> None:
        for start, end in zip(values, values[1:]):
            self.ath = max(self.ath, start)
            if self.pending_cycle:
                return
            if end < start - EPS:
                self._down(start, end, when)
            elif end > start + EPS:
                self._up(start, end, when)
                self.ath = max(self.ath, end)

    def _begin_month(self, candle: Candle) -> None:
        self._month = candle.time.strftime("%Y-%m")
        self._month_stats = {"month": self._month, "btc_start": candle.open, "btc_end": candle.close, "btc_high": candle.high, "btc_low": candle.low, "entries": 0, "exits": 0, "profit": 0.0, "open_start": len(self._open()), "max_open": len(self._open()), "open_sum": 0, "candles": 0, "cycles": 0, "equity_start": self.equity(candle.open)}

    def _redistribute_month(self, candle: Candle) -> tuple[float, float, int, float]:
        if not self.config.redistribute_monthly:
            return 0.0, 0.0, 0, 0.0
        cap = self.config.operational_cap
        before = sum(slot.value for slot in self.slots)
        equivalent = value = 0.0
        donors = sorted((slot for slot in self._free() if slot.operational_gains > cap), key=lambda slot: (-slot.operational_gains, -slot.value, slot.slot_id))
        for donor in donors:
            while donor.operational_gains > cap:
                receivers = [slot for slot in self._free() if slot.operational_gains < cap]
                if not receivers:
                    break  # Não há destino permitido; o excedente fica no doador, sem reserva artificial.
                receiver = sorted(receivers, key=lambda slot: (-slot.operational_gains, -slot.value, slot.slot_id))[0]
                donor_before, receiver_before = donor.operational_gains, receiver.operational_gains
                donor_value_before = donor.value
                donor.value /= 1.0 + self.config.gain_rate
                transferred = donor_value_before - donor.value
                donor.operational_gains -= 1
                receiver.value += transferred
                receiver.operational_gains += 1
                donor.donated += transferred
                receiver.received += transferred
                equivalent += 1.0
                value += transferred
                self.total_redistributed += transferred
                self.redistributions.append({"month": self._month, "donor_slot": donor.slot_id, "receiver_slot": receiver.slot_id, "donor_real_gains": donor.real_gains, "donor_operational_before": donor_before, "donor_operational_after": donor.operational_gains, "receiver_operational_before": receiver_before, "receiver_operational_after": receiver.operational_gains, "gain_equivalent": 1.0, "value_transferred": transferred})
        after = sum(slot.value for slot in self.slots)
        if not math.isclose(before, after, abs_tol=1e-8, rel_tol=1e-12):
            raise AssertionError("redistribuição não conservou valor")
        locked = sum(max(0, slot.operational_gains - cap) for slot in self.slots if slot.position)
        unallocated = sum(max(0, slot.operational_gains - cap) for slot in self._free())
        return equivalent, value, locked, float(unallocated)

    def _close_month(self, candle: Candle) -> None:
        if not self._month_stats:
            return
        equivalent, value, locked, unallocated = self._redistribute_month(candle)
        stats = self._month_stats
        close = candle.close
        distance = close / self.ath - 1.0 if self.ath else 0.0
        ops = [slot.operational_gains for slot in self.slots]
        self.monthly.append({"month": stats["month"], "btc_start": stats["btc_start"], "btc_end": close, "btc_high": stats["btc_high"], "btc_low": stats["btc_low"], "ath_end": self.ath, "distance_from_ath_end": distance * 100, "regime_end": self.regime_for_price(close), "real_gains": stats["exits"], "entries": stats["entries"], "exits": stats["exits"], "realized_profit": stats["profit"], "open_slots_start": stats["open_start"], "max_open_slots": stats["max_open"], "average_open_slots": stats["open_sum"] / stats["candles"] if stats["candles"] else 0.0, "candle_count": stats["candles"], "open_slots_end": len(self._open()), "cycles": stats["cycles"], "redistributed_gain_equivalent": equivalent, "redistributed_value": value, "locked_excess": locked, "unallocated_free_excess": unallocated, "slots_at_3": sum(gain == self.config.operational_cap for gain in ops), "slots_between_0_and_3": sum(0 < gain < self.config.operational_cap for gain in ops), "slots_zero": sum(gain == 0 for gain in ops), "equity_start": stats["equity_start"], "equity_end": self.equity(close), "realized_profit_total": self.realized_profit, "open_pnl": self.open_pnl(close)})

    def _update_saturation(self, candle: Candle) -> None:
        opened = len(self._open())
        for threshold in self._saturation_active:
            active = self._saturation_active[threshold]
            if opened >= threshold:
                if active is None:
                    active = {"threshold": threshold, "start": candle.time, "btc_start": candle.open, "btc_low": candle.low, "max_open": opened, "regime_start": self.regime_for_price(candle.close)}
                    self._saturation_active[threshold] = active
                active["btc_low"] = min(active["btc_low"], candle.low)
                active["max_open"] = max(active["max_open"], opened)
            elif active is not None:
                self.saturation.append({"threshold": threshold, "start": active["start"].isoformat(), "end": candle.time.isoformat(), "duration_minutes": (candle.time - active["start"]).total_seconds() / 60, "max_open_slots": active["max_open"], "btc_start": active["btc_start"], "btc_low": active["btc_low"], "drawdown_pct": (active["btc_low"] / active["btc_start"] - 1.0) * 100, "regime_start": active["regime_start"], "gains_during_period": sum(1 for trade in self.trades if active["start"] <= datetime.fromisoformat(trade["exit_timestamp"]) < candle.time)})
                self._saturation_active[threshold] = None
        if opened == self.config.slots:
            self._days_at_full.add(candle.time.date().isoformat())

    def run(self, candles: Iterable[Candle]):
        first = True
        for candle in candles:
            if first:
                first = False
                self.ath = max(candle.open, candle.close)
                self._begin_month(candle)
                self._start_cycle(candle.close, candle.time)
            else:
                month = candle.time.strftime("%Y-%m")
                if month != self._month:
                    assert self._last_candle is not None
                    self._close_month(self._last_candle)
                    self._begin_month(candle)
                self.ath = max(self.ath, candle.open)
                if self.pending_cycle:
                    self._start_cycle(candle.open, candle.time)
                assert self._last_close is not None
                path = [self._last_close, candle.open]
                path += [candle.low, candle.high, candle.close] if candle.close >= candle.open else [candle.high, candle.low, candle.close]
                self._process_path(path, candle.time)
            assert self._month_stats is not None
            self._month_stats["btc_high"] = max(self._month_stats["btc_high"], candle.high)
            self._month_stats["btc_low"] = min(self._month_stats["btc_low"], candle.low)
            self._month_stats["btc_end"] = candle.close
            self._month_stats["max_open"] = max(self._month_stats["max_open"], len(self._open()))
            self._month_stats["open_sum"] += len(self._open())
            self._month_stats["candles"] += 1
            self._update_saturation(candle)
            self._last_close, self._last_candle = candle.close, candle
        if first or self._last_candle is None:
            raise ValueError("Nenhum candle")
        self._close_month(self._last_candle)
        for threshold, active in self._saturation_active.items():
            if active is not None:
                self.saturation.append({"threshold": threshold, "start": active["start"].isoformat(), "end": self._last_candle.time.isoformat(), "duration_minutes": (self._last_candle.time - active["start"]).total_seconds() / 60, "max_open_slots": active["max_open"], "btc_start": active["btc_start"], "btc_low": active["btc_low"], "drawdown_pct": (active["btc_low"] / active["btc_start"] - 1.0) * 100, "regime_start": active["regime_start"], "gains_during_period": sum(1 for trade in self.trades if active["start"] <= datetime.fromisoformat(trade["exit_timestamp"]) <= self._last_candle.time)})
        return self
