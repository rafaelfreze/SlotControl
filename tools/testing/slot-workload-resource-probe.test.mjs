import assert from "node:assert/strict";
import test from "node:test";
import { BinanceLiveTransport } from "../../apps/live-executor/src/binance-live.mjs";
import { shardedEngineMap } from "../../apps/web/lib/execution/sharded-engine-map.ts";
import { renderSlotWorkloadResourceProbe,runSlotWorkloadResourceProbe } from "./slot-workload-resource-probe.mjs";

test("transport-only probe uses canonical shard scheduler and real per-engine4+1+1 order concurrency",async()=>{
  const result=await runSlotWorkloadResourceProbe(BinanceLiveTransport,shardedEngineMap);
  assert.equal(result.external_network_calls,0);assert.equal(result.environment_or_vault_reads,0);assert.equal(result.filesystem_writes,0);
  assert.equal(result.scope,"TRANSPORT_ONLY_NOT_FULL_STRATEGY_ENGINE");
  assert.deepEqual(result.scenarios.map(row=>row.slot_count),[25,100]);
  for(const row of result.scenarios){
    assert.equal(row.posts_or_deletes,0);assert.equal(row.foreign_engine_rejected,true);
    assert.equal(row.acknowledged_sell_peak_inflight_gets,row.slot_count>25?6:3);
    assert.deepEqual(row.engine_worker_counts,row.slot_count>25?[4,1,1]:[1,1,1]);
    assert.equal(row.engines_peak_by_shard["executor-03"],3);
    assert.ok(row.max_inflight_gets>=row.acknowledged_sell_peak_inflight_gets);
    assert.ok(row.state_peak_inflight_gets>0);assert.equal(row.reconciled_tp_observations,row.slot_count+50);
    assert.equal(row.request_weight,162+(row.slot_count+50)*19);
    assert.ok(row.process_peak_rss_bytes>0);assert.ok(row.cpu_user_ms>=0);assert.ok(row.fixture_json_bytes>0);
  }
  assert.equal(result.queue_callbacks.implementation,"CANONICAL_SHARDED_ENGINE_MAP");
  assert.equal(result.queue_callbacks.peak_by_shard["executor-03"],4);
  assert.equal(result.queue_callbacks.other_shard_completed_before_release,true);
  assert.equal(result.queue_callbacks.fifth_engine_waited_for_slot,true);
  console.log(JSON.stringify({local_only:true,...result}));
});

test("remote program accepts only a local deployed public module and fences external fetch",()=>{
  const code=renderSlotWorkloadResourceProbe("file:///opt/coinops/releases/test/apps/live-executor/src/binance-live.mjs");
  assert.match(code,/globalThis\.fetch=async/);assert.match(code,/external fetch forbidden/);
  assert.match(code,/sharded-engine-map\.ts/);
  assert.doesNotMatch(code,/process\.env|readFile|writeFile|child_process/);
  assert.throws(()=>renderSlotWorkloadResourceProbe("https://example.test/apps/live-executor/src/binance-live.mjs"));
  assert.throws(()=>renderSlotWorkloadResourceProbe("file:///var/lib/coinops/vault.json"));
});

test("resource probe refuses an absent canonical scheduler instead of silently substituting a global pool",async()=>{
  await assert.rejects(runSlotWorkloadResourceProbe(BinanceLiveTransport),/canonical shard scheduler required/);
});

test("exact50 workload is selected explicitly; invalid counts cannot generate or run a certificate probe",async()=>{
  const result=await runSlotWorkloadResourceProbe(BinanceLiveTransport,shardedEngineMap,[50]);
  assert.deepEqual(result.scenarios.map(row=>row.slot_count),[50]);
  assert.equal(result.scenarios[0].reconciled_tp_observations,100);
  assert.equal(result.scenarios[0].acknowledged_sell_peak_inflight_gets,6);
  assert.equal(result.scenarios[0].request_weight,2062);
  for(const counts of [[],[1],[101],[50,50],[25,50,75,100],["50"]]){
    assert.throws(()=>renderSlotWorkloadResourceProbe("file:///opt/coinops/releases/test/apps/live-executor/src/binance-live.mjs",counts),/slot counts invalid/);
    await assert.rejects(runSlotWorkloadResourceProbe(BinanceLiveTransport,shardedEngineMap,counts),/slot counts invalid/);
  }
});
