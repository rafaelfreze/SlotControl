import {test} from 'node:test';
import assert from 'node:assert/strict';
import {POLICY,MIN,features,createDetector,detect,createController,transition} from './protection.mjs';
const scope={operatorId:'op',accountId:'account',engineId:'engine-a',shardId:'shard-1',symbol:'SOLBRL',environment:'OFFLINE'};
const fresh=(at,fields={})=>({valid:true,at,price:100,low:100,trigger:false,calm:true,confirmationMs:30*MIN,...fields});
const evt=(s,type,at,fields={})=>({scope:s.scope,id:`${type}:${at}`,type,at,leaseEpoch:s.leaseEpoch,leaseValid:true,...fields});
const order=(s,fields={})=>({owner:s.scope,receiptVerified:true,side:'BUY',purpose:'ENTRY',orderId:'exchange-1',clientOrderId:'engine-a:slot-1:op1',quantity:1,filled:0,status:'NEW',observedAt:0,...fields});
const gates=Object.fromEntries(['ledgerComplete','ownership','tpProtected','reconciliationFresh','quoteBalance','feeBalance','capacity','filters','accountBudget','ipBudget','noPendingDispatch','noPendingConfiguration'].map(k=>[k,true]));
const warm=(symbol='SOLBRL')=>Array.from({length:73},(_,i)=>({at:i*5*MIN,close:100,low:100,high:100}));
test('detector thresholds cannot receive strategy spacing/capital/gain',()=>{
  const h=warm();h.push({at:365*MIN,close:96,low:96,high:100});
  const a=features(h,'SOLBRL',365*MIN);
  assert.equal(a.trigger,true);assert.deepEqual(a.thresholds,[.03,.05,.09]);
  assert.deepEqual(features(h,'SOLBRL',365*MIN),a);
});
for(const symbol of ['BTCBRL','BTCUSDT','SOLBRL','SOLUSDT'])test(`${symbol}: closed data, no own-shock volatility inflation`,()=>{
  const h=warm(symbol);h.push({at:365*MIN,close:90,low:90,high:100});
  const f=features(h,symbol,365*MIN);assert.equal(f.trigger,true);assert.equal(f.sigma,0);
  assert.equal(features(h,symbol,372*MIN).valid,false);
  h.at(-1).at+=MIN;assert.equal(features(h,symbol,372*MIN).valid,false);
});
for(const drop of [.01,.03,.05,.10,.20,.30,.50,.70])test(`synthetic abrupt${100*drop}% decision is deterministic`,()=>{
  const h=warm();h.push({at:365*MIN,close:100*(1-drop),low:100*(1-drop),high:100});
  const f=features(h,'SOLBRL',365*MIN),a=detect(createDetector(),f),b=detect(createDetector(),f);
  assert.deepEqual(a,b);assert.equal(f.trigger,drop>=.03);
});
test('future timestamps, stale data and zero price do not imply calm',()=>{
  const h=warm();assert.equal(features(h,'SOLBRL',0).valid,false);
  h.at(-1).close=0;assert.equal(features(h,'SOLBRL',360*MIN).valid,false);
});
test('adaptive confirmation increases with severity and is not elapsed-time resume',()=>{
  let d=detect(createDetector(),fresh(0,{trigger:true,confirmationMs:90*MIN,low:80,price:80}));
  d=detect(d,{valid:false,at:240*MIN});assert.equal(d.state,'DATA_PAUSED');
  d=detect(d,fresh(245*MIN,{low:80,price:80}));assert.equal(d.state,'RECOVERY_CONFIRMING');
  for(let t=250;t<=330;t+=5)d=detect(d,fresh(t*MIN,{low:80,price:80}));
  assert.equal(d.state,'RECOVERY_CONFIRMING');
  d=detect(d,fresh(335*MIN,{low:80,price:80}));assert.equal(d.state,'GRADUAL_RESTART');
  assert.equal(d.resumeReference,80);
});
test('a new low/new shock resets the stable sequence',()=>{
  let d=detect(createDetector(),fresh(0,{trigger:true,low:90}));
  d=detect(d,fresh(5*MIN,{low:90}));
  d=detect(d,fresh(10*MIN,{trigger:true,low:80}));assert.equal(d.stableSince,null);
});
for(const n of [25,50,100])test(`${n} slots: resident NEW gets one exact guarded cancel, TPs retained`,()=>{
  let s=createController(scope,n);s.protectedTPs=[{id:'tp-1',price:110}];
  s=transition(s,evt(s,'ORDER',0,{order:order(s)})).state;
  const a=transition(s,evt(s,'RISK',MIN,{feature:fresh(MIN,{trigger:true})}));
  assert.equal(a.intents.length,1);assert.equal(a.intents[0].kind,'CANONICAL_CANCEL_ONLY_NEW');
  assert.deepEqual(a.state.protectedTPs,s.protectedTPs);
  const b=transition(a.state,evt(a.state,'RISK',2*MIN,{feature:fresh(2*MIN,{trigger:true})}));
  assert.equal(b.intents[0].kind,'OBSERVE_EXACT_ORDER');assert.equal(b.state.slotCount,n);
});
for(const cause of ['HTTP503','TIMEOUT','CRASH_AFTER_DISPATCH'])test(`${cause}: no second cancel; exact terminal fill wins`,()=>{
  let s=createController(scope);s=transition(s,evt(s,'ORDER',0,{order:order(s)})).state;
  s=transition(s,evt(s,'RISK',MIN,{feature:fresh(MIN,{trigger:true})})).state;
  s=transition(s,evt(s,'AMBIGUOUS',2*MIN,{cause})).state;
  s=JSON.parse(JSON.stringify(s));assert.equal(s.state,'BLOCKED_SAFE');
  s=transition(s,evt(s,'RISK',3*MIN,{feature:fresh(3*MIN)})).state;assert.equal(s.state,'BLOCKED_SAFE');
  s=transition(s,evt(s,'ORDER',4*MIN,{order:order(s,{status:'FILLED',filled:1,observedAt:4*MIN})})).state;
  assert.throws(()=>transition(s,evt(s,'PLAN',4*MIN,{gates,reference:100,spacing:.01})),/ENTRY_PAUSED/);
  s=transition(s,evt(s,'RECONCILED',5*MIN,{exactOwnership:true,tradesComplete:true,tpProtected:true,noPendingDispatch:true,filled:1})).state;
  assert.equal(s.buy,null);assert.equal(s.cancelClaim.status,'TERMINAL_RECONCILED');assert.notEqual(s.state,'NORMAL');
});
test('partial unprotected position never auto cancels under-minimum remainder',()=>{
  let s=createController(scope);s=transition(s,evt(s,'ORDER',0,{order:order(s,{status:'PARTIALLY_FILLED',filled:.01})})).state;
  const r=transition(s,evt(s,'RISK',MIN,{feature:fresh(MIN,{trigger:true})}));
  assert.deepEqual(r.intents.map(x=>x.kind),['CANONICAL_RECONCILE_AND_PROTECT']);assert.equal(r.state.cancelClaim,null);
});
test('same account/symbol other engine or shard cannot observe or unpause',()=>{
  const s=createController(scope);
  for(const field of ['engineId','shardId','accountId','operatorId'])assert.throws(()=>transition(s,{...evt(s,'AMBIGUOUS',0),scope:{...scope,[field]:'other'}}),/OWNER_MISMATCH/);
});
test('duplicate event replay has no second financial intent; collision fails',()=>{
  let s=createController(scope);s=transition(s,evt(s,'ORDER',0,{order:order(s)})).state;
  const e=evt(s,'RISK',MIN,{feature:fresh(MIN,{trigger:true})}),a=transition(s,e);
  assert.deepEqual(transition(a.state,e).intents,[]);
  assert.throws(()=>transition(a.state,{...e,feature:fresh(MIN)}),/IDEMPOTENCY_COLLISION/);
});
test('lease lost, incomplete gate and two competing revisions fail in fixture store',()=>{
  const s=createController(scope);assert.throws(()=>transition(s,{...evt(s,'AMBIGUOUS',0),leaseValid:false}),/LEASE_LOST/);
  assert.throws(()=>transition(s,evt(s,'PLAN',0,{gates:{...gates,accountBudget:false},reference:100,spacing:.01})),/FINANCIAL_GATES_UNPROVEN/);
  let revision=s.revision;const cas=(before,after)=>{assert.equal(before,revision,'CAS_CONFLICT');revision=after;};
  cas(s.revision,s.revision+1);assert.throws(()=>cas(s.revision,s.revision+1),/CAS_CONFLICT/);
});
test('gradual resume emits one LIMIT at fresh reference and unchanged spacing; no catch-up MARKET',()=>{
  let s=createController(scope);s.detector={...createDetector(),state:'GRADUAL_RESTART',lastAt:MIN,resumeReference:80};s.state='GRADUAL_RESTART';
  const r=transition(s,evt(s,'PLAN',MIN,{gates,reference:80,spacing:.015}));
  assert.deepEqual(r.intents,[{kind:'CANONICAL_REPLAN_ONE_LIMIT',key:'engine-a:PLAN:60000',price:78.8,noCatchUp:true,marketAllowed:false}]);
  assert.throws(()=>transition(r.state,evt(r.state,'PLAN',MIN,{id:'parallel',gates,reference:80,spacing:.015})),/ENTRY_PAUSED/);
  assert.throws(()=>transition(r.state,evt(r.state,'PLAN',6*MIN,{id:'delayed-retry',gates,reference:80,spacing:.015})),/ENTRY_PAUSED/);
  assert.throws(()=>transition(s,evt(s,'PLAN',MIN,{gates,reference:90,spacing:.015})),/RESUME_REFERENCE_UNPROVEN/);
});
test('observed liquidity degradation triggers; absent liquidity is explicit, never invented',()=>{
  const h=warm();let f=features(h,'SOLBRL',360*MIN);assert.equal(f.liquidityAvailable,false);
  h.at(-1).liquidity={at:360*MIN,spreadBps:40,depthQuote:100};f=features(h,'SOLBRL',360*MIN);
  assert.equal(f.trigger,true);assert.equal(f.liquidityBad,true);
});

