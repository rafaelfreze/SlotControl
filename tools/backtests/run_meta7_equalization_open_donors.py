"""Executa comparação local: controle BTC puro vs Meta7 com doadores abertos."""
from __future__ import annotations
import argparse,csv,json,math,statistics
from collections import defaultdict
from datetime import date
from pathlib import Path
from backtest_btc_v2 import END,ROOT,profile_effective_series,profile_gaps,read_daily_fills,write_csv
from v2_grid_engine import load_cached_klines
from meta7_equalization_engine import Meta7Config,Meta7EqualizationEngine

START=date(2017,8,17)
SCENARIOS={'A':('Controle puro 25x10, 2% fixo',Meta7Config(equalize=False)),'B':('Meta 7 acumulada + equalização + aporte residual',Meta7Config(equalize=True))}

def summary(code,label,e):
 last=e._last_candle; assert last
 initial=e.config.slots*e.config.initial_value; equity=e.equity(last.close); pnl=e.open_pnl(last.close); expected=initial+e.cumulative_topup+e.realized_profit+pnl
 if not math.isclose(equity,expected,abs_tol=1e-8,rel_tol=1e-12): raise AssertionError('contabilidade não fecha')
 tops=[r['topup_value'] for r in e.external_topups]
 return {'scenario':code,'description':label,'initial_capital':initial,'real_gains':len(e.trades),'final_equity':equity,'realized_profit':e.realized_profit,'open_pnl':pnl,'external_topup_total':e.cumulative_topup,'total_contributed':initial+e.cumulative_topup,'net_profit_vs_contributed':equity-initial-e.cumulative_topup,'return_on_contributed_pct':(equity/(initial+e.cumulative_topup)-1)*100,'total_redistributed_value':e.total_redistributed,'total_debited_open_positions':e.total_debited_open_positions,'topup_average':statistics.mean(tops) if tops else 0.0,'topup_median':statistics.median(tops) if tops else 0.0,'topup_max':max(tops) if tops else 0.0,'months_with_topup':sum(v>0 for v in tops),'months_without_topup':len(e.monthly)-sum(v>0 for v in tops),'max_open_slots':e.max_open_slots,'cycles':e.complete_cycles,'slots_at_target_final':sum(s.operational_gains==len(e.monthly)*7 for s in e.slots),'open_slots_final':len(e._open()),'accounting_difference':expected-equity}

def control_assert(result):
 if result['real_gains']!=6269 or not math.isclose(result['final_equity'],2462.6975838782696,abs_tol=1e-8): raise AssertionError(f'controle divergiu: {result}')

def details(e):
 last=e._last_candle; assert last
 slots=[]
 for s in e.slots:
  p=s.position; market=p.btc_qty*last.close if p else 0.0
  slots.append({'scenario':e.scenario,'slot_id':s.slot_id,'status':'OPEN' if p else ('FREE' if s.value>0 else 'FREE_DEBIT'),'real_gains':s.real_gains,'operational_gains':s.operational_gains,'value':s.value,'times_bought':s.times_bought,'times_sold':s.times_sold,'total_received_redistribution':s.received,'total_donated_redistribution':s.donated,'entry_if_open':p.entry if p else '','target_if_open':p.target if p else '','btc_qty_if_open':p.btc_qty if p else 0.0,'debit_balance_if_open':p.redistribution_debit_balance if p else 0.0,'market_value_if_open':market,'unrealized_pnl':market-p.value_at_entry-p.redistribution_debit_balance if p else 0.0})
 yearly=[]; groups=defaultdict(list)
 for r in e.monthly: groups[r['month'][:4]].append(r)
 for y,rs in sorted(groups.items()):
  tops=[r for r in e.external_topups if r['month'].startswith(y)]
  yearly.append({'year':y,'scenario':e.scenario,'start_equity':rs[0]['equity_end']-rs[0]['realized_profit']-rs[0]['external_topup']-rs[0]['open_pnl'],'end_equity':rs[-1]['equity_end'],'real_gains':sum(r['real_gains_month'] for r in rs),'realized_profit':sum(r['realized_profit'] for r in rs),'topup_total':sum(r['topup_value'] for r in tops),'topup_average_month':statistics.mean([r['topup_value'] for r in tops]) if tops else 0.0,'topup_max_month':max([r['topup_value'] for r in tops],default=0.0),'months_with_topup':sum(r['topup_value']>0 for r in tops),'redistributed_value':sum(r['redistributed_value'] for r in rs),'open_donors':sum(r['open_donors'] for r in rs),'slots_at_target_end':rs[-1]['slots_at_target']})
 return {'monthly':e.monthly,'yearly':yearly,'slots':slots,'trades':e.trades,'cycles':e.cycles,'redistributions':e.redistributions,'topups':e.external_topups}

