-- CoinOps / OnPlay Platform (otdfpmsegjxpqrzisfmi), schema coinops only.
-- Software range 2..100 is not an admission/capacity certificate. Existing
-- engines retain 25 slots, ownership, strategy, balances and all resident orders.
-- Roll out consumers and the common executor release before admitting N != 25.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

do $$ begin
  if exists(select 1 from coinops.trading_engines where config ? 'slot_count'
    and config->'slot_count' is distinct from '25'::jsonb) then
    raise exception 'COINOPS_EXISTING_SLOT_TOPOLOGY_REQUIRES_REVIEW';
  end if;
end $$;

alter table coinops.trading_engines add column slot_count integer not null default 25;
alter table coinops.trading_engines add constraint trading_engines_slot_count_range check (slot_count between 2 and 100);
alter table coinops.trading_engines add constraint trading_engines_legacy_environment_slot_count
  check (environment='REAL' or slot_count=25);
-- Fast constant default backfills historical topology without UPDATEs, refresh
-- events or writes to existing financial state. INSERT derives from the engine.
alter table coinops.robot_v1_live_runs add column slot_count integer not null default 25;
alter table coinops.robot_v1_live_runs alter column slot_count drop default;
alter table coinops.robot_v1_live_runs add constraint robot_v1_live_runs_slot_count_range check (slot_count between 2 and 100);
alter table coinops.robot_v1_live_preparations drop constraint robot_v1_live_preparations_slot_count_check;
alter table coinops.robot_v1_live_preparations add constraint robot_v1_live_preparations_slot_count_check check (slot_count between 2 and 100);

-- Keep the engine column authoritative; JSON is a checked compatibility mirror,
-- never a way to resize a funded engine, including during bulk edits/recovery.
create or replace function private.coinops_engine_slot_topology_guard()
returns trigger language plpgsql set search_path='' as $$
begin
  if tg_op='UPDATE' and new.slot_count is distinct from old.slot_count then
    raise exception 'COINOPS_ENGINE_SLOT_COUNT_IMMUTABLE';
  end if;
  if new.slot_count is null or new.slot_count not between 2 and 100
    or (new.slot_count<>25 and not(new.config ? 'slot_count'))
    or (new.config ? 'slot_count' and (jsonb_typeof(new.config->'slot_count') is distinct from 'number'
      or new.config->>'slot_count' !~ '^[1-9][0-9]*$'
      or (new.config->>'slot_count')::numeric<>new.slot_count)) then
    raise exception 'COINOPS_ENGINE_SLOT_TOPOLOGY_INVALID';
  end if;
  return new;
end $$;
revoke all on function private.coinops_engine_slot_topology_guard() from public,anon,authenticated;
create trigger ab_coinops_engine_slot_topology before insert or update of slot_count,config
  on coinops.trading_engines for each row execute function private.coinops_engine_slot_topology_guard();

-- aa_coinops_engine_context runs first and binds exact engine/account/operator.
-- A run stores an immutable snapshot, also checked against its preparation.
create or replace function private.coinops_live_slot_topology_guard()
returns trigger language plpgsql set search_path='' as $$
declare engine_count integer; preparation_count integer;
begin
  select e.slot_count into engine_count from coinops.trading_engines e
    where e.id=new.trading_engine_id and e.operator_id=new.operator_id
      and e.exchange_account_id=new.exchange_account_id and e.environment='REAL';
  if engine_count is null then raise exception 'COINOPS_ENGINE_SLOT_SCOPE_DENIED'; end if;
  if tg_table_name='robot_v1_live_runs' then
    if tg_op='INSERT' and new.slot_count is null then new.slot_count:=engine_count; end if;
    select p.slot_count into preparation_count from coinops.robot_v1_live_preparations p
      where p.trading_engine_id=new.trading_engine_id and p.operator_id=new.operator_id
        and p.exchange_account_id=new.exchange_account_id;
    if preparation_count is distinct from engine_count then raise exception 'COINOPS_ENGINE_SLOT_TOPOLOGY_INVALID'; end if;
    if tg_op='UPDATE' and new.slot_count is distinct from old.slot_count then
      raise exception 'COINOPS_ENGINE_SLOT_COUNT_IMMUTABLE';
    end if;
    if new.config_snapshot ? 'slot_count' and
      (jsonb_typeof(new.config_snapshot->'slot_count') is distinct from 'number'
        or new.config_snapshot->>'slot_count' !~ '^[1-9][0-9]*$'
        or (new.config_snapshot->>'slot_count')::numeric<>engine_count) then
      raise exception 'COINOPS_ENGINE_SLOT_TOPOLOGY_INVALID';
    end if;
  elsif tg_op='UPDATE' and new.slot_count is distinct from old.slot_count then
    raise exception 'COINOPS_ENGINE_SLOT_COUNT_IMMUTABLE';
  end if;
  if new.slot_count is distinct from engine_count then raise exception 'COINOPS_ENGINE_SLOT_TOPOLOGY_INVALID'; end if;
  return new;
end $$;
revoke all on function private.coinops_live_slot_topology_guard() from public,anon,authenticated;
create trigger ab_coinops_live_slot_topology before insert or update of trading_engine_id,operator_id,exchange_account_id,slot_count
  on coinops.robot_v1_live_preparations for each row execute function private.coinops_live_slot_topology_guard();
create trigger ab_coinops_live_slot_topology before insert or update of trading_engine_id,operator_id,exchange_account_id,slot_count,config_snapshot
  on coinops.robot_v1_live_runs for each row execute function private.coinops_live_slot_topology_guard();

-- A broad physical upper bound is supplemented by the canonical per-engine
-- bound below. Manual/Testnet history remains capped at 25; no Testnet revival.
alter table coinops.robot_v1_live_slot_accounts drop constraint robot_v1_live_slot_accounts_slot_number_check;
alter table coinops.robot_v1_live_slot_accounts add constraint robot_v1_live_slot_accounts_slot_number_check check (slot_number between 1 and 100);
alter table coinops.robot_v1_live_slots drop constraint robot_v1_live_slots_slot_number_check;
alter table coinops.robot_v1_live_slots add constraint robot_v1_live_slots_slot_number_check check (slot_number between 1 and 100);
alter table coinops.robot_v1_live_slots drop constraint robot_v1_live_slots_operational_rank_check;
alter table coinops.robot_v1_live_slots add constraint robot_v1_live_slots_operational_rank_check check (operational_rank between 1 and 100);
alter table coinops.robot_v1_live_slots drop constraint robot_v1_live_slots_post_ath_group_rank_check;
alter table coinops.robot_v1_live_slots add constraint robot_v1_live_slots_post_ath_group_rank_check check (post_ath_group_rank between 1 and 100);
alter table coinops.robot_v1_live_orders drop constraint robot_v1_live_orders_slot_number_check;
alter table coinops.robot_v1_live_orders add constraint robot_v1_live_orders_slot_number_check check (slot_number between 1 and 100);
alter table coinops.robot_v1_live_events drop constraint robot_v1_live_events_slot_number_check;
alter table coinops.robot_v1_live_events add constraint robot_v1_live_events_slot_number_check check (slot_number between 1 and 100);
alter table coinops.robot_v1_monthly_slot_gains drop constraint robot_v1_monthly_slot_gains_slot_number_check;
alter table coinops.robot_v1_monthly_slot_gains add constraint robot_v1_monthly_slot_gains_slot_number_check check
  (slot_number between 1 and case when environment='REAL' then 100 else 25 end);
alter table coinops.robot_v1_live_adjustment_items drop constraint robot_v1_live_adjustment_items_slot_number_check;
alter table coinops.robot_v1_live_adjustment_items add constraint robot_v1_live_adjustment_items_slot_number_check check (slot_number between 1 and 100);
alter table coinops.robot_v1_live_selective_contribution_allocations drop constraint robot_v1_live_selective_contribution_allocati_slot_number_check;
alter table coinops.robot_v1_live_selective_contribution_allocations add constraint robot_v1_live_selective_contribution_allocati_slot_number_check check (slot_number between 1 and 100);
alter table coinops.robot_v1_live_selective_contribution_presets drop constraint robot_v1_live_selective_contribution_presets_total_slots_check;
alter table coinops.robot_v1_live_selective_contribution_presets add constraint robot_v1_live_selective_contribution_presets_total_slots_check check (total_slots between 1 and 100);
alter table coinops.robot_v1_live_selective_contribution_presets drop constraint robot_v1_live_selective_contribution_presets_open_slots_check;
alter table coinops.robot_v1_live_selective_contribution_presets add constraint robot_v1_live_selective_contribution_presets_open_slots_check check (open_slots between 1 and 100);
alter table coinops.robot_v1_live_selective_contribution_presets drop constraint robot_v1_live_selective_contribution_pres_following_slots_check;
alter table coinops.robot_v1_live_selective_contribution_presets add constraint robot_v1_live_selective_contribution_pres_following_slots_check check (following_slots between 0 and 99);
alter table coinops.robot_v1_live_selective_contribution_preset_usages drop constraint robot_v1_live_selective_contribution_p_anchor_slot_number_check;
alter table coinops.robot_v1_live_selective_contribution_preset_usages add constraint robot_v1_live_selective_contribution_p_anchor_slot_number_check check (anchor_slot_number between 1 and 100);
alter table coinops.robot_v1_live_selective_contribution_preset_usages drop constraint robot_v1_live_selective_contributio_resolved_slot_numbers_check;
alter table coinops.robot_v1_live_selective_contribution_preset_usages add constraint robot_v1_live_selective_contributio_resolved_slot_numbers_check check (cardinality(resolved_slot_numbers) between 1 and 100);

create or replace function private.coinops_physical_slot_bound_guard()
returns trigger language plpgsql set search_path='' as $$
declare n integer; row_data jsonb:=to_jsonb(new); value integer;
begin
  if tg_table_name='robot_v1_monthly_slot_gains' and row_data->>'environment'<>'REAL' then return new; end if;
  select e.slot_count into n from coinops.trading_engines e
    where e.id=new.trading_engine_id and e.operator_id=new.operator_id and e.environment='REAL'
      and (not(row_data ? 'exchange_account_id') or e.exchange_account_id=(row_data->>'exchange_account_id')::uuid);
  if n is null then raise exception 'COINOPS_ENGINE_SLOT_SCOPE_DENIED'; end if;
  if row_data ? 'run_id' and not exists(select 1 from coinops.robot_v1_live_runs r
    where r.id=(row_data->>'run_id')::uuid and r.trading_engine_id=new.trading_engine_id
      and r.slot_count=n) then raise exception 'COINOPS_ENGINE_SLOT_SCOPE_DENIED'; end if;
  foreach value in array array[(row_data->>'slot_number')::integer,(row_data->>'operational_rank')::integer,
    (row_data->>'post_ath_group_rank')::integer,(row_data->>'anchor_slot_number')::integer] loop
    if value is not null and (value<1 or value>n) then raise exception 'COINOPS_PHYSICAL_SLOT_OUT_OF_RANGE'; end if;
  end loop;
  if row_data ? 'resolved_slot_numbers' and exists(select 1 from jsonb_array_elements_text(row_data->'resolved_slot_numbers') v
    where v::integer not between 1 and n) then raise exception 'COINOPS_PHYSICAL_SLOT_OUT_OF_RANGE'; end if;
  return new;
end $$;
revoke all on function private.coinops_physical_slot_bound_guard() from public,anon,authenticated;
do $$ declare t text; columns text; begin
  foreach t in array array['robot_v1_live_slot_accounts','robot_v1_live_slots','robot_v1_live_orders','robot_v1_live_events',
    'robot_v1_monthly_slot_gains','robot_v1_live_adjustment_items','robot_v1_live_selective_contribution_allocations',
    'robot_v1_live_selective_contribution_preset_usages'] loop
    columns:=case when t='robot_v1_live_slots' then 'slot_number,operational_rank,post_ath_group_rank,trading_engine_id'
      when t='robot_v1_live_selective_contribution_preset_usages' then 'anchor_slot_number,resolved_slot_numbers,trading_engine_id'
      else 'slot_number,trading_engine_id' end;
    execute format('create trigger ab_coinops_physical_slot_bound before insert or update of %s on coinops.%I for each row execute function private.coinops_physical_slot_bound_guard()',columns,t);
  end loop;
end $$;

-- Parse strict optional plan topology. Legacy requests retain the 25-slot
-- interpretation; null/string/fraction/unknown topology is not a legacy value.
create or replace function private.coinops_plan_slot_count(p_item jsonb)
returns integer language plpgsql immutable set search_path='' as $$
declare n integer;
begin
  if not(p_item ? 'slotCount') then return 25; end if;
  if jsonb_typeof(p_item->'slotCount') is distinct from 'number'
    or p_item->>'slotCount' !~ '^[1-9][0-9]*$' then raise exception 'COINOPS_ENGINE_SLOT_COUNT_INVALID'; end if;
  n:=(p_item->>'slotCount')::integer;
  if n not between 2 and 100 then raise exception 'COINOPS_ENGINE_SLOT_COUNT_INVALID'; end if;
  return n;
end $$;
revoke all on function private.coinops_plan_slot_count(jsonb) from public,anon,authenticated;

create or replace function private.coinops_plan_replay_input(p_input jsonb)
returns jsonb language sql immutable set search_path='' as $$
  select case when jsonb_typeof(p_input->'engines')='array' then jsonb_set(p_input,'{engines}',
    (select coalesce(jsonb_agg(
      (case when private.coinops_plan_slot_count(v)=25 then v-'slotCount' else v end)
        - case when v->>'monthlyTarget'=case v->>'asset' when 'BTC' then '7' else '2' end
          then 'monthlyTarget' else '__no_default_field__' end order by i),'[]')
      from jsonb_array_elements(p_input->'engines') with ordinality a(v,i))) else p_input end
$$;
revoke all on function private.coinops_plan_replay_input(jsonb) from public,anon,authenticated;

-- A software topology is NOT a workload certificate. Legacy25 retains its
-- current conservative profile. Every other count needs exact-count coverage,
-- tied to this fleet release and reviewed bounded scenarios. No maximum-count
-- inference, linear ceil(N/25) assumption, or fresh low-weight sample certifies it.
create or replace function private.coinops_slot_workload_profile(p_shard_id text,p_environment text,p_slot_count integer)
returns jsonb language plpgsql stable set search_path='' as $$
declare a coinops.executor_admission_attestations%rowtype;
  r coinops.executor_admission_release%rowtype; policy jsonb:=coinops.executor_capacity_policy();
  proof jsonb; profile jsonb; units integer; upper_bound numeric;
  required_scenarios text[]:=array['STEADY','ALL_TP_FILL_BURST','TRANSIENT_RETRIES','SIBLING_LOAD',
    'CPU_RAM','RECONCILIATION_BACKLOG','QUEUE_AND_RATE_LIMIT'];
