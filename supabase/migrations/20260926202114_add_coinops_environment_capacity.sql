-- Additive telemetry per Binance host/environment. Production retains its
-- original table, collector contract and 900/65% policy without a shared budget.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '60s';

create table coinops.executor_capacity_environment_samples (
  like coinops.executor_capacity_samples including defaults including constraints,
  environment text not null check (environment = 'TESTNET'),
  inventory_source text not null default 'LEDGER_CREDENTIAL_BOUND_TRANSPORT'
    check (inventory_source = 'LEDGER_CREDENTIAL_BOUND_TRANSPORT'),
  primary key(shard_id, environment),
  foreign key(shard_id) references coinops.executor_shards(id) on delete restrict
);
alter table coinops.executor_capacity_environment_samples enable row level security;
alter table coinops.executor_capacity_environment_samples force row level security;
revoke all on coinops.executor_capacity_environment_samples from public, anon, authenticated;
grant select, insert, update on coinops.executor_capacity_environment_samples to service_role;

-- A uniform read shape without copying Production evidence to another budget.
create function coinops.executor_capacity_sample_for_environment(p_shard_id text, p_environment text)
returns setof coinops.executor_capacity_samples language sql stable security invoker set search_path = '' as $$
  select s.* from coinops.executor_capacity_samples s
    where s.shard_id = p_shard_id and p_environment = 'REAL'
  union all
  select (pg_catalog.jsonb_populate_record(null::coinops.executor_capacity_samples, to_jsonb(s))).*
    from coinops.executor_capacity_environment_samples s
    where s.shard_id = p_shard_id and s.environment = p_environment and p_environment = 'TESTNET'
$$;
revoke all on function coinops.executor_capacity_sample_for_environment(text,text) from public, anon, authenticated;
grant execute on function coinops.executor_capacity_sample_for_environment(text,text) to service_role;

create or replace function coinops.reserve_executor_capacity(p_shard_id text, p_engine_id uuid)
returns text language plpgsql security invoker set search_path = '' as $$
declare
  v_shard coinops.executor_shards%rowtype;
  v_sample coinops.executor_capacity_samples%rowtype;
  v_account_shard text;
  v_environment text;
  v_reserved numeric;
  v_projected numeric;
