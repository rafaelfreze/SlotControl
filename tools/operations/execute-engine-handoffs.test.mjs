import {test} from 'node:test';import assert from 'node:assert/strict';
import {requestId,proveOrders} from './execute-engine-handoffs.mjs';
const fixture=()=>{const o={id:'local',exchange_order_id:'123',client_order_id:'C2-0123456789-1-S-example',side:'SELL',purpose:'TP',status:'NEW',price:12,requested_quantity:1,executed_quantity:0,slot_id:'slot1'};
 const h={operator_id:'operator',exchange_account_id:'account',trading_engine_id:'engine',kind:'CLIENT_MANAGED',before_snapshot:{engine:{symbol:'SOLBRL',slot_count:2,order_owner_prefix:'C2-0123456789-'},run:{id:'run'},slots:[{id:'slot1',run_id:'run',entry_state:'OPEN',position_quantity:1},{id:'slot2',run_id:'run',entry_state:'PLANNED'}],orders:[o]}};
 const scope={operator_id:'operator',exchange_account_id:'account',trading_engine_id:'engine',environment:'REAL',symbol:'SOLBRL'};
 const probe={pending_claims:0,rows:[{path:'/v1/health',result:{...scope,healthy:true,egress_ipv4_verified:true}},{path:'/v1/state',result:{...scope,open_orders:[{id:'123',clientOrderId:o.client_order_id,symbol:'SOLBRL',side:'SELL',status:'NEW',price:12,originalQuantity:1,executedQuantity:0}]}}]};return {h,probe};};
test('handoff request is deterministic per engine and purpose, never a new engine identity',()=>{
 assert.equal(requestId('engine','CLIENT_MANAGED'),requestId('engine','CLIENT_MANAGED'));
 assert.notEqual(requestId('engine','CLIENT_MANAGED'),requestId('engine','SHARD_MIGRATION'));
});
test('TP proof requires exact IDs, financial quantities, namespace, full resident inventory and no pending claim',()=>{
 const {h,probe}=fixture();assert.equal(proveOrders(h,probe).tps,1);
 for(const edit of [p=>p.pending_claims=1,p=>p.rows[0].result.healthy=false,
  p=>p.rows[1].result.exchange_account_id='foreign',p=>p.rows[1].result.open_orders[0].id='wrong',
  p=>p.rows[1].result.open_orders[0].executedQuantity=.1,p=>p.rows[1].result.open_orders[0].price=13,
  p=>p.rows[1].result.open_orders.push({...p.rows[1].result.open_orders[0],id:'extra'})]){
   const changed=structuredClone(probe);edit(changed);assert.throws(()=>proveOrders(h,changed),/UNPROVEN/);
 }
});
