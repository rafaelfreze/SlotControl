-- Fase 5.0: fail closed for NULL/NaN FX and retain executed partial-BUY evidence.
-- Replaces validation only. No historical row, position, order or balance is rewritten.
alter table coinops.robot_v1_manual_adjustments add constraint robot_v1_manual_adjustments_finite
  check (original_amount::text not in ('NaN','Infinity','-Infinity')
    and converted_amount_usdc::text not in ('NaN','Infinity','-Infinity')
    and balance_before_usdc::text not in ('NaN','Infinity','-Infinity')
    and balance_after_usdc::text not in ('NaN','Infinity','-Infinity')
    and (fx_rate is null or fx_rate::text not in ('NaN','Infinity','-Infinity'))
    and (currency<>'BRL' or (fx_source is not null and fx_rate is not null and fx_observed_at is not null))
    and (position_committed_notional_usdc is null or
      (position_committed_notional_usdc>0 and position_committed_notional_usdc::text not in ('NaN','Infinity','-Infinity'))));
alter table coinops.robot_v1_slot_accounts add constraint robot_v1_slot_accounts_finite
  check (balance_usdc::text not in ('NaN','Infinity','-Infinity')
    and initial_balance_usdc::text not in ('NaN','Infinity','-Infinity')
    and net_profit_usdc::text not in ('NaN','Infinity','-Infinity')
    and manual_gain_usdc::text not in ('NaN','Infinity','-Infinity')
    and contribution_usdc::text not in ('NaN','Infinity','-Infinity'));
alter table coinops.robot_v1_testnet_slots add constraint robot_v1_testnet_slots_finite
  check (balance_usdc::text not in ('NaN','Infinity','-Infinity')
    and net_profit_usdc::text not in ('NaN','Infinity','-Infinity')
    and manual_gain_usdc::text not in ('NaN','Infinity','-Infinity')
    and contribution_usdc::text not in ('NaN','Infinity','-Infinity'));
alter table coinops.robot_v1_real_prepared_slot_accounts add constraint robot_v1_real_prepared_accounts_finite
  check (balance_usdc::text not in ('NaN','Infinity','-Infinity')
    and manual_gain_usdc::text not in ('NaN','Infinity','-Infinity')
    and contribution_usdc::text not in ('NaN','Infinity','-Infinity'));

create or replace function coinops.apply_robot_v1_manual_adjustment(
  p_product_id uuid, p_tenant_id uuid, p_user_id uuid, p_created_by uuid,
  p_environment text, p_asset text, p_slot_number integer, p_kind text,
  p_gain_units integer, p_currency text, p_original_amount numeric,
  p_fx_rate numeric, p_fx_source text, p_fx_observed_at timestamptz,
  p_reason text, p_note text, p_reversal_of uuid, p_idempotency_key text,
  p_expected_balance numeric, p_expected_lifetime integer, p_expected_monthly integer
) returns coinops.robot_v1_manual_adjustments
language plpgsql security definer set search_path = '' as $$
declare
  v_existing coinops.robot_v1_manual_adjustments%rowtype;
  v_original coinops.robot_v1_manual_adjustments%rowtype;
  v_config coinops.robot_v1_configs%rowtype;
  v_run coinops.robot_v1_testnet_runs%rowtype;
  v_profile coinops.robot_v1_ath_profiles%rowtype;
  v_account coinops.robot_v1_slot_accounts%rowtype;
  v_test_slot coinops.robot_v1_testnet_slots%rowtype;
  v_real coinops.robot_v1_real_prepared_slot_accounts%rowtype;
  v_physical text;
  v_balance numeric(28,12);
  v_delta numeric(20,8);
  v_original_amount numeric(20,8);
  v_gain_units integer;
  v_currency text;
  v_fx_rate numeric(20,8);
  v_fx_source text;
  v_fx_at timestamptz;
  v_period text;
  v_current_period text;
  v_monthly integer;
  v_lifetime integer;
  v_open boolean := false;
  v_committed numeric(20,8);
  v_remaining_quantity numeric(28,12);
  v_fingerprint text;
  v_at timestamptz := now();
