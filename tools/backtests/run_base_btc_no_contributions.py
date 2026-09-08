"""Backtest-base BTCUSDT: grade linear reciclável, sem aportes ou crescimento artificial."""

from __future__ import annotations

import json
import math
import statistics
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from backtest_btc_v2 import END, ROOT, profile_gaps, read_daily_fills, write_csv
from v2_grid_engine import Candle, GridConfig, RecyclableLinearGridEngine, load_cached_klines

START = date(2017, 8, 17)
CRASH_PERIODS = {
    "2017_2018": (date(2017, 8, 17), date(2018, 12, 31)),
    "2020_03": (date(2020, 3, 1), date(2020, 3, 31)),
    "2021_2022": (date(2021, 1, 1), date(2022, 12, 31)),
    "2024_2026": (date(2024, 1, 1), END),
}


@dataclass
class OpenPosition:
    slot: int
    cycle: int
    level: int
    anchor: float
    entry: float
    target: float
    opened: datetime
    value: float

    @property
    def btc_qty(self) -> float:
        return self.value / self.entry


@dataclass
class FinanceState:
    slots: int
    initial_value: float
    values: dict[int, float] = field(init=False)
    open: dict[int, OpenPosition] = field(default_factory=dict)
    cumulative_btc_bought: float = 0.0
    cumulative_btc_sold: float = 0.0

    def __post_init__(self) -> None:
        self.values = {slot: self.initial_value for slot in range(1, self.slots + 1)}

    def equity(self, price: float) -> float:
        return sum(self.values[slot] for slot in self.values if slot not in self.open) + sum(pos.value * price / pos.entry for pos in self.open.values())

    def open_pnl(self, price: float) -> float:
        return sum(pos.value * (price / pos.entry - 1.0) for pos in self.open.values())

    def apply(self, event: dict) -> float:
        """Aplica evento e devolve lucro realizado da venda, quando houver."""
        kind = event["event"]
        if kind == "BUY":
            slot, level = int(event["slot"]), int(event["level"])
            if slot in self.open or level in {pos.level for pos in self.open.values()}:
                raise AssertionError("posição/nível duplicado no livro de auditoria")
            entry = float(event["entry_price"])
            pos = OpenPosition(slot, int(event["cycle"]), level, float(event["anchor"]), entry, float(event["target"]), datetime.fromisoformat(event["timestamp"]), self.values[slot])
            self.open[slot] = pos
            self.cumulative_btc_bought += pos.btc_qty
        elif kind == "SELL":
            slot = int(event["slot"])
            pos = self.open.pop(slot, None)
            if pos is None:
                raise AssertionError("venda sem posição no livro de auditoria")
            before = self.values[slot]
            self.values[slot] *= 1.01
            self.cumulative_btc_sold += pos.btc_qty
            return self.values[slot] - before
        return 0.0


@dataclass
class Bucket:
    key: str
    start_equity: float
    btc_start: float
    btc_end: float = 0.0
    btc_high: float = 0.0
    btc_low: float = float("inf")
    entries: int = 0
    exits: int = 0
    profit: float = 0.0
    open_start: int = 0
    open_max: int = 0
    open_end: int = 0
    cycles: int = 0
    open_sum: int = 0
    candles: int = 0
    end_equity: float = 0.0
    unrealized_end: float = 0.0

    def add_candle(self, candle: Candle, open_slots: int, equity: float, unrealized: float) -> None:
        self.btc_end = candle.close
        self.btc_high = max(self.btc_high, candle.high)
        self.btc_low = min(self.btc_low, candle.low)
        self.open_max = max(self.open_max, open_slots)
        self.open_end = open_slots
        self.open_sum += open_slots
        self.candles += 1
        self.end_equity, self.unrealized_end = equity, unrealized