begin
  if p_slot_count=25 then return jsonb_build_object('code','SLOT_WORKLOAD_CERTIFIED','capacity_units',1,'basis','LEGACY_25_SLOT_PROFILE'); end if;
  if p_slot_count is null or p_slot_count not between 2 and 100 or p_environment is distinct from 'REAL' then
    return jsonb_build_object('code','SLOT_WORKLOAD_UNCERTIFIED'); end if;
  select * into a from coinops.executor_admission_attestations where shard_id=p_shard_id;
  select * into r from coinops.executor_admission_release where singleton;
  proof:=a.evidence->'slot_workload';
  if a.shard_id is null or r.target_sha is null or a.target_sha is distinct from r.target_sha
    or a.runtime_sha256 is distinct from r.runtime_sha256 or a.node_version is distinct from r.node_version
    or a.policy_version is distinct from r.policy_version or a.policy_version is distinct from policy->>'version'
    or jsonb_typeof(proof) is distinct from 'object' or proof->>'contract' is distinct from 'SLOT_WORKLOAD_V1'
    or proof->>'environment' is distinct from p_environment or proof->>'target_sha' is distinct from r.target_sha
    or proof->>'runtime_sha256' is distinct from r.runtime_sha256 or proof->>'policy_version' is distinct from r.policy_version
    or jsonb_typeof(proof->'profiles') is distinct from 'array' then
    return jsonb_build_object('code','SLOT_WORKLOAD_UNCERTIFIED'); end if;
  if (select count(*) from jsonb_array_elements(proof->'profiles') p where p->'slot_count'=to_jsonb(p_slot_count))<>1 then
    return jsonb_build_object('code','SLOT_WORKLOAD_UNCERTIFIED'); end if;
  select p into profile from jsonb_array_elements(proof->'profiles') p where p->'slot_count'=to_jsonb(p_slot_count);
  if profile->>'status' is distinct from 'PASS'
    or jsonb_typeof(profile->'capacity_units') is distinct from 'number'
    or profile->>'capacity_units' !~ '^[1-9][0-9]*$'
    or jsonb_typeof(profile->'upper_bound_weight_per_minute') is distinct from 'number'
    or profile->>'upper_bound_weight_per_minute' !~ '^[0-9]+([.][0-9]+)?$'
    or profile->>'evidence_sha256' is null or profile->>'evidence_sha256' !~ '^[a-f0-9]{64}$'
    or jsonb_typeof(profile->'scenarios') is distinct from 'object'
    or exists(select 1 from unnest(required_scenarios) s where profile->'scenarios'->>s is distinct from 'PASS') then
    return jsonb_build_object('code','SLOT_WORKLOAD_UNCERTIFIED'); end if;
  units:=(profile->>'capacity_units')::integer; upper_bound:=(profile->>'upper_bound_weight_per_minute')::numeric;
  if units not between 1 and 25 or upper_bound<=0 or upper_bound>units*(policy->>'incremental_weight')::numeric then
    return jsonb_build_object('code','SLOT_WORKLOAD_UNCERTIFIED'); end if;
  return jsonb_build_object('code','SLOT_WORKLOAD_CERTIFIED','capacity_units',units,
    'upper_bound_weight_per_minute',upper_bound,'evidence_sha256',profile->>'evidence_sha256','basis','ATTESTED_EXACT_SLOT_WORKLOAD');
exception when data_exception then
  return jsonb_build_object('code','SLOT_WORKLOAD_UNCERTIFIED');
end $$;
revoke all on function private.coinops_slot_workload_profile(text,text,integer) from public,anon,authenticated;
grant execute on function private.coinops_slot_workload_profile(text,text,integer) to service_role;

-- Reuse the SINGLE projection formula and persisted hysteresis. The count of
-- conservative units comes ONLY from the reviewed workload profile, not N/25.
create or replace function coinops.preview_engine_slot_admission(p_shard_id text,p_environment text,p_slot_counts integer[],p_exclude_engine uuid default null)
returns jsonb language plpgsql stable set search_path='' as $$
declare units integer:=0; slot_count integer; profile jsonb; result jsonb;
begin
  if cardinality(p_slot_counts) not between 1 and 25 or p_slot_counts is null
    or exists(select 1 from unnest(p_slot_counts) n where n is null or n not between 2 and 100) then
    return jsonb_build_object('code','CAPACITY_UNKNOWN','reason','INVALID_SLOT_ADMISSION_INPUT'); end if;
  foreach slot_count in array p_slot_counts loop
    profile:=private.coinops_slot_workload_profile(p_shard_id,p_environment,slot_count);
    if profile->>'code' is distinct from 'SLOT_WORKLOAD_CERTIFIED' then
      return jsonb_build_object('code','CAPACITY_UNKNOWN','reason','SLOT_WORKLOAD_UNCERTIFIED',
        'slot_count',slot_count,'slot_counts',p_slot_counts,'slot_cost_basis','EXACT_WORKLOAD_ATTESTATION_REQUIRED'); end if;
    units:=units+(profile->>'capacity_units')::integer;
  end loop;
  if units not between 1 and 25 then return jsonb_build_object('code','CAPACITY_UNKNOWN','reason','SLOT_ADMISSION_PROFILE_UNCERTIFIED'); end if;
  result:=coinops.preview_executor_admission(p_shard_id,p_environment,units,p_exclude_engine);
  return result||jsonb_build_object('slot_counts',p_slot_counts,'capacity_units',units,'slot_cost_basis','ATTESTED_EXACT_SLOT_WORKLOAD_OR_LEGACY_25');
end $$;
revoke all on function coinops.preview_engine_slot_admission(text,text,integer[],uuid) from public,anon,authenticated;
grant execute on function coinops.preview_engine_slot_admission(text,text,integer[],uuid) to service_role;


-- Existing RPCs retain ownership, financial guards and original execution grants.
CREATE OR REPLACE FUNCTION coinops.activate_robot_v1_live_cycle(p_run_id uuid)
 RETURNS coinops.robot_v1_live_runs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_run coinops.robot_v1_live_runs%rowtype;
  v_config coinops.robot_v1_live_preparations%rowtype;
  v_global coinops.account_quote_caps%rowtype;
  v_engine coinops.trading_engines%rowtype;
  v_count integer;
  v_contribution numeric;
  v_slot_admission jsonb;
begin
  select * into strict v_run from coinops.robot_v1_live_runs where id=p_run_id for update;
  if v_run.slot_count<>25 and v_run.status='PREPARING' then
    -- Match append/reservation lock order: account -> shard -> attestation ->
    -- quote cap/preparation. Taking a shard lock after a cap lock can deadlock
    -- an append that already holds the shard and is waiting for that cap.
    perform 1 from coinops.exchange_accounts where id=v_run.exchange_account_id and operator_id=v_run.operator_id for update;
  end if;
  select * into strict v_engine from coinops.trading_engines where id=v_run.trading_engine_id for share;
  if v_engine.slot_count<>25 and v_run.status='PREPARING' then
    perform 1 from coinops.executor_shards where id=v_engine.executor_shard_id and enabled for update;
    if not found then raise exception 'COINOPS_CAPACITY_UNKNOWN'; end if;
    perform 1 from coinops.executor_admission_attestations where shard_id=v_engine.executor_shard_id for share;
    perform 1 from coinops.executor_admission_release where singleton for share;
  end if;
  select * into strict v_global from coinops.account_quote_caps
    where exchange_account_id=v_run.exchange_account_id and quote_asset=v_run.quote_asset for update;
  select * into strict v_config from coinops.robot_v1_live_preparations
    where product_id=v_run.product_id and tenant_id=v_run.tenant_id
      and user_id=v_run.user_id and trading_engine_id=v_run.trading_engine_id and asset=v_run.asset for update;
  if v_engine.status<>'ACTIVE' or v_engine.kill_switch
      or exists(select 1 from coinops.exchange_accounts a where a.id=v_run.exchange_account_id and (a.status<>'ACTIVE' or a.kill_switch))
      or exists(select 1 from coinops.operators o where o.id=v_run.operator_id and (o.status<>'ACTIVE' or o.kill_switch)) then
      raise exception 'COINOPS_ENGINE_NEW_WRITES_BLOCKED'; end if;
  if v_run.status='ACTIVE' and v_config.live_enabled and not v_config.kill_switch then return v_run; end if;
  if v_run.status<>'PREPARING' or v_config.live_enabled or not v_config.kill_switch
    or (v_config.slot_count<>v_engine.slot_count or v_run.slot_count<>v_engine.slot_count) or v_config.configured_live_capital_brl > v_engine.hard_cap_quote
    or v_config.max_order_notional_brl > v_engine.hard_cap_quote
    or v_config.max_total_exposure_brl > v_engine.hard_cap_quote
    or v_engine.hard_cap_quote > v_global.hard_cap_quote
    or exists (select 1 from coinops.robot_v1_live_orders where run_id=v_run.id) then
    raise exception 'COINOPS_LIVE_ACTIVATION_GATE_FAILED';
  end if;
  -- Larger/nonlegacy topologies are DRAFT-capable but cannot bypass the
  -- official admission path by calling activation directly. Existing ACTIVE
  -- replay and every legacy25 activation keep their established semantics.
  if v_engine.slot_count<>25 then
    v_slot_admission:=coinops.preview_engine_slot_admission(v_engine.executor_shard_id,'REAL',array[v_engine.slot_count],v_engine.id);
    if v_slot_admission->>'reason'='SLOT_WORKLOAD_UNCERTIFIED' then raise exception 'COINOPS_SLOT_WORKLOAD_UNCERTIFIED'; end if;
    if v_slot_admission->>'code' is distinct from 'CAPACITY_OK' then
      raise exception '%',case when v_slot_admission->>'code'='CAPACITY_UNKNOWN' then 'COINOPS_CAPACITY_UNKNOWN' else 'COINOPS_CAPACITY_REQUIRED' end;
    end if;
    if not exists(select 1 from coinops.executor_capacity_admissions a where a.engine_id=v_engine.id
      and a.shard_id=v_engine.executor_shard_id and a.environment='REAL' and a.expires_at>now()
      and a.reserved_weight>=(v_slot_admission->>'capacity_units')::integer*(coinops.executor_capacity_policy()->>'incremental_weight')::numeric) then
      raise exception 'COINOPS_SLOT_WORKLOAD_RESERVATION_REQUIRED';
    end if;
  end if;
  select count(*) into v_count from coinops.robot_v1_live_slots where run_id=v_run.id;
  if v_count<>v_engine.slot_count then raise exception 'COINOPS_LIVE_SLOT_COUNT_INVALID'; end if;
  select count(*),coalesce(sum(contribution_brl),0) into v_count,v_contribution
    from coinops.robot_v1_live_slot_accounts where product_id=v_run.product_id
      and tenant_id=v_run.tenant_id and user_id=v_run.user_id and trading_engine_id=v_run.trading_engine_id and asset=v_run.asset
      and balance_brl=contribution_brl and manual_gain_brl=0 and market_pnl_brl=0 and fees_brl=0;
  if v_count<>v_engine.slot_count or v_contribution<>v_config.configured_live_capital_brl then
    raise exception 'COINOPS_LIVE_PRINCIPAL_NOT_PROVEN';
  end if;
  update coinops.robot_v1_live_preparations set live_enabled=true,kill_switch=false,
    config_version=config_version+1 where id=v_config.id;
  update coinops.robot_v1_live_runs set status='ACTIVE' where id=v_run.id returning * into v_run;
  insert into coinops.robot_v1_live_events
    (run_id,product_id,tenant_id,user_id,event_key,event_type,details)
  values (v_run.id,v_run.product_id,v_run.tenant_id,v_run.user_id,
    'RUN_ACTIVATED','RUN_ACTIVATED',jsonb_build_object('asset',v_run.asset,
      'capital_brl',v_contribution,'strategy_version',v_run.strategy_version));
  return v_run;
end $function$
;

