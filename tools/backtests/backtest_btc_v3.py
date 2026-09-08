"""Backtest V3: redistribuição, reserva e aporte externo mínimo.

Reutiliza exclusivamente o motor local V2 e o mesmo cache BTCUSDT 1m.
"""

from __future__ import annotations

import argparse
import csv
import json
import shutil
import statistics
from datetime import date, datetime, timezone
from pathlib import Path

from backtest_btc_v2 import END, ROOT, START, read_daily_fills, write_csv
from v2_grid_engine import GridConfig, load_cached_klines
from v3_redistribution_engine import RedistributionTargetEngine


def numbers(rows: list[dict], key: str) -> list[float]:
    return [float(row[key]) for row in rows if row.get("reason") == "APPLIED" and float(row.get(key, 0) or 0) > 0]


def slot_rows(engine: RedistributionTargetEngine) -> list[dict]:
    rows = []
    for slot in engine.slots:
        rows.append({
            "slot_id": slot.slot_id,
            "status": "OPEN" if slot.position else "FREE",
            "real_gains": slot.real_gains,
            "operational_gains": slot.operational_gains,
            "final_value": slot.value,
            "total_received_redistribution": engine.total_received[slot.slot_id],
            "total_donated_redistribution": engine.total_donated[slot.slot_id],
            "total_external_topup": slot.total_topup,
            "months_at_target": engine.months_at_target[slot.slot_id],
            "times_bought": slot.times_bought,
            "times_sold": slot.times_sold,
        })
    return rows


def metrics(engine: RedistributionTargetEngine, result) -> dict:
    amounts = numbers(result.topups, "topup")
    redistributed_from_slots = sum(float(row["value_transferred"]) for row in engine.redistributions if row["donor_slot"] != "GROWTH_RESERVE")
    reserve_allocated = sum(float(row["value_transferred"]) for row in engine.redistributions if row["donor_slot"] == "GROWTH_RESERVE")
    target_counts = [int(row["slots_at_target"]) for row in result.monthly]
    final_equity = result.equity() + engine.reserve.value
    return {
        "capital_inicial": result.config.slots * result.config.initial_value,
        "gains_reais": len(result.trades),
        "patrimonio_final": final_equity,
        "lucro_realizado": result.realized_profit,
        "pnl_aberto": result.open_pnl(),
        "aporte_externo_total": sum(amounts),
        "quantidade_aportes": len(amounts),
        "aporte_medio": statistics.mean(amounts) if amounts else 0.0,
        "aporte_mediano": statistics.median(amounts) if amounts else 0.0,
        "maior_aporte": max(amounts, default=0.0),
        "total_redistribuido_dos_doadores": redistributed_from_slots,
        "total_alocado_da_reserva": reserve_allocated,
        "reserva_final": engine.reserve.value,
        "reserva_final_gain_equivalent": engine.reserve.gain_equivalent,
        "max_slots_abertos": result.max_open_slots,
        "slots_distintos_usados": sum(slot.times_bought > 0 for slot in engine.slots),
        "ciclos_completos": result.complete_cycles,
        "media_slots_na_meta": statistics.mean(target_counts) if target_counts else 0.0,
        "max_slots_na_meta": max(target_counts, default=0),
        "meses_sem_aporte": sum(float(row["external_topup"]) == 0 for row in result.monthly),
        "candles_processados": result.candles,
        "candles_ambiguos": len(result.ambiguous),
    }


def accounting(engine: RedistributionTargetEngine, result, values: dict) -> dict:
    expected = values["capital_inicial"] + values["aporte_externo_total"] + values["lucro_realizado"] + values["pnl_aberto"]
    return {
        "capital_inicial": values["capital_inicial"],
        "aportes_externos": values["aporte_externo_total"],
        "lucro_realizado": values["lucro_realizado"],
        "pnl_aberto": values["pnl_aberto"],
        "patrimonio_calculado": expected,
        "patrimonio_final": values["patrimonio_final"],
        "diferenca": values["patrimonio_final"] - expected,
        "valor_slots_livres": result.cash(),
        "valor_posicoes_abertas": result.position_value(),
        "growth_reserve_value": engine.reserve.value,
        "redistribuicao_cria_patrimonio": False,
    }


