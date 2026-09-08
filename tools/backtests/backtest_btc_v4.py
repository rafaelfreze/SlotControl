"""Backtest V4: teto em BRL, câmbio BCB, BTC em custódia e recuperação."""

from __future__ import annotations

import argparse
import copy
import csv
import json
import math
import shutil
import statistics
import urllib.parse
import urllib.request
from datetime import date, datetime, timezone
from pathlib import Path

from backtest_btc_v2 import END, ROOT, START, read_daily_fills, write_csv
from v2_grid_engine import GridConfig, load_cached_klines
from v4_capped_engine import CappedContributionEngine

BCB_URL = "https://api.bcb.gov.br/dados/serie/bcdata.sgs.1/dados?"  # SGS 1: dólar comercial venda.


def fetch_bcb_monthly_fx(cache: Path) -> tuple[dict[str, float], list[dict]]:
    target = cache / "bcb-sgs-1-usdbrl.json"
    if target.exists():
        rows = json.loads(target.read_text(encoding="utf-8"))
    else:
        query = urllib.parse.urlencode({"formato": "json", "dataInicial": START.strftime("%d/%m/%Y"), "dataFinal": END.strftime("%d/%m/%Y")})
        with urllib.request.urlopen(BCB_URL + query, timeout=90) as response:
            rows = json.loads(response.read().decode("utf-8"))
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(rows), encoding="utf-8")
    rates = sorted((datetime.strptime(row["data"], "%d/%m/%Y").date(), float(row["valor"].replace(",", "."))) for row in rows)
    monthly: dict[str, float] = {}
    output: list[dict] = []
    cursor = date(START.year, START.month, 1)
    last = None
    index = 0
    while cursor <= END:
        next_month = date(cursor.year + (cursor.month == 12), 1 if cursor.month == 12 else cursor.month + 1, 1)
        while index < len(rates) and rates[index][0] < next_month:
            last = rates[index]
            index += 1
        key = f"{cursor.year:04d}-{cursor.month:02d}"
        if last is None:
            raise ValueError(f"BCB SGS 1 sem cotação para {key}")
        monthly[key] = last[1]
        output.append({"month": key, "rate_date": last[0].isoformat(), "usd_brl": last[1], "source": "Banco Central do Brasil SGS série 1 (dólar venda diário)"})
        cursor = next_month
    return monthly, output


def v4_metrics(engine: CappedContributionEngine, result) -> dict:
    topups = [row for row in result.topups if float(row["actual_topup_usdt"])]
    brl = [float(row["actual_topup_usdt"]) * float(row["usd_brl"]) for row in topups]
    usdt = [float(row["actual_topup_usdt"]) for row in topups]
    holdings = engine.current_btc_holdings()
    total_equity = result.equity() + engine.reserve_value
    cost = sum(slot.position.value_at_entry for slot in engine.slots if slot.position)
    return {"capital_inicial_usdt": result.config.slots * result.config.initial_value, "gains_reais": len(result.trades), "aporte_total_brl": sum(brl), "aporte_total_usdt": sum(usdt), "aporte_medio_brl_mes_com_aporte": statistics.mean(brl) if brl else 0.0, "aporte_mediano_brl_mes_com_aporte": statistics.median(brl) if brl else 0.0, "aporte_medio_brl_todos_meses": sum(brl) / len(result.monthly), "meses_no_teto": sum(bool(row["hit_cap"]) for row in result.topups), "meses_aporte_parcial": sum(0 < float(row["actual_topup_usdt"]) < float(row["required_topup_usdt"]) for row in result.topups), "meses_sem_aporte": sum(not float(row["actual_topup_usdt"]) for row in result.topups), "maior_aporte_brl": max(brl, default=0.0), "maior_aporte_usdt": max(usdt, default=0.0), "gains_equivalentes_por_aporte": sum(float(row["gain_equivalent_added"]) for row in result.topups), "total_redistribuido": sum(float(row["value_transferred"]) for row in engine.redistributions if row["donor_slot"] != "GROWTH_RESERVE"), "reserva_final": engine.reserve_value, "reserva_final_gain_equivalent": engine.reserve_gain_equivalent, "patrimonio_final": total_equity, "cash_final": result.cash() + engine.reserve_value, "btc_em_aberto": holdings, "valor_btc_em_aberto": result.position_value(), "custo_posicoes": cost, "custo_medio_btc": cost / holdings if holdings else 0.0, "pnl_aberto": result.open_pnl(), "lucro_realizado": result.realized_profit, "max_slots_abertos": result.max_open_slots, "slots_distintos_usados": sum(slot.times_bought > 0 for slot in engine.slots), "ciclos_completos": result.complete_cycles, "candles_processados": result.candles, "candles_ambiguos": len(result.ambiguous), "cumulative_btc_bought": engine.cumulative_btc_bought, "cumulative_btc_sold": engine.cumulative_btc_sold, "btc_turnover": engine.cumulative_btc_bought + engine.cumulative_btc_sold}


