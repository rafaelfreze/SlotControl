-- Public-asset observations only. No trading state, account credentials or orders.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '60s';

create table coinops.asset_health_collector_state (
  id text primary key default 'default' check (id = 'default'),
  last_run_at timestamptz,
  last_success_at timestamptz,
  status text not null default 'NOT_RUN'
    check (status in ('NOT_RUN','RUNNING','HEALTHY','DEGRADED','FAILED')),
  last_error_code text,
  last_duration_ms integer check (last_duration_ms >= 0),
  source_failures integer not null default 0 check (source_failures >= 0),
  cadence_completed_at jsonb not null default '{}'::jsonb
    check (jsonb_typeof(cadence_completed_at) = 'object'),
  lease_token uuid,
  lease_until timestamptz,
  watchdog_checked_at timestamptz,
  watchdog_status text,
  check ((lease_token is null) = (lease_until is null))
);
insert into coinops.asset_health_collector_state(id) values ('default');

create table coinops.asset_health_snapshots (
  id uuid primary key default gen_random_uuid(),
  asset text not null check (asset in ('BTC','SOL')),
  assessment jsonb not null check (jsonb_typeof(assessment) = 'object'),
  evaluated_at timestamptz not null,
  status text not null check (status in ('HEALTHY','ATTENTION','STRUCTURAL_RISK','INSUFFICIENT_DATA')),
  created_at timestamptz not null default now(),
  unique (id, asset),
  check (assessment->>'asset' is not null and assessment->>'asset' = asset),
  check (assessment->>'status' is not null and assessment->>'status' = status)
);
create index asset_health_snapshots_asset_evaluated on coinops.asset_health_snapshots(asset, evaluated_at desc);

create table coinops.asset_health_current (
  asset text primary key check (asset in ('BTC','SOL')),
  snapshot_id uuid not null unique,
  assessment jsonb not null check (jsonb_typeof(assessment) = 'object'),
  foreign key (snapshot_id,asset) references coinops.asset_health_snapshots(id,asset) on delete restrict,
  check (assessment->>'asset' is not null and assessment->>'asset' = asset)
);

create table coinops.asset_health_events (
  id uuid primary key default gen_random_uuid(),
  snapshot_id uuid not null unique,
  asset text not null check (asset in ('BTC','SOL')),
  status_before text not null check (status_before in ('HEALTHY','ATTENTION','STRUCTURAL_RISK','INSUFFICIENT_DATA')),
  status_after text not null check (status_after in ('HEALTHY','ATTENTION','STRUCTURAL_RISK','INSUFFICIENT_DATA')),
  reasons jsonb not null default '[]'::jsonb check (jsonb_typeof(reasons) = 'array'),
  trigger text not null,
  created_at timestamptz not null default now(),
  foreign key (snapshot_id,asset) references coinops.asset_health_snapshots(id,asset) on delete restrict,
  check (status_before <> status_after)
);
create index asset_health_events_asset_created on coinops.asset_health_events(asset, created_at desc);

create table coinops.asset_health_deliveries (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references coinops.asset_health_events(id) on delete restrict,
  subscription_id uuid not null references coinops.operator_push_subscriptions(id) on delete restrict,
  status text not null default 'PENDING' check (status in ('PENDING','SENDING','SENT','FAILED','EXPIRED')),
  attempt_count integer not null default 0 check (attempt_count between 0 and 5),
  next_attempt_at timestamptz not null default now(),
  lease_token uuid,
  lease_until timestamptz,
  sent_at timestamptz,
  error_code text,
  created_at timestamptz not null default now(),
  unique (event_id, subscription_id)
);
create index asset_health_deliveries_due on coinops.asset_health_deliveries(next_attempt_at,lease_until)
  where status in ('PENDING','SENDING');
create index asset_health_deliveries_subscription on coinops.asset_health_deliveries(subscription_id);

-- One collector only; failed/crashed attempts also respect the request-budget spacing.
create function coinops.asset_health_claim(p_token uuid) returns boolean
language plpgsql security invoker set search_path = '' as $$
begin
  if p_token is null then raise exception 'ASSET_HEALTH_TOKEN_REQUIRED'; end if;
  update coinops.asset_health_collector_state
    set lease_token=p_token, lease_until=clock_timestamp()+interval '5 minutes',
      last_run_at=clock_timestamp(), status='RUNNING', last_error_code=null
    where id='default'
      and (lease_until is null or lease_until <= clock_timestamp())
      and (last_run_at is null or last_run_at <= clock_timestamp()-interval '20 minutes');
  return found;
