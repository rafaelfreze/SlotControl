-- Control plane only. Never changes accounts, engines, orders, slots or leases.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '60s';

create function coinops.executor_capacity_policy()
returns jsonb language sql immutable security invoker set search_path = '' as $$
  select '{"version":"capacity-v2-20260929","binance_limit":6000,"incremental_weight":900,"incremental_source":"CONSERVATIVE_UNCALIBRATED","observe_ratio":0.50,"warning_ratio":0.65,"capacity_ratio":0.75,"admission_ratio":0.65,"recovery_ratio":0.35,"telemetry_max_age_seconds":120,"cpu_max_percent":70,"ram_max_percent":75,"reconciliation_max_ms":120000,"peak_hold_minutes":15}'::jsonb
$$;
revoke all on function coinops.executor_capacity_policy() from public,anon,authenticated;
grant execute on function coinops.executor_capacity_policy() to service_role;

-- One reviewed profile for every current/future shard. No per-host tuning.
create function coinops.enforce_executor_capacity_policy()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare p jsonb := coinops.executor_capacity_policy();
begin
  if new.binance_limit_per_min <> (p->>'binance_limit')::int
    or new.admission_ratio <> (p->>'admission_ratio')::numeric
    or new.incremental_engine_weight <> (p->>'incremental_weight')::int then
    raise exception 'COINOPS_CAPACITY_POLICY_PARITY_REQUIRED';
  end if;
  return new;
end $$;
revoke all on function coinops.enforce_executor_capacity_policy() from public,anon,authenticated;
grant execute on function coinops.enforce_executor_capacity_policy() to service_role;
create trigger executor_capacity_policy_parity before insert or update on coinops.executor_shards
for each row execute function coinops.enforce_executor_capacity_policy();

create table coinops.executor_admission_release (
  singleton boolean primary key default true check(singleton),
  target_sha text not null check(target_sha ~ '^[a-f0-9]{40}$'),
  runtime_sha256 text not null check(runtime_sha256 ~ '^[a-f0-9]{64}$'),
  node_version text not null,
  policy_version text not null,
  verified_at timestamptz not null
);
create table coinops.executor_admission_attestations (
  shard_id text primary key references coinops.executor_shards(id) on delete restrict,
  egress_ipv4 inet not null,
  target_sha text not null,
  runtime_sha256 text not null,
  node_version text not null,
  policy_version text not null,
  verified_at timestamptz not null,
  evidence jsonb not null check(jsonb_typeof(evidence)='object')
);
alter table coinops.executor_admission_release enable row level security;
alter table coinops.executor_admission_release force row level security;
alter table coinops.executor_admission_attestations enable row level security;
alter table coinops.executor_admission_attestations force row level security;
revoke all on coinops.executor_admission_release,coinops.executor_admission_attestations from public,anon,authenticated;
grant select,insert,update on coinops.executor_admission_release,coinops.executor_admission_attestations to service_role;

-- A deployment attests bytes/Node/systemd over authenticated SSH. This read
-- continuously rechecks shard-local telemetry/version/Watchdog; no Binance I/O.
create function coinops.executor_admission_readiness(p_shard_id text)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  s coinops.executor_shards%rowtype; m coinops.executor_capacity_samples%rowtype;
  a coinops.executor_admission_attestations%rowtype; r coinops.executor_admission_release%rowtype;
  w record; p jsonb := coinops.executor_capacity_policy(); failures text[] := '{}';
