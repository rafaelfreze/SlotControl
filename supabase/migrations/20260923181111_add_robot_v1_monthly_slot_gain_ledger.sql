-- Fase 4.2: one immutable monthly fact per confirmed, credited physical-slot gain.
-- No existing balance, order, slot state, or historical event is rewritten.
alter table coinops.robot_v1_audit_events drop constraint robot_v1_audit_events_event_type_check;
alter table coinops.robot_v1_audit_events add constraint robot_v1_audit_events_event_type_check check (event_type in (
  'CAPITAL_CHANGED', 'CAPITAL_NEXT_CYCLE', 'PARAMETERS_NEXT_CYCLE',
  'SHADOW_STARTED', 'PAUSED', 'RESUMED', 'KILL_SWITCH_ENABLED', 'KILL_SWITCH_DISABLED',
  'CYCLE_STARTED', 'CYCLE_COMPLETED', 'CYCLE_RESTARTED', 'INITIAL_POSITION_OPENED',
  'SLOT_RECYCLED', 'SLOT_REENTRY_PLANNED', 'SLOT_REENTRY_ARMED', 'SHADOW_STATE_REPAIRED',
  'GRID_INVALID', 'RESET_ALLOWED', 'BUY_TRIGGERED', 'TP_TRIGGERED',
  'SLOT_PROFIT_CREDITED', 'SLOT_BALANCE_UPDATED', 'NEXT_BUY_ARMED', 'NEXT_BUY_DISARMED',
  'MISSED_LEVEL_DURING_REARM', 'INTRABAR_AMBIGUOUS', 'DATA_GAP',
  'MONTHLY_TARGET_HOLD', 'SHADOW_TICK_DRIFT_REPAIRED', 'SHADOW_GRID_AUTO_RESUMED'
));
create table coinops.robot_v1_monthly_slot_gains (
  environment text not null check (environment in ('SHADOW', 'TESTNET')),
  source_id uuid not null,
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  asset text not null check (asset in ('BTC', 'SOL')),
  slot_number integer not null check (slot_number between 1 and 25),
  physical_slot_id text not null,
  credited_at timestamptz not null,
  effective_gain_at timestamptz not null,
  evidence_basis text not null check (evidence_basis in ('SHADOW_CONFIRMED_TP_CLOSE', 'TESTNET_EXCHANGE_FILL', 'TESTNET_CREDIT_FALLBACK')),
  period_key text not null check (period_key ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  timezone text not null default 'America/Campo_Grande' check (timezone = 'America/Campo_Grande'),
  created_at timestamptz not null default now(),
  primary key (environment, source_id),
  foreign key (product_id, tenant_id) references public.product_tenants(product_id, tenant_id) on delete restrict
);
create index robot_v1_monthly_slot_gains_scope_period_idx
  on coinops.robot_v1_monthly_slot_gains(product_id, tenant_id, user_id, environment, asset, period_key, slot_number);
create index robot_v1_monthly_slot_gains_physical_idx
  on coinops.robot_v1_monthly_slot_gains(product_id, tenant_id, user_id, physical_slot_id, credited_at);

alter table coinops.robot_v1_monthly_slot_gains enable row level security;
alter table coinops.robot_v1_monthly_slot_gains force row level security;
create policy robot_v1_monthly_slot_gains_owner_select on coinops.robot_v1_monthly_slot_gains
  for select to authenticated using (private.coinops_can_access_row(product_id, tenant_id, user_id));
revoke all on coinops.robot_v1_monthly_slot_gains from public, anon, authenticated;
grant select on coinops.robot_v1_monthly_slot_gains to authenticated, service_role;
grant insert on coinops.robot_v1_monthly_slot_gains to service_role;

create function coinops.record_robot_v1_shadow_monthly_gain()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  v_config coinops.robot_v1_configs%rowtype;
  v_operation coinops.robot_v1_slot_operations%rowtype;
begin
  select * into strict v_config from coinops.robot_v1_configs where id = new.config_id;
  select * into strict v_operation from coinops.robot_v1_slot_operations where id = new.operation_id;
  if v_config.execution_mode <> 'SHADOW'
    or (new.product_id, new.tenant_id, new.user_id) is distinct from
       (v_config.product_id, v_config.tenant_id, v_config.user_id)
    or (v_operation.product_id, v_operation.tenant_id, v_operation.user_id) is distinct from
       (new.product_id, new.tenant_id, new.user_id)
    or v_operation.slot_id is null or v_operation.physical_slot_number <> new.slot_number
    or not exists (select 1 from coinops.robot_v1_cycles cycle
      where cycle.id = v_operation.cycle_id and cycle.config_id = new.config_id)
    or v_operation.closed_at is null then
    raise exception 'COINOPS_MONTHLY_SHADOW_SCOPE_INVALID';
  end if;
  insert into coinops.robot_v1_monthly_slot_gains
    (environment, source_id, product_id, tenant_id, user_id, asset, slot_number,
     physical_slot_id, credited_at, effective_gain_at, evidence_basis, period_key)
  values ('SHADOW', new.operation_id, new.product_id, new.tenant_id, new.user_id,
    v_config.asset, new.slot_number, 'SHADOW:' || new.config_id::text || ':' || new.slot_number::text,
    new.credited_at, v_operation.closed_at, 'SHADOW_CONFIRMED_TP_CLOSE',
    to_char(v_operation.closed_at at time zone 'America/Campo_Grande', 'YYYY-MM'))
  on conflict (environment, source_id) do nothing;
  return new;
end $$;
revoke all on function coinops.record_robot_v1_shadow_monthly_gain() from public, anon, authenticated;
grant execute on function coinops.record_robot_v1_shadow_monthly_gain() to service_role;
create trigger robot_v1_shadow_monthly_gain
  after insert on coinops.robot_v1_slot_profit_credits for each row
  execute function coinops.record_robot_v1_shadow_monthly_gain();

create function coinops.record_robot_v1_testnet_monthly_gain()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  v_run coinops.robot_v1_testnet_runs%rowtype;
  v_slot coinops.robot_v1_testnet_slots%rowtype;
  v_sequence integer;
  v_terminal coinops.robot_v1_testnet_orders%rowtype;
  v_fill_at timestamptz;
begin
  if new.event_type <> 'SLOT_CLOSED' then return new; end if;
  if new.details ? 'profitUsdc' and (new.details->>'profitUsdc')::numeric <= 0 then return new; end if;
  if not (new.details ? 'profitUsdc') or (new.details->>'profitUsdc')::numeric is null then
    raise exception 'COINOPS_MONTHLY_TESTNET_GAIN_UNKNOWN';
  end if;
  v_sequence := (new.details->>'operationSequence')::integer;
  select * into strict v_run from coinops.robot_v1_testnet_runs where id = new.run_id;
  select * into strict v_slot from coinops.robot_v1_testnet_slots
    where run_id = new.run_id and slot_number = new.slot_number;
  select * into v_terminal from coinops.robot_v1_testnet_orders o
    where o.run_id = new.run_id and o.slot_id = v_slot.id and o.operation_sequence = v_sequence
      and o.side = 'SELL' and o.purpose = 'TP' and o.status = 'FILLED'
    order by o.revision desc limit 1;
  if v_sequence is null or v_sequence < 1
    or (new.product_id, new.tenant_id, new.user_id) is distinct from
       (v_run.product_id, v_run.tenant_id, v_run.user_id)
    or (v_slot.product_id, v_slot.tenant_id, v_slot.user_id) is distinct from
       (v_run.product_id, v_run.tenant_id, v_run.user_id)
    or (new.details->>'gainCount')::integer <> v_slot.gain_count + 1
    or v_terminal.id is null then
    raise exception 'COINOPS_MONTHLY_TESTNET_GAIN_EVIDENCE_INVALID';
  end if;
  select (f.details->>'filledAt')::timestamptz into v_fill_at
  from coinops.robot_v1_testnet_events f where f.run_id = new.run_id
    and f.event_type = 'TESTNET_FILL_OBSERVED'
    and f.details->>'clientOrderId' = v_terminal.client_order_id
    and f.details->>'filledAt' is not null
  order by f.observed_at desc limit 1;
  insert into coinops.robot_v1_monthly_slot_gains
    (environment, source_id, product_id, tenant_id, user_id, asset, slot_number,
     physical_slot_id, credited_at, effective_gain_at, evidence_basis, period_key)
  values ('TESTNET', new.id, new.product_id, new.tenant_id, new.user_id,
    v_run.asset, new.slot_number,
    'TESTNET:' || new.product_id::text || ':' || new.tenant_id::text || ':' || new.user_id::text || ':' || v_run.asset || ':' || new.slot_number::text,
    new.observed_at, coalesce(v_fill_at, new.observed_at),
    case when v_fill_at is null then 'TESTNET_CREDIT_FALLBACK' else 'TESTNET_EXCHANGE_FILL' end,
    to_char(coalesce(v_fill_at, new.observed_at) at time zone 'America/Campo_Grande', 'YYYY-MM'))
  on conflict (environment, source_id) do nothing;
  return new;
end $$;
revoke all on function coinops.record_robot_v1_testnet_monthly_gain() from public, anon, authenticated;
grant execute on function coinops.record_robot_v1_testnet_monthly_gain() to service_role;
create trigger robot_v1_testnet_monthly_gain
  after insert on coinops.robot_v1_testnet_events for each row
  execute function coinops.record_robot_v1_testnet_monthly_gain();

-- Backfill only facts whose original credit/TP and scoped owner are persisted.
insert into coinops.robot_v1_monthly_slot_gains
  (environment, source_id, product_id, tenant_id, user_id, asset, slot_number,
   physical_slot_id, credited_at, effective_gain_at, evidence_basis, period_key)
select 'SHADOW', credit.operation_id, credit.product_id, credit.tenant_id, credit.user_id,
  config.asset, credit.slot_number,
  'SHADOW:' || credit.config_id::text || ':' || credit.slot_number::text,
  credit.credited_at, operation.closed_at, 'SHADOW_CONFIRMED_TP_CLOSE',
  to_char(operation.closed_at at time zone 'America/Campo_Grande', 'YYYY-MM')
from coinops.robot_v1_slot_profit_credits credit
join coinops.robot_v1_configs config on config.id = credit.config_id
 and (config.product_id, config.tenant_id, config.user_id) =
     (credit.product_id, credit.tenant_id, credit.user_id)
join coinops.robot_v1_slot_operations operation on operation.id = credit.operation_id
 and operation.physical_slot_number = credit.slot_number and operation.closed_at is not null
where config.execution_mode = 'SHADOW'
on conflict (environment, source_id) do nothing;

insert into coinops.robot_v1_monthly_slot_gains
  (environment, source_id, product_id, tenant_id, user_id, asset, slot_number,
   physical_slot_id, credited_at, effective_gain_at, evidence_basis, period_key)
select 'TESTNET', event.id, event.product_id, event.tenant_id, event.user_id,
  run.asset, event.slot_number,
  'TESTNET:' || event.product_id::text || ':' || event.tenant_id::text || ':' || event.user_id::text || ':' || run.asset || ':' || event.slot_number::text,
  event.observed_at, coalesce(fill.filled_at, event.observed_at),
  case when fill.filled_at is null then 'TESTNET_CREDIT_FALLBACK' else 'TESTNET_EXCHANGE_FILL' end,
  to_char(coalesce(fill.filled_at, event.observed_at) at time zone 'America/Campo_Grande', 'YYYY-MM')
from coinops.robot_v1_testnet_events event
join coinops.robot_v1_testnet_runs run on run.id = event.run_id
 and (run.product_id, run.tenant_id, run.user_id) =
     (event.product_id, event.tenant_id, event.user_id)
join coinops.robot_v1_testnet_slots slot on slot.run_id = event.run_id and slot.slot_number = event.slot_number
 and (slot.product_id, slot.tenant_id, slot.user_id) =
     (event.product_id, event.tenant_id, event.user_id)
left join lateral (
  select (f.details->>'filledAt')::timestamptz as filled_at
  from coinops.robot_v1_testnet_orders sell
  join coinops.robot_v1_testnet_events f on f.run_id = sell.run_id
    and f.event_type = 'TESTNET_FILL_OBSERVED'
    and f.details->>'clientOrderId' = sell.client_order_id
    and f.details->>'filledAt' is not null
  where sell.run_id = event.run_id and sell.slot_id = slot.id
    and sell.side = 'SELL' and sell.purpose = 'TP' and sell.status = 'FILLED'
    and (event.details->>'operationSequence' is null
      or sell.operation_sequence = (event.details->>'operationSequence')::integer)
  order by sell.revision desc, f.observed_at desc limit 1
) fill on true
where event.event_type = 'SLOT_CLOSED' and (event.details->>'profitUsdc')::numeric > 0
  and exists (select 1 from coinops.robot_v1_testnet_orders sell
    where sell.run_id = event.run_id and sell.slot_id = slot.id
      and sell.side = 'SELL' and sell.purpose = 'TP' and sell.status = 'FILLED'
      and (event.details->>'operationSequence' is null
        or sell.operation_sequence = (event.details->>'operationSequence')::integer))
on conflict (environment, source_id) do nothing;

-- One bounded row per physical slot for the live engines and UI. SECURITY
-- INVOKER keeps the underlying ledger's owner policy in force for readers.
create view coinops.robot_v1_slot_gain_totals with (security_invoker = true) as
select product_id, tenant_id, user_id, environment, asset, slot_number, physical_slot_id,
  count(*)::integer as lifetime_gain_count,
  count(*) filter (where period_key = to_char(now() at time zone 'America/Campo_Grande', 'YYYY-MM'))::integer as monthly_gain_count,
  to_char(now() at time zone 'America/Campo_Grande', 'YYYY-MM') as period_key,
  'America/Campo_Grande'::text as timezone
from coinops.robot_v1_monthly_slot_gains
group by product_id, tenant_id, user_id, environment, asset, slot_number, physical_slot_id;
revoke all on coinops.robot_v1_slot_gain_totals from public, anon, authenticated;
grant select on coinops.robot_v1_slot_gain_totals to authenticated, service_role;

-- A fresh Testnet run has no exchange order yet. Assign the immutable physical
-- identities to grid prices by lifetime rank once, atomically, before MARKET.
-- Active-run prices and all reentry references are never rewritten here.
create function coinops.rank_robot_v1_testnet_fresh_cycle(p_run_id uuid, p_price_tick numeric)
returns void language plpgsql security definer set search_path = '' as $$
declare v_run coinops.robot_v1_testnet_runs%rowtype;
begin
  if coalesce(nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(auth.jwt() ->> 'role', ''), '') <> 'service_role' then
    raise exception 'COINOPS_TESTNET_SERVICE_ROLE_REQUIRED';
  end if;
  if p_price_tick <= 0 then raise exception 'COINOPS_TESTNET_PRICE_TICK_INVALID'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_run_id::text, 0));
  select * into strict v_run from coinops.robot_v1_testnet_runs where id = p_run_id for update;
  if v_run.status <> 'ACTIVE'
    or (select count(*) from coinops.robot_v1_testnet_slots where run_id = p_run_id) <> 25
    or exists (select 1 from coinops.robot_v1_testnet_orders where run_id = p_run_id)
    or exists (select 1 from coinops.robot_v1_testnet_slots where run_id = p_run_id
      and (entry_state <> 'PLANNED' or operation_sequence <> 1
        or target_buy_price <= 0 or target_buy_price / p_price_tick <> trunc(target_buy_price / p_price_tick))) then
    raise exception 'COINOPS_TESTNET_FRESH_CYCLE_REQUIRED';
  end if;
  with scored as (
    select slot.id, slot.slot_number,
      count(gain.source_id)::integer as lifetime_gains,
      count(gain.source_id) filter (where gain.period_key =
        to_char(now() at time zone 'America/Campo_Grande', 'YYYY-MM'))::integer as monthly_gains
    from coinops.robot_v1_testnet_slots slot
    left join coinops.robot_v1_monthly_slot_gains gain
      on gain.product_id = slot.product_id and gain.tenant_id = slot.tenant_id
      and gain.user_id = slot.user_id and gain.environment = 'TESTNET'
      and gain.asset = v_run.asset and gain.slot_number = slot.slot_number
    where slot.run_id = p_run_id
    group by slot.id, slot.slot_number
  ), ranked as (
    select id, row_number() over (order by
      (monthly_gains >= case when v_run.asset = 'BTC' then 7 else 2 end),
      lifetime_gains desc, slot_number)::integer as operational_rank from scored
  ), priced as (
    -- Reuse the exact, already persisted exchange-filtered ladder. Rebuilding
    -- it with SQL POWER could round a level differently from the TS adapter.
    select ranked.id, grid.target_buy_price as price from ranked
    join coinops.robot_v1_testnet_slots grid on grid.run_id = p_run_id
      and grid.slot_number = ranked.operational_rank
  )
  update coinops.robot_v1_testnet_slots slot set
    target_buy_price = priced.price, entry_reference_price = priced.price
  from priced where slot.id = priced.id;
end $$;
revoke all on function coinops.rank_robot_v1_testnet_fresh_cycle(uuid, numeric) from public, anon, authenticated;
grant execute on function coinops.rank_robot_v1_testnet_fresh_cycle(uuid, numeric) to service_role;

comment on table coinops.robot_v1_monthly_slot_gains is
  'Immutable, owner-scoped gain facts by physical slot and Campo Grande calendar month; source credit/event remains authoritative.';
