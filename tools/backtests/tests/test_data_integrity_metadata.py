"""Regressoes da contagem e das lacunas da serie mensal mesclada com fills."""

from __future__ import annotations

import sys
import tempfile
import unittest
import zipfile
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backtest_btc_v2 import profile_effective_series, profile_gaps
from v2_grid_engine import Candle


class EffectiveSeriesProfileTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.cache = Path(self.temporary.name)
        self.start = self.end = date(2024, 1, 1)
        self.base = datetime(2024, 1, 1, tzinfo=timezone.utc)
        self._write_monthly_zip([0, 3, 4])

    def _write_monthly_zip(self, minute_offsets: list[int]) -> None:
        folder = self.cache / "binance" / "BTCUSDT" / "1m"
        folder.mkdir(parents=True)
        rows = []
        for offset in minute_offsets:
            when = self.base + timedelta(minutes=offset)
            rows.append(f"{int(when.timestamp() * 1000)},100,101,99,100\n")
        path = folder / "BTCUSDT-1m-2024-01.zip"
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr("BTCUSDT-1m-2024-01.csv", "".join(rows))

    def _fill(self, minute_offset: int) -> Candle:
        when = self.base + timedelta(minutes=minute_offset)
        return Candle(when, 100, 101, 99, 100)

    def test_only_fill_rows_inserted_into_real_gaps_change_metadata(self) -> None:
        raw_count, _, _, raw_gaps = profile_gaps(self.cache, self.start, self.end)
        fills = {
            self.base: self._fill(0),  # Sobrepoe candle mensal.
            self.base + timedelta(minutes=1): self._fill(1),  # Recupera uma lacuna.
            self.base + timedelta(minutes=10): self._fill(10),  # Fora da serie mensal.
        }

        effective_count, first, last, effective_gaps = profile_effective_series(
            self.cache, self.start, self.end, fills
        )

        self.assertEqual(raw_count, 3)
        self.assertEqual(sum(row["missing_minutes"] for row in raw_gaps), 2)
        self.assertEqual(effective_count, 4)
        self.assertEqual(first, self.base)
        self.assertEqual(last, self.base + timedelta(minutes=4))
        self.assertEqual(len(effective_gaps), 1)
        self.assertEqual(sum(row["missing_minutes"] for row in effective_gaps), 1)

    def test_extra_overlapping_fills_cannot_make_missing_minutes_negative(self) -> None:
        fills = {
            self.base + timedelta(minutes=offset): self._fill(offset)
            for offset in (0, 1, 2, 3, 10)
        }

        effective_count, _, _, effective_gaps = profile_effective_series(
            self.cache, self.start, self.end, fills
        )

        self.assertEqual(effective_count, 5)
        self.assertEqual(effective_gaps, [])
        self.assertEqual(sum(row["missing_minutes"] for row in effective_gaps), 0)


if __name__ == "__main__":
    unittest.main()