begin
  select * into s from coinops.executor_shards where id=p_shard_id;
  select * into m from coinops.executor_capacity_samples where shard_id=p_shard_id;
  select * into a from coinops.executor_admission_attestations where shard_id=p_shard_id;
  select * into r from coinops.executor_admission_release where singleton;
  if s.id is null or not s.enabled then failures:=array_append(failures,'EXECUTOR_DISABLED_OR_MISSING'); end if;
  if s.binance_limit_per_min is distinct from (p->>'binance_limit')::int
    or s.admission_ratio is distinct from (p->>'admission_ratio')::numeric
    or s.incremental_engine_weight is distinct from (p->>'incremental_weight')::int
    or a.policy_version is distinct from p->>'version' or r.policy_version is distinct from p->>'version'
    then failures:=array_append(failures,'CAPACITY_POLICY_PARITY'); end if;
  if a.shard_id is null or a.egress_ipv4 is distinct from s.egress_ipv4
    or a.evidence->>'config_status' is distinct from 'PASS'
    then failures:=array_append(failures,'EXECUTOR_CONFIG_PARITY'); end if;
  if r.target_sha is null or a.target_sha is distinct from r.target_sha
    or a.runtime_sha256 is distinct from r.runtime_sha256
    or a.node_version is distinct from r.node_version or m.executor_version is distinct from r.target_sha
    then failures:=array_append(failures,'RUNTIME_PARITY'); end if;
  if m.shard_id is null or m.observed_at not between now()-interval '120 seconds' and now()+interval '10 seconds'
    or m.heartbeat_at not between now()-interval '120 seconds' and now()+interval '10 seconds'
    or not m.registry_match then failures:=array_append(failures,'TELEMETRY_ACTIVE'); end if;
  if m.weight_observed_at is null or m.weight_observed_at not between now()-interval '120 seconds' and now()+interval '10 seconds'
    or coalesce(m.binance_weight_samples,0)<2 then failures:=array_append(failures,'BINANCE_WEIGHT_TRACKING'); end if;
  select checked_at,blocked_engines,stale_engines,recovering_engines into w
    from coinops.watchdog_checks where shard_id=p_shard_id order by checked_at desc limit 1;
  if not found or w.checked_at not between now()-interval '120 seconds' and now()+interval '10 seconds'
    then failures:=array_append(failures,'WATCHDOG_DISCOVERY');
  elsif w.blocked_engines+w.stale_engines+w.recovering_engines>0
    then failures:=array_append(failures,'ENGINE_RECOVERY_IN_PROGRESS'); end if;
  return jsonb_build_object('ready',cardinality(failures)=0,'failures',failures,'policy_version',p->>'version');
end $$;
revoke all on function coinops.executor_admission_readiness(text) from public,anon,authenticated;
grant execute on function coinops.executor_admission_readiness(text) to service_role;

-- Shared by preview, assignment and serialized activation. Never reserves here.
create function coinops.preview_executor_admission(p_shard_id text,p_environment text,
  p_engines integer,p_exclude_engine uuid default null)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  s coinops.executor_shards%rowtype; m coinops.executor_capacity_samples%rowtype;
  p jsonb:=coinops.executor_capacity_policy(); readiness jsonb;
  observed numeric; reserved numeric; projected numeric; ceiling numeric;
  code text:='CAPACITY_OK'; reason text:='MEASURED_HEADROOM_AVAILABLE'; phase text;
