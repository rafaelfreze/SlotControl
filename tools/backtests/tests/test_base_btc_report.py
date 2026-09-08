from __future__ import annotations

import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from run_base_btc_no_contributions import CrashTracker
from v2_grid_engine import Candle


class CrashTrackerTest(unittest.TestCase):
    def test_new_deeper_bottom_resets_prior_recovery(self):
        start = datetime(2024, 1, 1, tzinfo=timezone.utc)
        tracker = CrashTracker("test", start.date(), (start + timedelta(days=2)).date())
        tracker.observe(Candle(start, 100, 100, 90, 95), 1, [])
        tracker.observe(Candle(start + timedelta(minutes=1), 95, 101, 80, 82), 2, [])
        tracker.observe(Candle(start + timedelta(minutes=2), 82, 102, 90, 101), 2, [])
        row = tracker.row()
        self.assertEqual(row["bottom_price"], 80)
        self.assertEqual(row["time_to_recovery_minutes"], 1)


if __name__ == "__main__":
    unittest.main()
