/** OFFLINE ONLY. Pure candidate policy; no transport, environment, DB or runtime import.
 * Detector never receives slot count, capital, gain or spacing. Closed observations only.
 * This module is deliberately unreachable from the LIVE dependency graph. */
import {isDeepStrictEqual} from 'node:util';
export const MIN = 60_000;
export const POLICY = Object.freeze({
  version: 'EXECUTION_CRASH_CANDIDATE_V1', stepMs: 5 * MIN, maxAgeMs: 6 * MIN,
  windows: [1, 3, 12], baselineBars: 72,
  floors: { BTC: [.02, .035, .06], SOL: [.03, .05, .09] },
  sigmaMultiplier: 4, quantile: .999, minimumTraining: 8640,
  lowQuietMs: 15 * MIN, confirmationMinMs: 30 * MIN, confirmationMaxMs: 180 * MIN,
});
const fail = (ok, code) => { if (!ok) throw Error(code); };
const SYMBOLS=new Set(['BTCBRL','BTCUSDT','SOLBRL','SOLUSDT']);
const sameScope = (a,b) => ['operatorId','accountId','engineId','shardId','symbol','environment'].every(k=>a?.[k]===b?.[k]);
const std = a => { const m=a.reduce((s,x)=>s+x,0)/a.length; return Math.sqrt(a.reduce((s,x)=>s+(x-m)**2,0)/a.length); };
export const quantile = (a,q) => { a=[...a].sort((x,y)=>x-y); return a.length ? a[Math.floor((a.length-1)*q)] : null; };
export function features(history, symbol, now, calibration=null) {
  fail(SYMBOLS.has(symbol),'UNSUPPORTED_SYMBOL');
  const asset=symbol.startsWith('BTC')?'BTC':symbol.startsWith('SOL')?'SOL':null;
  fail(asset,'UNSUPPORTED_ASSET');
  const bar=history.at(-1), needed=POLICY.baselineBars+1;
  const usable=history.slice(-needed);
  const calibrationValid=calibration===null||Array.isArray(calibration?.thresholds)&&calibration.thresholds.length===3
    &&calibration.thresholds.every(x=>Number.isFinite(x)&&x>0);
  const valid=Number.isFinite(now)&&now>=0&&calibrationValid&&bar && usable.length===needed && usable.every((b,i)=>
    [b.at,b.close,b.low,b.high].every(Number.isFinite)&&b.at>=0&&b.close>0&&b.low>0&&b.high>=b.close&&b.low<=b.close
    && b.at<=now && (!i||b.at-usable[i-1].at===POLICY.stepMs)) && now-bar.at<=POLICY.maxAgeMs;
  if(!valid)return {valid:false,at:bar?.at??now,observedAt:now,reason:calibrationValid?'STALE_GAP_OR_WARMUP':'INVALID_CALIBRATION'};
  // Volatility excludes the current shock, so a violent candle cannot lift its own threshold.
  const returns=usable.slice(1,-1).map((b,i)=>Math.log(b.close)-Math.log(usable[i].close));
  const sigma=std(returns);
  const losses=POLICY.windows.map(w=>1-bar.close/history.at(-1-w).close);
  const thresholds=POLICY.windows.map((w,j)=>Math.max(POLICY.floors[asset][j],
    POLICY.sigmaMultiplier*sigma*Math.sqrt(w),calibration?.thresholds?.[j]??0));
  const severity=Math.max(...losses.map((x,j)=>x/thresholds[j]));
  const recent=usable.slice(-7), range=(Math.max(...recent.map(x=>x.high))-Math.min(...recent.map(x=>x.low)))/bar.close;
  const liquidity=bar.liquidity??null;
  const liquidityBad=liquidity!==null && (!Number.isFinite(liquidity.at)||liquidity.at>now||now-liquidity.at>POLICY.maxAgeMs
    ||!Number.isFinite(liquidity.spreadBps)||!Number.isFinite(liquidity.depthQuote)||liquidity.spreadBps>30||liquidity.depthQuote<=0);
  if(![...losses,...thresholds,sigma,severity,range].every(Number.isFinite))
    return {valid:false,at:bar.at,observedAt:now,reason:'NONFINITE_DERIVED_FEATURE'};
  return {valid:true,at:bar.at,observedAt:now,price:bar.close,low:bar.low,losses,thresholds,sigma,severity,
    trigger:severity>=1-1e-12 || liquidityBad,calm:losses.every((x,j)=>x<thresholds[j]/2)&&range<Math.max(.01,3*sigma*Math.sqrt(6)),
    liquidityAvailable:liquidity!==null,liquidityBad,
    confirmationMs:Math.min(POLICY.confirmationMaxMs,Math.max(POLICY.confirmationMinMs,
      POLICY.confirmationMinMs*Math.max(1,severity)*(1+sigma/POLICY.floors[asset][0])))};
}
export function createDetector() { return {state:'NORMAL',reason:null,lastAt:null,lastObservedAt:null,lastFeature:null,pausedAt:null,stableSince:null,trough:null,lowAt:null,confirmationMs:POLICY.confirmationMinMs}; }
export function detect(previous, f) {
  const observedAt=f.observedAt??f.at;
  fail(Number.isFinite(observedAt)&&observedAt>=0
    &&(previous.lastObservedAt===null||observedAt>=previous.lastObservedAt),'NON_MONOTONIC_OBSERVATION');
  const valid=f.valid===true&&[f.at,f.price,f.low,f.confirmationMs].every(Number.isFinite)
    &&f.at>=0&&f.at<=observedAt&&observedAt-f.at<=POLICY.maxAgeMs&&f.price>0&&f.low>0&&f.low<=f.price
    &&typeof f.trigger==='boolean'&&typeof f.calm==='boolean'
    &&f.confirmationMs>=POLICY.confirmationMinMs&&f.confirmationMs<=POLICY.confirmationMaxMs
    &&(!('thresholds'in f)||Array.isArray(f.thresholds)&&f.thresholds.length===3&&f.thresholds.every(x=>Number.isFinite(x)&&x>0))
    &&(!('losses'in f)||Array.isArray(f.losses)&&f.losses.length===3&&f.losses.every(Number.isFinite))
    &&(!('sigma'in f)||Number.isFinite(f.sigma)&&f.sigma>=0)&&(!('severity'in f)||Number.isFinite(f.severity));
  // Freshness must precede same-candle dedupe. A once-valid candle expires even
  // without a new market timestamp; a future/invalid timestamp cannot poison lastAt.
  if(!valid)return {...previous,lastObservedAt:observedAt,state:'DATA_PAUSED',reason:previous.reason==='MARKET'?'MARKET':'DATA',stableSince:null};
  const {observedAt:ignored,...marketFeature}=f;
  if(previous.lastAt===f.at){
    fail(isDeepStrictEqual(previous.lastFeature,marketFeature),'MARKET_FEATURE_REPLAY_MISMATCH');
    return {...structuredClone(previous),lastObservedAt:observedAt};
  }
  fail(previous.lastAt===null||f.at>previous.lastAt,'NON_MONOTONIC_MARKET');
  const s={...previous,lastAt:f.at,lastObservedAt:observedAt,lastFeature:structuredClone(marketFeature)};
  if(f.trigger)return {...s,state:'VOLATILITY_BUY_PAUSED',reason:'MARKET',pausedAt:previous.pausedAt??f.at,stableSince:null,
    trough:Math.min(previous.trough??Infinity,f.low),lowAt:f.low<(previous.trough??Infinity)?f.at:previous.lowAt,
    confirmationMs:Math.max(previous.confirmationMs,f.confirmationMs)};
  if(previous.state==='NORMAL')return s;
  if(previous.state==='GRADUAL_RESTART'&&f.calm)return {...createDetector(),lastAt:f.at,lastObservedAt:observedAt,lastFeature:structuredClone(marketFeature)};
  const trough=Math.min(previous.trough??Infinity,f.low), lowAt=f.low<(previous.trough??Infinity)?f.at:previous.lowAt??f.at;
  const continuous=previous.lastAt!==null&&f.at-previous.lastAt===POLICY.stepMs;
  const stableSince=f.calm?(continuous?previous.stableSince??f.at:f.at):null;
  if(stableSince!==null&&f.at-stableSince>=s.confirmationMs&&f.at-lowAt>=POLICY.lowQuietMs)
    return {...createDetector(),state:'GRADUAL_RESTART',lastAt:f.at,lastObservedAt:observedAt,lastFeature:structuredClone(marketFeature),resumeReference:f.price};
  return {...s,state:f.calm?'RECOVERY_CONFIRMING':'VOLATILITY_BUY_PAUSED',stableSince,trough,lowAt};
}
export function createController(scope,slotCount=25) {
  fail(['operatorId','accountId','engineId','shardId','symbol','environment'].every(k=>typeof scope?.[k]==='string'&&scope[k]),'SCOPE_REQUIRED');
  fail(['OFFLINE','SYNTHETIC','FIXTURE'].includes(scope.environment)&&SYMBOLS.has(scope.symbol),'OFFLINE_SCOPE_REQUIRED');
  fail(Number.isInteger(slotCount)&&slotCount>=2&&slotCount<=100,'INVALID_SLOT_COUNT');
  return {scope:structuredClone(scope),slotCount,revision:0,leaseEpoch:1,detector:createDetector(),
    state:'NORMAL',cancelClaim:null,entryClaim:null,buy:null,protectedTPs:[],lastDecisionAt:null,seen:{},lastAt:0};
}
/** Intents are descriptive values. Caller must persist with engine lease/CAS before dispatch.
 * A passing fixture cannot prove production atomicity/fencing or Binance semantics. */