begin
  if p_environment is null or p_environment not in ('REAL','TESTNET') or p_engines is null or p_engines not between 1 and 25 then
    return jsonb_build_object('code','CAPACITY_UNKNOWN','reason','INVALID_ADMISSION_INPUT'); end if;
  select * into s from coinops.executor_shards where id=p_shard_id;
  select * into m from coinops.executor_capacity_sample_for_environment(p_shard_id,p_environment);
  readiness:=coinops.executor_admission_readiness(p_shard_id);
  ceiling:=(p->>'binance_limit')::numeric*(p->>'admission_ratio')::numeric;
  if s.id is null or not s.enabled or m.shard_id is null or not (readiness->>'ready')::boolean
    then code:='CAPACITY_UNKNOWN'; reason:=coalesce(readiness->'failures'->>0,'SHARD_NOT_READY');
  end if;
  if m.shard_id is null or m.observed_at not between now()-interval '120 seconds' and now()+interval '10 seconds'
    or m.heartbeat_at not between now()-interval '120 seconds' and now()+interval '10 seconds'
    or m.weight_observed_at is null or m.weight_observed_at not between now()-interval '120 seconds' and now()+interval '10 seconds'
    or not m.registry_match or m.binance_weight_samples<2
    or m.cpu_percent is null or m.cpu_percent not between 0 and 100
    or m.ram_used_mb is null or m.ram_used_mb<0 or m.ram_limit_mb is null or m.ram_limit_mb<=0
    or m.binance_weight_current is null or m.binance_weight_average is null or m.binance_weight_peak is null
    or least(m.binance_weight_current,m.binance_weight_average,m.binance_weight_peak)<0
    then code:='CAPACITY_UNKNOWN'; reason:='CAPACITY_TELEMETRY_MISSING_OR_STALE';
  end if;
  select coalesce(sum(reserved_weight),0) into reserved from coinops.executor_capacity_admissions
    where shard_id=p_shard_id and environment=p_environment and expires_at>now()
      and engine_id is distinct from p_exclude_engine;
  observed:=greatest(m.binance_weight_current,m.binance_weight_average,m.binance_weight_peak);
  projected:=observed+reserved+p_engines*(p->>'incremental_weight')::numeric;
  if code='CAPACITY_OK' then
    if m.cpu_percent>=(p->>'cpu_max_percent')::numeric or m.ram_used_mb/m.ram_limit_mb*100>=(p->>'ram_max_percent')::numeric
      then code:='CAPACITY_REQUIRED'; reason:='EXECUTOR_RESOURCE_HEADROOM_LOW';
    elsif m.scheduler_backlog>0 or m.reconciliation_p95_ms>=(p->>'reconciliation_max_ms')::numeric
      then code:='CAPACITY_REQUIRED'; reason:='SCHEDULER_OR_RECONCILIATION_SLOW';
    elsif m.errors_last_5m>0 or m.retries_last_5m>0
      then code:='CAPACITY_REQUIRED'; reason:='RECENT_TRANSPORT_ERRORS';
    elsif projected>ceiling then code:='CAPACITY_REQUIRED'; reason:='PROJECTED_BINANCE_WEIGHT_ABOVE_ADMISSION_LIMIT'; end if;
  end if;
  -- Diagnostic distinction only: a low current counter is not a completed minute.
  -- A historical peak keeps the conservative 15-minute hold; it is never latched.
  phase:=case when code='CAPACITY_UNKNOWN' then 'UNKNOWN'
    when m.binance_weight_average>=(p->>'binance_limit')::numeric*(p->>'capacity_ratio')::numeric then 'SUSTAINED_PRESSURE'
    when m.binance_weight_current>=(p->>'binance_limit')::numeric*(p->>'capacity_ratio')::numeric then 'CAPACITY_LIMIT'
    when m.binance_weight_peak>=ceiling and m.binance_weight_average<ceiling and m.binance_weight_current<ceiling then 'TRANSIENT_SPIKE'
    when observed>=ceiling then 'WARNING' else 'NORMAL' end;
  return jsonb_build_object('code',code,'reason',reason,'ready',readiness,'policy',p,
    'observed_weight',observed,'reserved_weight',reserved,'incremental_weight',(p->>'incremental_weight')::numeric*p_engines,
    'projected_weight',projected,'projected_percent',round(projected/(p->>'binance_limit')::numeric*100,2),
    'admission_limit_weight',ceiling,'recovery_headroom_weight',(p->>'binance_limit')::numeric-ceiling,
    'remaining_weight',ceiling-projected,'pressure_phase',phase,
    'additional_engines',case when code='CAPACITY_OK' then greatest(0,floor((ceiling-observed-reserved)/(p->>'incremental_weight')::numeric)) else 0 end);
end $$;
revoke all on function coinops.preview_executor_admission(text,text,integer,uuid) from public,anon,authenticated;
grant execute on function coinops.preview_executor_admission(text,text,integer,uuid) to service_role;

create function coinops.executor_capacity_decisions()
returns jsonb language sql stable security invoker set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('shard_id',s.id,
    'plus_one',coinops.preview_executor_admission(s.id,'REAL',1),
    'plus_two',coinops.preview_executor_admission(s.id,'REAL',2)) order by s.id),'[]'::jsonb)
  from coinops.executor_shards s
