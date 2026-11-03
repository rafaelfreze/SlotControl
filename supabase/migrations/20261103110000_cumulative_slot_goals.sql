-- CoinOps / otdfpmsegjxpqrzisfmi / coinops. Additive, staged under each run lease.
-- No fills, money, orders, physical slots or historical snapshots are rewritten.
begin;
set local lock_timeout='2s';
set local statement_timeout='15s';
alter table coinops.robot_v1_live_preparations add column if not exists slot_goal_policy jsonb;

create or replace function coinops.cumulative_slot_goal_target(p_policy jsonb,p_at timestamptz)
returns integer language plpgsql immutable set search_path='' as $goal$
declare v_anchor text;v_current integer;v_start integer;v_prev integer:=-1;
 v_month integer;v_rate integer;v_total bigint:=0;v_version jsonb;
begin
 if p_policy->>'policy' is distinct from 'CUMULATIVE_LIFETIME_V1'
  or jsonb_typeof(p_policy->'schedule') is distinct from 'array'
  or jsonb_array_length(p_policy->'schedule')=0 or p_at is null
 then raise exception 'COINOPS_SLOT_GOAL_POLICY_INVALID';end if;
 v_anchor:=to_char((p_policy->>'anchor_at')::timestamptz at time zone 'America/Campo_Grande','YYYY-MM');
 if v_anchor is null then raise exception 'COINOPS_SLOT_GOAL_POLICY_INVALID';end if;
 v_start:=substr(v_anchor,1,4)::integer*12+substr(v_anchor,6,2)::integer-1;
 v_current:=extract(year from p_at at time zone 'America/Campo_Grande')::integer*12
  +extract(month from p_at at time zone 'America/Campo_Grande')::integer-1;
 if v_current<v_start then raise exception 'COINOPS_SLOT_GOAL_BEFORE_ANCHOR';end if;
 for v_version in select value from jsonb_array_elements(p_policy->'schedule') loop
  if coalesce(v_version->>'effective_period','') !~ '^\d{4}-(0[1-9]|1[0-2])$'
   or coalesce(v_version->>'monthly_target','') !~ '^\d+$'
   or coalesce(v_version->>'source','')='' then raise exception 'COINOPS_SLOT_GOAL_SCHEDULE_INVALID';end if;
  v_month:=substr(v_version->>'effective_period',1,4)::integer*12+substr(v_version->>'effective_period',6,2)::integer-1;
  if v_month<=v_prev or v_month<v_start or v_prev=-1 and v_month<>v_start
   or (v_version->>'monthly_target')::integer not between 1 and 1000
  then raise exception 'COINOPS_SLOT_GOAL_SCHEDULE_INVALID';end if;
  if v_prev<>-1 then v_total:=v_total+greatest(0,least(v_current+1,v_month)-v_prev)*v_rate;end if;
  v_prev:=v_month;v_rate:=(v_version->>'monthly_target')::integer;
 end loop;
 v_total:=v_total+greatest(0,v_current+1-v_prev)*v_rate;
 if v_total not between 1 and 2147483647 then raise exception 'COINOPS_SLOT_GOAL_TARGET_INVALID';end if;
 return v_total::integer;
end $goal$;
revoke all on function coinops.cumulative_slot_goal_target(jsonb,timestamptz) from public,anon,authenticated;
grant execute on function coinops.cumulative_slot_goal_target(jsonb,timestamptz) to service_role;

-- Immutable anchor and append-only versions. A target edit takes effect next
-- competence; multiple edits in one month retain every version (same next
-- competence is resolved by replacing its not-yet-effective schedule entry).
create or replace function coinops.preserve_cumulative_slot_goal_history()
returns trigger language plpgsql set search_path='' as $history$
declare v_period text;v_schedule jsonb;
begin
 if old.slot_goal_policy is not null then
  if new.slot_goal_policy is distinct from old.slot_goal_policy then
   raise exception 'COINOPS_SLOT_GOAL_HISTORY_IMMUTABLE';end if;
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
drop trigger if exists preserve_cumulative_slot_goal_history on coinops.robot_v1_live_preparations;
create trigger preserve_cumulative_slot_goal_history before update on coinops.robot_v1_live_preparations
for each row execute function coinops.preserve_cumulative_slot_goal_history();
revoke all on function coinops.preserve_cumulative_slot_goal_history() from public,anon,authenticated;

-- Adoption is idempotent and only occurs in the new worker, after reconciling
-- fills/protecting TP, under the existing engine run lease. Original BUY fill
-- across successor runs is the anchor; registry creation/update is not.
create or replace function coinops.adopt_cumulative_slot_goal(p_run_id uuid,p_lease_owner uuid)
returns jsonb language plpgsql set search_path='' as $adopt$
declare r coinops.robot_v1_live_runs%rowtype;p coinops.robot_v1_live_preparations%rowtype;
 v_anchor timestamptz;v_policy jsonb;
