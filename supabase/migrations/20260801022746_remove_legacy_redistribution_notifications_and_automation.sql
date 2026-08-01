-- Apply after the application deployment that reads the programmed-growth schema.
-- This removes only legacy feature data and infrastructure; history_events is preserved.

do $cleanup$
declare
  legacy_function regprocedure;
begin
  for legacy_function in
    select p.oid::regprocedure
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = any (array[
        'sync_gains_distribuidos_on_real_gain_change',
        'slot_gain_redistribution_preview_for_user',
        'preview_slot_gain_redistribution',
        'confirm_slot_gain_redistribution',
        'undo_last_slot_gain_redistribution',
        'is_closed_slot_status',
        'is_open_slot_status',
        'set_push_notification_updated_at',
        'enqueue_slot_notification_from_history',
        'queue_push_test_notification',
        'claim_notification_outbox',
        'claim_automation_asset_cursor',
        'complete_automation_asset_cursor',
        'execute_slot_automation_decision',
        'apply_operational_profit_on_real_gain'
      ])
  loop
    execute format('drop function if exists %s cascade', legacy_function);
  end loop;
end;
$cleanup$;

drop table if exists public.notification_deliveries cascade;
drop table if exists public.notification_outbox cascade;
drop table if exists public.notification_preferences cascade;
drop table if exists public.push_subscriptions cascade;
drop table if exists public.automation_decisions cascade;
drop table if exists public.automation_price_windows cascade;
drop table if exists public.automation_market_cursors cascade;
drop table if exists public.automation_worker_runs cascade;
drop table if exists public.slot_gain_redistributions cascade;

alter table public.strategies drop column if exists redistribution_target;
alter table public.slots drop column if exists gains_distribuidos;
alter table public.slots drop column if exists operational_slot_value;
alter table public.slots drop column if exists reinvested_profit;
alter table public.slots
  add column operational_slot_value numeric(18, 8)
  generated always as (round((base_value + realized_profit + growth_contribution), 8)) stored;

update public.user_settings
set settings = settings - 'automationMode' - 'autoGainEnabled'
where settings ?| array['automationMode', 'autoGainEnabled'];
