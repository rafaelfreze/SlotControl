set request.jwt.claim.role = 'service_role';
insert into coinops.operators values (
  '10000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000001',
  '40000000-0000-0000-0000-000000000001', 'ACTIVE', false);
insert into coinops.trading_engines(id,operator_id,exchange_account_id,environment,status,kill_switch,symbol,quote_asset)
values
  ('50000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001',
   '60000000-0000-0000-0000-000000000001','REAL','ACTIVE',false,'SOLBRL','BRL'),
  ('50000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001',
   '60000000-0000-0000-0000-000000000002','REAL','ACTIVE',false,'BTCBRL','BRL');
insert into coinops.robot_v1_live_runs(id,trading_engine_id,operator_id,exchange_account_id,symbol,
  product_id,tenant_id,user_id,status,lease_owner,lease_until,config_version,entry_regime)
values
  ('70000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000001','SOLBRL',
   '20000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001',
   '40000000-0000-0000-0000-000000000001','ACTIVE',
   '90000000-0000-0000-0000-000000000001',now()+interval '5 minutes',1,'POST_ATH'),
  ('70000000-0000-0000-0000-000000000002','50000000-0000-0000-0000-000000000002',
   '10000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000002','BTCBRL',
   '20000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001',
   '40000000-0000-0000-0000-000000000001','ACTIVE',
   '90000000-0000-0000-0000-000000000002',now()+interval '5 minutes',1,'NORMAL');
insert into coinops.robot_v1_ath_profiles(id,trading_engine_id,operator_id,exchange_account_id,environment,
  product_id,tenant_id,user_id,config_version,next_config_version,post_ath_spacing_rate,regime)
values
  ('80000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000001','REAL',
   '20000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001',
   '40000000-0000-0000-0000-000000000001',1,null,.08,'POST_ATH'),
  ('80000000-0000-0000-0000-000000000002','50000000-0000-0000-0000-000000000002',
   '10000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000002','REAL',
   '20000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001',
   '40000000-0000-0000-0000-000000000001',1,null,.08,'NORMAL');

do $$
declare
  v_batch uuid;
  v_replay uuid;
  v_item uuid;
  v_scope jsonb := '{"parameter":"post_ath_spacing_rate","previewHash":"fixture"}'::jsonb;
  v_items jsonb := '[{"engine_id":"50000000-0000-0000-0000-000000000001",
    "expected_version":1,"expected_run_id":"70000000-0000-0000-0000-000000000001",
    "expected_profile_id":"80000000-0000-0000-0000-000000000001",
    "expected_regime":"POST_ATH","expected_post_ath_spacing_rate":0.08,
    "new_post_ath_spacing_rate":0.05}]'::jsonb;
begin
  v_batch := coinops.enqueue_strategy_bulk_post_ath(
    '10000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001',
    'a0000000-0000-0000-0000-000000000001',v_scope,v_items,null);
  v_replay := coinops.enqueue_strategy_bulk_post_ath(
    '10000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001',
    'a0000000-0000-0000-0000-000000000001',v_scope,v_items,null);
  if v_batch <> v_replay then raise exception 'IDEMPOTENCY_FAILED'; end if;
  if (coinops.admit_strategy_bulk_next(v_batch,'40000000-0000-0000-0000-000000000001')->>'admitted')::integer <> 1
    then raise exception 'ADMISSION_CURSOR_FAILED'; end if;
  if (coinops.admit_strategy_bulk_next(v_batch,'40000000-0000-0000-0000-000000000001')->>'admitted')::integer <> 1
    then raise exception 'ADMISSION_REPLAY_FAILED'; end if;
  if not (select strategy_config_pending from coinops.trading_engines
    where id='50000000-0000-0000-0000-000000000001') then raise exception 'GATE_NOT_CLOSED'; end if;
  if (select strategy_config_pending from coinops.trading_engines
    where id='50000000-0000-0000-0000-000000000002') then raise exception 'OTHER_ENGINE_GATED'; end if;
  begin
    insert into coinops.robot_v1_live_orders values
      ('b0000000-0000-0000-0000-000000000001','70000000-0000-0000-0000-000000000001','BUY','PREPARED',null);
    raise exception 'BUY_GATE_DID_NOT_BLOCK';
  exception when others then
    if sqlerrm <> 'COINOPS_STRATEGY_CONFIG_UPDATE_PENDING' then raise; end if;
  end;
  insert into coinops.robot_v1_live_orders values
    ('b0000000-0000-0000-0000-000000000002','70000000-0000-0000-0000-000000000001','SELL','NEW',null),
    ('b0000000-0000-0000-0000-000000000003','70000000-0000-0000-0000-000000000002','BUY','PREPARED',null);
  update coinops.robot_v1_ath_profiles set config_version=2,post_ath_spacing_rate=.05
    where id='80000000-0000-0000-0000-000000000001';
  update coinops.robot_v1_live_runs set config_version=2
    where id='70000000-0000-0000-0000-000000000001';
  select id into v_item from coinops.strategy_bulk_engine_updates where batch_id=v_batch;
  perform coinops.finish_strategy_bulk_engine_update(v_item,'90000000-0000-0000-0000-000000000001');
  if (select strategy_config_pending from coinops.trading_engines
    where id='50000000-0000-0000-0000-000000000001') then raise exception 'GATE_NOT_REOPENED'; end if;
  if (select status from coinops.strategy_bulk_batches where id=v_batch) <> 'APPLIED'
    then raise exception 'BATCH_NOT_APPLIED'; end if;
  insert into coinops.robot_v1_live_orders values
    ('b0000000-0000-0000-0000-000000000004','70000000-0000-0000-0000-000000000001','BUY','PREPARED',null);
  -- A conflicting second engine cannot undo or gate the first engine.
  v_items := '[{"engine_id":"50000000-0000-0000-0000-000000000001",
    "expected_version":2,"expected_run_id":"70000000-0000-0000-0000-000000000001",
    "expected_profile_id":"80000000-0000-0000-0000-000000000001",
    "expected_regime":"POST_ATH","expected_post_ath_spacing_rate":0.05,
    "new_post_ath_spacing_rate":0.06},{"engine_id":"50000000-0000-0000-0000-000000000002",
    "expected_version":99,"expected_run_id":"70000000-0000-0000-0000-000000000002",
    "expected_profile_id":"80000000-0000-0000-0000-000000000002",
    "expected_regime":"NORMAL","expected_post_ath_spacing_rate":0.08,
    "new_post_ath_spacing_rate":0.06}]'::jsonb;
  v_batch := coinops.enqueue_strategy_bulk_post_ath(
    '10000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001',
    'a0000000-0000-0000-0000-000000000002',v_scope,v_items,null);
  if (coinops.admit_strategy_bulk_next(v_batch,'40000000-0000-0000-0000-000000000001')->>'failed')::integer <> 1
    then raise exception 'ISOLATED_ADMISSION_FAILURE_NOT_RECORDED'; end if;
  if (select count(*) from coinops.strategy_bulk_engine_updates where batch_id=v_batch) <> 1
    or not (select strategy_config_pending from coinops.trading_engines
      where id='50000000-0000-0000-0000-000000000001')
    or (select strategy_config_pending from coinops.trading_engines
      where id='50000000-0000-0000-0000-000000000002')
    or (select status from coinops.strategy_bulk_batches where id=v_batch) <> 'PARTIAL'
    then raise exception 'ISOLATED_ADMISSION_FAILURE_SPILLED'; end if;
  raise notice 'BULK_MIGRATION_FIXTURE_PASS';
end $$;
