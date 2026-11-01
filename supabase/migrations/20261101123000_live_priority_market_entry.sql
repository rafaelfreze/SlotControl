-- Authorized priority-only MARKET catch-up. Existing amounts, gain, spacing,
-- metas and resident/OPEN/TP snapshots remain unchanged. No orders in migration.
begin;
set local lock_timeout='3s';
set local statement_timeout='60s';
alter table coinops.robot_v1_strategy_decisions drop constraint robot_v1_strategy_decisions_action_type_check;
alter table coinops.robot_v1_strategy_decisions add constraint robot_v1_strategy_decisions_action_type_check check
 (action_type in('OPEN_INITIAL_MARKET','OPEN_ENTRY_MARKET','CREATE_TP','PLAN_LOCAL_REENTRY','ARM_NEXT_BUY','CANCEL_REPLACE_NEXT_BUY','COMPLETE_CYCLE','REANCHOR','WAIT'));
alter table coinops.robot_v1_live_orders drop constraint robot_v1_live_order_request;
alter table coinops.robot_v1_live_orders add constraint robot_v1_live_order_request check
 ((purpose='INITIAL' and requested_quote>0 and requested_quantity is null and price is null)
 or (purpose in('ENTRY','TP') and requested_quote is null and requested_quantity>0 and price>0)
 or (side='BUY' and purpose='ENTRY' and requested_quote>0 and requested_quantity is null and price is null
   and config_snapshot @> '{"market_entry_intent":{"policy":"PRIORITY_MISSED_MARKET_V1"}}'::jsonb));
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
      or (v_monthly>=v_config.monthly_target and (select count(*)from coinops.robot_v1_slot_gain_totals g
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
end $function$
;

-- Only the just-filled new MARKET operation gets a new local entry reference.
-- Existing OPEN/TPs and all immutable order snapshots are untouched.
create function coinops.finalize_live_market_entry_reference(p_order_id uuid,p_price_tick numeric,p_lease_owner uuid)
returns numeric language plpgsql security invoker set search_path='' as $$
declare o coinops.robot_v1_live_orders%rowtype; r coinops.robot_v1_live_runs%rowtype;
 s coinops.robot_v1_live_slots%rowtype; price numeric; intent jsonb;
begin
 select * into strict o from coinops.robot_v1_live_orders where id=p_order_id;
 select * into strict r from coinops.robot_v1_live_runs where id=o.run_id for update;
 select * into strict s from coinops.robot_v1_live_slots where id=o.slot_id and run_id=r.id for update;
 select * into strict o from coinops.robot_v1_live_orders where id=p_order_id for update;
 intent:=o.config_snapshot->'market_entry_intent';
 if p_lease_owner is null or r.lease_owner is distinct from p_lease_owner or r.lease_until is null or r.lease_until<=now()
   or r.status not in('ACTIVE','PAUSED') or o.side<>'BUY' or o.purpose<>'ENTRY'
   or o.requested_quote is null or o.requested_quote<=0 or o.price is not null or o.requested_quantity is not null
   or o.status not in('FILLED','CANCELED','EXPIRED','EXPIRED_IN_MATCH') or not o.trades_reconciled
   or o.executed_quantity<=0 or o.cumulative_quote<=0 or p_price_tick is null or p_price_tick<=0
   or p_price_tick::text in('NaN','Infinity','-Infinity') or s.entry_state<>'OPEN' or s.position_quantity<=0
   or s.operation_sequence<>o.operation_sequence or s.trading_engine_id<>r.trading_engine_id
   or s.operator_id<>r.operator_id or s.exchange_account_id<>r.exchange_account_id
   or s.product_id<>r.product_id or s.tenant_id<>r.tenant_id or s.user_id<>r.user_id
   or o.product_id<>r.product_id or o.tenant_id<>r.tenant_id or o.user_id<>r.user_id
   or o.trading_engine_id<>r.trading_engine_id or o.operator_id<>r.operator_id or o.exchange_account_id<>r.exchange_account_id
   or coalesce(intent->>'policy','')<>'PRIORITY_MISSED_MARKET_V1'
   or intent->>'run_id' is distinct from r.id::text or intent->>'engine_id' is distinct from r.trading_engine_id::text
   or intent->>'slot_id' is distinct from s.id::text
   or (intent->>'operation_sequence')::integer is distinct from o.operation_sequence
   or intent->>'decision_id' is distinct from o.strategy_decision_id
   or exists(select 1 from coinops.robot_v1_live_orders other where other.run_id=r.id and other.slot_id=s.id
     and other.operation_sequence=o.operation_sequence and other.side='BUY' and other.id<>o.id and other.executed_quantity>0)
 then raise exception 'COINOPS_MARKET_ENTRY_REFERENCE_UNPROVEN';end if;
 price:=floor((o.cumulative_quote/o.executed_quantity)/p_price_tick)*p_price_tick;
 if price<=0 then raise exception 'COINOPS_MARKET_ENTRY_REFERENCE_UNPROVEN';end if;
 if exists(select 1 from coinops.robot_v1_live_events ev where ev.run_id=r.id
   and ev.event_key='MARKET_ENTRY_REFERENCE:'||o.id and ev.details is distinct from
     jsonb_build_object('order_id',o.id,'operation_sequence',o.operation_sequence,'reference_price',price))
 then raise exception 'COINOPS_MARKET_ENTRY_REFERENCE_UNPROVEN';end if;
 update coinops.robot_v1_live_slots set target_buy_price=price,entry_reference_price=price,entry_origin='REENTRY' where id=s.id;
 insert into coinops.robot_v1_live_events(run_id,product_id,tenant_id,user_id,operator_id,exchange_account_id,
   trading_engine_id,quote_asset,event_key,event_type,slot_number,details)
 values(r.id,r.product_id,r.tenant_id,r.user_id,r.operator_id,r.exchange_account_id,r.trading_engine_id,r.quote_asset,
   'MARKET_ENTRY_REFERENCE:'||o.id,'MARKET_ENTRY_REFERENCE',s.slot_number,
   jsonb_build_object('order_id',o.id,'operation_sequence',o.operation_sequence,'reference_price',price))
 on conflict(run_id,event_key)do nothing;
 return price;
end $$;
revoke all on function coinops.prepare_robot_v1_live_order(uuid,uuid,text,text,integer,text,numeric,numeric,numeric,text,uuid)
 from public,anon,authenticated;
grant execute on function coinops.prepare_robot_v1_live_order(uuid,uuid,text,text,integer,text,numeric,numeric,numeric,text,uuid) to service_role;
revoke all on function coinops.finalize_live_market_entry_reference(uuid,numeric,uuid) from public,anon,authenticated;
grant execute on function coinops.finalize_live_market_entry_reference(uuid,numeric,uuid) to service_role;
commit;
