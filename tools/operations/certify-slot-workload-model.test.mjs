import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { accountOrderBudgetDecision } from "../../apps/web/lib/execution/account-order-budget.ts";

// Projection/profile regression only. Real versioned SQL functions run in
// PostgreSQL/WASM; readiness/safety are explicit fixture boundaries. No remote
// account, signed certificate, telemetry history or admission is manufactured.
const load = createRequire(new URL("../testing/account-pause-sql/package.json", import.meta.url));
const { PGlite } = load("@electric-sql/pglite");
const sha = "a".repeat(40), hash = "b".repeat(64), policy = "capacity-v3-20260930";
const required = ["STEADY", "ALL_TP_FILL_BURST", "TRANSIENT_RETRIES", "SIBLING_LOAD", "CPU_RAM", "RECONCILIATION_BACKLOG", "QUEUE_AND_RATE_LIMIT"];
const migration = name => readFileSync(new URL(`../../supabase/migrations/${name}.sql`, import.meta.url), "utf8");
const source = migration("20261016161550_configurable_live_engine_slots");
const profileSQL = source.slice(source.indexOf("create or replace function private.coinops_slot_workload_profile("),
  source.indexOf("revoke all on function private.coinops_slot_workload_profile("));
const slotsSQL = source.slice(source.indexOf("create or replace function coinops.preview_engine_slot_admission("),
  source.indexOf("revoke all on function coinops.preview_engine_slot_admission("));
const v3 = migration("20260930140348_coinops_admission_hysteresis");
const previewSQL = v3.slice(v3.indexOf("create or replace function coinops.preview_executor_admission("),
  v3.indexOf("-- This reviewed control-plane-only policy upgrade"));
const policySQL = v3.slice(v3.indexOf("create or replace function coinops.executor_capacity_policy("),
  v3.indexOf("create table coinops.executor_admission_hysteresis"));
const profile = (count, units, bound) => ({ slot_count: count, capacity_units: units,
  upper_bound_weight_per_minute: bound, status: "PASS", evidence_sha256: "c".repeat(64),
  scenarios: Object.fromEntries(required.map(key => [key, "PASS"])) });
async function fixture() {
  const db = new PGlite();
  await db.exec(`create schema coinops;create schema private;
    create table coinops.executor_shards(id text primary key,enabled boolean);
    create table coinops.executor_capacity_samples(shard_id text,observed_at timestamptz,
      binance_weight_current numeric,binance_weight_average numeric,binance_weight_peak numeric);
    create table coinops.executor_admission_release(singleton boolean,target_sha text,runtime_sha256 text,node_version text,policy_version text);
    create table coinops.executor_admission_attestations(shard_id text,target_sha text,runtime_sha256 text,node_version text,policy_version text,evidence jsonb);
    create table coinops.executor_capacity_admissions(engine_id uuid,shard_id text,environment text,reserved_weight numeric,expires_at timestamptz);
    create table coinops.executor_admission_hysteresis(shard_id text,environment text,planned_engines int,
      policy_version text,sample_at timestamptz,allowed boolean,reason text,healthy_since timestamptz,
      blocked_since timestamptz,last_transition_at timestamptz);
    create function coinops.executor_capacity_sample_for_environment(text,text) returns coinops.executor_capacity_samples
      language sql as $$ select * from coinops.executor_capacity_samples where shard_id=$1 $$;
    create function coinops.executor_admission_readiness(text) returns jsonb language sql as $$select '{"ready":true}'::jsonb$$;
    create function coinops.executor_capacity_sample_safety(coinops.executor_capacity_samples) returns jsonb
      language sql as $$select '{"state":"HEALTHY","action":"NONE"}'::jsonb$$;
    insert into coinops.executor_shards values('executor-03',true);
    insert into coinops.executor_capacity_samples values('executor-03',now(),682,682,720);
    insert into coinops.executor_admission_release values(true,'${sha}','${hash}','v24.21.0','${policy}');
    insert into coinops.executor_admission_attestations values('executor-03','${sha}','${hash}','v24.21.0','${policy}','{}');
    insert into coinops.executor_admission_hysteresis select 'executor-03','REAL',n,'${policy}',now(),true,
      'SUSTAINED_HEADROOM_AVAILABLE',now()-interval '10 minutes',null,now() from generate_series(1,25)n;`);
  await db.exec(policySQL + previewSQL + profileSQL + slotsSQL);
  const one = async sql => (await db.query(sql)).rows[0].v;
  const profiles = async values => db.query("update coinops.executor_admission_attestations set evidence=$1", [{ slot_workload: {
    contract: "SLOT_WORKLOAD_V1", environment: "REAL", target_sha: sha, runtime_sha256: hash, policy_version: policy, profiles: values } }]);
  return { db, one, profiles, preview: counts => one(`select coinops.preview_engine_slot_admission('executor-03','REAL',array[${counts.join(",")}]) as v`) };
}

