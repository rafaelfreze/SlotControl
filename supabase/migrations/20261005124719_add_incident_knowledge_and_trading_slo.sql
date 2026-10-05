-- Observability only: no order, slot, strategy, balance or gate mutation.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '60s';
alter table coinops.watchdog_checks add column reconciling_engines integer not null default 0 check(reconciling_engines>=0);

create table coinops.incident_knowledge (
  operator_id uuid not null references coinops.operators(id),
  incident_signature text not null,
  root_cause text not null default 'UNVERIFIED_HISTORICAL_CAUSE',
  safe_recovery text not null default 'FAIL_CLOSED_AND_INVESTIGATE',
  first_seen timestamptz not null, last_seen timestamptz not null,
  occurrences bigint not null default 0, auto_recoveries bigint not null default 0,
  permanent_fix_version text, regression_test text, fixed_at timestamptz,
  status text not null default 'INVESTIGATE' check(status in ('INVESTIGATE','FIXED','RECURRENCE_REGRESSION')),
  priority text not null default 'NORMAL' check(priority in ('NORMAL','HIGH')),
  primary key(operator_id,incident_signature)
);
create table coinops.incident_knowledge_occurrences (
  incident_id uuid primary key references coinops.watchdog_incidents(incident_id),
  operator_id uuid not null references coinops.operators(id),
  incident_signature text not null,
  root_code text not null, stage text not null,
  foreign key(operator_id,incident_signature) references coinops.incident_knowledge(operator_id,incident_signature)
);
create index incident_knowledge_occurrences_signature on coinops.incident_knowledge_occurrences(operator_id,incident_signature);
alter table coinops.incident_knowledge enable row level security;
alter table coinops.incident_knowledge force row level security;
alter table coinops.incident_knowledge_occurrences enable row level security;
alter table coinops.incident_knowledge_occurrences force row level security;
revoke all on coinops.incident_knowledge,coinops.incident_knowledge_occurrences from public,anon,authenticated;
grant select,insert,update on coinops.incident_knowledge,coinops.incident_knowledge_occurrences to service_role;

-- Called only by the watchdog audit trigger/backfill. No financial recovery authority.
create function coinops.record_incident_knowledge(p_id uuid) returns void
language plpgsql security invoker set search_path=pg_catalog,coinops as $$
declare i coinops.watchdog_incidents; op uuid; evidence jsonb; sig text; root text; stage text;
begin
  select * into i from coinops.watchdog_incidents where incident_id=p_id;
  select operator_id into op from coinops.trading_engines where id=i.engine_id and exchange_account_id=i.account_id;
  if op is null then return; end if; -- shard-wide incidents have no invented account owner
  select a.details into evidence from coinops.robot_v1_live_alerts a
    where a.trading_engine_id=i.engine_id and a.exchange_account_id=i.account_id
      and a.operator_id=op and a.alert_key='LIVE_RUN:'||split_part(i.incident_key,':',1)||':CRITICAL'
      and a.code=i.detected_condition and a.first_seen_at<=i.opened_at+interval '1 minute'
    order by a.last_seen_at desc limit 1;
  root:=case when evidence->>'root_code' ~ '^(EXECUTOR|COINOPS)_[A-Z0-9_]+$' then evidence->>'root_code' else 'UNKNOWN' end;
  stage:=case when evidence->>'stage' ~ '^[A-Z_]+$' then evidence->>'stage' else 'UNKNOWN' end;
  sig:=i.detected_condition||':'||root||':'||stage;
  -- Once assigned, a historical episode must not change signature because an alert row was reused.
  select o.incident_signature,o.root_code,o.stage into sig,root,stage from coinops.incident_knowledge_occurrences o where o.incident_id=p_id;
  if not found then
    root:=case when evidence->>'root_code' ~ '^(EXECUTOR|COINOPS)_[A-Z0-9_]+$' then evidence->>'root_code' else 'UNKNOWN' end;
    stage:=case when evidence->>'stage' ~ '^[A-Z_]+$' then evidence->>'stage' else 'UNKNOWN' end;
    sig:=i.detected_condition||':'||root||':'||stage;
  end if;
  insert into coinops.incident_knowledge(operator_id,incident_signature,first_seen,last_seen)
    values(op,sig,i.opened_at,i.last_seen_at) on conflict do nothing;
  -- Serialize aggregates for two engines/shards reporting the same signature concurrently.
  perform 1 from coinops.incident_knowledge where operator_id=op and incident_signature=sig for update;
  insert into coinops.incident_knowledge_occurrences values(p_id,op,sig,root,stage) on conflict do nothing;
  update coinops.incident_knowledge k set
    first_seen=least(k.first_seen,i.opened_at),last_seen=greatest(k.last_seen,i.last_seen_at),
    occurrences=(select count(*) from coinops.incident_knowledge_occurrences o where o.operator_id=op and o.incident_signature=sig),
    auto_recoveries=(select count(*) from coinops.incident_knowledge_occurrences o join coinops.watchdog_incidents w using(incident_id)
      where o.operator_id=op and o.incident_signature=sig and w.result='RECOVERED'
        and exists(select 1 from jsonb_array_elements(w.actions_taken) a where a->>'status' in ('OK','RESTARTED','RESUMED')
          and a->>'action' in ('EXISTING_ENGINE_RECONCILIATION','VERIFIED_READ_RECOVERY'))),
    status=case when k.fixed_at is not null and i.opened_at>k.fixed_at then 'RECURRENCE_REGRESSION' else k.status end,
    priority=case when k.fixed_at is not null and i.opened_at>k.fixed_at then 'HIGH' else k.priority end
    where k.operator_id=op and k.incident_signature=sig;
