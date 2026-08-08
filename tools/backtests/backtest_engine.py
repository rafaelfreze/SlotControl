"""Motor deterministico do backtest BTC com slots lideres."""

from __future__ import annotations

import csv
import math
import zipfile
from dataclasses import dataclass
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Iterable

from strategy_slot_leader import StrategyConfig, calculate_compound_topup, priority_key, select_entry_slot, select_leader

EPSILON = 1e-10


@dataclass(frozen=True)
class Candle:
    time: datetime
    open: float
    high: float
    low: float
    close: float


@dataclass
class Position:
    buy_time: datetime
    buy_price: float
    target_price: float
    value_at_entry: float


@dataclass
class Slot:
    slot_id: int
    value: float
    gains_real: int = 0
    gains_operational: int = 0
    position: Position | None = None
    times_bought: int = 0
    times_sold: int = 0
    months_as_leader: int = 0
    total_topup_received: float = 0.0
    last_buy_price: float | None = None
    last_sell_price: float | None = None


@dataclass
class BacktestResult:
    config: StrategyConfig
    interval: str
    intrabar_mode: str
    start: datetime
    end: datetime
    candles_processed: int
    slots: list[Slot]
    trades: list[dict]
    topups: list[dict]
    monthly: list[dict]
    topups_forensic: list[dict]
    monthly_forensic: list[dict]
    leader_selection_audit: list[dict]
    ambiguous_candles: list[dict]
    ending_price: float
    total_entries: int
    total_exits: int
    max_open_slots: int
    max_drawdown_operational: float
    realized_profit: float

    def cash_balance(self) -> float:
        return sum(slot.value for slot in self.slots if slot.position is None)

    def open_market_value(self) -> float:
        return sum(slot.position.value_at_entry * self.ending_price / slot.position.buy_price for slot in self.slots if slot.position)

    def open_pnl(self) -> float:
        return self.open_market_value() - sum(slot.position.value_at_entry for slot in self.slots if slot.position)

    def equity(self) -> float:
        return self.cash_balance() + self.open_market_value()


def load_cached_klines(cache_root: Path, symbol: str, interval: str, start: date, end: date) -> Iterable[Candle]:
    folder = cache_root / "binance" / symbol / interval
    if not folder.exists():
        raise FileNotFoundError(f"Cache inexistente: {folder}. Execute com --download.")
    for zip_path in sorted(folder.glob(f"{symbol}-{interval}-*.zip")):
        with zipfile.ZipFile(zip_path) as archive:
            csv_names = [name for name in archive.namelist() if name.endswith(".csv")]
            if len(csv_names) != 1:
                raise ValueError(f"Arquivo invalido: {zip_path}")
            with archive.open(csv_names[0]) as raw:
                for row in csv.reader(line.decode("utf-8-sig") for line in raw):
                    if not row or row[0].lower() in {"open_time", "open time"}:
                        continue
                    # A Binance Data Vision mudou arquivos recentes para microssegundos.
                    raw_timestamp = int(row[0])
                    divisor = 1_000_000 if raw_timestamp >= 10_000_000_000_000 else 1_000
                    timestamp = datetime.fromtimestamp(raw_timestamp / divisor, tz=timezone.utc)
                    if start <= timestamp.date() <= end:
                        yield Candle(timestamp, float(row[1]), float(row[2]), float(row[3]), float(row[4]))


