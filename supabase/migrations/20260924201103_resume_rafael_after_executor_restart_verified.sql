-- Guarded recovery after the LIVE cron releases its lease.
with snapshot as materialized (
  select '2026-09-24T20:10:43.080Z'::timestamptz at
  where '2026-09-24T20:10:43.080Z'::timestamptz between now()-interval '90 seconds' and now()+interval '5 seconds'
), eligible as materialized (
  select r.*, p.id prep_id,a.id alert_id,
    coalesce((select sum(position_committed_quote) from coinops.robot_v1_live_slots where run_id=r.id),0)
    +coalesce((select sum(reserved_notional_quote) from coinops.robot_v1_live_orders
      where run_id=r.id and side='BUY' and status in ('NEW','PARTIALLY_FILLED')),0) exposure
  from coinops.robot_v1_live_runs r
  join coinops.trading_engines e on e.id=r.trading_engine_id and e.status='ACTIVE'
    and e.environment='REAL' and e.kill_switch and e.hard_cap_quote=case when r.asset='BTC' then 450 else 275 end
  join coinops.exchange_accounts ac on ac.id=e.exchange_account_id and ac.display_name='Rafael'
    and ac.is_legacy_default and ac.status='ACTIVE' and not ac.kill_switch
  join coinops.operators op on op.id=ac.operator_id and op.status='ACTIVE' and not op.kill_switch
  join coinops.robot_v1_live_preparations p on p.trading_engine_id=e.id and p.kill_switch
    and p.live_enabled and p.slot_count=25 and p.max_total_exposure_quote=e.hard_cap_quote
  join coinops.robot_v1_live_alerts a on a.trading_engine_id=e.id
    and a.alert_key='LIVE_RUN:'||r.id||':CRITICAL' and a.resolved_at is null
  where r.status='ACTIVE' and r.symbol in ('BTCBRL','SOLBRL') and r.strategy_version='4.3.1'
    and r.last_error is null and r.last_reconciled_at>a.last_seen_at
    and r.last_reconciled_at>now()-interval '2 minutes' and (r.lease_until is null or r.lease_until<now())
    and a.code=case when r.asset='BTC' then 'COINOPS_LIVE_READ_STATE_FAILED'
      else 'COINOPS_LIVE_RECONCILE_ORDERS_FAILED' end
    and (select count(*) from coinops.robot_v1_live_slots where run_id=r.id)=25
    and (select count(*) from coinops.robot_v1_live_slots where run_id=r.id and entry_state='ARMED')=1
    and (select count(*) from coinops.robot_v1_live_slots where run_id=r.id and entry_state='OPEN')
      =case when r.asset='BTC' then 1 else 2 end
    and (select count(*) from coinops.robot_v1_live_orders where run_id=r.id and side='BUY' and status='NEW')=1
    and (select count(*) from coinops.robot_v1_live_orders where run_id=r.id and side='SELL' and status='NEW')
      =case when r.asset='BTC' then 1 else 2 end
    and (select count(*) from coinops.robot_v1_live_events where run_id=r.id and event_type='RECONCILED'
      and observed_at>a.last_seen_at)>=3
    and not exists(select 1 from coinops.robot_v1_live_slots s where s.run_id=r.id and s.entry_state='OPEN'
      and not exists(select 1 from coinops.robot_v1_live_orders o where o.slot_id=s.id and o.side='SELL'
        and o.status='NEW' and o.requested_quantity=s.position_quantity))
    and not exists(select 1 from coinops.robot_v1_live_orders o where o.run_id=r.id
      and o.status in ('FILLED','CANCELED','EXPIRED','REJECTED') and not o.trades_reconciled)
    and (select array_agg(client_order_id order by client_order_id) from coinops.robot_v1_live_orders
      where run_id=r.id and status='NEW')=case when r.asset='BTC' then array[
      'COR1-BTC-1-1-SELL-0ae15217041b4e','COR1-BTC-2-2-BUY-b2600a8a2003f0'] else array[
      'COR1-SOL-1-1-SELL-4ce7a19233f07a','COR1-SOL-2-1-SELL-b5cb1cd49a6c43',
      'COR1-SOL-3-1-BUY-0850edc257eb72'] end
), gate as materialized (
  select s.at from snapshot s where (select count(*) from eligible)=2
    and (select count(distinct asset) from eligible)=2
    and (select sum(exposure) from eligible)<=725
    and (select count(*) from eligible where exposure<=case when asset='BTC' then 450 else 275 end)=2
    and (select count(*) from coinops.account_quote_caps cap join eligible e
      on e.exchange_account_id=cap.exchange_account_id and e.quote_asset=cap.quote_asset
      where cap.hard_cap_quote=725)=2
), prep as (
  update coinops.robot_v1_live_preparations p set kill_switch=false from eligible e,gate g
  where p.id=e.prep_id and p.kill_switch returning p.id
), engine as (
  update coinops.trading_engines t set kill_switch=false from eligible e,gate g
  where t.id=e.trading_engine_id and t.kill_switch returning t.id
), alert as (
  update coinops.robot_v1_live_alerts a set resolved_at=now(),
    details=a.details||jsonb_build_object('classification','TRANSIENT_EXECUTOR_RESTART','exchange_verified_at',g.at)
  from eligible e,gate g where a.id=e.alert_id and a.resolved_at is null returning a.id
), audit as (
  insert into coinops.robot_v1_live_events(run_id,product_id,tenant_id,user_id,operator_id,
    exchange_account_id,trading_engine_id,quote_asset,event_key,event_type,details)
  select e.id,e.product_id,e.tenant_id,e.user_id,e.operator_id,e.exchange_account_id,
    e.trading_engine_id,e.quote_asset,'INCIDENT_RECOVERY:20260924:RESTART:'||e.asset,
    'LIVE_RESUMED',jsonb_build_object('source','BINANCE_GET_AND_LEDGER','exchange_verified_at',g.at)
  from eligible e,gate g on conflict(run_id,event_key) do nothing returning id
)
select (select count(*) from gate) gate_pass,(select count(*) from prep) preparations_resumed,
  (select count(*) from engine) engines_resumed,(select count(*) from alert) alerts_closed,
  (select count(*) from audit) events_recorded;