begin
  if coalesce(nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(auth.jwt() ->> 'role', ''), '') <> 'service_role' then
    raise exception 'COINOPS_ADJUSTMENT_SERVICE_ROLE_REQUIRED';
  end if;
  if p_environment is null or p_environment not in ('SHADOW','TESTNET','REAL')
    or p_asset is null or p_asset not in ('BTC','SOL')
    or p_slot_number is null or p_slot_number not between 1 and 25
    or p_created_by is null or p_created_by <> p_user_id
    or p_kind is null or p_kind not in ('MANUAL_TARGET_GAIN','MANUAL_CONTRIBUTION','REVERSAL')
    or p_idempotency_key is null or length(p_idempotency_key) not between 16 and 100
    or p_reason is null or length(btrim(p_reason)) not between 3 and 160
    or length(coalesce(p_note,'')) > 500 then
    raise exception 'COINOPS_ADJUSTMENT_INPUT_INVALID';
  end if;
  v_fingerprint := md5(pg_catalog.jsonb_build_object('environment',p_environment,'asset',p_asset,
    'slot',p_slot_number,'kind',p_kind,'gain_units',p_gain_units,'currency',p_currency,
    'amount',p_original_amount,'fx_rate',p_fx_rate,'fx_source',p_fx_source,
    'fx_at',p_fx_observed_at,'reason',btrim(p_reason),'note',nullif(btrim(coalesce(p_note,'')),''),
    'reversal_of',p_reversal_of)::text);
  select * into v_existing from coinops.robot_v1_manual_adjustments
    where product_id=p_product_id and tenant_id=p_tenant_id and user_id=p_user_id
      and idempotency_key=p_idempotency_key;
  if found then
    if v_existing.request_fingerprint <> v_fingerprint then raise exception 'COINOPS_ADJUSTMENT_IDEMPOTENCY_CONFLICT'; end if;
    return v_existing;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_product_id::text || ':' || p_tenant_id::text || ':' || p_user_id::text || ':' || p_environment || ':' || p_asset || ':' || p_slot_number, 0));
  select * into v_existing from coinops.robot_v1_manual_adjustments
    where product_id=p_product_id and tenant_id=p_tenant_id and user_id=p_user_id
      and idempotency_key=p_idempotency_key;
  if found then
    if v_existing.request_fingerprint <> v_fingerprint then raise exception 'COINOPS_ADJUSTMENT_IDEMPOTENCY_CONFLICT'; end if;
    return v_existing;
  end if;
  if p_environment = 'SHADOW' then
    select * into strict v_config from coinops.robot_v1_configs
      where product_id=p_product_id and tenant_id=p_tenant_id and user_id=p_user_id
        and asset=p_asset and execution_mode='SHADOW' for update;
    if v_config.strategy_lease_until > v_at then raise exception 'COINOPS_ADJUSTMENT_ENGINE_BUSY'; end if;
    select * into strict v_account from coinops.robot_v1_slot_accounts
      where config_id=v_config.id and slot_number=p_slot_number
        and product_id=p_product_id and tenant_id=p_tenant_id and user_id=p_user_id for update;
    v_balance := v_account.balance_usdc;
    v_physical := 'SHADOW:' || v_config.id::text || ':' || p_slot_number;
    select s.status in ('OPEN','TP_ACTIVE','PARTIALLY_FILLED') and s.executed_quantity>0, round(s.buy_price * s.executed_quantity,8)
      into v_open,v_committed from coinops.robot_v1_slots s
      join coinops.robot_v1_cycles cy on cy.id=s.cycle_id and cy.config_id=v_config.id
      where s.slot_number=p_slot_number and cy.status in ('STARTING','GRID_ACTIVE','POSITIONS_ACTIVE','RESETTING')
      order by cy.started_at desc limit 1;
  elsif p_environment = 'TESTNET' then
    select * into strict v_run from coinops.robot_v1_testnet_runs
      where product_id=p_product_id and tenant_id=p_tenant_id and user_id=p_user_id
        and asset=p_asset and status='ACTIVE' for update;
    if v_run.lease_until > v_at then raise exception 'COINOPS_ADJUSTMENT_ENGINE_BUSY'; end if;
    select * into strict v_test_slot from coinops.robot_v1_testnet_slots
      where run_id=v_run.id and slot_number=p_slot_number
        and product_id=p_product_id and tenant_id=p_tenant_id and user_id=p_user_id for update;
    v_balance := v_test_slot.balance_usdc;
    v_physical := 'TESTNET:' || p_product_id::text || ':' || p_tenant_id::text || ':' || p_user_id::text || ':' || p_asset || ':' || p_slot_number;
    select round(coalesce(sum(o.cumulative_quote) filter(where o.side='BUY'),0),8),
      coalesce(sum(case when o.side='BUY' then o.executed_quantity else -o.executed_quantity end-o.fee_base),0)
      into v_committed,v_remaining_quantity from coinops.robot_v1_testnet_orders o
      where o.run_id=v_run.id and o.slot_id=v_test_slot.id and o.operation_sequence=v_test_slot.operation_sequence;
    if v_remaining_quantity::text in ('NaN','Infinity','-Infinity') or v_remaining_quantity < -0.0000000001 then
      raise exception 'COINOPS_ADJUSTMENT_POSITION_UNAVAILABLE';
    end if;
    v_open := v_remaining_quantity > 0.0000000001;
    if not v_open then v_committed:=null; end if;
  else
    select * into strict v_profile from coinops.robot_v1_ath_profiles
      where product_id=p_product_id and tenant_id=p_tenant_id and user_id=p_user_id
        and asset=p_asset and environment='REAL' for update;
    insert into coinops.robot_v1_real_prepared_slot_accounts
      (product_id,tenant_id,user_id,asset,slot_number)
      values (p_product_id,p_tenant_id,p_user_id,p_asset,p_slot_number)
      on conflict (product_id,tenant_id,user_id,asset,slot_number) do nothing;
    select * into strict v_real from coinops.robot_v1_real_prepared_slot_accounts
      where product_id=p_product_id and tenant_id=p_tenant_id and user_id=p_user_id
        and asset=p_asset and slot_number=p_slot_number for update;
    v_balance := v_real.balance_usdc;
    v_physical := 'REAL:' || p_product_id::text || ':' || p_tenant_id::text || ':' || p_user_id::text || ':' || p_asset || ':' || p_slot_number;
  end if;
  if v_balance::text in ('NaN','Infinity','-Infinity') then
    raise exception 'COINOPS_ADJUSTMENT_BALANCE_INVALID';
  end if;
  if v_open and (v_committed is null or v_committed<=0
    or v_committed::text in ('NaN','Infinity','-Infinity')) then
    raise exception 'COINOPS_ADJUSTMENT_POSITION_UNAVAILABLE';
  end if;
  -- Persist the effective ATH/profile version for every environment. A
  -- concurrent profile edit must not produce ambiguous adjustment metadata.
  select * into strict v_profile from coinops.robot_v1_ath_profiles
    where product_id=p_product_id and tenant_id=p_tenant_id and user_id=p_user_id
      and asset=p_asset and environment=p_environment for share;
  v_current_period := to_char(v_at at time zone 'America/Campo_Grande','YYYY-MM');
  select coalesce(sum(gain_units),0)::integer,
    coalesce(sum(gain_units) filter (where period_key=v_current_period),0)::integer
    into v_lifetime,v_monthly from coinops.robot_v1_monthly_slot_gains
    where product_id=p_product_id and tenant_id=p_tenant_id and user_id=p_user_id
      and environment=p_environment and asset=p_asset and slot_number=p_slot_number;
  if v_balance is distinct from p_expected_balance or v_lifetime is distinct from p_expected_lifetime
    or v_monthly is distinct from p_expected_monthly then
    raise exception 'COINOPS_ADJUSTMENT_PREVIEW_STALE';
  end if;
  if p_kind='REVERSAL' then
    select * into strict v_original from coinops.robot_v1_manual_adjustments
      where id=p_reversal_of and product_id=p_product_id and tenant_id=p_tenant_id and user_id=p_user_id
        and environment=p_environment and asset=p_asset and slot_number=p_slot_number
        and kind in ('MANUAL_TARGET_GAIN','MANUAL_CONTRIBUTION');
    if exists (select 1 from coinops.robot_v1_manual_adjustments where reversal_of=v_original.id) then
      raise exception 'COINOPS_ADJUSTMENT_ALREADY_REVERSED';
    end if;
    v_delta := -v_original.converted_amount_usdc;
    v_original_amount := -v_original.original_amount;
    v_gain_units := -v_original.gain_units;
    v_currency := v_original.currency;
    v_fx_rate := v_original.fx_rate;
    v_fx_source := v_original.fx_source;
    v_fx_at := v_original.fx_observed_at;
    v_period := v_original.period_key;
    if v_period<>v_current_period then
      select coalesce(sum(gain_units),0)::integer into v_monthly
        from coinops.robot_v1_monthly_slot_gains
        where product_id=p_product_id and tenant_id=p_tenant_id and user_id=p_user_id
          and environment=p_environment and asset=p_asset and slot_number=p_slot_number
          and period_key=v_period;
    end if;
  else
    if p_reversal_of is not null or p_gain_units is null or p_currency is null or p_currency not in ('USD','BRL')
      or p_original_amount is null or p_original_amount::text in ('NaN','Infinity','-Infinity') or p_original_amount <= 0 or p_original_amount > 1000000
      or p_original_amount <> round(p_original_amount,8)
      or (p_kind='MANUAL_TARGET_GAIN' and (p_gain_units not between 1 and 25 or p_currency<>'USD' or p_original_amount>100000))
      or (p_kind='MANUAL_CONTRIBUTION' and p_gain_units<>0) then
      raise exception 'COINOPS_ADJUSTMENT_INPUT_INVALID';
    end if;
    v_original_amount := p_original_amount;
    v_gain_units := p_gain_units;
    v_currency := p_currency;
    v_fx_rate := p_fx_rate;
    v_fx_source := p_fx_source;
    v_fx_at := p_fx_observed_at;
    v_period := v_current_period;
    if v_currency='BRL' then
      if p_kind<>'MANUAL_CONTRIBUTION' or v_fx_source is distinct from 'BINANCE_SPOT_USDCBRL_ASK'
        or v_fx_rate is null or v_fx_rate::text in ('NaN','Infinity','-Infinity') or v_fx_rate<=0 or v_fx_at is null
        or v_fx_at>v_at+interval '10 seconds' or v_fx_at<v_at-interval '120 seconds' then
        raise exception 'COINOPS_ADJUSTMENT_FX_STALE_OR_INVALID';
      end if;
      v_delta := round(v_original_amount/v_fx_rate,8);
    else
      if v_fx_rate is not null or v_fx_source is not null or v_fx_at is not null then
        raise exception 'COINOPS_ADJUSTMENT_FX_INVALID';
      end if;
      v_delta := v_original_amount;
    end if;
  end if;
  if v_delta=0 or (p_environment='REAL' and v_balance+v_delta<0)
    or (p_environment<>'REAL' and v_balance+v_delta<=0)
    or v_lifetime+v_gain_units<0 or v_monthly+v_gain_units<0 then
    raise exception 'COINOPS_ADJUSTMENT_BALANCE_INVALID';
  end if;
  insert into coinops.robot_v1_manual_adjustments
    (product_id,tenant_id,user_id,created_by,environment,asset,slot_number,physical_slot_id,
      kind,gain_units,currency,original_amount,fx_rate,fx_source,fx_observed_at,converted_amount_usdc,
      balance_before_usdc,balance_after_usdc,monthly_before,monthly_after,lifetime_before,lifetime_after,
      period_key,open_position_at_time,position_committed_notional_usdc,reason,note,reversal_of,
      idempotency_key,request_fingerprint,strategy_version,config_version)
  values (p_product_id,p_tenant_id,p_user_id,p_created_by,p_environment,p_asset,p_slot_number,v_physical,
    p_kind,v_gain_units,v_currency,v_original_amount,v_fx_rate,v_fx_source,v_fx_at,v_delta,
    v_balance,v_balance+v_delta,v_monthly,v_monthly+v_gain_units,
    v_lifetime,v_lifetime+v_gain_units,v_period,coalesce(v_open,false),v_committed,
    btrim(p_reason),nullif(btrim(coalesce(p_note,'')),''),p_reversal_of,
    p_idempotency_key,v_fingerprint,
    case when p_environment='SHADOW' then coalesce(v_config.strategy_version,'4.3.1')
      when p_environment='TESTNET' then coalesce(v_run.strategy_version,'4.3.1')
      else '4.3.1' end,v_profile.config_version)
  returning * into v_existing;
  if p_environment='SHADOW' then
    update coinops.robot_v1_slot_accounts set balance_usdc=v_balance+v_delta,
      manual_gain_usdc=manual_gain_usdc+case when p_kind='MANUAL_TARGET_GAIN' then v_delta
        when p_kind='REVERSAL' and v_original.kind='MANUAL_TARGET_GAIN' then v_delta else 0 end,
      contribution_usdc=contribution_usdc+case when p_kind='MANUAL_CONTRIBUTION' then v_delta
        when p_kind='REVERSAL' and v_original.kind='MANUAL_CONTRIBUTION' then v_delta else 0 end,
      gain_count=gain_count+v_gain_units,updated_at=v_at
      where config_id=v_config.id and slot_number=p_slot_number;
  elsif p_environment='TESTNET' then
    update coinops.robot_v1_testnet_slots set balance_usdc=v_balance+v_delta,
      manual_gain_usdc=manual_gain_usdc+case when p_kind='MANUAL_TARGET_GAIN' then v_delta
        when p_kind='REVERSAL' and v_original.kind='MANUAL_TARGET_GAIN' then v_delta else 0 end,
      contribution_usdc=contribution_usdc+case when p_kind='MANUAL_CONTRIBUTION' then v_delta
        when p_kind='REVERSAL' and v_original.kind='MANUAL_CONTRIBUTION' then v_delta else 0 end,
      gain_count=gain_count+case when p_kind='REVERSAL' and v_original.created_at<v_run.created_at
        then 0 else v_gain_units end where id=v_test_slot.id;
  else
    update coinops.robot_v1_real_prepared_slot_accounts set balance_usdc=v_balance+v_delta,
      manual_gain_usdc=manual_gain_usdc+case when p_kind='MANUAL_TARGET_GAIN' then v_delta
        when p_kind='REVERSAL' and v_original.kind='MANUAL_TARGET_GAIN' then v_delta else 0 end,
      contribution_usdc=contribution_usdc+case when p_kind='MANUAL_CONTRIBUTION' then v_delta
        when p_kind='REVERSAL' and v_original.kind='MANUAL_CONTRIBUTION' then v_delta else 0 end,
      gain_count=gain_count+v_gain_units
      where product_id=p_product_id and tenant_id=p_tenant_id and user_id=p_user_id
        and asset=p_asset and slot_number=p_slot_number;
  end if;
  if v_gain_units<>0 then
    insert into coinops.robot_v1_monthly_slot_gains
      (environment,source_id,product_id,tenant_id,user_id,asset,slot_number,physical_slot_id,
        credited_at,effective_gain_at,evidence_basis,period_key,gain_units)
    values (p_environment,v_existing.id,p_product_id,p_tenant_id,p_user_id,p_asset,p_slot_number,v_physical,
      v_at,v_at,case when p_kind='REVERSAL' then 'MANUAL_GAIN_REVERSAL' else 'MANUAL_TARGET_GAIN' end,
      v_period,v_gain_units);
  end if;
  return v_existing;
