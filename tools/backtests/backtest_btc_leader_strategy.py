"""Executa cenarios e recortes do backtest BTCUSDT de slot lider."""

from __future__ import annotations

import argparse
import json
import shutil
from datetime import date, datetime, timezone
from pathlib import Path

from backtest_engine import BacktestEngine, load_cached_klines
from download_binance_klines import download_range
from report_backtest import write_before_after_audit, write_csv, write_result
from strategy_slot_leader import StrategyConfig

ROOT = Path(__file__).resolve().parents[2]
HISTORY_START = date(2017, 8, 1)


def latest_n_years(today: date, years: int) -> date:
    try:
        return today.replace(year=today.year - years)
    except ValueError:
        return today.replace(year=today.year - years, month=2, day=28)


def run_scenario(cache: Path, output: Path, start: date, end: date, interval: str, mode: str, topups: bool, entry_priority: str = "leader") -> dict:
    result = BacktestEngine(StrategyConfig(enable_topups=topups, entry_priority=entry_priority), interval, mode).run(load_cached_klines(cache, "BTCUSDT", interval, start, end))
    summary = write_result(result, output)
    summary["cenario"] = f"{interval}-{mode}-{'com-aporte' if topups else 'sem-aporte'}"
    summary["recorte_inicio"] = start.isoformat()
    return summary


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--start", type=date.fromisoformat, default=HISTORY_START)
    parser.add_argument("--end", type=date.fromisoformat, default=date.today())
    parser.add_argument("--cache", type=Path, default=ROOT / "backtest-data")
    parser.add_argument("--reports", type=Path, default=ROOT / "reports" / "backtests" / "slot-control-btc-leader")
    parser.add_argument("--download", action="store_true")
    parser.add_argument("--run-all", action="store_true")
    parser.add_argument("--entry-priority", choices=("leader", "slot-number"), default="leader")
    parser.add_argument("--scenario-only", action="store_true", help="Gera somente um cenário em --output-name.")
    parser.add_argument("--output-name", default="scenario-personalizado")
    parser.add_argument("--baseline-summary", type=Path, help="summary.json anterior para a comparacao forense before/after.")
    args = parser.parse_args()
    if args.end < args.start:
        parser.error("--end deve ser posterior a --start")
    if args.download:
        download_range("BTCUSDT", "1m", args.start, args.end, args.cache)
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d-%H%M")
    report_root = args.reports / args.output_name if args.scenario_only else args.reports / stamp
    report_root.mkdir(parents=True, exist_ok=False)
    scenario_dir = report_root if args.scenario_only else report_root / "scenario-a-1m-heuristic"
    comparisons = [run_scenario(args.cache, scenario_dir, args.start, args.end, "1m", "heuristic", True, args.entry_priority)]
    if args.baseline_summary:
        old_summary = json.loads(args.baseline_summary.read_text(encoding="utf-8"))
        write_before_after_audit(scenario_dir, old_summary, comparisons[0])
    if args.scenario_only:
        print(f"Relatorio principal: {report_root}")
        return 0
    if args.run_all:
        comparisons.extend([
            run_scenario(args.cache, report_root / "scenario-b-1m-conservative", args.start, args.end, "1m", "conservative", True),
            run_scenario(args.cache, report_root / "scenario-d-1m-sem-aporte", args.start, args.end, "1m", "heuristic", False),
        ])
        full_history = dict(comparisons[0])
        full_history["cenario"] = "recorte-historico-completo"
        comparisons.append(full_history)
        cuts = [("2018-01-01", max(args.start, date(2018, 1, 1))), ("2020-01-01", max(args.start, date(2020, 1, 1))), ("2021-11-10-topo", max(args.start, date(2021, 11, 10))), ("2022-11-21-fundo", max(args.start, date(2022, 11, 21))), ("ultimos-8-anos", max(args.start, latest_n_years(args.end, 8))), ("ultimos-5-anos", max(args.start, latest_n_years(args.end, 5)))]
        for name, start in cuts:
            if start <= args.end:
                comparisons.append(run_scenario(args.cache, report_root / "recortes" / name, start, args.end, "1m", "heuristic", True))
    fields = ["cenario", "recorte_inicio", "intervalo_usado", "modo_intrabar", "candles_processados", "capital_inicial", "total_aportado_do_bolso", "saldo_de_caixa", "patrimonio_final", "lucro_realizado", "pnl_aberto", "gains_reais", "trades_fechados", "meses", "meses_com_aporte", "meses_sem_slot_livre", "maior_quantidade_slots_presos", "maximo_drawdown_operacional_percentual", "candles_ambiguos"]
    write_csv(report_root / "comparison.csv", comparisons, fields)
    primary = report_root / "scenario-a-1m-heuristic"
    for name in ("summary.md", "summary.json", "monthly.csv", "yearly.csv", "trades.csv", "topups.csv", "slots.csv", "ambiguous_candles.csv", "README.md"):
        shutil.copy2(primary / name, report_root / name)
    print(f"Relatorio principal: {report_root}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