CREATE OR REPLACE FUNCTION coinops.append_operator_engine_plan(p_operator_id uuid, p_account_id uuid, p_shard_id text, p_quote_asset text, p_authorized_capital numeric, p_engines jsonb, p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  a coinops.exchange_accounts%rowtype; op coinops.operators%rowtype;
  replay coinops.account_onboarding_checks%rowtype; connection coinops.account_executor_connections%rowtype;
  item jsonb; input jsonb; result jsonb:='[]'; admission jsonb; budget jsonb; symbol_counts jsonb; eid uuid; workload jsonb;
  asset text; cap numeric; gain numeric; spacing numeric; post_ath numeric; target integer; slots integer; slot_counts integer[];
  total numeric:=0; old_cap numeric:=0; allocation coinops.account_engine_append_previews%rowtype; inventory jsonb;
begin
  if coalesce(nullif(current_setting('request.jwt.claim.role',true),''),auth.jwt()->>'role','')<>'service_role'
    or p_operator_id is null or p_account_id is null or p_request_id is null
    or p_quote_asset is null or p_quote_asset not in ('BRL','USDT')
    or p_authorized_capital is null or p_authorized_capital<=0
    or p_authorized_capital::text in ('NaN','Infinity','-Infinity')
    or p_authorized_capital<>round(p_authorized_capital,2)
    or jsonb_typeof(p_engines) is distinct from 'array' or jsonb_array_length(p_engines)<1 then
    raise exception 'COINOPS_PLAN_INPUT_DENIED';
  end if;
  select * into a from coinops.exchange_accounts where id=p_account_id and operator_id=p_operator_id for update;
  select * into op from coinops.operators where id=p_operator_id;
  if a.id is null or op.id is null or op.status<>'ACTIVE' or op.kill_switch
    or a.status not in ('ACTIVE','INACTIVE') or a.kill_switch is distinct from (a.status='INACTIVE')
    or a.executor_profile is distinct from 'coinops-fixed-ip' or a.executor_shard_id is null
    or a.credential_ref is distinct from (case when a.is_legacy_default then 'legacy-binance-production'
      else 'account_'||replace(a.id::text,'-','') end) then
    raise exception 'COINOPS_PLAN_ACCOUNT_DENIED';
  end if;
  input:=jsonb_build_object('quote',p_quote_asset,'capital',p_authorized_capital,'engines',p_engines,'shardId',p_shard_id);
  select * into replay from coinops.account_onboarding_checks where exchange_account_id=a.id
    and idempotency_key='engine-append:'||p_request_id::text;
  if replay.id is not null then
    if replay.operator_id<>op.id or private.coinops_plan_replay_input(replay.evidence->'input') is distinct from private.coinops_plan_replay_input(input) then
      raise exception 'COINOPS_PLAN_REPLAY_MISMATCH';
    end if;
    return replay.evidence->'result';
  end if;
  select * into connection from coinops.account_executor_connections
    where exchange_account_id=a.id and operator_id=op.id and executor_shard_id=p_shard_id and environment='REAL';
  if connection.status is distinct from 'VALIDATED'
    or not exists(select 1 from coinops.binance_account_identity_bindings where exchange_account_id=a.id and operator_id=op.id and environment='REAL') then
    raise exception 'COINOPS_PLAN_CREDENTIAL_GATE_DENIED';
  end if;
  if not exists(select 1 from coinops.account_execution_policies p where p.exchange_account_id=a.id and p.operator_id=op.id
    and p.status='ACTIVE' and p.contract='ENGINE_ISOLATION_V2' and p_shard_id=any(p.required_shards)
    and p.proofs ?& p.required_shards
    and not exists(select 1 from coinops.trading_engines e where e.exchange_account_id=a.id and e.environment='REAL'
      and not(e.executor_shard_id=any(p.required_shards)))) then
    raise exception 'COINOPS_ENGINE_ISOLATION_REQUIRED';
  end if;
  perform 1 from coinops.executor_shards where id=p_shard_id and enabled for update;
  if not found then raise exception 'COINOPS_CAPACITY_UNKNOWN'; end if;
  perform 1 from coinops.executor_admission_attestations where shard_id=p_shard_id for share;
  perform 1 from coinops.executor_admission_release where singleton for share;
  select array_agg(private.coinops_plan_slot_count(value)) into slot_counts from jsonb_array_elements(p_engines);
  admission:=coinops.preview_engine_slot_admission(p_shard_id,'REAL',slot_counts);
  if admission->>'code' is distinct from 'CAPACITY_OK' then
    raise exception '%',case when admission->>'reason'='SLOT_WORKLOAD_UNCERTIFIED' then 'COINOPS_SLOT_WORKLOAD_UNCERTIFIED'
      when admission->>'code'='CAPACITY_UNKNOWN' then 'COINOPS_CAPACITY_UNKNOWN' else 'COINOPS_CAPACITY_REQUIRED' end;
  end if;
  for item in select value from jsonb_array_elements(p_engines) loop
    if jsonb_typeof(item) is distinct from 'object' or not (item ?& array['asset','capital','gain','spacing','postAth','monthlyTarget'])
      or (select count(*) from jsonb_object_keys(item-'slotCount'))<>6 then raise exception 'COINOPS_PLAN_INPUT_DENIED'; end if;
    asset:=item->>'asset'; cap:=(item->>'capital')::numeric; gain:=(item->>'gain')::numeric;
    spacing:=(item->>'spacing')::numeric; post_ath:=(item->>'postAth')::numeric; target:=(item->>'monthlyTarget')::integer; slots:=private.coinops_plan_slot_count(item);
    if asset is null or asset not in ('BTC','SOL') or cap is null or cap<=0 or cap<>round(cap,2)
      or cap::text in ('NaN','Infinity','-Infinity') or cap*100<slots
      or gain is null or gain not between .001 and .2 or spacing is null or spacing not between .001 and .2
      or post_ath is null or post_ath not between .001 and .2 or target is null or target<1
      or (item->>'monthlyTarget')::numeric<>target then raise exception 'COINOPS_PLAN_RATE_INVALID'; end if;
    total:=total+cap;
  end loop;
  if total<>p_authorized_capital then raise exception 'COINOPS_PLAN_CAP_SUM_MISMATCH'; end if;
  select jsonb_object_agg(symbol,n) into symbol_counts from
    (select (value->>'asset')||p_quote_asset symbol,jsonb_agg(private.coinops_plan_slot_count(value)) n from jsonb_array_elements(p_engines) group by 1) counts;
  budget:=private.coinops_account_order_budget_gate(op.id,a.id,3*jsonb_array_length(p_engines),symbol_counts);
  if budget->>'code' is distinct from 'PASS' then
    raise exception '%',coalesce('COINOPS_'||(budget->>'code'),'COINOPS_ACCOUNT_ORDER_BUDGET_UNKNOWN');
  end if;
  select hard_cap_quote into old_cap from coinops.account_quote_caps where exchange_account_id=a.id and quote_asset=p_quote_asset for update;
  old_cap:=coalesce(old_cap,0);
  select * into allocation from coinops.account_engine_append_previews where exchange_account_id=a.id
    and operator_id=op.id and request_id=p_request_id for update;
  select coalesce(jsonb_agg(jsonb_build_object('id',e.id,'cap',e.hard_cap_quote,'shard',e.executor_shard_id) order by e.id),'[]')
    into inventory from coinops.trading_engines e where e.exchange_account_id=a.id and e.operator_id=op.id
      and e.environment='REAL' and e.quote_asset=p_quote_asset;
  if allocation.request_id is null or allocation.input is distinct from input
    or allocation.expected_account_cap<>old_cap or allocation.engine_inventory is distinct from inventory
    or allocation.observed_at<clock_timestamp()-interval '30 seconds' or allocation.observed_at>clock_timestamp()+interval '2 seconds'
    or allocation.available_capital<p_authorized_capital then
    raise exception 'COINOPS_ENGINE_APPEND_PREVIEW_EXPIRED';
  end if;
  insert into coinops.account_quote_caps(operator_id,exchange_account_id,quote_asset,hard_cap_quote)
    values(op.id,a.id,p_quote_asset,old_cap+total)
    on conflict(exchange_account_id,quote_asset) do update set hard_cap_quote=excluded.hard_cap_quote;
  for item in select value from jsonb_array_elements(p_engines) loop
    asset:=item->>'asset'; cap:=(item->>'capital')::numeric; gain:=(item->>'gain')::numeric;
    spacing:=(item->>'spacing')::numeric; post_ath:=(item->>'postAth')::numeric; target:=(item->>'monthlyTarget')::integer; slots:=private.coinops_plan_slot_count(item);
    insert into coinops.trading_engines(operator_id,exchange_account_id,environment,symbol,base_asset,quote_asset,
      ath_reference_symbol,status,kill_switch,legacy_compatible,hard_cap_quote,executor_shard_id,slot_count,config)
    values(op.id,a.id,'REAL',asset||p_quote_asset,asset,p_quote_asset,asset||p_quote_asset,'INACTIVE',true,false,cap,p_shard_id,slots,
      jsonb_build_object('slot_count',slots,'initial_slot_quote',cap/slots,'capital_quote',cap,'max_order_quote',cap,
        'gain_rate',gain,'normal_spacing_rate',spacing,'post_ath_spacing_rate',post_ath,'monthly_target',target)) returning id into eid;
    workload:=private.coinops_slot_workload_profile(p_shard_id,'REAL',slots);
    if workload->>'code' is distinct from 'SLOT_WORKLOAD_CERTIFIED' then raise exception 'COINOPS_SLOT_WORKLOAD_UNCERTIFIED'; end if;
    insert into coinops.executor_capacity_admissions(engine_id,shard_id,environment,reserved_weight,expires_at)
      values(eid,p_shard_id,'REAL',(coinops.executor_capacity_policy()->>'incremental_weight')::numeric*(workload->>'capacity_units')::integer,
        clock_timestamp()+interval '5 minutes');
    insert into coinops.robot_v1_ath_profiles(product_id,tenant_id,user_id,operator_id,exchange_account_id,trading_engine_id,
      environment,asset,quote_asset,config_version,gain_rate,normal_spacing_rate,post_ath_spacing_rate,regime)
    values(op.product_id,op.tenant_id,op.user_id,op.id,a.id,eid,'REAL',asset,p_quote_asset,1,gain,spacing,post_ath,'NORMAL');
    insert into coinops.robot_v1_live_preparations(product_id,tenant_id,user_id,operator_id,exchange_account_id,trading_engine_id,
      asset,symbol,quote_asset,slot_count,monthly_target,configured_live_capital_brl,max_order_notional_brl,max_total_exposure_brl,
      compounding_enabled,single_active_entry,initial_market_enabled,local_reentry_enabled,kill_switch,live_enabled)
    values(op.product_id,op.tenant_id,op.user_id,op.id,a.id,eid,asset,asset||p_quote_asset,p_quote_asset,slots,target,cap,cap,cap,true,true,true,true,true,false);
    insert into coinops.robot_v1_live_slot_accounts(product_id,tenant_id,user_id,operator_id,exchange_account_id,trading_engine_id,asset,quote_asset,slot_number)
    select op.product_id,op.tenant_id,op.user_id,op.id,a.id,eid,asset,p_quote_asset,n from generate_series(1,slots)n;
    result:=result||jsonb_build_array(jsonb_build_object('engineId',eid,'symbol',asset||p_quote_asset,'capital',cap,'slotCount',slots,'status','INACTIVE','environment','REAL','shardId',p_shard_id));
  end loop;
  insert into coinops.account_onboarding_checks(operator_id,exchange_account_id,check_key,status,evidence,created_by,idempotency_key)
  values(op.id,a.id,'ENGINE_APPEND','PASS',jsonb_build_object('input',input,'result',result,'previousAccountCap',old_cap,
    'accountCap',old_cap+total,'shardId',p_shard_id),op.user_id,'engine-append:'||p_request_id::text);
  return result;
end $function$
;

CREATE OR REPLACE FUNCTION coinops.apply_live_operator_adjustment(p_operator_id uuid, p_account_id uuid, p_created_by uuid, p_kind text, p_quote_asset text, p_origin_currency text, p_origin_amount numeric, p_amount_quote numeric, p_fx_rate numeric, p_fx_observed_at timestamp with time zone, p_evidence text, p_reason text, p_allocations jsonb, p_expected_account_cap numeric, p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_operator coinops.operators%rowtype;
  v_account coinops.exchange_accounts%rowtype;
  v_cap coinops.account_quote_caps%rowtype;
  v_batch coinops.robot_v1_live_adjustment_batches%rowtype;
  v_engine coinops.trading_engines%rowtype;
  v_run coinops.robot_v1_live_runs%rowtype;
  v_slot coinops.robot_v1_live_slots%rowtype;
  v_slot_account coinops.robot_v1_live_slot_accounts%rowtype;
  v_item jsonb;
  v_item_id uuid;
  v_number integer;
  v_delta numeric;
  v_units integer;
  v_total numeric := 0;
  v_engine_delta numeric;
  v_monthly integer;
  v_lifetime integer;
  v_period text := to_char(now() at time zone 'America/Campo_Grande','YYYY-MM');
  v_physical_slot_id text;
  v_fingerprint text;
  v_seen text[] := '{}';
begin
  if coalesce(nullif(current_setting('request.jwt.claim.role',true),''),auth.jwt()->>'role','') <> 'service_role'
    or p_operator_id is null or p_account_id is null or p_created_by is null or p_request_id is null
    or p_kind not in ('MANUAL_GAIN','CAPITAL') or p_quote_asset not in ('BRL','USDT')
    or p_origin_currency not in ('BRL','USDT') or p_amount_quote is null or p_origin_amount is null
    or p_expected_account_cap is null or length(btrim(coalesce(p_reason,''))) not between 3 and 160
    or jsonb_typeof(p_allocations)<>'array' or jsonb_array_length(p_allocations) not between 1 and 200 then
    raise exception 'COINOPS_LIVE_ADJUSTMENT_INPUT_DENIED';
  end if;
  if p_kind='MANUAL_GAIN' and (jsonb_array_length(p_allocations)<>1 or p_amount_quote<>0 or p_origin_amount<>0)
    or p_kind='CAPITAL' and (p_amount_quote<=0 or p_amount_quote<>round(p_amount_quote,2)
      or p_origin_amount<=0 or p_origin_amount<>round(p_origin_amount,2)) then
    raise exception 'COINOPS_LIVE_ADJUSTMENT_AMOUNT_DENIED';
  end if;
  if p_origin_currency=p_quote_asset then
    if p_origin_amount<>p_amount_quote or p_fx_rate is not null or p_fx_observed_at is not null then
      raise exception 'COINOPS_LIVE_ADJUSTMENT_FX_DENIED';
    end if;
  elsif p_kind<>'CAPITAL' or p_origin_currency<>'BRL' or p_quote_asset<>'USDT'
    or p_fx_rate is null or p_fx_rate<=0 or p_fx_observed_at is null
    or p_fx_observed_at<now()-interval '10 minutes' or p_fx_observed_at>now()+interval '10 seconds'
    or abs(p_origin_amount/p_amount_quote-p_fx_rate)>0.0001
    or length(btrim(coalesce(p_evidence,'')))<8 then
    raise exception 'COINOPS_LIVE_ADJUSTMENT_FX_EVIDENCE_REQUIRED';
  end if;
  v_fingerprint:=md5(jsonb_build_object('operator',p_operator_id,'account',p_account_id,
    'kind',p_kind,'quote',p_quote_asset,'origin',p_origin_currency,'originAmount',p_origin_amount,
    'amount',p_amount_quote,'fx',p_fx_rate,'fxAt',p_fx_observed_at,'evidence',p_evidence,
    'reason',btrim(p_reason),'allocations',p_allocations)::text);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_account_id::text,0));
  select * into v_batch from coinops.robot_v1_live_adjustment_batches
    where exchange_account_id=p_account_id and request_id=p_request_id;
  if v_batch.id is not null then
    if v_batch.request_fingerprint<>v_fingerprint then raise exception 'COINOPS_LIVE_ADJUSTMENT_REPLAY_CONFLICT'; end if;
    return jsonb_build_object('id',v_batch.id,'status','REPLAYED');
  end if;
  select * into v_operator from coinops.operators where id=p_operator_id for share;
  select * into v_account from coinops.exchange_accounts
    where id=p_account_id and operator_id=p_operator_id for share;
  select * into v_cap from coinops.account_quote_caps
    where exchange_account_id=p_account_id and operator_id=p_operator_id and quote_asset=p_quote_asset for update;
  if v_operator.id is null or v_operator.status<>'ACTIVE' or v_operator.user_id<>p_created_by
    or v_account.id is null or v_account.status<>'ACTIVE' or v_cap.exchange_account_id is null
    or v_cap.hard_cap_quote<>p_expected_account_cap then
    raise exception 'COINOPS_LIVE_ADJUSTMENT_SCOPE_DENIED';
  end if;
  insert into coinops.robot_v1_live_adjustment_batches
    (product_id,tenant_id,user_id,operator_id,exchange_account_id,request_id,request_fingerprint,
      kind,quote_asset,origin_currency,origin_amount,amount_quote,fx_rate,fx_observed_at,evidence,reason)
  values(v_operator.product_id,v_operator.tenant_id,v_operator.user_id,p_operator_id,p_account_id,
    p_request_id,v_fingerprint,p_kind,p_quote_asset,p_origin_currency,p_origin_amount,
    p_amount_quote,p_fx_rate,p_fx_observed_at,nullif(btrim(coalesce(p_evidence,'')),''),btrim(p_reason))
  returning * into v_batch;
  for v_item in select value from jsonb_array_elements(p_allocations) loop
    if jsonb_typeof(v_item)<>'object' or not (v_item ?& array['engineId','slotNumber','amount','gainUnits','balanceBefore','operationSequence','monthlyBefore','lifetimeBefore'])
      or (select count(*) from jsonb_object_keys(v_item))<>8 then
      raise exception 'COINOPS_LIVE_ADJUSTMENT_ITEM_DENIED';
    end if;
    select * into v_engine from coinops.trading_engines
      where id=(v_item->>'engineId')::uuid and exchange_account_id=p_account_id
        and operator_id=p_operator_id and environment='REAL' and quote_asset=p_quote_asset for update;
    v_number:=(v_item->>'slotNumber')::integer;
    v_delta:=(v_item->>'amount')::numeric;
    v_units:=(v_item->>'gainUnits')::integer;
    if v_engine.id is null or v_engine.status<>'ACTIVE' or v_number not between 1 and v_engine.slot_count
      or (v_engine.id::text||':'||v_number::text)=any(v_seen)
      or v_delta is null or v_units is null or v_delta<>round(v_delta,2)
      or p_kind='CAPITAL' and (v_delta<=0 or v_units<>0)
      or p_kind='MANUAL_GAIN' and (v_delta<>0 or v_units not between 1 and 25) then
      raise exception 'COINOPS_LIVE_ADJUSTMENT_ITEM_DENIED';
    end if;
    v_seen:=array_append(v_seen,v_engine.id::text||':'||v_number::text);
    v_physical_slot_id:=case when v_engine.legacy_compatible then
      'REAL:'||v_operator.product_id::text||':'||v_operator.tenant_id::text||':'||
        v_operator.user_id::text||':'||v_engine.base_asset||':'||v_number::text
      else 'REAL:'||v_engine.id::text||':'||v_number::text end;
    select * into v_run from coinops.robot_v1_live_runs
      where trading_engine_id=v_engine.id and status in ('ACTIVE','PAUSED') for update;
    if v_run.id is null or v_run.lease_until>now() then raise exception 'COINOPS_LIVE_ADJUSTMENT_ENGINE_BUSY'; end if;
    select * into v_slot from coinops.robot_v1_live_slots
      where run_id=v_run.id and trading_engine_id=v_engine.id and slot_number=v_number for share;
    select * into v_slot_account from coinops.robot_v1_live_slot_accounts
      where trading_engine_id=v_engine.id and slot_number=v_number for update;
    if v_slot.id is null or v_slot_account.trading_engine_id is null
      or v_slot_account.balance_brl<>(v_item->>'balanceBefore')::numeric
      or v_slot.operation_sequence<>(v_item->>'operationSequence')::integer then
      raise exception 'COINOPS_LIVE_ADJUSTMENT_PREVIEW_STALE';
    end if;
    if exists(select 1 from coinops.robot_v1_monthly_slot_gains
      where trading_engine_id=v_engine.id and environment='REAL' and slot_number=v_number
        and physical_slot_id<>v_physical_slot_id) then
      raise exception 'COINOPS_LIVE_ADJUSTMENT_PHYSICAL_SLOT_MISMATCH';
    end if;
    select coalesce(sum(gain_units),0)::integer,
      coalesce(sum(gain_units) filter(where period_key=v_period),0)::integer
      into v_lifetime,v_monthly from coinops.robot_v1_monthly_slot_gains
      where trading_engine_id=v_engine.id and environment='REAL' and slot_number=v_number;
    if v_lifetime<>(v_item->>'lifetimeBefore')::integer
      or v_monthly<>(v_item->>'monthlyBefore')::integer then
      raise exception 'COINOPS_LIVE_ADJUSTMENT_PREVIEW_STALE';
    end if;
    insert into coinops.robot_v1_live_adjustment_items
      (batch_id,product_id,tenant_id,user_id,operator_id,exchange_account_id,trading_engine_id,
        symbol,quote_asset,slot_number,physical_slot_id,amount_quote,gain_units,balance_before,balance_after,
        monthly_before,monthly_after,lifetime_before,lifetime_after,open_at_time,position_committed_quote,
        operation_sequence,period_key)
    values(v_batch.id,v_operator.product_id,v_operator.tenant_id,v_operator.user_id,p_operator_id,
      p_account_id,v_engine.id,v_engine.symbol,p_quote_asset,v_number,
      v_physical_slot_id,v_delta,v_units,
      v_slot_account.balance_brl,v_slot_account.balance_brl+v_delta,
      v_monthly,v_monthly+v_units,v_lifetime,v_lifetime+v_units,
      v_slot.entry_state='OPEN',v_slot.position_committed_brl,v_slot.operation_sequence,v_period)
    returning id into v_item_id;
    update coinops.robot_v1_live_slot_accounts set balance_brl=balance_brl+v_delta,
      contribution_brl=contribution_brl+v_delta,gain_count=gain_count+v_units
      where trading_engine_id=v_engine.id and slot_number=v_number;
    if v_units>0 then
      insert into coinops.robot_v1_monthly_slot_gains
        (environment,source_id,product_id,tenant_id,user_id,operator_id,exchange_account_id,
          trading_engine_id,quote_asset,asset,slot_number,physical_slot_id,
          credited_at,effective_gain_at,evidence_basis,period_key,gain_units)
      values('REAL',v_item_id,v_operator.product_id,v_operator.tenant_id,v_operator.user_id,
        p_operator_id,p_account_id,v_engine.id,p_quote_asset,v_engine.base_asset,v_number,
        v_physical_slot_id,
        now(),now(),'MANUAL_TARGET_GAIN',v_period,v_units);
    end if;
    v_total:=v_total+v_delta;
  end loop;
  if v_total<>p_amount_quote then raise exception 'COINOPS_LIVE_ADJUSTMENT_SUM_MISMATCH'; end if;
  if p_kind='CAPITAL' then
    for v_engine in select * from coinops.trading_engines
      where id in (select distinct trading_engine_id from coinops.robot_v1_live_adjustment_items where batch_id=v_batch.id)
      order by id for update loop
      select sum(amount_quote) into v_engine_delta from coinops.robot_v1_live_adjustment_items
        where batch_id=v_batch.id and trading_engine_id=v_engine.id;
      if v_account.is_legacy_default and
        v_engine.hard_cap_quote+v_engine_delta>(case v_engine.base_asset when 'BTC' then 450 else 275 end) then
        raise exception 'COINOPS_LIVE_ADJUSTMENT_LEGACY_CAP_DENIED';
      end if;
      update coinops.trading_engines set hard_cap_quote=hard_cap_quote+v_engine_delta where id=v_engine.id;
      update coinops.robot_v1_live_preparations set
        configured_live_capital_brl=configured_live_capital_brl+v_engine_delta,
        max_order_notional_brl=max_order_notional_brl+v_engine_delta,
        max_total_exposure_brl=max_total_exposure_brl+v_engine_delta,
        config_version=config_version+1
        where trading_engine_id=v_engine.id;
      if not found then raise exception 'COINOPS_LIVE_ADJUSTMENT_PREPARATION_MISSING'; end if;
    end loop;
    if v_account.is_legacy_default and v_cap.hard_cap_quote+p_amount_quote>725 then
      raise exception 'COINOPS_LIVE_ADJUSTMENT_LEGACY_CAP_DENIED';
    end if;
    update coinops.account_quote_caps set hard_cap_quote=hard_cap_quote+p_amount_quote,
      updated_at=now() where exchange_account_id=p_account_id and quote_asset=p_quote_asset;
  end if;
  return jsonb_build_object('id',v_batch.id,'status','APPLIED','amount_quote',p_amount_quote,
    'item_count',jsonb_array_length(p_allocations));