export function transition(current,event) {
  fail(sameScope(current.scope,event.scope),'OWNER_MISMATCH');
  fail(event.leaseEpoch===current.leaseEpoch&&event.leaseValid===true,'LEASE_LOST');
  fail(typeof event.id==='string'&&event.id&&Number.isFinite(event.at)&&event.at>=0,'EVENT_INVALID');
  const eventKey=`event:${event.id}`;
  if(Object.hasOwn(current.seen,eventKey)) {fail(isDeepStrictEqual(current.seen[eventKey],event),'IDEMPOTENCY_COLLISION');return {state:structuredClone(current),intents:[]};}
  fail(event.at>=current.lastAt,'EVENT_INVALID');
  const s=structuredClone(current),intents=[];s.revision++;s.lastAt=event.at;s.seen[eventKey]=structuredClone(event);
  if(event.type==='RISK') {
    fail(event.feature&&(!('observedAt'in event.feature)||Number.isFinite(event.feature.observedAt)&&event.feature.observedAt<=event.at),'FEATURE_OBSERVATION_INVALID');
    s.detector=detect(s.detector,{...event.feature,observedAt:event.at});
    if(s.state!=='BLOCKED_SAFE')s.state=s.detector.state;
    if(s.entryClaim&&!s.buy)intents.push({kind:'OBSERVE_EXACT_ENTRY_INTENT',decisionKey:s.entryClaim.key});
    if(s.state!=='NORMAL'&&s.buy&&!['CANCELED','FILLED','EXPIRED','REJECTED'].includes(s.buy.status)) {
      if(s.cancelClaim){
        fail(s.cancelClaim.orderId===s.buy.orderId&&s.cancelClaim.clientOrderId===s.buy.clientOrderId,'CANCEL_CLAIM_OWNER_MISMATCH');
        intents.push({kind:'OBSERVE_EXACT_ORDER',orderId:s.buy.orderId});
      }
      else if(s.buy.status==='NEW'&&s.buy.filled===0&&s.buy.observedAt<=event.at&&event.at-s.buy.observedAt<=POLICY.maxAgeMs) {
        s.cancelClaim={key:`${s.scope.engineId}:${s.buy.clientOrderId}:ONLY_NEW`,orderId:s.buy.orderId,clientOrderId:s.buy.clientOrderId,status:'PREPARED'};
        intents.push({kind:'CANONICAL_CANCEL_ONLY_NEW',orderId:s.buy.orderId,key:s.cancelClaim.key});
      } else intents.push({kind:'CANONICAL_RECONCILE_AND_PROTECT',orderId:s.buy.orderId});
    }
  } else if(event.type==='ORDER') {
    const o=event.order;
    fail(sameScope(o.owner,s.scope)&&o.receiptVerified===true&&o.side==='BUY'&&o.purpose==='ENTRY','ORDER_OWNER_UNPROVEN');
    fail(typeof o.orderId==='string'&&o.orderId&&typeof o.clientOrderId==='string'&&o.clientOrderId
      &&[o.quantity,o.filled,o.observedAt].every(Number.isFinite)&&o.quantity>0&&o.filled>=0&&o.filled<=o.quantity&&o.observedAt>=0,'ORDER_INVALID');
    fail(['NEW','PARTIALLY_FILLED','FILLED','CANCELED','EXPIRED','REJECTED'].includes(o.status),'ORDER_STATE_UNKNOWN');
    fail((o.status!=='NEW'||o.filled===0)&&(o.status!=='FILLED'||o.filled===o.quantity)
      &&(o.status!=='PARTIALLY_FILLED'||o.filled>0&&o.filled<o.quantity),'ORDER_STATE_INCONSISTENT');
    fail(o.observedAt<=event.at&&event.at-o.observedAt<=POLICY.maxAgeMs,'ORDER_OBSERVATION_STALE');
    if(s.entryClaim){fail(o.decisionKey===s.entryClaim.key,'ENTRY_ACK_MISMATCH');s.entryClaim=null;}
    if(s.cancelClaim&&(s.cancelClaim.orderId!==o.orderId||s.cancelClaim.clientOrderId!==o.clientOrderId)){
      fail(s.cancelClaim.status==='TERMINAL_RECONCILED'&&!s.buy,'CANCEL_CLAIM_OWNER_MISMATCH');s.cancelClaim=null;
    }
    if(s.buy) {fail(s.buy.orderId===o.orderId&&s.buy.clientOrderId===o.clientOrderId,'ORDER_IDENTITY_MISMATCH');
      fail(o.filled>=s.buy.filled&&o.quantity===s.buy.quantity,'FILL_REGRESSION');
      if(['CANCELED','FILLED','EXPIRED','REJECTED'].includes(s.buy.status))fail(o.status===s.buy.status&&o.filled===s.buy.filled,'TERMINAL_CHANGED');}
    s.buy=structuredClone(o);
    if(o.filled>0)intents.push({kind:'CANONICAL_RECONCILE_AND_PROTECT',orderId:o.orderId});
  } else if(event.type==='AMBIGUOUS') {
    s.state='BLOCKED_SAFE';
    if(s.buy)intents.push({kind:'OBSERVE_EXACT_ORDER',orderId:s.buy.orderId});
    else if(s.entryClaim)intents.push({kind:'OBSERVE_EXACT_ENTRY_INTENT',decisionKey:s.entryClaim.key});
    else intents.push({kind:'CANONICAL_RECONCILE_SCOPE',engineId:s.scope.engineId});
  }
  else if(event.type==='RECONCILED') {
    fail(['exactOwnership','tradesComplete','tpProtected','noPendingDispatch'].every(k=>event[k]===true)
      &&Number.isFinite(event.filled)&&event.filled>=0,'RECONCILIATION_UNPROVEN');
    fail(!s.buy||['CANCELED','FILLED','EXPIRED','REJECTED'].includes(s.buy.status),'BUY_NOT_TERMINAL');
    fail(!s.buy||event.filled===s.buy.filled,'FILL_MISMATCH');
    if(s.cancelClaim)s.cancelClaim.status='TERMINAL_RECONCILED';
    s.buy=null;s.state=s.detector.state==='NORMAL'?'RECOVERY_CONFIRMING':s.detector.state;
  } else if(event.type==='PLAN') {
    const gates=['ledgerComplete','ownership','tpProtected','reconciliationFresh','quoteBalance','feeBalance','capacity','filters','accountBudget','ipBudget','noPendingDispatch','noPendingConfiguration'];
    fail(gates.every(k=>event.gates?.[k]===true),'FINANCIAL_GATES_UNPROVEN');
    fail(['NORMAL','GRADUAL_RESTART'].includes(s.state)&&!s.buy&&!s.entryClaim&&(!s.cancelClaim||s.cancelClaim.status==='TERMINAL_RECONCILED'),'ENTRY_PAUSED');
    fail(Number.isFinite(s.detector.lastAt)&&event.at-s.detector.lastAt>=0&&event.at-s.detector.lastAt<=POLICY.maxAgeMs,'MARKET_STALE');
    fail(s.lastDecisionAt===null||event.at-s.lastDecisionAt>=POLICY.stepMs,'ONE_DECISION_AT_A_TIME');
    fail([event.reference,event.spacing,event.reference*(1-event.spacing)].every(Number.isFinite)
      &&event.reference>0&&event.spacing>0&&event.spacing<1,'PLAN_INVALID');
    fail(s.state!=='GRADUAL_RESTART'||event.reference===s.detector.resumeReference,'RESUME_REFERENCE_UNPROVEN');
    s.lastDecisionAt=event.at;
    // Only the current cancel pointer rotates; its exact terminal event remains
    // in the immutable model event proofs. An unresolved cancel can never reach here.
    s.cancelClaim=null;
    s.entryClaim={key:`${s.scope.engineId}:${event.id}`,status:'PREPARED'};
    intents.push({kind:'CANONICAL_REPLAN_ONE_LIMIT',key:s.entryClaim.key,price:event.reference*(1-event.spacing),noCatchUp:true,marketAllowed:false});
    // No queue is returned. A new controller call still requires a fresh full observation.
  } else throw Error('EVENT_TYPE_UNKNOWN');
  return {state:s,intents};
}
