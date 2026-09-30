-- Control-plane only: no account/engine/order/slot/lease/credential mutation.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '60s';

create or replace function coinops.executor_capacity_policy()
returns jsonb language sql immutable security invoker set search_path = '' as $$
  select '{"version":"capacity-v3-20260930","binance_limit":6000,"incremental_weight":900,"incremental_source":"CONSERVATIVE_UNCALIBRATED","observe_ratio":0.50,"warning_ratio":0.65,"capacity_ratio":0.75,"admission_ratio":0.65,"recovery_ratio":0.35,"telemetry_max_age_seconds":120,"cpu_max_percent":70,"ram_max_percent":75,"reconciliation_max_ms":120000,"pressure_window_minutes":15,"minimum_weight_samples":15,"reopen_ratio":0.60,"reopen_healthy_seconds":600,"hard_current_ratio":0.75,"hard_projected_ratio":0.90,"peak_hold_minutes":15}'::jsonb
$$;

create table coinops.executor_admission_hysteresis (
  shard_id text not null references coinops.executor_shards(id) on delete restrict,
  environment text not null check(environment in ('REAL','TESTNET')),
  planned_engines integer not null check(planned_engines between 1 and 25),
  allowed boolean not null default false,
  healthy_since timestamptz,
  blocked_since timestamptz,
  last_transition_at timestamptz not null,
  sample_at timestamptz not null,
  sustained_weight numeric,
  executor_state text not null,
  reason text not null,
  policy_version text not null,
  primary key(shard_id,environment,planned_engines)
);
create table coinops.executor_capacity_observations (
  shard_id text not null references coinops.executor_shards(id) on delete restrict,
  environment text not null check(environment in ('REAL','TESTNET')),
  observed_at timestamptz not null,
  current_weight numeric,
  sustained_weight numeric,
  peak_weight numeric,
  weight_samples integer,
  engine_count integer,
  primary key(shard_id,environment,observed_at)
);
create table coinops.executor_admission_transitions (
  id bigint generated always as identity primary key,
  shard_id text not null references coinops.executor_shards(id) on delete restrict,
  environment text not null check(environment in ('REAL','TESTNET')),
  planned_engines integer not null,
  transitioned_at timestamptz not null,
  allowed boolean not null,
  reason text not null,
  sustained_weight numeric,
  projected_weight numeric,
  policy_version text not null
);
create index executor_admission_transitions_scope on coinops.executor_admission_transitions(shard_id,environment,transitioned_at);
alter table coinops.executor_admission_hysteresis enable row level security;
alter table coinops.executor_admission_hysteresis force row level security;
alter table coinops.executor_capacity_observations enable row level security;
alter table coinops.executor_capacity_observations force row level security;
alter table coinops.executor_admission_transitions enable row level security;
alter table coinops.executor_admission_transitions force row level security;
revoke all on coinops.executor_admission_hysteresis,coinops.executor_capacity_observations,coinops.executor_admission_transitions from public,anon,authenticated;
grant select,insert,update on coinops.executor_admission_hysteresis to service_role;
grant select,insert,delete on coinops.executor_capacity_observations to service_role;
grant select,insert on coinops.executor_admission_transitions to service_role;
grant usage,select on sequence coinops.executor_admission_transitions_id_seq to service_role;

