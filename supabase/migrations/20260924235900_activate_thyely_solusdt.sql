-- Phase 5.7 one-time activation of the prepared Thyely SOLUSDT run.
-- BTCUSDT was independently reconciled before this migration.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';

create temporary table coinops_thyely_sol_activation_gate (
  valid boolean not null check (valid)
) on commit drop;

insert into coinops_thyely_sol_activation_gate (valid)
select count(*) = 1
from coinops.exchange_accounts a
join coinops.operators op on op.id = a.operator_id
join coinops.account_quote_caps cap
  on cap.exchange_account_id = a.id and cap.quote_asset = 'USDT'
join coinops.trading_engines e on e.exchange_account_id = a.id
join coinops.robot_v1_live_preparations p on p.trading_engine_id = e.id
join coinops.robot_v1_live_runs r on r.trading_engine_id = e.id
join coinops.robot_v1_ath_profiles ap
  on ap.trading_engine_id = e.id and ap.environment = 'REAL'
where a.display_name = 'Thyely' and not a.is_legacy_default
  and a.status = 'ACTIVE' and not a.kill_switch
  and op.status = 'ACTIVE' and not op.kill_switch
  and a.executor_profile = 'coinops-fixed-ip'
  and a.credential_ref = 'account_' || replace(a.id::text, '-', '')
  and cap.hard_cap_quote = 838
  and (select count(*) from coinops.trading_engines other
    where other.exchange_account_id = a.id and other.status = 'ACTIVE') = 2
  and e.symbol = 'SOLUSDT' and e.environment = 'REAL'
  and e.quote_asset = 'USDT' and e.operator_id = op.id
  and e.status = 'ACTIVE' and not e.kill_switch
  and e.hard_cap_quote = 419
  and p.exchange_account_id = a.id and p.operator_id = op.id
  and p.configured_live_capital_quote = 419
  and p.max_order_notional_quote = 419
  and p.max_total_exposure_quote = 419
  and p.slot_count = 25 and p.monthly_target = 2
  and not p.live_enabled and p.kill_switch
  and r.status = 'PREPARING' and r.quote_asset = 'USDT'
  and r.slot_notional_brl = 16.76 and r.strategy_version = '4.3.1'
  and ap.regime = 'NORMAL' and ap.gain_rate = 0.055
  and ap.normal_spacing_rate = 0.03 and ap.post_ath_spacing_rate = 0.08
  and (select count(*) from coinops.robot_v1_live_slots s
    where s.run_id = r.id) = 25
  and (select count(*) from coinops.robot_v1_live_slot_accounts sa
    where sa.trading_engine_id = e.id and sa.balance_brl = sa.contribution_brl
      and sa.manual_gain_brl = 0 and sa.market_pnl_brl = 0 and sa.fees_brl = 0) = 25
  and (select coalesce(sum(sa.balance_brl), 0)
    from coinops.robot_v1_live_slot_accounts sa
    where sa.trading_engine_id = e.id) = 419
  and not exists (select 1 from coinops.robot_v1_live_orders o where o.run_id = r.id)
  and exists (
    select 1 from coinops.trading_engines btc
    join coinops.robot_v1_live_runs br on br.trading_engine_id = btc.id
    join coinops.robot_v1_live_preparations bp on bp.trading_engine_id = btc.id
    where btc.exchange_account_id = a.id and btc.symbol = 'BTCUSDT'
      and btc.hard_cap_quote = 419 and br.status = 'ACTIVE'
      and bp.live_enabled and not bp.kill_switch and br.last_error is null
      and (select count(*) from coinops.robot_v1_live_orders bo
        where bo.run_id = br.id and bo.purpose = 'INITIAL' and bo.status = 'FILLED') = 1
      and (select count(*) from coinops.robot_v1_live_orders bo
        where bo.run_id = br.id and bo.purpose = 'TP' and bo.status = 'NEW') = 1
      and (select count(*) from coinops.robot_v1_live_orders bo
        where bo.run_id = br.id and bo.purpose = 'ENTRY' and bo.status = 'NEW') = 1
  );

select (coinops.activate_robot_v1_live_cycle(r.id)).status
from coinops.robot_v1_live_runs r
join coinops.trading_engines e on e.id = r.trading_engine_id
join coinops.exchange_accounts a on a.id = r.exchange_account_id
join coinops_thyely_sol_activation_gate gate on gate.valid
where a.display_name = 'Thyely' and not a.is_legacy_default
  and e.symbol = 'SOLUSDT' and r.status = 'PREPARING';

commit;
