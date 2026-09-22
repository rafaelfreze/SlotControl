-- Fictitious Binance Spot Testnet ledger. It never references Production
-- exchange connections and never changes the active Shadow robot.
create table coinops.robot_v1_testnet_runs (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  asset text not null check (asset = 'SOL'),
  symbol text not null check (symbol = 'SOLUSDC'),
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'PAUSED', 'COMPLETED')),
  anchor_price numeric(24, 8) not null check (anchor_price > 0),
  slot_notional_usdc numeric(20, 8) not null check (slot_notional_usdc > 0),
  gain_rate numeric(12, 8) not null check (gain_rate > 0 and gain_rate < 1),
  entry_spacing numeric(12, 8) not null check (entry_spacing > 0 and entry_spacing < 1),
  last_reconciled_at timestamptz,
  last_error text,
  lease_owner uuid,
  lease_until timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (id, product_id, tenant_id, user_id),
  foreign key (product_id, tenant_id) references public.product_tenants(product_id, tenant_id) on delete restrict
);
create unique index robot_v1_testnet_one_active_run on coinops.robot_v1_testnet_runs(product_id, tenant_id, user_id, asset)
  where status in ('ACTIVE', 'PAUSED');

create table coinops.robot_v1_testnet_slots (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  slot_number integer not null check (slot_number between 1 and 25),
  entry_state text not null default 'PLANNED' check (entry_state in ('PLANNED', 'ARMED', 'OPEN', 'CLOSED', 'MISSED')),
  target_buy_price numeric(24, 8) not null check (target_buy_price > 0),
  balance_usdc numeric(20, 8) not null check (balance_usdc > 0),
  gain_count integer not null default 0 check (gain_count >= 0),
  net_profit_usdc numeric(20, 8) not null default 0,
  missed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (run_id, slot_number),
  unique (id, run_id, product_id, tenant_id, user_id),
  foreign key (run_id, product_id, tenant_id, user_id)
    references coinops.robot_v1_testnet_runs(id, product_id, tenant_id, user_id) on delete restrict
);
create unique index robot_v1_testnet_one_armed_slot on coinops.robot_v1_testnet_slots(run_id) where entry_state = 'ARMED';

create table coinops.robot_v1_testnet_orders (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,
  slot_id uuid not null,
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  slot_number integer not null check (slot_number between 1 and 25),
  side text not null check (side in ('BUY', 'SELL')),
  purpose text not null check (purpose in ('INITIAL', 'ENTRY', 'TP')),
  revision integer not null default 1 check (revision > 0),
  client_order_id text not null unique check (client_order_id ~ '^COV1-SOL-[0-9]+(-[0-9]+)?-(BUY|SELL)-[a-f0-9]{18}$'),
  exchange_order_id text,
  status text not null default 'PREPARED' check (status in ('PREPARED', 'NEW', 'PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'EXPIRED', 'REJECTED')),
  requested_quantity numeric(28, 12),
  requested_quote numeric(20, 8),
  price numeric(24, 8),
  executed_quantity numeric(28, 12) not null default 0 check (executed_quantity >= 0),
  cumulative_quote numeric(28, 12) not null default 0 check (cumulative_quote >= 0),
  fee_base numeric(28, 12) not null default 0 check (fee_base >= 0),
  fee_quote numeric(28, 12) not null default 0 check (fee_quote >= 0),
  fee_other jsonb not null default '[]'::jsonb check (jsonb_typeof(fee_other) = 'array'),
  trades_reconciled boolean not null default false,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (run_id, slot_number, side, revision),
  foreign key (run_id, product_id, tenant_id, user_id)
    references coinops.robot_v1_testnet_runs(id, product_id, tenant_id, user_id) on delete restrict,
  foreign key (slot_id, run_id, product_id, tenant_id, user_id)
    references coinops.robot_v1_testnet_slots(id, run_id, product_id, tenant_id, user_id) on delete restrict
);
create unique index robot_v1_testnet_one_active_buy on coinops.robot_v1_testnet_orders(run_id)
  where side = 'BUY' and status in ('PREPARED', 'NEW', 'PARTIALLY_FILLED');
create index robot_v1_testnet_orders_run_slot on coinops.robot_v1_testnet_orders(run_id, slot_number, created_at);

create table coinops.robot_v1_testnet_events (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  event_key text not null,
  event_type text not null,
  slot_number integer check (slot_number between 1 and 25),
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  observed_at timestamptz not null default timezone('utc', now()),
  unique (run_id, event_key),
  foreign key (run_id, product_id, tenant_id, user_id)
    references coinops.robot_v1_testnet_runs(id, product_id, tenant_id, user_id) on delete restrict
);
create index robot_v1_testnet_events_run_time on coinops.robot_v1_testnet_events(run_id, observed_at desc);

create trigger robot_v1_testnet_runs_touch_updated_at before update on coinops.robot_v1_testnet_runs
  for each row execute function private.coinops_touch_updated_at();
create trigger robot_v1_testnet_slots_touch_updated_at before update on coinops.robot_v1_testnet_slots
  for each row execute function private.coinops_touch_updated_at();
create trigger robot_v1_testnet_orders_touch_updated_at before update on coinops.robot_v1_testnet_orders
  for each row execute function private.coinops_touch_updated_at();

alter table coinops.robot_v1_testnet_runs enable row level security;
alter table coinops.robot_v1_testnet_slots enable row level security;
alter table coinops.robot_v1_testnet_orders enable row level security;
alter table coinops.robot_v1_testnet_events enable row level security;
alter table coinops.robot_v1_testnet_runs force row level security;
alter table coinops.robot_v1_testnet_slots force row level security;
alter table coinops.robot_v1_testnet_orders force row level security;
alter table coinops.robot_v1_testnet_events force row level security;

create policy robot_v1_testnet_runs_owner_select on coinops.robot_v1_testnet_runs for select to authenticated
  using (private.coinops_can_access_row(product_id, tenant_id, user_id));
create policy robot_v1_testnet_slots_owner_select on coinops.robot_v1_testnet_slots for select to authenticated
  using (private.coinops_can_access_row(product_id, tenant_id, user_id));
create policy robot_v1_testnet_orders_owner_select on coinops.robot_v1_testnet_orders for select to authenticated
  using (private.coinops_can_access_row(product_id, tenant_id, user_id));
create policy robot_v1_testnet_events_owner_select on coinops.robot_v1_testnet_events for select to authenticated
  using (private.coinops_can_access_row(product_id, tenant_id, user_id));

revoke all on coinops.robot_v1_testnet_runs, coinops.robot_v1_testnet_slots, coinops.robot_v1_testnet_orders, coinops.robot_v1_testnet_events from public, anon, authenticated;
grant select on coinops.robot_v1_testnet_runs, coinops.robot_v1_testnet_slots, coinops.robot_v1_testnet_orders, coinops.robot_v1_testnet_events to authenticated, service_role;
grant insert, update on coinops.robot_v1_testnet_runs, coinops.robot_v1_testnet_slots, coinops.robot_v1_testnet_orders to service_role;
grant insert on coinops.robot_v1_testnet_events to service_role;
