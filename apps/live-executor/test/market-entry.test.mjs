import test from 'node:test';
import assert from 'node:assert/strict';
import {BinanceLiveTransport} from '../src/binance-live.mjs';
import {engineFixture,ACCOUNT_B} from './registry-fixture.mjs';
import {liveClientOrderId} from '../../web/lib/execution/robot-v1-live-cycle.ts';
import {ENTRY_MARKET_POLICY} from '../../web/lib/execution/strategy-engine.ts';

function fixture(change={}){
 const engine={...engineFixture('BTCBRL',ACCOUNT_B,101,false),hard_cap_quote:500,max_order_quote:500,account_cap_quote:1000};
 const id=liveClientOrderId('00000000-0000-4000-8000-000000000099','BTC',7,8,'BUY',11,{...engine,legacy_compatible:false});
 const orders=change.orders??[],posts=[];let observed=null;
 const snapshot={account:{balances:[{asset:'BRL',free:change.freeQuote??453},{asset:'BNB',free:change.freeBnb??.004}]},
  bnbBrlPrice:{price:5000},openOrders:orders,price:{price:423673},filters:{minQuantity:.00001,maxQuantity:100,
   quantityStep:.00001,priceTick:1,minNotional:10,allowedSelfTradePreventionModes:['EXPIRE_TAKER']}};
 const transport=new BinanceLiveTransport({apiKey:'fixture-only',apiSecret:'fixture-only',engine,
  fetcher:()=>assert.fail('isolated fixture must never access Binance'),requireSelfTradePrevention:true});
 transport.queryOrder=async()=>observed;
 transport.safetySnapshot=async()=>snapshot;
 transport.signed=async(method,path,fields)=>{assert.equal(method,'POST');assert.equal(path,'/api/v3/order');posts.push(fields);
  const body={symbol:'BTCBRL',clientOrderId:id,orderId:123,side:'BUY',status:'FILLED',executedQty:'.00004',
   cummulativeQuoteQty:'16.94692',price:'0'};
  observed={orderId:'123',clientOrderId:id,symbol:'BTCBRL',side:'BUY',status:'FILLED',executedQuantity:.00004,
   cumulativeQuoteQuantity:16.94692,price:0};return {ok:true,body};};
 const input={symbol:'BTCBRL',clientOrderId:id,side:'BUY',purpose:'ENTRY',type:'MARKET',quoteOrderQty:'19.26268762',
  entryMarketPolicy:ENTRY_MARKET_POLICY,entryReferencePrice:432279,entrySlotNumber:7,
  expectedOwnedOpenIds:orders.filter(o=>o.clientOrderId.startsWith(id.slice(0,14))).map(o=>o.clientOrderId),
  assetCapBrl:500,globalCapBrl:1000,assetExposureBeforeBrl:200,globalExposureBeforeBrl:300};
 return {transport,input,posts,snapshot,engine,flags:{allowCreate:true,tradingEnabled:true,killSwitch:false}};
}

test('explicit missed ENTRY MARKET uses full quoteOrderQty, owned namespace, STP and query-first single dispatch',async()=>{
 const f=fixture();const result=await f.transport.createOwnedOrder(f.input,f.flags);
 assert.equal(result.clientOrderId,f.input.clientOrderId);assert.equal(f.posts.length,1);
 assert.equal(f.posts[0].quoteOrderQty,'19.26268762');assert.equal(f.posts[0].type,'MARKET');
 assert.equal(f.posts[0].selfTradePreventionMode,'EXPIRE_TAKER');
 await f.transport.createOwnedOrder(f.input,f.flags);assert.equal(f.posts.length,1);
});

test('missing/foreign market intent, wrong slot, insufficient BNB/cash, parent kill or caps cannot POST',async()=>{
 for(const change of [{entryMarketPolicy:undefined},{entryMarketPolicy:'OTHER'},{entrySlotNumber:8},
  {entryReferencePrice:0},{quoteOrderQty:'4'},{assetCapBrl:501},{assetExposureBeforeBrl:495}]){
  const f=fixture();await assert.rejects(f.transport.createOwnedOrder({...f.input,...change},f.flags));assert.equal(f.posts.length,0);
 }
 for(const opts of [{freeBnb:0},{freeQuote:1}]){
  const f=fixture(opts);await assert.rejects(f.transport.createOwnedOrder(f.input,f.flags));assert.equal(f.posts.length,0);
 }
 const f=fixture();await assert.rejects(f.transport.createOwnedOrder(f.input,{...f.flags,killSwitch:true}));assert.equal(f.posts.length,0);
});

test('a resident BUY in the same engine still blocks a second entry even with an exact expected snapshot',async()=>{
 const f=fixture();const resident=liveClientOrderId('00000000-0000-4000-8000-000000000099','BTC',9,1,'BUY',1,
  {...f.engine,legacy_compatible:false});
 f.snapshot.openOrders.push({clientOrderId:resident,side:'BUY',status:'NEW',executedQuantity:0});
 f.input.expectedOwnedOpenIds=[resident];
 await assert.rejects(f.transport.createOwnedOrder(f.input,f.flags),/MARKET_ENTRY_UNRECONCILED/);assert.equal(f.posts.length,0);
});
