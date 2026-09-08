"""Executa o V6 local: 50 slots, 2% fixo e redistribuição só do excedente mensal."""

from __future__ import annotations

import argparse
import csv
import json
import math
import statistics
from collections import defaultdict
from datetime import date, datetime
from pathlib import Path

from backtest_btc_v2 import END, ROOT, profile_effective_series, profile_gaps, read_daily_fills, write_csv
from v2_grid_engine import Candle, load_cached_klines
from v6_engine import V6Config, V6Engine

START = date(2017, 8, 17)
SCENARIOS = {
    "A": ("Controle: 50x10, 2% fixo, sem redistribuição", V6Config(slots=50, monthly_cap=None)),
    "B": ("V6 principal: teto mensal 3", V6Config(slots=50, monthly_cap=3)),
    "C": ("V6: teto mensal 2", V6Config(slots=50, monthly_cap=2)),
    "D": ("V6: teto mensal 4", V6Config(slots=50, monthly_cap=4)),
    "E": ("V6: teto mensal 5", V6Config(slots=50, monthly_cap=5)),
}
CONTROL_REFERENCE = {"real_gains": 8012, "final_equity": 3242.652663682764, "max_open_slots": 42, "days_open_50": 0}


def _weighted_average(monthly: list[dict], key: str) -> float:
    count = sum(row["candle_count"] for row in monthly)
    return sum(row[key] * row["candle_count"] for row in monthly) / count


def scenario_summary(code: str, label: str, engine: V6Engine) -> dict:
    last = engine._last_candle
    assert last is not None
    initial = engine.config.slots * engine.config.initial_value
    equity = engine.equity(last.close)
    open_pnl = engine.open_pnl(last.close)
    accounting = initial + engine.realized_profit + open_pnl
    if not math.isclose(accounting, equity, abs_tol=1e-8):
        raise AssertionError(f"contabilidade não fecha no cenário {code}")
    gains = [row["real_gains"] for row in engine.monthly]
    distribution = engine._distribution()
    return {
        "scenario": code,
        "description": label,
        "monthly_cap": engine.config.monthly_cap if engine.config.monthly_cap is not None else "NONE",
        "initial_capital": initial,
        "final_equity": equity,
        "equity_multiple": equity / initial,
        "return_pct": (equity / initial - 1) * 100,
        "real_gains": len(engine.trades),
        "gains_per_100_initial": len(engine.trades) / initial * 100,
        "realized_profit": engine.realized_profit,
        "open_pnl": open_pnl,
        "max_open_slots": engine.max_open_slots,
        "average_open_slots": _weighted_average(engine.monthly, "average_open_slots"),
        "days_open_ge_25": len(engine._days_open_ge_25),
        "days_open_ge_40": len(engine._days_open_ge_40),
        "days_open_50": len(engine._days_at_full),
        "complete_cycles": engine.complete_cycles,
        "monthly_gains_average": statistics.mean(gains),
        "monthly_gains_median": statistics.median(gains),
        "total_monthly_excess": sum(row["monthly_excess_gains"] for row in engine.monthly),
        "total_redistributed_equivalent": sum(row["redistributed_gain_equivalent"] for row in engine.monthly),
        "total_redistributed_value": engine.total_redistributed,
        "locked_monthly_excess": sum(row["locked_monthly_excess"] for row in engine.monthly),
        "unredistributed_monthly_excess": sum(row["unredistributed_monthly_excess"] for row in engine.monthly),
        "current_btc_holdings": engine.btc_holdings(),
        "external_topup": 0.0,
        "accounting_difference": accounting - equity,
        **distribution,
    }


def assert_control(summary: dict) -> None:
    for key, expected in CONTROL_REFERENCE.items():
        actual = summary[key]
        if isinstance(expected, float):
            if not math.isclose(actual, expected, abs_tol=1e-8, rel_tol=1e-12):
                raise AssertionError(f"controle V6 divergiu em {key}: {actual} != {expected}")
        elif actual != expected:
            raise AssertionError(f"controle V6 divergiu em {key}: {actual} != {expected}")


