-- Extend the existing public-source health pipeline. Trading schemas and orders are untouched.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '60s';

alter table coinops.asset_health_snapshots drop constraint asset_health_snapshots_asset_check;
alter table coinops.asset_health_snapshots add constraint asset_health_snapshots_asset_check check (asset in ('BTC','SOL','BINANCE'));
alter table coinops.asset_health_snapshots drop constraint asset_health_snapshots_status_check;
alter table coinops.asset_health_snapshots add constraint asset_health_snapshots_status_check
  check ((asset = 'BINANCE' and status in ('HEALTHY','ATTENTION','CRITICAL_RISK','INSUFFICIENT_DATA'))
      or (asset in ('BTC','SOL') and status in ('HEALTHY','ATTENTION','STRUCTURAL_RISK','INSUFFICIENT_DATA')));
alter table coinops.asset_health_current drop constraint asset_health_current_asset_check;
alter table coinops.asset_health_current add constraint asset_health_current_asset_check check (asset in ('BTC','SOL','BINANCE'));
alter table coinops.asset_health_events drop constraint asset_health_events_asset_check;
alter table coinops.asset_health_events add constraint asset_health_events_asset_check check (asset in ('BTC','SOL','BINANCE'));
alter table coinops.asset_health_events drop constraint asset_health_events_status_before_check;
alter table coinops.asset_health_events add constraint asset_health_events_status_before_check
  check ((asset = 'BINANCE' and status_before in ('HEALTHY','ATTENTION','CRITICAL_RISK','INSUFFICIENT_DATA'))
      or (asset in ('BTC','SOL') and status_before in ('HEALTHY','ATTENTION','STRUCTURAL_RISK','INSUFFICIENT_DATA')));
alter table coinops.asset_health_events drop constraint asset_health_events_status_after_check;
alter table coinops.asset_health_events add constraint asset_health_events_status_after_check
  check ((asset = 'BINANCE' and status_after in ('HEALTHY','ATTENTION','CRITICAL_RISK','INSUFFICIENT_DATA'))
      or (asset in ('BTC','SOL') and status_after in ('HEALTHY','ATTENTION','STRUCTURAL_RISK','INSUFFICIENT_DATA')));

create or replace function coinops.asset_health_finish(
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
    or jsonb_array_length(p_snapshots) not between 1 and 3
    or p_cadences is null or jsonb_typeof(p_cadences) <> 'object'
    or p_duration_ms is null or p_duration_ms < 0 then
    raise exception 'ASSET_HEALTH_INVALID_PAYLOAD';
  end if;
  if (select count(distinct value->>'asset') from jsonb_array_elements(p_snapshots)) <> jsonb_array_length(p_snapshots)
    or (jsonb_array_length(p_snapshots)=3 and (select array_agg(value->>'asset' order by value->>'asset')
      from jsonb_array_elements(p_snapshots)) is distinct from array['BINANCE','BTC','SOL']::text[]) then
    raise exception 'ASSET_HEALTH_INVALID_SUBJECT_SET';
  end if;
  for v_cadence in select key,value from jsonb_each_text(p_cadences) loop
    if v_cadence.key not in ('FAST','STRUCTURAL','DEVELOPMENT') or v_cadence.value is null
      or not isfinite(v_cadence.value::timestamptz)
      or v_cadence.value::timestamptz > clock_timestamp()+interval '1 minute'
      or v_cadence.value::timestamptz < coalesce((v_state.cadence_completed_at->>v_cadence.key)::timestamptz,'-infinity'::timestamptz)
      then raise exception 'ASSET_HEALTH_INVALID_CADENCE'; end if;
  end loop;
  for v_assessment in select value from jsonb_array_elements(p_snapshots) loop
    v_asset := v_assessment->>'asset'; v_status := v_assessment->>'status';
    if jsonb_typeof(v_assessment) <> 'object' or v_asset is null or v_asset not in ('BTC','SOL','BINANCE')
      or v_status is null or not ((v_asset='BINANCE' and v_status in ('HEALTHY','ATTENTION','CRITICAL_RISK','INSUFFICIENT_DATA'))
        or (v_asset in ('BTC','SOL') and v_status in ('HEALTHY','ATTENTION','STRUCTURAL_RISK','INSUFFICIENT_DATA')))
      or jsonb_typeof(v_assessment->'metrics') is distinct from 'array'
      or jsonb_typeof(v_assessment->'reasons') is distinct from 'array'
      or jsonb_typeof(v_assessment->'sources') is distinct from 'array'
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
  if v_state.lease_until <= clock_timestamp() then raise exception 'ASSET_HEALTH_LEASE_EXPIRED'; end if;
  update coinops.asset_health_collector_state set
    last_success_at=clock_timestamp(), status=case when v_source_failures > 0 then 'DEGRADED' else 'HEALTHY' end,
    last_error_code=case when v_source_failures > 0 then 'ASSET_HEALTH_SOURCE_UNAVAILABLE' else null end,
    last_duration_ms=p_duration_ms, source_failures=v_source_failures,
    cadence_completed_at=cadence_completed_at||p_cadences, lease_token=null,lease_until=null where id='default';
  return true;
end $$;

comment on table coinops.asset_health_snapshots is 'Append-only BTC, SOL and Binance public-source observations; never a trading directive.';
commit;