@dataclass
class CrashTracker:
    name: str
    start: date
    end: date
    peak: float = 0.0
    peak_time: datetime | None = None
    top: float = 0.0
    bottom: float = float("inf")
    bottom_time: datetime | None = None
    max_drawdown: float = 0.0
    recovery_time: datetime | None = None
    gains: int = 0
    entries: int = 0
    slots_used: set[int] = field(default_factory=set)
    max_open: int = 0
    positions_after_bottom: int = 0

    def observe(self, candle: Candle, open_slots: int, events: list[dict]) -> None:
        if not (self.start <= candle.time.date() <= self.end):
            return
        self.peak = max(self.peak, candle.high)
        if self.peak == candle.high:
            self.peak_time = candle.time
        drawdown = (self.peak - candle.low) / self.peak if self.peak else 0.0
        if drawdown > self.max_drawdown:
            self.max_drawdown, self.top, self.bottom, self.bottom_time = drawdown, self.peak, candle.low, candle.time
            self.positions_after_bottom = open_slots
            self.recovery_time = None
        if self.bottom_time and self.recovery_time is None and candle.time > self.bottom_time and candle.high >= self.top:
            self.recovery_time = candle.time
        self.max_open = max(self.max_open, open_slots)
        for event in events:
            if event["event"] == "SELL":
                self.gains += 1
            if event["event"] == "BUY":
                self.entries += 1
                self.slots_used.add(int(event["slot"]))

    def row(self) -> dict:
        recovery = "NOT_RECOVERED_IN_PERIOD" if self.recovery_time is None else self.recovery_time.isoformat()
        minutes = "" if self.recovery_time is None or self.bottom_time is None else int((self.recovery_time - self.bottom_time).total_seconds() / 60)
        return {"period": self.name, "start": self.start.isoformat(), "end": self.end.isoformat(), "top_price": self.top, "bottom_price": self.bottom, "drawdown_pct": self.max_drawdown * 100, "gains_during_period": self.gains, "entries_during_period": self.entries, "max_open_slots": self.max_open, "slots_used": len(self.slots_used), "positions_remaining_after_bottom": self.positions_after_bottom, "time_to_recovery": recovery, "time_to_recovery_minutes": minutes}


def effective_gaps(cache: Path, fills: dict[datetime, Candle]) -> tuple[int, list[dict]]:
    count, gaps, previous = 0, [], None
    for candle in load_cached_klines(cache, START, END, fills):
        count += 1
        if previous:
            missing = round((candle.time - previous.time).total_seconds() / 60) - 1
            if missing > 0:
                gaps.append({"start_after": previous.time.isoformat(), "end_before": candle.time.isoformat(), "missing_minutes": missing})
        previous = candle
    return count, gaps


