-- CoinOps REAL: a fail-closed BUY gate must not prevent a fully reconciled,
-- ledger-only cycle transition. No Binance order is created by this function.
create unique index if not exists robot_v1_live_runs_one_successor_per_engine
  on coinops.robot_v1_live_runs(trading_engine_id,previous_run_id)
  where previous_run_id is not null;

create or replace function coinops.restart_robot_v1_live_cycle(
  p_old_run_id uuid,p_reset_key text,p_anchor_price numeric,p_gain_rate numeric,
  p_entry_spacing numeric,p_regime text,p_config_version integer,p_config_snapshot jsonb,
  p_transition_key text,p_period_key text,p_plans jsonb,p_lease_owner uuid
) returns coinops.robot_v1_live_runs language plpgsql
security definer set search_path='' as $$
declare
  v_old coinops.robot_v1_live_runs%rowtype;
  v_new coinops.robot_v1_live_runs%rowtype;
  v_config coinops.robot_v1_live_preparations%rowtype;
  v_count integer;
  v_total numeric;
  v_number integer;
  v_plan jsonb;
  v_rank integer;
  v_price numeric;
  v_group text;
  v_group_rank integer;
  v_ranks integer[]:='{}';
begin
  select * into strict v_old from coinops.robot_v1_live_runs
    where id=p_old_run_id for update;
  select * into v_new from coinops.robot_v1_live_runs
    where previous_run_id=p_old_run_id;
  if found then
    if v_new.reset_idempotency_key is distinct from p_reset_key then
      raise exception 'COINOPS_LIVE_RESET_IDEMPOTENCY_CONFLICT';
    end if;
    return v_new;
  end if;
  select * into strict v_config from coinops.robot_v1_live_preparations
    where product_id=v_old.product_id and tenant_id=v_old.tenant_id
      and user_id=v_old.user_id and trading_engine_id=v_old.trading_engine_id and asset=v_old.asset for update;
  -- A prior error/kill switch blocks exchange BUYs, not recovery of a closed
  -- cycle in the ledger. Reconciliation and the operator-controlled resume
  -- must still pass before any next MARKET is dispatched.
  if v_old.status<>'ACTIVE'
    or p_lease_owner is null or v_old.lease_owner is distinct from p_lease_owner
    or v_old.lease_until is null or v_old.lease_until<=now()
    or not v_config.live_enabled
    or p_reset_key is null or length(p_reset_key)<16
    or p_anchor_price is null or p_anchor_price<=0
    or p_gain_rate is null or p_gain_rate<0.001 or p_gain_rate>0.2
    or p_entry_spacing is null or p_entry_spacing<0.001 or p_entry_spacing>0.2
    or p_regime not in ('NORMAL','POST_ATH')
    or p_config_version is null or p_config_version<1
    or jsonb_typeof(p_config_snapshot)<>'object'
    or jsonb_typeof(p_plans)<>'array' or jsonb_array_length(p_plans)<>25
    or p_period_key !~ '^[0-9]{4}-[0-9]{2}$'
    or exists (select 1 from coinops.robot_v1_live_slots
      where run_id=v_old.id and position_quantity>0)
    or exists (select 1 from coinops.robot_v1_live_orders
      where run_id=v_old.id and status in ('PREPARED','NEW','PARTIALLY_FILLED'))
    or exists (select 1 from coinops.robot_v1_live_orders
      where run_id=v_old.id and executed_quantity>0 and not trades_reconciled) then
    raise exception 'COINOPS_LIVE_RESET_GATE_FAILED';
  end if;
  select count(*),coalesce(sum(balance_brl),0) into v_count,v_total
    from coinops.robot_v1_live_slot_accounts
    where product_id=v_old.product_id and tenant_id=v_old.tenant_id
      and user_id=v_old.user_id and trading_engine_id=v_old.trading_engine_id and asset=v_old.asset and balance_brl>0;
  if v_count<>25 or v_total<=0 then raise exception 'COINOPS_LIVE_RESET_BALANCE_INVALID'; end if;
  for v_number in 1..25 loop
    v_plan:=p_plans->(v_number-1);
    if (v_plan->>'slot_number')::integer is distinct from v_number then
      raise exception 'COINOPS_LIVE_RESET_PHYSICAL_SLOT_INVALID';
    end if;
    v_rank:=(v_plan->>'operational_rank')::integer;
    v_price:=(v_plan->>'target_buy_price')::numeric;
    v_group:=v_plan->>'post_ath_group';
    v_group_rank:=(v_plan->>'post_ath_group_rank')::integer;
    if v_price is null or v_price<=0 or v_rank is not null and
      (v_rank<1 or v_rank>25 or v_rank=any(v_ranks))
      or v_group is not null and v_group not in ('PRIMARY','RESERVE')
      or v_group_rank is not null and (v_group is null or v_group_rank<1 or v_group_rank>25) then
      raise exception 'COINOPS_LIVE_RESET_PLAN_INVALID';
    end if;
    if v_rank is not null then v_ranks:=array_append(v_ranks,v_rank); end if;
  end loop;
  update coinops.robot_v1_live_runs set status='COMPLETED',completed_at=now()
    where id=v_old.id;
  insert into coinops.robot_v1_live_runs
    (operator_id,exchange_account_id,trading_engine_id,quote_asset,product_id,tenant_id,user_id,asset,symbol,status,anchor_price,slot_notional_brl,
      gain_rate,entry_spacing,entry_regime,config_version,config_snapshot,strategy_version,
      ath_transition_key,ath_period_key,previous_run_id,reset_idempotency_key)
  values (v_old.operator_id,v_old.exchange_account_id,v_old.trading_engine_id,v_old.quote_asset,v_old.product_id,v_old.tenant_id,v_old.user_id,v_old.asset,v_old.symbol,'ACTIVE',
    p_anchor_price,round(v_total/25,8),p_gain_rate,p_entry_spacing,p_regime,
    p_config_version,p_config_snapshot,v_old.strategy_version,
    p_transition_key,p_period_key,v_old.id,p_reset_key) returning * into v_new;
  for v_number in 1..25 loop
    v_plan:=p_plans->(v_number-1);
    insert into coinops.robot_v1_live_slots
      (run_id,product_id,tenant_id,user_id,slot_number,target_buy_price,
        entry_reference_price,operational_rank,post_ath_group,post_ath_group_rank)
    values (v_new.id,v_new.product_id,v_new.tenant_id,v_new.user_id,v_number,
      (v_plan->>'target_buy_price')::numeric,(v_plan->>'target_buy_price')::numeric,
      (v_plan->>'operational_rank')::integer,v_plan->>'post_ath_group',
      (v_plan->>'post_ath_group_rank')::integer);
  end loop;
  insert into coinops.robot_v1_live_events
    (run_id,product_id,tenant_id,user_id,event_key,event_type,details)
  values (v_new.id,v_new.product_id,v_new.tenant_id,v_new.user_id,
    'RUN_REANCHORED','RUN_REANCHORED',jsonb_build_object('previous_run_id',v_old.id,
      'anchor_price',p_anchor_price,'reset_key',p_reset_key,
      'recovered_while_buy_gate_closed',v_config.kill_switch or v_old.last_error is not null));
  return v_new;
end $$;
