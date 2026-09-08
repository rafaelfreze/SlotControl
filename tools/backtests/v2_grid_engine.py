"""Motor V2: grade linear reciclável para a estratégia pretendida de BTC.

Não depende do motor V1. Os níveis pertencem ao ciclo e voltam a ficar armados
quando o preço os cruza de baixo para cima. Uma posição aberta ainda bloqueia
o seu próprio nível, portanto a reciclagem nunca duplica uma mesma entrada.
"""

from __future__ import annotations

import csv
import io
import math
import zipfile
from dataclasses import dataclass
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Callable, Iterable

EPS = 1e-9


@dataclass(frozen=True)
class Candle:
    time: datetime
    open: float
    high: float
    low: float
    close: float


@dataclass(frozen=True)
class GridConfig:
    symbol: str = "BTCUSDT"
    slots: int = 25
    initial_value: float = 10.0
    gain_rate: float = 0.01
    default_drop_rate: float = 0.02
    monthly_target: int = 7
    enable_topups: bool = False
    regime: bool = False


@dataclass
class Position:
    level: int
    entry_time: datetime
    entry_price: float
    target_price: float
    value_at_entry: float
    btc_qty: float = 0.0


@dataclass
class Slot:
    slot_id: int
    value: float
    real_gains: int = 0
    operational_gains: int = 0
    position: Position | None = None
    times_bought: int = 0
    times_sold: int = 0
    total_topup: float = 0.0
    months_as_leader: int = 0


@dataclass
class V2Result:
    config: GridConfig
    mode: str
    start: datetime
    end: datetime
    candles: int
    ending_price: float
    slots: list[Slot]
    trades: list[dict]
    events: list[dict]
    cycles: list[dict]
    monthly: list[dict]
    topups: list[dict]
    ambiguous: list[dict]
    max_open_slots: int
    complete_cycles: int
    realized_profit: float
    max_drawdown: float

    def cash(self) -> float:
        return sum(slot.value for slot in self.slots if slot.position is None)

    def position_value(self) -> float:
        return sum(slot.position.value_at_entry * self.ending_price / slot.position.entry_price for slot in self.slots if slot.position)

    def equity(self) -> float:
        return self.cash() + self.position_value()

    def open_pnl(self) -> float:
        return self.position_value() - sum(slot.position.value_at_entry for slot in self.slots if slot.position)


def load_cached_klines(cache_root: Path, start: date, end: date, fills: dict[datetime, Candle] | None = None) -> Iterable[Candle]:
    """Lê os ZIPs mensais da Data Vision sem carregar a série inteira em RAM."""
    folder = cache_root / "binance" / "BTCUSDT" / "1m"
    previous: Candle | None = None
    for zip_path in sorted(folder.glob("BTCUSDT-1m-*.zip")):
        with zipfile.ZipFile(zip_path) as archive:
            names = [name for name in archive.namelist() if name.endswith(".csv")]
            if len(names) != 1:
                raise ValueError(f"ZIP inválido: {zip_path}")
            with archive.open(names[0]) as raw, io.TextIOWrapper(raw, encoding="utf-8-sig", newline="") as text:
                for row in csv.reader(text):
                    if not row or row[0].lower() in {"open_time", "open time"}:
                        continue
                    timestamp = int(row[0])
                    divisor = 1_000_000 if timestamp >= 10_000_000_000_000 else 1_000
                    when = datetime.fromtimestamp(timestamp / divisor, tz=timezone.utc)
                    if start <= when.date() <= end:
                        candle = Candle(when, float(row[1]), float(row[2]), float(row[3]), float(row[4]))
                        if previous is not None and fills:
                            cursor = previous.time.timestamp() + 60
                            while cursor < candle.time.timestamp():
                                fill = fills.get(datetime.fromtimestamp(cursor, tz=timezone.utc))
                                if fill is not None:
                                    yield fill
                                cursor += 60
                        yield candle
                        previous = candle


def slot_priority(slot: Slot) -> tuple[int, float, int]:
    return (-slot.operational_gains, -slot.value, slot.slot_id)


