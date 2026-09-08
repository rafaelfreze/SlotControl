"""Calibração operacional pura dos últimos 90 dias completos do cache V2."""

from __future__ import annotations

import argparse
import csv
import json
import statistics
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from backtest_btc_v2 import END, ROOT, write_csv
from v2_grid_engine import GridConfig, RecyclableLinearGridEngine, load_cached_klines


def daily_rows(candles, engine, result) -> list[dict]:
    events = defaultdict(list)
    for event in result.events:
        events[datetime.fromisoformat(event["timestamp"]).date()].append(event)
    profits = defaultdict(float)
    for trade in result.trades:
        profits[datetime.fromisoformat(trade["sell_time"]).date()] += float(trade["slot_value_after"]) - float(trade["slot_value_before"])
    cycles = defaultdict(int)
    for cycle in result.cycles:
        cycles[datetime.fromisoformat(cycle["end"]).date()] += 1
    grouped = defaultdict(list)
    for candle in candles:
        grouped[candle.time.date()].append(candle)
    snapshots = {datetime.fromisoformat(row["timestamp"]).date(): row for row in engine.candle_snapshots}
    rows = []
    for day, values in sorted(grouped.items()):
        day_events = events[day]
        snapshot = snapshots[day]
        rows.append({"date": day.isoformat(), "btc_open": values[0].open, "btc_high": max(row.high for row in values), "btc_low": min(row.low for row in values), "btc_close": values[-1].close, "entries": sum(row["event"] == "BUY" for row in day_events), "exits": sum(row["event"] == "SELL" for row in day_events), "real_gains": sum(row["event"] == "SELL" for row in day_events), "cycles_completed": cycles[day], "max_open_slots": max([int(row["open_slots_after"]) for row in day_events] + [snapshot["open_slots"]]), "end_open_slots": snapshot["open_slots"], "realized_profit": profits[day], "equity_end": snapshot["equity"]})
    return rows


def monthly_rows(daily: list[dict]) -> list[dict]:
    grouped = defaultdict(list)
    for row in daily:
        grouped[row["date"][:7]].append(row)
    rows = []
    for month, values in sorted(grouped.items()):
        rows.append({"month": month, "btc_inicial": values[0]["btc_open"], "btc_final": values[-1]["btc_close"], "maxima": max(float(row["btc_high"]) for row in values), "minima": min(float(row["btc_low"]) for row in values), "entradas": sum(int(row["entries"]) for row in values), "gains": sum(int(row["real_gains"]) for row in values), "max_slots_abertos": max(int(row["max_open_slots"]) for row in values), "slots_abertos_final": values[-1]["end_open_slots"], "ciclos_completos": sum(int(row["cycles_completed"]) for row in values), "lucro": sum(float(row["realized_profit"]) for row in values)})
    return rows


def consecutive(values: list[bool]) -> int:
    best = current = 0
    for value in values:
        current = current + 1 if value else 0
        best = max(best, current)
    return best


def trades_rows(result) -> tuple[list[dict], list[dict]]:
    buys = {(row["slot"], row["timestamp"]): row for row in result.events if row["event"] == "BUY"}
    open_keys = {(slot.slot_id, slot.position.entry_time.isoformat()) for slot in result.slots if slot.position}
    trades = []
    for index, trade in enumerate(result.trades, 1):
        buy = buys[(trade["slot"], trade["buy_time"])]
        entry, exit_ = datetime.fromisoformat(trade["buy_time"]), datetime.fromisoformat(trade["sell_time"])
        trades.append({"timestamp_entry": trade["buy_time"], "timestamp_exit": trade["sell_time"], "slot": trade["slot"], "anchor": buy["anchor"], "grid_level": buy["level"], "entry_price": trade["buy_price"], "target_price": trade["sell_price"], "exit_price": trade["sell_price"], "minutes_open": (exit_ - entry).total_seconds() / 60, "gain_number_slot": trade["gain_number"], "gain_number_global": index})
    entries = []
    matched = {(row["slot"], row["timestamp_entry"]) for row in trades}
    for buy in buys.values():
        key = (buy["slot"], buy["timestamp"])
        entries.append({"timestamp_entry": buy["timestamp"], "slot": buy["slot"], "cycle": buy["cycle"], "anchor": buy["anchor"], "grid_level": buy["level"], "entry_price": buy["entry_price"], "target_price": buy["target"], "status": "OPEN_AT_END" if key in open_keys else "CLOSED" if key in matched else "UNKNOWN", "reason": buy["reason"], "armed_before": buy["armed_before"], "armed_after": buy["armed_after"]})
    return trades, entries


