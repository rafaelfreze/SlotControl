-- Capacity control plane only: no order, cycle, slot or trading flag is changed.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '60s';

create table coinops.executor_shards (
  id text primary key check (id ~ '^executor-[0-9]{2,}$'),
  egress_ipv4 inet not null unique,
  enabled boolean not null default true,
  binance_limit_per_min integer not null default 6000 check (binance_limit_per_min > 0),
  admission_ratio numeric(5,4) not null default 0.65 check (admission_ratio > 0 and admission_ratio <= 0.75),
  incremental_engine_weight integer not null default 900 check (incremental_engine_weight > 0),
  created_at timestamptz not null default now()
);
insert into coinops.executor_shards(id, egress_ipv4) values ('executor-01', '46.101.104.48');
alter table coinops.exchange_accounts
  add column executor_shard_id text not null default 'executor-01'
  references coinops.executor_shards(id) on delete restrict;
create index exchange_accounts_executor_shard on coinops.exchange_accounts(executor_shard_id);

create table coinops.executor_capacity_samples (
  shard_id text primary key references coinops.executor_shards(id) on delete restrict,
  observed_at timestamptz not null,
  heartbeat_at timestamptz not null,
  weight_observed_at timestamptz,
  binance_weight_current numeric(12,2),
  binance_weight_average numeric(12,2),
  binance_weight_peak numeric(12,2),
  binance_weight_samples integer not null default 0 check (binance_weight_samples >= 0),
  cpu_percent numeric(7,3),
  ram_used_mb numeric(12,2),
  ram_limit_mb numeric(12,2),
  account_count integer not null default 0 check (account_count >= 0),
  engine_count integer not null default 0 check (engine_count >= 0),
  registry_match boolean not null default false,
  scheduler_backlog integer not null default 0 check (scheduler_backlog >= 0),
  reconciliation_p95_ms integer not null default 0 check (reconciliation_p95_ms >= 0),
  reconciliation_age_ms integer not null default 0 check (reconciliation_age_ms >= 0),
  errors_last_5m integer not null default 0 check (errors_last_5m >= 0),
  retries_last_5m integer not null default 0 check (retries_last_5m >= 0),
  executor_version text,
  updated_at timestamptz not null default now()
);

create table coinops.executor_capacity_admissions (
  engine_id uuid primary key references coinops.trading_engines(id) on delete restrict,
  shard_id text not null references coinops.executor_shards(id) on delete restrict,
  reserved_weight integer not null check (reserved_weight > 0),
  reserved_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index executor_capacity_admissions_active on coinops.executor_capacity_admissions(shard_id, expires_at);

create table coinops.executor_capacity_alerts (
  id uuid primary key default gen_random_uuid(),
  shard_id text not null references coinops.executor_shards(id) on delete restrict,
  code text not null check (code in ('BINANCE_WEIGHT_WARNING','EXECUTOR_CAPACITY_WARNING','CAPACITY_LIMIT')),
  severity text not null check (severity in ('WARNING','CRITICAL')),
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  resolved_at timestamptz,
  unique(shard_id, code)
);
create index executor_capacity_alerts_open on coinops.executor_capacity_alerts(shard_id, last_seen_at desc)
  where resolved_at is null;
create function private.coinops_capacity_new_incident() returns trigger language plpgsql
  set search_path = '' as $$
begin
  if old.resolved_at is not null and new.resolved_at is null then
    new.first_seen_at := now();
  end if;
  return new;
end $$;
revoke all on function private.coinops_capacity_new_incident() from public, anon, authenticated;
create trigger executor_capacity_new_incident before update on coinops.executor_capacity_alerts
  for each row execute function private.coinops_capacity_new_incident();

create table coinops.executor_capacity_deliveries (
  id uuid primary key default gen_random_uuid(),
  alert_id uuid not null references coinops.executor_capacity_alerts(id) on delete restrict,
  opened_at timestamptz not null,
  subscription_id uuid not null references coinops.operator_push_subscriptions(id) on delete restrict,
  status text not null default 'PENDING' check (status in ('PENDING','SENDING','SENT','FAILED','EXPIRED')),
  attempted_at timestamptz,
  sent_at timestamptz,
  lease_until timestamptz,
  next_attempt_at timestamptz not null default now(),
  attempt_count integer not null default 0 check (attempt_count between 0 and 5),
  error_code text,
  created_at timestamptz not null default now(),
  unique(alert_id, opened_at, subscription_id)
);
create index executor_capacity_deliveries_pending on coinops.executor_capacity_deliveries(status, next_attempt_at)
  where status in ('PENDING','SENDING');

-- Serialize all admissions for a shard on its sample row. A failed activation
-- retains the reservation temporarily; existing engines and orders are untouched.
create function coinops.reserve_executor_capacity(p_shard_id text, p_engine_id uuid)
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
   where e.id = p_engine_id and e.environment = 'REAL';
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
    or v_sample.ram_limit_mb is null
    or v_sample.ram_limit_mb <= 0
    or v_sample.binance_weight_current is null
    or v_sample.binance_weight_average is null
    or v_sample.binance_weight_peak is null
    or least(v_sample.binance_weight_current, v_sample.binance_weight_average,
      v_sample.binance_weight_peak) < 0 then return 'CAPACITY_UNKNOWN'; end if;
  if v_sample.cpu_percent >= 70 or v_sample.ram_used_mb / v_sample.ram_limit_mb >= 0.75
    or v_sample.scheduler_backlog > 0 or v_sample.reconciliation_p95_ms >= 120000
    then return 'CAPACITY_REQUIRED'; end if;
  select coalesce(sum(reserved_weight), 0) into v_reserved
    from coinops.executor_capacity_admissions
   where shard_id = p_shard_id and engine_id <> p_engine_id and expires_at > now();
  v_projected := greatest(v_sample.binance_weight_current, v_sample.binance_weight_average,
    v_sample.binance_weight_peak) + v_reserved + v_shard.incremental_engine_weight;
  if v_projected > v_shard.binance_limit_per_min * v_shard.admission_ratio
    then return 'CAPACITY_REQUIRED'; end if;
  insert into coinops.executor_capacity_admissions(engine_id, shard_id, reserved_weight, expires_at)
  values(p_engine_id, p_shard_id, v_shard.incremental_engine_weight, now() + interval '20 minutes')
  on conflict(engine_id) do update set shard_id = excluded.shard_id,
    reserved_weight = excluded.reserved_weight, reserved_at = now(), expires_at = excluded.expires_at;
  return 'CAPACITY_OK';
end $$;
revoke all on function coinops.reserve_executor_capacity(text,uuid) from public, anon, authenticated;
grant execute on function coinops.reserve_executor_capacity(text,uuid) to service_role;

do $$ declare t text; begin
  foreach t in array array['executor_shards','executor_capacity_samples','executor_capacity_admissions',
    'executor_capacity_alerts','executor_capacity_deliveries'] loop
    execute format('alter table coinops.%I enable row level security', t);
    execute format('alter table coinops.%I force row level security', t);
    execute format('revoke all on coinops.%I from public, anon, authenticated', t);
    execute format('grant select, insert, update on coinops.%I to service_role', t);
  end loop;
end $$;
commit;
