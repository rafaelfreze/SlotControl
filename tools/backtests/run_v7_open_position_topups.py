"""Executa V7 local: 25/50 slots e aporte mensal proporcional em posições abertas."""

from __future__ import annotations

import argparse
import csv
import json
import math
import statistics
from collections import defaultdict
from datetime import date
from pathlib import Path

from backtest_btc_v2 import END, ROOT, profile_effective_series, profile_gaps, read_daily_fills, write_csv
from v2_grid_engine import load_cached_klines
from v7_engine import V7Config, V7Engine

START = date(2017, 8, 17)
SCENARIOS = {
    "A0": ("25x10, zero aporte", V7Config(slots=25, topup_enabled=False)),
    "A1": ("25x10, aporte V7", V7Config(slots=25, topup_enabled=True)),
    "B0": ("50x10, zero aporte", V7Config(slots=50, topup_enabled=False)),
    "B1": ("50x10, aporte V7", V7Config(slots=50, topup_enabled=True)),
}
REFERENCES = {
    "A0": {"real_gains": 6269, "final_equity": 2462.6975838782696, "max_open_slots": 25, "days_full": 1543},
    "B0": {"real_gains": 8012, "final_equity": 3242.652663682764, "max_open_slots": 42, "days_full": 0},
}


def weighted(rows: list[dict], key: str) -> float:
    total = sum(row["candle_count"] for row in rows)
    return sum(row[key] * row["candle_count"] for row in rows) / total


def longest_cycle_minutes(engine: V7Engine) -> float:
    return max(((date.fromisoformat(row["end"][:10]) - date.fromisoformat(row["start"][:10])).days * 1440 for row in engine.cycles), default=0.0)


def longest_no_gain_minutes(engine: V7Engine) -> float:
    timestamps = [date.fromisoformat(trade["exit_timestamp"][:10]) for trade in engine.trades]
    if len(timestamps) < 2:
        return 0.0
    return max((later - earlier).days * 1440 for earlier, later in zip(timestamps, timestamps[1:]))


def summary(code: str, label: str, engine: V7Engine) -> dict:
    last = engine._last_candle
    assert last is not None
    initial = engine.config.slots * engine.config.initial_value
    equity = engine.equity(last.close)
    pnl = engine.open_pnl(last.close)
    accounting = initial + engine.cumulative_topups + engine.realized_profit + pnl
    if not math.isclose(accounting, equity, abs_tol=1e-8, rel_tol=1e-12):
        raise AssertionError(f"contabilidade não fecha no cenário {code}: {accounting} != {equity}")
    topups = [row["actual_total"] for row in engine.monthly_topups]
    positive = [value for value in topups if value > 0]
    open_positions = [slot.position for slot in engine.slots if slot.position]
    total_cost = sum(position.cost_basis for position in open_positions)
    return {
        "scenario": code, "description": label, "initial_capital": initial,
        "external_topups": engine.cumulative_topups, "total_contributed": initial + engine.cumulative_topups,
        "final_equity": equity, "net_profit_vs_contributed": equity - initial - engine.cumulative_topups,
        "return_on_contributed_pct": (equity / (initial + engine.cumulative_topups) - 1) * 100,
        "real_gains": len(engine.trades), "realized_profit": engine.realized_profit, "open_pnl": pnl,
        "max_open_slots": engine.max_open_slots, "average_open_slots": weighted(engine.monthly, "average_open_slots"),
        "days_full": len(engine._days_at_full), "days_open_80": len(engine._days_open_80),
        "cycles": engine.complete_cycles, "btc_holdings_final": engine.btc_holdings(),
        "open_cost_basis_final": total_cost,
        "open_average_cost_final": total_cost / engine.btc_holdings() if engine.btc_holdings() else 0.0,
        "open_market_value_final": engine.btc_holdings() * last.close,
        "cumulative_btc_bought_from_grid": engine.cumulative_btc_bought,
        "cumulative_btc_bought_from_topups": engine.cumulative_btc_bought_from_topups,
        "cumulative_btc_sold": engine.cumulative_btc_sold,
        "months_with_topup": len(positive), "months_without_topup": len(topups) - len(positive),
        "months_at_1000_cap": sum(value >= 1000 - 1e-8 for value in topups),
        "first_month_at_1000_cap": next((row["month"] for row in engine.monthly_topups if row["actual_total"] >= 1000 - 1e-8), ""),
        "average_topup_all_months": statistics.mean(topups), "average_topup_positive_months": statistics.mean(positive) if positive else 0.0,
        "median_topup": statistics.median(topups), "largest_topup": max(topups), "smallest_positive_topup": min(positive) if positive else 0.0,
        "average_effective_topup_rate": statistics.mean(row["effective_rate"] for row in engine.monthly_topups),
        "longest_full_period_minutes": max((row["duration_minutes"] for row in engine.saturation if row["threshold"] == engine.config.slots), default=0.0),
        "largest_open_period_minutes": longest_cycle_minutes(engine), "longest_no_gain_minutes": longest_no_gain_minutes(engine),
        "accounting_difference": accounting - equity,
    }