def slots_rows(engine: CappedContributionEngine, price: float) -> list[dict]:
    rows = []
    for slot in engine.slots:
        pos = slot.position
        market = pos.btc_qty * price if pos else 0.0
        cost = pos.value_at_entry if pos else 0.0
        rows.append({"slot_id": slot.slot_id, "status": "OPEN" if pos else "FREE", "entry_price": pos.entry_price if pos else "", "btc_qty": pos.btc_qty if pos else 0.0, "cost_basis": cost, "market_value": market, "unrealized_pnl": market - cost, "real_gains": slot.real_gains, "operational_gain_equivalent": slot.operational_gains, "operational_value": slot.value, "total_received_redistribution": engine.total_received[slot.slot_id], "total_donated_redistribution": engine.total_donated[slot.slot_id], "total_external_topup": slot.total_topup, "times_bought": slot.times_bought, "times_sold": slot.times_sold})
    return rows


def final_snapshot(engine: CappedContributionEngine, result) -> list[dict]:
    return slots_rows(engine, result.ending_price)


def recovery_marks(engine: CappedContributionEngine, result, ath: float) -> list[dict]:
    cash = result.cash() + engine.reserve_value
    holdings = engine.current_btc_holdings()
    cost = sum(slot.position.value_at_entry for slot in engine.slots if slot.position)
    rows = []
    for name, multiplier in (("R1_ATH", 1.0), ("R2_ATH_PLUS_10", 1.10), ("R3_ATH_PLUS_25", 1.25), ("R4_ATH_PLUS_50", 1.50)):
        price = ath * multiplier
        market = holdings * price
        rows.append({"scenario": name, "btc_price_scenario": price, "current_btc_holdings": holdings, "market_value_btc": market, "cash": cash, "total_equity": cash + market, "unrealized_pnl": market - cost})
    return rows


def recovery_sales(engine: CappedContributionEngine, result) -> tuple[list[dict], dict]:
    cash = result.cash() + engine.reserve_value
    rows = []
    for slot in sorted((slot for slot in engine.slots if slot.position), key=lambda value: value.position.target_price):
        pos = slot.position
        proceeds = pos.btc_qty * pos.target_price
        additional = proceeds - pos.value_at_entry
        cash += proceeds
        rows.append({"slot_id": slot.slot_id, "sell_price": pos.target_price, "btc_sold": pos.btc_qty, "proceeds_usdt": proceeds, "additional_realized_profit": additional, "cash_after": cash})
    return rows, {"cash_final": cash, "btc_remaining": 0.0, "lucro_realizado_adicional": sum(float(row["additional_realized_profit"]) for row in rows), "patrimonio_final": cash, "preco_quando_ultimo_fechou": max((float(row["sell_price"]) for row in rows), default=result.ending_price)}


def new_ath_restarts(engine: CappedContributionEngine, recovery: dict, ath: float) -> list[dict]:
    leader = min(engine.slots, key=lambda slot: (-slot.operational_gains, -slot.value, slot.slot_id))
    return [{"scenario": label, "entry_price": ath * multiplier, "capital_available": recovery["cash_final"], "slot_id": leader.slot_id, "slot_value": leader.value * 1.01, "btc_qty_new_entry": leader.value * 1.01 / (ath * multiplier), "remaining_free_slots": len(engine.slots) - 1, "reserve": engine.reserve_value} for label, multiplier in (("ATH", 1.0), ("ATH_PLUS_10", 1.10), ("ATH_PLUS_25", 1.25))]


def yearly_rows(result) -> list[dict]:
    groups: dict[str, list[dict]] = {}
    for row in result.monthly:
        groups.setdefault(row["month"][:4], []).append(row)
    rows = []
    for year, values in groups.items():
        brl = [float(row["external_topup"]) * float(row["usd_brl"]) for row in values]
        annual_cap = 12 * float(values[0]["cap_brl"])
        if sum(brl) > annual_cap + 0.000001:
            raise AssertionError(f"teto anual excedido em {year}")
        last = values[-1]
        rows.append({"year": year, "real_gains": sum(int(row["real_gains_month"]) for row in values), "topup_brl_total": sum(brl), "topup_usdt_total": sum(float(row["external_topup"]) for row in values), "average_brl_month": sum(brl) / len(values), "average_usdt_month": sum(float(row["external_topup"]) for row in values) / len(values), "months_with_topup": sum(amount > 0 for amount in brl), "months_at_cap": sum(bool(row["hit_cap"]) for row in values), "largest_required_topup": max(float(row["required_topup_usdt"]) for row in values), "largest_actual_topup": max(float(row["external_topup"]) for row in values), "equity_end": last["equity_after"], "open_slots_end": last["open_slots"]})
    return rows


