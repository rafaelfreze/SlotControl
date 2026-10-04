-- Additive creation, no activation, no exchange I/O, no existing engine update.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';
-- Ownership backfill copies the installed binding; it does not migrate engines.
alter table coinops.trading_engines add column executor_shard_id text references coinops.executor_shards(id);
update coinops.trading_engines e set executor_shard_id=a.executor_shard_id
  from coinops.exchange_accounts a where a.id=e.exchange_account_id and a.operator_id=e.operator_id;
do $$begin
  if exists(select 1 from coinops.trading_engines where environment='REAL' and executor_shard_id is null) then
    raise exception 'COINOPS_ENGINE_SHARD_BACKFILL_INCOMPLETE';
  end if;
end $$;
alter table coinops.trading_engines add constraint trading_engines_real_shard_required
  check(environment<>'REAL' or executor_shard_id is not null);
create index trading_engines_shard_status on coinops.trading_engines(executor_shard_id,environment,status);
grant select(executor_shard_id) on coinops.trading_engines to authenticated;

-- Old first-account provisioning remains compatible. Only INSERT can derive a
-- bootstrap target. An explicit new-engine target is never changed/fallbacked.
create function private.coinops_engine_shard_immutable() returns trigger
language plpgsql set search_path='' as $$
begin
  if tg_op='UPDATE' and (new.id is distinct from old.id
    or new.operator_id is distinct from old.operator_id
    or new.exchange_account_id is distinct from old.exchange_account_id
    or new.environment is distinct from old.environment
    or new.symbol is distinct from old.symbol
    or new.quote_asset is distinct from old.quote_asset
    or new.base_asset is distinct from old.base_asset
    or new.legacy_compatible is distinct from old.legacy_compatible) then
    raise exception 'COINOPS_ORDER_NAMESPACE_IMMUTABLE';
  end if;
  if tg_op='UPDATE' and new.executor_shard_id is distinct from old.executor_shard_id then
    raise exception 'COINOPS_ENGINE_SHARD_IMMUTABLE';
  end if;
  if tg_op='INSERT' and new.executor_shard_id is null then
    select a.executor_shard_id into new.executor_shard_id from coinops.exchange_accounts a
      where a.id=new.exchange_account_id and a.operator_id=new.operator_id;
  end if;
  return new;
end $$;
revoke all on function private.coinops_engine_shard_immutable() from public,anon,authenticated;
create trigger trading_engine_shard_identity before insert or update of executor_shard_id,id,operator_id,exchange_account_id,environment,symbol,quote_asset,base_asset,legacy_compatible
  on coinops.trading_engines for each row execute function private.coinops_engine_shard_immutable();

-- Prefix collisions fail at provisioning, not later at exchange reconciliation.
-- Existing COR1 IDs remain byte-for-byte unchanged.
-- UUIDs and the separator are ASCII; fixed UTF8 conversion is deterministic.
create function private.coinops_order_owner_prefix(p_account uuid,p_engine uuid,p_legacy boolean,p_asset text)
returns text language sql immutable strict set search_path='' as $$
  select case when p_legacy then 'COR1-'||p_asset||'-'
  else 'C2-'||substr(encode(sha256(convert_to(p_account::text||'|'||p_engine::text,'UTF8')),'hex'),1,10)||'-' end
$$;
revoke all on function private.coinops_order_owner_prefix(uuid,uuid,boolean,text) from public,anon,authenticated;
grant execute on function private.coinops_order_owner_prefix(uuid,uuid,boolean,text) to service_role;
alter table coinops.trading_engines add column order_owner_prefix text generated always as (
  private.coinops_order_owner_prefix(exchange_account_id,id,legacy_compatible,base_asset)
) stored;
create unique index trading_engines_order_owner_prefix on coinops.trading_engines(environment,order_owner_prefix);

-- Metadata/proof only. No API key, secret, UID, vault content or transferable
-- credential is stored here. A new shard requires its own signed validation.
create table coinops.account_executor_connections (
  exchange_account_id uuid not null,
  operator_id uuid not null,
  executor_shard_id text not null references coinops.executor_shards(id),
  environment text not null check(environment='REAL'),
  credential_ref text not null,
  status text not null default 'VALIDATION_REQUIRED' check(status in ('VALIDATION_REQUIRED','VALIDATED')),
  checked_at timestamptz,
  validation_evidence jsonb not null default '{}',
  primary key(exchange_account_id,executor_shard_id,environment),
  foreign key(exchange_account_id,operator_id) references coinops.exchange_accounts(id,operator_id),
  check(credential_ref='account_'||replace(exchange_account_id::text,'-','')
    or executor_shard_id='executor-01' and credential_ref='legacy-binance-production')
);
alter table coinops.account_executor_connections enable row level security;
alter table coinops.account_executor_connections force row level security;
revoke all on coinops.account_executor_connections from public,anon,authenticated;
grant select,insert,update on coinops.account_executor_connections to service_role;
insert into coinops.account_executor_connections(exchange_account_id,operator_id,executor_shard_id,environment,credential_ref)
select distinct a.id,a.operator_id,e.executor_shard_id,'REAL',a.credential_ref
from coinops.exchange_accounts a join coinops.trading_engines e on e.exchange_account_id=a.id and e.environment='REAL';

-- Two-phase configuration only. PREPARING already requires serialized permits
-- in the web dispatcher, before any monotonic executor marker is installed.
-- No rollback may silently downgrade an account after a marker was enabled.
create table coinops.account_execution_policies (
  exchange_account_id uuid primary key,
  operator_id uuid not null,
  contract text not null check(contract='ENGINE_ISOLATION_V2'),
  status text not null check(status in('PREPARING','ACTIVE')),
  request_id uuid not null,
  executor_version text not null check(executor_version ~ '^[a-f0-9]{40}$'),
  required_shards text[] not null check(cardinality(required_shards)>0),
  proofs jsonb not null default '{}' check(jsonb_typeof(proofs)='object'),
  updated_at timestamptz not null default clock_timestamp(),
  foreign key(exchange_account_id,operator_id) references coinops.exchange_accounts(id,operator_id)
);
alter table coinops.account_execution_policies enable row level security;
alter table coinops.account_execution_policies force row level security;
revoke all on coinops.account_execution_policies from public,anon,authenticated;
grant select,insert,update on coinops.account_execution_policies to service_role;