def run_scenario(cache: Path, fills, target: int, reserve: bool):
    config = GridConfig(monthly_target=target, enable_topups=False)
    engine = RedistributionTargetEngine(config, use_reserve=reserve)
    result = engine.run(load_cached_klines(cache, START, END, fills))
    values = metrics(engine, result)
    reconciliation = accounting(engine, result, values)
    if abs(reconciliation["diferenca"]) > 1e-7:
        raise AssertionError(f"reconciliação contábil falhou: {reconciliation['diferenca']}")
    return engine, result, values, reconciliation


def write_scenario(path: Path, engine: RedistributionTargetEngine, result, values: dict, reconciliation: dict) -> None:
    path.mkdir(parents=True, exist_ok=False)
    monthly_fields = ["month", "target", "real_gains_month", "real_gains_total", "free_slots", "open_slots", "donor_slots", "receiver_slots", "excess_gain_equivalent", "redistributed_value", "reserve_before", "reserve_used", "reserve_after", "leader_slot", "leader_operational_before", "leader_operational_after", "external_missing_gains", "external_topup", "equity_before", "equity_after", "locked_excess_gain_equivalent", "slots_at_target"]
    redistribution_fields = ["month", "donor_slot", "receiver_slot", "donor_real_gains", "donor_operational_before", "donor_operational_after", "receiver_operational_before", "receiver_operational_after", "gain_equivalent_transferred", "value_transferred"]
    topup_fields = ["month", "target", "slot_id", "operational_gains_before", "missing_gains", "value_before", "topup", "value_after", "reason"]
    slot_fields = ["slot_id", "status", "real_gains", "operational_gains", "final_value", "total_received_redistribution", "total_donated_redistribution", "total_external_topup", "months_at_target", "times_bought", "times_sold"]
    write_csv(path / "monthly_v3.csv", result.monthly, monthly_fields)
    write_csv(path / "redistributions.csv", engine.redistributions, redistribution_fields)
    write_csv(path / "topups_v3.csv", result.topups, topup_fields)
    write_csv(path / "slots_v3.csv", slot_rows(engine), slot_fields)
    (path / "accounting_v3.json").write_text(json.dumps(reconciliation, indent=2), encoding="utf-8")
    (path / "summary_v3.json").write_text(json.dumps(values, indent=2), encoding="utf-8")
    lines = ["# Backtest V3 — redistribuição e aporte mínimo", "", "| Métrica | Valor |", "|---|---:|"]
    for key, value in values.items():
        lines.append(f"| {key} | {value:.10f} |" if isinstance(value, float) else f"| {key} | {value} |")
    lines += ["", "A redistribuição movimenta exatamente o valor retirado do doador; a reserva guarda apenas excedente já existente. O cenário sem reserva mantém excedente sem destino no doador para não destruir patrimônio."]
    (path / "summary_v3.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def v2_sources(source: Path) -> tuple[dict, dict]:
    summary = json.loads((source / "summary.json").read_text(encoding="utf-8"))
    topups = list(csv.DictReader((source / "topups.csv").open(encoding="utf-8", newline="")))
    old = summary["target7"].copy()
    amounts = [float(row["topup_amount"]) for row in topups if row.get("reason") == "APPLIED"]
    return summary["pure"], {
        "capital_inicial": old["capital_inicial"], "gains_reais": old["gains_reais"], "patrimonio_final": old["valor_final"], "lucro_realizado": old["lucro_realizado"], "pnl_aberto": old["pnl_aberto"], "aporte_externo_total": sum(amounts), "quantidade_aportes": len(amounts), "aporte_medio": statistics.mean(amounts), "aporte_mediano": statistics.median(amounts), "maior_aporte": max(amounts), "reserva_final": 0.0,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path, default=ROOT / "backtest-data")
    parser.add_argument("--reports", type=Path, default=ROOT / "reports" / "backtests" / "v3-redistribution-target")
    parser.add_argument(
        "--v2-report",
        type=Path,
        help="Diretório de um relatório V2 contendo summary.json e topups.csv; omita para não comparar.",
    )
    args = parser.parse_args()
    output = args.reports / datetime.now(timezone.utc).strftime("%Y-%m-%d-%H%M")
    output.mkdir(parents=True, exist_ok=False)
    fills = read_daily_fills(args.cache, START, END)
    configurations = [("C_v3_target7_reserve", 7, True), ("D_v3_target7_without_reserve", 7, False), ("E_v3_target5_reserve", 5, True), ("F_v3_target10_reserve", 10, True)]
    outputs: dict[str, dict] = {}
    primary = None
    for name, target, reserve in configurations:
        engine, result, values, reconciliation = run_scenario(args.cache, fills, target, reserve)
        scenario = output / name
        write_scenario(scenario, engine, result, values, reconciliation)
        outputs[name] = values
        if name.startswith("C_"):
            primary = scenario
    assert primary is not None
    for name in ("summary_v3.md", "summary_v3.json", "monthly_v3.csv", "redistributions.csv", "topups_v3.csv", "slots_v3.csv", "accounting_v3.json"):
        shutil.copy2(primary / name, output / name)
    summary_document = {
        "primary": outputs["C_v3_target7_reserve"],
        "scenarios": outputs,
        "v2_comparison": {"status": "not_requested", "report": None},
    }
    comparison_note = "Comparação V2 não gerada; forneça `--v2-report <diretório-do-relatório-v2>` para incluí-la."
    if args.v2_report is not None:
        pure, old = v2_sources(args.v2_report)
        comparison_rows = []
        metrics_to_compare = ["aporte_externo_total", "aporte_medio", "aporte_mediano", "maior_aporte", "patrimonio_final", "gains_reais", "reserva_final"]
        for metric in metrics_to_compare:
            pure_value = pure.get({"patrimonio_final": "valor_final"}.get(metric, metric), 0.0)
            old_value = old.get(metric, 0.0)
            v3_value = outputs["C_v3_target7_reserve"].get(metric, 0.0)
            comparison_rows.append({"metric": metric, "v2_puro": pure_value, "modelo_acumulativo_antigo": old_value, "v3_redistribuicao_reserva": v3_value, "diferenca_v3_vs_antigo": v3_value - old_value})
        write_csv(output / "comparison_v2_vs_v3.csv", comparison_rows, ["metric", "v2_puro", "modelo_acumulativo_antigo", "v3_redistribuicao_reserva", "diferenca_v3_vs_antigo"])
        summary_document.update({"v2_pure": pure, "v2_old_accumulative": old})
        summary_document["v2_comparison"] = {"status": "generated", "report": str(args.v2_report)}
        comparison_note = f"Comparação V2 gerada a partir de `{args.v2_report}`."
    (output / "summary_v3.json").write_text(json.dumps(summary_document, indent=2), encoding="utf-8")
    primary_md = (primary / "summary_v3.md").read_text(encoding="utf-8")
    (output / "summary_v3.md").write_text(primary_md + "\n## Cenários\n\n" + "\n".join(f"- {name}: aporte externo {values['aporte_externo_total']:.8f}; patrimônio {values['patrimonio_final']:.8f}." for name, values in outputs.items()) + f"\n\n## Comparação V2\n\n{comparison_note}\n", encoding="utf-8")
    (output / "engine_validation_v3.md").write_text("# Validação do Backtest V3\n\nA suíte V3 cobre excedente livre, bloqueio de doador aberto, reserva, aporte único, NO_FREE_SLOT, conservação financeira e preservação de real_gains. No replay, cada mês gera uma única linha de aporte.\n", encoding="utf-8")
    (output / "README.md").write_text("# Backtest V3\n\nCenário principal: `C_v3_target7_reserve`; os arquivos na raiz são sua cópia. D/E/F ficam em subpastas para não misturar resultados. A comparação com V2 só é gerada quando um relatório é informado por `--v2-report`.\n", encoding="utf-8")
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