end $function$
;

CREATE OR REPLACE FUNCTION coinops.apply_live_selective_contribution(p_operator_id uuid, p_account_id uuid, p_engine_id uuid, p_created_by uuid, p_quote_asset text, p_origin_currency text, p_origin_amount numeric, p_amount_quote numeric, p_evidence text, p_reason text, p_allocations jsonb, p_expected_account_cap numeric, p_request_id uuid, p_request_fingerprint text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_operator coinops.operators%rowtype;
  v_account coinops.exchange_accounts%rowtype;
  v_engine coinops.trading_engines%rowtype;
  v_cap coinops.account_quote_caps%rowtype;
  v_batch coinops.robot_v1_live_selective_contribution_batches%rowtype;
  v_run coinops.robot_v1_live_runs%rowtype;
  v_slot coinops.robot_v1_live_slots%rowtype;
  v_slot_account coinops.robot_v1_live_slot_accounts%rowtype;
  v_item jsonb;
  v_number integer;
  v_amount numeric;
  v_total numeric:=0;
  v_pending integer:=0;
  v_applied integer:=0;
  v_seen integer[]:='{}';
begin
  if coalesce(nullif(current_setting('request.jwt.claim.role',true),''),auth.jwt()->>'role','')<>'service_role'
    or p_operator_id is null or p_account_id is null or p_engine_id is null or p_created_by is null
    or p_request_id is null or p_quote_asset not in ('BRL','USDT')
    or p_origin_currency not in ('BRL','USDT') or p_origin_amount is null or p_origin_amount<=0
    or p_amount_quote is null or p_amount_quote<=0 or p_amount_quote<>round(p_amount_quote,2)
    or p_expected_account_cap is null or length(btrim(coalesce(p_reason,''))) not between 3 and 160
    or p_request_fingerprint !~ '^[a-f0-9]{64}$'
    or jsonb_typeof(p_allocations)<>'array' or jsonb_array_length(p_allocations) not between 1 and 100 then
    raise exception 'COINOPS_SELECTIVE_CONTRIBUTION_INPUT_DENIED';
  end if;
  -- Serialize the natural idempotency key before the first lookup. Concurrent
  -- double-clicks therefore converge to the committed batch instead of racing
  -- the unique constraint or applying the cap twice.
  perform pg_advisory_xact_lock(hashtextextended(p_account_id::text||':'||p_request_id::text,0));
  select * into v_batch from coinops.robot_v1_live_selective_contribution_batches
    where exchange_account_id=p_account_id and request_id=p_request_id;
  if v_batch.id is not null then
    if v_batch.request_fingerprint<>p_request_fingerprint then
      raise exception 'COINOPS_SELECTIVE_CONTRIBUTION_REPLAY_CONFLICT';
    end if;
    return jsonb_build_object('id',v_batch.id,'status','REPLAYED','amount_quote',v_batch.amount_quote,
      'item_count',(select count(*) from coinops.robot_v1_live_selective_contribution_allocations where batch_id=v_batch.id),
      'pending_count',(select count(*) from coinops.robot_v1_live_selective_contribution_allocations where batch_id=v_batch.id and status='PENDING'));
  end if;
  select * into v_operator from coinops.operators where id=p_operator_id for share;
  select * into v_account from coinops.exchange_accounts
    where id=p_account_id and operator_id=p_operator_id for share;
  select * into v_engine from coinops.trading_engines
    where id=p_engine_id and operator_id=p_operator_id and exchange_account_id=p_account_id
      and environment='REAL' and quote_asset=p_quote_asset for update;
  select * into v_cap from coinops.account_quote_caps
    where exchange_account_id=p_account_id and operator_id=p_operator_id and quote_asset=p_quote_asset for update;
  select * into v_run from coinops.robot_v1_live_runs
    where trading_engine_id=p_engine_id and status in ('ACTIVE','PAUSED') for update;
  if v_operator.id is null or v_operator.status<>'ACTIVE' or v_operator.user_id<>p_created_by
    or v_account.id is null or v_account.status<>'ACTIVE'
    or v_engine.id is null or v_engine.status<>'ACTIVE' or v_engine.kill_switch
    or v_cap.exchange_account_id is null or v_cap.hard_cap_quote<>p_expected_account_cap
    or v_run.id is null or v_run.lease_until>now() then
    raise exception 'COINOPS_SELECTIVE_CONTRIBUTION_SCOPE_DENIED';
  end if;
  insert into coinops.robot_v1_live_selective_contribution_batches
    (product_id,tenant_id,user_id,operator_id,exchange_account_id,trading_engine_id,
      request_id,request_fingerprint,quote_asset,origin_currency,origin_amount,
      amount_quote,evidence,reason)
  values(v_operator.product_id,v_operator.tenant_id,v_operator.user_id,p_operator_id,p_account_id,
    p_engine_id,p_request_id,p_request_fingerprint,p_quote_asset,p_origin_currency,p_origin_amount,
    p_amount_quote,nullif(btrim(coalesce(p_evidence,'')),''),btrim(p_reason)) returning * into v_batch;
  for v_item in select value from jsonb_array_elements(p_allocations) loop
    if jsonb_typeof(v_item)<>'object'
      or not (v_item ?& array['engineId','slotNumber','amount','balanceBefore','operationSequence'])
      or (select count(*) from jsonb_object_keys(v_item))<>5
      or (v_item->>'engineId')::uuid<>p_engine_id then
      raise exception 'COINOPS_SELECTIVE_CONTRIBUTION_ITEM_DENIED';
    end if;
    v_number:=(v_item->>'slotNumber')::integer;
    v_amount:=(v_item->>'amount')::numeric;
    if v_number not between 1 and v_engine.slot_count or v_number=any(v_seen)
      or v_amount is null or v_amount<=0 or v_amount<>round(v_amount,2) then
      raise exception 'COINOPS_SELECTIVE_CONTRIBUTION_ITEM_DENIED';
    end if;
    v_seen:=array_append(v_seen,v_number);
    select * into v_slot from coinops.robot_v1_live_slots
      where run_id=v_run.id and trading_engine_id=p_engine_id and slot_number=v_number for share;
    select * into v_slot_account from coinops.robot_v1_live_slot_accounts
      where trading_engine_id=p_engine_id and slot_number=v_number for update;
    if v_slot.id is null or v_slot_account.trading_engine_id is null
      or v_slot_account.balance_brl<>(v_item->>'balanceBefore')::numeric
      or v_slot.operation_sequence<>(v_item->>'operationSequence')::integer then
      raise exception 'COINOPS_SELECTIVE_CONTRIBUTION_PREVIEW_STALE';
    end if;
    insert into coinops.robot_v1_live_selective_contribution_allocations
      (batch_id,product_id,tenant_id,user_id,operator_id,exchange_account_id,trading_engine_id,
        symbol,quote_asset,slot_number,amount_quote,status,slot_state_at_creation,
        operation_sequence_at_creation,balance_before,applied_at,applied_operation_sequence)
    values(v_batch.id,v_operator.product_id,v_operator.tenant_id,v_operator.user_id,p_operator_id,
      p_account_id,p_engine_id,v_engine.symbol,p_quote_asset,v_number,v_amount,
      case when v_slot.entry_state='OPEN' then 'PENDING' else 'APPLIED' end,v_slot.entry_state,
      v_slot.operation_sequence,v_slot_account.balance_brl,
      case when v_slot.entry_state='OPEN' then null else now() end,
      case when v_slot.entry_state='OPEN' then null else v_slot.operation_sequence end);
    if v_slot.entry_state='OPEN' then v_pending:=v_pending+1;
    else
      update coinops.robot_v1_live_slot_accounts set
        balance_brl=balance_brl+v_amount,contribution_brl=contribution_brl+v_amount
        where trading_engine_id=p_engine_id and slot_number=v_number;
      v_applied:=v_applied+1;
    end if;
    v_total:=v_total+v_amount;
  end loop;
  if v_total<>p_amount_quote then raise exception 'COINOPS_SELECTIVE_CONTRIBUTION_SUM_MISMATCH'; end if;
  update coinops.trading_engines set hard_cap_quote=hard_cap_quote+p_amount_quote where id=p_engine_id;
  update coinops.robot_v1_live_preparations set
    configured_live_capital_brl=configured_live_capital_brl+p_amount_quote,
    max_order_notional_brl=max_order_notional_brl+p_amount_quote,
    max_total_exposure_brl=max_total_exposure_brl+p_amount_quote,config_version=config_version+1
    where trading_engine_id=p_engine_id;
  if not found then raise exception 'COINOPS_SELECTIVE_CONTRIBUTION_PREPARATION_MISSING'; end if;
  update coinops.account_quote_caps set hard_cap_quote=hard_cap_quote+p_amount_quote,updated_at=now()
    where exchange_account_id=p_account_id and quote_asset=p_quote_asset;
  return jsonb_build_object('id',v_batch.id,'status','APPLIED','amount_quote',p_amount_quote,
    'item_count',jsonb_array_length(p_allocations),'pending_count',v_pending,'applied_count',v_applied);
end $function$
;

CREATE OR REPLACE FUNCTION coinops.manage_live_selective_contribution_preset(p_operator_id uuid, p_actor_id uuid, p_action text, p_preset_id uuid, p_name text, p_total_slots integer, p_open_slots integer, p_following_slots integer, p_enabled boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_operator coinops.operators%rowtype;
  v_preset coinops.robot_v1_live_selective_contribution_presets%rowtype;
begin
  if coalesce(nullif(current_setting('request.jwt.claim.role',true),''),auth.jwt()->>'role','')<>'service_role'
    or p_operator_id is null or p_actor_id is null
    or p_action not in ('CREATE','UPDATE','TOGGLE','DELETE') then
    raise exception 'COINOPS_SELECTIVE_PRESET_INPUT_DENIED';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_operator_id::text||':selective-presets',0));
  select * into v_operator from coinops.operators
    where id=p_operator_id and status='ACTIVE' and user_id=p_actor_id for share;
  if v_operator.id is null then raise exception 'COINOPS_SELECTIVE_PRESET_SCOPE_DENIED'; end if;
  if p_action='CREATE' then
    if p_preset_id is not null or length(btrim(coalesce(p_name,''))) not between 3 and 80
      or p_total_slots not between 1 and 100 or p_open_slots not between 1 and 100
      or p_following_slots not between 0 and 99
      or p_total_slots<>p_open_slots+p_following_slots then
      raise exception 'COINOPS_SELECTIVE_PRESET_CONFIGURATION_INVALID';
    end if;
    insert into coinops.robot_v1_live_selective_contribution_presets
      (product_id,tenant_id,user_id,operator_id,name,total_slots,open_slots,following_slots,created_by)
    values(v_operator.product_id,v_operator.tenant_id,v_operator.user_id,v_operator.id,btrim(p_name),
      p_total_slots,p_open_slots,p_following_slots,p_actor_id) returning * into v_preset;
  else
    select * into v_preset from coinops.robot_v1_live_selective_contribution_presets
      where id=p_preset_id and operator_id=p_operator_id for update;
    if v_preset.id is null then raise exception 'COINOPS_SELECTIVE_PRESET_NOT_FOUND'; end if;
    if p_action='UPDATE' then
      if length(btrim(coalesce(p_name,''))) not between 3 and 80
        or p_total_slots not between 1 and 100 or p_open_slots not between 1 and 100
        or p_following_slots not between 0 and 99
        or p_total_slots<>p_open_slots+p_following_slots then
        raise exception 'COINOPS_SELECTIVE_PRESET_CONFIGURATION_INVALID';
      end if;
      update coinops.robot_v1_live_selective_contribution_presets set
        name=btrim(p_name),total_slots=p_total_slots,open_slots=p_open_slots,
        following_slots=p_following_slots where id=v_preset.id returning * into v_preset;
    elsif p_action='TOGGLE' then
      if p_enabled is null then raise exception 'COINOPS_SELECTIVE_PRESET_INPUT_DENIED'; end if;
      update coinops.robot_v1_live_selective_contribution_presets
        set status=case when p_enabled then 'ACTIVE' else 'DISABLED' end
        where id=v_preset.id returning * into v_preset;
    else
      if v_preset.built_in or v_preset.usage_count>0 then
        update coinops.robot_v1_live_selective_contribution_presets set status='DISABLED'
          where id=v_preset.id returning * into v_preset;
        return jsonb_build_object('id',v_preset.id,'status','DISABLED_USED','deleted',false);
      end if;
      delete from coinops.robot_v1_live_selective_contribution_presets where id=v_preset.id;
      return jsonb_build_object('id',v_preset.id,'status','DELETED','deleted',true);
    end if;
  end if;
  return jsonb_build_object('id',v_preset.id,'status',v_preset.status,'deleted',false);