create function coinops.stage_account_execution_policy(p_operator_id uuid,p_account_id uuid,p_destination text,
  p_executor_version text,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare shards text[]; prior coinops.account_execution_policies%rowtype;
begin
  if coalesce(nullif(current_setting('request.jwt.claim.role',true),''),auth.jwt()->>'role','')<>'service_role'
    or p_operator_id is null or p_account_id is null or p_request_id is null
    or p_executor_version is null or p_executor_version !~ '^[a-f0-9]{40}$' then
    raise exception 'COINOPS_ENGINE_ISOLATION_SCOPE_DENIED';
  end if;
  perform 1 from coinops.exchange_accounts where id=p_account_id and operator_id=p_operator_id
    and status in('ACTIVE','INACTIVE') for update;
  if not found then raise exception 'COINOPS_ENGINE_ISOLATION_SCOPE_DENIED'; end if;
  select array_agg(distinct shard order by shard) into shards from(
    select e.executor_shard_id shard from coinops.trading_engines e where e.exchange_account_id=p_account_id
      and e.operator_id=p_operator_id and e.environment='REAL'
    union select p_destination) inventory;
  if shards is null or exists(select 1 from unnest(shards) id where id is null
    or not exists(select 1 from coinops.executor_shards s join coinops.account_executor_connections c
      on c.executor_shard_id=s.id where s.id=id and s.enabled and c.exchange_account_id=p_account_id
      and c.operator_id=p_operator_id and c.environment='REAL' and c.status='VALIDATED')) then
    raise exception 'COINOPS_ENGINE_ISOLATION_CREDENTIAL_REQUIRED';
  end if;
  select * into prior from coinops.account_execution_policies where exchange_account_id=p_account_id;
  if prior.request_id=p_request_id then
    if prior.operator_id<>p_operator_id or prior.executor_version<>p_executor_version or prior.required_shards<>shards then
      raise exception 'COINOPS_ENGINE_ISOLATION_REPLAY_MISMATCH';
    end if;
    return to_jsonb(prior);
  end if;
  if prior.status='PREPARING' then raise exception 'COINOPS_ENGINE_ISOLATION_PREPARING'; end if;
  insert into coinops.account_execution_policies(exchange_account_id,operator_id,contract,status,request_id,executor_version,required_shards)
  values(p_account_id,p_operator_id,'ENGINE_ISOLATION_V2','PREPARING',p_request_id,p_executor_version,shards)
  on conflict(exchange_account_id) do update set status='PREPARING',request_id=excluded.request_id,
    executor_version=excluded.executor_version,required_shards=excluded.required_shards,proofs='{}',updated_at=clock_timestamp();
  return (select to_jsonb(p) from coinops.account_execution_policies p where p.exchange_account_id=p_account_id);
end $$;
revoke all on function coinops.stage_account_execution_policy(uuid,uuid,text,text,uuid) from public,anon,authenticated;
grant execute on function coinops.stage_account_execution_policy(uuid,uuid,text,text,uuid) to service_role;

create function coinops.record_account_execution_policy(p_operator_id uuid,p_account_id uuid,p_request_id uuid,
  p_shard_id text,p_executor_version text,p_ip inet,p_enabled boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare policy coinops.account_execution_policies%rowtype; inventory text[];
begin
  if coalesce(nullif(current_setting('request.jwt.claim.role',true),''),auth.jwt()->>'role','')<>'service_role'
    or p_operator_id is null or p_account_id is null or p_request_id is null or p_enabled is distinct from true then
    raise exception 'COINOPS_ENGINE_ISOLATION_SCOPE_DENIED';
  end if;
  perform 1 from coinops.exchange_accounts where id=p_account_id and operator_id=p_operator_id for update;
  select * into policy from coinops.account_execution_policies where exchange_account_id=p_account_id and operator_id=p_operator_id;
  if policy.request_id is distinct from p_request_id or policy.executor_version is distinct from p_executor_version
    or p_shard_id is null or not(p_shard_id=any(policy.required_shards))
    or not exists(select 1 from coinops.executor_shards s join coinops.account_executor_connections c on c.executor_shard_id=s.id
      where s.id=p_shard_id and s.enabled and s.egress_ipv4=p_ip and c.exchange_account_id=p_account_id
      and c.operator_id=p_operator_id and c.environment='REAL' and c.status='VALIDATED') then
    raise exception 'COINOPS_ENGINE_ISOLATION_PROOF_DENIED';
  end if;
  select array_agg(distinct executor_shard_id) into inventory from coinops.trading_engines
    where exchange_account_id=p_account_id and operator_id=p_operator_id and environment='REAL';
  if inventory is not null and not(inventory<@policy.required_shards) then
    raise exception 'COINOPS_ENGINE_ISOLATION_INVENTORY_CHANGED';
  end if;
  policy.proofs:=policy.proofs||jsonb_build_object(p_shard_id,jsonb_build_object('version',p_executor_version,
    'ip',p_ip,'enabled',true,'checkedAt',clock_timestamp()));
  update coinops.account_execution_policies set proofs=policy.proofs,updated_at=clock_timestamp(),
    status=case when policy.proofs ?& policy.required_shards then 'ACTIVE' else 'PREPARING' end
    where exchange_account_id=p_account_id;
  return (select to_jsonb(p) from coinops.account_execution_policies p where p.exchange_account_id=p_account_id);
end $$;
revoke all on function coinops.record_account_execution_policy(uuid,uuid,uuid,text,text,inet,boolean) from public,anon,authenticated;
grant execute on function coinops.record_account_execution_policy(uuid,uuid,uuid,text,text,inet,boolean) to service_role;

create table coinops.account_order_budget_samples (
  exchange_account_id uuid primary key,
  operator_id uuid not null,
  observed_at timestamptz not null,
  server_time_ms bigint not null,
  intervals jsonb not null check(jsonb_typeof(intervals)='array' and jsonb_array_length(intervals)>0),
  symbol_limits jsonb not null check(jsonb_typeof(symbol_limits)='object'),
  restrictions jsonb not null default '[]' check(jsonb_typeof(restrictions)='array'),
  exchange_limits jsonb check(exchange_limits is null or jsonb_typeof(exchange_limits)='object'),
  source_shard_id text not null references coinops.executor_shards(id),
  foreign key(exchange_account_id,operator_id) references coinops.exchange_accounts(id,operator_id)
);
alter table coinops.account_order_budget_samples enable row level security;
alter table coinops.account_order_budget_samples force row level security;
revoke all on coinops.account_order_budget_samples from public,anon,authenticated;
grant select,insert,update on coinops.account_order_budget_samples to service_role;

create table coinops.account_order_budget_reservations (
  client_order_id text primary key,
  exchange_account_id uuid not null,
  operator_id uuid not null,
  trading_engine_id uuid not null,
  executor_shard_id text not null references coinops.executor_shards(id),
  reserved_at timestamptz not null default clock_timestamp(),
  acknowledged_at timestamptz,
  protection_orders integer not null default 0 check(protection_orders>=0),
  check(acknowledged_at is null or acknowledged_at>=reserved_at),
  foreign key(trading_engine_id,operator_id,exchange_account_id)
    references coinops.trading_engines(id,operator_id,exchange_account_id)
);
create index account_order_budget_reservations_account on coinops.account_order_budget_reservations(exchange_account_id,reserved_at);
alter table coinops.account_order_budget_reservations enable row level security;
alter table coinops.account_order_budget_reservations force row level security;
revoke all on coinops.account_order_budget_reservations from public,anon,authenticated;
grant select,insert,update on coinops.account_order_budget_reservations to service_role;

-- Cross-shard collection is single-flight in the control plane. The token
-- fences a late response; expiration never makes an old collector authoritative.
create table coinops.account_order_budget_probe_leases (
  exchange_account_id uuid primary key,
  operator_id uuid not null,
  lease_owner uuid not null,
  expires_at timestamptz not null,
  foreign key(exchange_account_id,operator_id) references coinops.exchange_accounts(id,operator_id)
);
alter table coinops.account_order_budget_probe_leases enable row level security;
alter table coinops.account_order_budget_probe_leases force row level security;
revoke all on coinops.account_order_budget_probe_leases from public,anon,authenticated;
grant select,insert,update on coinops.account_order_budget_probe_leases to service_role;

create function coinops.acquire_account_order_budget_probe(p_operator_id uuid,p_account_id uuid,p_lease_owner uuid)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  if coalesce(nullif(current_setting('request.jwt.claim.role',true),''),auth.jwt()->>'role','')<>'service_role'
    or p_operator_id is null or p_account_id is null or p_lease_owner is null then
    raise exception 'COINOPS_ACCOUNT_ORDER_BUDGET_SCOPE_DENIED';
  end if;
  perform 1 from coinops.exchange_accounts where id=p_account_id and operator_id=p_operator_id
    and status in ('ACTIVE','INACTIVE') for update;
  if not found then raise exception 'COINOPS_ACCOUNT_ORDER_BUDGET_SCOPE_DENIED'; end if;
  insert into coinops.account_order_budget_probe_leases(exchange_account_id,operator_id,lease_owner,expires_at)
  values(p_account_id,p_operator_id,p_lease_owner,clock_timestamp()+interval '45 seconds')
  on conflict(exchange_account_id) do update set lease_owner=excluded.lease_owner,expires_at=excluded.expires_at
    where coinops.account_order_budget_probe_leases.operator_id=p_operator_id
      and coinops.account_order_budget_probe_leases.expires_at<=clock_timestamp();
  return found;
end $$;
revoke all on function coinops.acquire_account_order_budget_probe(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function coinops.acquire_account_order_budget_probe(uuid,uuid,uuid) to service_role;

create function coinops.record_account_order_budget_sample(p_operator_id uuid,p_account_id uuid,p_lease_owner uuid,
  p_shard_id text,p_observed_at timestamptz,p_server_time_ms bigint,p_intervals jsonb,p_symbol_limits jsonb,
  p_restrictions jsonb,p_exchange_limits jsonb)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  if coalesce(nullif(current_setting('request.jwt.claim.role',true),''),auth.jwt()->>'role','')<>'service_role' then
    raise exception 'COINOPS_ACCOUNT_ORDER_BUDGET_SCOPE_DENIED';
  end if;
  perform 1 from coinops.exchange_accounts where id=p_account_id and operator_id=p_operator_id for update;
  if not found then raise exception 'COINOPS_ACCOUNT_ORDER_BUDGET_SCOPE_DENIED'; end if;
  perform 1 from coinops.account_order_budget_probe_leases where exchange_account_id=p_account_id
    and operator_id=p_operator_id and lease_owner=p_lease_owner and expires_at>clock_timestamp() for update;
  if not found then raise exception 'COINOPS_ACCOUNT_ORDER_BUDGET_PROBE_FENCED'; end if;
  if p_observed_at is null or p_observed_at<clock_timestamp()-interval '30 seconds'
    or p_observed_at>clock_timestamp()+interval '2 seconds' or p_server_time_ms is null
    or abs(p_server_time_ms-extract(epoch from p_observed_at)*1000)>2000
    or jsonb_typeof(p_intervals) is distinct from 'array' or jsonb_array_length(p_intervals)=0
    or jsonb_typeof(p_symbol_limits) is distinct from 'object'
    or jsonb_typeof(p_restrictions) is distinct from 'array'
    or p_exchange_limits is not null and jsonb_typeof(p_exchange_limits)<>'object'
    or not exists(select 1 from coinops.account_executor_connections c join coinops.executor_shards s
      on s.id=c.executor_shard_id where c.exchange_account_id=p_account_id and c.operator_id=p_operator_id
      and c.environment='REAL' and c.executor_shard_id=p_shard_id and c.status='VALIDATED'
      and s.enabled) then
    raise exception 'COINOPS_ACCOUNT_ORDER_BUDGET_OBSERVATION_INVALID';
  end if;
  insert into coinops.account_order_budget_samples(exchange_account_id,operator_id,observed_at,server_time_ms,
    intervals,symbol_limits,restrictions,exchange_limits,source_shard_id)
  values(p_account_id,p_operator_id,p_observed_at,p_server_time_ms,p_intervals,p_symbol_limits,
    p_restrictions,p_exchange_limits,p_shard_id)
  on conflict(exchange_account_id) do update set observed_at=excluded.observed_at,server_time_ms=excluded.server_time_ms,
    intervals=excluded.intervals,symbol_limits=excluded.symbol_limits,restrictions=excluded.restrictions,
    exchange_limits=excluded.exchange_limits,source_shard_id=excluded.source_shard_id
    where coinops.account_order_budget_samples.operator_id=p_operator_id
      and coinops.account_order_budget_samples.observed_at<=excluded.observed_at;
  if not found then raise exception 'COINOPS_ACCOUNT_ORDER_BUDGET_OBSERVATION_INVALID'; end if;
  update coinops.account_order_budget_probe_leases set expires_at=clock_timestamp()
    where exchange_account_id=p_account_id and lease_owner=p_lease_owner;
  return true;
end $$;
revoke all on function coinops.record_account_order_budget_sample(uuid,uuid,uuid,text,timestamptz,bigint,jsonb,jsonb,jsonb,jsonb)
  from public,anon,authenticated;
grant execute on function coinops.record_account_order_budget_sample(uuid,uuid,uuid,text,timestamptz,bigint,jsonb,jsonb,jsonb,jsonb)
  to service_role;

alter table coinops.trading_engines drop constraint trading_engines_exchange_account_id_environment_symbol_key;
create index trading_engines_account_market on coinops.trading_engines(exchange_account_id,environment,symbol);

-- One account-wide serialized budget, regardless of key/IP/shard. This gate
-- is read-only for trading/financial state. Its caller holds the account lock
-- until its admission/dispatch reservation is committed in the same transaction.
create function private.coinops_account_order_budget_gate(p_operator_id uuid,p_account_id uuid,
  p_new_orders integer,p_symbol_counts jsonb)
returns jsonb language plpgsql set search_path='' as $$
declare
  sample coinops.account_order_budget_samples%rowtype;
  interval_row jsonb; limits jsonb; symbol_row record;
  now_ms numeric; observed_ms numeric; offset_ms numeric; duration numeric;
  limit_value numeric; count_value numeric; outstanding numeric; projected numeric;
  resident numeric; external_count numeric; new_engines integer; existing_engines integer;
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
      or jsonb_typeof(value)<>'number' or value::text!~'^(0|[1-9][0-9]*)$') then
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
  select coalesce(sum(value::text::integer),0) into new_engines from jsonb_each(p_symbol_counts);
  for symbol_row in select key,value::text::integer amount from jsonb_each(p_symbol_counts) loop
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
    select count(*) into existing_engines from coinops.trading_engines
      where exchange_account_id=p_account_id and operator_id=p_operator_id and environment='REAL' and symbol=symbol_row.key;
    if greatest(resident+outstanding+p_new_orders,external_count+26::numeric*(existing_engines+symbol_row.amount))>limit_value then
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
    select count(*) into existing_engines from coinops.trading_engines
      where exchange_account_id=p_account_id and operator_id=p_operator_id and environment='REAL';
    if greatest(resident+outstanding+p_new_orders,external_count+26::numeric*(existing_engines+new_engines))>limit_value then
      code:='ACCOUNT_ORDER_CAPACITY_REQUIRED';
    end if;
  end if;
  return jsonb_build_object('code',code,'reason',case when code='PASS' then 'shared account budgets preserved'
    else 'shared account order capacity required' end,'intervals',results);
exception when data_exception then
  return jsonb_build_object('code','ACCOUNT_ORDER_BUDGET_UNKNOWN','reason','invalid observation','intervals','[]'::jsonb);
end $$;
revoke all on function private.coinops_account_order_budget_gate(uuid,uuid,integer,jsonb) from public,anon,authenticated;
grant execute on function private.coinops_account_order_budget_gate(uuid,uuid,integer,jsonb) to service_role;

create function coinops.preview_account_order_budget(p_operator_id uuid,p_account_id uuid,p_new_orders integer,p_symbol_counts jsonb)
returns jsonb language sql security definer set search_path='' as $$
  select private.coinops_account_order_budget_gate(p_operator_id,p_account_id,p_new_orders,p_symbol_counts)
$$;
revoke all on function coinops.preview_account_order_budget(uuid,uuid,integer,jsonb) from public,anon,authenticated;
grant execute on function coinops.preview_account_order_budget(uuid,uuid,integer,jsonb) to service_role;

-- A browser cannot mint a dispatch reservation. Identity, shard, side, lease
-- and the future protective TP cost are derived from the already-owned ledger.
create function coinops.reserve_account_order_budget(p_operator_id uuid,p_account_id uuid,
  p_engine_id uuid,p_client_order_id text,p_lease_owner uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  e coinops.trading_engines%rowtype; o coinops.robot_v1_live_orders%rowtype;
  r coinops.robot_v1_live_runs%rowtype; prior coinops.account_order_budget_reservations%rowtype;
  parent coinops.account_order_budget_reservations%rowtype;
  budget jsonb; cost integer; protected integer; expires_ms numeric;
  sample coinops.account_order_budget_samples%rowtype;
begin
  if coalesce(nullif(current_setting('request.jwt.claim.role',true),''),auth.jwt()->>'role','')<>'service_role'
    or p_operator_id is null or p_account_id is null or p_engine_id is null
    or p_client_order_id is null or p_lease_owner is null then
    raise exception 'COINOPS_ACCOUNT_ORDER_BUDGET_SCOPE_DENIED';
  end if;
  perform 1 from coinops.exchange_accounts where id=p_account_id and operator_id=p_operator_id for update;
  if not found then raise exception 'COINOPS_ACCOUNT_ORDER_BUDGET_SCOPE_DENIED'; end if;
  select * into e from coinops.trading_engines where id=p_engine_id and operator_id=p_operator_id
    and exchange_account_id=p_account_id and environment='REAL';
  select * into o from coinops.robot_v1_live_orders where client_order_id=p_client_order_id
    and operator_id=p_operator_id and exchange_account_id=p_account_id and trading_engine_id=p_engine_id;
  select * into r from coinops.robot_v1_live_runs where id=o.run_id and operator_id=p_operator_id
    and exchange_account_id=p_account_id and trading_engine_id=p_engine_id;
  if e.id is null or e.executor_shard_id is null or e.status<>'ACTIVE' or o.id is null or r.id is null
    or o.status<>'PREPARED' or o.exchange_order_id is not null or o.executed_quantity<>0
    or r.lease_owner is distinct from p_lease_owner or r.lease_until is null or r.lease_until<=clock_timestamp()
    or r.status<>'ACTIVE' and not(r.status='PAUSED' and o.side='SELL')
    or o.side='BUY' and (e.kill_switch or r.last_error is not null
      or exists(select 1 from coinops.exchange_accounts where id=p_account_id and (status<>'ACTIVE' or kill_switch))
      or exists(select 1 from coinops.operators where id=p_operator_id and (status<>'ACTIVE' or kill_switch))) then
    raise exception 'COINOPS_ACCOUNT_ORDER_BUDGET_SCOPE_DENIED';
  end if;
  select * into prior from coinops.account_order_budget_reservations where client_order_id=p_client_order_id;
  if prior.client_order_id is not null and (prior.operator_id,prior.exchange_account_id,
    prior.trading_engine_id,prior.executor_shard_id) is distinct from (p_operator_id,p_account_id,p_engine_id,e.executor_shard_id) then
    raise exception 'COINOPS_ACCOUNT_ORDER_BUDGET_IDENTITY_COLLISION';
  end if;
  protected:=case when o.side='BUY' then 1 else 0 end;
  cost:=case when prior.client_order_id is null then 1+protected else 0 end;
  -- A TP consumes the protective credit of its own terminal, reconciled BUY.
  -- Never consume another engine/run/slot/operation's reserve, even same symbol.
  if prior.client_order_id is null and o.side='SELL' then
    select b.* into parent from coinops.account_order_budget_reservations b
      join coinops.robot_v1_live_orders own_buy on own_buy.client_order_id=b.client_order_id
      where b.exchange_account_id=p_account_id and b.operator_id=p_operator_id and b.trading_engine_id=p_engine_id
        and b.executor_shard_id=e.executor_shard_id and b.protection_orders>0
        and own_buy.run_id=o.run_id and own_buy.slot_id=o.slot_id and own_buy.operation_sequence=o.operation_sequence
        and own_buy.side='BUY' and own_buy.executed_quantity>0 and own_buy.trades_reconciled
        and own_buy.status in('FILLED','CANCELED','EXPIRED','EXPIRED_IN_MATCH')
      order by b.reserved_at,b.client_order_id limit 1 for update of b;
    if parent.client_order_id is not null then
      update coinops.account_order_budget_reservations set protection_orders=protection_orders-1
        where client_order_id=parent.client_order_id;
    end if;
  end if;
  budget:=private.coinops_account_order_budget_gate(p_operator_id,p_account_id,cost,jsonb_build_object(e.symbol,0));
  if budget->>'code' is distinct from 'PASS' then
    if parent.client_order_id is not null then
      update coinops.account_order_budget_reservations set protection_orders=protection_orders+1
        where client_order_id=parent.client_order_id;
    end if;
    return budget;
  end if;
  if prior.client_order_id is null then
    insert into coinops.account_order_budget_reservations(client_order_id,exchange_account_id,operator_id,
      trading_engine_id,executor_shard_id,protection_orders)
    values(p_client_order_id,p_account_id,p_operator_id,p_engine_id,e.executor_shard_id,protected);
  end if;
  select * into sample from coinops.account_order_budget_samples where exchange_account_id=p_account_id;
  select least(extract(epoch from sample.observed_at)*1000+30000,
    min((floor(sample.server_time_ms/(value->>'intervalMs')::numeric)+1)*(value->>'intervalMs')::numeric
      -(sample.server_time_ms-extract(epoch from sample.observed_at)*1000))) into expires_ms
    from jsonb_array_elements(sample.intervals);
  return budget||jsonb_build_object('clientOrderId',p_client_order_id,'engineId',p_engine_id,
    'accountId',p_account_id,'operatorId',p_operator_id,'shardId',e.executor_shard_id,
    'expiresAt',floor(expires_ms),'replayed',prior.client_order_id is not null);
end $$;
revoke all on function coinops.reserve_account_order_budget(uuid,uuid,uuid,text,uuid) from public,anon,authenticated;
grant execute on function coinops.reserve_account_order_budget(uuid,uuid,uuid,text,uuid) to service_role;

create function coinops.acknowledge_account_order_budget(p_operator_id uuid,p_account_id uuid,
  p_engine_id uuid,p_client_order_id text,p_lease_owner uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare own_order coinops.robot_v1_live_orders%rowtype; own_run coinops.robot_v1_live_runs%rowtype;
begin
  if coalesce(nullif(current_setting('request.jwt.claim.role',true),''),auth.jwt()->>'role','')<>'service_role'
    or p_operator_id is null or p_account_id is null or p_engine_id is null
    or p_client_order_id is null or p_lease_owner is null then
    raise exception 'COINOPS_ACCOUNT_ORDER_BUDGET_SCOPE_DENIED';
  end if;
  perform 1 from coinops.exchange_accounts where id=p_account_id and operator_id=p_operator_id for update;
  if not found then raise exception 'COINOPS_ACCOUNT_ORDER_BUDGET_SCOPE_DENIED'; end if;
  select * into own_order from coinops.robot_v1_live_orders where client_order_id=p_client_order_id
    and operator_id=p_operator_id and exchange_account_id=p_account_id and trading_engine_id=p_engine_id;
  select * into own_run from coinops.robot_v1_live_runs where id=own_order.run_id;
  if own_order.id is null or own_order.exchange_order_id is null or own_order.status='PREPARED'
    or own_run.lease_owner is distinct from p_lease_owner
    or own_run.lease_until is null or own_run.lease_until<=clock_timestamp() then
    raise exception 'COINOPS_ACCOUNT_ORDER_BUDGET_ACK_UNPROVEN';
  end if;
  update coinops.account_order_budget_reservations set acknowledged_at=clock_timestamp()
    where client_order_id=p_client_order_id and operator_id=p_operator_id and exchange_account_id=p_account_id
      and trading_engine_id=p_engine_id and acknowledged_at is null;
  -- Retire only the unused future TP credit of a terminal BUY with proven zero
  -- fills. Unknown submissions and partially filled STP orders keep protection.
  if own_order.side='BUY' and own_order.status in('CANCELED','EXPIRED','EXPIRED_IN_MATCH','REJECTED')
    and own_order.executed_quantity=0 and own_order.cumulative_quote=0 and own_order.trades_reconciled then
    update coinops.account_order_budget_reservations set protection_orders=0
      where client_order_id=p_client_order_id and operator_id=p_operator_id and exchange_account_id=p_account_id
        and trading_engine_id=p_engine_id;
  end if;
  return exists(select 1 from coinops.account_order_budget_reservations where client_order_id=p_client_order_id
    and operator_id=p_operator_id and exchange_account_id=p_account_id and trading_engine_id=p_engine_id and acknowledged_at is not null);
end $$;
revoke all on function coinops.acknowledge_account_order_budget(uuid,uuid,uuid,text,uuid) from public,anon,authenticated;
grant execute on function coinops.acknowledge_account_order_budget(uuid,uuid,uuid,text,uuid) to service_role;

-- The original submission guard NEVER changes. Preserve the certified unsent
-- receipt separately and consume it exactly once on the next owned dispatch.
alter table coinops.robot_v1_live_orders add column account_order_unsent_receipt jsonb
  check(account_order_unsent_receipt is null or jsonb_typeof(account_order_unsent_receipt)='object');
revoke select(account_order_unsent_receipt) on coinops.robot_v1_live_orders from anon;

-- The caller first authenticates the exact invocation's no-POST receipt using
-- its shard HMAC. CAS of dispatched_at prevents an old receipt from releasing
-- a later submission; no original guard or append-only audit is erased.
create function coinops.release_proven_unsent_account_order(p_operator_id uuid,p_account_id uuid,p_engine_id uuid,
  p_client_order_id text,p_lease_owner uuid,p_dispatched_at timestamptz,p_proof jsonb) returns boolean
language plpgsql security definer set search_path='' as $$
declare o coinops.robot_v1_live_orders%rowtype; r coinops.robot_v1_live_runs%rowtype;
  d coinops.robot_v1_strategy_decisions%rowtype; shard text; proof_time timestamptz;
begin
  if coalesce(nullif(current_setting('request.jwt.claim.role',true),''),auth.jwt()->>'role','')<>'service_role'
    or p_dispatched_at is null or jsonb_typeof(p_proof) is distinct from 'object' then
    raise exception 'COINOPS_ACCOUNT_ORDER_UNSENT_UNPROVEN';
  end if;
  select * into o from coinops.robot_v1_live_orders where operator_id=p_operator_id and exchange_account_id=p_account_id
    and trading_engine_id=p_engine_id and client_order_id=p_client_order_id for update;
  select * into r from coinops.robot_v1_live_runs where id=o.run_id for update;
  select * into d from coinops.robot_v1_strategy_decisions where trading_engine_id=p_engine_id
    and decision_id=o.strategy_decision_id and environment='REAL' for update;
  select executor_shard_id into shard from coinops.trading_engines where id=p_engine_id;
  if o.id is null or r.id is null or d.id is null or r.lease_owner is distinct from p_lease_owner
    or r.lease_until is null or r.lease_until<=clock_timestamp()
    or o.submission_guarded_at is null or o.status<>'PREPARED'
    or o.exchange_order_id is not null or o.executed_quantity<>0 or o.cumulative_quote<>0
    or d.result<>'DISPATCHED' or d.dispatched_at is distinct from p_dispatched_at
    or d.exchange_ack_at is not null or d.completed_at is not null
    or d.cycle_id<>r.id or d.slot_id is distinct from o.slot_id or d.operation_sequence is distinct from o.operation_sequence
    or p_proof->>'outcome' is distinct from 'NOT_SUBMITTED' or p_proof->>'protocol' is distinct from '1'
    or p_proof->>'operator_id' is distinct from p_operator_id::text
    or p_proof->>'exchange_account_id' is distinct from p_account_id::text
    or p_proof->>'trading_engine_id' is distinct from p_engine_id::text
    or p_proof->>'executor_shard_id' is distinct from shard or p_proof->>'environment' is distinct from 'REAL'
    or p_proof->>'symbol' is distinct from r.symbol or p_proof->>'clientOrderId' is distinct from p_client_order_id
    or p_proof->>'decision_id' is distinct from d.decision_id
    or coalesce(p_proof->>'bodyHash','') !~ '^[a-f0-9]{64}$'
    or coalesce(p_proof->>'request_nonce','') !~ '^[a-zA-Z0-9_-]{16,128}$'
    or coalesce(p_proof->>'observedAt','') !~ '^[0-9]{13}$' then
    raise exception 'COINOPS_ACCOUNT_ORDER_UNSENT_UNPROVEN';
  end if;
  proof_time:=to_timestamp((p_proof->>'observedAt')::numeric/1000);
  if proof_time<p_dispatched_at-interval '2 seconds' or proof_time>clock_timestamp()+interval '2 seconds'
    or proof_time<=clock_timestamp()-interval '60 seconds' then raise exception 'COINOPS_ACCOUNT_ORDER_UNSENT_UNPROVEN';end if;
  insert into coinops.robot_v1_live_events(run_id,product_id,tenant_id,user_id,operator_id,exchange_account_id,trading_engine_id,
    quote_asset,event_key,event_type,slot_number,details)
  values(r.id,r.product_id,r.tenant_id,r.user_id,p_operator_id,p_account_id,p_engine_id,r.quote_asset,
    'ACCOUNT_ORDER_NOT_SUBMITTED:'||(p_proof->>'request_nonce'),'ACCOUNT_ORDER_NOT_SUBMITTED',o.slot_number,p_proof);
  update coinops.robot_v1_strategy_decisions set result='PENDING',dispatched_at=null,error=null where id=d.id;
  update coinops.robot_v1_live_orders set account_order_unsent_receipt=p_proof where id=o.id;
  return true;
end $$;
revoke all on function coinops.release_proven_unsent_account_order(uuid,uuid,uuid,text,uuid,timestamptz,jsonb) from public,anon,authenticated;
grant execute on function coinops.release_proven_unsent_account_order(uuid,uuid,uuid,text,uuid,timestamptz,jsonb) to service_role;

create function coinops.claim_proven_unsent_account_order(p_operator_id uuid,p_account_id uuid,p_engine_id uuid,
  p_client_order_id text,p_lease_owner uuid,p_proof_nonce text) returns timestamptz
language plpgsql security definer set search_path='' as $$
declare o coinops.robot_v1_live_orders%rowtype; r coinops.robot_v1_live_runs%rowtype;
  d coinops.robot_v1_strategy_decisions%rowtype; dispatched timestamptz:=clock_timestamp();
begin
  if coalesce(nullif(current_setting('request.jwt.claim.role',true),''),auth.jwt()->>'role','')<>'service_role'
    or p_proof_nonce is null then raise exception 'COINOPS_ACCOUNT_ORDER_UNSENT_UNPROVEN'; end if;
  select * into o from coinops.robot_v1_live_orders where operator_id=p_operator_id and exchange_account_id=p_account_id
    and trading_engine_id=p_engine_id and client_order_id=p_client_order_id for update;
  select * into r from coinops.robot_v1_live_runs where id=o.run_id for update;
  select * into d from coinops.robot_v1_strategy_decisions where trading_engine_id=p_engine_id
    and decision_id=o.strategy_decision_id and environment='REAL' for update;
  if o.id is null or r.id is null or d.id is null or r.lease_owner is distinct from p_lease_owner
    or r.lease_until is null or r.lease_until<=clock_timestamp() or o.status<>'PREPARED'
    or o.exchange_order_id is not null or o.executed_quantity<>0 or o.cumulative_quote<>0
    or o.submission_guarded_at is null or o.account_order_unsent_receipt->>'request_nonce' is distinct from p_proof_nonce
    or d.result<>'PENDING' or d.dispatched_at is not null or d.exchange_ack_at is not null or d.completed_at is not null
    or d.cycle_id<>r.id or d.slot_id is distinct from o.slot_id or d.operation_sequence is distinct from o.operation_sequence then
    raise exception 'COINOPS_ACCOUNT_ORDER_UNSENT_UNPROVEN';
  end if;
  update coinops.robot_v1_live_orders set account_order_unsent_receipt=null where id=o.id;
  update coinops.robot_v1_strategy_decisions set dispatched_at=dispatched,result='DISPATCHED',error=null where id=d.id;
  return dispatched;
end $$;
revoke all on function coinops.claim_proven_unsent_account_order(uuid,uuid,uuid,text,uuid,text) from public,anon,authenticated;
grant execute on function coinops.claim_proven_unsent_account_order(uuid,uuid,uuid,text,uuid,text) to service_role;

-- Short-lived, server-observed allocation evidence. No API keys or exchange
-- history. Account lock at append rejects a concurrently changed allocation.
create table coinops.account_engine_append_previews (
  exchange_account_id uuid not null,
  operator_id uuid not null,
  request_id uuid not null,
  input jsonb not null,
  preview_hash text not null check(preview_hash ~ '^[a-f0-9]{64}$'),
  observed_at timestamptz not null,
  expected_account_cap numeric not null check(expected_account_cap>=0),
  engine_inventory jsonb not null check(jsonb_typeof(engine_inventory)='array'),
  available_capital numeric not null check(available_capital>=0),
  primary key(exchange_account_id,request_id),
  foreign key(exchange_account_id,operator_id) references coinops.exchange_accounts(id,operator_id)
);
alter table coinops.account_engine_append_previews enable row level security;
alter table coinops.account_engine_append_previews force row level security;
revoke all on coinops.account_engine_append_previews from public,anon,authenticated;
grant select,insert,update on coinops.account_engine_append_previews to service_role;

create function coinops.append_operator_engine_plan(p_operator_id uuid,p_account_id uuid,p_shard_id text,
  p_quote_asset text,p_authorized_capital numeric,p_engines jsonb,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  a coinops.exchange_accounts%rowtype; op coinops.operators%rowtype;
  replay coinops.account_onboarding_checks%rowtype; connection coinops.account_executor_connections%rowtype;
  item jsonb; input jsonb; result jsonb:='[]'; admission jsonb; budget jsonb; symbol_counts jsonb; eid uuid;
  asset text; cap numeric; gain numeric; spacing numeric; post_ath numeric; target integer;
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
    if replay.operator_id<>op.id or replay.evidence->'input' is distinct from input then
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
  admission:=coinops.preview_executor_admission(p_shard_id,'REAL',jsonb_array_length(p_engines));
  if admission->>'code' is distinct from 'CAPACITY_OK' then raise exception 'COINOPS_CAPACITY_REQUIRED'; end if;
  for item in select value from jsonb_array_elements(p_engines) loop
    if jsonb_typeof(item) is distinct from 'object' or not (item ?& array['asset','capital','gain','spacing','postAth','monthlyTarget'])
      or (select count(*) from jsonb_object_keys(item))<>6 then raise exception 'COINOPS_PLAN_INPUT_DENIED'; end if;
    asset:=item->>'asset'; cap:=(item->>'capital')::numeric; gain:=(item->>'gain')::numeric;
    spacing:=(item->>'spacing')::numeric; post_ath:=(item->>'postAth')::numeric; target:=(item->>'monthlyTarget')::integer;
    if asset is null or asset not in ('BTC','SOL') or cap is null or cap<=0 or cap<>round(cap,2)
      or cap::text in ('NaN','Infinity','-Infinity')
      or gain is null or gain not between .001 and .2 or spacing is null or spacing not between .001 and .2
      or post_ath is null or post_ath not between .001 and .2 or target is null or target<1
      or (item->>'monthlyTarget')::numeric<>target then raise exception 'COINOPS_PLAN_RATE_INVALID'; end if;
    total:=total+cap;
  end loop;
  if total<>p_authorized_capital then raise exception 'COINOPS_PLAN_CAP_SUM_MISMATCH'; end if;
  select jsonb_object_agg(symbol,n) into symbol_counts from
    (select (value->>'asset')||p_quote_asset symbol,count(*) n from jsonb_array_elements(p_engines) group by 1) counts;
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
    spacing:=(item->>'spacing')::numeric; post_ath:=(item->>'postAth')::numeric; target:=(item->>'monthlyTarget')::integer;
    insert into coinops.trading_engines(operator_id,exchange_account_id,environment,symbol,base_asset,quote_asset,
      ath_reference_symbol,status,kill_switch,legacy_compatible,hard_cap_quote,executor_shard_id,config)
    values(op.id,a.id,'REAL',asset||p_quote_asset,asset,p_quote_asset,asset||p_quote_asset,'INACTIVE',true,false,cap,p_shard_id,
      jsonb_build_object('slot_count',25,'initial_slot_quote',cap/25,'capital_quote',cap,'max_order_quote',cap,
        'gain_rate',gain,'normal_spacing_rate',spacing,'post_ath_spacing_rate',post_ath,'monthly_target',target)) returning id into eid;
    insert into coinops.executor_capacity_admissions(engine_id,shard_id,environment,reserved_weight,expires_at)
      values(eid,p_shard_id,'REAL',(coinops.executor_capacity_policy()->>'incremental_weight')::numeric,
        clock_timestamp()+interval '5 minutes');
    insert into coinops.robot_v1_ath_profiles(product_id,tenant_id,user_id,operator_id,exchange_account_id,trading_engine_id,
      environment,asset,quote_asset,config_version,gain_rate,normal_spacing_rate,post_ath_spacing_rate,regime)
    values(op.product_id,op.tenant_id,op.user_id,op.id,a.id,eid,'REAL',asset,p_quote_asset,1,gain,spacing,post_ath,'NORMAL');
    insert into coinops.robot_v1_live_preparations(product_id,tenant_id,user_id,operator_id,exchange_account_id,trading_engine_id,
      asset,symbol,quote_asset,slot_count,monthly_target,configured_live_capital_brl,max_order_notional_brl,max_total_exposure_brl,
      compounding_enabled,single_active_entry,initial_market_enabled,local_reentry_enabled,kill_switch,live_enabled)
    values(op.product_id,op.tenant_id,op.user_id,op.id,a.id,eid,asset,asset||p_quote_asset,p_quote_asset,25,target,cap,cap,cap,true,true,true,true,true,false);
    insert into coinops.robot_v1_live_slot_accounts(product_id,tenant_id,user_id,operator_id,exchange_account_id,trading_engine_id,asset,quote_asset,slot_number)
    select op.product_id,op.tenant_id,op.user_id,op.id,a.id,eid,asset,p_quote_asset,n from generate_series(1,25)n;
    result:=result||jsonb_build_array(jsonb_build_object('engineId',eid,'symbol',asset||p_quote_asset,'capital',cap,'status','INACTIVE','environment','REAL','shardId',p_shard_id));
  end loop;
  insert into coinops.account_onboarding_checks(operator_id,exchange_account_id,check_key,status,evidence,created_by,idempotency_key)
  values(op.id,a.id,'ENGINE_APPEND','PASS',jsonb_build_object('input',input,'result',result,'previousAccountCap',old_cap,
    'accountCap',old_cap+total,'shardId',p_shard_id),op.user_id,'engine-append:'||p_request_id::text);
  return result;
end $$;
revoke all on function coinops.append_operator_engine_plan(uuid,uuid,text,text,numeric,jsonb,uuid) from public,anon,authenticated;
grant execute on function coinops.append_operator_engine_plan(uuid,uuid,text,text,numeric,jsonb,uuid) to service_role;

-- Sanitized read model for authenticated reports. Private connection/policy/
-- dispatch tables keep their service-only grants. Authorization is evaluated
-- again inside this definer before accessing them; no UID, vault, secret,
-- signature or transferable permit leaves the database.
create function coinops.read_engine_isolation_report(p_engine_ids uuid[])
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
  if p_engine_ids is null or cardinality(p_engine_ids)>100
    or cardinality(p_engine_ids)<>(select count(distinct id)from unnest(p_engine_ids)requested(id))
    or exists(select 1 from unnest(p_engine_ids) requested(id) where requested.id is null
      or not exists(select 1 from coinops.trading_engines e where e.id=requested.id
        and private.coinops_operator_owned(e.operator_id))) then
    raise exception 'COINOPS_REPORT_ENGINE_DENIED';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'operator_id',e.operator_id,'exchange_account_id',e.exchange_account_id,'trading_engine_id',e.id,
    'environment',e.environment,'symbol',e.symbol,'asset',e.base_asset,'quote_asset',e.quote_asset,
    'executor_shard_id',e.executor_shard_id,'order_owner_prefix',e.order_owner_prefix,
    'identity_contract','ACCOUNT_ENGINE_SHARD','credential_status',c.status,'credential_checked_at',c.checked_at,
    'isolation_contract',p.contract,'isolation_status',p.status,'executor_version',p.executor_version,
    'enforcement_checked_at',p.proofs->e.executor_shard_id->>'checkedAt',
    'maker_preserving_stp',coalesce((p.proofs->e.executor_shard_id->>'enabled')::boolean,false),
    'account_budget_observed_at',b.observed_at,'account_budget_source_shard',b.source_shard_id,
    'account_budget_evidence_state',case when b.observed_at between now()-interval '30 seconds'and now()+interval '2 seconds'
      then 'RECENT_SAMPLE_NOT_ADMISSION_PROOF' else 'UNKNOWN_OR_STALE' end,
    'unacknowledged_dispatches',(select count(*) from coinops.account_order_budget_reservations r
      where r.trading_engine_id=e.id and r.acknowledged_at is null),
    'reserved_protection_orders',(select coalesce(sum(r.protection_orders),0)from coinops.account_order_budget_reservations r where r.trading_engine_id=e.id),
    'evidence_basis','CURRENT_PERSISTED_ENGINE_ISOLATION_METADATA_NOT_RUNTIME_SMOKE'
  ) order by e.id),'[]') into result from coinops.trading_engines e
    left join coinops.account_executor_connections c on c.exchange_account_id=e.exchange_account_id
      and c.operator_id=e.operator_id and c.executor_shard_id=e.executor_shard_id and c.environment=e.environment
    left join coinops.account_execution_policies p on p.exchange_account_id=e.exchange_account_id and p.operator_id=e.operator_id
    left join coinops.account_order_budget_samples b on b.exchange_account_id=e.exchange_account_id and b.operator_id=e.operator_id
    where e.id=any(p_engine_ids);
  return result;
end $$;
revoke all on function coinops.read_engine_isolation_report(uuid[]) from public,anon,authenticated;
grant execute on function coinops.read_engine_isolation_report(uuid[]) to authenticated;

-- Preserve the canonical formula/hysteresis. Only ownership resolution changes.
create or replace function coinops.reserve_executor_capacity(p_shard_id text,p_engine_id uuid)
returns text language plpgsql security invoker set search_path='' as $$
declare s record; owner_shard text; env text; decision jsonb;
begin
  select e.executor_shard_id,e.environment into owner_shard,env
    from coinops.trading_engines e join coinops.exchange_accounts a
      on a.id=e.exchange_account_id and a.operator_id=e.operator_id
    where e.id=p_engine_id and e.environment in ('REAL','TESTNET') for update of a;
  if owner_shard is null or owner_shard<>p_shard_id then return 'CAPACITY_UNKNOWN'; end if;
  select * into s from coinops.executor_shards where id=p_shard_id and enabled for update;
  if not found then return 'CAPACITY_UNKNOWN'; end if;
  decision:=coinops.preview_executor_admission(p_shard_id,env,1,p_engine_id);
  if decision->>'code' is distinct from 'CAPACITY_OK' then return coalesce(decision->>'code','CAPACITY_UNKNOWN'); end if;
  insert into coinops.executor_capacity_admissions(engine_id,shard_id,environment,reserved_weight,expires_at)
  values(p_engine_id,p_shard_id,env,s.incremental_engine_weight,now()+interval '20 minutes')
  on conflict(engine_id) do update set shard_id=excluded.shard_id,environment=excluded.environment,
    reserved_weight=excluded.reserved_weight,reserved_at=now(),expires_at=excluded.expires_at;
  return 'CAPACITY_OK';
end $$;
revoke all on function coinops.reserve_executor_capacity(text,uuid) from public,anon,authenticated;
grant execute on function coinops.reserve_executor_capacity(text,uuid) to service_role;
commit;
