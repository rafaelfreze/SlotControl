import test from'node:test';import assert from'node:assert/strict';
import{requestMissedMarketEntry}from'./request-missed-market-entry.mjs';
const args=['6918a0fa-39fd-423a-bc60-ee8d8ecffb25','516530f6-16dc-4617-be9b-ccb32d1d4e57','BTC',
 'd49c8b87-b2c2-4965-830f-e3b5e293f282','7','8'],secret='offline-secret-only-0000000000000000';
test('official command binds one exact operation, no amount/price or retry',async()=>{
 let calls=0;const result=await requestMissedMarketEntry(args,secret,async(url,options)=>{
  calls++;assert.equal(url,'https://cripto-flax.vercel.app/api/cron/live-control');assert.equal(options.redirect,'error');
  assert.deepEqual(JSON.parse(options.body),{action:'REENTER_MISSED_MARKET',asset:'BTC',exchange_account_id:args[0],
   trading_engine_id:args[1],run_id:args[3],slot_number:7,operation_sequence:8});
  return{ok:true,json:async()=>({status:'MARKET_ENTRY_AUTHORIZED',cycle_id:args[3],slot_number:7,operation_sequence:8})};
 });assert.equal(calls,1);assert.equal(result.operation_sequence,8);
 await assert.rejects(requestMissedMarketEntry(args,secret,async()=>{calls++;throw Error('timeout');}));assert.equal(calls,2);
 for(const change of [[...args,'22'],[...args.slice(0,4),'0','8'],[...args.slice(0,4),'7','NaN']])
  await assert.rejects(requestMissedMarketEntry(change,secret,()=>assert.fail('invalid input must not send')));
 await assert.rejects(requestMissedMarketEntry(args,secret,async()=>({ok:true,json:async()=>({status:'MARKET_ENTRY_AUTHORIZED',cycle_id:'other',slot_number:7,operation_sequence:8})})));
});
