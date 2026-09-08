"""Casos obrigatórios da equalização Meta7, inclusive doador aberto."""
from __future__ import annotations
import math
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from meta7_equalization_engine import Meta7Config, Meta7EqualizationEngine, DebitPosition
from v2_grid_engine import Candle

class Meta7Test(unittest.TestCase):
 def engine(self,n=4):
  e=Meta7EqualizationEngine(Meta7Config(slots=n,equalize=True),'B'); e._month='2020-01'; e._last_candle=Candle(datetime(2020,1,31,tzinfo=timezone.utc),100,100,100,100); return e
 def set(self,e, values, opened=()):
  for i,gain in enumerate(values):
   s=e.slots[i]; s.real_gains=gain+100; s.operational_gains=gain; s.value=10*(1.01**gain)
   if i in opened: s.position=DebitPosition(i,1,100,100,101,datetime(2020,1,1,tzinfo=timezone.utc),s.value,s.value/100)
 def test_open_donor_transfers_now_without_mutating_position(self):
  e=self.engine(3); self.set(e,[20,10,12],{0}); p=e.slots[0].position; before=(p.btc_qty,p.entry,p.target,e.equity(100)); r=e._equalize(14)
  self.assertEqual([s.operational_gains for s in e.slots],[14,14,14]); self.assertEqual((p.btc_qty,p.entry,p.target),before[:3]); self.assertGreater(p.redistribution_debit_balance,0); self.assertTrue(math.isclose(e.equity(100),before[3])); self.assertEqual(r['open_donors'],1)
 def test_residual_topup_only_after_open_donor_excess(self):
  e=self.engine(2); self.set(e,[17,10],{0}); e._equalize(14); r=e._external_topup(14)
  self.assertEqual(e.slots[1].operational_gains,14); self.assertEqual(r['missing_gains'],1); self.assertGreater(r['topup_value'],0)
 def test_multiple_donors_receivers_preserve_real_and_equity(self):
  e=self.engine(); self.set(e,[30,25,18,10]); before=e.equity(100); real=[s.real_gains for s in e.slots]; e._equalize(21)
  self.assertEqual(real,[s.real_gains for s in e.slots]); self.assertTrue(math.isclose(before,e.equity(100))); self.assertEqual([s.operational_gains for s in e.slots],[21,21,21,20])
 def test_open_debit_is_settled_once_on_sale(self):
  e=self.engine(2); self.set(e,[20,10],{0}); e.open_by_level[0]=e.slots[0]; e.levels={0:type('L',(),{'distance':0.0})()}; e._equalize(14); debit=e.slots[0].position.redistribution_debit_balance; gross=e.slots[0].position.value_at_entry*1.01; e._sell(e.slots[0],datetime(2020,2,1,tzinfo=timezone.utc)); self.assertTrue(math.isclose(e.slots[0].value,gross-debit))
