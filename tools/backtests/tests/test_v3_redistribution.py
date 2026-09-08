from __future__ import annotations

import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from v2_grid_engine import Candle, GridConfig, Position
from v3_redistribution_engine import RedistributionTargetEngine


def month_end() -> Candle:
    return Candle(datetime(2024, 1, 31, tzinfo=timezone.utc), 100, 100, 100, 100)


class RedistributionTest(unittest.TestCase):
    def engine(self, target=21, reserve=True):
        instance = RedistributionTargetEngine(GridConfig(slots=3, monthly_target=target, enable_topups=False), reserve)
        instance._month = "2024-01"
        instance._month_number = 1
        instance._month_start_equity = 30
        return instance

    def close(self, instance, target):
        instance._close_month(month_end())

    def test_free_donor_completes_receivers_without_topup(self):
        instance = self.engine(21)
        a, b, c = instance.slots
        a.operational_gains, b.operational_gains, c.operational_gains = 26, 18, 15
        self.close(instance, 21)
        self.assertEqual((a.operational_gains, b.operational_gains, c.operational_gains), (21, 21, 17))
        self.assertEqual(instance.topups[-1]["topup"], 0.0)

    def test_open_donor_does_not_donate(self):
        instance = self.engine(21)
        a, b, c = instance.slots
        a.operational_gains, b.operational_gains, c.operational_gains = 26, 18, 15
        a.position = Position(0, month_end().time, 100, 101, a.value)
        instance._close_month(month_end())
        self.assertEqual(a.operational_gains, 26)
        self.assertFalse(any(row["donor_slot"] == 1 for row in instance.redistributions))

    def test_remainder_goes_to_reserve(self):
        instance = self.engine(21)
        a, b, c = instance.slots
        a.operational_gains = 26
        b.operational_gains = c.operational_gains = 21
        self.close(instance, 21)
        self.assertEqual(a.operational_gains, 21)
        self.assertEqual(instance.reserve.gain_equivalent, 5)
        self.assertGreater(instance.reserve.value, 0)

    def test_reserve_completes_leader_without_external_topup(self):
        instance = self.engine(21)
        a, b, c = instance.slots
        a.operational_gains, b.operational_gains, c.operational_gains = 20, 21, 21
        instance.reserve.value, instance.reserve.gain_equivalent = 1.0, 1
        self.close(instance, 21)
        self.assertEqual(a.operational_gains, 21)
        self.assertEqual(instance.topups[-1]["topup"], 0.0)

    def test_insufficient_internal_funds_results_in_exactly_one_topup(self):
        instance = self.engine(21)
        for slot in instance.slots:
            slot.operational_gains = 10
        self.close(instance, 21)
        applied = [row for row in instance.topups if row["reason"] == "APPLIED"]
        self.assertEqual(len(applied), 1)
        self.assertEqual(applied[0]["slot_id"], 1)

    def test_no_free_slot_has_no_topup(self):
        instance = self.engine(21)
        for slot in instance.slots:
            slot.position = Position(0, month_end().time, 100, 101, slot.value)
        self.close(instance, 21)
        self.assertEqual(instance.topups[-1]["reason"], "NO_FREE_SLOT")
        self.assertEqual(instance.topups[-1]["topup"], 0.0)

    def test_redistribution_conserves_value_and_real_gains(self):
        instance = self.engine(21)
        a, b, c = instance.slots
        a.operational_gains, b.operational_gains, c.operational_gains = 26, 18, 15
        a.real_gains, b.real_gains, c.real_gains = 26, 18, 15
        before = sum(slot.value for slot in instance.slots) + instance.reserve.value
        self.close(instance, 21)
        after = sum(slot.value for slot in instance.slots) + instance.reserve.value
        self.assertAlmostEqual(before, after)
        self.assertEqual((a.real_gains, b.real_gains, c.real_gains), (26, 18, 15))


if __name__ == "__main__":
    unittest.main()