def run_postprocess(cache: Path, fills: dict[datetime, Candle], result) -> tuple[list[dict], list[dict], list[dict], dict, dict[int, float]]:
    events_by_time: dict[datetime, list[dict]] = defaultdict(list)
    for event in result.events:
        events_by_time[datetime.fromisoformat(event["timestamp"])].append(event)
    cycles_by_end: dict[datetime, int] = defaultdict(int)
    for cycle in result.cycles:
        cycles_by_end[datetime.fromisoformat(cycle["end"])] += 1
    state = FinanceState(result.config.slots, result.config.initial_value)
    monthly: dict[str, Bucket] = {}
    yearly: dict[str, Bucket] = {}
    trackers = [CrashTracker(name, start, end) for name, (start, end) in CRASH_PERIODS.items()]
    current_month = current_year = None
    longest_open: dict[int, float] = defaultdict(float)
    trades_by_key = {(trade["slot"], trade["buy_time"]): trade for trade in result.trades}
    buys_by_key = {(event["slot"], event["timestamp"]): event for event in result.events if event["event"] == "BUY"}
    trade_rows = []
    previous_candle = None
    for candle in load_cached_klines(cache, START, END, fills):
        month, year = candle.time.strftime("%Y-%m"), candle.time.strftime("%Y")
        if month not in monthly:
            monthly[month] = Bucket(month, state.equity(candle.open), candle.open, open_start=len(state.open))
        if year not in yearly:
            yearly[year] = Bucket(year, state.equity(candle.open), candle.open, open_start=len(state.open))
        event_rows = events_by_time.get(candle.time, [])
        for event in event_rows:
            if event["event"] == "BUY":
                expected = float(event["anchor"]) * (1 - 0.02 * int(event["level"]))
                if not math.isclose(float(event["entry_price"]), expected, rel_tol=0.0, abs_tol=1e-7):
                    raise AssertionError("entrada fora da grade linear")
            profit = state.apply(event)
            for bucket in (monthly[month], yearly[year]):
                if event["event"] == "BUY":
                    bucket.entries += 1
                elif event["event"] == "SELL":
                    bucket.exits += 1
                    bucket.profit += profit
        cycle_count = cycles_by_end.get(candle.time, 0)
        monthly[month].cycles += cycle_count
        yearly[year].cycles += cycle_count
        equity, unrealized, open_slots = state.equity(candle.close), state.open_pnl(candle.close), len(state.open)
        for bucket in (monthly[month], yearly[year]):
            bucket.add_candle(candle, open_slots, equity, unrealized)
        for tracker in trackers:
            tracker.observe(candle, open_slots, event_rows)
        previous_candle = candle

    for trade in result.trades:
        entry = datetime.fromisoformat(trade["buy_time"])
        exit_ = datetime.fromisoformat(trade["sell_time"])
        duration = (exit_ - entry).total_seconds() / 60
        longest_open[int(trade["slot"])] = max(longest_open[int(trade["slot"])], duration)
        buy = buys_by_key[(trade["slot"], trade["buy_time"])]
        trade_rows.append({"cycle_id": trade["cycle"], "slot_id": trade["slot"], "grid_level": trade["level"], "anchor": buy["anchor"], "entry_timestamp": trade["buy_time"], "entry_price": trade["buy_price"], "btc_qty": float(trade["slot_value_before"]) / float(trade["buy_price"]), "target_price": trade["sell_price"], "exit_timestamp": trade["sell_time"], "exit_price": trade["sell_price"], "duration_minutes": duration, "slot_value_before": trade["slot_value_before"], "slot_value_after": trade["slot_value_after"], "real_gain_number_slot": trade["gain_number"], "real_gain_number_global": len(trade_rows) + 1})
    assert previous_candle is not None
    for pos in state.open.values():
        longest_open[pos.slot] = max(longest_open[pos.slot], (previous_candle.time - pos.opened).total_seconds() / 60)
    monthly_rows = [{"month": item.key, "btc_start": item.btc_start, "btc_end": item.btc_end, "btc_high": item.btc_high, "btc_low": item.btc_low, "entries": item.entries, "exits": item.exits, "real_gains": item.exits, "realized_profit": item.profit, "open_slots_start": item.open_start, "max_open_slots": item.open_max, "open_slots_end": item.open_end, "cycles_completed": item.cycles, "equity_start": item.start_equity, "equity_end": item.end_equity, "unrealized_pnl_end": item.unrealized_end} for _, item in sorted(monthly.items())]
    yearly_rows = [{"year": item.key, "start_equity": item.start_equity, "end_equity": item.end_equity, "real_gains": item.exits, "entries": item.entries, "exits": item.exits, "realized_profit": item.profit, "max_open_slots": item.open_max, "average_open_slots": item.open_sum / item.candles if item.candles else 0.0, "cycles_completed": item.cycles, "btc_year_high": item.btc_high, "btc_year_low": item.btc_low, "btc_return_pct": (item.btc_end / item.btc_start - 1) * 100 if item.btc_start else 0.0} for _, item in sorted(yearly.items())]
    final = {"state": state, "last_candle": previous_candle, "trackers": [tracker.row() for tracker in trackers], "longest_open": longest_open, "average_open_slots": sum(item.open_sum for item in monthly.values()) / sum(item.candles for item in monthly.values())}
    return monthly_rows, yearly_rows, trade_rows, final, longest_open