end $$;
create function coinops.capture_incident_knowledge() returns trigger
language plpgsql security invoker set search_path=pg_catalog,coinops as $$
begin perform coinops.record_incident_knowledge(new.incident_id); return new; end $$;
create trigger watchdog_incident_knowledge after insert or update of result,actions_taken,resolved_at
  on coinops.watchdog_incidents for each row execute function coinops.capture_incident_knowledge();
revoke all on function coinops.record_incident_knowledge(uuid),coinops.capture_incident_knowledge() from public,anon,authenticated;
grant execute on function coinops.record_incident_knowledge(uuid),coinops.capture_incident_knowledge() to service_role;
select coinops.record_incident_knowledge(incident_id) from coinops.watchdog_incidents;

-- Exact verified root signature; generic historical failures are deliberately NOT marked fixed.
insert into coinops.incident_knowledge(operator_id,incident_signature,root_cause,safe_recovery,
  first_seen,last_seen,permanent_fix_version,regression_test,fixed_at,status)
select distinct operator_id,'COINOPS_LIVE_RECONCILE_ORDERS_FAILED:EXECUTOR_ORDER_QUERY_FAILED:RECONCILE_ORDERS',
  'Named HTTP 503 observation bypassed generic read retry and lost its original cause',
  'Four read-only attempts with backoff, persistent bounded checkpoint; never retry an ambiguous write',
  now(),now(),'read-observation-v1','live-executor-transport.test.ts: named query 503',null::timestamptz,'INVESTIGATE'
from coinops.trading_engines where environment='REAL' on conflict do nothing;

-- Narrow event index: no index over every minute's RECONCILED payload.
create index live_events_trading_slo on coinops.robot_v1_live_events(operator_id,observed_at)
  where event_type in ('SLOT_PROFIT_CREDITED','ORDER_OBSERVED','TRADING_FLOW_OWNER','RUN_REANCHORED');