exception when unique_violation then
  raise exception 'COINOPS_SELECTIVE_PRESET_NAME_CONFLICT';
end $function$
;

CREATE OR REPLACE FUNCTION coinops.mark_live_selective_contribution_preset_usage(p_operator_id uuid, p_actor_id uuid, p_preset_id uuid, p_engine_id uuid, p_request_id uuid, p_anchor_slot_number integer, p_resolved_slot_numbers integer[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_operator coinops.operators%rowtype;
  v_preset coinops.robot_v1_live_selective_contribution_presets%rowtype;
  v_usage coinops.robot_v1_live_selective_contribution_preset_usages%rowtype;
begin
  if coalesce(nullif(current_setting('request.jwt.claim.role',true),''),auth.jwt()->>'role','')<>'service_role'
    or p_request_id is null or p_anchor_slot_number not between 1 and 100
    or cardinality(p_resolved_slot_numbers) not between 1 and 100
    or cardinality(p_resolved_slot_numbers)<>cardinality(array(select distinct unnest(p_resolved_slot_numbers)))
    or not (p_anchor_slot_number=any(p_resolved_slot_numbers)) then
    raise exception 'COINOPS_SELECTIVE_PRESET_USAGE_DENIED';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_operator_id::text||':'||p_request_id::text,0));
  select * into v_usage from coinops.robot_v1_live_selective_contribution_preset_usages
    where operator_id=p_operator_id and request_id=p_request_id;
  if v_usage.id is not null then
    if v_usage.preset_id<>p_preset_id or v_usage.trading_engine_id<>p_engine_id
      or v_usage.anchor_slot_number<>p_anchor_slot_number
      or v_usage.resolved_slot_numbers<>p_resolved_slot_numbers then
      raise exception 'COINOPS_SELECTIVE_PRESET_USAGE_REPLAY_CONFLICT';
    end if;
    return jsonb_build_object('id',v_usage.id,'status','REPLAYED');
  end if;
  select * into v_operator from coinops.operators
    where id=p_operator_id and status='ACTIVE' and user_id=p_actor_id for share;
  select * into v_preset from coinops.robot_v1_live_selective_contribution_presets
    where id=p_preset_id and operator_id=p_operator_id and status='ACTIVE' for update;
  if v_operator.id is null or v_preset.id is null
    or v_preset.total_slots<>cardinality(p_resolved_slot_numbers)
    or not exists(select 1 from coinops.trading_engines where id=p_engine_id
      and operator_id=p_operator_id and environment='REAL' and status='ACTIVE'
        and p_anchor_slot_number between 1 and slot_count
        and not exists(select 1 from unnest(p_resolved_slot_numbers) n where n is null or n not between 1 and slot_count)) then
    raise exception 'COINOPS_SELECTIVE_PRESET_USAGE_DENIED';
  end if;
  insert into coinops.robot_v1_live_selective_contribution_preset_usages
    (product_id,tenant_id,user_id,operator_id,preset_id,trading_engine_id,request_id,
      anchor_slot_number,resolved_slot_numbers)
  values(v_operator.product_id,v_operator.tenant_id,v_operator.user_id,p_operator_id,p_preset_id,
    p_engine_id,p_request_id,p_anchor_slot_number,p_resolved_slot_numbers) returning * into v_usage;
  update coinops.robot_v1_live_selective_contribution_presets
    set usage_count=usage_count+1 where id=p_preset_id;
  return jsonb_build_object('id',v_usage.id,'status','RECORDED');
end $function$
;

CREATE OR REPLACE FUNCTION coinops.prepare_robot_v1_live_order(p_run_id uuid, p_slot_id uuid, p_side text, p_purpose text, p_revision integer, p_client_order_id text, p_quantity numeric, p_quote numeric, p_price numeric, p_decision_id text, p_lease_owner uuid)
 RETURNS coinops.robot_v1_live_orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_run coinops.robot_v1_live_runs%rowtype;
  v_slot coinops.robot_v1_live_slots%rowtype;
  v_config coinops.robot_v1_live_preparations%rowtype;
  v_global coinops.account_quote_caps%rowtype;
  v_engine coinops.trading_engines%rowtype;
  v_existing coinops.robot_v1_live_orders%rowtype;
  v_order coinops.robot_v1_live_orders%rowtype;
  v_notional numeric;
  v_asset_exposure numeric;
  v_global_exposure numeric;
  v_accounts integer;
  v_account_balance numeric;
begin
  select * into strict v_run from coinops.robot_v1_live_runs where id=p_run_id for update;
  if (v_run.status <> 'ACTIVE' and not (p_side='SELL' and v_run.status='PAUSED'))
    or p_lease_owner is null
    or v_run.lease_owner is distinct from p_lease_owner
    or v_run.lease_until is null or v_run.lease_until <= now()
    or (v_run.last_error is not null and p_side='BUY') then
    raise exception 'COINOPS_LIVE_LEASE_OR_RUN_BLOCKED';
  end if;
  select * into strict v_engine from coinops.trading_engines where id=v_run.trading_engine_id for share;
  select * into strict v_global from coinops.account_quote_caps
    where exchange_account_id=v_run.exchange_account_id and quote_asset=v_run.quote_asset for update;
  select * into strict v_config from coinops.robot_v1_live_preparations
    where product_id=v_run.product_id and tenant_id=v_run.tenant_id
      and user_id=v_run.user_id and trading_engine_id=v_run.trading_engine_id and asset=v_run.asset for update;
  select * into strict v_slot from coinops.robot_v1_live_slots
    where id=p_slot_id and run_id=p_run_id and product_id=v_run.product_id
      and tenant_id=v_run.tenant_id and user_id=v_run.user_id for update;
  if v_config.symbol<>v_run.symbol or (v_config.slot_count<>v_engine.slot_count or v_run.slot_count<>v_engine.slot_count)
    or v_config.configured_live_capital_brl > v_engine.hard_cap_quote
    or v_config.max_order_notional_brl > v_engine.hard_cap_quote
    or v_config.max_total_exposure_brl > v_engine.hard_cap_quote
    or v_engine.hard_cap_quote > v_global.hard_cap_quote then
    raise exception 'COINOPS_LIVE_HARD_CAP_INVALID';
  end if;
  select * into v_existing from coinops.robot_v1_live_orders where client_order_id=p_client_order_id;
  if found then
    if (v_existing.run_id,v_existing.slot_id,v_existing.side,v_existing.purpose,
      v_existing.revision,v_existing.requested_quantity,v_existing.requested_quote,
      v_existing.price,v_existing.strategy_decision_id)
      is distinct from (p_run_id,p_slot_id,p_side,p_purpose,p_revision,p_quantity,
        p_quote,p_price,p_decision_id) then
      raise exception 'COINOPS_LIVE_ORDER_IDENTITY_COLLISION';
    end if;
    return v_existing;
  end if;
  if p_revision < 1 or (case when v_engine.legacy_compatible then p_client_order_id !~ ('^COR1-'||v_run.asset||'-'||v_slot.slot_number||'-'||p_revision||'-'||p_side||'-[a-f0-9]{14}$') else p_client_order_id !~ ('^C2-'||substr(encode(sha256(convert_to(v_run.exchange_account_id::text||'|'||v_run.trading_engine_id::text,'UTF8')),'hex'),1,10)||'-'||v_slot.slot_number||'-'||substr(p_side,1,1)||'-[a-f0-9]{14}$') end)
    or p_decision_id !~ '^[a-f0-9]{64}$' or not exists
      (select 1 from coinops.robot_v1_strategy_decisions d where d.environment='REAL'
        and d.cycle_id=p_run_id and d.slot_id=p_slot_id and d.decision_id=p_decision_id
        and d.product_id=v_run.product_id and d.tenant_id=v_run.tenant_id and d.user_id=v_run.user_id)
    or (p_side,p_purpose) not in (('BUY','INITIAL'),('BUY','ENTRY'),('SELL','TP')) then
    raise exception 'COINOPS_LIVE_ORDER_INTENT_INVALID';
  end if;
  if p_purpose='INITIAL' then
    if p_quote is null or p_quote<=0 or p_quantity is not null or p_price is not null
      or v_slot.operation_sequence<>1 or v_slot.operational_rank<>1 then
      raise exception 'COINOPS_LIVE_INITIAL_INTENT_INVALID';
    end if;
    v_notional:=p_quote;
  else
    if p_quantity is null or p_quantity<=0 or p_quote is not null or p_price is null or p_price<=0 then
      raise exception 'COINOPS_LIVE_LIMIT_INTENT_INVALID';
    end if;
    v_notional:=round(p_quantity*p_price,8);
  end if;
  if p_side='BUY' then
    if v_engine.status<>'ACTIVE' or v_engine.kill_switch
      or exists(select 1 from coinops.exchange_accounts a where a.id=v_run.exchange_account_id and (a.status<>'ACTIVE' or a.kill_switch))
      or exists(select 1 from coinops.operators o where o.id=v_run.operator_id and (o.status<>'ACTIVE' or o.kill_switch)) then
      raise exception 'COINOPS_ENGINE_NEW_WRITES_BLOCKED'; end if;
    if not v_config.live_enabled or v_config.kill_switch or v_slot.entry_state<>'PLANNED'
      or v_notional > v_config.max_order_notional_brl
      or exists (select 1 from coinops.robot_v1_live_orders o where o.run_id=p_run_id
        and o.side='BUY' and o.status in ('PREPARED','NEW','PARTIALLY_FILLED')) then
      raise exception 'COINOPS_LIVE_NEW_BUY_BLOCKED';
    end if;
    select count(*),coalesce(sum(contribution_brl),0) into v_accounts,v_account_balance
      from coinops.robot_v1_live_slot_accounts a where a.product_id=v_run.product_id
        and a.tenant_id=v_run.tenant_id and a.user_id=v_run.user_id and a.trading_engine_id=v_run.trading_engine_id and a.asset=v_run.asset;
    if v_accounts<>v_engine.slot_count or v_account_balance>v_config.configured_live_capital_brl
      or v_account_balance<=0 or v_notional>
        (select balance_brl from coinops.robot_v1_live_slot_accounts a
          where a.product_id=v_run.product_id and a.tenant_id=v_run.tenant_id
            and a.user_id=v_run.user_id and a.trading_engine_id=v_run.trading_engine_id and a.asset=v_run.asset and a.slot_number=v_slot.slot_number)
      then raise exception 'COINOPS_LIVE_SLOT_CAPITAL_INVALID';
    end if;
    select coalesce(sum(s.position_committed_brl),0) into v_asset_exposure
      from coinops.robot_v1_live_slots s join coinops.robot_v1_live_runs r on r.id=s.run_id
      where r.product_id=v_run.product_id and r.tenant_id=v_run.tenant_id
        and r.user_id=v_run.user_id and r.trading_engine_id=v_run.trading_engine_id and r.asset=v_run.asset and r.status in ('ACTIVE','PAUSED');
    select v_asset_exposure+coalesce(sum(greatest(o.reserved_notional_brl-o.cumulative_quote,0)),0)
      into v_asset_exposure from coinops.robot_v1_live_orders o
      join coinops.robot_v1_live_runs r on r.id=o.run_id
      where r.product_id=v_run.product_id and r.tenant_id=v_run.tenant_id
        and r.user_id=v_run.user_id and r.trading_engine_id=v_run.trading_engine_id and r.asset=v_run.asset and r.status in ('ACTIVE','PAUSED')
        and o.side='BUY' and o.status in ('PREPARED','NEW','PARTIALLY_FILLED');
    select coalesce(sum(s.position_committed_brl),0) into v_global_exposure
      from coinops.robot_v1_live_slots s join coinops.robot_v1_live_runs r on r.id=s.run_id
      where r.product_id=v_run.product_id and r.tenant_id=v_run.tenant_id
        and r.user_id=v_run.user_id and r.exchange_account_id=v_run.exchange_account_id and r.quote_asset=v_run.quote_asset and r.status in ('ACTIVE','PAUSED');
    select v_global_exposure+coalesce(sum(greatest(o.reserved_notional_brl-o.cumulative_quote,0)),0)
      into v_global_exposure from coinops.robot_v1_live_orders o
      join coinops.robot_v1_live_runs r on r.id=o.run_id
      where r.product_id=v_run.product_id and r.tenant_id=v_run.tenant_id
        and r.user_id=v_run.user_id and r.exchange_account_id=v_run.exchange_account_id and r.quote_asset=v_run.quote_asset and r.status in ('ACTIVE','PAUSED')
        and o.side='BUY' and o.status in ('PREPARED','NEW','PARTIALLY_FILLED');
    if v_asset_exposure+v_notional>v_config.max_total_exposure_brl
      or v_global_exposure+v_notional>v_global.hard_cap_quote then
      raise exception 'COINOPS_LIVE_EXPOSURE_CAP_DENIED';
    end if;
  elsif v_slot.position_quantity<=0 or p_quantity>v_slot.position_quantity
    or v_slot.entry_state<>'OPEN' then
    raise exception 'COINOPS_LIVE_TP_POSITION_UNVERIFIED';
  end if;
  insert into coinops.robot_v1_live_orders
    (run_id,slot_id,product_id,tenant_id,user_id,slot_number,operation_sequence,
      side,purpose,revision,client_order_id,requested_quantity,requested_quote,price,
      reserved_notional_brl,strategy_decision_id,config_version,config_snapshot)
  values (v_run.id,v_slot.id,v_run.product_id,v_run.tenant_id,v_run.user_id,v_slot.slot_number,
    v_slot.operation_sequence,p_side,p_purpose,p_revision,p_client_order_id,p_quantity,p_quote,p_price,
    case when p_side='BUY' then v_notional else 0 end,p_decision_id,
    v_run.config_version,v_run.config_snapshot) returning * into v_order;
  return v_order;
