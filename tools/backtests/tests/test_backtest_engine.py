from __future__ import annotations

import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backtest_engine import BacktestEngine, Candle
from strategy_slot_leader import StrategyConfig, select_entry_slot, select_leader


def candle(offset: int, open_: float, high: float, low: float, close: float) -> Candle:
    return Candle(datetime(2024, 1, 1, tzinfo=timezone.utc) + timedelta(minutes=offset), open_, high, low, close)


class BacktestEngineTest(unittest.TestCase):
    def run_engine(self, candles, mode="heuristic", slots=3, topups=False):
        return BacktestEngine(StrategyConfig(slot_count=slots, enable_topups=topups), "1m", mode).run(candles)

    def test_entra_quando_low_cruza_gatilho(self):
        result = self.run_engine([candle(0, 100, 100, 100, 100), candle(1, 100, 100, 97.9, 98)])
        self.assertEqual(result.total_entries, 2)
        self.assertEqual(result.slots[1].position.buy_price, 98)

    def test_sai_quando_high_cruza_alvo(self):
        result = self.run_engine([candle(0, 100, 100, 100, 100), candle(1, 100, 101, 99, 100)])
        self.assertEqual(result.total_exits, 1)
        self.assertAlmostEqual(result.slots[0].value, 10.1)

    def test_multiplas_entradas_no_mesmo_candle(self):
        result = self.run_engine([candle(0, 100, 100, 100, 100), candle(1, 100, 100, 93.9, 94)], slots=4)
        self.assertEqual(result.total_entries, 4)

    def test_multiplas_saidas_no_mesmo_candle(self):
        result = self.run_engine([candle(0, 100, 100, 100, 100), candle(1, 100, 100, 95, 95), candle(2, 95, 101, 95, 100)], slots=3)
        self.assertEqual(result.total_exits, 3)

    def test_prioriza_maior_gain_e_valor(self):
        engine = BacktestEngine(StrategyConfig(slot_count=3), "1m", "heuristic")
        engine.slots[0].gains_operational = 4
        engine.slots[1].gains_operational = engine.slots[2].gains_operational = 6
        engine.slots[1].value, engine.slots[2].value = 10, 11
        self.assertEqual(select_leader(engine.slots).slot_id, 3)

    def test_controle_por_numero_ignora_gains_na_entrada(self):
        engine = BacktestEngine(StrategyConfig(slot_count=3), "1m", "heuristic")
        engine.slots[0].gains_operational = 1
        engine.slots[1].gains_operational = 99
        self.assertEqual(select_entry_slot(engine.slots, "slot-number").slot_id, 1)

    def test_slot_preso_nunca_recebe_aporte(self):
        result = self.run_engine([candle(0, 100, 100, 100, 100), candle(1, 100, 100, 70, 70)], slots=2, topups=True)
        self.assertTrue(any(row["slot_id"] == "NO_FREE_SLOT" for row in result.topups))

    def test_meta_mensal_e_aporte_composto(self):
        result = self.run_engine([candle(0, 100, 100, 100, 100), candle(1, 100, 101, 99, 100)], slots=2, topups=True)
        topup = next(row for row in result.topups if row["slot_id"] != "NO_FREE_SLOT")
        self.assertEqual(topup["target_gains"], 7)
        self.assertAlmostEqual(topup["slot_value_after"], topup["slot_value_before"] * 1.01 ** topup["missing_gains"])

    def test_novo_ciclo_so_no_candle_seguinte(self):
        result = self.run_engine([candle(0, 100, 100, 100, 100), candle(1, 100, 101, 99, 100), candle(2, 100, 100, 100, 100)])
        self.assertEqual(result.total_entries, 2)
        self.assertEqual(result.slots[0].times_bought, 2)

    def test_sem_aporte_quando_lider_bate_meta(self):
        engine = BacktestEngine(StrategyConfig(slot_count=2, enable_topups=True), "1m", "heuristic")
        engine.slots[0].gains_operational = 8
        engine.slots[1].gains_operational = 8
        result = engine.run([candle(0, 100, 100, 100, 100)])
        self.assertFalse(result.topups)

    def test_conservative_nao_realiza_compra_e_venda_mesmo_candle(self):
        candles = [candle(0, 100, 100, 100, 100), candle(1, 100, 101, 97, 100)]
        self.assertGreater(self.run_engine(candles, "heuristic").total_exits, self.run_engine(candles, "conservative").total_exits)


if __name__ == "__main__":
    unittest.main()
