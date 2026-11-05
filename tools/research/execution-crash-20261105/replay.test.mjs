import {test} from 'node:test';
import assert from 'node:assert/strict';
import {replay,syntheticPath} from './run-study.mjs';
const cfg={capital:1000,slots:25,spacing:.01,gain:.055,fee:.001,slippage:.0002};
for(const name of ['DROP1_5','DROP3_5','DROP5_5','DROP10_5','DROP20_180','DROP30_1440','DROP50_60','DROP70_60','FLASH_V','SUCCESSIVE_DAYS','GRADUAL','SIDEWAYS','UPTREND'])test(`${name}: deterministic paired replay, funded slots, TP economics`,()=>{
  const bars=syntheticPath(name),a=replay(bars,'SOLBRL',cfg,null,bars[72].at),b=replay(bars,'SOLBRL',cfg,null,bars[72].at);
  assert.deepEqual(a,b);
  for(const r of [a.baseline,a.protected]){
    assert(r.open<=cfg.slots&&r.maxOpen<=cfg.slots&&r.gains<=r.buys);
    assert(r.equity>=0&&r.fees>=0&&r.maxDD>=0&&r.maxDD<=1);
    assert.equal(r.marketBuys+r.limitBuys,r.buys);
    assert(r.realized>=0); // Gross gain in these fixtures exceeds fees; not a net gain guarantee.
  }
  assert.deepEqual(a.configuration,cfg);assert.equal(a.financialCertification,'NOT_CERTIFIED_SURROGATE_GRID_NO_DEPTH_FILTERS_RUNTIME_OR_LEDGER');
});
test('gradual decline remains a normal strategy event, not a spacing-derived crash',()=>{
  const bars=syntheticPath('GRADUAL'),a=replay(bars,'SOLBRL',cfg,null,bars[72].at);
  assert.equal(a.comparison.pauses,0);assert.equal(a.comparison.pausedBars,0);
});