end $$;
revoke all on function coinops.apply_robot_v1_manual_adjustment(uuid,uuid,uuid,uuid,text,text,integer,text,
  integer,text,numeric,numeric,text,timestamptz,text,text,uuid,text,numeric,integer,integer)
  from public,anon,authenticated;
grant execute on function coinops.apply_robot_v1_manual_adjustment(uuid,uuid,uuid,uuid,text,text,integer,text,
  integer,text,numeric,numeric,text,timestamptz,text,text,uuid,text,numeric,integer,integer)
  to service_role;

-- A manual credit and a TP settlement must never overwrite each other's
-- current balance. Both lock the run and the physical slot, and this RPC
-- credits P&L, monthly evidence and CLOSED state in one transaction.
-- The closure helper is installed by the following partial-accounting migration.
create function coinops.credit_robot_v1_testnet_closed_slot(
  p_run_id uuid, p_slot_id uuid, p_operation_sequence integer,
  p_closing_sell_client_order_id text, p_quantity_step numeric, p_lease_owner uuid
) returns coinops.robot_v1_testnet_slots
language plpgsql security definer set search_path = '' as $$
declare
  v_run coinops.robot_v1_testnet_runs%rowtype;
  v_slot coinops.robot_v1_testnet_slots%rowtype;
  v_previous_event coinops.robot_v1_testnet_events%rowtype;
  v_proof jsonb;
  v_profit numeric(20,8);
  v_balance numeric(20,8);
  v_gain_count integer;
  v_event_key text;
  v_at timestamptz := clock_timestamp();