def main() -> int:
    cache = ROOT / "backtest-data"
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d-%H%M")
    output = ROOT / "reports" / "backtests" / "base-btc-no-contributions" / stamp
    output.mkdir(parents=True, exist_ok=False)
    raw_count, first, last, raw_gaps = profile_gaps(cache, START, END)
    fills = read_daily_fills(cache, START, END)
    effective_count, gaps = effective_gaps(cache, fills)
    engine = RecyclableLinearGridEngine(GridConfig(enable_topups=False, regime=False), "heuristic")
    result = engine.run(load_cached_klines(cache, START, END, fills))
    if result.topups:
        raise AssertionError("cenário-base não pode ter aporte externo")
    monthly, yearly, trades, final, longest = run_postprocess(cache, fills, result)
    state, last_candle = final["state"], final["last_candle"]
    open_positions = []
    for pos in sorted(state.open.values(), key=lambda item: item.slot):
        market_value = pos.btc_qty * last_candle.close
        open_positions.append({"slot_id": pos.slot, "status": "OPEN", "cycle_id": pos.cycle, "grid_level": pos.level, "anchor": pos.anchor, "entry_price": pos.entry, "target_price": pos.target, "btc_qty": pos.btc_qty, "cost_basis": pos.value, "market_value": market_value, "unrealized_pnl": market_value - pos.value, "opened_at": pos.opened.isoformat(), "open_duration_minutes": (last_candle.time - pos.opened).total_seconds() / 60})
    slots = []
    for slot in result.slots:
        pos = state.open.get(slot.slot_id)
        market = pos.btc_qty * last_candle.close if pos else 0.0
        slots.append({"slot_id": slot.slot_id, "real_gains": slot.real_gains, "final_value": slot.value, "times_bought": slot.times_bought, "times_sold": slot.times_sold, "status": "OPEN" if pos else "FREE", "entry_price_if_open": pos.entry if pos else "", "target_if_open": pos.target if pos else "", "btc_qty_if_open": pos.btc_qty if pos else 0.0, "market_value_if_open": market, "unrealized_pnl": market - pos.value if pos else 0.0, "longest_open_duration_minutes": longest.get(slot.slot_id, 0.0)})
    monthly_gains = [row["real_gains"] for row in monthly]
    trade_times = [datetime.fromisoformat(trade["sell_time"]) for trade in result.trades]
    intervals = [trade_times[0] - result.start, *[right - left for left, right in zip(trade_times, trade_times[1:])], result.end - trade_times[-1]]
    longest_no_gain = max(intervals, key=lambda value: value.total_seconds())
    cycles = list(result.cycles)
    active_cycle_start = min((pos.opened for pos in state.open.values()), default=None)
    longest_stuck = max([datetime.fromisoformat(cycle["end"]) - datetime.fromisoformat(cycle["start"]) for cycle in cycles] + ([result.end - active_cycle_start] if active_cycle_start else []), key=lambda value: value.total_seconds())
    capital = result.config.slots * result.config.initial_value
    equity = result.equity()
    accounting = {"capital_initial": capital, "external_topup": 0.0, "realized_profit": result.realized_profit, "open_pnl": result.open_pnl(), "patrimony_final": equity, "reconciliation_lhs": capital + result.realized_profit + result.open_pnl(), "difference": capital + result.realized_profit + result.open_pnl() - equity}
    if not math.isclose(accounting["reconciliation_lhs"], equity, abs_tol=1e-8):
        raise AssertionError("reconciliação contábil não fecha")
    summary = {"period": {"first_timestamp": result.start.isoformat(), "last_timestamp": result.end.isoformat(), "days": (result.end.date() - result.start.date()).days + 1, "candles": result.candles}, "data_integrity": {"raw_candles": raw_count, "raw_gaps": len(raw_gaps), "raw_missing_minutes": sum(row["missing_minutes"] for row in raw_gaps), "official_daily_fill_candles": len(fills), "effective_candles": effective_count, "remaining_gaps": len(gaps), "remaining_missing_minutes": sum(row["missing_minutes"] for row in gaps)}, "capital_initial": capital, "external_topup": 0.0, "patrimony_final": equity, "realized_profit": result.realized_profit, "open_pnl": result.open_pnl(), "real_gains": len(result.trades), "gains_monthly_average": statistics.mean(monthly_gains), "gains_monthly_median": statistics.median(monthly_gains), "gains_yearly_average": len(result.trades) / (len(yearly) or 1), "best_month_gains": max(monthly_gains), "worst_month_gains": min(monthly_gains), "max_open_slots": result.max_open_slots, "average_open_slots": final["average_open_slots"], "slots_used": sum(slot.times_bought > 0 for slot in result.slots), "complete_cycles": result.complete_cycles, "longest_period_without_gain_minutes": longest_no_gain.total_seconds() / 60, "longest_period_with_open_positions_minutes": longest_stuck.total_seconds() / 60, "current_btc_holdings": sum(pos.btc_qty for pos in state.open.values()), "open_cost_basis": sum(pos.value for pos in state.open.values()), "open_market_value": sum(pos.btc_qty * last_candle.close for pos in state.open.values()), "cumulative_btc_bought": state.cumulative_btc_bought, "cumulative_btc_sold": state.cumulative_btc_sold, "ambiguous_candles": len(result.ambiguous), "calibration_90d_reference": {"gains_90d": 80, "gains_60d": 61, "max_open_slots": 16}}
    files = sorted(path.name for path in (cache / "binance" / "BTCUSDT" / "1m").glob("BTCUSDT-1m-*.zip"))
    integrity_lines = ["# Integridade dos dados", "", "Fonte: Binance Data Vision, Spot Klines BTCUSDT 1m.", "", f"- Arquivos mensais utilizados: {len(files)}", f"- Candles brutos: {raw_count:,}", f"- Lacunas brutas: {len(raw_gaps)} / {sum(row['missing_minutes'] for row in raw_gaps):,} minutos", f"- Linhas lidas em arquivos diários oficiais: {len(fills):,}", f"- Minutos efetivamente recuperados nas lacunas: {effective_count - raw_count:,}", f"- Candles efetivos: {effective_count:,}", f"- Lacunas restantes: {len(gaps)} / {sum(row['missing_minutes'] for row in gaps):,} minutos", "", "Os candles ausentes não foram inventados. A lista de arquivos e lacunas está nos CSVs adjacentes."]
    write_csv(output / "monthly_base_btc.csv", monthly, list(monthly[0]))
    write_csv(output / "yearly_base_btc.csv", yearly, list(yearly[0]))
    write_csv(output / "slots_base_btc.csv", slots, list(slots[0]))
    write_csv(output / "trades_base_btc.csv", trades, list(trades[0]))
    write_csv(output / "cycles_base_btc.csv", cycles, ["cycle", "start", "end", "anchor", "drop_rate", "trades", "status"])
    write_csv(output / "open_positions_final.csv", open_positions, list(open_positions[0]) if open_positions else ["slot_id", "status"])
    write_csv(output / "crashes_base_btc.csv", final["trackers"], list(final["trackers"][0]))
    write_csv(output / "data_gaps_remaining.csv", gaps, ["start_after", "end_before", "missing_minutes"])
    write_csv(output / "data_files_used.csv", [{"file": name} for name in files], ["file"])
    (output / "accounting_base_btc.json").write_text(json.dumps(accounting, indent=2), encoding="utf-8")
    (output / "summary_base_btc.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    (output / "data_integrity_base_btc.md").write_text("\n".join(integrity_lines) + "\n", encoding="utf-8")
    report = ["# Backtest-base BTC — operacional puro", "", "Sem meta, aporte, redistribuição, reserva ou regimes ATH.", "", "| Métrica | Valor |", "|---|---:|", *[f"| {label} | {value} |" for label, value in [("Período", f"{result.start.isoformat()} a {result.end.isoformat()}"), ("Candles", result.candles), ("Gains reais", len(result.trades)), ("Patrimônio final", f"{equity:.8f} USDT"), ("Lucro realizado", f"{result.realized_profit:.8f} USDT"), ("PnL aberto", f"{result.open_pnl():.8f} USDT"), ("Máximo slots abertos", result.max_open_slots), ("Média slots abertos", f"{final['average_open_slots']:.4f}"), ("Slots utilizados", f"{sum(slot.times_bought > 0 for slot in result.slots)}/25"), ("Ciclos completos", result.complete_cycles), ("BTC em aberto", f"{summary['current_btc_holdings']:.12f}"), ("Lacunas restantes", summary['data_integrity']['remaining_missing_minutes'])]], "", "## Resultado mês a mês", "", "| Mês | Gains | Entradas | Máx. abertos | Abertos final | Ciclos | Patrimônio |", "|---|---:|---:|---:|---:|---:|---:|", *[f"| {row['month']} | {row['real_gains']} | {row['entries']} | {row['max_open_slots']} | {row['open_slots_end']} | {row['cycles_completed']} | {row['equity_end']:.2f} |" for row in monthly], "", "## Resultado anual", "", "| Ano | Gains | Patrimônio inicial | Patrimônio final | Máx. slots abertos | Ciclos |", "|---|---:|---:|---:|---:|---:|", *[f"| {row['year']} | {row['real_gains']} | {row['start_equity']:.2f} | {row['end_equity']:.2f} | {row['max_open_slots']} | {row['cycles_completed']} |" for row in yearly], "", "O modo heuristic usa o caminho intraminuto aproximado. Candles ambíguos são contabilizados no JSON; não foram usados AggTrades nesta execução."]
    (output / "summary_base_btc.md").write_text("\n".join(report) + "\n", encoding="utf-8")
    (output / "README.md").write_text("# Backtest-base BTC sem aportes\n\nEste diretório contém somente o cenário BTCUSDT 1m, grade linear reciclável de 2%, ganho líquido de 1% e capital inicial de 250 USDT. Não há meta, aporte, redistribuição, reserva, regime ATH ou outros ativos.\n", encoding="utf-8")
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
