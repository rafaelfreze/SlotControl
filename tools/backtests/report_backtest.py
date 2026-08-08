"""Escrita de CSV, JSON e Markdown para o motor de backtest."""

from __future__ import annotations

import csv
import json
import statistics
from collections import defaultdict
from pathlib import Path

from backtest_engine import BacktestResult


def write_csv(path: Path, rows: list[dict], fields: list[str]) -> None:
    with path.open("w", encoding="utf-8", newline="") as output:
        writer = csv.DictWriter(output, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def slot_rows(result: BacktestResult) -> list[dict]:
    rows = []
    for slot in result.slots:
        position = slot.position
        rows.append({"slot_id": slot.slot_id, "final_status": "aberto" if position else "livre", "final_gains_reais": slot.gains_real, "final_gains_operacionais": slot.gains_operational, "final_value": slot.value, "times_bought": slot.times_bought, "times_sold": slot.times_sold, "months_as_leader": slot.months_as_leader, "total_topup_received": slot.total_topup_received, "last_buy_price": slot.last_buy_price or "", "last_sell_price": slot.last_sell_price or "", "open_entry_price": position.buy_price if position else "", "open_target_price": position.target_price if position else ""})
    return rows


def yearly_rows(result: BacktestResult) -> list[dict]:
    grouped: dict[str, list[dict]] = defaultdict(list)
    for row in result.monthly:
        grouped[row["month"][:4]].append(row)
    rows = []
    for year, months in sorted(grouped.items()):
        topups = [float(month["topup_amount"]) for month in months]
        rows.append({"year": year, "start_equity": months[0]["start_equity"], "end_equity": months[-1]["end_equity"], "realized_gains": sum(int(month["realized_gains"]) for month in months), "realized_profit": sum(float(month["realized_profit"]) for month in months), "topup_total": sum(topups), "topup_average_month": sum(topups) / len(months), "topup_max_month": max(topups), "months_with_topup": sum(value > 0 for value in topups), "months_without_free_slot": sum(month["leader_slot"] == "NO_FREE_SLOT" for month in months), "max_open_slots": max(int(month["open_slots_end"]) for month in months), "end_open_slots": months[-1]["open_slots_end"]})
    return rows


def summary_data(result: BacktestResult) -> dict:
    topup_total = sum(float(row["topup_amount"]) for row in result.topups)
    initial = result.config.slot_count * result.config.initial_slot_value
    return {"periodo": {"inicio": result.start.isoformat(), "fim": result.end.isoformat()}, "ativo": result.config.symbol, "intervalo_usado": result.interval, "modo_intrabar": result.intrabar_mode, "prioridade_de_entrada": result.config.entry_priority, "candles_processados": result.candles_processed, "capital_inicial": initial, "total_aportado_do_bolso": topup_total, "patrimonio_final": result.equity(), "saldo_de_caixa": result.cash_balance(), "valor_de_mercado_posicoes_abertas": result.open_market_value(), "pnl_aberto": result.open_pnl(), "lucro_realizado": result.realized_profit, "retorno_sobre_capital_inicial_percentual": (result.equity() / initial - 1) * 100, "retorno_sobre_capital_total_aportado_percentual": (result.equity() / (initial + topup_total) - 1) * 100, "trades_fechados": result.total_exits, "entradas": result.total_entries, "saidas": result.total_exits, "gains_reais": sum(slot.gains_real for slot in result.slots), "meses": len(result.monthly), "meses_com_aporte": sum(float(row["topup_amount"]) > 0 for row in result.topups), "meses_sem_slot_livre": sum(row["leader_slot"] == "NO_FREE_SLOT" for row in result.monthly), "maior_quantidade_slots_presos": result.max_open_slots, "maximo_drawdown_operacional_percentual": result.max_drawdown_operational * 100, "candles_ambiguos": len(result.ambiguous_candles), "preco_final_btc": result.ending_price}


def write_forensic_artifacts(result: BacktestResult, output: Path) -> None:
    topup_fields = ["timestamp", "month", "slot_id", "status", "month_number", "cumulative_target", "real_gains_before", "operational_gains_before", "missing_gains", "slot_value_before", "compound_factor", "topup_amount", "slot_value_after", "reason"]
    write_csv(output / "topups_forensic.csv", result.topups_forensic, topup_fields)
    write_csv(output / "monthly_forensic.csv", result.monthly_forensic, ["month", "btc_start", "btc_end", "leader_slot", "cumulative_target", "leader_real_gains", "leader_operational_gains_before", "missing_gains", "topup_amount", "real_trades_month", "real_profit_month", "open_slots_start", "open_slots_end", "equity_before_topup", "equity_after_topup", "cash_before", "cash_after", "reason"])
    write_csv(output / "leader_selection_audit.csv", result.leader_selection_audit, ["month", "slot_id", "status", "operational_gains", "real_gains", "slot_value", "eligible", "rank", "selected"])
    topup_amounts = [float(row["topup_amount"]) for row in result.topups_forensic]
    top20 = sorted(result.topups_forensic, key=lambda row: float(row["topup_amount"]), reverse=True)[:20]
    write_csv(output / "topups_forensic_top20.csv", top20, topup_fields)
    external_by_slot = {slot.slot_id: {"equivalents": 0, "total": 0.0} for slot in result.slots}
    for row in result.topups_forensic:
        bucket = external_by_slot[int(row["slot_id"])]
        bucket["equivalents"] += int(row["missing_gains"])
        bucket["total"] += float(row["topup_amount"])
    gains_rows = []
    for slot in result.slots:
        bucket = external_by_slot[slot.slot_id]
        if slot.gains_operational != slot.gains_real + bucket["equivalents"]:
            raise AssertionError(f"Gains operacionais inconsistentes no slot {slot.slot_id}")
        gains_rows.append({"slot_id": slot.slot_id, "real_gains": slot.gains_real, "operational_gains": slot.gains_operational, "external_gain_equivalents": bucket["equivalents"], "total_topup": bucket["total"]})
    write_csv(output / "gains_reconciliation.csv", gains_rows, ["slot_id", "real_gains", "operational_gains", "external_gain_equivalents", "total_topup"])
    final_rows = []
    for slot in result.slots:
        position = slot.position
        quantity = position.value_at_entry / position.buy_price if position else 0.0
        market_value = quantity * result.ending_price if position else 0.0
        final_rows.append({"slot_id": slot.slot_id, "status": "OPEN" if position else "FREE", "operational_value": slot.value, "entry_price": position.buy_price if position else "", "btc_quantity": quantity, "market_price": result.ending_price, "market_value": market_value, "unrealized_pnl": market_value - position.value_at_entry if position else 0.0, "real_gains": slot.gains_real, "operational_gains": slot.gains_operational, "total_external_topup": external_by_slot[slot.slot_id]["total"]})
    write_csv(output / "final_snapshot.csv", final_rows, ["slot_id", "status", "operational_value", "entry_price", "btc_quantity", "market_price", "market_value", "unrealized_pnl", "real_gains", "operational_gains", "total_external_topup"])
    initial = result.config.slot_count * result.config.initial_slot_value
    total_topups = sum(topup_amounts)
    accounting_expected = initial + total_topups + result.realized_profit + result.open_pnl()
    accounting = {"capital_inicial": initial, "aportes_externos": total_topups, "lucro_realizado": result.realized_profit, "pnl_aberto": result.open_pnl(), "patrimonio_calculado": accounting_expected, "patrimonio_reportado": result.equity(), "diferenca": result.equity() - accounting_expected, "cash": result.cash_balance(), "valor_posicoes_abertas": result.open_market_value(), "cash_mais_posicoes": result.cash_balance() + result.open_market_value(), "numero_aportes": len(topup_amounts), "aporte_medio": statistics.mean(topup_amounts) if topup_amounts else 0.0, "aporte_mediano": statistics.median(topup_amounts) if topup_amounts else 0.0, "maior_aporte": max(topup_amounts, default=0.0), "soma_gains_reais": sum(slot.gains_real for slot in result.slots), "soma_equivalentes_externos": sum(row["external_gain_equivalents"] for row in gains_rows)}
    if abs(accounting["diferenca"]) > 1e-8:
        raise AssertionError("Identidade contabil nao reconciliou")
    (output / "accounting_reconciliation.json").write_text(json.dumps(accounting, indent=2, ensure_ascii=False), encoding="utf-8")
    grouped: dict[str, list[dict]] = defaultdict(list)
    for row in result.topups_forensic:
        grouped[row["month"][:4]].append(row)
    lines = ["# Livro-razão forense dos aportes", "", f"Aportes aplicados: {len(topup_amounts)} · Total: {total_topups:.12f} USDT · Mediana: {accounting['aporte_mediano']:.12f} USDT.", "", "## 20 maiores aportes", "", "| Mês | Slot | Meta | Gains antes | Faltantes | Valor antes | Fator | Aporte | Valor depois |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|"]
    for row in top20:
        lines.append(f"| {row['month']} | {row['slot_id']} | {row['cumulative_target']} | {row['operational_gains_before']} | {row['missing_gains']} | {float(row['slot_value_before']):.12f} | {float(row['compound_factor']):.12f} | {float(row['topup_amount']):.12f} | {float(row['slot_value_after']):.12f} |")
    for year, rows in sorted(grouped.items()):
        lines.extend(["", f"## {year}", "", "| Mês | Slot | Meta | Antes | Faltantes | Aporte | Motivo |", "|---|---:|---:|---:|---:|---:|---|"])
        for row in rows:
            lines.append(f"| {row['month']} | {row['slot_id']} | {row['cumulative_target']} | {row['operational_gains_before']} | {row['missing_gains']} | {float(row['topup_amount']):.12f} | {row['reason']} |")
    (output / "forensic_topups.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_before_after_audit(output: Path, old_summary: dict, new_summary: dict) -> None:
    metrics = ["candles_processados", "capital_inicial", "total_aportado_do_bolso", "patrimonio_final", "saldo_de_caixa", "lucro_realizado", "pnl_aberto", "gains_reais", "trades_fechados", "meses", "meses_com_aporte", "meses_sem_slot_livre", "maior_quantidade_slots_presos"]
    rows = []
    for metric in metrics:
        old_value, new_value = old_summary.get(metric), new_summary.get(metric)
        difference = new_value - old_value if isinstance(old_value, (int, float)) and isinstance(new_value, (int, float)) else ""
        cause = "instrumentacao forense; regra inalterada" if difference == 0 else "revisar divergencia"
        rows.append({"metric": metric, "old_value": old_value, "new_value": new_value, "difference": difference, "cause": cause})
    write_csv(output / "before_after_audit.csv", rows, ["metric", "old_value", "new_value", "difference", "cause"])


def write_result(result: BacktestResult, output: Path) -> dict:
    output.mkdir(parents=True, exist_ok=True)
    summary = summary_data(result)
    (output / "summary.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8")
    write_csv(output / "monthly.csv", result.monthly, ["month", "start_equity", "end_equity", "realized_gains", "realized_profit", "open_slots_end", "closed_slots_end", "leader_slot", "target_gains", "leader_gains_before", "missing_gains", "topup_amount", "total_topups_to_date", "end_btc_price"])
    write_csv(output / "yearly.csv", yearly_rows(result), ["year", "start_equity", "end_equity", "realized_gains", "realized_profit", "topup_total", "topup_average_month", "topup_max_month", "months_with_topup", "months_without_free_slot", "max_open_slots", "end_open_slots"])
    write_csv(output / "trades.csv", result.trades, ["slot", "buy_time", "buy_price", "sell_time", "sell_price", "slot_value_before", "slot_value_after", "gain_number"])
    write_csv(output / "topups.csv", result.topups, ["month", "target_gains", "slot_id", "slot_gains_before", "slot_gains_after", "slot_value_before", "slot_value_after", "missing_gains", "topup_amount"])
    write_csv(output / "slots.csv", slot_rows(result), ["slot_id", "final_status", "final_gains_reais", "final_gains_operacionais", "final_value", "times_bought", "times_sold", "months_as_leader", "total_topup_received", "last_buy_price", "last_sell_price", "open_entry_price", "open_target_price"])
    write_csv(output / "ambiguous_candles.csv", result.ambiguous_candles, ["time", "open", "high", "low", "close"])
    write_forensic_artifacts(result, output)
    text = f"""# Backtest BTCUSDT — slot líder

## Resultado

- Período: {summary['periodo']['inicio']} até {summary['periodo']['fim']}
- Cenário: {summary['intervalo_usado']} / {summary['modo_intrabar']}
- Candles processados: {summary['candles_processados']:,}
- Capital inicial: {summary['capital_inicial']:.2f} USDT
- Aportes do bolso: {summary['total_aportado_do_bolso']:.2f} USDT
- Saldo em caixa: {summary['saldo_de_caixa']:.2f} USDT
- Posições abertas a mercado: {summary['valor_de_mercado_posicoes_abertas']:.2f} USDT
- Patrimônio final: {summary['patrimonio_final']:.2f} USDT
- Lucro realizado: {summary['lucro_realizado']:.2f} USDT
- PnL aberto: {summary['pnl_aberto']:.2f} USDT
- Gains reais: {summary['gains_reais']}
- Trades fechados: {summary['trades_fechados']}
- Maior quantidade de slots presos: {summary['maior_quantidade_slots_presos']}
- Drawdown operacional marcado: {summary['maximo_drawdown_operacional_percentual']:.2f}%

## Precisão intrabar

Foram encontrados {summary['candles_ambiguos']} candles em que OHLC não resolve
completamente a ordem de entrada/saída. Este cenário usa `{summary['modo_intrabar']}`.
Compare com o cenário alternativo para observar o impacto. AggTrades não foi
executado automaticamente.

## Arquivos

- `monthly.csv`: fechamento mensal, meta e aporte;
- `yearly.csv`: agregação anual;
- `trades.csv`: cada gain real;
- `topups.csv`: cada aporte composto ou NO_FREE_SLOT;
- `slots.csv`: distribuição final dos 25 slots;
- `ambiguous_candles.csv`: candles ainda ambíguos por OHLC.
"""
    (output / "summary.md").write_text(text, encoding="utf-8")
    (output / "README.md").write_text("Relatório local gerado por `tools/backtests`. Dados brutos: Binance Data Vision; não versionados.\n", encoding="utf-8")
    return summary
