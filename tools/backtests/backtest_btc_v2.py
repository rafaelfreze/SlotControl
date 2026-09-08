"""Executa o backtest V2 da grade linear reciclável definida pelo proprietário.

Saídas são locais e ignoradas pelo Git. Não acessa produção, Supabase ou Vercel.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import statistics
import urllib.error
import urllib.request
import zipfile
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from v2_grid_engine import Candle, GridConfig, RecyclableLinearGridEngine, V2Result, load_cached_klines

ROOT = Path(__file__).resolve().parents[2]
START = date(2017, 8, 17)
END = date(2026, 7, 31)
DAILY_URL = "https://data.binance.vision/data/spot/daily/klines/BTCUSDT/1m/BTCUSDT-1m-{day}.zip"


def write_csv(path: Path, rows: list[dict], fields: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def profile_effective_series(
    cache: Path,
    start: date,
    end: date,
    fills: dict[datetime, Candle] | None = None,
) -> tuple[int, datetime | None, datetime | None, list[dict]]:
    """Perfila exatamente a serie mensal processada, ja mesclada com fills."""
    count = 0
    first = last = None
    gaps: list[dict] = []
    previous: Candle | None = None
    for candle in load_cached_klines(cache, start, end, fills):
        count += 1
        first = first or candle.time
        last = candle.time
        if previous:
            missing = round((candle.time - previous.time).total_seconds() / 60) - 1
            if missing > 0:
                gaps.append({"start_after": previous.time.isoformat(), "end_before": candle.time.isoformat(), "missing_minutes": missing})
        previous = candle
    return count, first, last, gaps


def profile_gaps(cache: Path, start: date, end: date) -> tuple[int, datetime | None, datetime | None, list[dict]]:
    return profile_effective_series(cache, start, end)


def _daily_path(cache: Path, day: date) -> Path:
    return cache / "binance" / "BTCUSDT" / "1m-daily-fill" / f"BTCUSDT-1m-{day.isoformat()}.zip"


def fill_gap_days(cache: Path, gaps: list[dict]) -> list[dict]:
    """Tenta a fonte oficial diária. Falhas são registradas, nunca ocultadas."""
    days: set[date] = set()
    for gap in gaps:
        left = datetime.fromisoformat(gap["start_after"]).date()
        right = datetime.fromisoformat(gap["end_before"]).date()
        cursor = left
        while cursor <= right:
            days.add(cursor)
            cursor += timedelta(days=1)
    attempts: list[dict] = []
    for day in sorted(days):
        target = _daily_path(cache, day)
        if target.exists() and target.stat().st_size:
            attempts.append({"day": day.isoformat(), "status": "cached"})
            continue
        url = DAILY_URL.format(day=day.isoformat())
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "SlotControl-v2-backtest/1.0"})
            with urllib.request.urlopen(request, timeout=90) as response:
                payload = response.read()
            with zipfile.ZipFile(io.BytesIO(payload)) as archive:
                if not any(name.endswith(".csv") for name in archive.namelist()):
                    raise ValueError("ZIP diário sem CSV")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(payload)
            attempts.append({"day": day.isoformat(), "status": "downloaded"})
        except urllib.error.HTTPError as error:
            attempts.append({"day": day.isoformat(), "status": f"http_{error.code}"})
        except (urllib.error.URLError, TimeoutError, OSError, ValueError, zipfile.BadZipFile) as error:
            attempts.append({"day": day.isoformat(), "status": f"error_{type(error).__name__}"})
    return attempts


def read_daily_fills(cache: Path, start: date, end: date) -> dict[datetime, Candle]:
    fills: dict[datetime, Candle] = {}
    folder = cache / "binance" / "BTCUSDT" / "1m-daily-fill"
    if not folder.exists():
        return fills
    for path in sorted(folder.glob("*.zip")):
        with zipfile.ZipFile(path) as archive:
            name = next(name for name in archive.namelist() if name.endswith(".csv"))
            with archive.open(name) as raw, io.TextIOWrapper(raw, encoding="utf-8-sig", newline="") as text:
                for row in csv.reader(text):
                    if not row or row[0].lower() in {"open_time", "open time"}:
                        continue
                    raw_time = int(row[0])
                    divisor = 1_000_000 if raw_time >= 10_000_000_000_000 else 1_000
                    when = datetime.fromtimestamp(raw_time / divisor, tz=timezone.utc)
                    if start <= when.date() <= end:
                        fills[when] = Candle(when, float(row[1]), float(row[2]), float(row[3]), float(row[4]))
    return fills


def summary(result: V2Result) -> dict:
    monthly_gains = [int(row["realized_gains"]) for row in result.monthly]
    used = [slot for slot in result.slots if slot.times_bought]
    topups = [float(row["topup_amount"]) for row in result.topups if float(row["topup_amount"])]
    return {
        "periodo": {"inicio": result.start.isoformat(), "fim": result.end.isoformat()},
        "modo": result.mode,
        "regime_ath": result.config.regime,
        "candles_processados": result.candles,
        "capital_inicial": result.config.slots * result.config.initial_value,
        "gains_reais": len(result.trades),
        "gains_mensais_media": statistics.mean(monthly_gains) if monthly_gains else 0.0,
        "gains_mensais_mediana": statistics.median(monthly_gains) if monthly_gains else 0.0,
        "melhor_mes_gains": max(monthly_gains, default=0),
        "pior_mes_gains": min(monthly_gains, default=0),
        "max_slots_abertos": result.max_open_slots,
        "slots_distintos_utilizados": len(used),
        "ciclos_completos": result.complete_cycles,
        "valor_final": result.equity(),
        "saldo_caixa": result.cash(),
        "valor_posicoes_abertas": result.position_value(),
        "pnl_aberto": result.open_pnl(),
        "lucro_realizado": result.realized_profit,
        "max_drawdown_percentual": result.max_drawdown * 100,
        "candles_ambiguos": len(result.ambiguous),
        "total_aportado": sum(topups),
        "aportes": len(topups),
    }


def write_summary_md(path: Path, title: str, values: dict) -> None:
    lines = [f"# {title}", "", "| Métrica | Valor |", "|---|---:|"]
    names = {"gains_reais": "Gains reais", "gains_mensais_media": "Média mensal de gains", "gains_mensais_mediana": "Mediana mensal de gains", "melhor_mes_gains": "Melhor mês", "pior_mes_gains": "Pior mês", "max_slots_abertos": "Máximo de slots abertos", "slots_distintos_utilizados": "Slots distintos usados", "ciclos_completos": "Ciclos completos", "valor_final": "Patrimônio final", "saldo_caixa": "Caixa final", "valor_posicoes_abertas": "Posições abertas", "pnl_aberto": "PnL aberto", "lucro_realizado": "Lucro realizado", "total_aportado": "Aporte externo", "candles_ambiguos": "Candles ambíguos"}
    for key, label in names.items():
        value = values.get(key, "")
        lines.append(f"| {label} | {value:.8f} |" if isinstance(value, float) else f"| {label} | {value} |")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def slots_rows(result: V2Result) -> list[dict]:
    rows = []
    for slot in result.slots:
        pos = slot.position
        rows.append({"slot_id": slot.slot_id, "status": "OPEN" if pos else "FREE", "real_gains": slot.real_gains, "operational_gains": slot.operational_gains, "final_value": slot.value, "times_bought": slot.times_bought, "times_sold": slot.times_sold, "total_topup": slot.total_topup, "open_level": pos.level if pos else "", "open_entry_price": pos.entry_price if pos else "", "open_target_price": pos.target_price if pos else ""})
    return rows


def critical_rows(result: V2Result, cache: Path, fills: dict[datetime, Candle]) -> dict[str, list[dict]]:
    periods = {"critical_period_2017_2018.csv": (date(2017, 8, 17), date(2018, 12, 31)), "critical_period_2020_03.csv": (date(2020, 3, 1), date(2020, 3, 31)), "critical_period_2021.csv": (date(2021, 1, 1), date(2021, 12, 31)), "critical_period_2021_11_2022_11.csv": (date(2021, 11, 1), date(2022, 11, 30)), "critical_period_2024_2026.csv": (date(2024, 1, 1), END)}
    event_map: dict[datetime, list[dict]] = {}
    for event in result.events:
        when = datetime.fromisoformat(event["timestamp"])
        event_map.setdefault(when, []).append(event)
    rows = {name: [] for name in periods}
    for candle in load_cached_klines(cache, START, END, fills):
        for event in event_map.get(candle.time, []):
            for name, (period_start, period_end) in periods.items():
                if period_start <= candle.time.date() <= period_end:
                    rows[name].append({"timestamp": candle.time.isoformat(), "price_open": candle.open, "price_high": candle.high, "price_low": candle.low, "price_close": candle.close, **event})
    return rows


def write_spec(path: Path) -> None:
    path.write_text("""# Estratégia autoritativa do Backtest V2

