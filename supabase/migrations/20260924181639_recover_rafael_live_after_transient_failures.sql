do $recover$
declare
  v_account uuid;
  v_operator uuid;
  v_global numeric := 0;
  v_count integer;
  v_processed integer := 0;
  v_slots integer;
  v_open integer;
  v_armed integer;
  v_planned integer;
  v_buys integer;
  v_tps integer;
  v_exposure numeric;
  v_row record;
  v_exchange_verified_at timestamptz := '2026-09-24T18:16:35.533Z';
begin
  -- A recent direct authenticated GET from the fixed-IP executor is mandatory.
  if v_exchange_verified_at < now() - interval '90 seconds'
    or v_exchange_verified_at > now() + interval '5 seconds'
  then raise exception 'COINOPS_RAFAEL_EXCHANGE_SNAPSHOT_STALE'; end if;
  select a.id, a.operator_id into strict v_account,v_operator
  from coinops.exchange_accounts a join coinops.operators op on op.id=a.operator_id
  where a.display_name='Rafael' and a.is_legacy_default and a.status='ACTIVE'
    and not a.kill_switch and op.status='ACTIVE' and not op.kill_switch;
  select count(*) into v_count from coinops.robot_v1_live_runs r
  where r.exchange_account_id=v_account and r.status='ACTIVE' and r.symbol in ('BTCBRL','SOLBRL');
  if v_count<>2 then raise exception 'COINOPS_RAFAEL_RUN_COUNT_MISMATCH'; end if;
  for v_row in
    select r.*, e.hard_cap_quote, e.kill_switch as engine_kill,
      e.status as engine_status, p.id as prep_id, p.kill_switch as prep_kill,
      p.live_enabled, p.slot_count, p.monthly_target, p.max_total_exposure_quote,
      p.compounding_enabled, p.single_active_entry, p.initial_market_enabled,
      al.id as alert_id, al.code as alert_code, al.last_seen_at as alert_last_seen
    from coinops.robot_v1_live_runs r
    join coinops.trading_engines e on e.id=r.trading_engine_id and e.exchange_account_id=r.exchange_account_id
    join coinops.robot_v1_live_preparations p on p.trading_engine_id=e.id
      and p.product_id=r.product_id and p.tenant_id=r.tenant_id and p.user_id=r.user_id
    join coinops.robot_v1_live_alerts al on al.trading_engine_id=e.id
      and al.alert_key='LIVE_RUN:'||r.id||':CRITICAL' and al.resolved_at is null
    where r.exchange_account_id=v_account and r.operator_id=v_operator
      and r.status='ACTIVE' and r.symbol in ('BTCBRL','SOLBRL')
    order by r.symbol for update of r,e,p,al
  loop
    if v_row.strategy_version<>'4.3.1' or v_row.quote_asset<>'BRL'
      or v_row.last_error is not null
      or v_row.last_reconciled_at is null
      or v_row.last_reconciled_at < now()-interval '2 minutes'
      or v_row.last_reconciled_at <= v_row.alert_last_seen
      or v_row.lease_until is not null and v_row.lease_until>now()
      or v_row.engine_status<>'ACTIVE' or not v_row.engine_kill
      or not v_row.prep_kill or not v_row.live_enabled
      or v_row.slot_count<>25 or not v_row.compounding_enabled
      or not v_row.single_active_entry or not v_row.initial_market_enabled
      or v_row.hard_cap_quote<>(case when v_row.symbol='BTCBRL' then 450 else 275 end)
      or v_row.max_total_exposure_quote<>v_row.hard_cap_quote
      or v_row.monthly_target<>(case when v_row.symbol='BTCBRL' then 7 else 2 end)
      or v_row.alert_code<>(case when v_row.symbol='BTCBRL'
        then 'COINOPS_LIVE_READ_STATE_FAILED' else 'COINOPS_LIVE_RECONCILE_ORDERS_FAILED' end)
    then raise exception 'COINOPS_RAFAEL_RESUME_GATE_INVALID_%',v_row.symbol; end if;
    select count(*), count(*) filter(where s.entry_state='OPEN'),
      count(*) filter(where s.entry_state='ARMED'),
      count(*) filter(where s.entry_state='PLANNED')
      into v_slots,v_open,v_armed,v_planned
      from coinops.robot_v1_live_slots s where s.run_id=v_row.id;
    if v_slots<>25 or v_armed<>1
      or v_open<>(case when v_row.symbol='BTCBRL' then 1 else 2 end)
      or v_planned<>25-v_open-v_armed
    then raise exception 'COINOPS_RAFAEL_SLOT_STATE_INVALID_%',v_row.symbol; end if;
    select count(*) into v_count from coinops.robot_v1_live_slot_accounts a
    where a.trading_engine_id=v_row.trading_engine_id
      and abs(a.balance_brl-(a.contribution_brl+a.market_pnl_brl+a.manual_gain_brl-a.fees_brl-a.dust_cost_brl))<=0.00000001;
    if v_count<>25 then raise exception 'COINOPS_RAFAEL_ACCOUNTING_INVALID_%',v_row.symbol; end if;
    select count(*) filter(where o.side='BUY'),count(*) filter(where o.side='SELL')
      into v_buys,v_tps from coinops.robot_v1_live_orders o
    where o.run_id=v_row.id and o.status in ('NEW','PARTIALLY_FILLED');
    if v_buys<>1 or v_tps<>v_open
      or exists(select 1 from coinops.robot_v1_live_orders o
        where o.run_id=v_row.id and o.status in ('NEW','PARTIALLY_FILLED')
          and o.client_order_id not like 'COR1-'||v_row.asset||'-%')
      or exists(select 1 from coinops.robot_v1_live_orders o
        where o.run_id=v_row.id and o.status in ('FILLED','CANCELED','EXPIRED','REJECTED')
          and not o.trades_reconciled)
      or exists(select 1 from coinops.robot_v1_live_slots s
        where s.run_id=v_row.id and s.entry_state='OPEN' and not exists
          (select 1 from coinops.robot_v1_live_orders o
           where o.slot_id=s.id and o.side='SELL' and o.purpose='TP'
             and o.status='NEW' and o.requested_quantity=s.position_quantity))
    then raise exception 'COINOPS_RAFAEL_ORDER_PROTECTION_INVALID_%',v_row.symbol; end if;
    select coalesce(sum(s.position_committed_quote),0) into v_exposure
      from coinops.robot_v1_live_slots s where s.run_id=v_row.id;
    select v_exposure+coalesce(sum(o.reserved_notional_quote),0) into v_exposure
      from coinops.robot_v1_live_orders o
      where o.run_id=v_row.id and o.side='BUY' and o.status in ('NEW','PARTIALLY_FILLED');
    if v_exposure>v_row.hard_cap_quote then
      raise exception 'COINOPS_RAFAEL_ENGINE_CAP_INVALID_%',v_row.symbol; end if;
    v_global:=v_global+v_exposure;
    select count(*) into v_count from coinops.robot_v1_live_events ev
    where ev.run_id=v_row.id and ev.event_type='RECONCILED'
      and ev.observed_at>v_row.alert_last_seen;
    if v_count<3 then raise exception 'COINOPS_RAFAEL_RECOVERY_UNPROVEN_%',v_row.symbol; end if;
    update coinops.robot_v1_live_preparations set kill_switch=false
      where id=v_row.prep_id and kill_switch and live_enabled;
    get diagnostics v_count=row_count;
    if v_count<>1 then raise exception 'COINOPS_RAFAEL_PREP_UPDATE_FAILED_%',v_row.symbol; end if;
    update coinops.trading_engines set kill_switch=false
      where id=v_row.trading_engine_id and kill_switch and status='ACTIVE';
    get diagnostics v_count=row_count;
    if v_count<>1 then raise exception 'COINOPS_RAFAEL_ENGINE_UPDATE_FAILED_%',v_row.symbol; end if;
    update coinops.robot_v1_live_alerts
      set resolved_at=now(), details=details||jsonb_build_object(
        'classification','TRANSIENT_FAILURE_RESOLVED',
        'resolution','DIRECT_BINANCE_LEDGER_MATCH_AND_RESUME',
        'exchange_verified_at',v_exchange_verified_at)
      where id=v_row.alert_id and resolved_at is null;
    get diagnostics v_count=row_count;
    if v_count<>1 then raise exception 'COINOPS_RAFAEL_ALERT_UPDATE_FAILED_%',v_row.symbol; end if;
    insert into coinops.robot_v1_live_events
      (run_id,product_id,tenant_id,user_id,operator_id,exchange_account_id,
       trading_engine_id,quote_asset,event_key,event_type,details)
    values (v_row.id,v_row.product_id,v_row.tenant_id,v_row.user_id,v_row.operator_id,
      v_row.exchange_account_id,v_row.trading_engine_id,v_row.quote_asset,
      'INCIDENT_RECOVERY:20260924:'||v_row.symbol,'LIVE_RESUMED',
      jsonb_build_object('source','DIRECT_BINANCE_LEDGER_RECOVERY',
        'classification','TRANSIENT_FAILURE_RESOLVED',
        'exchange_verified_at',v_exchange_verified_at,
        'exposure_brl',v_exposure))
    on conflict (run_id,event_key) do nothing;
    v_processed:=v_processed+1;
  end loop;
  if v_processed<>2 then raise exception 'COINOPS_RAFAEL_ALERT_COUNT_MISMATCH'; end if;
  if v_global>725 or coalesce((select c.hard_cap_quote from coinops.account_quote_caps c
    where c.exchange_account_id=v_account and c.quote_asset='BRL'),-1)<>725
  then raise exception 'COINOPS_RAFAEL_GLOBAL_CAP_INVALID'; end if;
end; $recover$;
