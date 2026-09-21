-- CoinOps execution foundation. Phase 1 is intentionally SHADOW-only: this
-- schema cannot persist LIVE mode and carries no exchange credential material.

create table coinops.exchange_connections (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  exchange text not null check (exchange = 'BINANCE_SPOT'),
  connection_status text not null default 'NOT_CONNECTED'
    check (connection_status in ('NOT_CONNECTED','READ_ONLY','CONNECTED','ERROR')),
  credential_reference text,
  last_reconciled_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (product_id, tenant_id, user_id, exchange),
  unique (id, product_id, tenant_id, user_id),
  foreign key (product_id, tenant_id) references public.product_tenants(product_id, tenant_id) on delete restrict
);

create table coinops.execution_engine_settings (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  execution_mode text not null default 'SHADOW' check (execution_mode = 'SHADOW'),
  global_kill_switch boolean not null default true,
  max_order_notional_usdt numeric(20,8) not null default 0 check (max_order_notional_usdt >= 0),
  max_daily_notional_usdt numeric(20,8) not null default 0 check (max_daily_notional_usdt >= 0),
  max_market_age_seconds integer not null default 60 check (max_market_age_seconds between 1 and 3600),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (product_id, tenant_id, user_id),
  foreign key (product_id, tenant_id) references public.product_tenants(product_id, tenant_id) on delete restrict
);

create table coinops.execution_asset_settings (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  asset text not null check (asset in ('BTC','SOL')),
  automation_enabled boolean not null default false,
  kill_switch boolean not null default true,
  max_order_notional_usdt numeric(20,8) check (max_order_notional_usdt is null or max_order_notional_usdt >= 0),
  max_daily_notional_usdt numeric(20,8) check (max_daily_notional_usdt is null or max_daily_notional_usdt >= 0),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (product_id, tenant_id, user_id, asset),
  foreign key (product_id, tenant_id) references public.product_tenants(product_id, tenant_id) on delete restrict
);

create table coinops.exchange_order_intents (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  strategy_id uuid not null,
  slot_id uuid not null,
  cycle_id uuid,
  exchange text not null default 'BINANCE_SPOT' check (exchange = 'BINANCE_SPOT'),
  execution_mode text not null default 'SHADOW' check (execution_mode = 'SHADOW'),
  asset text not null check (asset in ('BTC','SOL')),
  symbol text not null check (symbol in ('BTCUSDT','SOLUSDT')),
  side text not null check (side in ('BUY','SELL')),
  quantity numeric(28,12) not null check (quantity > 0),
  expected_notional_usdt numeric(20,8) not null check (expected_notional_usdt > 0),
  reference_price numeric(24,8) not null check (reference_price > 0),
  target_price numeric(24,8),
  observed_market_price numeric(24,8) not null check (observed_market_price > 0),
  observed_at timestamptz not null,
  strategy_reason text not null,
  strategy_regime text,
  status text not null default 'SHADOW_RECORDED'
    check (status in ('SHADOW_RECORDED','BLOCKED','RECONCILIATION_REQUIRED','FAILED','CANCELLED')),
  idempotency_key text not null check (idempotency_key ~ '^[0-9a-f]{64}$'),
  exchange_order_id text,
  execution_payload jsonb not null default '{}'::jsonb check (jsonb_typeof(execution_payload) = 'object'),
  last_error_code text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (product_id, tenant_id, user_id, idempotency_key),
  unique (id, product_id, tenant_id, user_id),
  foreign key (product_id, tenant_id) references public.product_tenants(product_id, tenant_id) on delete restrict,
  foreign key (product_id, tenant_id, user_id, strategy_id)
    references coinops.strategies(product_id, tenant_id, user_id, id) on delete restrict,
  foreign key (product_id, tenant_id, user_id, slot_id)
    references coinops.slots(product_id, tenant_id, user_id, id) on delete restrict,
  foreign key (cycle_id) references coinops.operational_cycles(id) on delete restrict,
  check ((asset = 'BTC' and symbol = 'BTCUSDT') or (asset = 'SOL' and symbol = 'SOLUSDT')),
  check (exchange_order_id is null)
);

create index exchange_order_intents_scope_created_idx
  on coinops.exchange_order_intents(product_id, tenant_id, user_id, created_at desc);
create index exchange_order_intents_scope_status_idx
  on coinops.exchange_order_intents(product_id, tenant_id, user_id, status, created_at desc);

create trigger exchange_connections_touch_updated_at
before update on coinops.exchange_connections
for each row execute function private.coinops_touch_updated_at();

create trigger execution_engine_settings_touch_updated_at
before update on coinops.execution_engine_settings
for each row execute function private.coinops_touch_updated_at();

create trigger execution_asset_settings_touch_updated_at
before update on coinops.execution_asset_settings
for each row execute function private.coinops_touch_updated_at();

create trigger exchange_order_intents_touch_updated_at
before update on coinops.exchange_order_intents
for each row execute function private.coinops_touch_updated_at();

alter table coinops.exchange_connections enable row level security;
alter table coinops.exchange_connections force row level security;
alter table coinops.execution_engine_settings enable row level security;
alter table coinops.execution_engine_settings force row level security;
alter table coinops.execution_asset_settings enable row level security;
alter table coinops.execution_asset_settings force row level security;
alter table coinops.exchange_order_intents enable row level security;
alter table coinops.exchange_order_intents force row level security;

create policy exchange_connections_owner_select on coinops.exchange_connections
  for select to authenticated using (private.coinops_can_access_row(product_id, tenant_id, user_id));
create policy execution_engine_settings_owner_select on coinops.execution_engine_settings
  for select to authenticated using (private.coinops_can_access_row(product_id, tenant_id, user_id));
create policy execution_asset_settings_owner_select on coinops.execution_asset_settings
  for select to authenticated using (private.coinops_can_access_row(product_id, tenant_id, user_id));
create policy exchange_order_intents_owner_select on coinops.exchange_order_intents
  for select to authenticated using (private.coinops_can_access_row(product_id, tenant_id, user_id));

revoke all on table coinops.exchange_connections, coinops.execution_engine_settings,
  coinops.execution_asset_settings, coinops.exchange_order_intents
  from public, anon, authenticated;
grant select on table coinops.exchange_connections, coinops.execution_engine_settings,
  coinops.execution_asset_settings, coinops.exchange_order_intents to authenticated, service_role;
grant insert on table coinops.exchange_order_intents to service_role;

comment on table coinops.exchange_connections is
  'Metadata-only exchange connection record. Phase 1 stores no Binance key, secret, password, 2FA, seed or withdrawal capability.';
comment on table coinops.execution_engine_settings is
  'Fail-closed global execution controls. Database accepts SHADOW only in Phase 1.';
comment on table coinops.execution_asset_settings is
  'Per-asset fail-closed controls. BTC and SOL automation default to disabled with their kill switches active.';
comment on table coinops.exchange_order_intents is
  'Immutable logical strategy intents in SHADOW mode. They are never Binance orders and cannot contain an exchange order id in Phase 1.';