begin
  -- Account lock first matches staged reassignment: admission cannot reserve
  -- the old shard concurrently with an explicitly authorized never-traded move.
  select a.executor_shard_id, e.environment into v_account_shard, v_environment
    from coinops.trading_engines e join coinops.exchange_accounts a on a.id = e.exchange_account_id
   where e.id = p_engine_id and e.operator_id = a.operator_id and e.environment in ('REAL', 'TESTNET')
   for update of a;
  if v_account_shard is null or v_account_shard <> p_shard_id then return 'CAPACITY_UNKNOWN'; end if;
  select * into v_shard from coinops.executor_shards where id = p_shard_id and enabled for update;
  if not found then return 'CAPACITY_UNKNOWN'; end if;
  select * into v_sample from coinops.executor_capacity_sample_for_environment(p_shard_id, v_environment);
  if not found or v_sample.observed_at < now() - interval '120 seconds'
    or v_sample.observed_at > now() + interval '10 seconds'
    or v_sample.heartbeat_at < now() - interval '120 seconds'
    or v_sample.heartbeat_at > now() + interval '10 seconds'
    or v_sample.weight_observed_at is null
    or v_sample.weight_observed_at < now() - interval '120 seconds'
    or v_sample.weight_observed_at > now() + interval '10 seconds'
    or v_sample.binance_weight_samples < 2 or not v_sample.registry_match
    or v_sample.cpu_percent is null or v_sample.cpu_percent < 0 or v_sample.cpu_percent > 100
    or v_sample.ram_used_mb is null or v_sample.ram_used_mb < 0
    or v_sample.ram_limit_mb is null or v_sample.ram_limit_mb <= 0
    or v_sample.binance_weight_current is null or v_sample.binance_weight_average is null
    or v_sample.binance_weight_peak is null
    or least(v_sample.binance_weight_current, v_sample.binance_weight_average,
      v_sample.binance_weight_peak) < 0 then return 'CAPACITY_UNKNOWN'; end if;
  if v_sample.cpu_percent >= 70 or v_sample.ram_used_mb / v_sample.ram_limit_mb >= 0.75
    or v_sample.scheduler_backlog > 0 or v_sample.reconciliation_p95_ms >= 120000
    then return 'CAPACITY_REQUIRED'; end if;
  select coalesce(sum(r.reserved_weight), 0) into v_reserved
    from coinops.executor_capacity_admissions r
   where r.shard_id = p_shard_id and r.environment = v_environment
     and r.engine_id <> p_engine_id and r.expires_at > now()
     and exists (select 1 from coinops.trading_engines e where e.id = r.engine_id and e.environment = v_environment);
  v_projected := greatest(v_sample.binance_weight_current, v_sample.binance_weight_average,
    v_sample.binance_weight_peak) + v_reserved + v_shard.incremental_engine_weight;
  if v_projected > v_shard.binance_limit_per_min * v_shard.admission_ratio
    then return 'CAPACITY_REQUIRED'; end if;
  insert into coinops.executor_capacity_admissions(engine_id, shard_id, environment, reserved_weight, expires_at)
  values(p_engine_id, p_shard_id, v_environment, v_shard.incremental_engine_weight, now() + interval '20 minutes')
  on conflict(engine_id) do update set shard_id = excluded.shard_id, environment = excluded.environment,
    reserved_weight = excluded.reserved_weight, reserved_at = now(), expires_at = excluded.expires_at;
  return 'CAPACITY_OK';
end $$;
revoke all on function coinops.reserve_executor_capacity(text,uuid) from public, anon, authenticated;
grant execute on function coinops.reserve_executor_capacity(text,uuid) to service_role;

create or replace function coinops.assign_executor_shard(p_operator_id uuid, p_account_id uuid,
  p_display_name text, p_environment text, p_planned_engines integer, p_request_id uuid)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_operator coinops.operators%rowtype;
  v_account coinops.exchange_accounts%rowtype;
  v_shard coinops.executor_shards%rowtype;
  v_sample coinops.executor_capacity_samples%rowtype;
  v_reserved numeric;
  v_current numeric;
  v_has_fresh boolean := false;