$$;
revoke all on function coinops.executor_capacity_decisions() from public,anon,authenticated;
grant execute on function coinops.executor_capacity_decisions() to service_role;

create or replace function coinops.reserve_executor_capacity(p_shard_id text, p_engine_id uuid)
returns text language plpgsql security invoker set search_path = '' as $$
declare
  v_shard coinops.executor_shards%rowtype;
  v_sample coinops.executor_capacity_samples%rowtype;
  v_account_shard text;
  v_environment text;
  v_reserved numeric;
  v_decision jsonb;
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
  v_decision:=coinops.preview_executor_admission(p_shard_id,v_environment,1,p_engine_id);
  if v_decision->>'code'<>'CAPACITY_OK' then return v_decision->>'code'; end if;
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
  v_decision jsonb;
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
    v_decision:=coinops.preview_executor_admission(v_shard.id,p_environment,p_planned_engines);
    if v_decision->>'code'<>'CAPACITY_UNKNOWN' then v_has_fresh:=true; end if;
    if v_decision->>'code'<>'CAPACITY_OK' then continue; end if;
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

create or replace function coinops.reassign_staged_executor_shard(p_operator_id uuid,p_account_id uuid,
  p_from_shard text,p_to_shard text,p_request_id uuid,p_preview boolean,p_origin_retired boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_account coinops.exchange_accounts%rowtype;
  v_operator coinops.operators%rowtype;
  v_shard coinops.executor_shards%rowtype;
  v_sample coinops.executor_capacity_samples%rowtype;
  v_count integer; v_reserved numeric; v_weight numeric; v_decision jsonb;
begin
  if p_operator_id is null or p_account_id is null or p_request_id is null
    or p_preview is null or p_origin_retired is null or p_from_shard is null or p_to_shard is null
    or p_from_shard=p_to_shard then raise exception 'COINOPS_STAGED_REASSIGNMENT_INVALID'; end if;
  select * into v_operator from coinops.operators where id=p_operator_id and status='ACTIVE';
  if not found then raise exception 'COINOPS_ADMIN_OPERATOR_DENIED'; end if;
  select * into v_account from coinops.exchange_accounts where id=p_account_id for update;
  if not found or v_account.operator_id<>p_operator_id or v_account.is_legacy_default then
    raise exception 'COINOPS_ADMIN_ACCOUNT_DENIED'; end if;
  if v_account.executor_shard_id=p_to_shard and exists(
    select 1 from coinops.account_onboarding_checks where exchange_account_id=p_account_id
      and check_key='EXECUTOR_REASSIGNMENT' and status='PASS'
      and evidence->>'from_shard'=p_from_shard and evidence->>'to_shard'=p_to_shard) then
    return jsonb_build_object('code','REASSIGNED','shardId',p_to_shard,'replayed',true);
  end if;
  if v_account.executor_shard_id<>p_from_shard or v_account.status<>'INACTIVE'
    or not v_account.kill_switch then raise exception 'COINOPS_STAGED_REASSIGNMENT_DENIED'; end if;
  perform id from coinops.trading_engines where exchange_account_id=p_account_id order by id for update;
  if exists(select 1 from coinops.trading_engines where exchange_account_id=p_account_id
    and (status<>'INACTIVE' or not kill_switch or environment<>'REAL')) then
    raise exception 'COINOPS_STAGED_REASSIGNMENT_DENIED'; end if;
  perform id from coinops.robot_v1_live_runs where exchange_account_id=p_account_id order by id for update;
  if exists(select 1 from coinops.robot_v1_live_runs where exchange_account_id=p_account_id
    and (status<>'PREPARING' or lease_until>now()))
    or exists(select 1 from coinops.robot_v1_testnet_runs where exchange_account_id=p_account_id)
    or exists(select 1 from coinops.robot_v1_live_orders where exchange_account_id=p_account_id)
    or exists(select 1 from coinops.robot_v1_live_fills where exchange_account_id=p_account_id)
    or exists(select 1 from coinops.robot_v1_live_slots where exchange_account_id=p_account_id
      and (entry_state<>'PLANNED' or position_quantity<>0 or position_committed_brl<>0
        or last_credited_sell_client_order_id is not null or operation_sequence<>1
        or last_take_profit_price is not null))
    or exists(select 1 from coinops.executor_capacity_admissions c join coinops.trading_engines e on e.id=c.engine_id
      where e.exchange_account_id=p_account_id and c.expires_at>now()) then
    raise exception 'COINOPS_STAGED_REASSIGNMENT_TRADING_HISTORY'; end if;
  select * into v_shard from coinops.executor_shards where id=p_to_shard and enabled for update;
  if not found then raise exception 'COINOPS_CAPACITY_UNKNOWN'; end if;
  select greatest(count(*),1) into v_count from coinops.trading_engines where exchange_account_id=p_account_id;
  v_decision:=coinops.preview_executor_admission(p_to_shard,'REAL',v_count::integer);
  if v_decision->>'code'='CAPACITY_UNKNOWN' then raise exception 'COINOPS_CAPACITY_UNKNOWN'; end if;
  if v_decision->>'code'<>'CAPACITY_OK' then raise exception 'COINOPS_CAPACITY_REQUIRED'; end if;
  if p_preview then return jsonb_build_object('code','READY_TO_REASSIGN','shardId',p_to_shard,
    'executorIp',host(v_shard.egress_ipv4),'engineCount',v_count); end if;
  if not p_origin_retired then raise exception 'COINOPS_SOURCE_REGISTRY_RETIREMENT_REQUIRED'; end if;
  insert into private.coinops_staged_shard_move_capabilities values(p_account_id,p_from_shard,p_to_shard,pg_catalog.txid_current());
  update coinops.exchange_accounts set executor_shard_id=p_to_shard,onboarding_environment='REAL' where id=p_account_id;
  delete from private.coinops_staged_shard_move_capabilities where account_id=p_account_id;
  insert into coinops.account_onboarding_checks(operator_id,exchange_account_id,check_key,status,evidence,created_by,idempotency_key)
    values(p_operator_id,p_account_id,'EXECUTOR_REASSIGNMENT','PASS',
      jsonb_build_object('from_shard',p_from_shard,'to_shard',p_to_shard,'source_registry_retired',true,'never_traded',true),
      v_operator.user_id,'shard-reassignment:'||p_request_id::text),
    (p_operator_id,p_account_id,'BINANCE_CREDENTIAL','PENDING',
      jsonb_build_object('status','CREDENTIAL_REQUIRED','environment','REAL','executor_shard_id',p_to_shard,
        'executor_ip',host(v_shard.egress_ipv4),'reason','EXPLICIT_STAGED_REASSIGNMENT'),
      v_operator.user_id,'shard-credential-required:'||p_request_id::text);
  return jsonb_build_object('code','REASSIGNED','shardId',p_to_shard,'executorIp',host(v_shard.egress_ipv4),
    'credentialRequired',true,'replayed',false);
end $$;
revoke all on function coinops.reassign_staged_executor_shard(uuid,uuid,text,text,uuid,boolean,boolean)
  from public,anon,authenticated;
grant execute on function coinops.reassign_staged_executor_shard(uuid,uuid,text,text,uuid,boolean,boolean) to service_role;

-- Called only by the deployment verifier AFTER FLEET_PARITY_PASS. Empty/new
-- shards have no attestation and cannot admit even when their weight is zero.
create function coinops.certify_executor_admission(p_target_sha text,p_runtime_sha256 text,
  p_node_version text,p_policy_version text,p_evidence jsonb)
returns text language plpgsql security invoker set search_path = '' as $$
declare s record; e jsonb; m coinops.executor_capacity_samples%rowtype; w record;
begin
  if p_target_sha is null or p_target_sha !~ '^[a-f0-9]{40}$'
    or p_runtime_sha256 is null or p_runtime_sha256 !~ '^[a-f0-9]{64}$'
    or p_node_version is null or p_node_version !~ '^v[0-9]+\.[0-9]+\.[0-9]+$'
    or p_policy_version is distinct from coinops.executor_capacity_policy()->>'version'
    or jsonb_typeof(p_evidence) is distinct from 'array' then raise exception 'COINOPS_ADMISSION_EVIDENCE_INVALID'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('coinops-admission-certification',0));
  if jsonb_array_length(p_evidence)<1 or jsonb_array_length(p_evidence)<>(select count(*) from coinops.executor_shards where enabled)
    then raise exception 'COINOPS_ADMISSION_FLEET_INCOMPLETE'; end if;
  for s in select * from coinops.executor_shards where enabled order by id for share loop
    if (select count(*) from jsonb_array_elements(p_evidence) x where x->>'shard_id'=s.id)<>1
      then raise exception 'COINOPS_ADMISSION_FLEET_INCOMPLETE'; end if;
    select x into e from jsonb_array_elements(p_evidence) x where x->>'shard_id'=s.id;
    if e->>'status' is distinct from 'PASS' or e->>'config_status' is distinct from 'PASS'
      or e->>'actual_sha' is distinct from p_target_sha or e->>'runtime_sha256' is distinct from p_runtime_sha256
      or e->>'node_version' is distinct from p_node_version or e->>'ip' is distinct from host(s.egress_ipv4)
      or e->>'observed_at' is null or (e->>'observed_at')::timestamptz not between now()-interval '120 seconds' and now()+interval '10 seconds'
      then raise exception 'COINOPS_ADMISSION_FLEET_UNVERIFIED'; end if;
    if s.binance_limit_per_min<>(coinops.executor_capacity_policy()->>'binance_limit')::int
      or s.admission_ratio<>(coinops.executor_capacity_policy()->>'admission_ratio')::numeric
      or s.incremental_engine_weight<>(coinops.executor_capacity_policy()->>'incremental_weight')::int
      then raise exception 'COINOPS_CAPACITY_POLICY_PARITY_REQUIRED'; end if;
    select * into m from coinops.executor_capacity_samples where shard_id=s.id;
    if not found or m.executor_version is distinct from p_target_sha or not m.registry_match
      or m.observed_at not between now()-interval '120 seconds' and now()+interval '10 seconds'
      or m.heartbeat_at not between now()-interval '120 seconds' and now()+interval '10 seconds'
      or m.weight_observed_at is null or m.weight_observed_at not between now()-interval '120 seconds' and now()+interval '10 seconds'
      or m.binance_weight_samples<2 then raise exception 'COINOPS_ADMISSION_TELEMETRY_UNVERIFIED'; end if;
    select checked_at into w from coinops.watchdog_checks where shard_id=s.id order by checked_at desc limit 1;
    if not found or w.checked_at not between now()-interval '120 seconds' and now()+interval '10 seconds'
      then raise exception 'COINOPS_ADMISSION_WATCHDOG_UNVERIFIED'; end if;
    insert into coinops.executor_admission_attestations values(s.id,s.egress_ipv4,p_target_sha,
      p_runtime_sha256,p_node_version,p_policy_version,(e->>'observed_at')::timestamptz,e)
    on conflict(shard_id) do update set egress_ipv4=excluded.egress_ipv4,target_sha=excluded.target_sha,
      runtime_sha256=excluded.runtime_sha256,node_version=excluded.node_version,policy_version=excluded.policy_version,
      verified_at=excluded.verified_at,evidence=excluded.evidence;
  end loop;
  insert into coinops.executor_admission_release values(true,p_target_sha,p_runtime_sha256,p_node_version,p_policy_version,now())
  on conflict(singleton) do update set target_sha=excluded.target_sha,runtime_sha256=excluded.runtime_sha256,
    node_version=excluded.node_version,policy_version=excluded.policy_version,verified_at=excluded.verified_at;
  return 'ADMISSION_PREFLIGHT_PASS';
end $$;
revoke all on function coinops.certify_executor_admission(text,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function coinops.certify_executor_admission(text,text,text,text,jsonb) to service_role;
commit;