def yearly_rows(monthly: list[dict]) -> list[dict]:
    groups: dict[str, list[dict]] = defaultdict(list)
    for row in monthly:
        groups[row["month"][:4]].append(row)
    rows = []
    for year, values in sorted(groups.items()):
        start, end = values[0], values[-1]
        rows.append(
            {
                "year": year,
                "real_gains": sum(row["real_gains"] for row in values),
                "start_equity": start["equity_start"],
                "end_equity": end["equity_end"],
                "return_pct": (end["equity_end"] / start["equity_start"] - 1) * 100,
                "max_open_slots": max(row["max_open_slots"] for row in values),
                "average_open_slots": _weighted_average(values, "average_open_slots"),
                "cycles": sum(row["cycles"] for row in values),
                "redistributed_value": sum(row["redistributed_value"] for row in values),
                "gini_slot_value": end["gini_slot_value"],
                "gini_operational_gains": end["gini_operational_gains"],
                "largest_slot": end["largest_slot"],
                "smallest_slot": end["smallest_slot"],
                "median_slot": end["median_slot"],
            }
        )
    return rows


def saturation_rows(engine: V6Engine) -> list[dict]:
    return [
        {"threshold": 25, "days_at_or_above": len(engine._days_open_ge_25), "period_count": sum(row["threshold"] == 25 for row in engine.saturation), "total_duration_minutes": sum(row["duration_minutes"] for row in engine.saturation if row["threshold"] == 25), "max_open_slots": engine.max_open_slots},
        {"threshold": 40, "days_at_or_above": len(engine._days_open_ge_40), "period_count": sum(row["threshold"] == 40 for row in engine.saturation), "total_duration_minutes": sum(row["duration_minutes"] for row in engine.saturation if row["threshold"] == 40), "max_open_slots": engine.max_open_slots},
        {"threshold": 50, "days_at_or_above": len(engine._days_at_full), "period_count": sum(row["threshold"] == 50 for row in engine.saturation), "total_duration_minutes": sum(row["duration_minutes"] for row in engine.saturation if row["threshold"] == 50), "max_open_slots": engine.max_open_slots},
    ]


def write_principal(output: Path, engine: V6Engine, summary: dict) -> None:
    last = engine._last_candle
    assert last is not None
    slots = []
    for slot in engine.slots:
        position = slot.position
        market = position.btc_qty * last.close if position else 0.0
        slots.append(
            {
                "slot_id": slot.slot_id,
                "real_gains_total": slot.real_gains,
                "operational_gains": slot.operational_gains,
                "final_value": slot.value,
                "status": "OPEN" if position else "FREE",
                "times_bought": slot.times_bought,
                "times_sold": slot.times_sold,
                "months_as_donor": engine._months_as_donor[slot.slot_id],
                "months_as_receiver": engine._months_as_receiver[slot.slot_id],
                "total_value_donated": slot.donated,
                "total_value_received": slot.received,
                "entry_if_open": position.entry if position else "",
                "target_if_open": position.target if position else "",
                "btc_qty_if_open": position.btc_qty if position else 0.0,
                "unrealized_pnl": market - position.value_at_entry if position else 0.0,
            }
        )
    accounting = {
        "capital_initial": summary["initial_capital"],
        "external_topup": 0.0,
        "realized_profit": summary["realized_profit"],
        "open_pnl": summary["open_pnl"],
        "patrimony_final": summary["final_equity"],
        "difference": summary["accounting_difference"],
    }
    write_csv(output / "monthly_v6.csv", engine.monthly, list(engine.monthly[0]))
    years = yearly_rows(engine.monthly)
    write_csv(output / "yearly_v6.csv", years, list(years[0]))
    write_csv(output / "slots_v6.csv", slots, list(slots[0]))
    write_csv(output / "trades_v6.csv", engine.trades, list(engine.trades[0]))
    write_csv(output / "cycles_v6.csv", engine.cycles, ["cycle_id", "start", "end", "anchor", "trades", "status"])
    write_csv(output / "redistributions_v6.csv", engine.redistributions, ["month", "donor_slot", "receiver_slot", "donor_real_gains_month", "donor_real_gains_total", "receiver_real_gains_month", "donor_value_before", "donor_value_after", "receiver_value_before", "receiver_value_after", "gain_equivalent", "value_transferred"])
    rows = saturation_rows(engine)
    write_csv(output / "saturation_v6.csv", rows, list(rows[0]))
    (output / "accounting_v6.json").write_text(json.dumps({"B": accounting}, indent=2), encoding="utf-8")