end $function$
;

CREATE OR REPLACE FUNCTION coinops.restart_robot_v1_live_cycle(p_old_run_id uuid, p_reset_key text, p_anchor_price numeric, p_gain_rate numeric, p_entry_spacing numeric, p_regime text, p_config_version integer, p_config_snapshot jsonb, p_transition_key text, p_period_key text, p_plans jsonb, p_lease_owner uuid)
 RETURNS coinops.robot_v1_live_runs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_old coinops.robot_v1_live_runs%rowtype;
  v_new coinops.robot_v1_live_runs%rowtype;
  v_config coinops.robot_v1_live_preparations%rowtype;
  v_count integer;
  v_total numeric;
  v_number integer;
  v_plan jsonb;
  v_rank integer;
  v_price numeric;
  v_group text;
  v_group_rank integer;
  v_ranks integer[]:='{}';
begin
  select * into strict v_old from coinops.robot_v1_live_runs
    where id=p_old_run_id for update;
  select * into v_new from coinops.robot_v1_live_runs
    where previous_run_id=p_old_run_id;
  if found then
    if v_new.reset_idempotency_key is distinct from p_reset_key then
      raise exception 'COINOPS_LIVE_RESET_IDEMPOTENCY_CONFLICT';
    end if;
    return v_new;
  end if;
  select * into strict v_config from coinops.robot_v1_live_preparations
    where product_id=v_old.product_id and tenant_id=v_old.tenant_id
      and user_id=v_old.user_id and trading_engine_id=v_old.trading_engine_id and asset=v_old.asset for update;
  -- A prior error/kill switch blocks exchange BUYs, not recovery of a closed
  -- cycle in the ledger. Reconciliation and the operator-controlled resume
  -- must still pass before any next MARKET is dispatched.
  if v_old.status<>'ACTIVE'
    or p_lease_owner is null or v_old.lease_owner is distinct from p_lease_owner
    or v_old.lease_until is null or v_old.lease_until<=now()
    or not v_config.live_enabled
    or p_reset_key is null or length(p_reset_key)<16
    or p_anchor_price is null or p_anchor_price<=0
    or p_gain_rate is null or p_gain_rate<0.001 or p_gain_rate>0.2
    or p_entry_spacing is null or p_entry_spacing<0.001 or p_entry_spacing>0.2
    or p_regime not in ('NORMAL','POST_ATH')
    or p_config_version is null or p_config_version<1
    or jsonb_typeof(p_config_snapshot)<>'object'
    or jsonb_typeof(p_plans)<>'array' or jsonb_array_length(p_plans)<>v_old.slot_count
    or v_config.slot_count<>v_old.slot_count
    or p_period_key !~ '^[0-9]{4}-[0-9]{2}$'
    or exists (select 1 from coinops.robot_v1_live_slots
      where run_id=v_old.id and position_quantity>0)
    or exists (select 1 from coinops.robot_v1_live_orders
      where run_id=v_old.id and status in ('PREPARED','NEW','PARTIALLY_FILLED'))
    or exists (select 1 from coinops.robot_v1_live_orders
      where run_id=v_old.id and executed_quantity>0 and not trades_reconciled) then
    raise exception 'COINOPS_LIVE_RESET_GATE_FAILED';
  end if;
  select count(*),coalesce(sum(balance_brl),0) into v_count,v_total
    from coinops.robot_v1_live_slot_accounts
    where product_id=v_old.product_id and tenant_id=v_old.tenant_id
      and user_id=v_old.user_id and trading_engine_id=v_old.trading_engine_id and asset=v_old.asset and balance_brl>0;
  if v_count<>v_old.slot_count or v_total<=0 then raise exception 'COINOPS_LIVE_RESET_BALANCE_INVALID'; end if;
  for v_number in 1..v_old.slot_count loop
    v_plan:=p_plans->(v_number-1);
    if (v_plan->>'slot_number')::integer is distinct from v_number then
      raise exception 'COINOPS_LIVE_RESET_PHYSICAL_SLOT_INVALID';
    end if;
    v_rank:=(v_plan->>'operational_rank')::integer;
    v_price:=(v_plan->>'target_buy_price')::numeric;
    v_group:=v_plan->>'post_ath_group';
    v_group_rank:=(v_plan->>'post_ath_group_rank')::integer;
    if v_price is null or v_price<=0 or v_rank is not null and
      (v_rank<1 or v_rank>v_old.slot_count or v_rank=any(v_ranks))
      or v_group is not null and v_group not in ('PRIMARY','RESERVE')
      or v_group_rank is not null and (v_group is null or v_group_rank<1 or v_group_rank>v_old.slot_count) then
      raise exception 'COINOPS_LIVE_RESET_PLAN_INVALID';
    end if;
    if v_rank is not null then v_ranks:=array_append(v_ranks,v_rank); end if;
  end loop;
  update coinops.robot_v1_live_runs set status='COMPLETED',completed_at=now()
    where id=v_old.id;
  insert into coinops.robot_v1_live_runs
    (operator_id,exchange_account_id,trading_engine_id,quote_asset,product_id,tenant_id,user_id,asset,symbol,status,anchor_price,slot_notional_brl,
      gain_rate,entry_spacing,entry_regime,config_version,config_snapshot,strategy_version,
      ath_transition_key,ath_period_key,previous_run_id,reset_idempotency_key)
  values (v_old.operator_id,v_old.exchange_account_id,v_old.trading_engine_id,v_old.quote_asset,v_old.product_id,v_old.tenant_id,v_old.user_id,v_old.asset,v_old.symbol,'ACTIVE',
    p_anchor_price,round(v_total/v_old.slot_count,8),p_gain_rate,p_entry_spacing,p_regime,
    p_config_version,p_config_snapshot,v_old.strategy_version,
    p_transition_key,p_period_key,v_old.id,p_reset_key) returning * into v_new;
  for v_number in 1..v_old.slot_count loop
    v_plan:=p_plans->(v_number-1);
    insert into coinops.robot_v1_live_slots
      (run_id,product_id,tenant_id,user_id,slot_number,target_buy_price,
        entry_reference_price,operational_rank,post_ath_group,post_ath_group_rank)
    values (v_new.id,v_new.product_id,v_new.tenant_id,v_new.user_id,v_number,
      (v_plan->>'target_buy_price')::numeric,(v_plan->>'target_buy_price')::numeric,
      (v_plan->>'operational_rank')::integer,v_plan->>'post_ath_group',
      (v_plan->>'post_ath_group_rank')::integer);
  end loop;
  insert into coinops.robot_v1_live_events
    (run_id,product_id,tenant_id,user_id,event_key,event_type,details)
  values (v_new.id,v_new.product_id,v_new.tenant_id,v_new.user_id,
    'RUN_REANCHORED','RUN_REANCHORED',jsonb_build_object('previous_run_id',v_old.id,
      'anchor_price',p_anchor_price,'reset_key',p_reset_key,
      'recovered_while_buy_gate_closed',v_config.kill_switch or v_old.last_error is not null));
  return v_new;
end $function$
;