begin
  if coalesce(nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(auth.jwt() ->> 'role', ''), '') <> 'service_role' then
    raise exception 'COINOPS_TESTNET_SERVICE_ROLE_REQUIRED';
  end if;
  if p_operation_sequence is null or p_operation_sequence<1
    or p_closing_sell_client_order_id is null or p_closing_sell_client_order_id=''
    or p_quantity_step is null or p_quantity_step<=0
    or p_quantity_step::text in ('NaN','Infinity','-Infinity') or p_lease_owner is null then
    raise exception 'COINOPS_TESTNET_SETTLEMENT_INPUT_INVALID';
  end if;
  select * into strict v_run from coinops.robot_v1_testnet_runs where id=p_run_id for update;
  if v_run.status<>'ACTIVE' or v_run.lease_owner is distinct from p_lease_owner
    or v_run.lease_until is null or v_run.lease_until<=clock_timestamp() then
    raise exception 'COINOPS_TESTNET_SETTLEMENT_LEASE_INVALID';
  end if;
  select * into strict v_slot from coinops.robot_v1_testnet_slots
    where id=p_slot_id and run_id=v_run.id
      and (product_id,tenant_id,user_id)=(v_run.product_id,v_run.tenant_id,v_run.user_id) for update;
  v_event_key := p_closing_sell_client_order_id || ':SLOT_CLOSED';
  select * into v_previous_event from coinops.robot_v1_testnet_events
    where run_id=v_run.id and event_key=v_event_key and event_type='SLOT_CLOSED'
      and slot_number=v_slot.slot_number;
  if v_slot.last_credited_sell_client_order_id=p_closing_sell_client_order_id then return v_slot; end if;
  if v_slot.operation_sequence>p_operation_sequence and v_previous_event.id is not null
    and (v_previous_event.details->>'operationSequence')::integer=p_operation_sequence then return v_slot; end if;
  if v_slot.entry_state<>'OPEN' or v_slot.operation_sequence<>p_operation_sequence then
    raise exception 'COINOPS_TESTNET_SETTLEMENT_STATE_INVALID';
  end if;
  -- Lock exchange evidence so another reconciliation cannot revise quantity
  -- or fees between the closure proof and its credit.
  perform 1 from coinops.robot_v1_testnet_orders where run_id=v_run.id and slot_id=v_slot.id
    and operation_sequence=p_operation_sequence for share;
  v_proof := private.coinops_testnet_operation_closure(v_run.id,v_slot.id,p_operation_sequence,p_quantity_step);
  if coalesce((v_proof->>'eligible')::boolean,false) is not true
    or v_proof->>'closing_sell_client_order_id' is distinct from p_closing_sell_client_order_id then
    raise exception 'COINOPS_TESTNET_SETTLEMENT_EVIDENCE_INVALID';
  end if;
  v_profit := (v_proof->>'net_profit_usdc')::numeric;
  v_balance := v_slot.balance_usdc+v_profit;
  v_gain_count := v_slot.gain_count+case when v_profit>0 then 1 else 0 end;
  if v_profit is null or v_profit::text in ('NaN','Infinity','-Infinity')
    or v_balance is null or v_balance<=0 or v_balance::text in ('NaN','Infinity','-Infinity') then
    raise exception 'COINOPS_TESTNET_SETTLEMENT_BALANCE_INVALID';
  end if;
  -- Recover the pre-5.0 crash window: an existing SLOT_CLOSED with OPEN slot
  -- is evidence only, not proof that money was credited. Reuse its monthly
  -- fact, but apply the still-pending balance delta under this transaction.
  if v_previous_event.id is not null and (
    (v_previous_event.details->>'operationSequence')::integer is distinct from p_operation_sequence
    or (v_previous_event.details->>'profitUsdc')::numeric is distinct from v_profit) then
    raise exception 'COINOPS_TESTNET_SETTLEMENT_REPLAY_CONFLICT';
  end if;
  insert into coinops.robot_v1_testnet_events
    (run_id,product_id,tenant_id,user_id,event_key,event_type,slot_number,details,observed_at)
  values(v_run.id,v_run.product_id,v_run.tenant_id,v_run.user_id,
    p_closing_sell_client_order_id||':SLOT_TP_FILLED','SLOT_TP_FILLED',v_slot.slot_number,
    jsonb_build_object('operationSequence',p_operation_sequence,'previousEntryPrice',v_slot.entry_reference_price,
      'takeProfitPrice',(v_proof->>'closing_sell_price')::numeric,
      'balanceBefore',v_slot.balance_usdc,'balanceAfter',v_balance,
      'gainCountBefore',v_slot.gain_count,'gainCountAfter',v_gain_count,
      'atomicSettlement',true,'strategy_version',v_run.strategy_version),v_at)
  on conflict (run_id,event_key) do nothing;
  insert into coinops.robot_v1_testnet_events
    (run_id,product_id,tenant_id,user_id,event_key,event_type,slot_number,details,observed_at)
  values(v_run.id,v_run.product_id,v_run.tenant_id,v_run.user_id,v_event_key,'SLOT_CLOSED',v_slot.slot_number,
    jsonb_build_object('operationSequence',p_operation_sequence,'profitUsdc',v_profit,'balanceUsdc',v_balance,
      'gainCount',v_gain_count,'quantityStep',p_quantity_step,
      'closingSellClientOrderId',p_closing_sell_client_order_id,
      'remainingDust',(v_proof->>'remaining_dust')::numeric,'terminalStatus',v_proof->>'closing_sell_status',
      'execution',jsonb_build_object('quantityStep',p_quantity_step,
        'closingSellClientOrderId',p_closing_sell_client_order_id,
        'remainingDust',(v_proof->>'remaining_dust')::numeric,'terminalStatus',v_proof->>'closing_sell_status'),
      'atomicSettlement',true,'strategy_version',v_run.strategy_version),v_at)
  on conflict (run_id,event_key) do nothing;
  update coinops.robot_v1_testnet_slots set entry_state='CLOSED',balance_usdc=v_balance,
    gain_count=v_gain_count,net_profit_usdc=net_profit_usdc+v_profit,
    last_take_profit_price=(v_proof->>'closing_sell_price')::numeric,
    last_credited_sell_client_order_id=p_closing_sell_client_order_id
    where id=v_slot.id returning * into v_slot;
  return v_slot;
end $$;
revoke all on function coinops.credit_robot_v1_testnet_closed_slot(uuid,uuid,integer,text,numeric,uuid)
  from public,anon,authenticated;
grant execute on function coinops.credit_robot_v1_testnet_closed_slot(uuid,uuid,integer,text,numeric,uuid)
  to service_role;
