from __future__ import annotations

import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from v2_grid_engine import Candle, GridConfig, RecyclableLinearGridEngine


def candle(i: int, open_: float, high: float, low: float, close: float) -> Candle:
    return Candle(datetime(2024, 1, 1, tzinfo=timezone.utc) + timedelta(minutes=i), open_, high, low, close)


class RecyclableGridTest(unittest.TestCase):
    def simulate(self, rows, slots=25, topups=False):
        return RecyclableLinearGridEngine(GridConfig(slots=slots, enable_topups=topups)).run(rows)

    def test_recycles_same_level_after_gain(self):
        rows = [candle(0, 100, 100, 100, 100), candle(1, 100, 100, 98, 98), candle(2, 98, 99.5, 98, 99.5), candle(3, 99.5, 99.5, 98, 98), candle(4, 98, 99.5, 98, 99.5), candle(5, 99.5, 99.5, 98, 98), candle(6, 98, 99.5, 98, 99.5)]
        result = self.simulate(rows)
        recycled = [trade for trade in result.trades if trade["level"] == 1]
        self.assertEqual(len(recycled), 3)

    def test_linear_grid_trigger_matches_anchor_formula(self):
        engine = RecyclableLinearGridEngine(GridConfig())
        engine.anchor = 100_000
        engine.drop_rate = 0.02
        self.assertEqual([engine._level_price(level) for level in range(4)], [100_000, 98_000, 96_000, 94_000])

    def test_pure_mode_has_no_external_topup_and_equity_reconciles(self):
        result = self.simulate([candle(0, 100, 100, 100, 100), candle(1, 100, 101, 99, 100)], slots=2)
        self.assertEqual(result.topups, [])
        self.assertAlmostEqual(20 + result.realized_profit + result.open_pnl(), result.equity())

    def test_rebuy_of_a_level_is_preceded_by_an_upward_rearm(self):
        rows = [candle(0, 100, 100, 100, 100), candle(1, 100, 100, 98, 98), candle(2, 98, 99.5, 98, 99.5), candle(3, 99.5, 99.5, 98, 98)]
        result = self.simulate(rows)
        relevant = [
            (index, event)
            for index, event in enumerate(result.events)
            if event.get("level") == 1 and event["event"] in {"BUY", "REARM"}
        ]
        first_buy = next(index for index, event in relevant if event["event"] == "BUY")
        rearm = next(index for index, event in relevant if event["event"] == "REARM")
        second_buy = [index for index, event in relevant if event["event"] == "BUY"][1]
        self.assertLess(first_buy, rearm)
        self.assertLess(rearm, second_buy)

    def test_monotonic_50_percent_decline_consumes_25_slots(self):
        result = self.simulate([candle(0, 100, 100, 100, 100), candle(1, 100, 100, 50, 50)])
        self.assertEqual(result.max_open_slots, 25)

    def test_repique_frees_and_slot_is_eligible_again(self):
        result = self.simulate([candle(0, 100, 100, 100, 100), candle(1, 100, 100, 98, 98), candle(2, 98, 99.5, 98, 99.5), candle(3, 99.5, 99.5, 98, 98)])
        self.assertEqual(result.slots[1].times_bought, 2)
        self.assertEqual(result.slots[1].real_gains, 1)

    def test_thirty_percent_decline_with_rebounds_recycles(self):
        rows = [
            candle(0, 100, 100, 100, 100),
            candle(1, 100, 100, 70, 70),
            candle(2, 70, 73.5, 70, 73.5),
            candle(3, 73.5, 73.5, 70, 70),
            candle(4, 70, 73.5, 70, 73.5),
        ]
        result = self.simulate(rows)
        self.assertGreaterEqual(len(result.trades), 4)
        self.assertGreater(result.slots[15].times_bought, 1)

    def test_anchor_stays_when_individual_slot_sells(self):
        engine = RecyclableLinearGridEngine(GridConfig(slots=3))
        result = engine.run([candle(0, 100, 100, 100, 100), candle(1, 100, 100, 96, 96), candle(2, 96, 99.5, 96, 99.5)])
        self.assertEqual(result.complete_cycles, 0)
        self.assertEqual(engine.anchor, 100)

    def test_cycle_restarts_only_next_candle(self):
        engine = RecyclableLinearGridEngine(GridConfig(slots=2))
        result = engine.run([candle(0, 100, 100, 100, 100), candle(1, 100, 101, 99, 100), candle(2, 100, 100, 100, 100)])
        self.assertEqual(result.complete_cycles, 1)
        self.assertEqual(result.slots[0].times_bought + result.slots[1].times_bought, 2)

    def test_open_slot_is_ineligible_and_priority_is_leader(self):
        engine = RecyclableLinearGridEngine(GridConfig(slots=3))
        engine.slots[0].operational_gains = 9
        engine.slots[0].position = object()  # type: ignore[assignment]
        engine.slots[1].operational_gains = 8
        engine.slots[2].operational_gains = 8
        engine.slots[2].value = 11
        self.assertEqual(engine._free_leader().slot_id, 3)

    def test_at_most_one_topup_per_month_and_not_profit(self):
        result = self.simulate([candle(0, 100, 100, 100, 100)], slots=2, topups=True)
        self.assertEqual(len(result.topups), 1)
        self.assertEqual(result.realized_profit, 0)

    def test_conservative_does_not_take_same_candle_gain_after_buy(self):
        rows = [candle(0, 100, 100, 100, 100), candle(1, 100, 100, 98, 99.5)]
        heuristic = RecyclableLinearGridEngine(GridConfig()).run(rows)
        conservative = RecyclableLinearGridEngine(GridConfig(), "conservative").run(rows)
        self.assertGreater(len(heuristic.trades), len(conservative.trades))

    def test_ath_regime_does_not_look_ahead_to_new_cycle_candle_high(self):
        engine = RecyclableLinearGridEngine(GridConfig(regime=True))
        engine.run([
            candle(0, 100, 100, 100, 100),
            candle(1, 100, 101, 99, 100),
            candle(2, 100, 200, 100, 105),
        ])
        self.assertAlmostEqual(engine.cycles[-1]["drop_rate"], 0.04)


if __name__ == "__main__":
    unittest.main()
