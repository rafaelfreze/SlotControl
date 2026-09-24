-- Phase 5.7: release only Thyely's parent gates. The two runs remain
-- PREPARING and their preparations remain disabled and kill-switched.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';

create temporary table coinops_thyely_parent_gate_check (
  valid boolean not null check (valid)
) on commit drop;

insert into coinops_thyely_parent_gate_check (valid)
select coalesce((
  select count(*) = 1 and bool_and(
    a.status = 'INACTIVE' and a.kill_switch
    and a.executor_profile = 'coinops-fixed-ip'
    and a.credential_ref = 'account_' || replace(a.id::text, '-', '')
    and op.status = 'ACTIVE' and not op.kill_switch
    and cap.hard_cap_quote = 838
    and (select count(*) from coinops.trading_engines e
      where e.exchange_account_id = a.id) = 2
    and (select count(*)
      from coinops.trading_engines e
      join coinops.robot_v1_live_preparations p on p.trading_engine_id = e.id
      join coinops.robot_v1_live_runs r on r.trading_engine_id = e.id
      join coinops.robot_v1_ath_profiles ap
        on ap.trading_engine_id = e.id and ap.environment = 'REAL'
      where e.exchange_account_id = a.id
        and e.operator_id = op.id and e.environment = 'REAL'
        and e.symbol in ('BTCUSDT', 'SOLUSDT')
        and e.status = 'INACTIVE' and e.kill_switch and not e.legacy_compatible
        and e.quote_asset = 'USDT' and e.hard_cap_quote = 419
        and p.operator_id = op.id and p.exchange_account_id = a.id
        and p.configured_live_capital_quote = 419
        and p.max_order_notional_quote = 419
        and p.max_total_exposure_quote = 419 and p.slot_count = 25
        and not p.live_enabled and p.kill_switch
        and p.monthly_target = case e.symbol when 'BTCUSDT' then 7 else 2 end
        and r.status = 'PREPARING' and r.quote_asset = 'USDT'
        and r.slot_notional_brl = 16.76 and r.config_version = 1
        and r.strategy_version = '4.3.1'
        and ap.regime = 'NORMAL' and ap.config_version = 1
        and ap.gain_rate = case e.symbol when 'BTCUSDT' then 0.012 else 0.055 end
        and ap.normal_spacing_rate = case e.symbol when 'BTCUSDT' then 0.02 else 0.03 end
        and ap.post_ath_spacing_rate = case e.symbol when 'BTCUSDT' then 0.05 else 0.08 end
        and (select count(*) from coinops.robot_v1_live_slots s
          where s.run_id = r.id) = 25
        and (select count(*) from coinops.robot_v1_live_slot_accounts sa
          where sa.trading_engine_id = e.id and sa.balance_brl = sa.contribution_brl
            and sa.manual_gain_brl = 0 and sa.market_pnl_brl = 0
            and sa.fees_brl = 0) = 25
        and (select coalesce(sum(sa.balance_brl), 0)
          from coinops.robot_v1_live_slot_accounts sa
          where sa.trading_engine_id = e.id) = 419
        and not exists (select 1 from coinops.robot_v1_live_orders o
          where o.run_id = r.id)) = 2
  )
  from coinops.exchange_accounts a
  join coinops.operators op on op.id = a.operator_id
  join coinops.account_quote_caps cap
    on cap.exchange_account_id = a.id and cap.quote_asset = 'USDT'
  where a.display_name = 'Thyely' and not a.is_legacy_default
), false);

update coinops.exchange_accounts a
set status = 'ACTIVE', kill_switch = false, updated_at = now()
from coinops_thyely_parent_gate_check gate
where gate.valid and a.display_name = 'Thyely' and not a.is_legacy_default;

update coinops.trading_engines e
set status = 'ACTIVE', kill_switch = false, updated_at = now()
from coinops.exchange_accounts a, coinops_thyely_parent_gate_check gate
where gate.valid and e.exchange_account_id = a.id
  and a.display_name = 'Thyely' and not a.is_legacy_default
  and e.symbol in ('BTCUSDT', 'SOLUSDT');

insert into coinops.robot_v1_live_events
  (run_id, product_id, tenant_id, user_id, operator_id, exchange_account_id,
   trading_engine_id, quote_asset, event_key, event_type, details)
select r.id, r.product_id, r.tenant_id, r.user_id, r.operator_id,
  r.exchange_account_id, r.trading_engine_id, r.quote_asset,
  'PARENT_GATES_RELEASED', 'PARENT_GATES_RELEASED',
  jsonb_build_object('phase', '5.7', 'orders_sent', false,
    'run_status', r.status, 'capital_quote', 419)
from coinops.robot_v1_live_runs r
join coinops.exchange_accounts a on a.id = r.exchange_account_id
join coinops_thyely_parent_gate_check gate on gate.valid
where a.display_name = 'Thyely' and not a.is_legacy_default;

commit;