begin
  if p_account_id is null or p_request_id is null or p_operator_id is null
    or p_display_name is null or length(btrim(p_display_name)) not between 1 and 80
    or p_environment is null or p_environment not in ('REAL', 'TESTNET')
    or p_planned_engines is null or p_planned_engines not between 1 and 2 then
    raise exception 'COINOPS_ADMIN_INTENT_INVALID';
  end if;
  select * into v_operator from coinops.operators where id = p_operator_id and status = 'ACTIVE';
  if not found then raise exception 'COINOPS_ADMIN_OPERATOR_DENIED'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'coinops-shard-assignment:' || p_account_id::text, 0));
  select * into v_account from coinops.exchange_accounts where id = p_account_id;
  if found then
    if v_account.operator_id <> p_operator_id or v_account.is_legacy_default
      or v_account.display_name <> btrim(p_display_name)
      or v_account.onboarding_environment is distinct from p_environment then
      raise exception 'COINOPS_ADMIN_ACCOUNT_DENIED';
    end if;
    select * into v_shard from coinops.executor_shards where id = v_account.executor_shard_id;
    return jsonb_build_object('code', 'ASSIGNED', 'accountId', v_account.id,
      'shardId', v_shard.id, 'executorIp', host(v_shard.egress_ipv4),
      'environment', v_account.onboarding_environment, 'capacityReserved', false);
  end if;
  for v_shard in select s.* from coinops.executor_shards s
    left join lateral coinops.executor_capacity_sample_for_environment(s.id, p_environment) m on true
    where s.enabled
    order by greatest(m.binance_weight_current, m.binance_weight_average,
      m.binance_weight_peak) / s.binance_limit_per_min nulls last, s.id
  loop
    select * into v_sample from coinops.executor_capacity_sample_for_environment(v_shard.id, p_environment);
    if not found or v_sample.observed_at < now() - interval '120 seconds'
      or v_sample.observed_at > now() + interval '10 seconds'
      or v_sample.heartbeat_at < now() - interval '120 seconds'
      or v_sample.heartbeat_at > now() + interval '10 seconds'
      or v_sample.weight_observed_at is null
      or v_sample.weight_observed_at < now() - interval '120 seconds'
      or v_sample.weight_observed_at > now() + interval '10 seconds'
      or v_sample.binance_weight_samples < 2 or not v_sample.registry_match
      or v_sample.cpu_percent is null or v_sample.cpu_percent < 0 or v_sample.cpu_percent > 100
      or v_sample.ram_used_mb is null or v_sample.ram_used_mb < 0
      or v_sample.ram_limit_mb is null or v_sample.ram_limit_mb <= 0
      or v_sample.binance_weight_current is null or v_sample.binance_weight_average is null
      or v_sample.binance_weight_peak is null
      or least(v_sample.binance_weight_current, v_sample.binance_weight_average,
        v_sample.binance_weight_peak) < 0 then continue; end if;
    v_has_fresh := true;
    v_current := greatest(v_sample.binance_weight_current, v_sample.binance_weight_average, v_sample.binance_weight_peak);
    if v_current >= v_shard.binance_limit_per_min * 0.50
      or v_sample.cpu_percent >= 70 or v_sample.ram_used_mb / v_sample.ram_limit_mb >= 0.75
      or v_sample.scheduler_backlog > 0 or v_sample.reconciliation_p95_ms >= 120000 then continue; end if;
    select coalesce(sum(r.reserved_weight), 0) into v_reserved
      from coinops.executor_capacity_admissions r
     where r.shard_id = v_shard.id and r.environment = p_environment and r.expires_at > now()
       and exists (select 1 from coinops.trading_engines e where e.id = r.engine_id and e.environment = p_environment);
    if v_current + v_reserved + v_shard.incremental_engine_weight * p_planned_engines
      > v_shard.binance_limit_per_min * v_shard.admission_ratio then continue; end if;
    insert into coinops.exchange_accounts(id, operator_id, display_name, status, kill_switch,
      is_legacy_default, credential_ref, executor_profile, executor_shard_id, onboarding_environment)
    values(p_account_id, p_operator_id, btrim(p_display_name), 'INACTIVE', true, false,
      'account_' || replace(p_account_id::text, '-', ''), 'coinops-fixed-ip', v_shard.id, p_environment);
    insert into coinops.account_onboarding_checks(operator_id, exchange_account_id, check_key,
      status, evidence, created_by, idempotency_key)
    values(p_operator_id, p_account_id, 'EXECUTOR_ASSIGNMENT', 'PASS',
      jsonb_build_object('executor_shard_id', v_shard.id, 'executor_ip', host(v_shard.egress_ipv4),
        'environment', p_environment, 'planned_engines', p_planned_engines, 'capacity_reserved', false),
      v_operator.user_id, 'shard-assignment:' || p_request_id::text);
    return jsonb_build_object('code', 'ASSIGNED', 'accountId', p_account_id,
      'shardId', v_shard.id, 'executorIp', host(v_shard.egress_ipv4),
      'environment', p_environment, 'capacityReserved', false);
  end loop;
  return jsonb_build_object('code', case when v_has_fresh then 'CAPACITY_REQUIRED' else 'CAPACITY_UNKNOWN' end);
end $$;
revoke all on function coinops.assign_executor_shard(uuid,uuid,text,text,integer,uuid) from public, anon, authenticated;
grant execute on function coinops.assign_executor_shard(uuid,uuid,text,text,integer,uuid) to service_role;
commit;
