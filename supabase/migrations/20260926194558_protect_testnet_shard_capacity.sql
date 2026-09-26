-- Control-plane admission only. Existing execution, recovery and orders do not
-- call this gate. Testnet's Binance budget is independent of Production. New
-- Testnet admission stays UNKNOWN until its own recent telemetry is available;
-- never charge fictitious Testnet weight against Production headroom.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '60s';

-- The previously published reservation RPC only accepted REAL engines, so
-- existing reservations are REAL. Future environment support must stay scoped.
alter table coinops.executor_capacity_admissions
  add column environment text not null default 'REAL' check (environment in ('REAL', 'TESTNET'));

create or replace function coinops.reserve_executor_capacity(p_shard_id text, p_engine_id uuid)
returns text language plpgsql security invoker set search_path = '' as $$
declare
  v_shard coinops.executor_shards%rowtype;
  v_sample coinops.executor_capacity_samples%rowtype;
  v_account_shard text;
  v_reserved numeric;
  v_projected numeric;
begin
  select a.executor_shard_id into v_account_shard
    from coinops.trading_engines e join coinops.exchange_accounts a on a.id = e.exchange_account_id
   where e.id = p_engine_id and e.operator_id = a.operator_id
     and e.environment = 'REAL';
  if v_account_shard is null or v_account_shard <> p_shard_id then return 'CAPACITY_UNKNOWN'; end if;
  select * into v_shard from coinops.executor_shards where id = p_shard_id and enabled for update;
  if not found then return 'CAPACITY_UNKNOWN'; end if;
  select * into v_sample from coinops.executor_capacity_samples where shard_id = p_shard_id for update;
  if not found or v_sample.observed_at < now() - interval '120 seconds'
    or v_sample.observed_at > now() + interval '10 seconds'
    or v_sample.heartbeat_at < now() - interval '120 seconds'
    or v_sample.heartbeat_at > now() + interval '10 seconds'
    or v_sample.weight_observed_at is null
    or v_sample.weight_observed_at < now() - interval '120 seconds'
    or v_sample.weight_observed_at > now() + interval '10 seconds'
    or v_sample.binance_weight_samples < 2
    or not v_sample.registry_match
    or v_sample.cpu_percent is null or v_sample.cpu_percent < 0 or v_sample.cpu_percent > 100
    or v_sample.ram_used_mb is null or v_sample.ram_used_mb < 0
    or v_sample.ram_limit_mb is null or v_sample.ram_limit_mb <= 0
    or v_sample.binance_weight_current is null
    or v_sample.binance_weight_average is null
    or v_sample.binance_weight_peak is null
    or least(v_sample.binance_weight_current, v_sample.binance_weight_average,
      v_sample.binance_weight_peak) < 0 then return 'CAPACITY_UNKNOWN'; end if;
  if v_sample.cpu_percent >= 70 or v_sample.ram_used_mb / v_sample.ram_limit_mb >= 0.75
    or v_sample.scheduler_backlog > 0 or v_sample.reconciliation_p95_ms >= 120000
    then return 'CAPACITY_REQUIRED'; end if;
  select coalesce(sum(r.reserved_weight), 0) into v_reserved
    from coinops.executor_capacity_admissions r
   where r.shard_id = p_shard_id and r.engine_id <> p_engine_id and r.expires_at > now()
     and r.environment = 'REAL'
     and exists (select 1 from coinops.trading_engines e where e.id = r.engine_id and e.environment = 'REAL');
  v_projected := greatest(v_sample.binance_weight_current, v_sample.binance_weight_average,
    v_sample.binance_weight_peak) + v_reserved + v_shard.incremental_engine_weight;
  if v_projected > v_shard.binance_limit_per_min * v_shard.admission_ratio
    then return 'CAPACITY_REQUIRED'; end if;
  insert into coinops.executor_capacity_admissions(engine_id, shard_id, environment, reserved_weight, expires_at)
  values(p_engine_id, p_shard_id, 'REAL', v_shard.incremental_engine_weight, now() + interval '20 minutes')
  on conflict(engine_id) do update set shard_id = excluded.shard_id,
    environment = excluded.environment, reserved_weight = excluded.reserved_weight,
    reserved_at = now(), expires_at = excluded.expires_at;
  return 'CAPACITY_OK';
end $$;
revoke all on function coinops.reserve_executor_capacity(text,uuid) from public, anon, authenticated;
grant execute on function coinops.reserve_executor_capacity(text,uuid) to service_role;
commit;
