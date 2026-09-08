"""Testes do V6: excedente do mês, conservação e independência entre meses."""

from __future__ import annotations

import math
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from v6_engine import V6Config, V6Engine


class V6MonthlyRedistributionTest(unittest.TestCase):
    def _engine(self, slots: int, cap: int = 3) -> V6Engine:
        return V6Engine(V6Config(slots=slots, monthly_cap=cap))

    def _apply(self, engine: V6Engine, gains: list[int], open_slots: set[int] | None = None) -> dict:
        open_slots = open_slots or set()
        for slot, count in zip(engine.slots, gains):
            slot.real_gains_month = count
            slot.real_gains = count + 100
            slot.operational_gains = count + 100
            slot.value = 10 * (1.01 ** (count + 100))
            if slot.slot_id in open_slots:
                slot.position = object()
        return engine._redistribute_month()

    def test_monthly_7_2_0_spreads_to_3_3_3_without_changing_real_history(self) -> None:
        engine = self._engine(3)
        result = self._apply(engine, [7, 2, 0])
        equivalents = [engine._monthly_equivalent(slot) for slot in engine.slots]
        self.assertEqual(equivalents, [3.0, 3.0, 3.0])
        self.assertEqual([slot.real_gains for slot in engine.slots], [107, 102, 100])
        self.assertEqual(result["redistributed_gain_equivalent"], 4.0)
        self.assertEqual(result["unredistributed_monthly_excess"], 0.0)
        expected_value_before_transfer = sum(10 * (1.01 ** (100 + gain)) for gain in [7, 2, 0])
        self.assertTrue(math.isclose(expected_value_before_transfer, sum(slot.value for slot in engine.slots), abs_tol=1e-10))

    def test_monthly_10_0_0_0_becomes_10_3_3_3_by_only_moving_excess(self) -> None:
        engine = self._engine(4)
        self._apply(engine, [10, 0, 0, 0])
        equivalents = [engine._monthly_equivalent(slot) for slot in engine.slots]
        self.assertEqual(equivalents, [3.0, 3.0, 3.0, 1.0])

    def test_monthly_17_uses_six_slots_when_available(self) -> None:
        engine = self._engine(6)
        result = self._apply(engine, [17, 0, 0, 0, 0, 0])
        equivalents = [engine._monthly_equivalent(slot) for slot in engine.slots]
        self.assertEqual(equivalents, [3.0, 3.0, 3.0, 3.0, 3.0, 2.0])
        self.assertEqual(result["redistributed_gain_equivalent"], 14.0)

    def test_new_month_does_not_carry_receipt_or_obligation(self) -> None:
        engine = self._engine(3)
        self._apply(engine, [7, 2, 0])
        for slot in engine.slots:
            slot.real_gains_month = 0
            slot.monthly_received_equivalent = 0.0
            slot.monthly_donated_equivalent = 0.0
        self.assertEqual([engine._monthly_equivalent(slot) for slot in engine.slots], [0.0, 0.0, 0.0])

    def test_open_slot_is_locked_and_cannot_donate_or_receive(self) -> None:
        engine = self._engine(3)
        result = self._apply(engine, [7, 0, 0], {1})
        self.assertEqual(result["locked_monthly_excess"], 4.0)
        self.assertEqual(result["redistributed_gain_equivalent"], 0.0)
        self.assertEqual(engine.slots[1].monthly_received_equivalent, 0.0)

    def test_control_has_no_redistribution_or_external_topup(self) -> None:
        engine = V6Engine(V6Config(slots=3, monthly_cap=None))
        self._apply(engine, [7, 0, 0])
        self.assertEqual(engine.total_redistributed, 0.0)
        self.assertEqual(engine.config.initial_value * engine.config.slots, 30.0)
