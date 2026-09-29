-- Engine-scoped, auditable strategy changes. No existing order is touched by this migration.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table coinops.trading_engines
  add column if not exists strategy_config_pending boolean not null default false;

create table coinops.strategy_bulk_batches (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null, tenant_id uuid not null, user_id uuid not null,
  operator_id uuid not null references coinops.operators(id) on delete restrict,
  created_by uuid not null,
  idempotency_key uuid not null,
  request_payload jsonb not null check (jsonb_typeof(request_payload) = 'object'),
  selected_count integer generated always as (jsonb_array_length(request_payload->'engines')) stored,
  admission_cursor integer not null default 0 check (admission_cursor >= 0),
  admission_failures jsonb not null default '{}'::jsonb check (jsonb_typeof(admission_failures) = 'object'),
  rollback_of uuid references coinops.strategy_bulk_batches(id) on delete restrict,
  status text not null default 'PENDING' check (status in ('PENDING','APPLYING','APPLIED','PARTIAL','BLOCKED_SAFE')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  applied_at timestamptz,
  unique (operator_id,idempotency_key),
  foreign key (operator_id,product_id,tenant_id,user_id)
    references coinops.operators(id,product_id,tenant_id,user_id) on delete restrict
);

create table coinops.strategy_bulk_engine_updates (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references coinops.strategy_bulk_batches(id) on delete restrict,
  product_id uuid not null, tenant_id uuid not null, user_id uuid not null,
  operator_id uuid not null, exchange_account_id uuid not null,
  trading_engine_id uuid not null,
  run_id uuid not null references coinops.robot_v1_live_runs(id) on delete restrict,
  profile_id uuid not null references coinops.robot_v1_ath_profiles(id) on delete restrict,
  symbol text not null, quote_asset text not null,
  strategy_version_before integer not null check (strategy_version_before > 0),
  strategy_version_after integer not null check (strategy_version_after = strategy_version_before + 1),
  old_values jsonb not null check (jsonb_typeof(old_values) = 'object'),
  new_values jsonb not null check (jsonb_typeof(new_values) = 'object'),
  status text not null default 'PENDING' check (status in ('PENDING','APPLYING','APPLIED','BLOCKED_SAFE')),
  error_code text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  applied_at timestamptz,
  unique (batch_id,trading_engine_id),
  foreign key (trading_engine_id,operator_id,exchange_account_id,quote_asset)
    references coinops.trading_engines(id,operator_id,exchange_account_id,quote_asset) on delete restrict
);
create unique index strategy_bulk_one_pending_per_engine
  on coinops.strategy_bulk_engine_updates(trading_engine_id)
  where status in ('PENDING','APPLYING','BLOCKED_SAFE');
create index strategy_bulk_engine_status on coinops.strategy_bulk_engine_updates(trading_engine_id,status,created_at);

alter table coinops.strategy_bulk_batches enable row level security;
alter table coinops.strategy_bulk_batches force row level security;
alter table coinops.strategy_bulk_engine_updates enable row level security;
alter table coinops.strategy_bulk_engine_updates force row level security;
revoke all on coinops.strategy_bulk_batches, coinops.strategy_bulk_engine_updates from anon, authenticated;
grant select on coinops.strategy_bulk_batches, coinops.strategy_bulk_engine_updates to authenticated;
grant all on coinops.strategy_bulk_batches, coinops.strategy_bulk_engine_updates to service_role;
create policy strategy_bulk_batches_owner_read on coinops.strategy_bulk_batches for select to authenticated
  using (private.coinops_can_access_row(product_id,tenant_id,user_id));
create policy strategy_bulk_engine_updates_owner_read on coinops.strategy_bulk_engine_updates for select to authenticated
  using (private.coinops_can_access_row(product_id,tenant_id,user_id));

-- This gate also protects a PREPARED BUY whose HTTP submission was delayed.
-- A pending config never blocks SELL/TP updates or ordinary reconciliation.
create function private.coinops_strategy_buy_gate() returns trigger language plpgsql
  set search_path = '' as $$
declare
  v_pending boolean;
  v_check boolean := false;
begin
  if new.side = 'BUY' then
    if tg_op = 'INSERT' then
      v_check := true;
    else
      v_check := old.submission_guarded_at is null and new.submission_guarded_at is not null;
    end if;
  end if;
  if v_check then
    -- The order identifies its engine through the immutable run. Locking the
    -- engine serializes this check with bulk admission's FOR UPDATE gate.
    select e.strategy_config_pending into v_pending
      from coinops.robot_v1_live_runs r
      join coinops.trading_engines e on e.id = r.trading_engine_id
      where r.id = new.run_id for share of e;
    if v_pending is null then
      raise exception 'COINOPS_STRATEGY_ENGINE_SCOPE_MISSING';
    elsif v_pending then
      raise exception 'COINOPS_STRATEGY_CONFIG_UPDATE_PENDING';
    end if;
  end if;
  return new;
end $$;
revoke all on function private.coinops_strategy_buy_gate() from public, anon, authenticated;
create trigger coinops_strategy_buy_gate before insert or update of submission_guarded_at
  on coinops.robot_v1_live_orders for each row execute function private.coinops_strategy_buy_gate();

-- Persist the immutable operator-approved plan without locking any engine.
-- Separate short transactions admit at most 25 engines each.
create function coinops.enqueue_strategy_bulk_post_ath(
  p_operator_id uuid, p_created_by uuid, p_idempotency_key uuid,
  p_scope jsonb, p_engines jsonb, p_rollback_of uuid default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_operator coinops.operators%rowtype;
  v_batch coinops.strategy_bulk_batches%rowtype;
  v_payload jsonb;
begin
  if coalesce(nullif(current_setting('request.jwt.claim.role',true),''),
    nullif(auth.jwt()->>'role',''),'') <> 'service_role' then
    raise exception 'COINOPS_BULK_ADMIN_REQUIRED'; end if;
  if p_scope is null or jsonb_typeof(p_scope) <> 'object'
    or p_engines is null or jsonb_typeof(p_engines) <> 'array'
    or jsonb_array_length(p_engines) < 1 or jsonb_array_length(p_engines) > 5000
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
revoke all on function coinops.enqueue_strategy_bulk_post_ath(uuid,uuid,uuid,jsonb,jsonb,uuid)
  from public, anon, authenticated;
grant execute on function coinops.enqueue_strategy_bulk_post_ath(uuid,uuid,uuid,jsonb,jsonb,uuid)
  to service_role;

-- One bounded admission transaction per 25 motors. A failed compare-and-set
-- rolls back only that motor's subtransaction and is recorded without gating it.
create function coinops.admit_strategy_bulk_next(p_batch_id uuid, p_created_by uuid)
  returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_batch coinops.strategy_bulk_batches%rowtype;
  v_operator coinops.operators%rowtype;
  v_item jsonb;
  v_engine coinops.trading_engines%rowtype;
  v_profile coinops.robot_v1_ath_profiles%rowtype;
  v_run coinops.robot_v1_live_runs%rowtype;
  v_rate numeric;
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
        and v_item ? 'expected_regime' and v_item ? 'expected_post_ath_spacing_rate'
        and v_item ? 'new_post_ath_spacing_rate')
        then raise exception '%', v_code; end if;
      v_rate := (v_item->>'new_post_ath_spacing_rate')::numeric;
      v_expected := (v_item->>'expected_version')::integer;
      if v_rate is null or v_rate < 0.001 or v_rate > 0.2
        or v_expected is null or v_expected < 1
        then raise exception 'COINOPS_BULK_RATE_OR_VERSION_INVALID'; end if;
      -- Match the runtime's run -> engine lock order. The BUY trigger takes
      -- a share lock on this engine, serializing submission with the gate.
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
      if not found or v_engine.strategy_config_pending
        then raise exception '%', v_code; end if;
      if v_run.exchange_account_id <> v_engine.exchange_account_id
        or v_run.operator_id <> v_batch.operator_id or v_run.symbol <> v_engine.symbol
        or v_run.product_id <> v_operator.product_id
        or v_run.tenant_id <> v_operator.tenant_id
        or v_run.user_id <> v_operator.user_id
        then raise exception 'COINOPS_BULK_RUN_UNAVAILABLE'; end if;
      v_code := 'COINOPS_BULK_PROFILE_CONFLICT';
      select * into v_profile from coinops.robot_v1_ath_profiles
        where trading_engine_id = v_engine.id and environment = 'REAL' for update;
      if not found or v_profile.operator_id <> v_batch.operator_id
        or v_profile.id <> (v_item->>'expected_profile_id')::uuid
        or v_profile.exchange_account_id <> v_engine.exchange_account_id
        or v_profile.product_id <> v_operator.product_id
        or v_profile.tenant_id <> v_operator.tenant_id
        or v_profile.user_id <> v_operator.user_id
        or v_profile.config_version <> v_expected
        or v_profile.regime <> (v_item->>'expected_regime')
        or v_profile.post_ath_spacing_rate <> (v_item->>'expected_post_ath_spacing_rate')::numeric
        or v_profile.next_config_version is not null
        then raise exception '%', v_code; end if;
      v_code := 'COINOPS_BULK_ADMISSION_FAILED';
      insert into coinops.strategy_bulk_engine_updates(batch_id,product_id,tenant_id,user_id,
        operator_id,exchange_account_id,trading_engine_id,run_id,profile_id,symbol,quote_asset,
        strategy_version_before,strategy_version_after,old_values,new_values)
        values(v_batch.id,v_operator.product_id,v_operator.tenant_id,v_operator.user_id,
          v_batch.operator_id,v_engine.exchange_account_id,v_engine.id,v_run.id,v_profile.id,
          v_engine.symbol,v_engine.quote_asset,v_expected,v_expected+1,
          jsonb_build_object('post_ath_spacing_rate',v_profile.post_ath_spacing_rate),
          jsonb_build_object('post_ath_spacing_rate',v_rate));
      update coinops.trading_engines set strategy_config_pending = true, updated_at = now()
        where id = v_engine.id;
    exception when others then
      -- The implicit subtransaction unwinds this motor's locks and writes.
      -- Never persist raw SQL errors, exchange IDs or credentials in metadata.
      v_failures := v_failures || jsonb_build_object(coalesce(v_item->>'engine_id',
        'item-' || v_cursor::text), v_code);
    end;
  end loop;
  update coinops.strategy_bulk_batches set admission_cursor = v_cursor,
    admission_failures = v_failures, updated_at = now(),
    status = case
      when v_cursor < v_total then 'APPLYING'
      when v_failures = '{}'::jsonb and not exists (
        select 1 from coinops.strategy_bulk_engine_updates
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
revoke all on function coinops.admit_strategy_bulk_next(uuid,uuid) from public, anon, authenticated;
grant execute on function coinops.admit_strategy_bulk_next(uuid,uuid) to service_role;

create function coinops.finish_strategy_bulk_engine_update(p_item_id uuid, p_lease_owner uuid)
  returns void language plpgsql security definer set search_path = '' as $$
declare
  v_item coinops.strategy_bulk_engine_updates%rowtype;
  v_run coinops.robot_v1_live_runs%rowtype;
  v_profile coinops.robot_v1_ath_profiles%rowtype;
begin
  if coalesce(nullif(current_setting('request.jwt.claim.role',true),''),
    nullif(auth.jwt()->>'role',''),'') <> 'service_role' then
    raise exception 'COINOPS_BULK_SERVICE_REQUIRED'; end if;
  select * into v_item from coinops.strategy_bulk_engine_updates where id = p_item_id for update;
  if not found or v_item.status not in ('PENDING','APPLYING') then raise exception 'COINOPS_BULK_ITEM_UNAVAILABLE'; end if;
  select * into v_run from coinops.robot_v1_live_runs where id = v_item.run_id for update;
  if not found or v_run.lease_owner <> p_lease_owner
    or v_run.lease_until is null or v_run.lease_until <= now()
    or v_run.config_version <> v_item.strategy_version_after
    or v_run.trading_engine_id <> v_item.trading_engine_id
    then raise exception 'COINOPS_BULK_LEASE_OR_VERSION_INVALID'; end if;
  select * into v_profile from coinops.robot_v1_ath_profiles
    where id = v_item.profile_id for share;
  if not found or v_profile.trading_engine_id <> v_item.trading_engine_id
    or v_profile.config_version <> v_item.strategy_version_after
    or v_profile.post_ath_spacing_rate <> (v_item.new_values->>'post_ath_spacing_rate')::numeric
    then raise exception 'COINOPS_BULK_PROFILE_VERSION_INVALID'; end if;
  if v_run.entry_regime = 'POST_ATH' and exists (select 1 from coinops.robot_v1_live_orders o where o.run_id = v_run.id
    and o.side = 'BUY' and o.status in ('PREPARED','NEW','PARTIALLY_FILLED'))
    then raise exception 'COINOPS_BULK_BUY_STILL_ACTIVE'; end if;
  update coinops.strategy_bulk_engine_updates set status = 'APPLIED', error_code = null,
    applied_at = now(), updated_at = now() where id = v_item.id;
  update coinops.trading_engines set strategy_config_pending = false, updated_at = now()
    where id = v_item.trading_engine_id and operator_id = v_item.operator_id;
  update coinops.strategy_bulk_batches set status = case
    when admission_cursor < jsonb_array_length(request_payload->'engines') then 'APPLYING'
    when admission_failures = '{}'::jsonb and not exists (
      select 1 from coinops.strategy_bulk_engine_updates
      where batch_id = v_item.batch_id and status <> 'APPLIED') then 'APPLIED'
    when admission_failures <> '{}'::jsonb or exists (
      select 1 from coinops.strategy_bulk_engine_updates
      where batch_id = v_item.batch_id and status = 'BLOCKED_SAFE') then 'PARTIAL'
    else 'APPLYING' end,
    applied_at = case when admission_cursor = jsonb_array_length(request_payload->'engines')
      and admission_failures = '{}'::jsonb and not exists (
        select 1 from coinops.strategy_bulk_engine_updates
        where batch_id = v_item.batch_id and status <> 'APPLIED') then now() else null end,
    updated_at = now() where id = v_item.batch_id;
end $$;
revoke all on function coinops.finish_strategy_bulk_engine_update(uuid,uuid) from public, anon, authenticated;
grant execute on function coinops.finish_strategy_bulk_engine_update(uuid,uuid) to service_role;

commit;
