begin;

-- Rafael remains the pinned legacy identity at Executor 01, but its financial
-- caps are no longer immutable bootstrap constants. The ledger, per-engine cap
-- and per-account cap remain the authoritative limits after an audited aporte.
create or replace function coinops.prepare_robot_v1_live_order(
  p_run_id uuid, p_slot_id uuid, p_side text, p_purpose text,
  p_revision integer, p_client_order_id text, p_quantity numeric,
  p_quote numeric, p_price numeric, p_decision_id text, p_lease_owner uuid
) returns coinops.robot_v1_live_orders language plpgsql
security definer set search_path='' as $$
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
  if v_config.symbol<>v_run.symbol or v_config.slot_count<>25
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
  if p_purpose='INITIAL' then
    if p_quote is null or p_quote<=0 or p_quantity is not null or p_price is not null
      or v_slot.operation_sequence<>1 or v_slot.operational_rank<>1 then
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
    if not v_config.live_enabled or v_config.kill_switch or v_slot.entry_state<>'PLANNED'
      or v_notional > v_config.max_order_notional_brl
      or exists (select 1 from coinops.robot_v1_live_orders o where o.run_id=p_run_id
        and o.side='BUY' and o.status in ('PREPARED','NEW','PARTIALLY_FILLED')) then
      raise exception 'COINOPS_LIVE_NEW_BUY_BLOCKED';
    end if;
    select count(*),coalesce(sum(contribution_brl),0) into v_accounts,v_account_balance
      from coinops.robot_v1_live_slot_accounts a where a.product_id=v_run.product_id
        and a.tenant_id=v_run.tenant_id and a.user_id=v_run.user_id and a.trading_engine_id=v_run.trading_engine_id and a.asset=v_run.asset;
    if v_accounts<>25 or v_account_balance>v_config.configured_live_capital_brl
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
    (run_id,slot_id,product_id,tenant_id,user_id,slot_number,operation_sequence,
      side,purpose,revision,client_order_id,requested_quantity,requested_quote,price,
      reserved_notional_brl,strategy_decision_id,config_version,config_snapshot)
  values (v_run.id,v_slot.id,v_run.product_id,v_run.tenant_id,v_run.user_id,v_slot.slot_number,
    v_slot.operation_sequence,p_side,p_purpose,p_revision,p_client_order_id,p_quantity,p_quote,p_price,
    case when p_side='BUY' then v_notional else 0 end,p_decision_id,
    v_run.config_version,v_run.config_snapshot) returning * into v_order;
  return v_order;
end $$;

create or replace function coinops.activate_robot_v1_live_cycle(p_run_id uuid)
returns coinops.robot_v1_live_runs language plpgsql
security definer set search_path='' as $$
declare
  v_run coinops.robot_v1_live_runs%rowtype;
  v_config coinops.robot_v1_live_preparations%rowtype;
  v_global coinops.account_quote_caps%rowtype;
  v_engine coinops.trading_engines%rowtype;
  v_count integer;
  v_contribution numeric;
begin
  select * into strict v_run from coinops.robot_v1_live_runs where id=p_run_id for update;
  select * into strict v_engine from coinops.trading_engines where id=v_run.trading_engine_id for share;
  select * into strict v_global from coinops.account_quote_caps
    where exchange_account_id=v_run.exchange_account_id and quote_asset=v_run.quote_asset for update;
  select * into strict v_config from coinops.robot_v1_live_preparations
    where product_id=v_run.product_id and tenant_id=v_run.tenant_id
      and user_id=v_run.user_id and trading_engine_id=v_run.trading_engine_id and asset=v_run.asset for update;
  if v_engine.status<>'ACTIVE' or v_engine.kill_switch
      or exists(select 1 from coinops.exchange_accounts a where a.id=v_run.exchange_account_id and (a.status<>'ACTIVE' or a.kill_switch))
      or exists(select 1 from coinops.operators o where o.id=v_run.operator_id and (o.status<>'ACTIVE' or o.kill_switch)) then
      raise exception 'COINOPS_ENGINE_NEW_WRITES_BLOCKED'; end if;
  if v_run.status='ACTIVE' and v_config.live_enabled and not v_config.kill_switch then return v_run; end if;
  if v_run.status<>'PREPARING' or v_config.live_enabled or not v_config.kill_switch
    or v_config.slot_count<>25 or v_config.configured_live_capital_brl > v_engine.hard_cap_quote
    or v_config.max_order_notional_brl > v_engine.hard_cap_quote
    or v_config.max_total_exposure_brl > v_engine.hard_cap_quote
    or v_engine.hard_cap_quote > v_global.hard_cap_quote
    or exists (select 1 from coinops.robot_v1_live_orders where run_id=v_run.id) then
    raise exception 'COINOPS_LIVE_ACTIVATION_GATE_FAILED';
  end if;
  select count(*) into v_count from coinops.robot_v1_live_slots where run_id=v_run.id;
  if v_count<>25 then raise exception 'COINOPS_LIVE_SLOT_COUNT_INVALID'; end if;
  select count(*),coalesce(sum(contribution_brl),0) into v_count,v_contribution
    from coinops.robot_v1_live_slot_accounts where product_id=v_run.product_id
      and tenant_id=v_run.tenant_id and user_id=v_run.user_id and trading_engine_id=v_run.trading_engine_id and asset=v_run.asset
      and balance_brl=contribution_brl and manual_gain_brl=0 and market_pnl_brl=0 and fees_brl=0;
  if v_count<>25 or v_contribution<>v_config.configured_live_capital_brl then
    raise exception 'COINOPS_LIVE_PRINCIPAL_NOT_PROVEN';
  end if;
  update coinops.robot_v1_live_preparations set live_enabled=true,kill_switch=false,
    config_version=config_version+1 where id=v_config.id;
  update coinops.robot_v1_live_runs set status='ACTIVE' where id=v_run.id returning * into v_run;
  insert into coinops.robot_v1_live_events
    (run_id,product_id,tenant_id,user_id,event_key,event_type,details)
  values (v_run.id,v_run.product_id,v_run.tenant_id,v_run.user_id,
    'RUN_ACTIVATED','RUN_ACTIVATED',jsonb_build_object('asset',v_run.asset,
      'capital_brl',v_contribution,'strategy_version',v_run.strategy_version));
  return v_run;
end $$;

commit;
