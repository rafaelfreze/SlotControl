-- CoinOps Robot V1 is isolated from the manual BTCUSDT/SOLUSDT strategy.
-- Production Binance remains read-only; these records only model SHADOW/Testnet state.

create table coinops.robot_v1_configs (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  asset text not null check (asset in ('BTC','SOL')),
  symbol text not null check ((asset = 'BTC' and symbol = 'BTCUSDC') or (asset = 'SOL' and symbol = 'SOLUSDC')),
  execution_mode text not null default 'SHADOW' check (execution_mode in ('SHADOW','TESTNET')),
  capital_usdc numeric(20,8) not null check (capital_usdc > 0),
  slot_count integer not null default 25 check (slot_count = 25),
  kill_switch boolean not null default true,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (product_id, tenant_id, user_id, asset),
  foreign key (product_id, tenant_id) references public.product_tenants(product_id, tenant_id) on delete restrict
);

create table coinops.robot_v1_cycles (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  config_id uuid not null references coinops.robot_v1_configs(id) on delete restrict,
  asset text not null check (asset in ('BTC','SOL')),
  symbol text not null check ((asset = 'BTC' and symbol = 'BTCUSDC') or (asset = 'SOL' and symbol = 'SOLUSDC')),
  execution_mode text not null check (execution_mode in ('SHADOW','TESTNET')),
  status text not null check (status in ('IDLE','STARTING','GRID_ACTIVE','POSITIONS_ACTIVE','CYCLE_COMPLETE','RESETTING','FAILED')),
  anchor_price numeric(24,8) not null check (anchor_price > 0),
  slot_notional_usdc numeric(20,8) not null check (slot_notional_usdc > 0),
  capital_usdc numeric(20,8) not null check (capital_usdc > 0),
  started_at timestamptz not null default timezone('utc', now()),
  completed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  foreign key (product_id, tenant_id) references public.product_tenants(product_id, tenant_id) on delete restrict
);
create unique index robot_v1_one_active_cycle_per_asset_idx on coinops.robot_v1_cycles(product_id, tenant_id, user_id, asset)
  where status in ('STARTING','GRID_ACTIVE','POSITIONS_ACTIVE','RESETTING');

create table coinops.robot_v1_slots (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  cycle_id uuid not null references coinops.robot_v1_cycles(id) on delete cascade,
  slot_number integer not null check (slot_number between 1 and 25),
  symbol text not null check (symbol in ('BTCUSDC','SOLUSDC')),
  buy_price numeric(24,8) not null check (buy_price > 0),
  requested_quantity numeric(28,12) not null check (requested_quantity > 0),
  executed_quantity numeric(28,12) not null default 0 check (executed_quantity >= 0 and executed_quantity <= requested_quantity),
  average_fill_price numeric(24,8),
  buy_status text not null default 'PENDING' check (buy_status in ('PENDING','PARTIALLY_FILLED','FILLED','CANCELLED')),
  take_profit_price numeric(24,8),
  take_profit_status text not null default 'NONE' check (take_profit_status in ('NONE','PENDING','PARTIALLY_FILLED','FILLED','CANCELLED')),
  status text not null default 'PENDING' check (status in ('PENDING','PARTIALLY_FILLED','OPEN','TP_ACTIVE','CLOSED')),
  buy_client_order_id text not null,
  sell_client_order_id text,
  buy_exchange_order_id text,
  sell_exchange_order_id text,
  buy_fee numeric(28,12) not null default 0 check (buy_fee >= 0),
  sell_fee numeric(28,12) not null default 0 check (sell_fee >= 0),
  realized_quote_pnl numeric(28,12),
  idempotency_key text not null check (idempotency_key ~ '^[0-9a-f]{64}$'),
  observed_at timestamptz not null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (cycle_id, slot_number),
  unique (product_id, tenant_id, user_id, idempotency_key),
  unique (buy_client_order_id),
  unique (sell_client_order_id),
  foreign key (product_id, tenant_id) references public.product_tenants(product_id, tenant_id) on delete restrict
);
create index robot_v1_slots_cycle_status_idx on coinops.robot_v1_slots(cycle_id, status, slot_number);

create trigger robot_v1_configs_touch_updated_at before update on coinops.robot_v1_configs for each row execute function private.coinops_touch_updated_at();
create trigger robot_v1_cycles_touch_updated_at before update on coinops.robot_v1_cycles for each row execute function private.coinops_touch_updated_at();
create trigger robot_v1_slots_touch_updated_at before update on coinops.robot_v1_slots for each row execute function private.coinops_touch_updated_at();

alter table coinops.robot_v1_configs enable row level security;
alter table coinops.robot_v1_cycles enable row level security;
alter table coinops.robot_v1_slots enable row level security;
alter table coinops.robot_v1_configs force row level security;
alter table coinops.robot_v1_cycles force row level security;
alter table coinops.robot_v1_slots force row level security;

create policy robot_v1_configs_owner_select on coinops.robot_v1_configs for select to authenticated using (private.coinops_can_access_row(product_id, tenant_id, user_id));
create policy robot_v1_cycles_owner_select on coinops.robot_v1_cycles for select to authenticated using (private.coinops_can_access_row(product_id, tenant_id, user_id));
create policy robot_v1_slots_owner_select on coinops.robot_v1_slots for select to authenticated using (private.coinops_can_access_row(product_id, tenant_id, user_id));
revoke all on coinops.robot_v1_configs, coinops.robot_v1_cycles, coinops.robot_v1_slots from public, anon, authenticated;
grant select on coinops.robot_v1_configs, coinops.robot_v1_cycles, coinops.robot_v1_slots to authenticated, service_role;
grant insert, update on coinops.robot_v1_configs, coinops.robot_v1_cycles, coinops.robot_v1_slots to service_role;

comment on table coinops.robot_v1_configs is 'Robot V1 USDC-only configuration; execution accepts SHADOW or separate TESTNET only.';
comment on table coinops.robot_v1_cycles is 'Restart-safe V1 cycle ledger. LIVE and production-write modes cannot be persisted.';
comment on table coinops.robot_v1_slots is 'V1 owned grid slots. Client order IDs are deterministic and never identify BTCUSDT or SOLUSDT manual orders.';