test("canonical profile25/50/100 depends on exact evidence, never on slot-count division", async t => {
  const f = await fixture(); t.after(() => f.db.close());
  assert.equal((await f.preview([25])).incremental_weight, 900);
  assert.equal((await f.preview([50])).reason, "SLOT_WORKLOAD_UNCERTIFIED");
  assert.equal((await f.preview([100])).reason, "SLOT_WORKLOAD_UNCERTIFIED");
  await f.profiles([profile(50, 2, 1750)]); // Synthetic evidence only, not a real50 certificate.
  assert.equal((await f.preview([50])).incremental_weight, 1800);
  assert.equal((await f.preview([100])).reason, "SLOT_WORKLOAD_UNCERTIFIED");
  await f.profiles([profile(50, 2, 1750), profile(100, 3, 2600)]);
  assert.equal((await f.preview([100])).incremental_weight, 2700);
  assert.equal((await f.preview([25, 50])).incremental_weight, 2700);
});
test("2816 is not certified by2700; four units reserve3600 without changing3900/2100 limits", async t => {
  const f = await fixture(); t.after(() => f.db.close());
  await f.profiles([profile(50, 3, 2816)]);
  assert.equal((await f.preview([50])).reason, "SLOT_WORKLOAD_UNCERTIFIED");
  await f.profiles([profile(50, 4, 2816)]);
  const result = await f.preview([50]);
  assert.equal(result.incremental_weight, 3600); assert.equal(result.projected_weight, 4282);
  assert.equal(result.admission_limit_weight, 3900); assert.equal(result.recovery_headroom_weight, 2100);
  assert.equal(result.code, "CAPACITY_REQUIRED");
  assert.equal(result.policy.admission_ratio + result.policy.recovery_ratio, 1);
  assert.equal(682 + 2816, 3498, "exact-weight design illustration only; current canonical gate reserves3600");
});
test("unobserved reservations are charged once; own replay is excluded and no other IP budget is borrowed", async t => {
  const f = await fixture(); t.after(() => f.db.close());
  await f.profiles([profile(50, 3, 2600)]);
  const engine = "00000000-0000-4000-8000-000000000001";
  await f.db.exec(`insert into coinops.executor_capacity_admissions values
    ('${engine}','executor-03','REAL',900,now()+interval '5 minutes'),
    ('00000000-0000-4000-8000-000000000002','executor-01','REAL',900,now()+interval '5 minutes');`);
  const other = await f.preview([50]);
  assert.equal(other.reserved_weight, 900); assert.equal(other.projected_weight, 4282);
  const own = await f.one(`select coinops.preview_engine_slot_admission('executor-03','REAL',array[50],'${engine}') as v`);
  assert.equal(own.reserved_weight, 0); assert.equal(own.projected_weight, 3382);
  assert.equal(own.recovery_headroom_weight, 2100);
});
test("25/50/100 reserve N+1 resident orders; two USDT siblings count globally, not as SOLBRL orders", () => {
  const now = Date.parse("2026-10-16T19:10:40Z");
  const sample = { accountId: "fixture-account", observedAt: now, serverTime: now, restrictions: [],
    intervals: [{ intervalMs: 86_400_000, limit: 200_000, count: 0 }],
    symbols: { SOLBRL: { maxOrders: 200, openOrders: 0, externalOrders: 0, selfTradePrevention: "EXPIRE_TAKER" } },
    exchangeOrders: { limit: 1000, openOrders: 0, externalOrders: 0 } };
  const input = count => ({ accountId: sample.accountId, newOrders: 3, newEngineSymbol: "SOLBRL",
    newEngines: 1, existingEnginesForSymbol: 0, existingEnginesForAccount: 2,
    newEngineSlotCounts: [count], existingEngineSlotCountsForSymbol: [], existingEngineSlotCountsForAccount: [25, 25] });
  for (const [count, globalFootprint] of [[25, 78], [50, 103], [100, 153]]) {
    assert.equal(globalFootprint, 26 + 26 + count + 1);
    const exact = { ...sample, exchangeOrders: { ...sample.exchangeOrders, limit: globalFootprint } };
    assert.equal(accountOrderBudgetDecision(exact, [], input(count), now).code, "PASS");
    assert.equal(accountOrderBudgetDecision({ ...exact, exchangeOrders: { ...exact.exchangeOrders, limit: globalFootprint - 1 } }, [], input(count), now).code,
      "ACCOUNT_ORDER_CAPACITY_REQUIRED");
    const pairExact = { ...sample, symbols: { SOLBRL: { ...sample.symbols.SOLBRL, maxOrders: count + 1 } } };
    assert.equal(accountOrderBudgetDecision(pairExact, [], input(count), now).code, "PASS");
  }
  const twoHundred = { ...input(100), existingEnginesForSymbol: 1, existingEngineSlotCountsForSymbol: [100],
    existingEnginesForAccount: 3, existingEngineSlotCountsForAccount: [25, 25, 100] };
  assert.equal(accountOrderBudgetDecision(sample, [], twoHundred, now).code, "ACCOUNT_ORDER_CAPACITY_REQUIRED");
});