class BacktestEngine:
    def __init__(self, config: StrategyConfig, interval: str, intrabar_mode: str):
        if intrabar_mode not in {"heuristic", "conservative"}:
            raise ValueError("intrabar_mode deve ser heuristic ou conservative")
        self.config, self.interval, self.intrabar_mode = config, interval, intrabar_mode
        self.slots = [Slot(index, config.initial_slot_value) for index in range(1, config.slot_count + 1)]
        self.trades: list[dict] = []
        self.topups: list[dict] = []
        self.monthly: list[dict] = []
        self.topups_forensic: list[dict] = []
        self.monthly_forensic: list[dict] = []
        self.leader_selection_audit: list[dict] = []
        self.ambiguous_candles: list[dict] = []
        self.anchor: float | None = None
        self.next_level = 0
        self.restart_next_candle = False
        self.total_entries = self.total_exits = self.max_open_slots = 0
        self.realized_profit = 0.0
        self.peak_equity = config.slot_count * config.initial_slot_value
        self.max_drawdown = 0.0
        self.month_start_equity = self.peak_equity
        self.month_start_exits = 0
        self.month_start_profit = 0.0
        self.current_month: str | None = None
        self.month_number = 0
        self.month_btc_start = 0.0
        self.month_open_slots_start = 0
        self.month_cash_start = 0.0
        self.month_equity_start = 0.0
        self.topup_months: set[str] = set()
        self.last_candle: Candle | None = None
        self.processed = 0

    def _open_slots(self):
        return [slot for slot in self.slots if slot.position]

    def _equity(self, price: float) -> float:
        return sum(slot.value for slot in self.slots if slot.position is None) + sum(slot.position.value_at_entry * price / slot.position.buy_price for slot in self.slots if slot.position)

    def _record_drawdown(self, price: float) -> None:
        equity = self._equity(price)
        self.peak_equity = max(self.peak_equity, equity)
        self.max_drawdown = max(self.max_drawdown, (self.peak_equity - equity) / self.peak_equity)

    def _begin_month(self, candle: Candle) -> None:
        self.month_number = len(self.monthly) + 1
        self.month_btc_start = candle.open
        self.month_open_slots_start = len(self._open_slots())
        self.month_cash_start = sum(slot.value for slot in self.slots if slot.position is None)
        self.month_equity_start = self._equity(candle.open)

    def _buy(self, slot: Slot, price: float, when: datetime) -> None:
        if slot.position is not None:
            raise AssertionError("slot ocupado nao pode comprar")
        slot.position = Position(when, price, price * (1 + self.config.gain_rate), slot.value)
        slot.times_bought += 1
        slot.last_buy_price = price
        self.total_entries += 1
        self.max_open_slots = max(self.max_open_slots, len(self._open_slots()))

    def _sell(self, slot: Slot, when: datetime) -> None:
        position = slot.position
        if position is None:
            return
        before, after = slot.value, slot.value * (1 + self.config.gain_rate)
        slot.value = after
        slot.gains_real += 1
        slot.gains_operational += 1
        slot.times_sold += 1
        slot.last_sell_price = position.target_price
        self.trades.append({"slot": slot.slot_id, "buy_time": position.buy_time.isoformat(), "buy_price": position.buy_price, "sell_time": when.isoformat(), "sell_price": position.target_price, "slot_value_before": before, "slot_value_after": after, "gain_number": slot.gains_real})
        self.realized_profit += after - before
        self.total_exits += 1
        slot.position = None

    def _start_cycle(self, price: float, when: datetime) -> None:
        leader = select_entry_slot(self.slots, self.config.entry_priority)
        if leader is None:
            return
        self.anchor, self.next_level, self.restart_next_candle = price, 1, False
        self._buy(leader, price, when)

    def _maybe_restart(self, candle: Candle) -> None:
        if self.restart_next_candle:
            self._start_cycle(candle.open, candle.time)

    def _fill_buys_down_to(self, price: float, when: datetime) -> bool:
        if self.anchor is None:
            return False
        filled = False
        while True:
            trigger = self.anchor * (1 - self.config.drop_rate * self.next_level)
            leader = select_entry_slot(self.slots, self.config.entry_priority)
            if leader is None or price > trigger + EPSILON:
                return filled
            self._buy(leader, trigger, when)
            self.next_level += 1
            filled = True

    def _fill_sells_up_to(self, price: float, when: datetime, allowed: list[Slot] | None = None) -> bool:
        candidates = allowed if allowed is not None else self._open_slots()
        sellable = sorted((slot for slot in candidates if slot.position and slot.position.target_price <= price + EPSILON), key=lambda slot: slot.position.target_price)
        for slot in sellable:
            self._sell(slot, when)
        if sellable and not self._open_slots():
            self.anchor = None
            self.restart_next_candle = True
        return bool(sellable)

    def _ambiguous(self, candle: Candle) -> bool:
        if self.anchor is None or not select_entry_slot(self.slots, self.config.entry_priority):
            return False
        trigger = self.anchor * (1 - self.config.drop_rate * self.next_level)
        has_buy = candle.low <= trigger + EPSILON
        has_existing_sell = any(slot.position and candle.high >= slot.position.target_price - EPSILON for slot in self.slots)
        return has_buy and (has_existing_sell or candle.high >= trigger * (1 + self.config.gain_rate) - EPSILON)

    def _process_heuristic(self, candle: Candle) -> None:
        self._fill_sells_up_to(candle.open, candle.time)
        if not self.restart_next_candle:
            self._fill_buys_down_to(candle.open, candle.time)
        if self.restart_next_candle:
            return
        path = [candle.open, candle.low, candle.high, candle.close] if candle.close >= candle.open else [candle.open, candle.high, candle.low, candle.close]
        for previous, current in zip(path, path[1:]):
            if self.restart_next_candle:
                return
            if current < previous:
                self._fill_buys_down_to(current, candle.time)
            elif current > previous:
                self._fill_sells_up_to(current, candle.time)

    def _process_conservative(self, candle: Candle) -> None:
        positions_at_start = list(self._open_slots())
        self._fill_buys_down_to(candle.low, candle.time)
        self._fill_sells_up_to(candle.high, candle.time, positions_at_start)

    def _close_month(self, candle: Candle) -> None:
        if self.current_month is None:
            return
        target = (len(self.monthly) + 1) * self.config.monthly_target_gains
        leader = select_leader(self.slots)
        eligible = sorted((slot for slot in self.slots if slot.position is None), key=priority_key)
        ranks = {slot.slot_id: index + 1 for index, slot in enumerate(eligible)}
        equity_before_topup = self._equity(candle.close)
        cash_before = sum(slot.value for slot in self.slots if slot.position is None)
        topup = 0.0
        factor = 1.0
        missing: int | str = ""
        leader_before: int | str = ""
        leader_id: int | str = "NO_FREE_SLOT" if leader is None else leader.slot_id
        leader_real_before: int | str = ""
        leader_value_before: float | str = ""
        reason = "NO_FREE_SLOT" if leader is None else "TARGET_ALREADY_MET"
        if self.config.enable_topups and leader is not None:
            leader_before = leader.gains_operational
            leader_real_before = leader.gains_real
            leader_value_before = leader.value
            missing, factor, topup, after = calculate_compound_topup(leader.value, leader.gains_operational, target, self.config.gain_rate)
            if missing:
                if leader.position is not None:
                    raise AssertionError("Slot aberto nao pode receber aporte")
                if self.current_month in self.topup_months:
                    raise AssertionError("topups_per_month excedeu 1")
                self.topup_months.add(self.current_month)
                leader.value, leader.gains_operational = after, leader.gains_operational + missing
                leader.total_topup_received += topup
                reason = "APPLIED"
                topup_row = {"month": self.current_month, "target_gains": target, "slot_id": leader.slot_id, "slot_gains_before": leader_before, "slot_gains_after": leader.gains_operational, "slot_value_before": leader_value_before, "slot_value_after": after, "missing_gains": missing, "topup_amount": topup}
                self.topups.append(topup_row)
                self.topups_forensic.append({"timestamp": candle.time.isoformat(), "month": self.current_month, "slot_id": leader.slot_id, "status": "FREE", "month_number": self.month_number, "cumulative_target": target, "real_gains_before": leader_real_before, "operational_gains_before": leader_before, "missing_gains": missing, "slot_value_before": leader_value_before, "compound_factor": factor, "topup_amount": topup, "slot_value_after": after, "reason": reason})
            leader.months_as_leader += 1
        elif self.config.enable_topups:
            self.topups.append({"month": self.current_month, "target_gains": target, "slot_id": "NO_FREE_SLOT", "slot_gains_before": "", "slot_gains_after": "", "slot_value_before": "", "slot_value_after": "", "missing_gains": "", "topup_amount": 0.0})
        for slot in self.slots:
            self.leader_selection_audit.append({"month": self.current_month, "slot_id": slot.slot_id, "status": "OPEN" if slot.position else "FREE", "operational_gains": slot.gains_operational if slot is not leader else leader_before, "real_gains": slot.gains_real if slot is not leader else leader_real_before, "slot_value": slot.value if slot is not leader else leader_value_before, "eligible": slot.position is None, "rank": ranks.get(slot.slot_id, ""), "selected": slot is leader})
        cash_after = sum(slot.value for slot in self.slots if slot.position is None)
        equity_after_topup = self._equity(candle.close)
        self.monthly_forensic.append({"month": self.current_month, "btc_start": self.month_btc_start, "btc_end": candle.close, "leader_slot": leader_id, "cumulative_target": target, "leader_real_gains": leader_real_before, "leader_operational_gains_before": leader_before, "missing_gains": missing, "topup_amount": topup, "real_trades_month": self.total_exits - self.month_start_exits, "real_profit_month": self.realized_profit - self.month_start_profit, "open_slots_start": self.month_open_slots_start, "open_slots_end": len(self._open_slots()), "equity_before_topup": equity_before_topup, "equity_after_topup": equity_after_topup, "cash_before": cash_before, "cash_after": cash_after, "reason": reason})
        self.monthly.append({"month": self.current_month, "start_equity": self.month_start_equity, "end_equity": self._equity(candle.close), "realized_gains": self.total_exits - self.month_start_exits, "realized_profit": self.realized_profit - self.month_start_profit, "open_slots_end": len(self._open_slots()), "closed_slots_end": self.config.slot_count - len(self._open_slots()), "leader_slot": leader_id, "target_gains": target, "leader_gains_before": leader_before, "missing_gains": missing, "topup_amount": topup, "total_topups_to_date": sum(float(item["topup_amount"]) for item in self.topups), "end_btc_price": candle.close})
        self.month_start_equity, self.month_start_exits, self.month_start_profit = self._equity(candle.close), self.total_exits, self.realized_profit

    def run(self, candles: Iterable[Candle]) -> BacktestResult:
        first: Candle | None = None
        for candle in candles:
            if first is None:
                first, self.current_month = candle, candle.time.strftime("%Y-%m")
                self._start_cycle(candle.close, candle.time)  # close inicial, escolha reproduzivel
                self._begin_month(candle)
            else:
                month = candle.time.strftime("%Y-%m")
                if month != self.current_month:
                    self._close_month(self.last_candle)
                    self.current_month = month
                    self._begin_month(candle)
                self._maybe_restart(candle)
                if self._ambiguous(candle):
                    self.ambiguous_candles.append({"time": candle.time.isoformat(), "open": candle.open, "high": candle.high, "low": candle.low, "close": candle.close})
                (self._process_heuristic if self.intrabar_mode == "heuristic" else self._process_conservative)(candle)
            self._record_drawdown(candle.close)
            self.last_candle, self.processed = candle, self.processed + 1
        if first is None or self.last_candle is None:
            raise ValueError("Nenhum candle no periodo solicitado")
        self._close_month(self.last_candle)
        return BacktestResult(self.config, self.interval, self.intrabar_mode, first.time, self.last_candle.time, self.processed, self.slots, self.trades, self.topups, self.monthly, self.topups_forensic, self.monthly_forensic, self.leader_selection_audit, self.ambiguous_candles, self.last_candle.close, self.total_entries, self.total_exits, self.max_open_slots, self.max_drawdown, self.realized_profit)