def assert_control(code: str, result: dict) -> None:
    for key, expected in REFERENCES[code].items():
        actual = result[key]
        if isinstance(expected, float):
            if not math.isclose(actual, expected, abs_tol=1e-8, rel_tol=1e-12): raise AssertionError(f"{code} divergiu em {key}: {actual} != {expected}")
        elif actual != expected: raise AssertionError(f"{code} divergiu em {key}: {actual} != {expected}")


def detail_rows(engine: V7Engine) -> dict[str, list[dict]]:
    last = engine._last_candle
    assert last is not None
    slots = []
    for slot in engine.slots:
        pos = slot.position
        slots.append({"scenario": engine.scenario, "slot_id": slot.slot_id, "real_gains": slot.real_gains, "operational_gains": slot.operational_gains, "value": slot.value, "status": "OPEN" if pos else "FREE", "times_bought": slot.times_bought, "times_sold": slot.times_sold, "total_topup_received": sum(row["actual_topup"] for row in engine.topups_by_slot if row["slot_id"] == slot.slot_id), "entry_if_open": pos.original_entry_price if pos else "", "average_cost_if_open": pos.average_cost if pos else "", "target_if_open": pos.target if pos else "", "cost_basis_if_open": pos.cost_basis if pos else 0.0, "btc_qty_if_open": pos.btc_qty if pos else 0.0, "market_value_if_open": pos.btc_qty * last.close if pos else 0.0, "unrealized_pnl": pos.btc_qty * last.close - pos.cost_basis if pos else 0.0})
    yearly: list[dict] = []
    groups: dict[str, list[dict]] = defaultdict(list)
    for row in engine.monthly: groups[row["month"][:4]].append(row)
    for year, rows in sorted(groups.items()):
        tops = [row for row in engine.monthly_topups if row["month"].startswith(year)]
        yearly.append({"year": year, "scenario": engine.scenario, "start_equity": rows[0]["equity_start"], "end_equity": rows[-1]["equity_end"], "external_topup": sum(row["actual_total"] for row in tops), "cumulative_external_topup": sum(row["actual_total"] for row in engine.monthly_topups if row["month"] <= rows[-1]["month"]), "real_gains": sum(row["real_gains"] for row in rows), "realized_profit": sum(row["realized_profit"] for row in rows), "unrealized_pnl_end": rows[-1]["unrealized_pnl"], "max_open_slots": max(row["max_open_slots"] for row in rows), "average_open_slots": weighted(rows, "average_open_slots"), "cycles": sum(row["cycles"] for row in rows), "months_with_topup": sum(row["actual_total"] > 0 for row in tops), "months_at_1000_cap": sum(row["actual_total"] >= 1000 - 1e-8 for row in tops), "average_effective_topup_rate": statistics.mean([row["effective_rate"] for row in tops]) if tops else 0.0, "btc_holdings_end": rows[-1]["btc_holdings_end"]})
    impacts: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for row in engine.topups_by_slot: impacts[(row["scenario"], row["month"])].append(row)
    impact_rows = [{"scenario": scenario, "month": month, "topup_events": len(rows), "total_topup": sum(row["actual_topup"] for row in rows), "average_cost_before": statistics.mean(row["old_average_cost"] for row in rows), "average_cost_after": statistics.mean(row["new_average_cost"] for row in rows), "average_distance_to_target_before_pct": statistics.mean(row["distance_to_target_before_pct"] for row in rows), "average_distance_to_target_after_pct": statistics.mean(row["distance_to_target_after_pct"] for row in rows), "average_distance_reduction_pct_points": statistics.mean(row["distance_reduction_pct_points"] for row in rows)} for (scenario, month), rows in sorted(impacts.items())]
    saturation = [{"scenario": engine.scenario, "capacity": engine.config.slots, "max_open_slots": engine.max_open_slots, "days_full": len(engine._days_at_full), "days_open_80": len(engine._days_open_80), "longest_full_period_minutes": max((row["duration_minutes"] for row in engine.saturation if row["threshold"] == engine.config.slots), default=0.0), "largest_open_period_minutes": longest_cycle_minutes(engine), "longest_no_gain_minutes": longest_no_gain_minutes(engine)}]
    return {"monthly": engine.monthly, "yearly": yearly, "monthly_topups": engine.monthly_topups, "slot_topups": engine.topups_by_slot, "slots": slots, "trades": engine.trades, "cycles": engine.cycles, "saturation": saturation, "impact": impact_rows}