class RecyclableLinearGridEngine:
    def __init__(self, config: GridConfig, mode: str = "heuristic", record_candle_state: bool = False):
        if mode not in {"heuristic", "conservative"}:
            raise ValueError("mode deve ser heuristic ou conservative")
        self.config, self.mode = config, mode
        self.slots = [Slot(i, config.initial_value) for i in range(1, config.slots + 1)]
        self.anchor: float | None = None
        self.drop_rate: float | None = None
        self.armed: set[int] = set()
        self.open_by_level: dict[int, Slot] = {}
        self.pending_cycle = False
        self.cycle_id = 0
        self.cycle_start: datetime | None = None
        self.trades: list[dict] = []
        self.events: list[dict] = []
        self.cycles: list[dict] = []
        self.monthly: list[dict] = []
        self.topups: list[dict] = []
        self.ambiguous: list[dict] = []
        self.max_open_slots = self.complete_cycles = 0
        self.realized_profit = 0.0
        self.peak_equity = config.slots * config.initial_value
        self.max_drawdown = 0.0
        self._last_close: float | None = None
        self._last_candle: Candle | None = None
        self._month: str | None = None
        self._month_start_equity = 0.0
        self._month_start_trades = 0
        self._month_start_profit = 0.0
        self._month_open_start = 0
        self._month_btc_start = 0.0
        self._month_number = 0
        self._candles_processed = 0
        self.record_candle_state = record_candle_state
        self.candle_snapshots: list[dict] = []

    def _open(self) -> list[Slot]:
        return [slot for slot in self.slots if slot.position is not None]

    def _free_leader(self) -> Slot | None:
        free = [slot for slot in self.slots if slot.position is None]
        return min(free, key=slot_priority) if free else None

    def _equity_at(self, price: float) -> float:
        return sum(slot.value for slot in self.slots if slot.position is None) + sum(slot.position.value_at_entry * price / slot.position.entry_price for slot in self.slots if slot.position)

    def _record_drawdown(self, price: float) -> None:
        equity = self._equity_at(price)
        self.peak_equity = max(self.peak_equity, equity)
        self.max_drawdown = max(self.max_drawdown, (self.peak_equity - equity) / self.peak_equity)

    def _regime_rate(self, ath: float, price: float) -> float:
        if not self.config.regime:
            return self.config.default_drop_rate
        drawdown = (price / ath - 1.0) if ath else 0.0
        if drawdown >= -0.20:
            return 0.04
        if drawdown >= -0.40:
            return 0.03
        return 0.02

    def _level_price(self, level: int) -> float:
        assert self.anchor is not None and self.drop_rate is not None
        return self.anchor * (1.0 - self.drop_rate * level)

    def _open_levels(self) -> set[int]:
        return set(self.open_by_level)

    def _levels_between(self, low: float, high: float) -> range:
        """Faixa de índices lineares cujos preços estão entre low e high."""
        assert self.anchor is not None and self.drop_rate is not None
        lower = math.ceil((1.0 - high / self.anchor) / self.drop_rate - EPS)
        upper = math.floor((1.0 - low / self.anchor) / self.drop_rate + EPS)
        return range(max(0, lower), min(self.config.slots - 1, upper) + 1)

    def _start_cycle(self, price: float, when: datetime, ath: float) -> None:
        leader = self._free_leader()
        if leader is None:
            raise AssertionError("não há slot livre para a entrada inicial do ciclo")
        self.cycle_id += 1
        self.anchor = price
        self.drop_rate = self._regime_rate(ath, price)
        self.armed = set(range(self.config.slots))
        self.pending_cycle = False
        self.cycle_start = when
        self._buy(leader, 0, price, when, "cycle_market_entry")

    def _buy(self, slot: Slot, level: int, price: float, when: datetime, reason: str) -> None:
        if slot.position is not None:
            raise AssertionError("slot aberto não pode receber nova entrada")
        if level in self.open_by_level:
            raise AssertionError("nível já possui posição aberta")
        armed_before = level in self.armed
        slot.position = Position(level, when, price, price * (1.0 + self.config.gain_rate), slot.value, slot.value / price)
        self.open_by_level[level] = slot
        slot.times_bought += 1
        self.armed.discard(level)
        self.max_open_slots = max(self.max_open_slots, len(self._open()))
        self.events.append({"timestamp": when.isoformat(), "event": "BUY", "cycle": self.cycle_id, "slot": slot.slot_id, "level": level, "trigger": price, "entry_price": price, "target": slot.position.target_price, "exit_price": "", "real_gain_number": slot.real_gains, "slot_gains": slot.operational_gains, "open_slots_after": len(self._open()), "anchor": self.anchor, "drop_rate": self.drop_rate, "reason": reason, "armed_before": armed_before, "armed_after": level in self.armed})

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
        self.trades.append({"slot": slot.slot_id, "cycle": self.cycle_id, "level": position.level, "buy_time": position.entry_time.isoformat(), "buy_price": position.entry_price, "sell_time": when.isoformat(), "sell_price": position.target_price, "slot_value_before": before, "slot_value_after": slot.value, "gain_number": slot.real_gains})
        del self.open_by_level[position.level]
        slot.position = None
        self.events.append({"timestamp": when.isoformat(), "event": "SELL", "cycle": self.cycle_id, "slot": slot.slot_id, "level": position.level, "trigger": "", "entry_price": position.entry_price, "target": position.target_price, "exit_price": position.target_price, "real_gain_number": slot.real_gains, "slot_gains": slot.operational_gains, "open_slots_after": len(self._open()), "anchor": self.anchor, "drop_rate": self.drop_rate, "reason": "gain_target", "armed_before": position.level in self.armed, "armed_after": position.level in self.armed})
        if not self._open():
            self.cycles.append({"cycle": self.cycle_id, "start": self.cycle_start.isoformat() if self.cycle_start else "", "end": when.isoformat(), "anchor": self.anchor, "drop_rate": self.drop_rate, "trades": sum(1 for trade in self.trades if trade["cycle"] == self.cycle_id), "status": "COMPLETE"})
            self.complete_cycles += 1
            self.anchor = self.drop_rate = None
            self.armed.clear()
            self.pending_cycle = True
        else:
            # O alvo fica acima da entrada; ao realizar o gain, o nível já foi
            # cruzado na subida e pode voltar a aceitar uma queda futura.
            self.armed.add(position.level)
            self.events.append({"timestamp": when.isoformat(), "event": "REARM", "cycle": self.cycle_id, "slot": slot.slot_id, "level": position.level, "trigger": position.entry_price, "entry_price": position.entry_price, "target": position.target_price, "exit_price": position.target_price, "real_gain_number": slot.real_gains, "slot_gains": slot.operational_gains, "open_slots_after": len(self._open()), "anchor": self.anchor, "drop_rate": self.drop_rate, "reason": "post_sale_rearm", "armed_before": False, "armed_after": True})

    def _cross_down(self, start: float, end: float, when: datetime) -> None:
        if self.anchor is None or end >= start - EPS:
            return
        # Cronologia na queda: do preço alto para o baixo (nível 0, 1, 2 ...).
        crossed = [level for level in self._levels_between(end, start) if level in self.armed]
        for level in crossed:
            if self.pending_cycle:
                return
            if level in self.open_by_level:
                continue
            leader = self._free_leader()
            if leader is None:
                return
            self._buy(leader, level, self._level_price(level), when, "downward_cross")

    def _cross_up(self, start: float, end: float, when: datetime, allow_new_sells: bool = True) -> None:
        if self.anchor is None or end <= start + EPS:
            return
        # Realiza targets em ordem de preço. O fechamento rearma o nível: o
        # próprio alvo está 1% acima da entrada, portanto a subida o cruzou.
        points: list[tuple[float, Slot]] = []
        for slot in self._open():
            if start - EPS <= slot.position.target_price <= end + EPS:
                points.append((slot.position.target_price, slot))
        for _, slot in sorted(points, key=lambda value: value[0]):
            if self.pending_cycle:
                return
            if allow_new_sells:
                self._sell(slot, when)

    def _process_path(self, values: list[float], when: datetime, conservative: bool = False) -> None:
        initially_open = set(id(slot) for slot in self._open())
        for previous, current in zip(values, values[1:]):
            if self.pending_cycle:
                return
            if current < previous - EPS:
                self._cross_down(previous, current, when)
            elif current > previous + EPS:
                if conservative:
                    # O conservador permite apenas saídas de posições já abertas antes do candle.
                    held = [slot for slot in self._open() if id(slot) in initially_open]
                    for slot in held:
                        if slot.position and previous - EPS <= slot.position.target_price <= current + EPS:
                            self._sell(slot, when)
                else:
                    self._cross_up(previous, current, when)

    def _start_month(self, candle: Candle) -> None:
        self._month_number = len(self.monthly) + 1
        self._month_start_equity = self._equity_at(candle.open)
        self._month_start_trades = len(self.trades)
        self._month_start_profit = self.realized_profit
        self._month_open_start = len(self._open())
        self._month_btc_start = candle.open

    def _close_month(self, candle: Candle) -> None:
        if self._month is None:
            return
        leader = self._free_leader()
        target = self._month_number * self.config.monthly_target
        topup = 0.0
        missing: int | str = ""
        leader_id: int | str = "NO_FREE_SLOT" if leader is None else leader.slot_id
        before_gains: int | str = "" if leader is None else leader.operational_gains
        if self.config.enable_topups and leader is not None:
            missing = max(0, target - leader.operational_gains)
            if missing:
                before = leader.value
                factor = math.pow(1.0 + self.config.gain_rate, missing)
                topup = before * (factor - 1.0)
                leader.value *= factor
                leader.operational_gains += missing
                leader.total_topup += topup
                self.topups.append({"month": self._month, "month_number": self._month_number, "slot_id": leader.slot_id, "target_gains": target, "real_gains_before": leader.real_gains, "operational_gains_before": before_gains, "missing_gains": missing, "slot_value_before": before, "compound_factor": factor, "topup_amount": topup, "slot_value_after": leader.value, "reason": "APPLIED"})
            leader.months_as_leader += 1
        elif self.config.enable_topups and leader is None:
            self.topups.append({"month": self._month, "month_number": self._month_number, "slot_id": "NO_FREE_SLOT", "target_gains": target, "real_gains_before": "", "operational_gains_before": "", "missing_gains": "", "slot_value_before": "", "compound_factor": "", "topup_amount": 0.0, "slot_value_after": "", "reason": "NO_FREE_SLOT"})
        self.monthly.append({"month": self._month, "start_equity": self._month_start_equity, "end_equity": self._equity_at(candle.close), "realized_gains": len(self.trades) - self._month_start_trades, "realized_profit": self.realized_profit - self._month_start_profit, "open_slots_start": self._month_open_start, "open_slots_end": len(self._open()), "leader_slot": leader_id, "target_gains": target if self.config.enable_topups else "", "leader_gains_before": before_gains, "missing_gains": missing, "topup_amount": topup, "end_btc_price": candle.close})

    def run(self, candles: Iterable[Candle]) -> V2Result:
        first: Candle | None = None
        ath = 0.0
        for candle in candles:
            self._candles_processed += 1
            if first is None:
                first = candle
                self._month = candle.time.strftime("%Y-%m")
                # A entrada inicial é no fechamento: a máxima deste candle já é conhecida.
                self._start_cycle(candle.close, candle.time, candle.high)
                ath = candle.high
                self._start_month(candle)
            else:
                month = candle.time.strftime("%Y-%m")
                if month != self._month:
                    assert self._last_candle is not None
                    self._close_month(self._last_candle)
                    self._month = month
                    self._start_month(candle)
                # Um ciclo concluído só reinicia a mercado no candle seguinte.
                if self.pending_cycle:
                    self._start_cycle(candle.open, candle.time, ath)
                assert self._last_close is not None
                path = [self._last_close, candle.open]
                if self.mode == "heuristic":
                    path += [candle.low, candle.high, candle.close] if candle.close >= candle.open else [candle.high, candle.low, candle.close]
                else:
                    # Pior caso: entradas na mínima sem permitir gain dessas entradas no candle.
                    path += [candle.low, candle.high, candle.close]
                if self.anchor is not None:
                    has_buy = any(level in self.armed for level in self._levels_between(candle.low, candle.high))
                    has_sell = any(slot.position and candle.low <= slot.position.target_price <= candle.high for slot in self.slots)
                    if has_buy and has_sell:
                        self.ambiguous.append({"timestamp": candle.time.isoformat(), "open": candle.open, "high": candle.high, "low": candle.low, "close": candle.close})
                self._process_path(path, candle.time, conservative=self.mode == "conservative")
                # Para o próximo candle, a máxima atual passa a ser informação observável.
                ath = max(ath, candle.high)
            self._record_drawdown(candle.close)
            if self.record_candle_state:
                self.candle_snapshots.append({"timestamp": candle.time.isoformat(), "close": candle.close, "equity": self._equity_at(candle.close), "open_slots": len(self._open()), "entries": sum(slot.times_bought for slot in self.slots), "exits": len(self.trades), "cycles_completed": self.complete_cycles, "realized_profit": self.realized_profit})
            self._last_close, self._last_candle = candle.close, candle
        if first is None or self._last_candle is None:
            raise ValueError("Nenhum candle")
        self._close_month(self._last_candle)
        return V2Result(self.config, self.mode, first.time, self._last_candle.time, self._candles_processed, self._last_candle.close, self.slots, self.trades, self.events, self.cycles, self.monthly, self.topups, self.ambiguous, self.max_open_slots, self.complete_cycles, self.realized_profit, self.max_drawdown)
