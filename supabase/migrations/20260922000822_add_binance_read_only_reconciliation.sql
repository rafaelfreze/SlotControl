-- CoinOps Phase 2: audited Binance Spot read-only reconciliation.
-- No credential, key material, live mode, exchange order id or write capability is persisted.

alter table coinops.exchange_connections
  add column if not exists api_key_masked text,
  add column if not exists last_synced_at timestamptz;

create table coinops.exchange_reconciliation_runs (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  connection_id uuid not null,
  execution_mode text not null default 'SHADOW' check (execution_mode = 'SHADOW'),
  status text not null check (status in ('RUNNING','COMPLETED','FAILED')),
  idempotency_key text not null check (idempotency_key ~ '^[0-9a-f]{64}$'),
  summary jsonb not null default '{}'::jsonb check (jsonb_typeof(summary) = 'object'),
  error_code text,
  started_at timestamptz not null default timezone('utc', now()),
  completed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (connection_id, idempotency_key),
  unique (id, product_id, tenant_id, user_id),
  foreign key (product_id, tenant_id) references public.product_tenants(product_id, tenant_id) on delete restrict,
  foreign key (connection_id, product_id, tenant_id, user_id)
    references coinops.exchange_connections(id, product_id, tenant_id, user_id) on delete restrict
);

create table coinops.exchange_reconciliation_items (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  classification text not null check (classification in ('MATCH','EXPECTED_ONLY','EXCHANGE_ONLY','QUANTITY_MISMATCH','PRICE_MISMATCH','STATUS_MISMATCH','UNKNOWN')),
  entity_type text not null check (entity_type in ('INTENT','ORDER','TRADE','BALANCE')),
  intent_id uuid,
  exchange_reference text,
  symbol text,
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  created_at timestamptz not null default timezone('utc', now()),
  foreign key (run_id, product_id, tenant_id, user_id)
    references coinops.exchange_reconciliation_runs(id, product_id, tenant_id, user_id) on delete cascade,
  foreign key (intent_id, product_id, tenant_id, user_id)
    references coinops.exchange_order_intents(id, product_id, tenant_id, user_id) on delete restrict
);

create index exchange_reconciliation_runs_scope_created_idx
  on coinops.exchange_reconciliation_runs(product_id, tenant_id, user_id, created_at desc);
create index exchange_reconciliation_items_run_idx
  on coinops.exchange_reconciliation_items(run_id, created_at asc);
create index exchange_reconciliation_items_scope_classification_idx
  on coinops.exchange_reconciliation_items(product_id, tenant_id, user_id, classification, created_at desc);

create trigger exchange_reconciliation_runs_touch_updated_at
before update on coinops.exchange_reconciliation_runs
for each row execute function private.coinops_touch_updated_at();

alter table coinops.exchange_reconciliation_runs enable row level security;
alter table coinops.exchange_reconciliation_runs force row level security;
alter table coinops.exchange_reconciliation_items enable row level security;
alter table coinops.exchange_reconciliation_items force row level security;

create policy exchange_reconciliation_runs_owner_select on coinops.exchange_reconciliation_runs
  for select to authenticated using (private.coinops_can_access_row(product_id, tenant_id, user_id));
create policy exchange_reconciliation_items_owner_select on coinops.exchange_reconciliation_items
  for select to authenticated using (private.coinops_can_access_row(product_id, tenant_id, user_id));

revoke all on table coinops.exchange_reconciliation_runs, coinops.exchange_reconciliation_items from public, anon, authenticated;
grant select on table coinops.exchange_reconciliation_runs, coinops.exchange_reconciliation_items to authenticated, service_role;
grant insert, update on table coinops.exchange_connections to service_role;
grant insert, update on table coinops.exchange_reconciliation_runs to service_role;
grant insert on table coinops.exchange_reconciliation_items to service_role;

comment on table coinops.exchange_reconciliation_runs is
  'Read-only Binance reconciliation snapshots. Each run is SHADOW-only and idempotent per connection/time window.';
comment on table coinops.exchange_reconciliation_items is
  'Audit comparisons between CoinOps Shadow expectations and Binance read-only data. Historical exchange trades are never auto-associated to slots.';
