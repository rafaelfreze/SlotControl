"""Executa cenários V5 locais BTCUSDT 1m, sem aporte externo."""

from __future__ import annotations

import argparse
import csv
import json
import math
import statistics
from collections import defaultdict
from datetime import date, datetime, timezone
from pathlib import Path

from backtest_btc_v2 import END, ROOT, profile_effective_series, profile_gaps, read_daily_fills, write_csv
from v2_grid_engine import Candle, load_cached_klines
from v5_engine import V5Config, V5Engine

START = date(2017, 8, 17)
SCENARIOS = {
    "A": ("Benchmark 25x10, 2% fixo, sem redistribuição", V5Config(slots=25, adaptive_ath=False, redistribute_monthly=False)),
    "B": ("50x10, 2% fixo, sem redistribuição", V5Config(slots=50, adaptive_ath=False, redistribute_monthly=False)),
    "C": ("50x10, ATH 4/2/2, sem redistribuição", V5Config(slots=50, adaptive_ath=True, redistribute_monthly=False)),
    "D": ("V5: 50x10, ATH 4/2/2 e redistribuição mensal teto 3", V5Config(slots=50, adaptive_ath=True, redistribute_monthly=True)),
}
CRASH_PERIODS = {
    "2017_2018": (date(2017, 8, 17), date(2018, 12, 31)),
    "2020_03": (date(2020, 3, 1), date(2020, 3, 31)),
    "2021_2022": (date(2021, 1, 1), date(2022, 12, 31)),
    "2024_2026": (date(2024, 1, 1), END),
}


def scenario_summary(code: str, label: str, engine: V5Engine) -> dict:
    last = engine._last_candle
    assert last is not None
    initial = engine.config.slots * engine.config.initial_value
    gains = [row["real_gains"] for row in engine.monthly]
    equity = engine.equity(last.close)
    open_pnl = engine.open_pnl(last.close)
    accounting = initial + engine.realized_profit + open_pnl
    if not math.isclose(accounting, equity, abs_tol=1e-8):
        raise AssertionError(f"contabilidade não fecha em {code}")
    total_candles = sum(row["candle_count"] for row in engine.monthly)
    return {"scenario": code, "description": label, "initial_capital": initial, "final_equity": equity, "equity_multiple": equity / initial, "return_pct": (equity / initial - 1) * 100, "realized_profit": engine.realized_profit, "realized_profit_over_initial_pct": engine.realized_profit / initial * 100, "open_pnl": open_pnl, "real_gains": len(engine.trades), "gains_per_100_initial": len(engine.trades) / initial * 100, "monthly_gains_average": statistics.mean(gains), "monthly_gains_median": statistics.median(gains), "max_open_slots": engine.max_open_slots, "average_open_slots": sum(row["average_open_slots"] * row["candle_count"] for row in engine.monthly) / total_candles, "days_fully_occupied": len(engine._days_at_full), "complete_cycles": engine.complete_cycles, "current_btc_holdings": engine.btc_holdings(), "open_cost_basis": sum(slot.position.value_at_entry for slot in engine.slots if slot.position), "open_market_value": sum(slot.position.btc_qty * last.close for slot in engine.slots if slot.position), "cumulative_btc_bought": engine.cumulative_btc_bought, "cumulative_btc_sold": engine.cumulative_btc_sold, "total_redistributed": engine.total_redistributed, "slots_at_3": sum(slot.operational_gains == 3 for slot in engine.slots), "slots_zero": sum(slot.operational_gains == 0 for slot in engine.slots), "external_topup": 0.0, "accounting_difference": accounting - equity, "ending_btc_price": last.close}