-- One classifier shared by persistence, preview and the ADMIN API. The rolling
-- mean already averages maxima from each observed UTC minute, not raw counters.
-- Historical peaks may elevate OBSERVE, but cannot promote WARNING/LIMIT.
create function coinops.executor_capacity_sample_safety(m coinops.executor_capacity_samples)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare p jsonb:=coinops.executor_capacity_policy(); r text; state text; action text:='NONE';
begin
  if m.shard_id is null or m.observed_at not between now()-interval '120 seconds' and now()+interval '10 seconds'
    or m.heartbeat_at not between now()-interval '120 seconds' and now()+interval '10 seconds'
    or m.weight_observed_at is null or m.weight_observed_at not between now()-interval '120 seconds' and now()+interval '10 seconds'
    or m.registry_match is distinct from true or coalesce(m.binance_weight_samples,0)<(p->>'minimum_weight_samples')::int
    or m.cpu_percent is null or m.cpu_percent not between 0 and 100
    or m.ram_used_mb is null or m.ram_used_mb<0 or m.ram_limit_mb is null or m.ram_limit_mb<=0
    or m.binance_weight_current is null or m.binance_weight_average is null or m.binance_weight_peak is null
    or least(m.binance_weight_current,m.binance_weight_average,m.binance_weight_peak)<0 then
    return jsonb_build_object('state','OFFLINE','action','INVESTIGATE','reason','CAPACITY_TELEMETRY_MISSING_OR_STALE');
  end if;
  state:=case
    when greatest(m.binance_weight_current,m.binance_weight_average)>=(p->>'binance_limit')::numeric*(p->>'capacity_ratio')::numeric then 'CAPACITY_LIMIT'
    when m.binance_weight_average>=(p->>'binance_limit')::numeric*(p->>'warning_ratio')::numeric then 'WARNING'
    when greatest(m.binance_weight_current,m.binance_weight_average,m.binance_weight_peak)>=(p->>'binance_limit')::numeric*(p->>'observe_ratio')::numeric then 'OBSERVE'
    else 'HEALTHY' end;
  if m.binance_weight_current>=(p->>'binance_limit')::numeric*(p->>'hard_current_ratio')::numeric then r:='BINANCE_WEIGHT_CRITICAL_NOW';
  elsif m.cpu_percent>=(p->>'cpu_max_percent')::numeric or m.ram_used_mb/m.ram_limit_mb*100>=(p->>'ram_max_percent')::numeric then r:='EXECUTOR_RESOURCE_HEADROOM_LOW'; action:='SCALE_UP';
  elsif m.scheduler_backlog>0 or m.reconciliation_p95_ms>=(p->>'reconciliation_max_ms')::numeric then r:='SCHEDULER_OR_RECONCILIATION_SLOW'; action:='INVESTIGATE';
  elsif m.errors_last_5m>0 or m.retries_last_5m>0 then r:='RECENT_TRANSPORT_ERRORS'; action:='INVESTIGATE';
  end if;
  if r is not null and state in ('HEALTHY','OBSERVE') then state:='WARNING'; end if;
  if action='NONE' and state in ('WARNING','CAPACITY_LIMIT') then action:='SCALE_OUT'; end if;
  return jsonb_build_object('state',state,'action',action,'reason',r);
end $$;
revoke all on function coinops.executor_capacity_sample_safety(coinops.executor_capacity_samples) from public,anon,authenticated;
grant execute on function coinops.executor_capacity_sample_safety(coinops.executor_capacity_samples) to service_role;

-- Only a new collector observation advances the clock. Page reads never write
-- or accrue recovery time. Gaps >120s reset the healthy interval; out-of-order
-- and replayed samples cannot shorten recovery. Generic 1..25 requests are the
-- existing RPC contract, not a quota on the number of engines in a shard.
create function coinops.advance_executor_admission_hysteresis()
returns trigger language plpgsql security invoker set search_path = '' as $$
<<hysteresis>>
declare
  m coinops.executor_capacity_samples%rowtype;
  h coinops.executor_admission_hysteresis%rowtype;
  p jsonb:=coinops.executor_capacity_policy(); safety jsonb;
  env text; n integer; projected numeric; reason text; previous_allowed boolean;
