-- Internal CoinOps watchdog audit. No trading state, order or strategy changes.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '60s';

create table coinops.watchdog_checks (
  shard_id text primary key references coinops.executor_shards(id) on delete restrict,
  checked_at timestamptz not null,
  shard_state text not null check (shard_state in
    ('HEALTHY','DEGRADED','RECOVERING','BLOCKED','STALE','OFFLINE','CAPACITY_WARNING','CAPACITY_LIMIT')),
  healthy_engines integer not null default 0 check (healthy_engines >= 0),
  recovering_engines integer not null default 0 check (recovering_engines >= 0),
  blocked_engines integer not null default 0 check (blocked_engines >= 0),
  stale_engines integer not null default 0 check (stale_engines >= 0),
  check_duration_ms integer not null check (check_duration_ms >= 0),
  updated_at timestamptz not null default now()
);

create table coinops.watchdog_incidents (
  incident_id uuid primary key default gen_random_uuid(),
  shard_id text not null references coinops.executor_shards(id) on delete restrict,
  account_id uuid references coinops.exchange_accounts(id) on delete restrict,
  engine_id uuid references coinops.trading_engines(id) on delete restrict,
  market text,
  incident_key text not null check (length(incident_key) between 4 and 160),
  detected_condition text not null,
  severity text not null check (severity in ('WARNING','CRITICAL')),
  state_before text not null,
  state_after text not null,
  actions_taken jsonb not null default '[]'::jsonb check (jsonb_typeof(actions_taken) = 'array'),
  opened_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_recovery_attempt_at timestamptz,
  resolved_at timestamptz,
  recovery_duration_ms bigint check (recovery_duration_ms >= 0),
  result text not null default 'OPEN' check (result in ('OPEN','RECOVERING','RECOVERED','BLOCKED_SAFE','SUPERSEDED')),
  error_code text
);
create unique index watchdog_one_open_incident
  on coinops.watchdog_incidents(shard_id,incident_key) where resolved_at is null;
create index watchdog_incidents_timeline
  on coinops.watchdog_incidents(shard_id,opened_at desc);
create index watchdog_incidents_engine
  on coinops.watchdog_incidents(engine_id,opened_at desc) where engine_id is not null;

alter table coinops.watchdog_checks enable row level security;
alter table coinops.watchdog_checks force row level security;
alter table coinops.watchdog_incidents enable row level security;
alter table coinops.watchdog_incidents force row level security;
revoke all on coinops.watchdog_checks,coinops.watchdog_incidents from public,anon,authenticated;
grant select,insert,update on coinops.watchdog_checks,coinops.watchdog_incidents to service_role;
commit;