def yearly_rows(monthly: list[dict], full_days: set[str]) -> list[dict]:
    groups: dict[str, list[dict]] = defaultdict(list)
    for row in monthly:
        groups[row["month"][:4]].append(row)
    rows = []
    for year, values in sorted(groups.items()):
        candles = sum(row["candle_count"] for row in values)
        avg_open = sum(row["average_open_slots"] * row["candle_count"] for row in values) / candles
        rows.append({"year": year, "real_gains": sum(row["real_gains"] for row in values), "entries": sum(row["entries"] for row in values), "exits": sum(row["exits"] for row in values), "start_equity": values[0]["equity_start"], "end_equity": values[-1]["equity_end"], "max_open_slots": max(row["max_open_slots"] for row in values), "average_open_slots": avg_open, "days_50_open": sum(day.startswith(year) for day in full_days), "cycles": sum(row["cycles"] for row in values), "redistributed_value": sum(row["redistributed_value"] for row in values), "slots_at_3_end": values[-1]["slots_at_3"], "btc_year_high": max(row["btc_high"] for row in values), "btc_year_low": min(row["btc_low"] for row in values), "btc_return_pct": (values[-1]["btc_end"] / values[0]["btc_start"] - 1) * 100})
    return rows


def crash_rows(engine: V5Engine, cache: Path, fills: dict[datetime, Candle]) -> list[dict]:
    events: dict[datetime, list[dict]] = defaultdict(list)
    for event in engine.events:
        events[datetime.fromisoformat(event["timestamp"])].append(event)
    trackers = {name: {"peak": 0.0, "top": 0.0, "bottom": float("inf"), "bottom_time": None, "recovery": None, "dd": 0.0, "gains": 0, "entries": 0, "used": set(), "max_open": 0, "after_bottom": 0, "regimes": defaultdict(int), "open": 0} for name in CRASH_PERIODS}
    ath = 0.0
    open_slots = 0
    for candle in load_cached_klines(cache, START, END, fills):
        ath = max(ath, candle.high)
        event_rows = events.get(candle.time, [])
        for event in event_rows:
            if event["event"] == "BUY":
                open_slots += 1
            elif event["event"] == "SELL":
                open_slots -= 1
        for name, (start, end) in CRASH_PERIODS.items():
            if not start <= candle.time.date() <= end:
                continue
            tracker = trackers[name]
            tracker["peak"] = max(tracker["peak"], candle.high)
            dd = (tracker["peak"] - candle.low) / tracker["peak"] if tracker["peak"] else 0.0
            if dd > tracker["dd"]:
                tracker.update({"dd": dd, "top": tracker["peak"], "bottom": candle.low, "bottom_time": candle.time, "recovery": None, "after_bottom": open_slots})
            if tracker["bottom_time"] and tracker["recovery"] is None and candle.time > tracker["bottom_time"] and candle.high >= tracker["top"]:
                tracker["recovery"] = candle.time
            tracker["max_open"] = max(tracker["max_open"], open_slots)
            tracker["regimes"][engine.regime_for_price(candle.close, ath)] += 1
            for event in event_rows:
                if event["event"] == "SELL": tracker["gains"] += 1
                if event["event"] == "BUY":
                    tracker["entries"] += 1
                    tracker["used"].add(int(event["slot_id"]))
    rows = []
    for name, tracker in trackers.items():
        recovery = tracker["recovery"].isoformat() if tracker["recovery"] else "NOT_RECOVERED_IN_PERIOD"
        minutes = (tracker["recovery"] - tracker["bottom_time"]).total_seconds() / 60 if tracker["recovery"] else ""
        saturated = sum(row["duration_minutes"] for row in engine.saturation if row["threshold"] == engine.config.slots and datetime.fromisoformat(row["start"]).date() <= CRASH_PERIODS[name][1] and datetime.fromisoformat(row["end"]).date() >= CRASH_PERIODS[name][0])
        rows.append({"period": name, "top_price": tracker["top"], "bottom_price": tracker["bottom"], "drawdown_pct": tracker["dd"] * 100, "predominant_regime": max(tracker["regimes"], key=tracker["regimes"].get) if tracker["regimes"] else "", "gains": tracker["gains"], "entries": tracker["entries"], "max_open_slots": tracker["max_open"], "reached_50": tracker["max_open"] >= engine.config.slots, "slots_used": len(tracker["used"]), "positions_remaining_after_bottom": tracker["after_bottom"], "time_to_recovery": recovery, "time_to_recovery_minutes": minutes, "time_saturated_minutes": saturated})
    return rows