begin
 if coalesce(nullif(current_setting('request.jwt.claim.role',true),''),auth.jwt()->>'role','')<>'service_role'
 then raise exception 'COINOPS_SLOT_GOAL_SCOPE_DENIED';end if;
 select * into r from coinops.robot_v1_live_runs where id=p_run_id for update;
 if not found or p_lease_owner is null or r.lease_owner is distinct from p_lease_owner
  or r.lease_until is null or r.lease_until<=clock_timestamp() or r.status<>'ACTIVE' or r.last_error is not null
 then raise exception 'COINOPS_SLOT_GOAL_LEASE_DENIED';end if;
 select * into p from coinops.robot_v1_live_preparations where trading_engine_id=r.trading_engine_id for update;
 if not found or (p.operator_id,p.exchange_account_id,p.product_id,p.tenant_id,p.user_id,p.slot_count)
  is distinct from (r.operator_id,r.exchange_account_id,r.product_id,r.tenant_id,r.user_id,r.slot_count)
 then raise exception 'COINOPS_SLOT_GOAL_SCOPE_DENIED';end if;
 if p.slot_goal_policy is not null then return p.slot_goal_policy;end if;
 if not exists(select 1 from coinops.trading_engines e where e.id=r.trading_engine_id
  and e.environment='REAL' and not e.strategy_config_pending and e.status='ACTIVE'
  and e.operator_id=r.operator_id and e.exchange_account_id=r.exchange_account_id and e.slot_count=r.slot_count)
 then return null;end if;
 if exists(select 1 from coinops.robot_v1_live_runs prior where prior.trading_engine_id=r.trading_engine_id
  and prior.config_snapshot->>'monthly_target' is not null
  and (prior.config_snapshot->>'monthly_target')::integer<>p.monthly_target)
 then raise exception 'COINOPS_SLOT_GOAL_BASELINE_AMBIGUOUS';end if;
 select min(f.filled_at) into v_anchor from coinops.robot_v1_live_fills f
  join coinops.robot_v1_live_orders o on o.id=f.order_id
  join coinops.robot_v1_live_runs original on original.id=o.run_id
  where o.trading_engine_id=r.trading_engine_id and o.operator_id=r.operator_id
   and o.exchange_account_id=r.exchange_account_id and o.product_id=r.product_id
   and o.tenant_id=r.tenant_id and o.user_id=r.user_id and o.side='BUY' and f.quantity>0
   and original.trading_engine_id=r.trading_engine_id and o.trades_reconciled;
 -- A brand-new engine has no lifetime yet. Initial preparation remains intact;
 -- its first reconciled fill establishes the anchor on the next worker pass.
 if v_anchor is null then return null;end if;
 v_policy:=jsonb_build_object('policy','CUMULATIVE_LIFETIME_V1','anchor_at',v_anchor,'schedule',jsonb_build_array(
  jsonb_build_object('effective_period',to_char(v_anchor at time zone 'America/Campo_Grande','YYYY-MM'),
   'monthly_target',p.monthly_target,'source','RECONCILED_FIRST_BUY_BASELINE')));
 update coinops.robot_v1_live_preparations set slot_goal_policy=v_policy where id=p.id;
 insert into coinops.robot_v1_live_events(run_id,product_id,tenant_id,user_id,operator_id,exchange_account_id,
  trading_engine_id,quote_asset,event_key,event_type,slot_number,details)
 values(r.id,r.product_id,r.tenant_id,r.user_id,r.operator_id,r.exchange_account_id,r.trading_engine_id,r.quote_asset,
  'SLOT_GOAL:CUMULATIVE_LIFETIME_V1','SLOT_GOAL_POLICY_ADOPTED',null,v_policy)
 on conflict(run_id,event_key) do nothing;
 return v_policy;
end $adopt$;
revoke all on function coinops.adopt_cumulative_slot_goal(uuid,uuid) from public,anon,authenticated;
grant execute on function coinops.adopt_cumulative_slot_goal(uuid,uuid) to service_role;

create or replace function coinops.cumulative_slot_entry_eligible(p_run_id uuid,p_slot_number integer,p_at timestamptz)
returns boolean language plpgsql stable set search_path='' as $eligible$
declare r coinops.robot_v1_live_runs%rowtype;p coinops.robot_v1_live_preparations%rowtype;
 v_target integer;v_own bigint;v_count integer;v_available integer;v_below integer;v_valid boolean;
begin
 select * into strict r from coinops.robot_v1_live_runs where id=p_run_id;
 select * into strict p from coinops.robot_v1_live_preparations where trading_engine_id=r.trading_engine_id;
 if p.slot_goal_policy is null then return true;end if;
 v_target:=coinops.cumulative_slot_goal_target(p.slot_goal_policy,p_at);
 select count(*),bool_and(s.operator_id=r.operator_id and s.exchange_account_id=r.exchange_account_id
  and s.product_id=r.product_id and s.tenant_id=r.tenant_id and s.user_id=r.user_id
  and ac.gain_count<=coalesce(g.lifetime_gain_count,0)
  and (g.period_key is null or g.period_key=to_char(p_at at time zone 'America/Campo_Grande','YYYY-MM'))),
  max(case when s.slot_number=p_slot_number then coalesce(g.lifetime_gain_count,0)end),
  count(*) filter(where s.entry_state in('PLANNED','ARMED','CLOSED') and s.missed_at is null and s.position_quantity=0),
  count(*) filter(where s.entry_state in('PLANNED','ARMED','CLOSED') and s.missed_at is null and s.position_quantity=0
   and coalesce(g.lifetime_gain_count,0)<v_target)
 into v_count,v_valid,v_own,v_available,v_below
 from coinops.robot_v1_live_slots s join coinops.robot_v1_live_slot_accounts ac
  on ac.trading_engine_id=r.trading_engine_id and ac.slot_number=s.slot_number
  and ac.operator_id=r.operator_id and ac.exchange_account_id=r.exchange_account_id
 left join coinops.robot_v1_slot_gain_totals g on g.trading_engine_id=r.trading_engine_id
  and g.slot_number=s.slot_number and g.environment='REAL' and g.asset=r.asset
  and g.operator_id=r.operator_id and g.exchange_account_id=r.exchange_account_id
  and g.product_id=r.product_id and g.tenant_id=r.tenant_id and g.user_id=r.user_id
 where s.run_id=r.id;
 return v_count=r.slot_count and v_valid and v_own is not null
  and (v_own<v_target or v_available>0 and v_below=0);
end $eligible$;
revoke all on function coinops.cumulative_slot_entry_eligible(uuid,integer,timestamptz) from public,anon,authenticated;
grant execute on function coinops.cumulative_slot_entry_eligible(uuid,integer,timestamptz) to service_role;
-- GOAL_CORE_END

