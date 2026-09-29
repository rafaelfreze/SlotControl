-- UI-only projection of current cycles. SECURITY INVOKER retains every table's
-- Version aligned with the official Supabase migration history after application.
-- RLS; caller IDs narrow access and can never grant it. No writes or dispatch.
create or replace function coinops.dashboard_live_engine_reads(
  p_operator_id uuid, p_engine_ids uuid[]
) returns table(engine_id uuid, payload jsonb)
language sql stable security invoker set search_path = '' as $$
select e.id, jsonb_build_object(
  'run', to_jsonb(r),
  'slots', coalesce((select jsonb_agg(x order by x.slot_number) from (
    select slot_number,entry_state,target_buy_price,operational_rank,post_ath_group,
      post_ath_group_rank,operation_sequence,position_quantity,position_committed_brl,
      position_committed_quote,missed_at
    from coinops.robot_v1_live_slots where operator_id=e.operator_id
      and exchange_account_id=e.exchange_account_id and trading_engine_id=e.id and run_id=r.id
  ) x), '[]'::jsonb),
  'orders', coalesce((select jsonb_agg(x order by x.created_at, x.client_order_id) from (
    select side,purpose,status,slot_number,client_order_id,exchange_order_id,price,
      requested_quantity,requested_quote,executed_quantity,cumulative_quote,created_at,
      updated_at,fee_base,fee_quote,fee_other,reserved_notional_brl,reserved_notional_quote
    from coinops.robot_v1_live_orders where operator_id=e.operator_id
      and exchange_account_id=e.exchange_account_id and trading_engine_id=e.id and run_id=r.id
  ) x), '[]'::jsonb),
  'accounts', coalesce((select jsonb_agg(x order by x.slot_number) from (
    select slot_number,balance_brl,balance_quote,contribution_brl,contribution_quote,
      market_pnl_brl,market_pnl_quote,manual_gain_brl,manual_gain_quote,fees_brl,fees_quote,
      gain_count,dust_quantity,dust_cost_brl,dust_cost_quote
    from coinops.robot_v1_live_slot_accounts where operator_id=e.operator_id
      and exchange_account_id=e.exchange_account_id and trading_engine_id=e.id
  ) x), '[]'::jsonb),
  'selectiveAllocations', coalesce((select jsonb_agg(x order by x.created_at) from (
    select slot_number,amount_quote,status,created_at,applied_at
    from coinops.robot_v1_live_selective_contribution_allocations where operator_id=e.operator_id
      and exchange_account_id=e.exchange_account_id and trading_engine_id=e.id
      and status in ('PENDING','APPLIED')
  ) x), '[]'::jsonb),
  'events', coalesce((select jsonb_agg(x order by x.observed_at desc) from (
    select event_type,slot_number,observed_at,details from coinops.robot_v1_live_events
    where operator_id=e.operator_id and exchange_account_id=e.exchange_account_id
      and trading_engine_id=e.id and run_id=r.id order by observed_at desc limit 40
  ) x), '[]'::jsonb),
  'alerts', coalesce((select jsonb_agg(x) from (
    select severity,code,last_seen_at from coinops.robot_v1_live_alerts
    where operator_id=e.operator_id and exchange_account_id=e.exchange_account_id
      and trading_engine_id=e.id and resolved_at is null
  ) x), '[]'::jsonb),
  'monthlyGains', coalesce((select jsonb_agg(x) from (
    select slot_number,physical_slot_id,period_key,lifetime_gain_count,monthly_gain_count,
      market_gain_count,manual_gain_count,monthly_market_gain_count,monthly_manual_gain_count
    from coinops.robot_v1_slot_gain_totals where operator_id=e.operator_id
      and exchange_account_id=e.exchange_account_id and trading_engine_id=e.id
  ) x), '[]'::jsonb),
  'preparation', (select jsonb_build_object('liveEnabled',live_enabled,'killSwitch',kill_switch)
    from coinops.robot_v1_live_preparations where operator_id=e.operator_id
      and exchange_account_id=e.exchange_account_id and trading_engine_id=e.id)
)
from coinops.trading_engines e
left join lateral (
  select id,status,symbol,entry_regime,last_reconciled_at,last_error,config_version,gain_rate,entry_spacing
  from coinops.robot_v1_live_runs where operator_id=e.operator_id
    and exchange_account_id=e.exchange_account_id and trading_engine_id=e.id
    and status in ('PREPARING','ACTIVE','PAUSED')
) r on true
where e.operator_id=p_operator_id and e.id=any(p_engine_ids) and e.environment='REAL'
  and cardinality(p_engine_ids) between 1 and 32
order by e.id;
$$;

revoke all on function coinops.dashboard_live_engine_reads(uuid,uuid[]) from public, anon;
grant execute on function coinops.dashboard_live_engine_reads(uuid,uuid[]) to authenticated;
comment on function coinops.dashboard_live_engine_reads(uuid,uuid[]) is
  'Bounded read-only UI projection; invoker RLS; no cached state, financial writes or executor work.';
