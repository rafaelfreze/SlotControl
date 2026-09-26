-- Additive control-plane routing. No engine, credential, order, cycle or balance
-- is migrated. An assignment is an immutable IP binding, not a capacity booking.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '60s';

alter table coinops.exchange_accounts add column onboarding_environment text
  check (onboarding_environment in ('REAL', 'TESTNET'));

create function private.coinops_primary_shard_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.executor_shard_id is distinct from old.executor_shard_id then
    raise exception 'COINOPS_SHARD_REASSIGNMENT_FORBIDDEN';
  end if;
  if old.onboarding_environment is not null
    and new.onboarding_environment is distinct from old.onboarding_environment then
    raise exception 'COINOPS_ADMIN_ENVIRONMENT_MISMATCH';
  end if;
  return new;
end $$;
revoke all on function private.coinops_primary_shard_immutable() from public, anon, authenticated;
create trigger exchange_accounts_primary_shard_immutable before update
  on coinops.exchange_accounts for each row execute function private.coinops_primary_shard_immutable();

-- Server-only RPC. Auth/tenant/operator membership is resolved in the API before
-- calling this function. Direct authenticated/anonymous invocation is forbidden.
create function coinops.assign_executor_shard(p_operator_id uuid, p_account_id uuid,
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
  -- Serialize retries of this identity only, never an unrelated account/engine.
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

  -- Existing assignments are returned above, without migration. A new Testnet
  -- account cannot use Production telemetry as proof of an independent budget.
  if p_environment = 'TESTNET' then return jsonb_build_object('code', 'CAPACITY_UNKNOWN'); end if;

  -- Choose a HEALTHY shard using each IP's own budget. No summed/shared budgets,
  -- hardcoded executor02, implicit migration or reassignment of existing rows.
  for v_shard in select s.* from coinops.executor_shards s
    left join coinops.executor_capacity_samples m on m.shard_id = s.id
    where s.enabled
    order by greatest(m.binance_weight_current, m.binance_weight_average,
      m.binance_weight_peak) / s.binance_limit_per_min nulls last, s.id
  loop
    select * into v_sample from coinops.executor_capacity_samples where shard_id = v_shard.id;
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
    v_current := greatest(v_sample.binance_weight_current, v_sample.binance_weight_average,
      v_sample.binance_weight_peak);
    if v_current >= v_shard.binance_limit_per_min * 0.50
      or v_sample.cpu_percent >= 70 or v_sample.ram_used_mb / v_sample.ram_limit_mb >= 0.75
      or v_sample.scheduler_backlog > 0 or v_sample.reconciliation_p95_ms >= 120000
      then continue; end if;
    select coalesce(sum(r.reserved_weight), 0) into v_reserved
      from coinops.executor_capacity_admissions r where r.shard_id = v_shard.id and r.expires_at > now()
       and exists (select 1 from coinops.trading_engines e where e.id = r.engine_id and e.environment = 'REAL');
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
revoke all on function coinops.assign_executor_shard(uuid,uuid,text,text,integer,uuid)
  from public, anon, authenticated;
grant execute on function coinops.assign_executor_shard(uuid,uuid,text,text,integer,uuid) to service_role;

alter table coinops.executor_capacity_alerts drop constraint executor_capacity_alerts_code_check;
alter table coinops.executor_capacity_alerts add constraint executor_capacity_alerts_code_check
  check (code in ('BINANCE_WEIGHT_WARNING', 'EXECUTOR_CAPACITY_WARNING', 'CAPACITY_LIMIT',
    'EXECUTOR_OFFLINE', 'SCHEDULER_BACKLOG_WARNING', 'ENGINE_STALE', 'EXECUTOR_RESOURCE_WARNING'));
commit;
