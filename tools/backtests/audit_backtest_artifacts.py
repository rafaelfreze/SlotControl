"""Valida independentemente o cache e os CSVs forenses de um backtest gerado."""

from __future__ import annotations

import argparse
import csv
import json
import zipfile
from datetime import datetime, timezone
from pathlib import Path


def cache_profile(cache: Path) -> dict:
    folder = cache / "binance" / "BTCUSDT" / "1m"
    files = sorted(folder.glob("BTCUSDT-1m-*.zip"))
    count = duplicate = gaps = missing_minutes = 0
    first = last = previous = None
    for path in files:
        with zipfile.ZipFile(path) as archive:
            name = next(name for name in archive.namelist() if name.endswith(".csv"))
            with archive.open(name) as raw:
                for row in csv.reader(line.decode("utf-8-sig") for line in raw):
                    if not row or row[0].lower() in {"open_time", "open time"}:
                        continue
                    raw_ts = int(row[0])
                    timestamp = raw_ts // (1_000_000 if raw_ts >= 10_000_000_000_000 else 1_000)
                    if previous is not None:
                        if timestamp == previous:
                            duplicate += 1
                        elif timestamp < previous:
                            raise AssertionError(f"Cache fora de ordem em {path}")
                        elif timestamp - previous > 60:
                            gaps += 1
                            missing_minutes += (timestamp - previous) // 60 - 1
                    first = timestamp if first is None else first
                    last = timestamp
                    previous = timestamp
                    count += 1
    return {"zip_files": len(files), "candles": count, "first_utc": datetime.fromtimestamp(first, tz=timezone.utc).isoformat(), "last_utc": datetime.fromtimestamp(last, tz=timezone.utc).isoformat(), "duplicate_timestamps": duplicate, "gaps_over_one_minute": gaps, "missing_minutes_inside_gaps": missing_minutes}


def artifact_profile(report: Path) -> dict:
    summary = json.loads((report / "summary.json").read_text(encoding="utf-8"))
    with (report / "topups_forensic.csv").open(encoding="utf-8", newline="") as source:
        topups = list(csv.DictReader(source))
    with (report / "leader_selection_audit.csv").open(encoding="utf-8", newline="") as source:
        leaders = list(csv.DictReader(source))
    formula_deltas = [float(row["slot_value_before"]) * (float(row["compound_factor"]) - 1) - float(row["topup_amount"]) for row in topups]
    per_month: dict[str, int] = {}
    for row in topups:
        per_month[row["month"]] = per_month.get(row["month"], 0) + 1
    selected = [row for row in leaders if row["selected"] == "True"]
    invalid_selected = [row for row in selected if row["eligible"] != "True" or row["rank"] != "1"]
    total = sum(float(row["topup_amount"]) for row in topups)
    return {"topup_rows": len(topups), "unique_topup_months": len(per_month), "max_topups_per_month": max(per_month.values(), default=0), "topup_sum": total, "summary_topups": summary["total_aportado_do_bolso"], "topup_sum_difference": total - summary["total_aportado_do_bolso"], "max_formula_abs_difference": max((abs(value) for value in formula_deltas), default=0.0), "selected_leader_rows": len(selected), "selected_leader_not_rank_one": len(invalid_selected)}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    result = {"cache": cache_profile(args.cache), "artifacts": artifact_profile(args.report)}
    (args.report / "independent_forensic_validation.json").write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
