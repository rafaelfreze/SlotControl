-- A completed monthly goal is informational. The last verified TP may restart
-- the cycle even when all 25 physical slots reached the goal. Every exchange,
-- scope, fill, active-order, capital, filter, lock and idempotency guard below
-- remains unchanged. No existing order, position or gain row is modified.
create or replace function coinops.restart_robot_v1_testnet_cycle_v2(
  p_old_run_id uuid,p_terminal_fill_client_order_id text,p_anchor_price numeric,p_price_tick numeric,
  p_reset_idempotency_key text,p_recovery_source text,p_reset_started_at timestamptz
) returns table(new_run_id uuid,created boolean)
language plpgsql security definer set search_path='' as $$
declare
  v_old coinops.robot_v1_testnet_runs%rowtype; v_existing coinops.robot_v1_testnet_runs%rowtype;
  v_terminal coinops.robot_v1_testnet_orders%rowtype; v_close coinops.robot_v1_testnet_events%rowtype;
  v_proof jsonb; v_new_id uuid; v_new_capital numeric; v_new_gain numeric; v_new_spacing numeric; v_delta_per_slot numeric;
begin
  if coalesce(nullif(current_setting('request.jwt.claim.role',true),''),nullif(auth.jwt()->>'role',''),'')<>'service_role' then
    raise exception 'COINOPS_TESTNET_SERVICE_ROLE_REQUIRED';
  end if;
  if p_old_run_id is null or p_terminal_fill_client_order_id is null or p_terminal_fill_client_order_id=''
    or p_anchor_price is null or p_price_tick is null or p_anchor_price::text in ('NaN','Infinity','-Infinity')
    or p_price_tick::text in ('NaN','Infinity','-Infinity') or p_anchor_price<=0 or p_price_tick<=0
    or p_reset_idempotency_key is null or p_reset_idempotency_key !~ '^[a-f0-9]{64}$'
    or p_recovery_source is null or p_recovery_source !~ '^[A-Z0-9_]{3,64}$'
    or p_reset_started_at is null or not isfinite(p_reset_started_at) then
    raise exception 'COINOPS_TESTNET_RESET_INPUT_INVALID';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_old_run_id::text,0));
  select * into v_old from coinops.robot_v1_testnet_runs where id=p_old_run_id for update;
  if v_old.id is null then raise exception 'COINOPS_TESTNET_RESET_RUN_INVALID'; end if;
  select * into v_existing from coinops.robot_v1_testnet_runs where previous_run_id=p_old_run_id and reset_idempotency_key=p_reset_idempotency_key;
  if v_existing.id is not null then
    if v_existing.previous_run_id is distinct from p_old_run_id
      or v_existing.terminal_fill_client_order_id is distinct from p_terminal_fill_client_order_id
      or v_existing.anchor_price is distinct from p_anchor_price
      or (v_existing.product_id,v_existing.tenant_id,v_existing.user_id,v_existing.asset)
        is distinct from (v_old.product_id,v_old.tenant_id,v_old.user_id,v_old.asset) then
      raise exception 'COINOPS_TESTNET_RESET_IDEMPOTENCY_CONFLICT';
    end if;
    return query select v_existing.id,false; return;
  end if;
  if v_old.status<>'ACTIVE' or not exists(select 1 from coinops.trading_engines e where e.id=v_old.trading_engine_id and e.environment='TESTNET' and e.symbol=v_old.symbol and e.base_asset=v_old.asset) then
    raise exception 'COINOPS_TESTNET_RESET_RUN_INVALID';
  end if;
  select * into v_terminal from coinops.robot_v1_testnet_orders where run_id=v_old.id
    and client_order_id=p_terminal_fill_client_order_id and side='SELL' and purpose='TP';
  if v_terminal.id is null or v_terminal.status not in ('FILLED','CANCELED','EXPIRED','EXPIRED_IN_MATCH')
    or v_terminal.executed_quantity<=0 then raise exception 'COINOPS_TESTNET_TERMINAL_FILL_REQUIRED'; end if;
  if v_terminal.status<>'FILLED' then
    select * into v_close from coinops.robot_v1_testnet_events where run_id=v_old.id
      and slot_number=v_terminal.slot_number and event_type='SLOT_CLOSED'
      and details->>'operationSequence'=v_terminal.operation_sequence::text
      and details#>>'{execution,closingSellClientOrderId}'=v_terminal.client_order_id
      order by observed_at desc limit 1;
    v_proof:=private.coinops_testnet_operation_closure(v_old.id,v_terminal.slot_id,v_terminal.operation_sequence,
      (v_close.details#>>'{execution,quantityStep}')::numeric);
    if v_close.id is null or (v_proof->>'eligible')::boolean is distinct from true
      or v_proof->>'closing_sell_client_order_id' is distinct from p_terminal_fill_client_order_id then
      raise exception 'COINOPS_TESTNET_TERMINAL_FILL_REQUIRED';
    end if;
  end if;
  if exists(select 1 from coinops.robot_v1_testnet_orders where run_id=v_old.id and status in ('PREPARED','NEW','PARTIALLY_FILLED'))
    or exists(select 1 from coinops.robot_v1_testnet_slots where run_id=v_old.id and entry_state in ('OPEN','ARMED')) then
    raise exception 'COINOPS_TESTNET_ACTIVE_OLD_ORDER';
  end if;
  if (select count(*) from coinops.robot_v1_testnet_slots where run_id=v_old.id)<>25 then
    raise exception 'COINOPS_TESTNET_PLAN_INCOMPLETE';
  end if;
  v_new_capital:=coalesce(v_old.next_capital_usdc,v_old.slot_notional_usdc*25);
  v_new_gain:=coalesce(v_old.next_gain_rate,v_old.gain_rate);
  v_new_spacing:=coalesce(v_old.next_entry_spacing,v_old.entry_spacing);
  v_delta_per_slot:=v_new_capital/25-v_old.slot_notional_usdc;
  if v_new_capital is null or v_new_capital::text in ('NaN','Infinity','-Infinity') or v_new_capital<=0 or v_new_capital>2500
    or v_new_gain is null or v_new_gain::text in ('NaN','Infinity','-Infinity') or v_new_gain not between 0.001 and 0.20
    or v_new_spacing is null or v_new_spacing::text in ('NaN','Infinity','-Infinity') or v_new_spacing not between 0.001 and 0.20
    or exists(select 1 from coinops.robot_v1_testnet_slots where run_id=v_old.id and (balance_usdc::text in ('NaN','Infinity','-Infinity')
      or balance_usdc+v_delta_per_slot<=0 or balance_usdc+v_delta_per_slot>100
      or floor((p_anchor_price*power((1-v_new_spacing)::numeric,(slot_number-1)::numeric))/p_price_tick)*p_price_tick<=0)) then
    raise exception 'COINOPS_TESTNET_NEXT_PROFILE_INVALID';
  end if;
  update coinops.robot_v1_testnet_runs set status='COMPLETED',completed_at=now(),completion_reason='LAST_OPEN_TP_FILLED',
    terminal_fill_client_order_id=p_terminal_fill_client_order_id,reset_started_at=p_reset_started_at,recovery_source=p_recovery_source where id=v_old.id;
  insert into coinops.robot_v1_testnet_runs(operator_id,exchange_account_id,trading_engine_id,quote_asset,product_id,tenant_id,user_id,asset,symbol,anchor_price,slot_notional_usdc,
    gain_rate,entry_spacing,previous_run_id,terminal_fill_client_order_id,reset_idempotency_key,reset_started_at,recovery_source)
  values(v_old.operator_id,v_old.exchange_account_id,v_old.trading_engine_id,v_old.quote_asset,v_old.product_id,v_old.tenant_id,v_old.user_id,v_old.asset,v_old.symbol,p_anchor_price,v_new_capital/25,v_new_gain,v_new_spacing,
    v_old.id,p_terminal_fill_client_order_id,p_reset_idempotency_key,p_reset_started_at,p_recovery_source) returning id into v_new_id;
  insert into coinops.robot_v1_testnet_slots(run_id,product_id,tenant_id,user_id,slot_number,entry_state,
    target_buy_price,balance_usdc,gain_count,net_profit_usdc,operation_sequence,entry_origin,entry_reference_price)
  select v_new_id,s.product_id,s.tenant_id,s.user_id,s.slot_number,'PLANNED',
    floor((p_anchor_price*power((1-v_new_spacing)::numeric,(s.slot_number-1)::numeric))/p_price_tick)*p_price_tick,
    s.balance_usdc+v_delta_per_slot,0,0,1,'GRID',
    floor((p_anchor_price*power((1-v_new_spacing)::numeric,(s.slot_number-1)::numeric))/p_price_tick)*p_price_tick
  from coinops.robot_v1_testnet_slots s where s.run_id=v_old.id order by s.slot_number;
  insert into coinops.robot_v1_testnet_events(run_id,product_id,tenant_id,user_id,event_key,event_type,details) values
    (v_old.id,v_old.product_id,v_old.tenant_id,v_old.user_id,'CYCLE_COMPLETED:'||p_reset_idempotency_key,'CYCLE_COMPLETED',
      jsonb_build_object('reason','LAST_OPEN_TP_FILLED','terminalFillClientOrderId',p_terminal_fill_client_order_id,
        'nextRunId',v_new_id,'reset_after_last_tp',true,'recovery_source',p_recovery_source)),
    (v_new_id,v_old.product_id,v_old.tenant_id,v_old.user_id,'NEW_CYCLE_STARTED:'||p_reset_idempotency_key,'NEW_CYCLE_STARTED',
      jsonb_build_object('previousRunId',v_old.id,'anchorPrice',p_anchor_price,'new_cycle_started',true,
        'recovery_source',p_recovery_source,'profile',case when v_new_gain=0.005 and v_new_spacing=0.01 then 'TEST_PROFILE' else 'CUSTOM_TEST' end));
  return query select v_new_id,true;
end $$;

revoke all on function coinops.restart_robot_v1_testnet_cycle_v2(uuid,text,numeric,numeric,text,text,timestamptz)
  from public,anon,authenticated;
grant execute on function coinops.restart_robot_v1_testnet_cycle_v2(uuid,text,numeric,numeric,text,text,timestamptz)
  to service_role;