def run_scenario(output: Path, code: str) -> None:
    label, config = SCENARIOS[code]
    cache = ROOT / "backtest-data"
    fills = read_daily_fills(cache, START, END)
    engine = V6Engine(config).run(load_cached_klines(cache, START, END, fills))
    summary = scenario_summary(code, label, engine)
    if code == "A":
        assert_control(summary)
    (output / f"scenario_{code}.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    if code == "B":
        write_principal(output, engine, summary)
    print(output / f"scenario_{code}.json")


def finalize(output: Path) -> None:
    scenarios = [json.loads((output / f"scenario_{code}.json").read_text(encoding="utf-8")) for code in SCENARIOS]
    cache = ROOT / "backtest-data"
    raw_count, first, last, _ = profile_gaps(cache, START, END)
    fills = read_daily_fills(cache, START, END)
    effective_count, _, _, effective_gaps = profile_effective_series(cache, START, END, fills)
    comparison = scenarios
    write_csv(output / "comparison_v6.csv", comparison, list(comparison[0]))
    accounting = {
        row["scenario"]: {
            "capital_initial": row["initial_capital"],
            "external_topup": 0.0,
            "realized_profit": row["realized_profit"],
            "open_pnl": row["open_pnl"],
            "patrimony_final": row["final_equity"],
            "difference": row["accounting_difference"],
        }
        for row in scenarios
    }
    (output / "accounting_v6.json").write_text(json.dumps(accounting, indent=2), encoding="utf-8")
    summary = {
        "period": {
            "first_timestamp": first.isoformat() if first else "",
            "last_timestamp": last.isoformat() if last else "",
            "days": (last.date() - first.date()).days + 1 if first and last else 0,
            "raw_candles": raw_count,
            "official_daily_rows_read": len(fills),
            "effective_candles": effective_count,
            "remaining_gaps": len(effective_gaps),
            "remaining_missing_minutes": sum(row["missing_minutes"] for row in effective_gaps),
        },
        "financial_formula": "por ganho equivalente transferido: valor_doador_depois = valor_doador_antes / 1.01; valor_transferido = antes - depois; valor_receptor_depois = antes + valor_transferido",
        "scenarios": scenarios,
    }
    (output / "summary_v6.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    (output / "README.md").write_text(
        "# BTC V6 — 50 slots, 2% fixo e redistribuição do excedente mensal\n\n"
        "O trading é idêntico ao controle B do V5: grade linear reciclável de 2%, gain líquido de 1%, sem aporte e sem ATH. "
        "No fechamento UTC, apenas gains reais do mês acima do teto são elegíveis. Para cada equivalente transferido, o valor do doador é dividido por 1,01 e a diferença é creditada ao receptor. "
        "Slots abertos não doam nem recebem; seu excedente mensal fica bloqueado somente para auditoria e não vira obrigação no mês seguinte. "
        "Recebedores livres são ordenados por menor equivalente mensal, menor operational_gains, menor valor e slot_id.\n",
        encoding="utf-8",
    )
    lines = ["# Backtest BTC V6", "", "| Cenário | Teto mensal | Equity final | Retorno | Gains | Máx. abertos | Dias 50 | Redistribuído | Gini valor |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|"]
    lines.extend(
        f"| {row['scenario']} | {row['monthly_cap']} | {row['final_equity']:.2f} | {row['return_pct']:.2f}% | {row['real_gains']} | {row['max_open_slots']} | {row['days_open_50']} | {row['total_redistributed_value']:.2f} | {row['gini_slot_value']:.4f} |"
        for row in scenarios
    )
    (output / "summary_v6.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
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