CREATE OR REPLACE FUNCTION coinops.stage_operator_engine_plan(p_operator_id uuid, p_account_id uuid, p_quote_asset text, p_authorized_capital numeric, p_engines jsonb, p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_account coinops.exchange_accounts%rowtype;
  v_operator coinops.operators%rowtype;
  v_check coinops.account_onboarding_checks%rowtype;
  v_item jsonb;
  v_asset text;
  v_symbol text;
  v_cap numeric;
  v_gain numeric;
  v_spacing numeric;
  v_post_ath numeric;
  v_slots integer;
  v_engine_id uuid;
  v_total numeric := 0;
  v_assets text[] := '{}';
  v_result jsonb := '[]'::jsonb;
  v_replay coinops.account_onboarding_checks%rowtype;
begin
  if coalesce(nullif(current_setting('request.jwt.claim.role',true),''),auth.jwt()->>'role','') <> 'service_role'
    or p_operator_id is null or p_account_id is null
    or p_request_id is null or p_quote_asset not in ('BRL','USDT')
    or p_authorized_capital is null or p_authorized_capital <= 0
    or p_authorized_capital <> round(p_authorized_capital, 2)
    or jsonb_typeof(p_engines) <> 'array'
    or jsonb_array_length(p_engines) not between 1 and 2 then
    raise exception 'COINOPS_PLAN_INPUT_DENIED';
  end if;
  select * into v_account from coinops.exchange_accounts
    where id = p_account_id and operator_id = p_operator_id for update;
  select * into v_operator from coinops.operators where id = p_operator_id;
  if v_account.id is null or v_operator.id is null or v_operator.status <> 'ACTIVE'
    or v_operator.kill_switch or v_account.status <> 'INACTIVE'
    or not v_account.kill_switch or v_account.is_legacy_default
    or v_account.executor_profile <> 'coinops-fixed-ip'
    or v_account.credential_ref <> 'account_' || replace(p_account_id::text, '-', '') then
    raise exception 'COINOPS_PLAN_ACCOUNT_DENIED';
  end if;
  select * into v_check from coinops.account_onboarding_checks
    where operator_id = p_operator_id and exchange_account_id = p_account_id
      and check_key = 'BINANCE_CREDENTIAL'
    order by checked_at desc, id desc limit 1;
  if v_check.id is null or v_check.status <> 'PASS'
    or v_check.evidence->>'environment' <> 'REAL'
    or v_check.evidence->>'status' <> 'PASS'
    or v_check.evidence->>'whitelist_accepted' <> 'true'
    or v_check.evidence->'permission'->>'spotTrading' <> 'true'
    or v_check.evidence->'permission'->>'withdrawals' <> 'false' then
    raise exception 'COINOPS_PLAN_CREDENTIAL_GATE_DENIED';
  end if;
  select * into v_replay from coinops.account_onboarding_checks
    where exchange_account_id = p_account_id
      and idempotency_key = 'engine-plan:' || p_request_id::text;
  if v_replay.id is not null then
    if private.coinops_plan_replay_input(v_replay.evidence->'input') is distinct from private.coinops_plan_replay_input(jsonb_build_object(
      'quote', p_quote_asset, 'capital', p_authorized_capital, 'engines', p_engines)) then
      raise exception 'COINOPS_PLAN_REPLAY_MISMATCH';
    end if;
    return v_replay.evidence->'result';
  end if;
  if exists (select 1 from coinops.trading_engines where exchange_account_id = p_account_id)
    or exists (select 1 from coinops.account_quote_caps where exchange_account_id = p_account_id)
    or exists (select 1 from coinops.robot_v1_live_runs where exchange_account_id = p_account_id) then
    raise exception 'COINOPS_PLAN_EXISTING_STATE_DENIED';
  end if;
  for v_item in select value from jsonb_array_elements(p_engines) loop
    v_asset := v_item->>'asset';
    v_symbol := v_asset || p_quote_asset;
    if v_asset not in ('BTC','SOL') or v_asset = any(v_assets)
      or (select count(*) from jsonb_object_keys(v_item-'slotCount'-'monthlyTarget')) <> 5
      or not (v_item ?& array['asset','capital','gain','spacing','postAth']) then
      raise exception 'COINOPS_PLAN_MARKET_DENIED';
    end if;
    v_assets := array_append(v_assets, v_asset);
    begin
      v_cap := (v_item->>'capital')::numeric;
      v_gain := (v_item->>'gain')::numeric;
      v_spacing := (v_item->>'spacing')::numeric;
      v_post_ath := (v_item->>'postAth')::numeric;
    v_slots := private.coinops_plan_slot_count(v_item);
    exception when others then raise exception 'COINOPS_PLAN_RATE_INVALID'; end;
    if v_cap is null or v_cap <= 0 or v_cap*100<v_slots or v_cap <> round(v_cap, 2)
      or v_gain not between 0.001 and 0.2
      or v_spacing not between 0.001 and 0.2
      or v_post_ath not between 0.001 and 0.2 then
      raise exception 'COINOPS_PLAN_CAP_INVALID';
    end if;
    if v_item ? 'monthlyTarget' and (jsonb_typeof(v_item->'monthlyTarget') is distinct from 'number'
      or v_item->>'monthlyTarget' !~ '^[1-9][0-9]*$') then raise exception 'COINOPS_PLAN_RATE_INVALID'; end if;
    v_total := v_total + v_cap;
  end loop;
  if v_total <> p_authorized_capital then raise exception 'COINOPS_PLAN_CAP_SUM_MISMATCH'; end if;

  insert into coinops.account_quote_caps(operator_id, exchange_account_id, quote_asset, hard_cap_quote)
    values (p_operator_id, p_account_id, p_quote_asset, p_authorized_capital);
  for v_item in select value from jsonb_array_elements(p_engines) loop
    v_asset := v_item->>'asset';
    v_symbol := v_asset || p_quote_asset;
    v_cap := (v_item->>'capital')::numeric;
    v_gain := (v_item->>'gain')::numeric;
    v_spacing := (v_item->>'spacing')::numeric;
    v_post_ath := (v_item->>'postAth')::numeric;
    v_slots := private.coinops_plan_slot_count(v_item);
    insert into coinops.trading_engines(operator_id, exchange_account_id, environment,
      symbol, base_asset, quote_asset, ath_reference_symbol, status, kill_switch,
      legacy_compatible, hard_cap_quote, slot_count, config)
    values (p_operator_id, p_account_id, 'REAL', v_symbol, v_asset, p_quote_asset,
      v_symbol, 'INACTIVE', true, false, v_cap,v_slots,
      jsonb_build_object('slot_count',v_slots,'initial_slot_quote',v_cap / v_slots,
        'capital_quote',v_cap,'max_order_quote',v_cap,'gain_rate',v_gain,
        'normal_spacing_rate',v_spacing,'post_ath_spacing_rate',v_post_ath,
        'monthly_target',coalesce((v_item->>'monthlyTarget')::integer,case v_asset when 'BTC' then 7 else 2 end)))
    returning id into v_engine_id;
    insert into coinops.robot_v1_live_preparations(product_id,tenant_id,user_id,
      operator_id,exchange_account_id,trading_engine_id,asset,symbol,quote_asset,
      slot_count,monthly_target,configured_live_capital_brl,max_order_notional_brl,
      max_total_exposure_brl,compounding_enabled,single_active_entry,
      initial_market_enabled,local_reentry_enabled,kill_switch,live_enabled)
    values(v_operator.product_id,v_operator.tenant_id,v_operator.user_id,
      p_operator_id,p_account_id,v_engine_id,v_asset,v_symbol,p_quote_asset,
      v_slots,coalesce((v_item->>'monthlyTarget')::integer,case v_asset when 'BTC' then 7 else 2 end),v_cap,v_cap,v_cap,
      true,true,true,true,true,false);
    insert into coinops.robot_v1_ath_profiles(product_id,tenant_id,user_id,
      operator_id,exchange_account_id,trading_engine_id,environment,asset,quote_asset,
      config_version,gain_rate,normal_spacing_rate,post_ath_spacing_rate,regime)
    values(v_operator.product_id,v_operator.tenant_id,v_operator.user_id,
      p_operator_id,p_account_id,v_engine_id,'REAL',v_asset,p_quote_asset,
      1,v_gain,v_spacing,v_post_ath,'NORMAL');
    insert into coinops.robot_v1_live_slot_accounts(product_id,tenant_id,user_id,
      operator_id,exchange_account_id,trading_engine_id,asset,quote_asset,slot_number)
    select v_operator.product_id,v_operator.tenant_id,v_operator.user_id,
      p_operator_id,p_account_id,v_engine_id,v_asset,p_quote_asset,number
    from generate_series(1,v_slots) as number;
    v_result := v_result || jsonb_build_array(jsonb_build_object(
      'engineId',v_engine_id,'symbol',v_symbol,'capital',v_cap,'slotCount',v_slots,'status','INACTIVE'));
  end loop;
  insert into coinops.account_onboarding_checks(operator_id,exchange_account_id,
    check_key,status,evidence,created_by,idempotency_key)
  values(p_operator_id,p_account_id,'ENGINE_PLAN','PASS',
    jsonb_build_object('input',jsonb_build_object('quote',p_quote_asset,
      'capital',p_authorized_capital,'engines',p_engines),'result',v_result),
    v_operator.user_id,'engine-plan:' || p_request_id::text);
  return v_result;
end $function$
;

CREATE OR REPLACE FUNCTION coinops.stage_operator_engine_plan(p_operator_id uuid, p_account_id uuid, p_quote_asset text, p_authorized_capital numeric, p_engines jsonb, p_request_id uuid, p_environment text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_account coinops.exchange_accounts%rowtype;
  v_operator coinops.operators%rowtype;
  v_check coinops.account_onboarding_checks%rowtype;
  v_item jsonb;
  v_asset text;
  v_symbol text;
  v_cap numeric;
  v_gain numeric;
  v_spacing numeric;
  v_post_ath numeric;
  v_slots integer;
  v_engine_id uuid;
  v_total numeric := 0;
  v_assets text[] := '{}';
  v_result jsonb := '[]'::jsonb;
  v_replay coinops.account_onboarding_checks%rowtype;
  v_input jsonb;
begin
  if coalesce(nullif(current_setting('request.jwt.claim.role',true),''),auth.jwt()->>'role','') <> 'service_role'
    or p_operator_id is null or p_account_id is null or p_request_id is null
    or p_environment is null or p_environment not in ('REAL','TESTNET')
    or p_quote_asset is null or p_quote_asset not in ('BRL','USDT','USDC')
    or (p_environment = 'REAL' and p_quote_asset = 'USDC')
    or (p_environment = 'TESTNET' and p_quote_asset = 'BRL')
    or p_authorized_capital is null or p_authorized_capital <= 0
    or p_authorized_capital <> round(p_authorized_capital,2)
    or jsonb_typeof(p_engines) <> 'array'
    or jsonb_array_length(p_engines) not between 1 and 2 then
    raise exception 'COINOPS_PLAN_INPUT_DENIED';
  end if;
  v_input := jsonb_build_object('environment',p_environment,'quote',p_quote_asset,
    'capital',p_authorized_capital,'engines',p_engines);
  select * into v_account from coinops.exchange_accounts
    where id=p_account_id and operator_id=p_operator_id for update;
  select * into v_operator from coinops.operators where id=p_operator_id;
  if v_account.id is null or v_operator.id is null or v_operator.status <> 'ACTIVE'
    or v_operator.kill_switch or v_account.status <> 'INACTIVE'
    or not v_account.kill_switch or v_account.is_legacy_default
    or v_account.executor_profile <> 'coinops-fixed-ip'
    or v_account.credential_ref <> 'account_' || replace(p_account_id::text,'-','') then
    raise exception 'COINOPS_PLAN_ACCOUNT_DENIED';
  end if;
  select * into v_check from coinops.account_onboarding_checks
    where operator_id=p_operator_id and exchange_account_id=p_account_id
      and check_key='BINANCE_CREDENTIAL'
    order by checked_at desc,id desc limit 1;
  if v_check.id is null or v_check.status <> 'PASS'
    or v_check.evidence->>'environment' <> p_environment
    or v_check.evidence->>'status' <> 'PASS'
    or v_check.evidence->'permission'->>'spotTrading' <> 'true'
    or (p_environment='REAL' and (
      v_check.evidence->>'whitelist_accepted' <> 'true'
      or v_check.evidence->'permission'->>'withdrawals' <> 'false')) then
    raise exception 'COINOPS_PLAN_CREDENTIAL_GATE_DENIED';
  end if;
  select * into v_replay from coinops.account_onboarding_checks
    where exchange_account_id=p_account_id
      and idempotency_key='engine-plan:' || p_request_id::text;
  if v_replay.id is not null then
    if private.coinops_plan_replay_input(v_replay.evidence->'input') is distinct from private.coinops_plan_replay_input(v_input) then
      raise exception 'COINOPS_PLAN_REPLAY_MISMATCH';
    end if;
    return v_replay.evidence->'result';
  end if;
  if exists(select 1 from coinops.trading_engines where exchange_account_id=p_account_id)
    or exists(select 1 from coinops.account_quote_caps where exchange_account_id=p_account_id)
    or exists(select 1 from coinops.robot_v1_live_runs where exchange_account_id=p_account_id)
    or exists(select 1 from coinops.robot_v1_testnet_runs where exchange_account_id=p_account_id) then
    raise exception 'COINOPS_PLAN_EXISTING_STATE_DENIED';
  end if;
  for v_item in select value from jsonb_array_elements(p_engines) loop
    v_asset := v_item->>'asset';
    v_symbol := v_asset || p_quote_asset;
    if v_asset not in ('BTC','SOL') or v_asset=any(v_assets)
      or (select count(*) from jsonb_object_keys(v_item-'slotCount'-'monthlyTarget')) <> 5
      or not (v_item ?& array['asset','capital','gain','spacing','postAth']) then
      raise exception 'COINOPS_PLAN_MARKET_DENIED';
    end if;
    v_assets := array_append(v_assets,v_asset);
    begin
      v_cap := (v_item->>'capital')::numeric;
      v_gain := (v_item->>'gain')::numeric;
      v_spacing := (v_item->>'spacing')::numeric;
      v_post_ath := (v_item->>'postAth')::numeric;
    v_slots := private.coinops_plan_slot_count(v_item);
    exception when others then raise exception 'COINOPS_PLAN_RATE_INVALID'; end;
    if v_cap is null or v_cap <= 0 or v_cap*100<v_slots or v_cap <> round(v_cap,2)
      or v_gain not between 0.001 and 0.2
      or v_spacing not between 0.001 and 0.2
      or v_post_ath not between 0.001 and 0.2 then
      raise exception 'COINOPS_PLAN_CAP_INVALID';
    end if;
    if p_environment<>'REAL' and v_slots<>25 then raise exception 'COINOPS_TESTNET_SLOT_COUNT_UNSUPPORTED'; end if;
    if v_item ? 'monthlyTarget' and (jsonb_typeof(v_item->'monthlyTarget') is distinct from 'number'
      or v_item->>'monthlyTarget' !~ '^[1-9][0-9]*$') then raise exception 'COINOPS_PLAN_RATE_INVALID'; end if;
    v_total := v_total + v_cap;
  end loop;
  if v_total <> p_authorized_capital then raise exception 'COINOPS_PLAN_CAP_SUM_MISMATCH'; end if;
  insert into coinops.account_quote_caps(operator_id,exchange_account_id,quote_asset,hard_cap_quote)
    values(p_operator_id,p_account_id,p_quote_asset,p_authorized_capital);
  for v_item in select value from jsonb_array_elements(p_engines) loop
    v_asset := v_item->>'asset'; v_symbol := v_asset || p_quote_asset;
    v_cap := (v_item->>'capital')::numeric;
    v_gain := (v_item->>'gain')::numeric;
    v_spacing := (v_item->>'spacing')::numeric;
    v_post_ath := (v_item->>'postAth')::numeric;
    v_slots := private.coinops_plan_slot_count(v_item);
    insert into coinops.trading_engines(operator_id,exchange_account_id,environment,
      symbol,base_asset,quote_asset,ath_reference_symbol,status,kill_switch,
      legacy_compatible,hard_cap_quote,slot_count,config)
    values(p_operator_id,p_account_id,p_environment,v_symbol,v_asset,p_quote_asset,
      v_symbol,'INACTIVE',true,false,v_cap,v_slots,
      jsonb_build_object('slot_count',v_slots,'initial_slot_quote',v_cap/v_slots,
        'capital_quote',v_cap,'max_order_quote',v_cap,'gain_rate',v_gain,
        'normal_spacing_rate',v_spacing,'post_ath_spacing_rate',v_post_ath,
        'monthly_target',coalesce((v_item->>'monthlyTarget')::integer,case v_asset when 'BTC' then 7 else 2 end)))
    returning id into v_engine_id;
    insert into coinops.robot_v1_ath_profiles(product_id,tenant_id,user_id,
      operator_id,exchange_account_id,trading_engine_id,environment,asset,quote_asset,
      config_version,gain_rate,normal_spacing_rate,post_ath_spacing_rate,regime)
    values(v_operator.product_id,v_operator.tenant_id,v_operator.user_id,
      p_operator_id,p_account_id,v_engine_id,p_environment,v_asset,p_quote_asset,
      1,v_gain,v_spacing,v_post_ath,'NORMAL');
    if p_environment='REAL' then
      insert into coinops.robot_v1_live_preparations(product_id,tenant_id,user_id,
        operator_id,exchange_account_id,trading_engine_id,asset,symbol,quote_asset,
        slot_count,monthly_target,configured_live_capital_brl,max_order_notional_brl,
        max_total_exposure_brl,compounding_enabled,single_active_entry,
        initial_market_enabled,local_reentry_enabled,kill_switch,live_enabled)
      values(v_operator.product_id,v_operator.tenant_id,v_operator.user_id,
        p_operator_id,p_account_id,v_engine_id,v_asset,v_symbol,p_quote_asset,
        v_slots,coalesce((v_item->>'monthlyTarget')::integer,case v_asset when 'BTC' then 7 else 2 end),v_cap,v_cap,v_cap,
        true,true,true,true,true,false);
      insert into coinops.robot_v1_live_slot_accounts(product_id,tenant_id,user_id,
        operator_id,exchange_account_id,trading_engine_id,asset,quote_asset,slot_number)
      select v_operator.product_id,v_operator.tenant_id,v_operator.user_id,
        p_operator_id,p_account_id,v_engine_id,v_asset,p_quote_asset,number
      from generate_series(1,v_slots) as number;
    end if;
    v_result := v_result || jsonb_build_array(jsonb_build_object(
      'engineId',v_engine_id,'symbol',v_symbol,'capital',v_cap,'slotCount',v_slots,'status','INACTIVE',
      'environment',p_environment));
  end loop;
  insert into coinops.account_onboarding_checks(operator_id,exchange_account_id,
    check_key,status,evidence,created_by,idempotency_key)
  values(p_operator_id,p_account_id,'ENGINE_PLAN','PASS',
    jsonb_build_object('input',v_input,'result',v_result),
    v_operator.user_id,'engine-plan:' || p_request_id::text);
  return v_result;
end $function$
;

-- JSON numeric symbol counts are legacy 25-slot plans. Arrays carry exact
-- canonical counts for mixed 25/50/100 engines on the same account/symbol.
create or replace function private.coinops_symbol_order_footprint(p_value jsonb)
returns numeric language plpgsql immutable set search_path='' as $$
declare total numeric; item jsonb;
begin
  if jsonb_typeof(p_value)='number' and p_value::text~'^(0|[1-9][0-9]*)$' then return 26*p_value::text::numeric; end if;
  if jsonb_typeof(p_value) is distinct from 'array' or jsonb_array_length(p_value)>25 then
    raise exception 'COINOPS_ACCOUNT_ORDER_BUDGET_INVALID_PROJECTION' using errcode='22023'; end if;
  total:=0;
  for item in select value from jsonb_array_elements(p_value) loop
    if jsonb_typeof(item) is distinct from 'number' or item::text!~'^[1-9][0-9]*$'
      or item::text::numeric not between 2 and 100 then
      raise exception 'COINOPS_ACCOUNT_ORDER_BUDGET_INVALID_PROJECTION' using errcode='22023'; end if;
    total:=total+item::text::numeric+1;
  end loop;
  return total;
end $$;
revoke all on function private.coinops_symbol_order_footprint(jsonb) from public,anon,authenticated;
grant execute on function private.coinops_symbol_order_footprint(jsonb) to service_role;

CREATE OR REPLACE FUNCTION private.coinops_account_order_budget_gate(p_operator_id uuid, p_account_id uuid, p_new_orders integer, p_symbol_counts jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  sample coinops.account_order_budget_samples%rowtype;
  interval_row jsonb; limits jsonb; symbol_row record;
  now_ms numeric; observed_ms numeric; offset_ms numeric; duration numeric;
  limit_value numeric; count_value numeric; outstanding numeric; projected numeric;
  resident numeric; external_count numeric; new_footprint numeric; existing_footprint numeric;
  results jsonb:='[]'; code text:='PASS';
begin
  if coalesce(nullif(current_setting('request.jwt.claim.role',true),''),auth.jwt()->>'role','')<>'service_role'
    or p_operator_id is null or p_account_id is null then
    raise exception 'COINOPS_ACCOUNT_ORDER_BUDGET_SCOPE_DENIED';
  end if;
  perform 1 from coinops.exchange_accounts where id=p_account_id and operator_id=p_operator_id for update;
  if not found then raise exception 'COINOPS_ACCOUNT_ORDER_BUDGET_SCOPE_DENIED'; end if;
  if p_new_orders is null or p_new_orders<0 or jsonb_typeof(p_symbol_counts) is distinct from 'object'
    or exists(select 1 from jsonb_each(p_symbol_counts) where key!~'^(BTC|SOL)(BRL|USDT)$'
      or (jsonb_typeof(value)<>'array' and (jsonb_typeof(value)<>'number' or value::text!~'^(0|[1-9][0-9]*)$'))) then
    return jsonb_build_object('code','ACCOUNT_ORDER_BUDGET_UNKNOWN','reason','invalid projection','intervals','[]'::jsonb);
  end if;
  now_ms:=extract(epoch from clock_timestamp())*1000;
  select * into sample from coinops.account_order_budget_samples
    where exchange_account_id=p_account_id and operator_id=p_operator_id;
  observed_ms:=extract(epoch from sample.observed_at)*1000;
  offset_ms:=sample.server_time_ms-observed_ms;
  if sample.exchange_account_id is null or observed_ms<now_ms-30000 or observed_ms>now_ms+2000
    or abs(offset_ms)>2000 or jsonb_array_length(sample.restrictions)>0
    or not exists(select 1 from coinops.account_executor_connections c where c.exchange_account_id=p_account_id
      and c.operator_id=p_operator_id and c.executor_shard_id=sample.source_shard_id
      and c.environment='REAL' and c.status='VALIDATED')
    or (select count(distinct value->>'intervalMs') from jsonb_array_elements(sample.intervals))<>jsonb_array_length(sample.intervals) then
    return jsonb_build_object('code','ACCOUNT_ORDER_BUDGET_UNKNOWN','reason','fresh signed account observation required','intervals','[]'::jsonb);
  end if;
  for interval_row in select value from jsonb_array_elements(sample.intervals) loop
    if jsonb_typeof(interval_row)<>'object' or not (interval_row ?& array['intervalMs','limit','count'])
      or jsonb_typeof(interval_row->'intervalMs') is distinct from 'number'
      or jsonb_typeof(interval_row->'limit') is distinct from 'number'
      or jsonb_typeof(interval_row->'count') is distinct from 'number'
      or interval_row->>'intervalMs'!~'^[1-9][0-9]*$' or interval_row->>'limit'!~'^[1-9][0-9]*$'
      or interval_row->>'count'!~'^(0|[1-9][0-9]*)$' then
      return jsonb_build_object('code','ACCOUNT_ORDER_BUDGET_UNKNOWN','reason','invalid interval','intervals','[]'::jsonb);
    end if;
    duration:=(interval_row->>'intervalMs')::numeric; limit_value:=(interval_row->>'limit')::numeric;
    count_value:=(interval_row->>'count')::numeric;
    if greatest(duration,limit_value,count_value)>9007199254740991
      or floor(sample.server_time_ms/duration)<>floor((now_ms+offset_ms)/duration) then
      return jsonb_build_object('code','ACCOUNT_ORDER_BUDGET_UNKNOWN','reason','interval expired or invalid','intervals','[]'::jsonb);
    end if;
    select coalesce(sum(r.protection_orders+case when r.acknowledged_at is null
      or r.acknowledged_at>=sample.observed_at and floor((extract(epoch from r.acknowledged_at)*1000+offset_ms)/duration)
        =floor((now_ms+offset_ms)/duration) then 1 else 0 end),0) into outstanding
      from coinops.account_order_budget_reservations r where r.exchange_account_id=p_account_id;
    projected:=count_value+outstanding+p_new_orders;
    results:=results||jsonb_build_array(jsonb_build_object('intervalMs',duration,'projected',projected,'limit',limit_value));
    if projected>limit_value then code:='ACCOUNT_ORDER_CAPACITY_REQUIRED'; end if;
  end loop;
  select coalesce(sum(r.protection_orders+case when r.acknowledged_at is null
    or r.acknowledged_at>=sample.observed_at then 1 else 0 end),0) into outstanding
    from coinops.account_order_budget_reservations r where r.exchange_account_id=p_account_id;
  select coalesce(sum(private.coinops_symbol_order_footprint(value)),0) into new_footprint from jsonb_each(p_symbol_counts);
  for symbol_row in select key,private.coinops_symbol_order_footprint(value) amount from jsonb_each(p_symbol_counts) loop
    limits:=sample.symbol_limits->symbol_row.key;
    if limits is null or jsonb_typeof(limits)<>'object'
      or not(limits ?& array['maxOrders','openOrders','externalOrders','selfTradePrevention'])
      or jsonb_typeof(limits->'maxOrders') is distinct from 'number'
      or jsonb_typeof(limits->'openOrders') is distinct from 'number'
      or jsonb_typeof(limits->'externalOrders') is distinct from 'number'
      or limits->>'selfTradePrevention' is distinct from 'EXPIRE_TAKER'
      or limits->>'maxOrders'!~'^[1-9][0-9]*$' or limits->>'openOrders'!~'^(0|[1-9][0-9]*)$'
      or limits->>'externalOrders'!~'^(0|[1-9][0-9]*)$' then
      return jsonb_build_object('code','ACCOUNT_ORDER_BUDGET_UNKNOWN','reason','symbol filters or STP unproven','intervals',results);
    end if;
    limit_value:=(limits->>'maxOrders')::numeric; resident:=(limits->>'openOrders')::numeric;
    external_count:=(limits->>'externalOrders')::numeric;
    if external_count>resident or greatest(limit_value,resident,external_count)>9007199254740991 then
      return jsonb_build_object('code','ACCOUNT_ORDER_BUDGET_UNKNOWN','reason','invalid resident order observation','intervals',results);
    end if;
    select coalesce(sum(slot_count+1),0) into existing_footprint from coinops.trading_engines
      where exchange_account_id=p_account_id and operator_id=p_operator_id and environment='REAL' and symbol=symbol_row.key;
    if greatest(resident+outstanding+p_new_orders,external_count+existing_footprint+symbol_row.amount)>limit_value then
      code:='ACCOUNT_ORDER_CAPACITY_REQUIRED';
    end if;
  end loop;
  if sample.exchange_limits is not null then
    limits:=sample.exchange_limits;
    if not(limits ?& array['limit','openOrders','externalOrders'])
      or jsonb_typeof(limits->'limit') is distinct from 'number'
      or jsonb_typeof(limits->'openOrders') is distinct from 'number'
      or jsonb_typeof(limits->'externalOrders') is distinct from 'number'
      or limits->>'limit'!~'^[1-9][0-9]*$' or limits->>'openOrders'!~'^(0|[1-9][0-9]*)$'
      or limits->>'externalOrders'!~'^(0|[1-9][0-9]*)$' then
      return jsonb_build_object('code','ACCOUNT_ORDER_BUDGET_UNKNOWN','reason','invalid exchange filter','intervals',results);
    end if;
    limit_value:=(limits->>'limit')::numeric; resident:=(limits->>'openOrders')::numeric;
    external_count:=(limits->>'externalOrders')::numeric;
    if external_count>resident or greatest(limit_value,resident,external_count)>9007199254740991 then
      return jsonb_build_object('code','ACCOUNT_ORDER_BUDGET_UNKNOWN','reason','invalid exchange observation','intervals',results);
    end if;
    select coalesce(sum(slot_count+1),0) into existing_footprint from coinops.trading_engines
      where exchange_account_id=p_account_id and operator_id=p_operator_id and environment='REAL';
    if greatest(resident+outstanding+p_new_orders,external_count+existing_footprint+new_footprint)>limit_value then
      code:='ACCOUNT_ORDER_CAPACITY_REQUIRED';
    end if;
  end if;
  return jsonb_build_object('code',code,'reason',case when code='PASS' then 'shared account budgets preserved'
    else 'shared account order capacity required' end,'intervals',results);
exception when data_exception then
  return jsonb_build_object('code','ACCOUNT_ORDER_BUDGET_UNKNOWN','reason','invalid observation','intervals','[]'::jsonb);
end $function$
;
CREATE OR REPLACE FUNCTION coinops.reserve_executor_capacity(p_shard_id text, p_engine_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare s record; owner_shard text; env text; slots integer; decision jsonb;
begin
  select e.executor_shard_id,e.environment,e.slot_count into owner_shard,env,slots
    from coinops.trading_engines e join coinops.exchange_accounts a
      on a.id=e.exchange_account_id and a.operator_id=e.operator_id
    where e.id=p_engine_id and e.environment in ('REAL','TESTNET') for update of a;
  if owner_shard is null or owner_shard<>p_shard_id then return 'CAPACITY_UNKNOWN'; end if;
  select * into s from coinops.executor_shards where id=p_shard_id and enabled for update;
  if not found then return 'CAPACITY_UNKNOWN'; end if;
  perform 1 from coinops.executor_admission_attestations where shard_id=p_shard_id for share;
  perform 1 from coinops.executor_admission_release where singleton for share;
  decision:=coinops.preview_engine_slot_admission(p_shard_id,env,array[slots],p_engine_id);
  if decision->>'code' is distinct from 'CAPACITY_OK' then return coalesce(decision->>'code','CAPACITY_UNKNOWN'); end if;
  insert into coinops.executor_capacity_admissions(engine_id,shard_id,environment,reserved_weight,expires_at)
  values(p_engine_id,p_shard_id,env,(coinops.executor_capacity_policy()->>'incremental_weight')::numeric*(decision->>'capacity_units')::integer,now()+interval '20 minutes')
  on conflict(engine_id) do update set shard_id=excluded.shard_id,environment=excluded.environment,
    reserved_weight=excluded.reserved_weight,reserved_at=now(),expires_at=excluded.expires_at;
  return 'CAPACITY_OK';
end $function$
;

-- Batch initialization avoids N server roundtrips. It is NOT an adjustment:
-- only unfunded PREPARING accounts with no order can be seeded, or replayed
-- byte-for-value at exactly the approved principal. Every other state fails.
create or replace function coinops.seed_robot_v1_live_slot_accounts(p_run_id uuid,p_slot_capitals jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r coinops.robot_v1_live_runs%rowtype; e coinops.trading_engines%rowtype;
  p coinops.robot_v1_live_preparations%rowtype; n integer; total numeric; zero_count integer; exact_count integer;
begin
  if coalesce(nullif(current_setting('request.jwt.claim.role',true),''),auth.jwt()->>'role','')<>'service_role'
    or p_run_id is null then raise exception 'COINOPS_LIVE_SEED_SCOPE_DENIED'; end if;
  select * into strict r from coinops.robot_v1_live_runs where id=p_run_id for update;
  select * into strict e from coinops.trading_engines where id=r.trading_engine_id and operator_id=r.operator_id
    and exchange_account_id=r.exchange_account_id and environment='REAL' for share;
  select * into strict p from coinops.robot_v1_live_preparations where trading_engine_id=e.id
    and operator_id=e.operator_id and exchange_account_id=e.exchange_account_id for update;
  if r.status<>'PREPARING' or r.slot_count<>e.slot_count or p.slot_count<>e.slot_count
    or p.live_enabled or not p.kill_switch or jsonb_typeof(p_slot_capitals) is distinct from 'array'
    or jsonb_array_length(p_slot_capitals)<>e.slot_count
    or exists(select 1 from coinops.robot_v1_live_orders where run_id=r.id) then
    raise exception 'COINOPS_LIVE_SEED_GATE_FAILED'; end if;
  if exists(select 1 from jsonb_array_elements(p_slot_capitals) v where jsonb_typeof(v)<>'number'
    or v::text::numeric<=0 or v::text::numeric<>round(v::text::numeric,2)
    or v::text::numeric::text in ('NaN','Infinity','-Infinity')) then
    raise exception 'COINOPS_LIVE_SEED_CAPITAL_INVALID'; end if;
  select sum(v::text::numeric) into total from jsonb_array_elements(p_slot_capitals) v;
  if total<>p.configured_live_capital_brl or total>e.hard_cap_quote then raise exception 'COINOPS_LIVE_SEED_CAPITAL_INVALID'; end if;
  perform 1 from coinops.robot_v1_live_slot_accounts a where a.trading_engine_id=e.id order by a.slot_number for update;
  select count(*) into n from coinops.robot_v1_live_slot_accounts a where a.trading_engine_id=e.id
    and a.operator_id=e.operator_id and a.exchange_account_id=e.exchange_account_id;
  if n<>e.slot_count then raise exception 'COINOPS_LIVE_SLOT_COUNT_INVALID'; end if;
  select count(*) filter(where a.balance_brl=0 and a.contribution_brl=0),
    count(*) filter(where a.balance_brl=(p_slot_capitals->>(a.slot_number-1))::numeric
      and a.contribution_brl=(p_slot_capitals->>(a.slot_number-1))::numeric)
    into zero_count,exact_count from coinops.robot_v1_live_slot_accounts a where a.trading_engine_id=e.id
      and a.manual_gain_brl=0 and a.market_pnl_brl=0 and a.fees_brl=0 and a.gain_count=0
      and a.dust_quantity=0 and a.dust_cost_brl=0;
  if exact_count=e.slot_count then return jsonb_build_object('seeded_count',e.slot_count,'replayed',true); end if;
  if zero_count<>e.slot_count then raise exception 'COINOPS_LIVE_SEED_EXISTING_FINANCIAL_STATE'; end if;
  update coinops.robot_v1_live_slot_accounts a set
    balance_brl=(p_slot_capitals->>(a.slot_number-1))::numeric,
    contribution_brl=(p_slot_capitals->>(a.slot_number-1))::numeric
    where a.trading_engine_id=e.id and a.operator_id=e.operator_id and a.exchange_account_id=e.exchange_account_id;
  return jsonb_build_object('seeded_count',e.slot_count,'replayed',false);
end $$;
revoke all on function coinops.seed_robot_v1_live_slot_accounts(uuid,jsonb) from public,anon,authenticated;
grant execute on function coinops.seed_robot_v1_live_slot_accounts(uuid,jsonb) to service_role;
revoke all on function coinops.reserve_executor_capacity(text,uuid) from public,anon,authenticated;
grant execute on function coinops.reserve_executor_capacity(text,uuid) to service_role;

-- Preserve the previously verified service-only RPC surface explicitly.
revoke all on function coinops.activate_robot_v1_live_cycle(uuid) from public,anon,authenticated;
grant execute on function coinops.activate_robot_v1_live_cycle(uuid) to service_role;
revoke all on function coinops.append_operator_engine_plan(uuid,uuid,text,text,numeric,jsonb,uuid) from public,anon,authenticated;
grant execute on function coinops.append_operator_engine_plan(uuid,uuid,text,text,numeric,jsonb,uuid) to service_role;
revoke all on function coinops.apply_live_operator_adjustment(uuid,uuid,uuid,text,text,text,numeric,numeric,numeric,timestamp with time zone,text,text,jsonb,numeric,uuid) from public,anon,authenticated;
grant execute on function coinops.apply_live_operator_adjustment(uuid,uuid,uuid,text,text,text,numeric,numeric,numeric,timestamp with time zone,text,text,jsonb,numeric,uuid) to service_role;
revoke all on function coinops.apply_live_selective_contribution(uuid,uuid,uuid,uuid,text,text,numeric,numeric,text,text,jsonb,numeric,uuid,text) from public,anon,authenticated;
grant execute on function coinops.apply_live_selective_contribution(uuid,uuid,uuid,uuid,text,text,numeric,numeric,text,text,jsonb,numeric,uuid,text) to service_role;
revoke all on function private.coinops_account_order_budget_gate(uuid,uuid,integer,jsonb) from public,anon,authenticated;
grant execute on function private.coinops_account_order_budget_gate(uuid,uuid,integer,jsonb) to service_role;
revoke all on function coinops.manage_live_selective_contribution_preset(uuid,uuid,text,uuid,text,integer,integer,integer,boolean) from public,anon,authenticated;
grant execute on function coinops.manage_live_selective_contribution_preset(uuid,uuid,text,uuid,text,integer,integer,integer,boolean) to service_role;
revoke all on function coinops.mark_live_selective_contribution_preset_usage(uuid,uuid,uuid,uuid,uuid,integer,integer[]) from public,anon,authenticated;
grant execute on function coinops.mark_live_selective_contribution_preset_usage(uuid,uuid,uuid,uuid,uuid,integer,integer[]) to service_role;
revoke all on function coinops.prepare_robot_v1_live_order(uuid,uuid,text,text,integer,text,numeric,numeric,numeric,text,uuid) from public,anon,authenticated;
grant execute on function coinops.prepare_robot_v1_live_order(uuid,uuid,text,text,integer,text,numeric,numeric,numeric,text,uuid) to service_role;
revoke all on function coinops.restart_robot_v1_live_cycle(uuid,text,numeric,numeric,numeric,text,integer,jsonb,text,text,jsonb,uuid) from public,anon,authenticated;
grant execute on function coinops.restart_robot_v1_live_cycle(uuid,text,numeric,numeric,numeric,text,integer,jsonb,text,text,jsonb,uuid) to service_role;
revoke all on function coinops.stage_operator_engine_plan(uuid,uuid,text,numeric,jsonb,uuid) from public,anon,authenticated;
grant execute on function coinops.stage_operator_engine_plan(uuid,uuid,text,numeric,jsonb,uuid) to service_role;
revoke all on function coinops.stage_operator_engine_plan(uuid,uuid,text,numeric,jsonb,uuid,text) from public,anon,authenticated;
grant execute on function coinops.stage_operator_engine_plan(uuid,uuid,text,numeric,jsonb,uuid,text) to service_role;
commit;
