from __future__ import annotations

import math
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from v2_grid_engine import Candle
from v5_engine import Position, V5Config, V5Engine


def candle(index: int, open_: float, high: float, low: float, close: float) -> Candle:
    return Candle(datetime(2024, 1, 1, tzinfo=timezone.utc) + timedelta(minutes=index), open_, high, low, close)


class V5EngineTest(unittest.TestCase):
    def test_ath_regime_boundaries_are_exact(self):
        engine = V5Engine(V5Config())
        engine.ath = 100
        self.assertEqual(engine.regime_for_price(80.01), "TOPO_4")
        self.assertEqual(engine.regime_for_price(80.00), "TOPO_4")
        self.assertEqual(engine.regime_for_price(79.99), "MEIO_2")
        self.assertEqual(engine.regime_for_price(60.01), "MEIO_2")
        self.assertEqual(engine.regime_for_price(60.00), "MEIO_2")
        self.assertEqual(engine.regime_for_price(59.99), "FUNDO_2")

    def test_new_levels_keep_old_trigger_and_transition_without_overlap(self):
        engine = V5Engine(V5Config())
        engine.ath, engine.anchor = 100, 100
        engine.levels = {0: type("Level", (), {"level_id": 0, "distance": 0.0, "trigger": 100.0})()}
        engine._ensure_deeper_levels(78)
        triggers = [item.trigger for item in engine.levels.values()]
        self.assertEqual(triggers, [100.0, 96.0, 92.0, 88.0, 84.0, 80.0, 78.0])
        self.assertEqual(len(triggers), len(set(triggers)))

    def test_position_is_not_mutated_by_regime_change(self):
        engine = V5Engine(V5Config(slots=2))
        engine.ath = 100
        engine._start_cycle(100, candle(0, 100, 100, 100, 100).time)
        position = engine.slots[0].position
        engine.ath = 200
        self.assertEqual((position.entry, position.target, position.btc_qty), (100, 101, 0.1))

    def test_first_downward_trigger_does_not_use_future_candle_high_as_ath(self):
        engine = V5Engine(V5Config(slots=3))
        engine.run([candle(0, 100, 200, 90, 100), candle(1, 100, 100, 96, 96)])
        buys = [event for event in engine.events if event["event"] == "BUY"]
        self.assertEqual(buys[1]["trigger"], 96.0)

    def test_monotonic_decline_never_exceeds_fifty_slots(self):
        engine = V5Engine(V5Config(adaptive_ath=False))
        engine.run([candle(0, 100, 100, 100, 100), candle(1, 100, 100, 1, 1)])
        self.assertEqual(engine.max_open_slots, 50)

    def test_recycle_and_cycle_reset(self):
        engine = V5Engine(V5Config(slots=2, adaptive_ath=False))
        engine.run([candle(0, 100, 100, 100, 100), candle(1, 100, 100, 98, 98), candle(2, 98, 99.5, 98, 99.5), candle(3, 99.5, 99.5, 98, 98)])
        self.assertGreaterEqual(len(engine.trades), 1)
        self.assertTrue(any(event["event"] == "REARM" for event in engine.events))
        self.assertLessEqual(engine.max_open_slots, 2)

    def redistribute(self, values: list[int]) -> V5Engine:
        engine = V5Engine(V5Config(slots=len(values), redistribute_monthly=True))
        engine._month = "2024-01"
        for slot, gains in zip(engine.slots, values):
            slot.operational_gains = gains
        return engine

    def test_redistribution_examples_and_conservation(self):
        for original, expected in [([7, 2, 0, 0], [3, 3, 3, 0]), ([10, 0, 0, 0], [3, 3, 3, 1]), ([17, 0, 0, 0, 0, 0], [3, 3, 3, 3, 3, 2])]:
            engine = self.redistribute(original)
            before = sum(slot.value for slot in engine.slots)
            engine._redistribute_month(candle(0, 100, 100, 100, 100))
            self.assertEqual([slot.operational_gains for slot in engine.slots], expected)
            self.assertTrue(math.isclose(before, sum(slot.value for slot in engine.slots), abs_tol=1e-9))

    def test_open_slot_does_not_donate_or_receive_and_locked_excess_is_reported(self):
        engine = self.redistribute([7, 0, 0])
        slot = engine.slots[0]
        slot.position = Position(0, 1, 100, 100, 101, candle(0, 100, 100, 100, 100).time, 10)
        _, _, locked, _ = engine._redistribute_month(candle(0, 100, 100, 100, 100))
        self.assertEqual(slot.operational_gains, 7)
        self.assertEqual(locked, 4)
        self.assertFalse(any(row["donor_slot"] == 1 or row["receiver_slot"] == 1 for row in engine.redistributions))

    def test_zero_external_topup(self):
        engine = V5Engine(V5Config(redistribute_monthly=True))
        engine.run([candle(0, 100, 100, 100, 100)])
        self.assertFalse(hasattr(engine, "topups"))


if __name__ == "__main__":
    unittest.main()
