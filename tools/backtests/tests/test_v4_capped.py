from __future__ import annotations

import math
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from v2_grid_engine import Candle, GridConfig, Position
from v4_capped_engine import CappedContributionEngine
from backtest_btc_v4 import new_ath_restarts, recovery_sales


def candle() -> Candle:
    return Candle(datetime(2024, 1, 31, tzinfo=timezone.utc), 100, 100, 100, 100)


class CappedV4Test(unittest.TestCase):
    def engine(self, cap=600, fx=5):
        item = CappedContributionEngine(GridConfig(slots=1, monthly_target=21, enable_topups=False), cap * fx, {"2024-01": fx})
        item._month, item._month_number, item._month_start_equity = "2024-01", 1, 20
        return item

    def test_cap_required_1000_is_600(self):
        item = self.engine()
        slot = item.slots[0]
        slot.operational_gains = 0
        slot.value = 1000 / (math.pow(1.01, 21) - 1)
        item._close_month(candle())
        self.assertAlmostEqual(item.topups[-1]["actual_topup_usdt"], 600)
        self.assertTrue(item.topups[-1]["hit_cap"])

    def test_required_200_is_not_rounded_to_cap(self):
        item = self.engine()
        slot = item.slots[0]
        target = 21
        slot.operational_gains = target - math.log(21) / math.log(1.01)
        slot.value = 10
        item._close_month(candle())
        self.assertAlmostEqual(item.topups[-1]["actual_topup_usdt"], 200, places=8)

    def test_partial_topup_uses_decimal_gain_equivalent(self):
        item = self.engine()
        item.slots[0].value = 1000 / (math.pow(1.01, 21) - 1)
        item._close_month(candle())
        added = item.topups[-1]["gain_equivalent_added"]
        before = 1000 / (math.pow(1.01, 21) - 1)
        self.assertAlmostEqual(added, math.log((before + 600) / before) / math.log(1.01))
        self.assertNotEqual(added, round(added))

    def test_no_debt_recalculates_next_month(self):
        item = self.engine()
        item.slots[0].value = 1000 / (math.pow(1.01, 21) - 1)
        item._close_month(candle())
        first_unused = item.topups[-1]["unused_required_usdt"]
        item._month, item._month_number = "2024-02", 2
        item.fx_by_month["2024-02"] = 5
        item._close_month(candle())
        self.assertNotEqual(first_unused, item.topups[-1]["unused_required_usdt"])

    def test_brl_cap_and_btc_quantities(self):
        item = self.engine()
        item._close_month(candle())
        self.assertLessEqual(item.topups[-1]["actual_topup_usdt"] * 5, 3000)
        slot = item.slots[0]
        item._buy(slot, 0, 100, candle().time, "test")
        self.assertAlmostEqual(slot.position.btc_qty, slot.position.value_at_entry / 100)
        held = item.current_btc_holdings()
        item._sell(slot, candle().time)
        self.assertEqual(item.current_btc_holdings(), 0)
        self.assertAlmostEqual(item.cumulative_btc_sold, held)
        self.assertGreater(item.cumulative_btc_bought, item.current_btc_holdings())

    def test_principal_annual_cap_is_36000_brl(self):
        item = self.engine()
        self.assertEqual(item.monthly_brl_cap * 12, 36000)

    def test_recovery_mark_to_market_and_real_gains_preserved(self):
        item = self.engine()
        slot = item.slots[0]
        slot.real_gains = 4
        item._buy(slot, 0, 100, candle().time, "test")
        self.assertAlmostEqual(item.current_btc_holdings() * 150, slot.position.value_at_entry * 1.5)
        before = slot.real_gains
        item._close_month(candle())
        self.assertEqual(slot.real_gains, before)

    def test_recovery_sale_uses_target_and_restart_uses_available_capital(self):
        item = self.engine()
        slot = item.slots[0]
        item._buy(slot, 0, 100, candle().time, "test")
        result = SimpleNamespace(cash=lambda: 0.0, ending_price=100.0)
        rows, final = recovery_sales(item, result)
        self.assertEqual(rows[0]["sell_price"], 101.0)
        self.assertAlmostEqual(final["cash_final"], slot.position.value_at_entry * 1.01)
        restart = new_ath_restarts(item, final, 200)
        self.assertAlmostEqual(restart[0]["btc_qty_new_entry"], restart[0]["slot_value"] / 200)