def rearm_audit(result) -> tuple[list[dict], list[dict]]:
    last_buy: dict[tuple[int, int], int] = {}
    rearmed_after_buy: dict[tuple[int, int], bool] = defaultdict(bool)
    rows, invalid = [], []
    for sequence, event in enumerate(result.events):
        if event["event"] == "REARM":
            key = (int(event["cycle"]), int(event["level"]))
            if key in last_buy:
                rearmed_after_buy[key] = True
        elif event["event"] == "BUY":
            key = (int(event["cycle"]), int(event["level"]))
            is_rebuy = key in last_buy
            valid = (not is_rebuy) or rearmed_after_buy[key]
            row = {"sequence": sequence, "timestamp": event["timestamp"], "cycle": event["cycle"], "slot": event["slot"], "level": event["level"], "reason": event["reason"], "is_rebuy": is_rebuy, "rearm_seen_since_prior_buy": rearmed_after_buy[key] if is_rebuy else "", "valid": valid}
            rows.append(row)
            if not valid:
                invalid.append(row)
            last_buy[key] = sequence
            rearmed_after_buy[key] = False
    return rows, invalid


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--end", type=date.fromisoformat, default=END, help="Último dia do recorte de 90 dias (YYYY-MM-DD).")
    args = parser.parse_args()
    end = args.end
    start = end - timedelta(days=89)
    output = ROOT / "reports" / "backtests" / "v2-calibration-90d" / datetime.now(timezone.utc).strftime("%Y-%m-%d-%H%M")
    output.mkdir(parents=True, exist_ok=False)
    candles = list(load_cached_klines(ROOT / "backtest-data", start, end))
    engine = RecyclableLinearGridEngine(GridConfig(enable_topups=False), "heuristic", record_candle_state=True)
    result = engine.run(candles)
    daily = daily_rows(candles, engine, result)
    monthly = monthly_rows(daily)
    trades, entries = trades_rows(result)
    audit, invalid = rearm_audit(result)
    top_gains = sorted(daily, key=lambda row: (-int(row["real_gains"]), row["date"]))[:5]
    top_entries = sorted(daily, key=lambda row: (-int(row["entries"]), row["date"]))[:5]
    top_open = sorted(daily, key=lambda row: (-int(row["max_open_slots"]), row["date"]))[:3]
    selected_days = {row["date"] for row in top_gains + top_entries + top_open}
    replay = []
    for event in result.events:
        if event["timestamp"][:10] in selected_days:
            replay.append({"timestamp": event["timestamp"], "price": event["entry_price"] or event["exit_price"] or event["trigger"], "event": event["event"], "slot": event["slot"], "level": event["level"], "anchor": event["anchor"], "entry": event["entry_price"], "target": event["target"], "armed_before": event.get("armed_before", ""), "armed_after": event.get("armed_after", ""), "open_slots": event["open_slots_after"], "reason": event["reason"]})
    write_csv(output / "calibration_90d_daily.csv", daily, list(daily[0]))
    write_csv(output / "calibration_90d_monthly.csv", monthly, list(monthly[0]))
    write_csv(output / "calibration_90d_trades.csv", trades, list(trades[0]) if trades else ["timestamp_entry"])
    write_csv(output / "calibration_90d_entries.csv", entries, list(entries[0]) if entries else ["timestamp_entry"])
    write_csv(output / "calibration_90d_replay.csv", replay, ["timestamp", "price", "event", "slot", "level", "anchor", "entry", "target", "armed_before", "armed_after", "open_slots", "reason"])
    write_csv(output / "calibration_90d_rearm_audit.csv", audit, ["sequence", "timestamp", "cycle", "slot", "level", "reason", "is_rebuy", "rearm_seen_since_prior_buy", "valid"])
    daily_gains = [int(row["real_gains"]) for row in daily]
    last60 = daily[-60:]
    result_summary = {"periodo": {"inicio": start.isoformat(), "fim": end.isoformat()}, "candles": len(candles), "gains_90d": len(trades), "gains_primeiros_30": sum(int(row["real_gains"]) for row in daily[:30]), "gains_segundos_30": sum(int(row["real_gains"]) for row in daily[30:60]), "gains_ultimos_30": sum(int(row["real_gains"]) for row in daily[60:]), "gains_60d": sum(int(row["real_gains"]) for row in last60), "ratio_vs_60_gains_reais": sum(int(row["real_gains"]) for row in last60) / 60, "gains_dia_medio": statistics.mean(daily_gains), "mediana_diaria": statistics.median(daily_gains), "melhor_dia": top_gains[0], "pior_dia": min(daily, key=lambda row: (int(row["real_gains"]), row["date"])), "maior_sequencia_sem_gain_dias": consecutive([value == 0 for value in daily_gains]), "maior_sequencia_com_gain_dias": consecutive([value > 0 for value in daily_gains]), "max_slots_abertos": result.max_open_slots, "slots_utilizados": sum(slot.times_bought > 0 for slot in result.slots), "ciclos_completos": result.complete_cycles, "patrimonio_final": result.equity(), "pnl_aberto": result.open_pnl(), "lucro_realizado": result.realized_profit, "rebuys_auditados": sum(bool(row["is_rebuy"]) for row in audit), "rebuys_sem_rearm_valido": len(invalid), "top_5_dias_gains": top_gains, "top_5_dias_entradas": top_entries, "top_3_dias_slots_abertos": top_open}
    (output / "summary.json").write_text(json.dumps(result_summary, indent=2), encoding="utf-8")
    diagnosis = "Nenhuma recompra sem REARM foi encontrada." if not invalid else f"A primeira recompra inválida está na sequência {invalid[0]['sequence']} em {invalid[0]['timestamp']}."
    lines = ["# Calibração operacional pura — últimos 90 dias", "", "Sem aporte, meta, redistribuição, reserva ou regime ATH.", "", f"- Período: {start.isoformat()} a {end.isoformat()}", f"- Gains: {len(trades)}; últimos 60 dias: {result_summary['gains_60d']} (ratio contra 60 reais: {result_summary['ratio_vs_60_gains_reais']:.4f})", f"- Máximo slots abertos: {result.max_open_slots}; slots usados: {result_summary['slots_utilizados']}/25; ciclos: {result.complete_cycles}", f"- Patrimônio final: {result.equity():.8f} USDT; lucro realizado: {result.realized_profit:.8f}; PnL aberto: {result.open_pnl():.8f}", f"- Auditoria de reentrada: {result_summary['rebuys_auditados']} recompras, {len(invalid)} inválidas. {diagnosis}", "", "## Regras de prova", "", "A compra desarma o nível. Quando a venda no alvo de +1% ocorre, o preço necessariamente já passou pelo nível de entrada; o motor então registra o `REARM` efetivo após a venda. Somente uma queda posterior pode gerar outra compra. A auditoria mantém a ordem dos eventos.", "", "## Comparação externa", "", "A referência informada é aproximadamente 60 gains em 60 dias no operacional real. O ratio acima é diagnóstico, não foi usado para ajustar parâmetros."]
    (output / "summary.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