CREATE OR REPLACE FUNCTION coinops.prepare_robot_v1_live_order(p_run_id uuid, p_slot_id uuid, p_side text, p_purpose text, p_revision integer, p_client_order_id text, p_quantity numeric, p_quote numeric, p_price numeric, p_decision_id text, p_lease_owner uuid)
 RETURNS coinops.robot_v1_live_orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_run coinops.robot_v1_live_runs%rowtype;
  v_slot coinops.robot_v1_live_slots%rowtype;
  v_config coinops.robot_v1_live_preparations%rowtype;
  v_global coinops.account_quote_caps%rowtype;
  v_engine coinops.trading_engines%rowtype;
  v_existing coinops.robot_v1_live_orders%rowtype;
  v_order coinops.robot_v1_live_orders%rowtype;
  v_notional numeric;
  v_asset_exposure numeric;
  v_global_exposure numeric;
  v_accounts integer;
  v_account_balance numeric;
  v_market boolean;
  v_intent jsonb;
  v_auth jsonb;
  v_month text;
  v_monthly bigint;
  v_lifetime bigint;
  v_account_gains bigint;
  v_slot_balance numeric;
begin
  select * into strict v_run from coinops.robot_v1_live_runs where id=p_run_id for update;
  if (v_run.status <> 'ACTIVE' and not (p_side='SELL' and v_run.status='PAUSED'))
    or p_lease_owner is null
    or v_run.lease_owner is distinct from p_lease_owner
    or v_run.lease_until is null or v_run.lease_until <= now()
    or (v_run.last_error is not null and p_side='BUY') then
    raise exception 'COINOPS_LIVE_LEASE_OR_RUN_BLOCKED';
  end if;
  select * into strict v_engine from coinops.trading_engines where id=v_run.trading_engine_id for share;
  select * into strict v_global from coinops.account_quote_caps
    where exchange_account_id=v_run.exchange_account_id and quote_asset=v_run.quote_asset for update;
  select * into strict v_config from coinops.robot_v1_live_preparations
    where product_id=v_run.product_id and tenant_id=v_run.tenant_id
      and user_id=v_run.user_id and trading_engine_id=v_run.trading_engine_id and asset=v_run.asset for update;
  select * into strict v_slot from coinops.robot_v1_live_slots
    where id=p_slot_id and run_id=p_run_id and product_id=v_run.product_id
      and tenant_id=v_run.tenant_id and user_id=v_run.user_id for update;
  if v_config.symbol<>v_run.symbol or (v_config.slot_count<>v_engine.slot_count or v_run.slot_count<>v_engine.slot_count)
    or v_config.configured_live_capital_brl > v_engine.hard_cap_quote
    or v_config.max_order_notional_brl > v_engine.hard_cap_quote
    or v_config.max_total_exposure_brl > v_engine.hard_cap_quote
    or v_engine.hard_cap_quote > v_global.hard_cap_quote then
    raise exception 'COINOPS_LIVE_HARD_CAP_INVALID';
  end if;
  select * into v_existing from coinops.robot_v1_live_orders where client_order_id=p_client_order_id;
  if found then
    if (v_existing.run_id,v_existing.slot_id,v_existing.side,v_existing.purpose,
      v_existing.revision,v_existing.requested_quantity,v_existing.requested_quote,
      v_existing.price,v_existing.strategy_decision_id)
      is distinct from (p_run_id,p_slot_id,p_side,p_purpose,p_revision,p_quantity,
        p_quote,p_price,p_decision_id) then
      raise exception 'COINOPS_LIVE_ORDER_IDENTITY_COLLISION';
    end if;
    return v_existing;
  end if;
  if p_revision < 1 or (case when v_engine.legacy_compatible then p_client_order_id !~ ('^COR1-'||v_run.asset||'-'||v_slot.slot_number||'-'||p_revision||'-'||p_side||'-[a-f0-9]{14}$') else p_client_order_id !~ ('^C2-'||substr(encode(sha256(convert_to(v_run.exchange_account_id::text||'|'||v_run.trading_engine_id::text,'UTF8')),'hex'),1,10)||'-'||v_slot.slot_number||'-'||substr(p_side,1,1)||'-[a-f0-9]{14}$') end)
    or p_decision_id !~ '^[a-f0-9]{64}$' or not exists
      (select 1 from coinops.robot_v1_strategy_decisions d where d.environment='REAL'
        and d.cycle_id=p_run_id and d.slot_id=p_slot_id and d.decision_id=p_decision_id
        and d.product_id=v_run.product_id and d.tenant_id=v_run.tenant_id and d.user_id=v_run.user_id)
    or (p_side,p_purpose) not in (('BUY','INITIAL'),('BUY','ENTRY'),('SELL','TP')) then
    raise exception 'COINOPS_LIVE_ORDER_INTENT_INVALID';
  end if;
  v_market:=p_side='BUY' and p_purpose='ENTRY' and p_quote is not null;
  if v_market then
    v_intent:=v_run.config_snapshot->'market_entry_intent';
    v_auth:=v_run.config_snapshot->'market_entry_authorization';
    v_month:=to_char(clock_timestamp() at time zone 'America/Campo_Grande','YYYY-MM');
    if p_quote<=0 or p_quote::text in ('NaN','Infinity','-Infinity') or p_quantity is not null or p_price is not null
      or coalesce(v_intent->>'policy','')<>'PRIORITY_MISSED_MARKET_V1'
      or v_intent->>'run_id' is distinct from v_run.id::text
      or v_intent->>'engine_id' is distinct from v_engine.id::text
      or v_intent->>'slot_id' is distinct from v_slot.id::text
      or (v_intent->>'slot_number')::integer is distinct from v_slot.slot_number
      or (v_intent->>'operation_sequence')::integer is distinct from v_slot.operation_sequence
      or v_intent->>'decision_id' is distinct from p_decision_id
      or v_intent->>'period' is distinct from v_month
      or (v_intent->>'quote')::numeric is distinct from p_quote
      or (v_intent->>'reference_price')::numeric is distinct from v_slot.entry_reference_price
      or v_slot.entry_state not in ('PLANNED','MISSED') or v_slot.position_quantity<>0 or v_slot.position_committed_brl<>0
      or v_engine.environment<>'REAL' or v_engine.operator_id<>v_run.operator_id
      or v_engine.exchange_account_id<>v_run.exchange_account_id or v_engine.strategy_config_pending
      or exists(select 1 from coinops.robot_v1_live_alerts a where a.trading_engine_id=v_engine.id and a.severity='CRITICAL' and a.resolved_at is null)
      or not exists(select 1 from coinops.robot_v1_strategy_decisions d where d.decision_id=p_decision_id
        and d.trading_engine_id=v_engine.id and d.operator_id=v_run.operator_id
        and d.exchange_account_id=v_run.exchange_account_id and d.cycle_id=v_run.id and d.slot_id=v_slot.id
        and d.environment='REAL' and d.action_type='OPEN_ENTRY_MARKET' and d.operation_sequence=v_slot.operation_sequence
        and d.result='PENDING' and d.dispatched_at is null and d.exchange_ack_at is null)
      or exists(select 1 from coinops.robot_v1_live_orders o where o.run_id=v_run.id and o.slot_id=v_slot.id
        and o.operation_sequence=v_slot.operation_sequence and (o.status in('PREPARED','NEW','PARTIALLY_FILLED')
          or o.executed_quantity>0 or o.cumulative_quote>0 or o.trades_reconciled is distinct from true))
    then raise exception 'COINOPS_MARKET_ENTRY_INTENT_INVALID'; end if;
    if v_slot.entry_state='MISSED' then
      if v_slot.missed_at is null or v_intent->>'reason' is distinct from 'OPERATOR_MISSED_ENTRY'
        or coalesce(v_auth->>'policy','')<>'PRIORITY_MISSED_MARKET_V1'
        or v_auth->>'run_id' is distinct from v_run.id::text or v_auth->>'engine_id' is distinct from v_engine.id::text
        or v_auth->>'slot_id' is distinct from v_slot.id::text
        or (v_auth->>'operation_sequence')::integer is distinct from v_slot.operation_sequence
        or v_auth->>'period' is distinct from v_month or (v_auth->>'source_missed_at')::timestamptz is distinct from v_slot.missed_at
        or coalesce((v_auth->>'quote_cap')::numeric,0)<p_quote
        or not exists(select 1 from coinops.robot_v1_live_events ev where ev.run_id=v_run.id
          and ev.trading_engine_id=v_engine.id and ev.slot_number=v_slot.slot_number
          and ev.event_key=v_auth->>'authorization_event_key' and ev.event_type='MISSED_MARKET_ENTRY_REQUESTED'
          and ev.details=v_auth)
      then raise exception 'COINOPS_MARKET_ENTRY_AUTHORIZATION_UNPROVEN'; end if;
    elsif v_slot.missed_at is not null or v_intent->>'reason' is distinct from 'PROSPECTIVE_CROSSED_ENTRY' then
      raise exception 'COINOPS_MARKET_ENTRY_AUTHORIZATION_UNPROVEN';
    end if;
    select coalesce(g.monthly_gain_count,0),coalesce(g.lifetime_gain_count,0),ac.gain_count,ac.balance_brl
      into v_monthly,v_lifetime,v_account_gains,v_slot_balance from coinops.robot_v1_live_slot_accounts ac
      left join coinops.robot_v1_slot_gain_totals g on g.trading_engine_id=v_engine.id and g.slot_number=ac.slot_number
        and g.environment='REAL' and g.asset=v_run.asset and g.operator_id=v_run.operator_id
        and g.exchange_account_id=v_run.exchange_account_id and g.product_id=v_run.product_id
        and g.tenant_id=v_run.tenant_id and g.user_id=v_run.user_id and g.period_key=v_month
      where ac.trading_engine_id=v_engine.id and ac.slot_number=v_slot.slot_number;
    if not found or v_account_gains>v_lifetime or v_config.monthly_target<=0
      or v_slot_balance<=0 or abs(v_slot_balance-p_quote)>0.00000001
      or (v_config.slot_goal_policy is null and v_monthly>=v_config.monthly_target and (select count(*)from coinops.robot_v1_slot_gain_totals g
        where g.trading_engine_id=v_engine.id and g.environment='REAL' and g.asset=v_run.asset
          and g.operator_id=v_run.operator_id and g.exchange_account_id=v_run.exchange_account_id
          and g.product_id=v_run.product_id and g.tenant_id=v_run.tenant_id and g.user_id=v_run.user_id
          and g.period_key=v_month and g.monthly_gain_count>=v_config.monthly_target)<>v_engine.slot_count)
    then raise exception 'COINOPS_MARKET_ENTRY_MONTHLY_INELIGIBLE'; end if;
  end if;
  if p_purpose='INITIAL' or v_market then
    if p_quote is null or p_quote<=0 or p_quantity is not null or p_price is not null
      or (not v_market and (v_slot.operation_sequence<>1 or v_slot.operational_rank<>1)) then
      raise exception 'COINOPS_LIVE_INITIAL_INTENT_INVALID';
    end if;
    v_notional:=p_quote;
  else
    if p_quantity is null or p_quantity<=0 or p_quote is not null or p_price is null or p_price<=0 then
      raise exception 'COINOPS_LIVE_LIMIT_INTENT_INVALID';
    end if;
    v_notional:=round(p_quantity*p_price,8);
  end if;
  if p_side='BUY' then
    if v_config.slot_goal_policy is not null and not coinops.cumulative_slot_entry_eligible(v_run.id,v_slot.slot_number,clock_timestamp())
    then raise exception 'COINOPS_CUMULATIVE_GOAL_INELIGIBLE';end if;
    if v_engine.status<>'ACTIVE' or v_engine.kill_switch
      or exists(select 1 from coinops.exchange_accounts a where a.id=v_run.exchange_account_id and (a.status<>'ACTIVE' or a.kill_switch))
      or exists(select 1 from coinops.operators o where o.id=v_run.operator_id and (o.status<>'ACTIVE' or o.kill_switch)) then
      raise exception 'COINOPS_ENGINE_NEW_WRITES_BLOCKED'; end if;
    if not v_config.live_enabled or v_config.kill_switch or (not v_market and v_slot.entry_state<>'PLANNED')
      or v_notional > v_config.max_order_notional_brl
      or exists (select 1 from coinops.robot_v1_live_orders o where o.run_id=p_run_id
        and o.side='BUY' and o.status in ('PREPARED','NEW','PARTIALLY_FILLED')) then
      raise exception 'COINOPS_LIVE_NEW_BUY_BLOCKED';
    end if;
    select count(*),coalesce(sum(contribution_brl),0) into v_accounts,v_account_balance
      from coinops.robot_v1_live_slot_accounts a where a.product_id=v_run.product_id
        and a.tenant_id=v_run.tenant_id and a.user_id=v_run.user_id and a.trading_engine_id=v_run.trading_engine_id and a.asset=v_run.asset;
    if v_accounts<>v_engine.slot_count or v_account_balance>v_config.configured_live_capital_brl
      or v_account_balance<=0 or v_notional>
        (select balance_brl from coinops.robot_v1_live_slot_accounts a
          where a.product_id=v_run.product_id and a.tenant_id=v_run.tenant_id
            and a.user_id=v_run.user_id and a.trading_engine_id=v_run.trading_engine_id and a.asset=v_run.asset and a.slot_number=v_slot.slot_number)
      then raise exception 'COINOPS_LIVE_SLOT_CAPITAL_INVALID';
    end if;
    select coalesce(sum(s.position_committed_brl),0) into v_asset_exposure
      from coinops.robot_v1_live_slots s join coinops.robot_v1_live_runs r on r.id=s.run_id
      where r.product_id=v_run.product_id and r.tenant_id=v_run.tenant_id
        and r.user_id=v_run.user_id and r.trading_engine_id=v_run.trading_engine_id and r.asset=v_run.asset and r.status in ('ACTIVE','PAUSED');
    select v_asset_exposure+coalesce(sum(greatest(o.reserved_notional_brl-o.cumulative_quote,0)),0)
      into v_asset_exposure from coinops.robot_v1_live_orders o
      join coinops.robot_v1_live_runs r on r.id=o.run_id
      where r.product_id=v_run.product_id and r.tenant_id=v_run.tenant_id
        and r.user_id=v_run.user_id and r.trading_engine_id=v_run.trading_engine_id and r.asset=v_run.asset and r.status in ('ACTIVE','PAUSED')
        and o.side='BUY' and o.status in ('PREPARED','NEW','PARTIALLY_FILLED');
    select coalesce(sum(s.position_committed_brl),0) into v_global_exposure
      from coinops.robot_v1_live_slots s join coinops.robot_v1_live_runs r on r.id=s.run_id
      where r.product_id=v_run.product_id and r.tenant_id=v_run.tenant_id
        and r.user_id=v_run.user_id and r.exchange_account_id=v_run.exchange_account_id and r.quote_asset=v_run.quote_asset and r.status in ('ACTIVE','PAUSED');
    select v_global_exposure+coalesce(sum(greatest(o.reserved_notional_brl-o.cumulative_quote,0)),0)
      into v_global_exposure from coinops.robot_v1_live_orders o
      join coinops.robot_v1_live_runs r on r.id=o.run_id
      where r.product_id=v_run.product_id and r.tenant_id=v_run.tenant_id
        and r.user_id=v_run.user_id and r.exchange_account_id=v_run.exchange_account_id and r.quote_asset=v_run.quote_asset and r.status in ('ACTIVE','PAUSED')
        and o.side='BUY' and o.status in ('PREPARED','NEW','PARTIALLY_FILLED');
    if v_asset_exposure+v_notional>v_config.max_total_exposure_brl
      or v_global_exposure+v_notional>v_global.hard_cap_quote then
      raise exception 'COINOPS_LIVE_EXPOSURE_CAP_DENIED';
    end if;
  elsif v_slot.position_quantity<=0 or p_quantity>v_slot.position_quantity
    or v_slot.entry_state<>'OPEN' then
    raise exception 'COINOPS_LIVE_TP_POSITION_UNVERIFIED';
  end if;
  insert into coinops.robot_v1_live_orders
    (run_id,slot_id,product_id,tenant_id,user_id,operator_id,exchange_account_id,trading_engine_id,quote_asset,slot_number,operation_sequence,
      side,purpose,revision,client_order_id,requested_quantity,requested_quote,price,
      reserved_notional_brl,strategy_decision_id,config_version,config_snapshot)
  values (v_run.id,v_slot.id,v_run.product_id,v_run.tenant_id,v_run.user_id,v_run.operator_id,v_run.exchange_account_id,v_run.trading_engine_id,v_run.quote_asset,v_slot.slot_number,
    v_slot.operation_sequence,p_side,p_purpose,p_revision,p_client_order_id,p_quantity,p_quote,p_price,
    case when p_side='BUY' then v_notional else 0 end,p_decision_id,
    v_run.config_version,v_run.config_snapshot) returning * into v_order;
  if v_market then
    update coinops.robot_v1_live_slots set entry_state='ARMED',missed_at=null,entry_origin='REENTRY' where id=v_slot.id;
  end if;
  return v_order;
