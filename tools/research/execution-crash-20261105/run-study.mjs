/** Local files only. No network, env, secrets, DB, exchange or runtime imports. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {MIN,POLICY,features,createDetector,detect,quantile} from './protection.mjs';
const ROOT=path.dirname(fileURLToPath(import.meta.url)),REPO=path.resolve(ROOT,'../../..');
const sha=x=>createHash('sha256').update(x).digest('hex');
const round=x=>Number.isFinite(x)?Number(x.toFixed(8)):null;
const manifest=JSON.parse(fs.readFileSync(path.join(ROOT,'data-manifest.json'),'utf8'));
function load(symbol){
  const d=manifest.datasets.find(x=>x.symbol===symbol&&x.interval==='5m');assert(d,'DATASET_NOT_FOUND');
  const bytes=fs.readFileSync(path.join(REPO,d.path));assert.equal(sha(bytes),d.sha256,'DATA_HASH_MISMATCH');
  const lines=bytes.toString('utf8').trim().split(/\r?\n/);assert.equal(lines.shift(),'timestamp,open,high,low,close,volume,quote_volume,trades');
  let previous=null,gaps=0,zeroVolume=0;
  const bars=lines.map(l=>{const a=l.split(',').map(Number),[openAt,open,high,low,close,volume]=a;
    assert(a.length===8&&a.every(Number.isFinite)&&low>0&&low<=Math.min(open,close)&&high>=Math.max(open,close)&&volume>=0,'BAD_BAR');
    assert(previous===null||openAt>previous,'TIME_NOT_UNIQUE');if(previous!==null&&openAt-previous!==POLICY.stepMs)gaps++;
    previous=openAt;if(!volume)zeroVolume++;return {at:openAt+POLICY.stepMs,open,high,low,close,volume};});
  assert.equal(bars.length,d.rows);
  return {bars,evidence:{symbol,path:d.path,sha256:d.sha256,rows:bars.length,firstClose:new Date(bars[0].at).toISOString(),lastClose:new Date(bars.at(-1).at).toISOString(),gaps,zeroVolume,
    source:'Binance Data Vision official native Spot OHLCV',dataManifestSha256:sha(fs.readFileSync(path.join(ROOT,'data-manifest.json'))),liquidityDepthAvailable:false}};
}
function calibration(bars,symbol){
  const groups={};let continuous=0;
  for(let i=0;i<bars.length;i++){
    continuous=i&&bars[i].at-bars[i-1].at===POLICY.stepMs?continuous+1:1;
    if(continuous<=12)continue;const year=new Date(bars[i].at).getUTCFullYear();groups[year]??=[[],[],[]];
    POLICY.windows.forEach((w,j)=>{const loss=1-bars[i].close/bars[i-w].close;if(loss>0)groups[year][j].push(loss);});
  }
  const asset=symbol.startsWith('BTC')?'BTC':'SOL',out={};
  for(const [year,losses] of Object.entries(groups))if(losses.every(a=>a.length>=POLICY.minimumTraining))out[+year+1]={
    trainingYear:+year,samples:losses.map(a=>a.length),thresholds:losses.map((a,j)=>Math.max(POLICY.floors[asset][j],quantile(a,POLICY.quantile)))};
  return out;
}
function engine(config,protectedMode,symbol){return {config,protectedMode,symbol,slots:Array.from({length:config.slots},(_,i)=>({id:i+1,balance:config.capital/config.slots,position:null,gains:0})),
  resident:null,nextPrice:null,first:true,reanchor:false,lastClosedAt:null,buys:0,gains:0,realized:0,fees:0,maxOpen:0,maxCommitted:0,peakEquity:config.capital,maxDD:0,
  cancellations:0,marketBuys:0,limitBuys:0,recoveryReplans:0,firstExhaustedAt:null,submissions:0,heldBars:0,canceledLevels:[],matchedAvoided:0,gainTimes:[]};}
function buy(e,slot,price,at,kind){
  const fee=e.config.fee,spend=slot.balance,qty=spend/(price*(1+fee));assert(!slot.position&&spend>0,'DUPLICATE_OR_UNFUNDED');
  const tick={BTCBRL:1,BTCUSDT:.01,SOLBRL:.1,SOLUSDT:.01}[e.symbol];
  assert(tick,'TICK_UNKNOWN');
  // Runtime target is gross fill average * (1+gain), then CEIL tick. Fees reduce
  // net profit; they are not added to the gain target. Historical filters remain unknown.
  const tp=Math.ceil((price*(1+e.config.gain)-1e-10)/tick)*tick;
  slot.position={qty,cost:spend,price,tp,at};slot.balance=0;
  e.buys++;e[`${kind}Buys`]++;e.fees+=qty*price*fee;e.first=false;
}
function step(e,b,d,previousAt){
  const c=e.config,paused=e.protectedMode&&!['NORMAL','GRADUAL_RESTART'].includes(d.state),existing=e.slots.filter(s=>s.position);
  // Resident execution is accounted before any close-of-bar cancellation/reset.
  // We cannot assume the bar's TP high occurred before its BUY low.
  if(e.resident&&b.low<=e.resident.price){const r=e.resident;buy(e,e.slots[r.slot],Math.min(b.open,r.price),b.at,'limit');e.nextPrice=r.price*(1-c.spacing);e.resident=null;}
  // TP existed before current bar; same-bar new BUY/TP path is not invented.
  for(const s of existing)if(b.high>=s.position.tp){const p=s.position,net=p.qty*p.tp*(1-c.fee),gain=net-p.cost;
    e.fees+=p.qty*p.tp*c.fee;e.realized+=gain;s.balance=net;s.position=null;s.gains++;e.gains++;e.gainTimes.push(b.at);}
  // Symmetric model correction: a completely closed cycle cancels its old unused
  // resident entry before resetting. Otherwise the baseline can wait years on a
  // stale deep limit while the candidate reanchors, an invalid treatment benefit.
  if(existing.length&&!e.slots.some(s=>s.position)){
    if(e.resident){e.cancellations++;e.resident=null;}e.first=true;e.nextPrice=null;
  }
  if(paused){e.heldBars++;if(e.resident){e.canceledLevels.push({at:b.at,price:e.resident.price});e.cancellations++;e.resident=null;}e.reanchor=true;}
  if(e.protectedMode&&d.state==='GRADUAL_RESTART'){e.nextPrice=b.close*(1-c.spacing);e.recoveryReplans++;e.reanchor=false;}
  const available=e.slots.filter(s=>!s.position).sort((a,b)=>b.gains-a.gains||a.id-b.id);
  if(!paused&&!e.resident&&available.length){
    const slot=available[0];
    if(e.first&&!(e.protectedMode&&(e.reanchor||d.state==='GRADUAL_RESTART'))){
      buy(e,slot,b.close*(1+c.slippage),b.at,'market');e.nextPrice=b.close*(1-c.spacing);e.submissions++;
    }else{e.nextPrice??=b.close*(1-c.spacing);
      // Candidate recovery never retroactively fills canceled/missed levels.
      if(b.close<=e.nextPrice&&!(e.protectedMode&&(e.reanchor||d.state==='GRADUAL_RESTART'))){
        buy(e,slot,b.close*(1+c.slippage),b.at,'market');e.nextPrice*=1-c.spacing;e.submissions++;
      }else {e.resident={slot:slot.id-1,price:e.nextPrice};e.submissions++;}
    }
  }
  const pos=e.slots.filter(s=>s.position),openCost=pos.reduce((s,x)=>s+x.position.cost,0),cash=e.slots.reduce((s,x)=>s+x.balance,0);
  const equity=cash+pos.reduce((s,x)=>s+x.position.qty*b.close*(1-c.fee),0);
  e.equity=equity;e.openCost=openCost;e.open=pos.length;e.maxOpen=Math.max(e.maxOpen,pos.length);
  e.maxCommitted=Math.max(e.maxCommitted,openCost+(e.resident?e.slots[e.resident.slot].balance:0));
  e.peakEquity=Math.max(e.peakEquity,equity);e.maxDD=Math.max(e.maxDD,1-equity/e.peakEquity);
  if(pos.length===c.slots)e.firstExhaustedAt??=b.at;
  e.unobservedMinutes=(e.unobservedMinutes??0)+(previousAt&&b.at-previousAt>POLICY.stepMs?(b.at-previousAt-POLICY.stepMs)/MIN:0);
}
function finish(e){const r=Object.fromEntries(['buys','gains','realized','fees','equity','openCost','open','maxOpen','maxCommitted','maxDD','marketBuys','limitBuys','cancellations','recoveryReplans','submissions','heldBars','unobservedMinutes'].map(k=>[k,round(e[k]??0)]));
  r.firstExhaustedAt=e.firstExhaustedAt;r.unrealized=round(e.equity-e.config.capital-e.realized);r.netReturn=round(e.equity/e.config.capital-1);return r;}
export function replay(bars,symbol,config,cal=null,startAt=bars[0].at){
  const a=engine(config,false,symbol),p=engine(config,true,symbol),history=[];let d=createDetector(),lastAt=null,pauses=0,resumes=0,pausedBars=0,marketPausedBars=0,dataPausedBars=0,validBars=0,dataBars=0;
  const episodes=[];let ep=null;
  for(const b of bars){history.push(b);if(history.length>73)history.shift();
    if(b.at<startAt)continue;
    const year=new Date(b.at).getUTCFullYear(),f=features(history,symbol,b.at,cal?.[year]??null);
    const before=d;d=detect(d,f);if(f.valid)validBars++;else dataBars++;
    const blocked=!['NORMAL','GRADUAL_RESTART'].includes(d.state);if(blocked){pausedBars++;if(f.valid&&d.reason==='MARKET')marketPausedBars++;else dataPausedBars++;}
    if(before.state==='NORMAL'&&blocked){pauses++;ep={start:b.at,startPrice:b.close,aCost:a.openCost??0,pCost:p.openCost??0};}
    if(d.state==='GRADUAL_RESTART'){resumes++;if(ep){episodes.push({...ep,end:b.at,durationMinutes:(b.at-ep.start)/MIN,aGains:a.gains,pGains:p.gains});ep=null;}}
    step(a,b,d,lastAt);step(p,b,d,lastAt);lastAt=b.at;
  }
  if(ep)episodes.push({...ep,end:null,censored:true});
  const aa=finish(a),pp=finish(p),gainRetention=aa.gains?pp.gains/aa.gains:null,returnDelta=(pp.equity-aa.equity)/config.capital,ddDelta=pp.maxDD-aa.maxDD;
  return {symbol,configuration:config,coverage:{validBars,dataBars},baseline:aa,protected:pp,
    comparison:{gainRetention:round(gainRetention),returnDelta:round(returnDelta),ddDelta:round(ddDelta),buysDelta:pp.buys-aa.buys,
      pauses,resumes,pausedBars,marketPausedBars,dataPausedBars,pauseFraction:round(pausedBars/(validBars+dataBars)),maxCommittedDelta:round(pp.maxCommitted-aa.maxCommitted),
      lostBaselineGains:Math.max(0,aa.gains-pp.gains),episodes},
    economicScreen:{gains95:gainRetention!==null&&gainRetention>=.95,returnWithin2pp:returnDelta>=-.02,drawdownWithin2pp:ddDelta<=.02,marketPauseUnder1pct:marketPausedBars/(validBars+dataBars)<.01},
    financialCertification:'NOT_CERTIFIED_SURROGATE_GRID_NO_DEPTH_FILTERS_RUNTIME_OR_LEDGER'};
}
export function syntheticPath(name){
  const bars=[];let price=100,t=Date.UTC(2026,0,1);
  const append=close=>{bars.push({at:t,open:price,high:Math.max(price,close),low:Math.min(price,close),close,volume:10000});price=close;t+=POLICY.stepMs;};
  const flat=n=>{for(let i=0;i<n;i++)append(price);};
  const ramp=(target,n)=>{const from=price;for(let i=1;i<=n;i++)append(from*(target/from)**(i/n));};
  flat(85); // 73bar signal warm-up + 1hour pre-shock trading, so a resident BUY exists.
  if(name.startsWith('DROP')){const [pct,minutes]=name.slice(4).split('_').map(Number);ramp(price*(1-pct/100),Math.max(1,minutes/5));flat(12*24);}
  else if(name==='FLASH_V'){ramp(70,1);ramp(100,12);flat(100);}
  else if(name==='SUCCESSIVE_DAYS'){for(let i=0;i<5;i++){ramp(price*.8,12*24);flat(12);}flat(12*24);}
  else if(name==='GRADUAL'){ramp(70,12*24*3);flat(12*24);}
  else if(name==='SIDEWAYS'){for(let i=0;i<12*24*7;i++)append(100+5*Math.sin(i*Math.PI/24));}
  else if(name==='UPTREND'){ramp(150,12*24*7);}
  else throw Error('UNKNOWN_SYNTHETIC');return bars;
}
function run(){
  const fingerprints=()=>Object.fromEntries(['protection.mjs','protection.test.mjs','replay.test.mjs','run-study.mjs','summarize.mjs','data-manifest.json','PREREGISTRATION.md'].map(n=>[n,sha(fs.readFileSync(path.join(ROOT,n)))]));
  const initialFingerprints=fingerprints();
  const symbols=['BTCBRL','BTCUSDT','SOLBRL','SOLUSDT'],results=[],sources=[],calibrations={};
  for(const symbol of symbols){
    const {bars,evidence}=load(symbol);sources.push(evidence);const cal=calibration(bars,symbol);calibrations[symbol]=cal;
    const config={capital:1000,slots:25,spacing:symbol.startsWith('BTC')?.02:.01,gain:symbol.startsWith('BTC')?.012:.055,fee:.001,slippage:.0002};
    const r=replay(bars,symbol,config,cal,Date.UTC(2022,0,1));results.push(r);
    console.log(JSON.stringify({symbol,baseline:r.baseline,protected:r.protected,comparison:{...r.comparison,episodes:r.comparison.episodes.length},screen:r.economicScreen}));
  }
  const synthetic=[];for(const symbol of ['BTCUSDT','SOLBRL'])for(const slots of [25,50,100])for(const spacing of [.01,.015,.02,.03,.05,.08])
    for(const name of ['DROP1_5','DROP3_5','DROP5_5','DROP10_5','DROP20_180','DROP30_1440','DROP50_60','DROP70_60','FLASH_V','SUCCESSIVE_DAYS','GRADUAL','SIDEWAYS','UPTREND']){
      const bars=syntheticPath(name),r=replay(bars,symbol,{capital:1000,slots,spacing,gain:.03,fee:.001,slippage:.0002},null,bars[72].at);
      synthetic.push({case:name,symbol,slots,spacing,baseline:r.baseline,protected:r.protected,comparison:{...r.comparison,episodes:r.comparison.episodes.length}});
    }
  const prior=['BTCBRL','BTCUSDT','SOLBRL','SOLUSDT'].map(symbol=>{const f=path.join(ROOT,`../extreme-crash-f-20261009/results-main-${symbol}.json`);
    if(!fs.existsSync(f))return {symbol,available:false,optional:true,excludedFromCertification:true};
    const raw=fs.readFileSync(f),p=JSON.parse(raw);return {symbol,available:true,optional:true,excludedFromCertification:true,sha256:sha(raw),pairs:p.pairs.map(x=>({engine:x.engine,gainsPreserved:x.gainsPreserved,returnDelta:x.returnDelta,ddDelta:x.ddDelta,marketPausedPct:x.marketPausedPct}))};});
  assert.deepEqual(fingerprints(),initialFingerprints,'SOURCE_CHANGED_DURING_RUN');
  const out={generatedAt:new Date().toISOString(),purpose:'OFFLINE_RESEARCH_ONLY_NO_LIVE_ACTIVATION',policy:POLICY,
    fingerprints:initialFingerprints,
    sources,calibrations,historical:results,synthetic,priorResearch:prior,liveCertification:'FAIL_UNPROVEN_CANONICAL_INTEGRATION_LIQUIDITY_CANCELLATION_LATENCY_AND_ECONOMIC_ROBUSTNESS'};
  fs.writeFileSync(path.join(ROOT,'results.json'),JSON.stringify(out,null,2));
  console.log(JSON.stringify({historicalPairs:results.length,syntheticPairs:synthetic.length,allEconomicScreensPass:results.every(r=>Object.values(r.economicScreen).every(Boolean)),live:out.liveCertification}));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))run();
