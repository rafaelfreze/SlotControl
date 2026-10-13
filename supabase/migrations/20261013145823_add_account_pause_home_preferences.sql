-- UI preference and immutable administrator audit only. No financial state is
-- modified. A paused engine remains ACTIVE in the registry for TP reconciliation.
begin;
create table coinops.account_home_preferences (
  operator_id uuid not null references coinops.operators(id),
  exchange_account_id uuid not null references coinops.exchange_accounts(id),
  hidden boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid not null,
  primary key(operator_id,exchange_account_id)
);
create table coinops.account_home_preference_events (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null references coinops.operators(id),
  exchange_account_id uuid not null references coinops.exchange_accounts(id),
  request_id uuid not null,
  hidden boolean not null,
  engine_ids uuid[] not null default '{}',
  changed_by uuid not null,
  observed_at timestamptz not null default now(),
  unique(operator_id,request_id)
);
create index account_home_events_recent_idx on coinops.account_home_preference_events(operator_id,exchange_account_id,observed_at desc);
alter table coinops.account_home_preferences enable row level security;
alter table coinops.account_home_preference_events enable row level security;
create policy account_home_preferences_owner_read on coinops.account_home_preferences for select to authenticated
using (operator_id in (select o.id from coinops.operators o where o.user_id=(select auth.uid()) and o.status='ACTIVE'));
create policy account_home_events_owner_read on coinops.account_home_preference_events for select to authenticated
using (operator_id in (select o.id from coinops.operators o where o.user_id=(select auth.uid()) and o.status='ACTIVE'));
revoke all on coinops.account_home_preferences,coinops.account_home_preference_events from public,anon,authenticated;
grant select on coinops.account_home_preferences,coinops.account_home_preference_events to authenticated;
grant select,insert,update on coinops.account_home_preferences to service_role;
grant select,insert on coinops.account_home_preference_events to service_role;

create function coinops.set_account_home_preference(p_operator_id uuid,p_account_id uuid,p_user_id uuid,
  p_hidden boolean,p_request_id uuid,p_expected_engine_ids uuid[] default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_engine_ids uuid[]; v_previous coinops.account_home_preference_events%rowtype; v_result jsonb;
begin
  if p_operator_id is null or p_account_id is null or p_user_id is null or p_request_id is null or p_hidden is null
    or not exists(select 1 from coinops.operators o join coinops.exchange_accounts a on a.operator_id=o.id
      where o.id=p_operator_id and o.user_id=p_user_id and o.status='ACTIVE' and not o.kill_switch
        and a.id=p_account_id and a.status='ACTIVE' and not a.kill_switch) then
    raise exception 'COINOPS_ACCOUNT_PAUSE_SCOPE_DENIED';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_operator_id::text||':'||p_account_id::text,0));
  select * into v_previous from coinops.account_home_preference_events
    where operator_id=p_operator_id and request_id=p_request_id;
  if found then
    if v_previous.exchange_account_id<>p_account_id or v_previous.hidden<>p_hidden then
      raise exception 'COINOPS_ACCOUNT_PAUSE_REQUEST_COLLISION';
    end if;
    select jsonb_build_object('hidden',hidden,'updated_at',updated_at) into v_result
      from coinops.account_home_preferences where operator_id=p_operator_id and exchange_account_id=p_account_id;
    return v_result;
  end if;
  select array_agg(id order by id) into v_engine_ids from coinops.trading_engines
    where operator_id=p_operator_id and exchange_account_id=p_account_id and environment='REAL' and status='ACTIVE';
  if p_hidden then
    if coalesce(cardinality(v_engine_ids),0)=0 or v_engine_ids is distinct from
      (select array_agg(x order by x) from unnest(p_expected_engine_ids) x) then
      raise exception 'COINOPS_ACCOUNT_PAUSE_INVENTORY_CHANGED';
    end if;
    -- Recheck pause gates and current-run identity in the same short transaction
    -- as the preference. TP/ownership/complete-ledger proof is additionally
    -- verified by the server and every Home projection. This RPC cannot trade.
    if exists(select 1 from coinops.trading_engines e where e.id=any(v_engine_ids) and
      (not e.kill_switch or e.strategy_config_pending
       or (select count(*) from coinops.robot_v1_live_runs r where r.operator_id=p_operator_id
         and r.exchange_account_id=p_account_id and r.trading_engine_id=e.id and r.status in('ACTIVE','PAUSED','PREPARING'))<>1
       or not exists(select 1 from coinops.robot_v1_live_runs r join coinops.robot_v1_live_preparations p
         on p.operator_id=r.operator_id and p.exchange_account_id=r.exchange_account_id and p.trading_engine_id=r.trading_engine_id
         where r.operator_id=p_operator_id and r.exchange_account_id=p_account_id and r.trading_engine_id=e.id
           and r.status='PAUSED' and r.last_error is null and r.last_reconciled_at>=now()-interval '3 minutes'
           and r.last_reconciled_at<=now()+interval '1 second' and p.live_enabled and p.kill_switch))) then
      raise exception 'COINOPS_ACCOUNT_PAUSE_PROTECTION_UNPROVEN';
    end if;
  end if;
  insert into coinops.account_home_preference_events(operator_id,exchange_account_id,request_id,hidden,engine_ids,changed_by)
    values(p_operator_id,p_account_id,p_request_id,p_hidden,coalesce(v_engine_ids,'{}'),p_user_id);
  insert into coinops.account_home_preferences(operator_id,exchange_account_id,hidden,updated_by)
    values(p_operator_id,p_account_id,p_hidden,p_user_id)
    on conflict(operator_id,exchange_account_id) do update set hidden=excluded.hidden,updated_at=now(),updated_by=excluded.updated_by;
  select jsonb_build_object('hidden',hidden,'updated_at',updated_at) into v_result from coinops.account_home_preferences
    where operator_id=p_operator_id and exchange_account_id=p_account_id;
  return v_result;
end; $$;
revoke all on function coinops.set_account_home_preference(uuid,uuid,uuid,boolean,uuid,uuid[]) from public,anon,authenticated;
grant execute on function coinops.set_account_home_preference(uuid,uuid,uuid,boolean,uuid,uuid[]) to service_role;
alter table coinops.watchdog_checks add column paused_engines integer not null default 0 check(paused_engines>=0);
commit;