def write_detail(output: Path, code: str, engine: V7Engine) -> None:
    for name, rows in detail_rows(engine).items():
        fields = list(rows[0]) if rows else {"monthly": list(engine.monthly[0]), "yearly": ["year", "scenario"], "monthly_topups": list(engine.monthly_topups[0]), "slot_topups": ["month", "scenario", "slot_id"], "slots": ["scenario", "slot_id"], "trades": ["scenario", "cycle_id"], "cycles": ["scenario", "cycle_id"], "saturation": ["scenario", "capacity"], "impact": ["scenario", "month"]}[name]
        write_csv(output / f"detail_{code}_{name}.csv", rows, fields)


def run_scenario(output: Path, code: str) -> None:
    label, config = SCENARIOS[code]
    cache = ROOT / "backtest-data"
    engine = V7Engine(config, code).run(load_cached_klines(cache, START, END, read_daily_fills(cache, START, END)))
    result = summary(code, label, engine)
    if code in REFERENCES: assert_control(code, result)
    (output / f"scenario_{code}.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    write_detail(output, code, engine)
    print(output / f"scenario_{code}.json")


def concat_details(output: Path, name: str) -> None:
    rows: list[dict] = []
    for code in SCENARIOS:
        path = output / f"detail_{code}_{name}.csv"
        with path.open(encoding="utf-8", newline="") as handle: rows.extend(csv.DictReader(handle))
    fields = list(rows[0]) if rows else ["scenario"]
    output_name = {"monthly": "monthly_v7.csv", "yearly": "yearly_v7.csv", "monthly_topups": "monthly_topups_v7.csv", "slot_topups": "topups_by_slot_v7.csv", "slots": "slots_v7.csv", "trades": "trades_v7.csv", "cycles": "cycles_v7.csv", "saturation": "saturation_v7.csv", "impact": "average_cost_impact_v7.csv"}[name]
    write_csv(output / output_name, rows, fields)


def finalize(output: Path) -> None:
    results = [json.loads((output / f"scenario_{code}.json").read_text(encoding="utf-8")) for code in SCENARIOS]
    for name in ["monthly", "yearly", "monthly_topups", "slot_topups", "slots", "trades", "cycles", "saturation", "impact"]: concat_details(output, name)
    write_csv(output / "comparison_v7.csv", results, list(results[0]))
    accounting = {row["scenario"]: {"initial_capital": row["initial_capital"], "external_topups": row["external_topups"], "realized_trading_result": row["realized_profit"], "unrealized_pnl": row["open_pnl"], "final_equity": row["final_equity"], "difference": row["accounting_difference"]} for row in results}
    (output / "accounting_v7.json").write_text(json.dumps(accounting, indent=2), encoding="utf-8")
    cache = ROOT / "backtest-data"; raw, first, last, _ = profile_gaps(cache, START, END); fills = read_daily_fills(cache, START, END); effective, _, _, gaps = profile_effective_series(cache, START, END, fills)
    doc = {"period": {"first_timestamp": first.isoformat(), "last_timestamp": last.isoformat(), "raw_candles": raw, "effective_candles": effective, "remaining_gaps": len(gaps), "remaining_missing_minutes": sum(row["missing_minutes"] for row in gaps)}, "formula": "No fechamento UTC: aporte_i = custo_i * min(0.02, 1000/soma_dos_custos_abertos); BTC adicional = aporte_i/preço_close; novo alvo = (novo_custo/nova_qty)*1.01.", "scenarios": results}
    (output / "summary_v7.json").write_text(json.dumps(doc, indent=2), encoding="utf-8")
    (output / "README.md").write_text("# BTC V7 — aportes somente em posições abertas\n\nAportes ocorrem uma vez no último candle UTC de cada mês, depois do trading. Slots livres nunca recebem. O teto de 1.000 USDT é global; não há dívida. O aporte compra BTC no close, recalcula custo médio e alvo de +1%, sem incrementar gains reais.\n", encoding="utf-8")
    lines=["# Backtest BTC V7", "", "| Cenário | Equity | Aporte externo | Lucro sobre capital total | Retorno sobre capital total | Gains | Máx. aberto |", "|---|---:|---:|---:|---:|---:|---:|"]
    lines += [f"| {row['scenario']} | {row['final_equity']:.2f} | {row['external_topups']:.2f} | {row['net_profit_vs_contributed']:.2f} | {row['return_on_contributed_pct']:.2f}% | {row['real_gains']} | {row['max_open_slots']} |" for row in results]
    (output / "summary_v7.md").write_text("\n".join(lines)+"\n", encoding="utf-8")
    print(output)


def main() -> int:
    parser=argparse.ArgumentParser(description=__doc__); parser.add_argument("--output",type=Path,required=True); parser.add_argument("--scenario",choices=SCENARIOS); parser.add_argument("--finalize",action="store_true"); args=parser.parse_args(); args.output.mkdir(parents=True,exist_ok=True)
    if args.scenario: run_scenario(args.output,args.scenario)
    elif args.finalize: finalize(args.output)
    else: raise SystemExit("informe --scenario ou --finalize")
    return 0

if __name__=="__main__": raise SystemExit(main())
