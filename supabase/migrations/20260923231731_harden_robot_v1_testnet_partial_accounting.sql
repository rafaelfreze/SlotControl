-- Fase 5.0. TESTNET only: one quantitative closure proof shared by the atomic
-- credit RPC, monthly gain trigger and terminal-cycle restart. No exchange call.
alter table coinops.robot_v1_testnet_orders drop constraint if exists robot_v1_testnet_orders_status_check;
alter table coinops.robot_v1_testnet_orders add constraint robot_v1_testnet_orders_status_check
  check(status in ('PREPARED','NEW','PARTIALLY_FILLED','FILLED','CANCELED','EXPIRED','EXPIRED_IN_MATCH','REJECTED'));

create or replace function private.coinops_testnet_operation_closure(
  p_run_id uuid,p_slot_id uuid,p_operation_sequence integer,p_quantity_step numeric
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  v_run coinops.robot_v1_testnet_runs%rowtype;
  v_slot coinops.robot_v1_testnet_slots%rowtype;
  v_order coinops.robot_v1_testnet_orders%rowtype;
  v_closing coinops.robot_v1_testnet_orders%rowtype;
  v_buy numeric:=0; v_sell numeric:=0; v_fee_base numeric:=0; v_cost numeric:=0;
  v_proceeds numeric:=0; v_fee_quote numeric:=0; v_remaining numeric; v_closed_at timestamptz;
begin
  if p_run_id is null or p_slot_id is null or p_operation_sequence is null or p_operation_sequence<1
    or p_quantity_step is null or p_quantity_step::text in ('NaN','Infinity','-Infinity') or p_quantity_step<=0 then
    return jsonb_build_object('eligible',false,'reason','INVALID_CLOSURE_INPUT');
  end if;
  select * into v_run from coinops.robot_v1_testnet_runs where id=p_run_id;
  select * into v_slot from coinops.robot_v1_testnet_slots where id=p_slot_id and run_id=p_run_id;
  if v_run.id is null or v_slot.id is null or (v_slot.product_id,v_slot.tenant_id,v_slot.user_id)
    is distinct from (v_run.product_id,v_run.tenant_id,v_run.user_id) then
    return jsonb_build_object('eligible',false,'reason','CLOSURE_SCOPE_INVALID');
  end if;
  for v_order in select * from coinops.robot_v1_testnet_orders
    where run_id=p_run_id and slot_id=p_slot_id and operation_sequence=p_operation_sequence
    order by revision,id loop
    if (v_order.product_id,v_order.tenant_id,v_order.user_id) is distinct from
      (v_run.product_id,v_run.tenant_id,v_run.user_id) or v_order.slot_number<>v_slot.slot_number
      or v_order.side not in ('BUY','SELL') or (v_order.side='SELL' and v_order.purpose<>'TP') then
      return jsonb_build_object('eligible',false,'reason','CLOSURE_SCOPE_INVALID');
    end if;
    if v_order.status not in ('FILLED','CANCELED','EXPIRED','EXPIRED_IN_MATCH','REJECTED') then
      return jsonb_build_object('eligible',false,'reason','ORDER_NOT_TERMINAL');
    end if;
    if v_order.executed_quantity is null or v_order.cumulative_quote is null or v_order.fee_base is null or v_order.fee_quote is null
      or v_order.executed_quantity::text in ('NaN','Infinity','-Infinity')
      or v_order.cumulative_quote::text in ('NaN','Infinity','-Infinity')
      or v_order.fee_base::text in ('NaN','Infinity','-Infinity') or v_order.fee_quote::text in ('NaN','Infinity','-Infinity')
      or least(v_order.executed_quantity,v_order.cumulative_quote,v_order.fee_base,v_order.fee_quote)<0 then
      return jsonb_build_object('eligible',false,'reason','NON_FINITE_OR_NEGATIVE_EXECUTION');
    end if;
    if v_order.executed_quantity>0 and (not coalesce(v_order.trades_reconciled,false)
      or v_order.exchange_order_id is null or v_order.cumulative_quote<=0 or v_order.status='REJECTED') then
      return jsonb_build_object('eligible',false,'reason','EXECUTION_NOT_RECONCILED');
    end if;
    if exists(select 1 from jsonb_array_elements(v_order.fee_other) fee
      where fee->>'amount' is null or (fee->>'amount')::numeric<>0) then
      return jsonb_build_object('eligible',false,'reason','OTHER_FEE_REQUIRES_VALUATION');
    end if;
    if v_order.side='SELL' and v_order.executed_quantity>0 and (v_order.price is null
      or v_order.price::text in ('NaN','Infinity','-Infinity') or v_order.price<=0) then
      return jsonb_build_object('eligible',false,'reason','CLOSING_SELL_PRICE_INVALID');
    end if;
    v_fee_base:=v_fee_base+v_order.fee_base; v_fee_quote:=v_fee_quote+v_order.fee_quote;
    if v_order.side='BUY' then
      v_buy:=v_buy+v_order.executed_quantity; v_cost:=v_cost+v_order.cumulative_quote;
    else
      v_sell:=v_sell+v_order.executed_quantity; v_proceeds:=v_proceeds+v_order.cumulative_quote;
      if v_order.executed_quantity>0 then v_closing:=v_order; end if;
    end if;
  end loop;
  v_remaining:=v_buy-v_fee_base-v_sell;
  if v_buy<=0 or v_sell<=0 or v_closing.id is null or v_remaining < -0.0000000001 or v_remaining>=p_quantity_step then
    return jsonb_build_object('eligible',false,'reason','POSITION_NOT_CLOSED','remaining_dust',v_remaining);
  end if;
  -- Revision order identifies the closing TP for idempotency, not fill time.
  -- A lower revision can have its residual filled after a newer TP revision.
  -- Never infer an early close from only a subset of executed SELL orders.
  -- Missing temporal evidence retains the explicit CREDIT_FALLBACK downstream.
  select case when count(distinct o.id)=(select count(*) from coinops.robot_v1_testnet_orders expected
      where expected.run_id=p_run_id and expected.slot_id=p_slot_id and expected.operation_sequence=p_operation_sequence
        and expected.side='SELL' and expected.executed_quantity>0)
    then max((e.details->>'filledAt')::timestamptz) else null end into v_closed_at from coinops.robot_v1_testnet_events e
    join coinops.robot_v1_testnet_orders o on o.run_id=e.run_id and o.client_order_id=e.details->>'clientOrderId'
    where e.run_id=p_run_id and e.event_type='TESTNET_FILL_OBSERVED'
      and o.slot_id=p_slot_id and o.operation_sequence=p_operation_sequence
      and o.side='SELL' and o.executed_quantity>0 and e.details->>'filledAt' is not null;
  return jsonb_build_object('eligible',true,'reason','TERMINAL_RECONCILED_POSITION',
    'buy_quantity',v_buy,'sell_quantity',v_sell,'fee_base',v_fee_base,
    'committed_quote',v_cost,'realized_quote',v_proceeds,'fees_quote',v_fee_quote,
    'remaining_dust',greatest(0,v_remaining),'net_profit_usdc',round(v_proceeds-v_cost-v_fee_quote,8),
    'closing_sell_client_order_id',v_closing.client_order_id,'closing_sell_price',v_closing.price,
    'closing_sell_status',v_closing.status,'closed_at',v_closed_at);
end $$;
revoke all on function private.coinops_testnet_operation_closure(uuid,uuid,integer,numeric) from public,anon,authenticated;
grant execute on function private.coinops_testnet_operation_closure(uuid,uuid,integer,numeric) to service_role;

create or replace function coinops.record_robot_v1_testnet_monthly_gain()
returns trigger language plpgsql security invoker set search_path='' as $$
declare
  v_run coinops.robot_v1_testnet_runs%rowtype;
  v_slot coinops.robot_v1_testnet_slots%rowtype;
  v_sequence integer; v_profit numeric; v_terminal coinops.robot_v1_testnet_orders%rowtype;
  v_fill_at timestamptz; v_proof jsonb;
begin
  if new.event_type<>'SLOT_CLOSED' then return new; end if;
  v_profit:=(new.details->>'profitUsdc')::numeric;
  if v_profit is null or v_profit::text in ('NaN','Infinity','-Infinity') then
    raise exception 'COINOPS_MONTHLY_TESTNET_GAIN_UNKNOWN';
  end if;
  if v_profit<=0 then return new; end if;
  v_sequence:=(new.details->>'operationSequence')::integer;
  select * into strict v_run from coinops.robot_v1_testnet_runs where id=new.run_id for update;
  select * into strict v_slot from coinops.robot_v1_testnet_slots
    where run_id=new.run_id and slot_number=new.slot_number for update;
  if v_sequence is null or v_sequence<1 or (new.product_id,new.tenant_id,new.user_id)
    is distinct from (v_run.product_id,v_run.tenant_id,v_run.user_id)
    or (v_slot.product_id,v_slot.tenant_id,v_slot.user_id) is distinct from (v_run.product_id,v_run.tenant_id,v_run.user_id)
    or (new.details->>'gainCount')::integer is distinct from v_slot.gain_count+1 then
    raise exception 'COINOPS_MONTHLY_TESTNET_GAIN_EVIDENCE_INVALID';
  end if;
  if new.details->'execution' ? 'quantityStep' then
    v_proof:=private.coinops_testnet_operation_closure(new.run_id,v_slot.id,v_sequence,
      (new.details#>>'{execution,quantityStep}')::numeric);
    if (v_proof->>'eligible')::boolean is distinct from true
      or v_proof->>'closing_sell_client_order_id' is distinct from new.details#>>'{execution,closingSellClientOrderId}'
      or (v_proof->>'net_profit_usdc')::numeric is distinct from round(v_profit,8) then
      raise exception 'COINOPS_MONTHLY_TESTNET_GAIN_EVIDENCE_INVALID';
    end if;
    select * into v_terminal from coinops.robot_v1_testnet_orders
      where run_id=new.run_id and slot_id=v_slot.id and operation_sequence=v_sequence
        and client_order_id=v_proof->>'closing_sell_client_order_id';
    v_fill_at:=(v_proof->>'closed_at')::timestamptz;
  else
    -- Compatibility for an already deployed 4.4 worker during rollout. A
    -- terminal partial can NEVER use this FILLED-only historical path.
    select * into v_terminal from coinops.robot_v1_testnet_orders o
      where o.run_id=new.run_id and o.slot_id=v_slot.id and o.operation_sequence=v_sequence
        and o.side='SELL' and o.purpose='TP' and o.status='FILLED' order by o.revision desc limit 1;
    select (e.details->>'filledAt')::timestamptz into v_fill_at from coinops.robot_v1_testnet_events e
      where e.run_id=new.run_id and e.event_type='TESTNET_FILL_OBSERVED'
        and e.details->>'clientOrderId'=v_terminal.client_order_id and e.details->>'filledAt' is not null
      order by e.observed_at desc limit 1;
  end if;
  if v_terminal.id is null then raise exception 'COINOPS_MONTHLY_TESTNET_GAIN_EVIDENCE_INVALID'; end if;
  if exists(select 1 from coinops.robot_v1_monthly_slot_gains gain
    join coinops.robot_v1_testnet_events source on source.id=gain.source_id and gain.environment='TESTNET'
    where source.run_id=new.run_id and source.slot_number=new.slot_number and source.event_type='SLOT_CLOSED'
      and source.details->>'operationSequence'=v_sequence::text and source.id<>new.id) then
    raise exception 'COINOPS_MONTHLY_TESTNET_OPERATION_ALREADY_CREDITED';
  end if;
  insert into coinops.robot_v1_monthly_slot_gains
    (environment,source_id,product_id,tenant_id,user_id,asset,slot_number,physical_slot_id,
      credited_at,effective_gain_at,evidence_basis,period_key)
  values('TESTNET',new.id,new.product_id,new.tenant_id,new.user_id,v_run.asset,new.slot_number,
    'TESTNET:'||new.product_id::text||':'||new.tenant_id::text||':'||new.user_id::text||':'||v_run.asset||':'||new.slot_number::text,
    new.observed_at,coalesce(v_fill_at,new.observed_at),
    case when v_fill_at is null then 'TESTNET_CREDIT_FALLBACK' else 'TESTNET_EXCHANGE_FILL' end,
    to_char(coalesce(v_fill_at,new.observed_at) at time zone 'America/Campo_Grande','YYYY-MM'))
  on conflict(environment,source_id) do nothing;
  return new;
end $$;
revoke all on function coinops.record_robot_v1_testnet_monthly_gain() from public,anon,authenticated;
grant execute on function coinops.record_robot_v1_testnet_monthly_gain() to service_role;

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
  select * into v_existing from coinops.robot_v1_testnet_runs where reset_idempotency_key=p_reset_idempotency_key;
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
  if v_old.status<>'ACTIVE' or not ((v_old.asset='BTC' and v_old.symbol='BTCUSDC') or (v_old.asset='SOL' and v_old.symbol='SOLUSDC')) then
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
  if not exists(select 1 from coinops.robot_v1_testnet_slots s left join coinops.robot_v1_slot_gain_totals g
    on g.environment='TESTNET' and g.product_id=v_old.product_id and g.tenant_id=v_old.tenant_id
      and g.user_id=v_old.user_id and g.asset=v_old.asset and g.slot_number=s.slot_number
    where s.run_id=v_old.id and coalesce(g.monthly_gain_count,0)<case when v_old.asset='BTC' then 7 else 2 end) then
    raise exception 'COINOPS_TESTNET_ALL_MONTHLY_TARGETS_REACHED';
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
  insert into coinops.robot_v1_testnet_runs(product_id,tenant_id,user_id,asset,symbol,anchor_price,slot_notional_usdc,
    gain_rate,entry_spacing,previous_run_id,terminal_fill_client_order_id,reset_idempotency_key,reset_started_at,recovery_source)
  values(v_old.product_id,v_old.tenant_id,v_old.user_id,v_old.asset,v_old.symbol,p_anchor_price,v_new_capital/25,v_new_gain,v_new_spacing,
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
revoke all on function coinops.restart_robot_v1_testnet_cycle_v2(uuid,text,numeric,numeric,text,text,timestamptz) from public,anon,authenticated;
grant execute on function coinops.restart_robot_v1_testnet_cycle_v2(uuid,text,numeric,numeric,text,text,timestamptz) to service_role;