create function coinops.trading_reliability_summary(p_operator_id uuid,p_since timestamptz,p_until timestamptz default now())
returns jsonb language sql stable security invoker set search_path=pg_catalog,coinops as $$
with events as materialized (
  select * from coinops.robot_v1_live_events where operator_id=p_operator_id and observed_at>=p_since and observed_at<p_until
    and event_type in ('SLOT_PROFIT_CREDITED','ORDER_OBSERVED','TRADING_FLOW_OWNER','RUN_REANCHORED')
), effects as (
  select id,run_id,trading_engine_id,details,'GAIN' kind,details->>'tp_client_order_id' client_id from events where event_type='SLOT_PROFIT_CREDITED'
  union all
  select distinct on(trading_engine_id,run_id,details->>'client_order_id',(details->>'executed_quantity')::numeric) id,run_id,trading_engine_id,details,'FILL',details->>'client_order_id'
    from events where event_type='ORDER_OBSERVED' and (details->>'executed_quantity')::numeric>0
), attributed as (
  select f.*, (select m.details->>'source' from events m where m.event_type='TRADING_FLOW_OWNER'
      and m.trading_engine_id=f.trading_engine_id and m.run_id=f.run_id and m.details->>'kind'=f.kind
      and m.details->>'client_order_id'=f.client_id
      and (f.kind='GAIN' or (m.details->>'executed_quantity')::numeric=(f.details->>'executed_quantity')::numeric) limit 1) owner
    from effects f
), episodes as (
  select w.* from coinops.watchdog_incidents w join coinops.trading_engines e on e.id=w.engine_id and e.exchange_account_id=w.account_id
    where e.operator_id=p_operator_id and w.opened_at>=p_since and w.opened_at<p_until
), totals as (
 select count(*) effects,count(*) filter(where kind='GAIN') gains,count(*) filter(where kind='FILL') fills,
  count(*) filter(where owner='WATCHDOG') dependent,count(*) filter(where owner is null or owner='UNKNOWN') unattributed from attributed
), recovery as (
 select count(*) incidents,count(*) filter(where result='RECOVERED') recovered,
 count(*) filter(where result='RECOVERED' and exists(select 1 from jsonb_array_elements(actions_taken) a
   where a->>'action'='EXISTING_ENGINE_RECONCILIATION' and a->>'status' in ('OK','RESTARTED'))) watchdog_recoveries,
 count(*) filter(where result='RECOVERED' and actions_taken @> '[{"action":"VERIFIED_READ_RECOVERY","status":"RESUMED"}]') engine_recoveries,
 count(*) filter(where detected_condition like '%RECONCILE%' or detected_condition like '%RECONCILIATION%') reconciliation_failures,
 avg(recovery_duration_ms) filter(where result='RECOVERED') mean_recovery_ms from episodes
), cycles as (select count(*) n from events where event_type='RUN_REANCHORED')
select jsonb_build_object('since',p_since,'until',p_until,'gains',t.gains,'fills',t.fills,'normalTradingEvents',t.effects,
 'watchdogDependentEvents',t.dependent,'unattributedEvents',t.unattributed,
 'NORMAL_TRADING_WATCHDOG_DEPENDENCY_RATE',case when t.unattributed=0 then round(100.0*t.dependent/nullif(t.effects,0),2) else null end,
 'incidents',r.incidents,'autoRecoveries',r.watchdog_recoveries+r.engine_recoveries,'watchdogRecoveries',r.watchdog_recoveries,'engineRecoveries',r.engine_recoveries,
 'incidentsPer100Gains',round(100.0*r.incidents/nullif(t.gains,0),2),
 'autoRecoveriesPer100Gains',round(100.0*(r.watchdog_recoveries+r.engine_recoveries)/nullif(t.gains,0),2),
 'reconciliationFailuresPer100Cycles',round(100.0*r.reconciliation_failures/nullif(c.n,0),2),'completedCycles',c.n,
 'meanRecoveryMs',r.mean_recovery_ms,
 'signatures',coalesce((select jsonb_agg(to_jsonb(k) order by k.last_seen desc) from coinops.incident_knowledge k where k.operator_id=p_operator_id),'[]'::jsonb))
from totals t cross join recovery r cross join cycles c
$$;
revoke all on function coinops.trading_reliability_summary(uuid,timestamptz,timestamptz) from public,anon,authenticated;
grant execute on function coinops.trading_reliability_summary(uuid,timestamptz,timestamptz) to service_role;
commit;