begin
  env:=case when tg_table_name='executor_capacity_samples' then 'REAL' else to_jsonb(new)->>'environment' end;
  m:=jsonb_populate_record(null::coinops.executor_capacity_samples,to_jsonb(new));
  safety:=coinops.executor_capacity_sample_safety(m);
  insert into coinops.executor_capacity_observations(shard_id,environment,observed_at,current_weight,sustained_weight,peak_weight,weight_samples,engine_count)
  values(m.shard_id,env,m.observed_at,m.binance_weight_current,m.binance_weight_average,m.binance_weight_peak,m.binance_weight_samples,m.engine_count)
  on conflict do nothing;
  -- Bounded operational telemetry; transition evidence remains append-only.
  delete from coinops.executor_capacity_observations where shard_id=m.shard_id and environment=env and observed_at<now()-interval '24 hours';
  for n in 1..25 loop
    insert into coinops.executor_admission_hysteresis(shard_id,environment,planned_engines,last_transition_at,sample_at,executor_state,reason,policy_version)
    values(m.shard_id,env,n,m.observed_at,m.observed_at-interval '1 microsecond',safety->>'state','RECOVERY_STABILIZING',p->>'version')
    on conflict do nothing;
    select * into h from coinops.executor_admission_hysteresis where shard_id=m.shard_id and environment=env and planned_engines=n for update;
    if m.observed_at<=h.sample_at then continue; end if;
    previous_allowed:=h.allowed;
    if m.observed_at-h.sample_at>interval '120 seconds' or h.policy_version<>p->>'version' then
      h.allowed:=false; h.healthy_since:=null; h.blocked_since:=m.observed_at;
    end if;
    projected:=m.binance_weight_average+n*(p->>'incremental_weight')::numeric;
    reason:=safety->>'reason';
    if reason is null and m.binance_weight_current+n*(p->>'incremental_weight')::numeric>=(p->>'binance_limit')::numeric*(p->>'hard_projected_ratio')::numeric then reason:='BINANCE_PROJECTED_CRITICAL_NOW'; end if;
    if reason is null and projected>(p->>'binance_limit')::numeric*(p->>'admission_ratio')::numeric then reason:='SUSTAINED_PROJECTION_ABOVE_ADMISSION_LIMIT'; end if;
    if reason is not null then
      h.allowed:=false; h.healthy_since:=null; h.blocked_since:=coalesce(h.blocked_since,m.observed_at);
    elsif h.allowed then
      reason:='SUSTAINED_HEADROOM_AVAILABLE';
    elsif projected<=(p->>'binance_limit')::numeric*(p->>'reopen_ratio')::numeric then
      if h.healthy_since is null or m.observed_at-h.sample_at>interval '120 seconds' or h.policy_version<>p->>'version' then h.healthy_since:=m.observed_at; end if;
      if m.observed_at-h.healthy_since>=make_interval(secs=>(p->>'reopen_healthy_seconds')::int) then
        h.allowed:=true; h.blocked_since:=null; reason:='SUSTAINED_HEADROOM_AVAILABLE';
      else reason:='RECOVERY_STABILIZING'; end if;
    else
      h.healthy_since:=null; reason:='RECOVERY_MARGIN_NOT_REACHED';
    end if;
    if previous_allowed<>h.allowed then
      h.last_transition_at:=m.observed_at;
      insert into coinops.executor_admission_transitions(shard_id,environment,planned_engines,transitioned_at,allowed,reason,sustained_weight,projected_weight,policy_version)
      values(m.shard_id,env,n,m.observed_at,h.allowed,reason,m.binance_weight_average,projected,p->>'version');
    end if;
    update coinops.executor_admission_hysteresis set allowed=h.allowed,healthy_since=h.healthy_since,blocked_since=h.blocked_since,
      last_transition_at=h.last_transition_at,sample_at=m.observed_at,sustained_weight=m.binance_weight_average,
      executor_state=safety->>'state',reason=hysteresis.reason,policy_version=p->>'version'
    where shard_id=m.shard_id and environment=env and planned_engines=n;
  end loop;
  return new;
end $$;
revoke all on function coinops.advance_executor_admission_hysteresis() from public,anon,authenticated;
grant execute on function coinops.advance_executor_admission_hysteresis() to service_role;
create trigger executor_admission_pressure_real after insert or update on coinops.executor_capacity_samples
for each row execute function coinops.advance_executor_admission_hysteresis();
create trigger executor_admission_pressure_testnet after insert or update on coinops.executor_capacity_environment_samples
for each row execute function coinops.advance_executor_admission_hysteresis();

create or replace function coinops.preview_executor_admission(p_shard_id text,p_environment text,p_engines integer,p_exclude_engine uuid default null)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  s coinops.executor_shards%rowtype; m coinops.executor_capacity_samples%rowtype;
  h coinops.executor_admission_hysteresis%rowtype;
  p jsonb:=coinops.executor_capacity_policy(); readiness jsonb; safety jsonb;
  observed numeric; reserved numeric; projected numeric; ceiling numeric;
  code text:='CAPACITY_OK'; reason text:='SUSTAINED_HEADROOM_AVAILABLE'; phase text;
