-- CoinOps / otdfpmsegjxpqrzisfmi / coinops, owner decision 2026-11-03.
-- Exclude September 2026 testing from goal accrual only. All lifetime credits,
-- original execution evidence, historical snapshots, prices and orders remain.
begin;
set local lock_timeout='2s';
set local statement_timeout='15s';

create or replace function coinops.october_slot_goal_policy(p_policy jsonb)
returns jsonb language plpgsql immutable set search_path='' as $policy$
declare v_period text;v_base jsonb;v_schedule jsonb;v_result jsonb;
begin
 perform coinops.cumulative_slot_goal_target(p_policy,(p_policy->>'anchor_at')::timestamptz);
 v_period:=to_char((p_policy->>'anchor_at')::timestamptz at time zone 'America/Campo_Grande','YYYY-MM');
 if v_period>='2026-10' then return p_policy;end if;
 if v_period<>'2026-09' or p_policy ? 'anchor_correction' or p_policy ? 'execution_anchor_at'
 then raise exception 'COINOPS_GOAL_START_CORRECTION_SCOPE_DENIED';end if;
 select value into strict v_base from jsonb_array_elements(p_policy->'schedule')
  where value->>'effective_period'<='2026-10' order by value->>'effective_period' desc limit 1;
 select coalesce(jsonb_agg(value order by value->>'effective_period'),'[]'::jsonb) into v_schedule
  from jsonb_array_elements(p_policy->'schedule') where value->>'effective_period'>'2026-10';
 v_schedule:=jsonb_build_array(jsonb_set(v_base,'{effective_period}','"2026-10"'::jsonb))||v_schedule;
 v_result:=p_policy||jsonb_build_object('anchor_at','2026-10-01T04:00:00Z',
  'execution_anchor_at',p_policy->>'anchor_at','schedule',v_schedule,
  'anchor_correction',jsonb_build_object('policy','EXCLUDE_SEPTEMBER_TEST_V1',
   'event_key','SLOT_GOAL_START:OCTOBER_2026_V1','previous_anchor_at',p_policy->>'anchor_at',
   'start_period','2026-10'));
 perform coinops.cumulative_slot_goal_target(v_result,'2026-11-01T04:00:00Z');
 return v_result;
end $policy$;
revoke all on function coinops.october_slot_goal_policy(jsonb) from public,anon,authenticated;
grant execute on function coinops.october_slot_goal_policy(jsonb) to service_role;

-- Normal immutability/prospective edits remain unchanged. The sole exception is
-- the exact one-time policy, supported by an immutable event and a live lease.
create or replace function coinops.preserve_cumulative_slot_goal_history()
returns trigger language plpgsql set search_path='' as $history$
declare v_period text;v_schedule jsonb;
begin
 if old.slot_goal_policy is not null then
  if new.slot_goal_policy is distinct from old.slot_goal_policy then
   if coalesce(nullif(current_setting('request.jwt.claim.role',true),''),auth.jwt()->>'role','')='service_role'
    and (to_jsonb(new)-'slot_goal_policy'-'updated_at')=(to_jsonb(old)-'slot_goal_policy'-'updated_at')
    and new.slot_goal_policy=coinops.october_slot_goal_policy(old.slot_goal_policy)
    and exists(select 1 from coinops.robot_v1_live_events ev
     join coinops.robot_v1_live_runs r on r.id=ev.run_id
     where ev.trading_engine_id=new.trading_engine_id and ev.operator_id=new.operator_id
      and ev.exchange_account_id=new.exchange_account_id and ev.product_id=new.product_id
      and ev.tenant_id=new.tenant_id and ev.user_id=new.user_id
      and ev.event_key='SLOT_GOAL_START:OCTOBER_2026_V1'
      and ev.event_type='SLOT_GOAL_START_CORRECTED'
      and ev.details->'before'=old.slot_goal_policy and ev.details->'after'=new.slot_goal_policy
      and ev.details->>'authorization'='OWNER_20261103_EXCLUDE_SEPTEMBER_TEST'
      and r.trading_engine_id=ev.trading_engine_id and r.operator_id=ev.operator_id
      and r.exchange_account_id=ev.exchange_account_id and r.product_id=ev.product_id
      and r.tenant_id=ev.tenant_id and r.user_id=ev.user_id
      and r.status='ACTIVE' and r.last_error is null and r.lease_owner is not null
      and r.lease_until>clock_timestamp() and ev.details->>'lease_owner'=r.lease_owner::text)
   then return new;end if;
   raise exception 'COINOPS_SLOT_GOAL_HISTORY_IMMUTABLE';
  end if;
  if new.monthly_target is distinct from old.monthly_target then
   v_period:=to_char((date_trunc('month',clock_timestamp() at time zone 'America/Campo_Grande')+interval '1 month'),'YYYY-MM');
   select coalesce(jsonb_agg(value order by value->>'effective_period'),'[]') into v_schedule
    from jsonb_array_elements(old.slot_goal_policy->'schedule') where value->>'effective_period'<>v_period;
   new.slot_goal_policy:=jsonb_set(old.slot_goal_policy,'{schedule}',v_schedule||jsonb_build_array(jsonb_build_object(
    'effective_period',v_period,'monthly_target',new.monthly_target,'source','CONFIG_VERSION:'||new.config_version::text)));
  end if;
 elsif new.slot_goal_policy is not null then
  perform coinops.cumulative_slot_goal_target(new.slot_goal_policy,clock_timestamp());
 end if;
 return new;