def write_principal(output: Path, engine: V5Engine, summary: dict, cache: Path, fills: dict[datetime, Candle]) -> None:
    last = engine._last_candle
    assert last is not None
    years = yearly_rows(engine.monthly, engine._days_at_full)
    slots, opens = [], []
    for slot in engine.slots:
        pos = slot.position
        market = pos.btc_qty * last.close if pos else 0.0
        locked = max(0, slot.operational_gains - engine.config.operational_cap) if pos else 0
        row = {"slot_id": slot.slot_id, "real_gains": slot.real_gains, "operational_gains": slot.operational_gains, "value": slot.value, "status": "OPEN" if pos else "FREE", "times_bought": slot.times_bought, "times_sold": slot.times_sold, "received_redistribution": slot.received, "donated_redistribution": slot.donated, "locked_excess": locked, "entry_price_if_open": pos.entry if pos else "", "target_if_open": pos.target if pos else "", "btc_qty_if_open": pos.btc_qty if pos else 0.0, "market_value": market, "unrealized_pnl": market - pos.value_at_entry if pos else 0.0}
        slots.append(row)
        if pos:
            opens.append({**row, "cycle_id": pos.cycle_id, "grid_level": pos.level_id, "anchor": pos.anchor, "opened_at": pos.opened_at.isoformat(), "cost_basis": pos.value_at_entry, "open_duration_minutes": (last.time - pos.opened_at).total_seconds() / 60})
    crashes = crash_rows(engine, cache, fills)
    accounting = {"capital_initial": summary["initial_capital"], "external_topup": 0.0, "realized_profit": summary["realized_profit"], "open_pnl": summary["open_pnl"], "patrimony_final": summary["final_equity"], "difference": summary["accounting_difference"]}
    write_csv(output / "monthly_v5.csv", engine.monthly, list(engine.monthly[0]))
    write_csv(output / "yearly_v5.csv", years, list(years[0]))
    write_csv(output / "slots_v5.csv", slots, list(slots[0]))
    write_csv(output / "trades_v5.csv", engine.trades, list(engine.trades[0]) if engine.trades else ["cycle_id"])
    write_csv(output / "cycles_v5.csv", engine.cycles, ["cycle_id", "start", "end", "anchor", "trades", "status"])
    write_csv(output / "redistributions_v5.csv", engine.redistributions, ["month", "donor_slot", "receiver_slot", "donor_real_gains", "donor_operational_before", "donor_operational_after", "receiver_operational_before", "receiver_operational_after", "gain_equivalent", "value_transferred"])
    write_csv(output / "saturation_v5.csv", engine.saturation, ["threshold", "start", "end", "duration_minutes", "max_open_slots", "btc_start", "btc_low", "drawdown_pct", "regime_start", "gains_during_period"])
    write_csv(output / "crashes_v5.csv", crashes, list(crashes[0]))
    write_csv(output / "open_positions_final_v5.csv", opens, list(opens[0]) if opens else ["slot_id", "status"])
    (output / "accounting_v5.json").write_text(json.dumps({"D": accounting}, indent=2), encoding="utf-8")


