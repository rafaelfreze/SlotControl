"""Testes locais do aporte V7 em posições abertas."""

from __future__ import annotations

import math
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from v2_grid_engine import Candle
from v7_engine import V7Config, V7Engine, V7Position


class V7TopupTest(unittest.TestCase):
    def _engine(self, cap: float = 1000.0) -> V7Engine:
        return V7Engine(V7Config(slots=3, topup_enabled=True, monthly_topup_cap=cap), "T")

    def _open(self, engine: V7Engine, slot_id: int, cost: float, price: float = 100.0) -> None:
        slot = engine.slots[slot_id - 1]
        slot.position = V7Position(0, 1, price, price, price, price * 1.01, datetime(2020, 1, 31, tzinfo=timezone.utc), cost, cost / price)

    def _candle(self, price: float = 100.0) -> Candle:
        return Candle(datetime(2020, 1, 31, tzinfo=timezone.utc), price, price, price, price)

    def test_open_receives_two_percent_and_free_receives_zero(self) -> None:
        engine = self._engine()
        self._open(engine, 1, 100)
        result = engine._apply_monthly_topups(self._candle())
        self.assertEqual(result["actual_total"], 2.0)
        self.assertEqual(len(engine.topups_by_slot), 1)
        self.assertEqual(engine.slots[1].value, 10.0)

    def test_below_exact_and_above_cap_have_correct_global_rate(self) -> None:
        for costs, cap, expected_rate, expected_total in [([100], 1000, .02, 2), ([50000], 1000, .02, 1000), ([100000], 1000, .01, 1000)]:
            engine = self._engine(cap)
            for index, cost in enumerate(costs, 1): self._open(engine, index, cost)
            result = engine._apply_monthly_topups(self._candle())
            self.assertTrue(math.isclose(result["effective_rate"], expected_rate))
            self.assertTrue(math.isclose(result["actual_total"], expected_total))
            self.assertLessEqual(result["actual_total"], cap + 1e-9)

    def test_empty_month_has_zero_and_no_debt(self) -> None:
        engine = self._engine()
        result = engine._apply_monthly_topups(self._candle())
        self.assertEqual(result["actual_total"], 0.0)
        self.assertEqual(engine.cumulative_topups, 0.0)

    def test_capped_month_does_not_create_debt_for_next_month(self) -> None:
        engine = self._engine()
        self._open(engine, 1, 100000)
        engine._month = "2020-01"
        first = engine._apply_monthly_topups(self._candle())
        self.assertEqual(first["actual_total"], 1000.0)
        engine.slots[0].position.cost_basis = 100.0
        engine._month = "2020-02"
        second = engine._apply_monthly_topups(self._candle())
        self.assertEqual(second["actual_total"], 2.0)

    def test_btc_cost_average_target_and_real_gains_are_correct(self) -> None:
        engine = self._engine()
        self._open(engine, 1, 100, 200)
        engine._apply_monthly_topups(self._candle(100))
        pos = engine.slots[0].position
        self.assertTrue(math.isclose(pos.btc_qty, .5 + .02))
        self.assertTrue(math.isclose(pos.cost_basis, 102))
        self.assertTrue(math.isclose(pos.average_cost, 102 / .52))
        self.assertTrue(math.isclose(pos.target, pos.average_cost * 1.01))
        self.assertEqual(engine.slots[0].real_gains, 0)

    def test_sale_uses_new_quantity_target_and_accounting_closes(self) -> None:
        engine = self._engine()
        self._open(engine, 1, 100, 200)
        engine._apply_monthly_topups(self._candle(100))
        pos = engine.slots[0].position
        engine.open_by_level[0] = engine.slots[0]
        engine.levels = {0: type("L", (), {"distance": 0.0})()}
        engine._sell(engine.slots[0], datetime(2020, 2, 1, tzinfo=timezone.utc))
        self.assertTrue(math.isclose(engine.slots[0].value, 102 * 1.01))
        self.assertTrue(math.isclose(engine.realized_profit, 1.02))
        self.assertEqual(engine.slots[0].real_gains, 1)