end $$;

create function coinops.asset_health_finish(
  p_token uuid, p_snapshots jsonb, p_cadences jsonb, p_duration_ms integer
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare
  v_state coinops.asset_health_collector_state%rowtype;
  v_assessment jsonb;
  v_asset text;
  v_status text;
  v_previous text;
  v_evaluated timestamptz;
  v_previous_evaluated timestamptz;
  v_snapshot_id uuid;
  v_cadence record;
  v_source_failures integer;
begin
  select * into v_state from coinops.asset_health_collector_state where id='default' for update;
  if not found or p_token is null or v_state.lease_token is distinct from p_token
    or v_state.lease_until is null or v_state.lease_until <= clock_timestamp() then return false; end if;
  if p_snapshots is null or jsonb_typeof(p_snapshots) <> 'array'
    or jsonb_array_length(p_snapshots) not between 1 and 2
    or p_cadences is null or jsonb_typeof(p_cadences) <> 'object'
    or p_duration_ms is null or p_duration_ms < 0 then
    raise exception 'ASSET_HEALTH_INVALID_PAYLOAD';
  end if;
  if (select count(distinct value->>'asset') from jsonb_array_elements(p_snapshots))
    <> jsonb_array_length(p_snapshots) then raise exception 'ASSET_HEALTH_DUPLICATE_ASSET'; end if;
  for v_cadence in select key,value from jsonb_each_text(p_cadences) loop
    if v_cadence.key not in ('FAST','STRUCTURAL','DEVELOPMENT') or v_cadence.value is null
      or not isfinite(v_cadence.value::timestamptz)
      or v_cadence.value::timestamptz > clock_timestamp()+interval '1 minute'
      or v_cadence.value::timestamptz < coalesce((v_state.cadence_completed_at->>v_cadence.key)::timestamptz,'-infinity'::timestamptz)
      then raise exception 'ASSET_HEALTH_INVALID_CADENCE'; end if;
  end loop;
  for v_assessment in select value from jsonb_array_elements(p_snapshots) loop
    v_asset := v_assessment->>'asset'; v_status := v_assessment->>'status';
    if jsonb_typeof(v_assessment) <> 'object' or v_asset is null or v_asset not in ('BTC','SOL')
      or v_status is null or v_status not in ('HEALTHY','ATTENTION','STRUCTURAL_RISK','INSUFFICIENT_DATA')
      or jsonb_typeof(v_assessment->'metrics') is distinct from 'array'
      or jsonb_typeof(v_assessment->'reasons') is distinct from 'array'
      or v_assessment->>'trigger' is null or v_assessment->>'evaluatedAt' is null then
      raise exception 'ASSET_HEALTH_INVALID_ASSESSMENT';
    end if;
    v_evaluated := (v_assessment->>'evaluatedAt')::timestamptz;
    if not isfinite(v_evaluated) or v_evaluated > clock_timestamp()+interval '1 minute' then
      raise exception 'ASSET_HEALTH_INVALID_EVALUATED_AT'; end if;
    select c.assessment->>'status',s.evaluated_at into v_previous,v_previous_evaluated
      from coinops.asset_health_current c join coinops.asset_health_snapshots s on s.id=c.snapshot_id
      where c.asset=v_asset;
    if v_previous_evaluated is not null and v_evaluated <= v_previous_evaluated then
      raise exception 'ASSET_HEALTH_OBSERVATION_NOT_NEWER'; end if;
    insert into coinops.asset_health_snapshots(asset,assessment,evaluated_at,status)
      values(v_asset,v_assessment,v_evaluated,v_status) returning id into v_snapshot_id;
    -- First observation is not a transition: no bootstrap push.
    if v_previous is not null and v_previous <> v_status then
      insert into coinops.asset_health_events(snapshot_id,asset,status_before,status_after,reasons,trigger)
        values(v_snapshot_id,v_asset,v_previous,v_status,v_assessment->'reasons',v_assessment->>'trigger');
    end if;
    insert into coinops.asset_health_current(asset,snapshot_id,assessment)
      values(v_asset,v_snapshot_id,v_assessment)
      on conflict(asset) do update set snapshot_id=excluded.snapshot_id,assessment=excluded.assessment;
  end loop;
  select count(distinct m#>>'{source,id}')::integer into v_source_failures
    from coinops.asset_health_current c cross join lateral jsonb_array_elements(c.assessment->'metrics') m
    where m->'optional' is distinct from 'true'::jsonb
      and (m->>'collectionStatus'='SOURCE_UNAVAILABLE' or m->>'status' in ('SOURCE_UNAVAILABLE','DATA_STALE'));
  -- Fencing is checked again before commit; expiry rolls back the entire transaction.
  if v_state.lease_until <= clock_timestamp() then raise exception 'ASSET_HEALTH_LEASE_EXPIRED'; end if;
  update coinops.asset_health_collector_state set
    last_success_at=clock_timestamp(), status=case when v_source_failures > 0 then 'DEGRADED' else 'HEALTHY' end,
    last_error_code=case when v_source_failures > 0 then 'ASSET_HEALTH_SOURCE_UNAVAILABLE' else null end,
    last_duration_ms=p_duration_ms, source_failures=v_source_failures,
    cadence_completed_at=cadence_completed_at||p_cadences, lease_token=null,lease_until=null where id='default';
  return true;
end $$;

create function coinops.asset_health_fail(p_token uuid,p_error_code text,p_duration_ms integer default null)
returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  update coinops.asset_health_collector_state set status='FAILED',
    last_error_code=case when p_error_code ~ '^[A-Z0-9_:-]{1,160}$' then p_error_code else 'ASSET_HEALTH_COLLECTION_FAILED' end,
    last_duration_ms=greatest(coalesce(p_duration_ms,0),0),lease_token=null,lease_until=null
    where id='default' and lease_token=p_token and lease_until>clock_timestamp();
  return found;
end $$;

-- Append-only source evidence and state-transition audit, even for the server role.
create function coinops.asset_health_history_immutable() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin raise exception 'ASSET_HEALTH_HISTORY_IMMUTABLE'; end $$;
create trigger asset_health_snapshots_immutable before update or delete on coinops.asset_health_snapshots
  for each row execute function coinops.asset_health_history_immutable();
create trigger asset_health_events_immutable before update or delete on coinops.asset_health_events
  for each row execute function coinops.asset_health_history_immutable();

alter table coinops.asset_health_collector_state enable row level security;
alter table coinops.asset_health_collector_state force row level security;
alter table coinops.asset_health_snapshots enable row level security;
alter table coinops.asset_health_snapshots force row level security;
alter table coinops.asset_health_current enable row level security;
alter table coinops.asset_health_current force row level security;
alter table coinops.asset_health_events enable row level security;
alter table coinops.asset_health_events force row level security;
alter table coinops.asset_health_deliveries enable row level security;
alter table coinops.asset_health_deliveries force row level security;

revoke all on coinops.asset_health_collector_state,coinops.asset_health_snapshots,coinops.asset_health_current,
  coinops.asset_health_events,coinops.asset_health_deliveries from public,anon,authenticated,service_role;
grant select,insert,update on coinops.asset_health_collector_state,coinops.asset_health_current,coinops.asset_health_deliveries to service_role;
grant select,insert on coinops.asset_health_snapshots,coinops.asset_health_events to service_role;
revoke all on function coinops.asset_health_claim(uuid),coinops.asset_health_finish(uuid,jsonb,jsonb,integer),
  coinops.asset_health_fail(uuid,text,integer),coinops.asset_health_history_immutable() from public,anon,authenticated;
grant execute on function coinops.asset_health_claim(uuid),coinops.asset_health_finish(uuid,jsonb,jsonb,integer),
  coinops.asset_health_fail(uuid,text,integer) to service_role;

comment on table coinops.asset_health_snapshots is 'Append-only public-source asset observations; never a trading directive.';
comment on table coinops.asset_health_collector_state is 'Independent low-frequency collector and freshness watchdog; no trading dependency.';
commit;