end $function$;

CREATE OR REPLACE FUNCTION coinops.allocate_live_monthly_entry_levels(p_run_id uuid, p_lease_owner uuid, p_plan_id text, p_period text, p_expected jsonb, p_assignments jsonb, p_context jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
 r coinops.robot_v1_live_runs%rowtype; e coinops.trading_engines%rowtype;
 prep coinops.robot_v1_live_preparations%rowtype;
 actual jsonb; checkpoint jsonb; a jsonb; n integer; sources jsonb; source_origin text;
 goal_target integer; goal_release boolean:=false;
begin
 if coalesce(nullif(current_setting('request.jwt.claim.role',true),''),auth.jwt()->>'role','') <> 'service_role'
  or p_plan_id is null or p_plan_id !~ '^[a-f0-9]{64}$' then
  raise exception 'COINOPS_ENTRY_PRIORITY_SCOPE_DENIED';
 end if;
 select * into r from coinops.robot_v1_live_runs where id=p_run_id for update;
 if not found or p_lease_owner is null or r.lease_owner is distinct from p_lease_owner
  or r.lease_until is null or r.lease_until<=clock_timestamp() then
  raise exception 'COINOPS_ENTRY_PRIORITY_LEASE_DENIED'; end if;
 select * into e from coinops.trading_engines where id=r.trading_engine_id for share;
 if not found or e.environment is distinct from 'REAL' or e.status is distinct from 'ACTIVE'
  or r.status is distinct from 'ACTIVE' or e.operator_id is distinct from r.operator_id
  or e.exchange_account_id is distinct from r.exchange_account_id or e.symbol is distinct from r.symbol
  or e.slot_count is distinct from r.slot_count or e.slot_count not between 2 and 100
  or e.kill_switch is distinct from false or e.strategy_config_pending is distinct from false
  or r.last_error is not null or not exists(select 1 from coinops.executor_shards sh
   where sh.id=e.executor_shard_id and sh.enabled)
  or not exists(select 1 from coinops.operators op where op.id=r.operator_id
   and op.product_id=r.product_id and op.tenant_id=r.tenant_id and op.user_id=r.user_id
   and op.status='ACTIVE' and not op.kill_switch)
  or not exists(select 1 from coinops.exchange_accounts ac where ac.id=r.exchange_account_id
   and ac.operator_id=r.operator_id and ac.status='ACTIVE' and not ac.kill_switch)
  or not exists(select 1 from coinops.robot_v1_live_preparations p where p.trading_engine_id=e.id
   and p.live_enabled and not p.kill_switch and p.slot_count=e.slot_count)
  or exists(select 1 from coinops.robot_v1_live_alerts al where al.trading_engine_id=e.id
   and al.severity='CRITICAL' and al.resolved_at is null)
 then raise exception 'COINOPS_ENTRY_PRIORITY_SCOPE_DENIED'; end if;
 select * into prep from coinops.robot_v1_live_preparations where trading_engine_id=e.id for share;
 if not found or p_context is distinct from (jsonb_build_object('regime',r.entry_regime,
  'config_version',r.config_version,'monthly_target',prep.monthly_target,'shard',e.executor_shard_id) || case when prep.slot_goal_policy is null then '{}'::jsonb else jsonb_build_object('goal_policy','CUMULATIVE_LIFETIME_V1','goal_target',coinops.cumulative_slot_goal_target(prep.slot_goal_policy,clock_timestamp())) end)
 then raise exception 'COINOPS_ENTRY_PRIORITY_SNAPSHOT_CHANGED'; end if;
 n:=e.slot_count;
 if p_period is distinct from to_char(clock_timestamp() at time zone 'America/Campo_Grande','YYYY-MM')
  or jsonb_typeof(p_expected) is distinct from 'array' or jsonb_array_length(p_expected)<>n
  or jsonb_typeof(p_assignments) is distinct from 'array' or jsonb_array_length(p_assignments) not between 0 and n
 then raise exception 'COINOPS_ENTRY_PRIORITY_INPUT_INVALID'; end if;
 -- All current physical rows and monthly facts are CAS evidence. Unknown is
 -- never zero: the account counter must agree with the complete gain view.
 perform 1 from coinops.robot_v1_live_slots s where s.run_id=r.id order by s.slot_number for update;
 if (select count(*) from coinops.robot_v1_live_slots s where s.run_id=r.id)<>n
  or (select count(distinct s.slot_number) from coinops.robot_v1_live_slots s where s.run_id=r.id)<>n
  or exists(select 1 from coinops.robot_v1_live_slots s where s.run_id=r.id and
   (s.slot_number not between 1 and n or s.trading_engine_id is distinct from e.id
    or s.operator_id is distinct from r.operator_id or s.exchange_account_id is distinct from r.exchange_account_id
    or s.tenant_id is distinct from r.tenant_id or s.product_id is distinct from r.product_id or s.user_id is distinct from r.user_id))
  or (select count(*) from coinops.robot_v1_live_slot_accounts ac where ac.trading_engine_id=e.id)<>n
 then raise exception 'COINOPS_ENTRY_PRIORITY_INCOMPLETE'; end if;
 if exists(select 1 from coinops.robot_v1_live_slot_accounts ac left join coinops.robot_v1_slot_gain_totals g
   on g.trading_engine_id=e.id and g.slot_number=ac.slot_number and g.environment='REAL' and g.asset=r.asset
   and g.operator_id=r.operator_id and g.exchange_account_id=r.exchange_account_id
   and g.product_id=r.product_id and g.tenant_id=r.tenant_id and g.user_id=r.user_id
   where ac.trading_engine_id=e.id and (ac.gain_count>coalesce(g.lifetime_gain_count,0)
    or g.period_key is not null and g.period_key<>p_period))
 then raise exception 'COINOPS_ENTRY_PRIORITY_GAIN_EVIDENCE_INVALID'; end if;
 select jsonb_agg(jsonb_build_object('id',s.id,'n',s.slot_number,'state',s.entry_state,
  'sequence',s.operation_sequence,'price',s.target_buy_price,'reference',s.entry_reference_price,
  'position',s.position_quantity,'monthly',coalesce(g.monthly_gain_count,0),'lifetime',coalesce(g.lifetime_gain_count,0))
  order by s.slot_number) into actual from coinops.robot_v1_live_slots s
 left join coinops.robot_v1_slot_gain_totals g on g.trading_engine_id=e.id and g.slot_number=s.slot_number
  and g.environment='REAL' and g.asset=r.asset and g.operator_id=r.operator_id
  and g.exchange_account_id=r.exchange_account_id and g.product_id=r.product_id
  and g.tenant_id=r.tenant_id and g.user_id=r.user_id where s.run_id=r.id;
 checkpoint:=jsonb_build_object('policy','MONTHLY_GAINS_V1','plan_id',p_plan_id,'period',p_period,
  'symbol',r.symbol,'quote_asset',r.quote_asset,'assignments',p_assignments,
  'goal_policy',prep.slot_goal_policy,'goal_target',case when prep.slot_goal_policy is not null then coinops.cumulative_slot_goal_target(prep.slot_goal_policy,clock_timestamp())end);
 if r.config_snapshot->'entry_priority_checkpoint' @> checkpoint then
  -- A replay cannot refresh timestamps or overwrite a later allocation.
  return (r.config_snapshot->'entry_priority_checkpoint')||jsonb_build_object('price_sources',r.config_snapshot->'entry_price_sources'); end if;
 if actual is distinct from p_expected then raise exception 'COINOPS_ENTRY_PRIORITY_SNAPSHOT_CHANGED'; end if;
 -- Reuse the locked, complete CAS facts once, not an N-query goal scan.
 if prep.slot_goal_policy is not null then
  goal_target:=coinops.cumulative_slot_goal_target(prep.slot_goal_policy,clock_timestamp());
  select coalesce(bool_and((x->>'lifetime')::bigint>=goal_target),false) into goal_release
   from jsonb_array_elements(actual)x join coinops.robot_v1_live_slots s on s.id=(x->>'id')::uuid
   where s.run_id=r.id and s.entry_state in('PLANNED','ARMED','CLOSED')
    and s.position_quantity=0 and s.missed_at is null;
 end if;
 if (select count(distinct x->>'id') from jsonb_array_elements(p_assignments) x)<>jsonb_array_length(p_assignments)
  or (select count(distinct x->>'sourceId') from jsonb_array_elements(p_assignments) x)<>jsonb_array_length(p_assignments)
  or (select jsonb_agg((x->>'previousPrice')::numeric order by (x->>'previousPrice')::numeric) from jsonb_array_elements(p_assignments) x)
   is distinct from (select jsonb_agg((x->>'price')::numeric order by (x->>'price')::numeric) from jsonb_array_elements(p_assignments) x)
 then raise exception 'COINOPS_ENTRY_PRIORITY_NOT_A_PERMUTATION'; end if;
 sources:=coalesce(r.config_snapshot->'entry_price_sources','{}'::jsonb);
 for a in select value from jsonb_array_elements(p_assignments) loop
  if not exists(select 1 from coinops.robot_v1_live_slots s where s.id=(a->>'id')::uuid and s.run_id=r.id
   and s.slot_number=(a->>'slotNumber')::integer and s.entry_state='PLANNED' and s.position_quantity=0
   and s.missed_at is null and s.target_buy_price=(a->>'previousPrice')::numeric
   and (a->>'price')::numeric>0 and (a->>'price')::numeric::text not in ('NaN','Infinity','-Infinity')
   and (a->>'rank')::integer between 1 and n
   and not exists(select 1 from coinops.robot_v1_live_orders o where o.run_id=r.id and o.slot_id=s.id
    and o.operation_sequence=s.operation_sequence and (o.status in ('PREPARED','NEW','PARTIALLY_FILLED')
      or o.executed_quantity>0 or o.cumulative_quote>0 or o.trades_reconciled is distinct from true)))
  then raise exception 'COINOPS_ENTRY_PRIORITY_COMMITTED_SLOT'; end if;
  if prep.slot_goal_policy is not null and not goal_release and
   (select (x->>'lifetime')::bigint from jsonb_array_elements(actual)x where x->>'id'=a->>'id')>=goal_target
  then raise exception 'COINOPS_CUMULATIVE_GOAL_INELIGIBLE';end if;
  select case when (sources->s.id::text->>'price')::numeric=s.target_buy_price
   then sources->s.id::text->>'source_origin' else s.entry_origin end into source_origin
   from coinops.robot_v1_live_slots s where s.id=(a->>'sourceId')::uuid and s.run_id=r.id
    and s.target_buy_price=(a->>'price')::numeric and s.entry_reference_price=s.target_buy_price
    and exists(select 1 from jsonb_array_elements(p_assignments) src where src->>'id'=s.id::text);
  if source_origin is null or source_origin not in ('GRID','REENTRY') or source_origin is distinct from a->>'sourceOrigin'
   then raise exception 'COINOPS_ENTRY_PRIORITY_LEVEL_SOURCE_INVALID'; end if;
 end loop;
 -- Build from the BEFORE map, never from another assignment in this permutation.
 for a in select value from jsonb_array_elements(p_assignments) loop
  sources:=sources||jsonb_build_object(a->>'id',jsonb_build_object('run_id',r.id,'engine_id',e.id,
   'slot_id',a->>'id','price',(a->>'price')::numeric,'source_origin',a->>'sourceOrigin','plan_id',p_plan_id));
 end loop;
 update coinops.robot_v1_live_slots s set target_buy_price=(a.value->>'price')::numeric,
  entry_reference_price=(a.value->>'price')::numeric,operational_rank=(a.value->>'rank')::integer
 from jsonb_array_elements(p_assignments) a where s.id=(a.value->>'id')::uuid and s.run_id=r.id;
 checkpoint:=checkpoint||jsonb_build_object('committed_at',clock_timestamp());
 update coinops.robot_v1_live_runs set config_snapshot=config_snapshot||jsonb_build_object(
  'entry_priority_policy','MONTHLY_GAINS_V1','entry_priority_checkpoint',checkpoint,'entry_price_sources',sources) where id=r.id;
 insert into coinops.robot_v1_live_events(run_id,product_id,tenant_id,user_id,operator_id,exchange_account_id,
  trading_engine_id,quote_asset,event_key,event_type,slot_number,details)
 values(r.id,r.product_id,r.tenant_id,r.user_id,r.operator_id,r.exchange_account_id,e.id,r.quote_asset,
  'ENTRY_PRIORITY:'||p_plan_id,'ENTRY_PRIORITY_ALLOCATED',null,checkpoint)
 on conflict(run_id,event_key) do nothing;
 return checkpoint||jsonb_build_object('price_sources',sources);
end $function$;

CREATE OR REPLACE FUNCTION coinops.dashboard_live_engine_reads(p_operator_id uuid, p_engine_ids uuid[])
 RETURNS TABLE(engine_id uuid, payload jsonb)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
select e.id, jsonb_build_object(
  'run', to_jsonb(r),
  'slotGoalPolicy',(select slot_goal_policy from coinops.robot_v1_live_preparations where trading_engine_id=e.id and operator_id=e.operator_id and exchange_account_id=e.exchange_account_id),
  'slots', coalesce((select jsonb_agg(x order by x.slot_number) from (
    select slot_number,entry_state,target_buy_price,operational_rank,post_ath_group,
      post_ath_group_rank,operation_sequence,position_quantity,position_committed_brl,
      position_committed_quote,missed_at
    from coinops.robot_v1_live_slots where operator_id=e.operator_id
      and exchange_account_id=e.exchange_account_id and trading_engine_id=e.id and run_id=r.id
  ) x), '[]'::jsonb),
  'orders', coalesce((select jsonb_agg(x order by x.created_at,x.client_order_id) from (
    select side,purpose,status,slot_number,client_order_id,exchange_order_id,price,
      requested_quantity,requested_quote,executed_quantity,cumulative_quote,created_at,
      updated_at,fee_base,fee_quote,fee_other,reserved_notional_brl,reserved_notional_quote,trades_reconciled
    from coinops.robot_v1_live_orders where operator_id=e.operator_id
      and exchange_account_id=e.exchange_account_id and trading_engine_id=e.id and run_id=r.id
  ) x), '[]'::jsonb),
  'accounts', coalesce((select jsonb_agg(x order by x.slot_number) from (
    select slot_number,balance_brl,balance_quote,contribution_brl,contribution_quote,
      market_pnl_brl,market_pnl_quote,manual_gain_brl,manual_gain_quote,fees_brl,fees_quote,
      gain_count,dust_quantity,dust_cost_brl,dust_cost_quote
    from coinops.robot_v1_live_slot_accounts where operator_id=e.operator_id
      and exchange_account_id=e.exchange_account_id and trading_engine_id=e.id
  ) x), '[]'::jsonb),
  'selectiveAllocations', coalesce((select jsonb_agg(x order by x.created_at) from (
    select slot_number,amount_quote,status,created_at,applied_at
    from coinops.robot_v1_live_selective_contribution_allocations where operator_id=e.operator_id
      and exchange_account_id=e.exchange_account_id and trading_engine_id=e.id
      and status in ('PENDING','APPLIED')
  ) x), '[]'::jsonb),
  'events', coalesce((select jsonb_agg(x order by x.observed_at desc) from (
    select event_type,slot_number,observed_at,details from coinops.robot_v1_live_events
    where operator_id=e.operator_id and exchange_account_id=e.exchange_account_id
      and trading_engine_id=e.id and run_id=r.id order by observed_at desc limit 40
  ) x), '[]'::jsonb),
  'alerts', coalesce((select jsonb_agg(x) from (
    select severity,code,last_seen_at from coinops.robot_v1_live_alerts
    where operator_id=e.operator_id and exchange_account_id=e.exchange_account_id
      and trading_engine_id=e.id and resolved_at is null
  ) x), '[]'::jsonb),
  'monthlyGains', coalesce((select jsonb_agg(x) from (
    select slot_number,physical_slot_id,period_key,lifetime_gain_count,monthly_gain_count,
      market_gain_count,manual_gain_count,monthly_market_gain_count,monthly_manual_gain_count
    from coinops.robot_v1_slot_gain_totals where operator_id=e.operator_id
      and exchange_account_id=e.exchange_account_id and trading_engine_id=e.id
  ) x), '[]'::jsonb),
  'preparation', (select jsonb_build_object('liveEnabled',live_enabled,'killSwitch',kill_switch,
      'monthlyTarget',monthly_target)
    from coinops.robot_v1_live_preparations where operator_id=e.operator_id
      and exchange_account_id=e.exchange_account_id and trading_engine_id=e.id)
)
from coinops.trading_engines e
left join lateral (
  select id,status,symbol,entry_regime,last_reconciled_at,last_error,config_version,gain_rate,entry_spacing
  from coinops.robot_v1_live_runs where operator_id=e.operator_id
    and exchange_account_id=e.exchange_account_id and trading_engine_id=e.id
    and status in ('PREPARING','ACTIVE','PAUSED')
) r on true
where e.operator_id=p_operator_id and e.id=any(p_engine_ids) and e.environment='REAL'
  and cardinality(p_engine_ids) between 1 and 32
order by e.id;
$function$;

commit;
