set request.jwt.claim.role = 'service_role';

-- Synthetic local-only fixture: 26 engines prove that admission is split
-- into two independent transactions instead of locking the entire fleet.
insert into coinops.trading_engines(id,operator_id,exchange_account_id,environment,status,kill_switch,symbol,quote_asset)
select ('50000000-0000-0000-0000-' || lpad((i+100)::text,12,'0'))::uuid,
  '10000000-0000-0000-0000-000000000001',
  ('60000000-0000-0000-0000-' || lpad((i+100)::text,12,'0'))::uuid,
  'REAL','ACTIVE',false,'SOLBRL','BRL' from generate_series(1,26) i;
insert into coinops.robot_v1_live_runs(id,trading_engine_id,operator_id,exchange_account_id,symbol,
  product_id,tenant_id,user_id,status,lease_owner,lease_until,config_version,entry_regime)
select ('70000000-0000-0000-0000-' || lpad((i+100)::text,12,'0'))::uuid,
  ('50000000-0000-0000-0000-' || lpad((i+100)::text,12,'0'))::uuid,
  '10000000-0000-0000-0000-000000000001',
  ('60000000-0000-0000-0000-' || lpad((i+100)::text,12,'0'))::uuid,'SOLBRL',
  '20000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000001',
  '40000000-0000-0000-0000-000000000001','ACTIVE',null,null,1,'POST_ATH'
  from generate_series(1,26) i;
insert into coinops.robot_v1_ath_profiles(id,trading_engine_id,operator_id,exchange_account_id,environment,
  product_id,tenant_id,user_id,config_version,next_config_version,post_ath_spacing_rate,regime)
select ('80000000-0000-0000-0000-' || lpad((i+100)::text,12,'0'))::uuid,
  ('50000000-0000-0000-0000-' || lpad((i+100)::text,12,'0'))::uuid,
  '10000000-0000-0000-0000-000000000001',
  ('60000000-0000-0000-0000-' || lpad((i+100)::text,12,'0'))::uuid,'REAL',
  '20000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000001',
  '40000000-0000-0000-0000-000000000001',1,null,.08,'POST_ATH'
  from generate_series(1,26) i;

do $$
declare
  v_items jsonb;
  v_batch uuid;
  v_step jsonb;
begin
  select jsonb_agg(jsonb_build_object(
    'engine_id',('50000000-0000-0000-0000-' || lpad((i+100)::text,12,'0'))::uuid,
    'expected_version',1,
    'expected_run_id',('70000000-0000-0000-0000-' || lpad((i+100)::text,12,'0'))::uuid,
    'expected_profile_id',('80000000-0000-0000-0000-' || lpad((i+100)::text,12,'0'))::uuid,
    'expected_regime','POST_ATH','expected_post_ath_spacing_rate',.08,
    'new_post_ath_spacing_rate',.05) order by i) into v_items
    from generate_series(1,26) i;
  v_batch := coinops.enqueue_strategy_bulk_post_ath(
    '10000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001',
    'a0000000-0000-0000-0000-000000000026','{"parameter":"post_ath_spacing_rate"}'::jsonb,
    v_items,null);
  v_step := coinops.admit_strategy_bulk_next(v_batch,'40000000-0000-0000-0000-000000000001');
  if (v_step->>'admitted')::integer <> 25 or (v_step->>'failed')::integer <> 0
    or (select count(*) from coinops.strategy_bulk_engine_updates where batch_id=v_batch) <> 25
    or (select count(*) from coinops.trading_engines where strategy_config_pending
      and id::text like '50000000-0000-0000-0000-0000000001%') <> 25
    then raise exception 'CHUNK_25_FAILED'; end if;
  v_step := coinops.admit_strategy_bulk_next(v_batch,'40000000-0000-0000-0000-000000000001');
  if (v_step->>'admitted')::integer <> 26 or (v_step->>'failed')::integer <> 0
    or (select count(*) from coinops.strategy_bulk_engine_updates where batch_id=v_batch) <> 26
    then raise exception 'CHUNK_26_FAILED'; end if;
  raise notice 'BULK_CHUNK_FIXTURE_PASS';
end $$;
