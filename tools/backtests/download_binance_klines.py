"""Downloader reexecutavel de Klines mensais publicos da Binance Data Vision."""

from __future__ import annotations

import argparse
import io
import json
import time
import zipfile
from datetime import date
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

BASE_URL = "https://data.binance.vision/data/spot/monthly/klines/{symbol}/{interval}/{symbol}-{interval}-{year}-{month:02d}.zip"


def month_starts(start: date, end: date):
    cursor = date(start.year, start.month, 1)
    final = date(end.year, end.month, 1)
    while cursor <= final:
        yield cursor
        cursor = date(cursor.year + (cursor.month == 12), 1 if cursor.month == 12 else cursor.month + 1, 1)


def validate_zip(payload: bytes, expected_prefix: str) -> int:
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        csv_names = [name for name in archive.namelist() if name.endswith(".csv")]
        if len(csv_names) != 1 or not csv_names[0].startswith(expected_prefix):
            raise ValueError("ZIP nao contem o CSV mensal esperado")
        with archive.open(csv_names[0]) as csv_file:
            first = csv_file.readline().decode("utf-8-sig").strip()
            if not first or len(first.split(",")) < 6:
                raise ValueError("CSV mensal invalido")
            return archive.getinfo(csv_names[0]).file_size


def download_month(symbol: str, interval: str, month: date, target: Path, retries: int = 3) -> str:
    if target.exists() and target.stat().st_size:
        try:
            validate_zip(target.read_bytes(), f"{symbol}-{interval}-{month.year}-{month.month:02d}")
            return "cached"
        except (OSError, ValueError, zipfile.BadZipFile):
            target.unlink(missing_ok=True)

    url = BASE_URL.format(symbol=symbol, interval=interval, year=month.year, month=month.month)
    for attempt in range(retries):
        try:
            with urlopen(Request(url, headers={"User-Agent": "SlotControl-backtest/1.0"}), timeout=90) as response:
                payload = response.read()
            validate_zip(payload, f"{symbol}-{interval}-{month.year}-{month.month:02d}")
            target.parent.mkdir(parents=True, exist_ok=True)
            temp = target.with_suffix(".zip.part")
            temp.write_bytes(payload)
            temp.replace(target)
            return "downloaded"
        except HTTPError as error:
            if error.code == 404:
                return "unavailable"
            last_error = error
        except (URLError, TimeoutError, OSError, ValueError, zipfile.BadZipFile) as error:
            last_error = error
        time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"Falha ao baixar {url}: {last_error}")


def download_range(symbol: str, interval: str, start: date, end: date, cache_root: Path) -> dict[str, int]:
    folder = cache_root / "binance" / symbol / interval
    counts = {"cached": 0, "downloaded": 0, "unavailable": 0}
    for month in month_starts(start, end):
        target = folder / f"{symbol}-{interval}-{month.year}-{month.month:02d}.zip"
        status = download_month(symbol, interval, month, target)
        counts[status] += 1
        print(f"{interval} {month:%Y-%m}: {status}", flush=True)
    manifest = {"source": "Binance Data Vision Spot monthly Klines", "symbol": symbol, "interval": interval, "requested_start": start.isoformat(), "requested_end": end.isoformat(), "counts": counts}
    (cache_root.parent / "backtest-cache").mkdir(parents=True, exist_ok=True)
    (cache_root.parent / "backtest-cache" / f"binance-{symbol}-{interval}-manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return counts


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--symbol", default="BTCUSDT")
    parser.add_argument("--interval", choices=("1m", "5m"), required=True)
    parser.add_argument("--start", type=date.fromisoformat, default=date(2017, 8, 1))
    parser.add_argument("--end", type=date.fromisoformat, default=date.today())
    parser.add_argument("--cache-root", type=Path, default=Path("backtest-data"))
    args = parser.parse_args()
    print(json.dumps(download_range(args.symbol, args.interval, args.start, args.end, args.cache_root), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