def write_scenario(path: Path, engine: CappedContributionEngine, result, values: dict) -> None:
    path.mkdir(parents=True, exist_ok=False)
    monthly_fields = list(result.monthly[0])
    topup_fields = list(result.topups[0])
    redistribution_fields = list(engine.redistributions[0]) if engine.redistributions else ["month"]
    write_csv(path / "monthly_v4.csv", result.monthly, monthly_fields)
    write_csv(path / "yearly_v4.csv", yearly_rows(result), ["year", "real_gains", "topup_brl_total", "topup_usdt_total", "average_brl_month", "average_usdt_month", "months_with_topup", "months_at_cap", "largest_required_topup", "largest_actual_topup", "equity_end", "open_slots_end"])
    write_csv(path / "topups_v4.csv", result.topups, topup_fields)
    write_csv(path / "redistributions_v4.csv", engine.redistributions, redistribution_fields)
    write_csv(path / "slots_v4.csv", slots_rows(engine, result.ending_price), list(slots_rows(engine, result.ending_price)[0]))
    (path / "summary_v4.json").write_text(json.dumps(values, indent=2), encoding="utf-8")


def v2_source(source: Path) -> dict:
    return json.loads((source / "summary.json").read_text(encoding="utf-8"))["pure"]


def v3_source(source: Path) -> dict:
    return json.loads((source / "summary_v3.json").read_text(encoding="utf-8"))["primary"]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path, default=ROOT / "backtest-data")
    parser.add_argument("--reports", type=Path, default=ROOT / "reports" / "backtests" / "v4-capped-contributions")
    parser.add_argument(
        "--v2-report",
        type=Path,
        help="Diretório de um relatório V2 contendo summary.json; omita para não incluir V2 na comparação.",
    )
    parser.add_argument(
        "--v3-report",
        type=Path,
        help="Diretório de um relatório V3 contendo summary_v3.json; omita para não incluir V3 na comparação.",
    )
    args = parser.parse_args()
    output = args.reports / datetime.now(timezone.utc).strftime("%Y-%m-%d-%H%M")
    output.mkdir(parents=True, exist_ok=False)
    fx, fx_rows = fetch_bcb_monthly_fx(ROOT / "backtest-cache")
    fills = read_daily_fills(args.cache, START, END)
    configurations = [("C_v4_brl3000_historical", 3000.0, fx), ("D_v4_brl3000_fixed5", 3000.0, {month: 5.0 for month in fx}), ("E_v4_brl1500_historical", 1500.0, fx), ("F_v4_brl5000_historical", 5000.0, fx)]
    results = {}
    primary = None
    primary_engine = primary_result = primary_values = None
    for name, cap, scenario_fx in configurations:
        engine = CappedContributionEngine(GridConfig(monthly_target=7, enable_topups=False), cap, scenario_fx)
        result = engine.run(load_cached_klines(args.cache, START, END, fills))
        values = v4_metrics(engine, result)
        expected = values["capital_inicial_usdt"] + values["aporte_total_usdt"] + values["lucro_realizado"] + values["pnl_aberto"]
        reconciliation = {"capital_inicial": values["capital_inicial_usdt"], "aportes_externos_usdt": values["aporte_total_usdt"], "lucro_realizado": values["lucro_realizado"], "pnl_aberto": values["pnl_aberto"], "patrimonio_calculado": expected, "patrimonio_final": values["patrimonio_final"], "diferenca": values["patrimonio_final"] - expected, "growth_reserve_value": engine.reserve_value}
        if abs(reconciliation["diferenca"]) > 1e-7:
            raise AssertionError("contabilidade V4 não fecha")
        scenario = output / name
        write_scenario(scenario, engine, result, values)
        (scenario / "accounting_v4.json").write_text(json.dumps(reconciliation, indent=2), encoding="utf-8")
        results[name] = values
        if name.startswith("C_"):
            primary, primary_engine, primary_result, primary_values = scenario, engine, result, values
    assert primary and primary_engine and primary_result and primary_values
    for name in ("monthly_v4.csv", "yearly_v4.csv", "topups_v4.csv", "redistributions_v4.csv", "slots_v4.csv", "accounting_v4.json"):
        shutil.copy2(primary / name, output / name)
    ath = 0.0
    ath_time = ""
    for candle in load_cached_klines(args.cache, START, END, fills):
        if candle.high > ath:
            ath, ath_time = candle.high, candle.time.isoformat()
    snapshots = final_snapshot(primary_engine, primary_result)
    write_csv(output / "final_snapshot_v4.csv", snapshots, list(snapshots[0]))
    holdings = [{"metric": "current_btc_holdings", "value": primary_engine.current_btc_holdings()}, {"metric": "cumulative_btc_bought", "value": primary_engine.cumulative_btc_bought}, {"metric": "cumulative_btc_sold", "value": primary_engine.cumulative_btc_sold}, {"metric": "btc_turnover", "value": primary_engine.cumulative_btc_bought + primary_engine.cumulative_btc_sold}, {"metric": "ath_dataset", "value": ath}, {"metric": "ath_timestamp", "value": ath_time}]
    write_csv(output / "btc_holdings_v4.csv", holdings, ["metric", "value"])
    recovery = recovery_marks(primary_engine, primary_result, ath)
    write_csv(output / "recovery_scenarios.csv", recovery, list(recovery[0]))
    sales, recovery_final = recovery_sales(primary_engine, primary_result)
    write_csv(output / "recovery_sales.csv", sales, list(sales[0]))
    restart = new_ath_restarts(primary_engine, recovery_final, ath)
    write_csv(output / "new_ath_restart.csv", restart, list(restart[0]))
    write_csv(output / "usd_brl_monthly.csv", fx_rows, ["month", "rate_date", "usd_brl", "source"])
    comparison = {
        "status": "not_requested",
        "v2_report": str(args.v2_report) if args.v2_report is not None else None,
        "v3_report": str(args.v3_report) if args.v3_report is not None else None,
    }
    v2 = v2_source(args.v2_report) if args.v2_report is not None else None
    v3 = v3_source(args.v3_report) if args.v3_report is not None else None
    if v2 is not None or v3 is not None:
        compare = [
            {"metric": "gains_reais", "v4_capado": primary_values["gains_reais"]},
            {"metric": "aporte_total_usdt", "v4_capado": primary_values["aporte_total_usdt"]},
            {"metric": "patrimonio_final", "v4_capado": primary_values["patrimonio_final"]},
            {"metric": "btc_em_aberto", "v4_capado": primary_values["btc_em_aberto"]},
        ]
        fields = ["metric"]
        if v2 is not None:
            fields.append("v2_puro")
            for row, value in zip(compare, (v2["gains_reais"], 0.0, v2["valor_final"], "")):
                row["v2_puro"] = value
        if v3 is not None:
            fields.append("v3_ilimitado")
            for row, value in zip(compare, (v3["gains_reais"], v3["aporte_externo_total"], v3["patrimonio_final"], "")):
                row["v3_ilimitado"] = value
        fields.append("v4_capado")
        write_csv(output / "comparison_v2_v3_v4.csv", compare, fields)
        comparison["status"] = "generated"
        comparison["included"] = [name for name, source in (("v2", v2), ("v3", v3)) if source is not None]
    (output / "summary_v4.json").write_text(json.dumps({"primary": primary_values, "scenarios": results, "ath": {"price": ath, "timestamp": ath_time}, "recovery_all_sales": recovery_final, "comparison": comparison}, indent=2), encoding="utf-8")
    lines = ["# Backtest V4 — aporte mensal limitado", "", "Fonte de câmbio: Banco Central do Brasil, SGS série 1, dólar comercial venda diário; foi usado o último dia útil disponível de cada mês e USDT≈USD.", "", "| Métrica principal | Valor |", "|---|---:|"]
    for key, value in primary_values.items():
        lines.append(f"| {key} | {value:.10f} |" if isinstance(value, float) else f"| {key} | {value} |")
    lines += ["", "## Recuperação sem novas compras", "", "| Cenário | Preço BTC | Patrimônio |", "|---|---:|---:|"]
    lines += [f"| {row['scenario']} | {row['btc_price_scenario']:.2f} | {row['total_equity']:.2f} |" for row in recovery]
    lines += ["", f"Vendas na recuperação: patrimônio após a última saída {recovery_final['patrimonio_final']:.10f} USDT; preço da última saída {recovery_final['preco_quando_ultimo_fechou']:.10f}.", "", "## Comparação histórica", ""]
    if comparison["status"] == "generated":
        lines.append(f"Gerada com: {', '.join(comparison['included'])}.")
    else:
        lines.append("Não gerada; forneça `--v2-report` e/ou `--v3-report` para incluir baselines anteriores.")
    (output / "summary_v4.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    (output / "engine_validation_v4.md").write_text("# Validação V4\n\nA suíte V4 valida teto, aporte parcial decimal, ausência de dívida, câmbio, BTC comprado/vendido, recuperação, restart no ATH, conservação e real_gains imutável.\n", encoding="utf-8")
    (output / "README.md").write_text("# V4\n\nC é o cenário principal, câmbio histórico BCB e teto de R$3.000/mês. D usa R$5 fixo; E/F usam a série histórica. O teto não gera dívida: cada mês recalcula required_topup do estado atual. Comparações históricas só são geradas com os relatórios informados por `--v2-report` e/ou `--v3-report`.\n", encoding="utf-8")
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