Este documento modela exclusivamente a estratégia pretendida confirmada pelo proprietário em 2026-08-07. Não descreve nem altera o aplicativo atual.

## Base

- BTCUSDT, 25 slots de 10 USDT, ganho líquido de 1%, sem stop.
- A primeira entrada de cada ciclo é a mercado no fechamento do primeiro candle disponível (ou na abertura do candle posterior ao término de um ciclo).
- Essa entrada estabelece a âncora. A grade é linear: `anchor * (1 - 0,02 * nível)`, para níveis 0 a 24.

## Reciclagem e ciclo

- Cada nível fica desarmado somente enquanto carrega uma entrada. Ao preço cruzá-lo de baixo para cima, ele é rearmado.
- Uma nova queda que volte a cruzar um nível armado abre outra posição, com o slot livre prioritário. Um nível nunca aceita duas posições abertas simultâneas.
- A venda individual em `entrada * 1,01` libera o slot, incrementa gains reais e operacionais e capitaliza o valor do slot em 1%.
- A âncora é preservada enquanto existir qualquer posição do ciclo. Após a última saída, o ciclo termina; o próximo candle inicia o novo ciclo a mercado. Não há reentrada retroativa no restante do candle que encerrou o ciclo.

## Ordem intraminuto

Heuristic usa `open -> low -> high -> close` no candle de alta e `open -> high -> low -> close` no candle de baixa, incluindo a transição do fechamento anterior para a abertura atual. Conservative impede que uma compra do próprio candle realize gain nesse mesmo candle.