begin
  if p_environment is null or p_environment not in ('REAL','TESTNET') or p_engines is null or p_engines not between 1 and 25 then
    return jsonb_build_object('code','CAPACITY_UNKNOWN','reason','INVALID_ADMISSION_INPUT'); end if;
  select * into s from coinops.executor_shards where id=p_shard_id;
  select * into m from coinops.executor_capacity_sample_for_environment(p_shard_id,p_environment);
  select * into h from coinops.executor_admission_hysteresis where shard_id=p_shard_id and environment=p_environment and planned_engines=p_engines;
  readiness:=coinops.executor_admission_readiness(p_shard_id);
  safety:=coinops.executor_capacity_sample_safety(m);
  ceiling:=(p->>'binance_limit')::numeric*(p->>'admission_ratio')::numeric;
  select coalesce(sum(reserved_weight),0) into reserved from coinops.executor_capacity_admissions
    where shard_id=p_shard_id and environment=p_environment and expires_at>now() and engine_id is distinct from p_exclude_engine;
  observed:=m.binance_weight_average;
  projected:=observed+reserved+p_engines*(p->>'incremental_weight')::numeric;
  if s.id is null or not s.enabled or not (readiness->>'ready')::boolean then
    code:='CAPACITY_UNKNOWN'; reason:=coalesce(readiness->'failures'->>0,'SHARD_NOT_READY');
  elsif safety->>'state'='OFFLINE' then code:='CAPACITY_UNKNOWN'; reason:=safety->>'reason';
  elsif safety->>'reason' is not null then code:='CAPACITY_REQUIRED'; reason:=safety->>'reason';
  elsif m.binance_weight_current+reserved+p_engines*(p->>'incremental_weight')::numeric>=(p->>'binance_limit')::numeric*(p->>'hard_projected_ratio')::numeric then
    code:='CAPACITY_REQUIRED'; reason:='BINANCE_PROJECTED_CRITICAL_NOW';
  elsif projected>ceiling then code:='CAPACITY_REQUIRED'; reason:='SUSTAINED_PROJECTION_ABOVE_ADMISSION_LIMIT';
  elsif h.shard_id is null or h.policy_version<>p->>'version' or h.sample_at<>m.observed_at then
    code:='CAPACITY_UNKNOWN'; reason:='HYSTERESIS_EVIDENCE_MISSING';
  elsif not h.allowed then code:='CAPACITY_REQUIRED'; reason:=h.reason;
  end if;
  phase:=case when code='CAPACITY_UNKNOWN' then 'UNKNOWN'
    when reason in ('BINANCE_WEIGHT_CRITICAL_NOW','BINANCE_PROJECTED_CRITICAL_NOW') then 'CAPACITY_LIMIT'
    when reason='SUSTAINED_PROJECTION_ABOVE_ADMISSION_LIMIT' then 'SUSTAINED_PRESSURE'
    when reason in ('RECOVERY_STABILIZING','RECOVERY_MARGIN_NOT_REACHED') then 'RECOVERY'
    when m.binance_weight_peak>ceiling or m.binance_weight_peak>m.binance_weight_average+300 then 'TRANSIENT_SPIKE'
    else 'NORMAL' end;
  return jsonb_build_object('code',code,'reason',reason,'ready',readiness,'policy',p,
    'executor_state',safety->>'state','scale_action',safety->>'action','observed_weight',observed,
    'sustained_weight',observed,'current_weight',m.binance_weight_current,'peak_weight',m.binance_weight_peak,
    'reserved_weight',reserved,'incremental_weight',(p->>'incremental_weight')::numeric*p_engines,
    'projected_weight',projected,'projected_percent',round(projected/(p->>'binance_limit')::numeric*100,2),
    'admission_limit_weight',ceiling,'recovery_headroom_weight',(p->>'binance_limit')::numeric-ceiling,
    'remaining_weight',ceiling-projected,'pressure_phase',phase,
    'healthy_since',h.healthy_since,'blocked_since',h.blocked_since,'last_transition_at',h.last_transition_at,'decision_observed_at',h.sample_at,
    'healthy_seconds',case when h.healthy_since is not null then greatest(0,extract(epoch from (h.sample_at-h.healthy_since))) else 0 end,
    'additional_engines',case when code='CAPACITY_OK' then (select coalesce(max(x.planned_engines),0)
      from coinops.executor_admission_hysteresis x where x.shard_id=p_shard_id and x.environment=p_environment
        and x.allowed and x.sample_at=m.observed_at and x.policy_version=p->>'version'
        and observed+reserved+x.planned_engines*(p->>'incremental_weight')::numeric<=ceiling
        and m.binance_weight_current+reserved+x.planned_engines*(p->>'incremental_weight')::numeric<(p->>'binance_limit')::numeric*(p->>'hard_projected_ratio')::numeric)
      else 0 end);
end $$;

-- This reviewed control-plane-only policy upgrade preserves the existing
-- fingerprint/Node/IP/runtime certification and its original verified_at.
-- It does not claim a new executor rollout or certify any previously missing shard.
update coinops.executor_admission_attestations a set policy_version='capacity-v3-20260930',
  evidence=a.evidence||jsonb_build_object('capacity_policy_review','20260930133240_coinops_admission_hysteresis')
from coinops.executor_admission_release r,coinops.executor_shards s
where r.singleton and a.shard_id=s.id and a.policy_version='capacity-v2-20260929' and r.policy_version='capacity-v2-20260929'
  and a.target_sha=r.target_sha and a.runtime_sha256=r.runtime_sha256 and a.node_version=r.node_version
  and a.egress_ipv4=s.egress_ipv4 and a.evidence->>'config_status'='PASS'
  and s.binance_limit_per_min=6000 and s.admission_ratio=.65 and s.incremental_engine_weight=900;
update coinops.executor_admission_release set policy_version='capacity-v3-20260930' where singleton and policy_version='capacity-v2-20260929';

-- Do not bootstrap recovery by replaying old observations or inventing history.
-- The existing collector fills state automatically on the next fresh sample.
commit;
