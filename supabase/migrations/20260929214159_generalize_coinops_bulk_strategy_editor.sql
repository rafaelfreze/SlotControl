-- Generalize the existing safe bulk pipeline. No order/config is changed by DDL.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table coinops.strategy_bulk_engine_updates
  add column parameter_key text not null default 'post_ath_spacing_rate',
  add column apply_policy text not null default 'NEXT_BUY_RECONCILE',
  add column requires_order_reconciliation boolean not null default true;

alter table coinops.strategy_bulk_engine_updates
  add constraint strategy_bulk_parameter_key_check check (parameter_key in (
    'gain_rate','normal_spacing_rate','post_ath_spacing_rate','monthly_target')),
  add constraint strategy_bulk_apply_policy_check check (apply_policy in (
    'NEXT_CYCLE_ONLY','NEXT_BUY_RECONCILE','FUTURE_ENTRIES_ONLY','METADATA_ONLY'));

create index strategy_bulk_parameter_audit
  on coinops.strategy_bulk_engine_updates(parameter_key,created_at desc);

create function coinops.enqueue_strategy_bulk_update(
  p_operator_id uuid, p_created_by uuid, p_idempotency_key uuid,
  p_scope jsonb, p_engines jsonb, p_rollback_of uuid default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_operator coinops.operators%rowtype;
  v_batch coinops.strategy_bulk_batches%rowtype;
  v_payload jsonb;
  v_parameter text;
  v_policy text;
begin
  if coalesce(nullif(current_setting('request.jwt.claim.role',true),''),
    nullif(auth.jwt()->>'role',''),'') <> 'service_role' then
    raise exception 'COINOPS_BULK_ADMIN_REQUIRED'; end if;
  v_parameter := p_scope->>'parameterKey';
  v_policy := p_scope->>'applyPolicy';
  if p_scope is null or jsonb_typeof(p_scope) <> 'object'
    or p_engines is null or jsonb_typeof(p_engines) <> 'array'
    or jsonb_array_length(p_engines) < 1 or jsonb_array_length(p_engines) > 5000
    or v_parameter not in ('gain_rate','normal_spacing_rate','post_ath_spacing_rate','monthly_target')
    or v_policy <> (case v_parameter
      when 'gain_rate' then 'NEXT_CYCLE_ONLY'
      when 'monthly_target' then 'FUTURE_ENTRIES_ONLY'
      else 'NEXT_BUY_RECONCILE' end)
    then raise exception 'COINOPS_BULK_SCOPE_INVALID'; end if;
  select * into v_operator from coinops.operators where id = p_operator_id
    and user_id = p_created_by and status = 'ACTIVE' and not kill_switch for update;
  if not found then raise exception 'COINOPS_BULK_ADMIN_DENIED'; end if;
  v_payload := jsonb_build_object('scope',p_scope,'engines',p_engines,'rollback_of',p_rollback_of);
  select * into v_batch from coinops.strategy_bulk_batches
    where operator_id = p_operator_id and idempotency_key = p_idempotency_key;
  if found then
    if v_batch.request_payload <> v_payload then raise exception 'COINOPS_BULK_IDEMPOTENCY_CONFLICT'; end if;
    return v_batch.id;
  end if;
  if p_rollback_of is not null and not exists (
    select 1 from coinops.strategy_bulk_batches where id = p_rollback_of
      and operator_id = p_operator_id and status in ('APPLIED','PARTIAL'))
    then raise exception 'COINOPS_BULK_ROLLBACK_DENIED'; end if;
  insert into coinops.strategy_bulk_batches(product_id,tenant_id,user_id,operator_id,
    created_by,idempotency_key,request_payload,rollback_of)
    values(v_operator.product_id,v_operator.tenant_id,v_operator.user_id,p_operator_id,
      p_created_by,p_idempotency_key,v_payload,p_rollback_of) returning * into v_batch;
  return v_batch.id;
end $$;
revoke all on function coinops.enqueue_strategy_bulk_update(uuid,uuid,uuid,jsonb,jsonb,uuid)
  from public, anon, authenticated;
grant execute on function coinops.enqueue_strategy_bulk_update(uuid,uuid,uuid,jsonb,jsonb,uuid)
  to service_role;

create or replace function coinops.admit_strategy_bulk_next(p_batch_id uuid, p_created_by uuid)
  returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_batch coinops.strategy_bulk_batches%rowtype;
  v_operator coinops.operators%rowtype;
  v_item jsonb;
  v_engine coinops.trading_engines%rowtype;
  v_profile coinops.robot_v1_ath_profiles%rowtype;
  v_preparation coinops.robot_v1_live_preparations%rowtype;
  v_run coinops.robot_v1_live_runs%rowtype;
  v_parameter text;
  v_policy text;
  v_requires_reconciliation boolean;
  v_value numeric;
  v_old numeric;
  v_expected integer;
  v_cursor integer;
  v_failures jsonb;
  v_code text;
  v_total integer;
begin
  if coalesce(nullif(current_setting('request.jwt.claim.role',true),''),
    nullif(auth.jwt()->>'role',''),'') <> 'service_role' then
    raise exception 'COINOPS_BULK_SERVICE_REQUIRED'; end if;
  select * into v_batch from coinops.strategy_bulk_batches where id = p_batch_id
    and created_by = p_created_by for update;
  if not found then raise exception 'COINOPS_BULK_BATCH_UNAVAILABLE'; end if;
  select * into v_operator from coinops.operators where id = v_batch.operator_id
    and user_id = p_created_by and status = 'ACTIVE' and not kill_switch;
  if not found then raise exception 'COINOPS_BULK_ADMIN_DENIED'; end if;
  v_parameter := coalesce(v_batch.request_payload->'scope'->>'parameterKey',
    v_batch.request_payload->'scope'->>'parameter');
  v_policy := case v_parameter when 'gain_rate' then 'NEXT_CYCLE_ONLY'
    when 'monthly_target' then 'FUTURE_ENTRIES_ONLY'
    when 'normal_spacing_rate' then 'NEXT_BUY_RECONCILE'
    when 'post_ath_spacing_rate' then 'NEXT_BUY_RECONCILE' else null end;
  v_requires_reconciliation := v_parameter in ('normal_spacing_rate','post_ath_spacing_rate');
  if v_policy is null or coalesce(v_batch.request_payload->'scope'->>'applyPolicy',v_policy) <> v_policy
    then raise exception 'COINOPS_BULK_PARAMETER_INVALID'; end if;
  v_cursor := v_batch.admission_cursor;
  v_failures := v_batch.admission_failures;
  v_total := jsonb_array_length(v_batch.request_payload->'engines');
  for v_item in select value from jsonb_array_elements(v_batch.request_payload->'engines')
    with ordinality as planned(value, ordinal) where ordinal > v_cursor
    order by ordinal limit 25 loop
    v_cursor := v_cursor + 1;
    v_code := 'COINOPS_BULK_ITEM_INVALID';
    begin
      if not (v_item ? 'engine_id' and v_item ? 'expected_version'
        and v_item ? 'expected_run_id' and v_item ? 'expected_profile_id'
        and v_item ? 'expected_regime'
        and ((v_item ? 'expected_value' and v_item ? 'new_value')
          or (v_parameter = 'post_ath_spacing_rate'
            and v_item ? 'expected_post_ath_spacing_rate' and v_item ? 'new_post_ath_spacing_rate')))
        then raise exception '%', v_code; end if;
      v_value := coalesce(v_item->>'new_value',v_item->>'new_post_ath_spacing_rate')::numeric;
      v_old := coalesce(v_item->>'expected_value',v_item->>'expected_post_ath_spacing_rate')::numeric;
      v_expected := (v_item->>'expected_version')::integer;
      if v_value is null or v_old is null or v_expected is null or v_expected < 1
        or v_parameter in ('gain_rate','normal_spacing_rate','post_ath_spacing_rate')
          and (v_value < 0.001 or v_value > 0.2)
        or v_parameter = 'monthly_target'
          and (v_value < 1 or v_value > 1000 or v_value <> trunc(v_value))
        then raise exception 'COINOPS_BULK_VALUE_OR_VERSION_INVALID'; end if;
      v_code := 'COINOPS_BULK_RUN_UNAVAILABLE';
      select * into v_run from coinops.robot_v1_live_runs
        where trading_engine_id = (v_item->>'engine_id')::uuid and status = 'ACTIVE'
        order by created_at desc limit 1 for update;
      if not found or v_run.id <> (v_item->>'expected_run_id')::uuid
        then raise exception '%', v_code; end if;
      v_code := 'COINOPS_BULK_ENGINE_UNAVAILABLE';
      select * into v_engine from coinops.trading_engines
        where id = (v_item->>'engine_id')::uuid and operator_id = v_batch.operator_id
          and environment = 'REAL' and status = 'ACTIVE' and not kill_switch for update;
      if not found or v_engine.strategy_config_pending then raise exception '%', v_code; end if;
      if v_run.exchange_account_id <> v_engine.exchange_account_id
        or v_run.operator_id <> v_batch.operator_id or v_run.symbol <> v_engine.symbol
        or v_run.product_id <> v_operator.product_id or v_run.tenant_id <> v_operator.tenant_id
        or v_run.user_id <> v_operator.user_id then raise exception 'COINOPS_BULK_RUN_UNAVAILABLE'; end if;
      v_code := 'COINOPS_BULK_PROFILE_CONFLICT';
      select * into v_profile from coinops.robot_v1_ath_profiles
        where trading_engine_id = v_engine.id and environment = 'REAL' for update;
      if not found or v_profile.operator_id <> v_batch.operator_id
        or v_profile.id <> (v_item->>'expected_profile_id')::uuid
        or v_profile.exchange_account_id <> v_engine.exchange_account_id
        or v_profile.product_id <> v_operator.product_id or v_profile.tenant_id <> v_operator.tenant_id
        or v_profile.user_id <> v_operator.user_id or v_profile.config_version <> v_expected
        or v_profile.regime <> (v_item->>'expected_regime') or v_profile.next_config_version is not null
        then raise exception '%', v_code; end if;
      if v_parameter = 'gain_rate' and v_profile.gain_rate <> v_old
        or v_parameter = 'normal_spacing_rate' and v_profile.normal_spacing_rate <> v_old
        or v_parameter = 'post_ath_spacing_rate' and v_profile.post_ath_spacing_rate <> v_old
        then raise exception '%', v_code; end if;
      if v_parameter = 'monthly_target' then
        v_code := 'COINOPS_BULK_PREPARATION_CONFLICT';
        select * into v_preparation from coinops.robot_v1_live_preparations
          where trading_engine_id = v_engine.id and operator_id = v_batch.operator_id for update;
        if not found or v_preparation.exchange_account_id <> v_engine.exchange_account_id
          or v_preparation.monthly_target <> v_old then raise exception '%', v_code; end if;
      end if;
      v_code := 'COINOPS_BULK_ADMISSION_FAILED';
      insert into coinops.strategy_bulk_engine_updates(batch_id,product_id,tenant_id,user_id,
        operator_id,exchange_account_id,trading_engine_id,run_id,profile_id,symbol,quote_asset,
        strategy_version_before,strategy_version_after,parameter_key,apply_policy,
        requires_order_reconciliation,old_values,new_values)
        values(v_batch.id,v_operator.product_id,v_operator.tenant_id,v_operator.user_id,
          v_batch.operator_id,v_engine.exchange_account_id,v_engine.id,v_run.id,v_profile.id,
          v_engine.symbol,v_engine.quote_asset,v_expected,v_expected+1,v_parameter,v_policy,
          v_requires_reconciliation,jsonb_build_object(v_parameter,v_old),jsonb_build_object(v_parameter,v_value));
      update coinops.trading_engines set strategy_config_pending = true, updated_at = now()
        where id = v_engine.id;
    exception when others then
      v_failures := v_failures || jsonb_build_object(coalesce(v_item->>'engine_id',
        'item-' || v_cursor::text), v_code);
    end;
  end loop;
  update coinops.strategy_bulk_batches set admission_cursor = v_cursor,
    admission_failures = v_failures, updated_at = now(),
    status = case when v_cursor < v_total then 'APPLYING'
      when v_failures = '{}'::jsonb and not exists (select 1 from coinops.strategy_bulk_engine_updates
        where batch_id = v_batch.id and status <> 'APPLIED') then 'APPLIED'
      when v_failures <> '{}'::jsonb then 'PARTIAL'
      when exists (select 1 from coinops.strategy_bulk_engine_updates
        where batch_id = v_batch.id and status = 'BLOCKED_SAFE') then 'PARTIAL'
      else 'APPLYING' end,
    applied_at = case when v_cursor = v_total and v_failures = '{}'::jsonb
      and not exists (select 1 from coinops.strategy_bulk_engine_updates
        where batch_id = v_batch.id and status <> 'APPLIED') then now() else null end
    where id = v_batch.id;
  return jsonb_build_object('batchId',v_batch.id,'selected',v_total,
    'admitted',v_cursor,'failed',(select count(*) from jsonb_object_keys(v_failures)));
end $$;

create or replace function coinops.finish_strategy_bulk_engine_update(p_item_id uuid, p_lease_owner uuid)
  returns void language plpgsql security definer set search_path = '' as $$
declare
  v_item coinops.strategy_bulk_engine_updates%rowtype;
  v_run coinops.robot_v1_live_runs%rowtype;
  v_profile coinops.robot_v1_ath_profiles%rowtype;
  v_preparation coinops.robot_v1_live_preparations%rowtype;
  v_value numeric;
begin
  if coalesce(nullif(current_setting('request.jwt.claim.role',true),''),
    nullif(auth.jwt()->>'role',''),'') <> 'service_role' then
    raise exception 'COINOPS_BULK_SERVICE_REQUIRED'; end if;
  select * into v_item from coinops.strategy_bulk_engine_updates where id = p_item_id for update;
  if not found or v_item.status not in ('PENDING','APPLYING') then raise exception 'COINOPS_BULK_ITEM_UNAVAILABLE'; end if;
  v_value := (v_item.new_values->>v_item.parameter_key)::numeric;
  select * into v_run from coinops.robot_v1_live_runs where id = v_item.run_id for update;
  if not found or v_run.lease_owner <> p_lease_owner or v_run.lease_until is null
    or v_run.lease_until <= now() or v_run.trading_engine_id <> v_item.trading_engine_id
    or v_item.apply_policy <> 'NEXT_CYCLE_ONLY' and v_run.config_version <> v_item.strategy_version_after
    then raise exception 'COINOPS_BULK_LEASE_OR_VERSION_INVALID'; end if;
  select * into v_profile from coinops.robot_v1_ath_profiles where id = v_item.profile_id for share;
  if not found or v_profile.trading_engine_id <> v_item.trading_engine_id
    or v_profile.config_version <> v_item.strategy_version_after
    or v_item.parameter_key = 'gain_rate' and v_profile.gain_rate <> v_value
    or v_item.parameter_key = 'normal_spacing_rate' and v_profile.normal_spacing_rate <> v_value
    or v_item.parameter_key = 'post_ath_spacing_rate' and v_profile.post_ath_spacing_rate <> v_value
    then raise exception 'COINOPS_BULK_PROFILE_VERSION_INVALID'; end if;
  if v_item.parameter_key = 'monthly_target' then
    select * into v_preparation from coinops.robot_v1_live_preparations
      where trading_engine_id = v_item.trading_engine_id for share;
    if not found or v_preparation.operator_id <> v_item.operator_id
      or v_preparation.monthly_target <> v_value then raise exception 'COINOPS_BULK_PREPARATION_VERSION_INVALID'; end if;
  end if;
  if v_item.requires_order_reconciliation
    and ((v_item.parameter_key = 'normal_spacing_rate' and v_run.entry_regime = 'NORMAL')
      or (v_item.parameter_key = 'post_ath_spacing_rate' and v_run.entry_regime = 'POST_ATH'))
    and exists (select 1 from coinops.robot_v1_live_orders o where o.run_id = v_run.id
      and o.side = 'BUY' and o.status in ('PREPARED','NEW','PARTIALLY_FILLED'))
    then raise exception 'COINOPS_BULK_BUY_STILL_ACTIVE'; end if;
  update coinops.strategy_bulk_engine_updates set status = 'APPLIED', error_code = null,
    applied_at = now(), updated_at = now() where id = v_item.id;
  update coinops.trading_engines set strategy_config_pending = false, updated_at = now()
    where id = v_item.trading_engine_id and operator_id = v_item.operator_id;
  update coinops.strategy_bulk_batches set status = case
    when admission_cursor < jsonb_array_length(request_payload->'engines') then 'APPLYING'
    when admission_failures = '{}'::jsonb and not exists (select 1 from coinops.strategy_bulk_engine_updates
      where batch_id = v_item.batch_id and status <> 'APPLIED') then 'APPLIED'
    when admission_failures <> '{}'::jsonb or exists (select 1 from coinops.strategy_bulk_engine_updates
      where batch_id = v_item.batch_id and status = 'BLOCKED_SAFE') then 'PARTIAL'
    else 'APPLYING' end,
    applied_at = case when admission_cursor = jsonb_array_length(request_payload->'engines')
      and admission_failures = '{}'::jsonb and not exists (select 1 from coinops.strategy_bulk_engine_updates
        where batch_id = v_item.batch_id and status <> 'APPLIED') then now() else null end,
    updated_at = now() where id = v_item.batch_id;
end $$;

revoke all on function coinops.admit_strategy_bulk_next(uuid,uuid)
  from public, anon, authenticated;
revoke all on function coinops.finish_strategy_bulk_engine_update(uuid,uuid)
  from public, anon, authenticated;
grant execute on function coinops.admit_strategy_bulk_next(uuid,uuid) to service_role;
grant execute on function coinops.finish_strategy_bulk_engine_update(uuid,uuid) to service_role;

-- Keep the optimized Home projection aligned with the editable per-engine goal.
create or replace function coinops.dashboard_live_engine_reads(
  p_operator_id uuid, p_engine_ids uuid[]
) returns table(engine_id uuid, payload jsonb)
language sql stable security invoker set search_path = '' as $$
select e.id, jsonb_build_object(
  'run', to_jsonb(r),
  'slots', coalesce((select jsonb_agg(x order by x.slot_number) from (
    select slot_number,entry_state,target_buy_price,operational_rank,post_ath_group,
      post_ath_group_rank,operation_sequence,position_quantity,position_committed_brl,
      position_committed_quote,missed_at
    from coinops.robot_v1_live_slots where operator_id=e.operator_id
      and exchange_account_id=e.exchange_account_id and trading_engine_id=e.id and run_id=r.id
  ) x), '[]'::jsonb),
  'orders', coalesce((select jsonb_agg(x order by x.created_at,x.client_order_id) from (
    select side,purpose,status,slot_number,client_order_id,exchange_order_id,price,
      requested_quantity,requested_quote,executed_quantity,cumulative_quote,created_at,
      updated_at,fee_base,fee_quote,fee_other,reserved_notional_brl,reserved_notional_quote
    from coinops.robot_v1_live_orders where operator_id=e.operator_id
      and exchange_account_id=e.exchange_account_id and trading_engine_id=e.id and run_id=r.id
  ) x), '[]'::jsonb),
  'accounts', coalesce((select jsonb_agg(x order by x.slot_number) from (
    select slot_number,balance_brl,balance_quote,contribution_brl,contribution_quote,
      market_pnl_brl,market_pnl_quote,manual_gain_brl,manual_gain_quote,fees_brl,fees_quote,
      gain_count,dust_quantity,dust_cost_brl,dust_cost_quote
    from coinops.robot_v1_live_slot_accounts where operator_id=e.operator_id
      and exchange_account_id=e.exchange_account_id and trading_engine_id=e.id
  ) x), '[]'::jsonb),
  'selectiveAllocations', coalesce((select jsonb_agg(x order by x.created_at) from (
    select slot_number,amount_quote,status,created_at,applied_at
    from coinops.robot_v1_live_selective_contribution_allocations where operator_id=e.operator_id
      and exchange_account_id=e.exchange_account_id and trading_engine_id=e.id
      and status in ('PENDING','APPLIED')
  ) x), '[]'::jsonb),
  'events', coalesce((select jsonb_agg(x order by x.observed_at desc) from (
    select event_type,slot_number,observed_at,details from coinops.robot_v1_live_events
    where operator_id=e.operator_id and exchange_account_id=e.exchange_account_id
      and trading_engine_id=e.id and run_id=r.id order by observed_at desc limit 40
  ) x), '[]'::jsonb),
  'alerts', coalesce((select jsonb_agg(x) from (
    select severity,code,last_seen_at from coinops.robot_v1_live_alerts
    where operator_id=e.operator_id and exchange_account_id=e.exchange_account_id
      and trading_engine_id=e.id and resolved_at is null
  ) x), '[]'::jsonb),
  'monthlyGains', coalesce((select jsonb_agg(x) from (
    select slot_number,physical_slot_id,period_key,lifetime_gain_count,monthly_gain_count,
      market_gain_count,manual_gain_count,monthly_market_gain_count,monthly_manual_gain_count
    from coinops.robot_v1_slot_gain_totals where operator_id=e.operator_id
      and exchange_account_id=e.exchange_account_id and trading_engine_id=e.id
  ) x), '[]'::jsonb),
  'preparation', (select jsonb_build_object('liveEnabled',live_enabled,'killSwitch',kill_switch,
      'monthlyTarget',monthly_target)
    from coinops.robot_v1_live_preparations where operator_id=e.operator_id
      and exchange_account_id=e.exchange_account_id and trading_engine_id=e.id)
)
from coinops.trading_engines e
left join lateral (
  select id,status,symbol,entry_regime,last_reconciled_at,last_error,config_version,gain_rate,entry_spacing
  from coinops.robot_v1_live_runs where operator_id=e.operator_id
    and exchange_account_id=e.exchange_account_id and trading_engine_id=e.id
    and status in ('PREPARING','ACTIVE','PAUSED')
) r on true
where e.operator_id=p_operator_id and e.id=any(p_engine_ids) and e.environment='REAL'
  and cardinality(p_engine_ids) between 1 and 32
order by e.id;
$$;

commit;