## Prioridade e aporte

Entradas e líderes mensais consideram somente slots livres, por maior `operational_gains`, maior valor e menor número. O cenário base não tem aporte. No cenário separado Meta 7, o fechamento mensal aplica no máximo um aporte composto ao líder livre para a meta acumulada `mês * 7`; aporte não é lucro real.

## Regime adicional

O cenário adicional fixa a distância linear do ciclo pela maior alta observada até a entrada: até 20% abaixo do ATH = 4%, entre 20% e 40% = 3%, abaixo de 40% = 2%. Ele não altera o cenário-base de 2%.
""", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path, default=ROOT / "backtest-data")
    parser.add_argument("--reports", type=Path, default=ROOT / "reports" / "backtests" / "v2-faithful-slot-control")
    parser.add_argument("--start", type=date.fromisoformat, default=START)
    parser.add_argument("--end", type=date.fromisoformat, default=END)
    parser.add_argument("--skip-gap-fill", action="store_true")
    parser.add_argument("--only-integrity", action="store_true")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d-%H%M")
    output = args.output or args.reports / stamp
    output.mkdir(parents=True, exist_ok=False)
    raw_count, first, last, gaps_before = profile_gaps(args.cache, args.start, args.end)
    attempts = ([{"day": path.stem.removeprefix("BTCUSDT-1m-"), "status": "cached_from_prior_official_attempt"} for path in sorted((args.cache / "binance" / "BTCUSDT" / "1m-daily-fill").glob("*.zip"))] if args.skip_gap_fill else fill_gap_days(args.cache, gaps_before))
    fills = read_daily_fills(args.cache, args.start, args.end)
    effective_count, _, _, effective_gaps = profile_effective_series(args.cache, args.start, args.end, fills)
    write_csv(output / "data_gaps_before.csv", gaps_before, ["start_after", "end_before", "missing_minutes"])
    write_csv(output / "data_gaps_remaining.csv", effective_gaps, ["start_after", "end_before", "missing_minutes"])
    write_csv(output / "data_gap_fill_attempts.csv", attempts, ["day", "status"])
    recovered = effective_count - raw_count
    integrity = ["# Integridade dos dados", "", "Fonte: Binance Data Vision Spot Klines BTCUSDT 1m.", "", f"- Candles mensais brutos: {raw_count:,}", f"- Intervalo bruto: {first.isoformat() if first else ''} a {last.isoformat() if last else ''}", f"- Lacunas antes da tentativa: {len(gaps_before)} / {sum(row['missing_minutes'] for row in gaps_before):,} minutos", f"- Arquivos diários oficiais carregados: {len(fills):,} candles", f"- Minutos efetivamente recuperados: {recovered:,}", f"- Lacunas restantes: {len(effective_gaps)} / {sum(row['missing_minutes'] for row in effective_gaps):,} minutos", "", "Arquivos CSV ao lado listam todas as lacunas e cada tentativa de preenchimento oficial."]
    (output / "data_integrity_report.md").write_text("\n".join(integrity) + "\n", encoding="utf-8")
    write_spec(output / "REAL_STRATEGY_SPEC.md")
    if args.only_integrity:
        print(output)
        return 0

    # O motor puro é executado antes de qualquer plano de meta.
    pure = RecyclableLinearGridEngine(GridConfig(enable_topups=False), "heuristic").run(load_cached_klines(args.cache, args.start, args.end, fills))
    pure_summary = summary(pure)
    write_summary_md(output / "pure_trading_summary.md", "Backtest V2 puro — grade linear reciclável 2%", pure_summary)
    write_csv(output / "monthly_real_gains.csv", pure.monthly, list(pure.monthly[0]) if pure.monthly else [])
    write_csv(output / "trades.csv", pure.trades, list(pure.trades[0]) if pure.trades else ["slot"])
    write_csv(output / "events.csv", pure.events, list(pure.events[0]) if pure.events else ["timestamp"])
    write_csv(output / "cycles.csv", pure.cycles, ["cycle", "start", "end", "anchor", "drop_rate", "trades", "status"])
    write_csv(output / "slot_usage.csv", slots_rows(pure), ["slot_id", "status", "real_gains", "operational_gains", "final_value", "times_bought", "times_sold", "total_topup", "open_level", "open_entry_price", "open_target_price"])
    write_csv(output / "ambiguous_candles.csv", pure.ambiguous, ["timestamp", "open", "high", "low", "close"])
    critical = critical_rows(pure, args.cache, fills)
    combined = []
    fields = ["timestamp", "price_open", "price_high", "price_low", "price_close", "event", "cycle", "slot", "level", "trigger", "entry_price", "target", "exit_price", "real_gain_number", "slot_gains", "open_slots_after", "anchor", "drop_rate", "reason"]
    for name, rows in critical.items():
        write_csv(output / name, rows, fields)
        combined.extend(rows)
    write_csv(output / "critical_periods.csv", combined, fields)

    # A meta só roda depois do puro acima terminar sem falha de invariantes.
    target = RecyclableLinearGridEngine(GridConfig(enable_topups=True), "heuristic").run(load_cached_klines(args.cache, args.start, args.end, fills))
    target_summary = summary(target)
    write_summary_md(output / "with_target7_summary.md", "Backtest V2 — Meta acumulada de 7 gains/mês", target_summary)
    write_csv(output / "topups.csv", target.topups, ["month", "month_number", "slot_id", "target_gains", "real_gains_before", "operational_gains_before", "missing_gains", "slot_value_before", "compound_factor", "topup_amount", "slot_value_after", "reason"])

    regime = RecyclableLinearGridEngine(GridConfig(enable_topups=False, regime=True), "heuristic").run(load_cached_klines(args.cache, args.start, args.end, fills))
    regime_summary = summary(regime)
    write_summary_md(output / "ath_regime_summary.md", "Cenário separado — ATH 4% / 3% / 2%", regime_summary)
    old_path = ROOT / "reports" / "backtests" / "slot-control-btc-leader" / "2026-08-07-2336" / "summary.json"
    old = json.loads(old_path.read_text(encoding="utf-8")) if old_path.exists() else {}
    rows = []
    mapping = {"gains_reais": "gains_reais", "maior_quantidade_slots_presos": "max_slots_abertos", "patrimonio_final": "valor_final", "lucro_realizado": "lucro_realizado", "pnl_aberto": "pnl_aberto"}
    for old_key, new_key in mapping.items():
        old_value, new_value = old.get(old_key, ""), pure_summary.get(new_key, "")
        rows.append({"metric": old_key, "old_value": old_value, "new_value": new_value, "difference": (new_value - old_value) if isinstance(old_value, (int, float)) else "", "cause": "V1 consumia níveis irreversivelmente; V2 rearma níveis após cruzamento ascendente e recicla slots."})
    write_csv(output / "comparison_old_vs_v2.csv", rows, ["metric", "old_value", "new_value", "difference", "cause"])
    with (output / "engine_validation.md").open("w", encoding="utf-8") as handle:
        handle.write("# Validação do motor\n\nOs testes unitários V2 cobrem reciclagem no mesmo nível, queda monotônica consumindo 25 slots, repique que libera/reutiliza slot, persistência da âncora, reinício somente no candle seguinte, prioridade, aporte isolado do lucro e conservador versus heuristic.\n")
    (output / "summary.json").write_text(json.dumps({"pure": pure_summary, "target7": target_summary, "ath_regime": regime_summary, "data": {"raw_candles": raw_count, "effective_candles": effective_count, "gaps_before": len(gaps_before), "gaps_remaining": len(effective_gaps)}}, indent=2), encoding="utf-8")
    (output / "README.md").write_text("# Backtest V2\n\nO cenário-base é `pure_trading_summary.md`: 2% linear, reciclável, sem aporte. `with_target7_summary.md` é separado. Os CSVs preservam trades, eventos, ciclos, uso de slots, períodos críticos e dados de integridade.\n", encoding="utf-8")
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