def run_scenario(output: Path, code: str) -> None:
    label, config = SCENARIOS[code]
    cache = ROOT / "backtest-data"
    fills = read_daily_fills(cache, START, END)
    engine = V5Engine(config).run(load_cached_klines(cache, START, END, fills))
    summary = scenario_summary(code, label, engine)
    (output / f"scenario_{code}.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    if code == "D":
        write_principal(output, engine, summary, cache, fills)
    print(output / f"scenario_{code}.json")


def finalize(output: Path) -> None:
    scenarios = [json.loads((output / f"scenario_{code}.json").read_text(encoding="utf-8")) for code in SCENARIOS]
    cache = ROOT / "backtest-data"
    raw_count, first, last, _ = profile_gaps(cache, START, END)
    fills = read_daily_fills(cache, START, END)
    effective_count, _, _, effective_gaps = profile_effective_series(cache, START, END, fills)
    files = sorted(path.name for path in (cache / "binance" / "BTCUSDT" / "1m").glob("BTCUSDT-1m-*.zip"))
    write_csv(output / "comparison_scenarios_v5.csv", scenarios, list(scenarios[0]))
    base_reports = sorted((ROOT / "reports" / "backtests" / "base-btc-no-contributions").glob("*/monthly_base_btc.csv"))
    if base_reports:
        with base_reports[-1].open(encoding="utf-8", newline="") as handle:
            benchmark_monthly = {row["month"]: row for row in csv.DictReader(handle)}
        with (output / "monthly_v5.csv").open(encoding="utf-8", newline="") as handle:
            v5_monthly = list(csv.DictReader(handle))
        comparison_months = []
        for row in v5_monthly:
            benchmark = benchmark_monthly.get(row["month"])
            if not benchmark:
                continue
            comparison_months.append({"month": row["month"], "benchmark_gains_25x10": int(benchmark["real_gains"]), "v5_gains_50x10": int(row["real_gains"]), "difference_gains": int(row["real_gains"]) - int(benchmark["real_gains"]), "benchmark_gains_per_100": int(benchmark["real_gains"]) / 2.5, "v5_gains_per_100": int(row["real_gains"]) / 5.0, "difference_gains_per_100": int(row["real_gains"]) / 5.0 - int(benchmark["real_gains"]) / 2.5})
        write_csv(output / "v5_vs_benchmark_monthly.csv", comparison_months, list(comparison_months[0]))
    accounting = {row["scenario"]: {"capital_initial": row["initial_capital"], "external_topup": 0.0, "realized_profit": row["realized_profit"], "open_pnl": row["open_pnl"], "patrimony_final": row["final_equity"], "difference": row["accounting_difference"]} for row in scenarios}
    (output / "accounting_v5.json").write_text(json.dumps(accounting, indent=2), encoding="utf-8")
    summary = {"period": {"first_timestamp": first.isoformat() if first else "", "last_timestamp": last.isoformat() if last else "", "days": (last.date() - first.date()).days + 1 if first and last else 0, "raw_candles": raw_count, "official_daily_rows_read": len(fills), "effective_candles": effective_count, "remaining_gaps": len(effective_gaps), "remaining_missing_minutes": sum(row["missing_minutes"] for row in effective_gaps)}, "scenarios": scenarios, "assumptions": {"top": "4%", "middle": "2%", "bottom": "2%", "transition": "níveis já criados permanecem imutáveis; novos níveis usam 4% somente se o próximo gatilho ainda estiver no TOPO, caso contrário seguem 2% a partir da última fronteira", "overflow": "se todos os slots livres já estão no teto operacional 3, excedente livre permanece no doador; não há reserva ou perda financeira"}}
    (output / "summary_v5.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    (output / "README.md").write_text("# BTC V5 — 50 slots, ATH e redistribuição\n\nCenários A-D são isolados. O principal é D. A redistribuição opera somente entre slots livres, preserva valor e não recebe aporte externo. Níveis já criados não são reescritos por mudança de regime; a transição 4%→2% apenas define o próximo nível ainda não criado.\n", encoding="utf-8")
    lines = ["# Backtest BTC V5", "", "Sem aporte externo; cenário principal D usa 50 slots, ATH 4/2/2 e redistribuição mensal com teto operacional 3.", "", "| Cenário | Equity final | Múltiplo | Retorno | Gains | Máx. abertos | Dias 100% ocupado | Redistribuído |", "|---|---:|---:|---:|---:|---:|---:|---:|"]
    lines += [f"| {row['scenario']} | {row['final_equity']:.2f} | {row['equity_multiple']:.4f}x | {row['return_pct']:.2f}% | {row['real_gains']} | {row['max_open_slots']} | {row['days_fully_occupied']} | {row['total_redistributed']:.2f} |" for row in scenarios]
    lines += ["", "A: benchmark validado. B: efeito de 50 slots com 2% fixo. C: efeito do ATH sem redistribuição. D: V5 principal."]
    (output / "summary_v5.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(output)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--scenario", choices=SCENARIOS)
    parser.add_argument("--finalize", action="store_true")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    if args.scenario:
        run_scenario(args.output, args.scenario)
    elif args.finalize:
        finalize(args.output)
    else:
        raise SystemExit("informe --scenario ou --finalize")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
