-- Physical V1 slots remain a 25-slot active grid. Closed Shadow operations
-- are archived independently so recycled slots never erase their history.

alter table coinops.robot_v1_slots
  add column operation_sequence integer not null default 1 check (operation_sequence > 0);

create table coinops.robot_v1_slot_operations (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  cycle_id uuid not null references coinops.robot_v1_cycles(id) on delete restrict,
  slot_id uuid not null references coinops.robot_v1_slots(id) on delete restrict,
  operation_sequence integer not null check (operation_sequence > 0),
  symbol text not null check (symbol in ('BTCUSDC','SOLUSDC')),
  entry_price numeric(24,8) not null check (entry_price > 0),
  executed_quantity numeric(28,12) not null check (executed_quantity > 0),
  take_profit_price numeric(24,8) not null check (take_profit_price > 0),
  buy_client_order_id text not null,
  sell_client_order_id text,
  opened_at timestamptz,
  closed_at timestamptz not null,
  gross_quote_pnl numeric(28,12) not null,
  estimated_quote_fees numeric(28,12) not null default 0 check (estimated_quote_fees >= 0),
  net_quote_pnl numeric(28,12) not null,
  created_at timestamptz not null default timezone('utc', now()),
  unique (slot_id, operation_sequence),
  foreign key (product_id, tenant_id) references public.product_tenants(product_id, tenant_id) on delete restrict
);

insert into coinops.robot_v1_slot_operations (
  product_id, tenant_id, user_id, cycle_id, slot_id, operation_sequence, symbol,
  entry_price, executed_quantity, take_profit_price, buy_client_order_id,
  sell_client_order_id, opened_at, closed_at, gross_quote_pnl,
  estimated_quote_fees, net_quote_pnl
)
select
  product_id, tenant_id, user_id, cycle_id, id, operation_sequence, symbol,
  average_fill_price, executed_quantity, take_profit_price, buy_client_order_id,
  sell_client_order_id, buy_triggered_at, coalesce(tp_triggered_at, observed_at),
  coalesce(realized_quote_pnl, 0), sell_fee, coalesce(realized_quote_pnl, 0)
from coinops.robot_v1_slots
where status = 'CLOSED'
  and average_fill_price is not null
  and take_profit_price is not null
  and executed_quantity > 0
on conflict (slot_id, operation_sequence) do nothing;

alter table coinops.robot_v1_slot_operations enable row level security;
alter table coinops.robot_v1_slot_operations force row level security;
create policy robot_v1_slot_operations_owner_select on coinops.robot_v1_slot_operations
  for select to authenticated using (private.coinops_can_access_row(product_id, tenant_id, user_id));
revoke all on coinops.robot_v1_slot_operations from public, anon, authenticated;
grant select on coinops.robot_v1_slot_operations to authenticated, service_role;
grant insert on coinops.robot_v1_slot_operations to service_role;

alter table coinops.robot_v1_audit_events
  drop constraint robot_v1_audit_events_event_type_check,
  add constraint robot_v1_audit_events_event_type_check check (event_type in (
    'CAPITAL_CHANGED', 'CAPITAL_NEXT_CYCLE', 'PARAMETERS_NEXT_CYCLE',
    'SHADOW_STARTED', 'PAUSED', 'RESUMED', 'KILL_SWITCH_ENABLED', 'KILL_SWITCH_DISABLED',
    'CYCLE_STARTED', 'CYCLE_COMPLETED', 'CYCLE_RESTARTED', 'INITIAL_POSITION_OPENED',
    'SLOT_RECYCLED', 'RESET_ALLOWED', 'BUY_TRIGGERED', 'TP_TRIGGERED',
    'INTRABAR_AMBIGUOUS', 'DATA_GAP'
  ));

comment on table coinops.robot_v1_slot_operations is 'Immutable terminal V1 Shadow operation history. Recycled physical slots receive a new operation_sequence and new logical client IDs; no exchange order is created.';
