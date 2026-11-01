import test from 'node:test';import assert from 'node:assert/strict';
import{BinanceLiveTransport}from'../src/binance-live.mjs';
import{PARTIAL_ENTRY_RECOVERY_POLICY as POLICY}from'../../web/lib/execution/partial-entry-recovery.ts';
const source='COR1-SOL-8-1-BUY-aaaaaaaaaaaaaa',child='COR1-SOL-8-2-BUY-bbbbbbbbbbbbbb',sell='COR1-SOL-8-1-SELL-cccccccccccccc';
const flags={tradingEnabled:true,killSwitch:false};
function fixture(){
 const calls=[],orders=new Map([[source,{orderId:'1',clientOrderId:source,symbol:'SOLBRL',side:'BUY',status:'CANCELED',executedQuantity:.004,cumulativeQuoteQuantity:2,price:500}]]);
 const snapshot={price:{price:500},bnbBrlPrice:{price:5000},filters:{minNotional:10,minQuantity:.001,maxQuantity:100,quantityStep:.001,priceTick:.1},
  openOrders:[],account:{balances:[{asset:'BRL',free:100},{asset:'SOL',free:.03},{asset:'BNB',free:.005}]}};
 const t=new BinanceLiveTransport({apiKey:'fixture',apiSecret:'fixture',fetcher:async()=>{throw Error('NETWORK_FORBIDDEN')}});
 t.queryOrder=async(_symbol,id,orderId)=>{const row=orders.get(id);if(row&&orderId&&row.orderId!==orderId)throw Error('IDENTITY');return row??null};
 t.observeOwnedOrder=async(symbol,id,oid)=>{const order=await t.queryOrder(symbol,id,oid);return{order,trades:order?[{quantity:order.executedQuantity,quoteQuantity:order.cumulativeQuoteQuantity,commission:0,commissionAsset:'BNB'}]:null}};
 t.safetySnapshot=async()=>snapshot;
 t.signed=async(method,path,input)=>{assert.equal(method,'POST');assert.equal(path,'/api/v3/order');calls.push(input);
  const row={symbol:'SOLBRL',clientOrderId:input.newClientOrderId,orderId:input.side==='BUY'?2:3,side:input.side,
   status:input.side==='BUY'?'FILLED':'NEW',executedQty:input.side==='BUY'?'.021':'0',cummulativeQuoteQty:input.side==='BUY'?'10.5':'0',price:input.price??'0'};
  orders.set(input.newClientOrderId,{orderId:String(row.orderId),clientOrderId:row.clientOrderId,symbol:row.symbol,side:row.side,status:row.status,
   executedQuantity:Number(row.executedQty),cumulativeQuoteQuantity:Number(row.cummulativeQuoteQty),price:Number(row.price)});
  return{ok:true,body:row};};
 const common={symbol:'SOLBRL',expectedOwnedOpenIds:[],assetCapBrl:275,globalCapBrl:725,assetExposureBeforeBrl:2,globalExposureBeforeBrl:2};
 const buy={...common,clientOrderId:child,side:'BUY',purpose:'ENTRY',type:'MARKET',quoteOrderQty:'10.5',
  partialEntryRecoveryPolicy:POLICY,partialEntryRecoverySource:{clientOrderId:source,orderId:'1',quantity:.004,quote:2}};
 const tp={...common,clientOrderId:sell,side:'SELL',purpose:'TP',type:'LIMIT',quantity:'0.025',price:'527.5',
  sourceBuyClientOrderId:source,sourceBuyOrderId:'1',partialEntryRecoverySources:{policy:POLICY,recoveryClientOrderId:child,recoveryOrderId:'2'}};
 return{t,calls,orders,snapshot,buy,tp};
}
test('tiny canceled partial gets exactly one bounded rescue; same CID replay never duplicates; TP owns both sources',async()=>{
 const h=fixture();assert.equal((await h.t.createOwnedOrder(h.buy,{allowCreate:true,...flags})).status,'FILLED');
 await h.t.createOwnedOrder(h.buy,{allowCreate:true,...flags});assert.equal(h.calls.length,1);
 assert.equal((await h.t.createOwnedOrder(h.tp,{allowCreate:true,...flags})).status,'NEW');assert.equal(h.calls.length,2);
});
test('partial rescue refuses active/changed source, other slot, oversized complement, missing BNB and kill switch',async()=>{
 for(const change of ['active','changed','foreign','large','bnb','kill']){
  const h=fixture();let f=flags;
  if(change==='active')h.orders.get(source).status='PARTIALLY_FILLED';
  if(change==='changed')h.orders.get(source).executedQuantity=.005;
  if(change==='foreign')h.buy.partialEntryRecoverySource.clientOrderId=source.replace('-8-','-9-');
  if(change==='large')h.buy.quoteOrderQty='100';
  if(change==='bnb')h.snapshot.account.balances.find(b=>b.asset==='BNB').free=0;
  if(change==='kill')f={...flags,killSwitch:true};
  await assert.rejects(h.t.createOwnedOrder(h.buy,{allowCreate:true,...f}));assert.equal(h.calls.length,0,change);
 }
});
test('paired TP refuses missing child, another slot, duplicated source, oversell and existing TP; ordinary TP cannot sum sources',async()=>{
 for(const change of ['missing','foreign','duplicate','oversell','resident','ordinary']){
  const h=fixture();await h.t.createOwnedOrder(h.buy,{allowCreate:true,...flags});h.calls.length=0;
  if(change==='missing')h.orders.delete(child);
  if(change==='foreign')h.tp.partialEntryRecoverySources.recoveryClientOrderId=child.replace('-8-','-9-');
  if(change==='duplicate')h.tp.partialEntryRecoverySources.recoveryClientOrderId=source;
  if(change==='oversell')h.tp.quantity='0.026';
  if(change==='resident'){h.snapshot.openOrders.push({clientOrderId:sell,side:'SELL'});h.tp.expectedOwnedOpenIds=[sell];}
  if(change==='ordinary')delete h.tp.partialEntryRecoverySources;
  await assert.rejects(h.t.createOwnedOrder(h.tp,{allowCreate:true,...flags}));assert.equal(h.calls.length,0,change);
 }
});