test('same candle ages into DATA_PAUSED before dedupe; identical replay never extends freshness',()=>{
  const h=warm(),first=features(h,'SOLBRL',360*MIN),d=detect(createDetector(),first);
  const stale=features(h,'SOLBRL',367*MIN),paused=detect(d,stale);
  assert.equal(paused.state,'DATA_PAUSED');assert.equal(paused.lastAt,360*MIN);
  assert.equal(paused.lastObservedAt,367*MIN);assert.equal(paused.stableSince,null);
  assert.throws(()=>detect(d,{...first,price:101}),/MARKET_FEATURE_REPLAY_MISMATCH/);
  const same=detect(d,{...first,observedAt:361*MIN});assert.equal(same.lastAt,360*MIN);assert.equal(same.lastObservedAt,361*MIN);
});
test('future market timestamp cannot authorize PLAN or poison the next valid observation',()=>{
  let d=detect(createDetector(),{...fresh(100*MIN),observedAt:MIN});
  assert.equal(d.state,'DATA_PAUSED');assert.equal(d.lastAt,null);
  d=detect(d,{...fresh(5*MIN),observedAt:5*MIN});assert.equal(d.lastAt,5*MIN);
  let s=createController(scope);s=transition(s,evt(s,'RISK',MIN,{feature:fresh(100*MIN)})).state;
  assert.equal(s.state,'DATA_PAUSED');assert.equal(s.detector.lastAt,null);
  assert.throws(()=>transition(s,evt(s,'PLAN',MIN,{gates,reference:100,spacing:.01})),/ENTRY_PAUSED/);
  s=createController(scope);s.detector={...createDetector(),lastAt:100*MIN};
  assert.throws(()=>transition(s,evt(s,'PLAN',MIN,{gates,reference:100,spacing:.01})),/MARKET_STALE/);
});
test('all OHLC/calibration numerics are finite; invalid calibration is explicit',()=>{
  for(const field of ['close','low','high','at'])for(const value of [NaN,Infinity,-Infinity]){
    const h=warm();h.at(-1)[field]=value;assert.equal(features(h,'SOLBRL',360*MIN).valid,false,`${field}:${value}`);
  }
  for(const thresholds of [[NaN,.05,.09],[.03,Infinity,.09],[.03,.05],['.03',.05,.09],[0,.05,.09]]){
    const f=features(warm(),'SOLBRL',360*MIN,{thresholds});assert.equal(f.valid,false);assert.equal(f.reason,'INVALID_CALIBRATION');
  }
  const h=warm();for(let i=0;i<h.length;i++)Object.assign(h[i],{close:i%2?Number.MAX_VALUE:Number.MIN_VALUE,low:Number.MIN_VALUE,high:Number.MAX_VALUE});
  assert.equal(features(h,'SOLBRL',360*MIN).valid,false);
});
test('fabricated feature numeric/boolean values cannot be accepted as valid market proof',()=>{
  for(const [field,value]of [['price',Infinity],['low',Infinity],['confirmationMs',Infinity],['trigger','false'],['calm',1],['sigma',NaN],['severity',Infinity],['thresholds',[.03,Infinity,.09]],['losses',[0,NaN,0]]]){
    assert.equal(detect(createDetector(),fresh(0,{[field]:value})).state,'DATA_PAUSED',field);
  }
});
test('ORDER and PLAN reject infinite/undefined numeric fields and inconsistent partial states',()=>{
  const s=createController(scope);
  for(const field of ['quantity','filled','observedAt'])for(const value of [Infinity,NaN,undefined]){
    assert.throws(()=>transition(s,evt(s,'ORDER',0,{order:order(s,{[field]:value})})),/ORDER_INVALID/,`${field}:${value}`);
  }
  for(const filled of [0,1])assert.throws(()=>transition(s,evt(s,'ORDER',0,{order:order(s,{status:'PARTIALLY_FILLED',filled})})),/ORDER_STATE_INCONSISTENT/);
  const ready=transition(s,evt(s,'RISK',0,{feature:fresh(0)})).state;
  for(const field of ['reference','spacing'])for(const value of [Infinity,NaN,undefined]){
    const plan={gates,reference:100,spacing:.01,[field]:value};assert.throws(()=>transition(ready,evt(ready,'PLAN',0,plan)),/PLAN_INVALID/);
  }
});
test('RECONCILED requires booleans true and a finite exact fill, not truthy strings',()=>{
  let s=createController(scope);s=transition(s,evt(s,'ORDER',0,{order:order(s,{status:'CANCELED'})})).state;
  const fields={exactOwnership:true,tradesComplete:true,tpProtected:true,noPendingDispatch:true,filled:0};
  for(const field of ['exactOwnership','tradesComplete','tpProtected','noPendingDispatch'])assert.throws(()=>transition(s,evt(s,'RECONCILED',MIN,{...fields,[field]:'false'})),/RECONCILIATION_UNPROVEN/);
  for(const value of [NaN,Infinity,undefined])assert.throws(()=>transition(s,evt(s,'RECONCILED',MIN,{...fields,filled:value})),/RECONCILIATION_UNPROVEN/);
});
test('completed cancel A never prevents a new owned cancel B after recovery and new ACK',()=>{
  let s=createController(scope);s.protectedTPs=[{id:'old-tp'}];s=transition(s,evt(s,'ORDER',0,{order:order(s)})).state;
  const first=transition(s,evt(s,'RISK',MIN,{feature:fresh(MIN,{trigger:true})}));s=first.state;
  s=transition(s,evt(s,'ORDER',2*MIN,{order:order(s,{status:'CANCELED',observedAt:2*MIN})})).state;
  s=transition(s,evt(s,'RECONCILED',3*MIN,{exactOwnership:true,tradesComplete:true,tpProtected:true,noPendingDispatch:true,filled:0})).state;
  for(let at=5;at<=35;at+=5)s=transition(s,evt(s,'RISK',at*MIN,{feature:fresh(at*MIN)})).state;
  const planned=transition(s,evt(s,'PLAN',35*MIN,{gates,reference:100,spacing:.01}));s=planned.state;assert.equal(s.cancelClaim,null);
  s=transition(s,evt(s,'ORDER',36*MIN,{order:order(s,{orderId:'exchange-b',clientOrderId:'engine-a:slot-2:op1',observedAt:36*MIN,decisionKey:planned.intents[0].key})})).state;
  const second=transition(s,evt(s,'RISK',40*MIN,{feature:fresh(40*MIN,{trigger:true})}));
  assert.equal(second.intents[0].kind,'CANONICAL_CANCEL_ONLY_NEW');assert.equal(second.intents[0].orderId,'exchange-b');
  assert.notEqual(second.intents[0].key,first.intents[0].key);assert.deepEqual(second.state.protectedTPs,[{id:'old-tp'}]);
});
test('old asynchronous duplicate replay returns current checkpoint and prototype-like IDs are ordinary scoped events',()=>{
  const s=createController(scope),e=evt(s,'RISK',0,{id:'__proto__',feature:fresh(0)});
  const a=transition(s,e),b=transition(a.state,evt(a.state,'RISK',5*MIN,{id:'toString',feature:fresh(5*MIN)}));
  const replay=transition(b.state,Object.fromEntries(Object.entries(e).reverse()));
  assert.deepEqual(replay.intents,[]);assert.deepEqual(replay.state,b.state);
  assert.throws(()=>transition(b.state,{...e,feature:fresh(0,{price:101})}),/IDEMPOTENCY_COLLISION/);
});
test('pending ENTRY claim is observed by decision key through crash-before-ACK, never treated as absence',()=>{
  let s=createController(scope);s.protectedTPs=[{id:'sibling-tp'}];s=transition(s,evt(s,'RISK',0,{feature:fresh(0)})).state;
  const planned=transition(s,evt(s,'PLAN',0,{gates,reference:100,spacing:.01}));s=planned.state;
  const crash=transition(s,evt(s,'AMBIGUOUS',MIN,{cause:'CRASH_BEFORE_ACK'}));s=JSON.parse(JSON.stringify(crash.state));
  assert.deepEqual(crash.intents,[{kind:'OBSERVE_EXACT_ENTRY_INTENT',decisionKey:planned.intents[0].key}]);
  const risk=transition(s,evt(s,'RISK',2*MIN,{feature:fresh(2*MIN,{trigger:true})}));s=risk.state;
  assert.deepEqual(risk.intents,[{kind:'OBSERVE_EXACT_ENTRY_INTENT',decisionKey:planned.intents[0].key}]);
  assert.throws(()=>transition(s,evt(s,'PLAN',2*MIN,{gates,reference:100,spacing:.01})),/ENTRY_PAUSED/);
  s=transition(s,evt(s,'ORDER',3*MIN,{order:order(s,{observedAt:3*MIN,decisionKey:planned.intents[0].key})})).state;
  const owned=transition(s,evt(s,'RISK',4*MIN,{feature:fresh(4*MIN,{trigger:true})}));
  assert.equal(owned.intents[0].kind,'CANONICAL_CANCEL_ONLY_NEW');assert.deepEqual(owned.state.protectedTPs,[{id:'sibling-tp'}]);
});
test('prototype refuses LIVE environment and unsupported market',()=>{
  assert.throws(()=>createController({...scope,environment:'REAL'}),/OFFLINE_SCOPE_REQUIRED/);
  assert.throws(()=>createController({...scope,symbol:'SOLXYZ'}),/OFFLINE_SCOPE_REQUIRED/);
});