end $history$;
revoke all on function coinops.preserve_cumulative_slot_goal_history() from public,anon,authenticated;

create or replace function coinops.correct_cumulative_goal_october_start(p_run_id uuid,p_expected_policy jsonb)
returns jsonb language plpgsql set search_path='' set lock_timeout='2s' as $correct$
declare r coinops.robot_v1_live_runs%rowtype;p coinops.robot_v1_live_preparations%rowtype;
 e coinops.trading_engines%rowtype;v_owner uuid:=gen_random_uuid();v_next jsonb;
 v_event coinops.robot_v1_live_events%rowtype;v_anchor timestamptz;v_rows integer;
begin
 if coalesce(nullif(current_setting('request.jwt.claim.role',true),''),auth.jwt()->>'role','')<>'service_role'
 then raise exception 'COINOPS_GOAL_START_CORRECTION_SCOPE_DENIED';end if;
 select * into r from coinops.robot_v1_live_runs where id=p_run_id for update skip locked;
 if not found then return jsonb_build_object('status','DEFERRED','reason','RUN_BUSY');end if;
 select * into strict e from coinops.trading_engines where id=r.trading_engine_id for update nowait;
 select * into strict p from coinops.robot_v1_live_preparations where trading_engine_id=e.id for update nowait;
 if (p.operator_id,p.exchange_account_id,p.product_id,p.tenant_id,p.user_id,p.slot_count)
    is distinct from(r.operator_id,r.exchange_account_id,r.product_id,r.tenant_id,r.user_id,r.slot_count)
  or e.operator_id<>r.operator_id or e.exchange_account_id<>r.exchange_account_id
  or (e.product_id,e.tenant_id,e.user_id,e.slot_count) is distinct from(r.product_id,r.tenant_id,r.user_id,r.slot_count)
  or e.environment<>'REAL' or e.status<>'ACTIVE' or r.status<>'ACTIVE'
  or p.slot_goal_policy is null then raise exception 'COINOPS_GOAL_START_CORRECTION_SCOPE_DENIED';end if;
 if p.slot_goal_policy->'anchor_correction'->>'policy'='EXCLUDE_SEPTEMBER_TEST_V1' then
  select * into v_event from coinops.robot_v1_live_events where trading_engine_id=e.id
   and event_key='SLOT_GOAL_START:OCTOBER_2026_V1' and event_type='SLOT_GOAL_START_CORRECTED'
   and details->'after'=p.slot_goal_policy and details->'before'=p_expected_policy;
  if not found then raise exception 'COINOPS_GOAL_START_CORRECTION_REPLAY_MISMATCH';end if;
  return jsonb_build_object('status','ALREADY_APPLIED','engine',e.id,'policy',p.slot_goal_policy);
 end if;
 if p.slot_goal_policy is distinct from p_expected_policy
 then raise exception 'COINOPS_GOAL_START_CORRECTION_CONCURRENT_CHANGE';end if;
 v_next:=coinops.october_slot_goal_policy(p.slot_goal_policy);
 if v_next=p.slot_goal_policy then return jsonb_build_object('status','UNCHANGED','engine',e.id,'policy',v_next);end if;
 if r.lease_until>clock_timestamp() then return jsonb_build_object('status','DEFERRED','reason','LEASE_BUSY');end if;
 if r.last_error is not null or r.last_reconciled_at is null
  or r.last_reconciled_at<clock_timestamp()-interval '150 seconds'
  or e.kill_switch or e.strategy_config_pending or p.kill_switch or not p.live_enabled
  or exists(select 1 from coinops.robot_v1_live_alerts a where a.trading_engine_id=e.id and a.resolved_at is null and a.severity='CRITICAL')
  or exists(select 1 from coinops.strategy_bulk_engine_updates u where u.trading_engine_id=e.id and u.status in('PENDING','APPLYING','BLOCKED_SAFE'))
  or exists(select 1 from coinops.account_order_budget_reservations b where b.trading_engine_id=e.id and b.acknowledged_at is null)
  or exists(select 1 from coinops.robot_v1_strategy_decisions d where d.trading_engine_id=e.id and d.environment='REAL'
    and d.action_type in('OPEN_INITIAL_MARKET','CREATE_TP','ARM_NEXT_BUY','CANCEL_REPLACE_NEXT_BUY') and d.result is distinct from 'COMPLETED')
  or exists(select 1 from coinops.robot_v1_live_orders o where o.run_id=r.id
    and (o.status not in('NEW','FILLED','CANCELED','EXPIRED','REJECTED','EXPIRED_IN_MATCH')
      or o.executed_quantity>0 and not coalesce(o.trades_reconciled,false)))
 then return jsonb_build_object('status','DEFERRED','reason','ENGINE_NOT_SETTLED');end if;
 select min(f.filled_at) into v_anchor from coinops.robot_v1_live_fills f
  join coinops.robot_v1_live_orders o on o.id=f.order_id
  where o.trading_engine_id=e.id and o.operator_id=r.operator_id and o.exchange_account_id=r.exchange_account_id
   and o.product_id=r.product_id and o.tenant_id=r.tenant_id and o.user_id=r.user_id
   and o.side='BUY' and f.quantity>0 and o.trades_reconciled;
 if v_anchor is distinct from (p.slot_goal_policy->>'anchor_at')::timestamptz
 then raise exception 'COINOPS_GOAL_START_CORRECTION_ORIGIN_UNPROVEN';end if;
 update coinops.robot_v1_live_runs set lease_owner=v_owner,lease_until=clock_timestamp()+interval '30 seconds' where id=r.id;
 insert into coinops.robot_v1_live_events(run_id,product_id,tenant_id,user_id,operator_id,exchange_account_id,
  trading_engine_id,quote_asset,event_key,event_type,slot_number,details)
 values(r.id,r.product_id,r.tenant_id,r.user_id,r.operator_id,r.exchange_account_id,e.id,r.quote_asset,
  'SLOT_GOAL_START:OCTOBER_2026_V1','SLOT_GOAL_START_CORRECTED',null,
  jsonb_build_object('authorization','OWNER_20261103_EXCLUDE_SEPTEMBER_TEST','lease_owner',v_owner,
   'before',p.slot_goal_policy,'after',v_next,'execution_started_at',v_anchor,
   'historical_snapshots_rewritten',false,'lifetime_rewritten',false));
 update coinops.robot_v1_live_preparations set slot_goal_policy=v_next where id=p.id and slot_goal_policy=p_expected_policy;
 get diagnostics v_rows=row_count;
 if v_rows<>1 then raise exception 'COINOPS_GOAL_START_CORRECTION_CONCURRENT_CHANGE';end if;
 update coinops.robot_v1_live_runs set lease_owner=null,lease_until=null where id=r.id and lease_owner=v_owner;
 return jsonb_build_object('status','APPLIED','engine',e.id,'policy',v_next);
exception when lock_not_available then return jsonb_build_object('status','DEFERRED','reason','ROW_BUSY');
end $correct$;
revoke all on function coinops.correct_cumulative_goal_october_start(uuid,jsonb) from public,anon,authenticated;
grant execute on function coinops.correct_cumulative_goal_october_start(uuid,jsonb) to service_role;
commit;