FIELDS={'monthly':['month','target','real_gains_month','real_gains_total','donors','open_donors','receivers','redistributed_value','redistributed_gain_equivalent','external_topup','cumulative_topup','slots_at_target','slots_below_target','slots_above_target_after','equity_end','open_slots'],'yearly':['year','scenario'],'slots':['scenario','slot_id'],'trades':['scenario','cycle_id'],'cycles':['scenario','cycle_id'],'redistributions':['month','donor_slot'],'topups':['month','target','slot_id','operational_before','missing_gains','value_before','topup_value','value_after']}

def run(output,code):
 label,cfg=SCENARIOS[code]; cache=ROOT/'backtest-data'; e=Meta7EqualizationEngine(cfg,code).run(load_cached_klines(cache,START,END,read_daily_fills(cache,START,END))); result=summary(code,label,e)
 if code=='A': control_assert(result)
 (output/f'scenario_{code}.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
 for name,rows in details(e).items(): write_csv(output/f'detail_{code}_{name}.csv',rows,list(rows[0]) if rows else FIELDS[name])
 print(output/f'scenario_{code}.json')

def consolidate(output):
 results=[json.loads((output/f'scenario_{c}.json').read_text(encoding='utf-8')) for c in SCENARIOS]
 mapping={'monthly':'monthly.csv','yearly':'yearly.csv','slots':'slots.csv','trades':'trades.csv','cycles':'cycles.csv','redistributions':'redistributions.csv','topups':'external_topups.csv'}
 for name,dest in mapping.items():
  rows=[]
  for code in SCENARIOS:
   with (output/f'detail_{code}_{name}.csv').open(encoding='utf-8',newline='') as f:
    source=list(csv.DictReader(f))
    if name in {'monthly','redistributions','topups'}:
     for row in source: row.setdefault('scenario',code)
    rows.extend(source)
  write_csv(output/dest,rows,list(rows[0]) if rows else FIELDS[name])
 write_csv(output/'comparison_control.csv',results,list(results[0]))
 accounting={r['scenario']:{'capital_initial':r['initial_capital'],'external_topups':r['external_topup_total'],'realized_trading_result':r['realized_profit'],'unrealized_pnl':r['open_pnl'],'patrimony_final':r['final_equity'],'difference':r['accounting_difference']} for r in results}
 (output/'accounting.json').write_text(json.dumps(accounting,indent=2),encoding='utf-8')
 cache=ROOT/'backtest-data'; raw,first,last,_=profile_gaps(cache,START,END); fills=read_daily_fills(cache,START,END); effective,_,_,gaps=profile_effective_series(cache,START,END,fills)
 doc={'period':{'first_timestamp':first.isoformat(),'last_timestamp':last.isoformat(),'raw_candles':raw,'effective_candles':effective,'remaining_gaps':len(gaps),'remaining_missing_minutes':sum(r['missing_minutes'] for r in gaps)},'open_donor_accounting':'Para doador aberto, o valor transferido aumenta redistribution_debit_balance. Equity e PnL aberto descontam este saldo; na venda slot_value_after = gross_proceeds - debit_settled.','scenarios':results}
 (output/'summary.json').write_text(json.dumps(doc,indent=2),encoding='utf-8')
 (output/'README.md').write_text('# Meta 7 — equalização com doadores abertos\n\nA equalização é local e não altera posição BTC em andamento. Débitos de doadores abertos viram uma obrigação registrada contra o valor de mercado e são liquidados uma única vez no fechamento futuro da posição.\n',encoding='utf-8')
 lines=['# Simulação Meta 7', '', '| Cenário | Equity final | Gains reais | Redistribuído | Aporte externo | Retorno sobre capital total |','|---|---:|---:|---:|---:|---:|']
 lines += [f"| {r['scenario']} | {r['final_equity']:.2f} | {r['real_gains']} | {r['total_redistributed_value']:.2f} | {r['external_topup_total']:.2f} | {r['return_on_contributed_pct']:.2f}% |" for r in results]
 (output/'summary.md').write_text('\n'.join(lines)+'\n',encoding='utf-8')
 print(output)

def main():
 p=argparse.ArgumentParser();p.add_argument('--output',type=Path,required=True);p.add_argument('--scenario',choices=SCENARIOS);p.add_argument('--finalize',action='store_true');a=p.parse_args();a.output.mkdir(parents=True,exist_ok=True)
 if a.scenario: run(a.output,a.scenario)
 elif a.finalize: consolidate(a.output)
 else: raise SystemExit('informe --scenario ou --finalize')
if __name__=='__main__':main()
