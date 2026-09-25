-- A reversal is a compensating, immutable entry. It is rejected if a slot
-- has advanced, placed a later order or received another manual adjustment.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';

create function coinops.reverse_live_operator_adjustment(
  p_operator_id uuid, p_account_id uuid, p_created_by uuid,
  p_original_id uuid, p_reason text, p_request_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_operator coinops.operators%rowtype;
  v_original coinops.robot_v1_live_adjustment_batches%rowtype;
  v_existing coinops.robot_v1_live_adjustment_batches%rowtype;
  v_reverse coinops.robot_v1_live_adjustment_batches%rowtype;
  v_item coinops.robot_v1_live_adjustment_items%rowtype;
  v_slot coinops.robot_v1_live_slots%rowtype;
  v_account coinops.robot_v1_live_slot_accounts%rowtype;
  v_run coinops.robot_v1_live_runs%rowtype;
  v_total numeric:=0;
  v_engine_allocation record;
  v_current_monthly integer;
  v_current_lifetime integer;
  v_cap numeric;
  v_exposure numeric;
  v_engine_cap numeric;
  v_engine_exposure numeric;
  v_fingerprint text;
  v_item_id uuid;
begin
  if coalesce(nullif(current_setting('request.jwt.claim.role',true),''),auth.jwt()->>'role','') <> 'service_role'
    or p_operator_id is null or p_account_id is null or p_created_by is null
    or p_original_id is null or p_request_id is null
    or length(btrim(coalesce(p_reason,''))) not between 3 and 160 then
    raise exception 'COINOPS_LIVE_REVERSAL_INPUT_DENIED';
  end if;
  v_fingerprint:=md5(jsonb_build_object('operator',p_operator_id,'account',p_account_id,
    'original',p_original_id,'reason',btrim(p_reason))::text);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_account_id::text,0));
  select * into v_existing from coinops.robot_v1_live_adjustment_batches
    where exchange_account_id=p_account_id and request_id=p_request_id;
  if v_existing.id is not null then
    if v_existing.kind<>'REVERSAL' or v_existing.reversal_of<>p_original_id
      or v_existing.request_fingerprint<>v_fingerprint then
      raise exception 'COINOPS_LIVE_REVERSAL_REPLAY_CONFLICT';
    end if;
    return jsonb_build_object('id',v_existing.id,'status','REPLAYED');
  end if;
  select * into v_operator from coinops.operators where id=p_operator_id for share;
  select * into v_original from coinops.robot_v1_live_adjustment_batches
    where id=p_original_id and operator_id=p_operator_id and exchange_account_id=p_account_id for share;
  if v_operator.id is null or v_operator.status<>'ACTIVE' or v_operator.user_id<>p_created_by
    or v_original.id is null or v_original.kind not in ('MANUAL_GAIN','CAPITAL')
    or exists(select 1 from coinops.robot_v1_live_adjustment_batches where reversal_of=p_original_id) then
    raise exception 'COINOPS_LIVE_REVERSAL_SCOPE_DENIED';
  end if;
  select hard_cap_quote into v_cap from coinops.account_quote_caps
    where exchange_account_id=p_account_id and operator_id=p_operator_id
      and quote_asset=v_original.quote_asset for update;
  if v_cap is null then raise exception 'COINOPS_LIVE_REVERSAL_CAP_MISSING'; end if;
  if v_original.kind='CAPITAL' then
    select coalesce(sum(s.position_committed_brl),0) into v_exposure
      from coinops.robot_v1_live_slots s
      join coinops.robot_v1_live_runs r on r.id=s.run_id
      where r.exchange_account_id=p_account_id and r.quote_asset=v_original.quote_asset
        and r.status in ('ACTIVE','PAUSED');
    select v_exposure+coalesce(sum(o.reserved_notional_brl),0) into v_exposure
      from coinops.robot_v1_live_orders o
      join coinops.robot_v1_live_runs r on r.id=o.run_id
      where r.exchange_account_id=p_account_id and r.quote_asset=v_original.quote_asset
        and r.status in ('ACTIVE','PAUSED') and o.side='BUY'
        and o.status in ('PREPARED','SUBMITTING','NEW','PARTIALLY_FILLED');
    if v_cap-v_original.amount_quote<v_exposure then
      raise exception 'COINOPS_LIVE_REVERSAL_CAP_COMMITTED';
    end if;
  end if;
  insert into coinops.robot_v1_live_adjustment_batches
    (product_id,tenant_id,user_id,operator_id,exchange_account_id,request_id,request_fingerprint,
      kind,quote_asset,origin_currency,origin_amount,amount_quote,fx_rate,fx_observed_at,evidence,reason,reversal_of)
  values(v_original.product_id,v_original.tenant_id,v_original.user_id,p_operator_id,p_account_id,
    p_request_id,v_fingerprint,'REVERSAL',v_original.quote_asset,v_original.origin_currency,
    -v_original.origin_amount,-v_original.amount_quote,v_original.fx_rate,v_original.fx_observed_at,
    v_original.evidence,btrim(p_reason),p_original_id) returning * into v_reverse;
  for v_item in select * from coinops.robot_v1_live_adjustment_items
    where batch_id=p_original_id order by trading_engine_id,slot_number loop
    select * into v_run from coinops.robot_v1_live_runs
      where trading_engine_id=v_item.trading_engine_id and status in ('ACTIVE','PAUSED') for update;
    select * into v_slot from coinops.robot_v1_live_slots
      where run_id=v_run.id and slot_number=v_item.slot_number for share;
    select * into v_account from coinops.robot_v1_live_slot_accounts
      where trading_engine_id=v_item.trading_engine_id and slot_number=v_item.slot_number for update;
    if v_run.id is null or v_run.lease_until>now() or v_slot.id is null
      or v_slot.operation_sequence<>v_item.operation_sequence or v_account.trading_engine_id is null
      or v_account.balance_brl<v_item.amount_quote
      or exists(select 1 from coinops.robot_v1_live_orders o
        where o.trading_engine_id=v_item.trading_engine_id and o.slot_number=v_item.slot_number
          and o.created_at>v_original.created_at)
      or exists(select 1 from coinops.robot_v1_live_adjustment_items later
        where later.trading_engine_id=v_item.trading_engine_id and later.slot_number=v_item.slot_number
          and later.created_at>v_item.created_at and later.batch_id<>v_reverse.id) then
      raise exception 'COINOPS_LIVE_REVERSAL_SLOT_COMMITTED';
    end if;
    select coalesce(sum(gain_units),0)::integer,
      coalesce(sum(gain_units) filter(where period_key=v_item.period_key),0)::integer
      into v_current_lifetime,v_current_monthly from coinops.robot_v1_monthly_slot_gains
      where trading_engine_id=v_item.trading_engine_id and environment='REAL'
        and slot_number=v_item.slot_number;
    if v_current_lifetime<v_item.gain_units or v_current_monthly<v_item.gain_units
      or v_account.gain_count<v_item.gain_units then
      raise exception 'COINOPS_LIVE_REVERSAL_GAIN_COMMITTED';
    end if;
    insert into coinops.robot_v1_live_adjustment_items
      (batch_id,product_id,tenant_id,user_id,operator_id,exchange_account_id,trading_engine_id,
        symbol,quote_asset,slot_number,physical_slot_id,amount_quote,gain_units,balance_before,balance_after,
        monthly_before,monthly_after,lifetime_before,lifetime_after,open_at_time,position_committed_quote,
        operation_sequence,period_key)
    values(v_reverse.id,v_item.product_id,v_item.tenant_id,v_item.user_id,p_operator_id,p_account_id,
      v_item.trading_engine_id,v_item.symbol,v_item.quote_asset,v_item.slot_number,v_item.physical_slot_id,
      -v_item.amount_quote,-v_item.gain_units,v_account.balance_brl,
      v_account.balance_brl-v_item.amount_quote,v_current_monthly,
      v_current_monthly-v_item.gain_units,v_current_lifetime,v_current_lifetime-v_item.gain_units,
      v_slot.entry_state='OPEN',v_slot.position_committed_brl,v_slot.operation_sequence,v_item.period_key)
    returning id into v_item_id;
    update coinops.robot_v1_live_slot_accounts set
      balance_brl=balance_brl-v_item.amount_quote,
      contribution_brl=contribution_brl-v_item.amount_quote,
      gain_count=gain_count-v_item.gain_units
      where trading_engine_id=v_item.trading_engine_id and slot_number=v_item.slot_number;
    if v_item.gain_units>0 then
      insert into coinops.robot_v1_monthly_slot_gains
        (environment,source_id,product_id,tenant_id,user_id,operator_id,exchange_account_id,
          trading_engine_id,quote_asset,asset,slot_number,physical_slot_id,
          credited_at,effective_gain_at,evidence_basis,period_key,gain_units)
      values('REAL',v_item_id,v_item.product_id,v_item.tenant_id,v_item.user_id,
        p_operator_id,p_account_id,v_item.trading_engine_id,v_item.quote_asset,
        left(v_item.symbol,length(v_item.symbol)-length(v_item.quote_asset)),v_item.slot_number,
        v_item.physical_slot_id,now(),now(),'MANUAL_GAIN_REVERSAL',v_item.period_key,-v_item.gain_units);
    end if;
    v_total:=v_total+v_item.amount_quote;
  end loop;
  if v_total<>v_original.amount_quote then raise exception 'COINOPS_LIVE_REVERSAL_SUM_MISMATCH'; end if;
  if v_original.kind='CAPITAL' then
    for v_engine_allocation in select trading_engine_id,sum(amount_quote) amount_quote
      from coinops.robot_v1_live_adjustment_items where batch_id=p_original_id
      group by trading_engine_id order by trading_engine_id loop
      select hard_cap_quote into v_engine_cap from coinops.trading_engines
        where id=v_engine_allocation.trading_engine_id and exchange_account_id=p_account_id
          and operator_id=p_operator_id for update;
      select coalesce(sum(s.position_committed_brl),0) into v_engine_exposure
        from coinops.robot_v1_live_slots s
        join coinops.robot_v1_live_runs r on r.id=s.run_id
        where r.trading_engine_id=v_engine_allocation.trading_engine_id
          and r.status in ('ACTIVE','PAUSED');
      select v_engine_exposure+coalesce(sum(o.reserved_notional_brl),0) into v_engine_exposure
        from coinops.robot_v1_live_orders o
        join coinops.robot_v1_live_runs r on r.id=o.run_id
        where r.trading_engine_id=v_engine_allocation.trading_engine_id
          and r.status in ('ACTIVE','PAUSED') and o.side='BUY'
          and o.status in ('PREPARED','SUBMITTING','NEW','PARTIALLY_FILLED');
      if v_engine_cap is null or v_engine_cap-v_engine_allocation.amount_quote<v_engine_exposure then
        raise exception 'COINOPS_LIVE_REVERSAL_ENGINE_CAP_COMMITTED';
      end if;
      update coinops.trading_engines set hard_cap_quote=hard_cap_quote-v_engine_allocation.amount_quote
        where id=v_engine_allocation.trading_engine_id and hard_cap_quote>=v_engine_allocation.amount_quote;
      if not found then raise exception 'COINOPS_LIVE_REVERSAL_ENGINE_CAP'; end if;
      update coinops.robot_v1_live_preparations set
        configured_live_capital_brl=configured_live_capital_brl-v_engine_allocation.amount_quote,
        max_order_notional_brl=max_order_notional_brl-v_engine_allocation.amount_quote,
        max_total_exposure_brl=max_total_exposure_brl-v_engine_allocation.amount_quote,
        config_version=config_version+1
        where trading_engine_id=v_engine_allocation.trading_engine_id
          and configured_live_capital_brl>=v_engine_allocation.amount_quote;
      if not found then raise exception 'COINOPS_LIVE_REVERSAL_PREPARATION_CAP'; end if;
    end loop;
    update coinops.account_quote_caps set hard_cap_quote=hard_cap_quote-v_total,updated_at=now()
      where exchange_account_id=p_account_id and quote_asset=v_original.quote_asset
        and hard_cap_quote>=v_total;
    if not found then raise exception 'COINOPS_LIVE_REVERSAL_ACCOUNT_CAP'; end if;
  end if;
  return jsonb_build_object('id',v_reverse.id,'status','REVERSED','reversal_of',p_original_id);
end $$;
revoke all on function coinops.reverse_live_operator_adjustment(uuid,uuid,uuid,uuid,text,uuid)
  from public,anon,authenticated;
grant execute on function coinops.reverse_live_operator_adjustment(uuid,uuid,uuid,uuid,text,uuid)
  to service_role;
commit;
