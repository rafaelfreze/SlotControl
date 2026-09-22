-- Operational controls and immutable audit evidence for the USDC-only V1 Shadow test.

alter table coinops.robot_v1_configs
  add column pause_new_entries boolean not null default false,
  add column next_capital_usdc numeric(20,8) check (next_capital_usdc is null or next_capital_usdc > 0),
  add column shadow_test_started_at timestamptz,
  add column shadow_test_target_end_at timestamptz,
  add column last_candle_open_at timestamptz;

alter table coinops.robot_v1_slots
  add column buy_trigger_price numeric(24,8),
  add column buy_trigger_observed_price numeric(24,8),
  add column buy_triggered_at timestamptz,
  add column tp_trigger_observed_price numeric(24,8),
  add column tp_triggered_at timestamptz;

create table coinops.robot_v1_audit_events (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  config_id uuid not null references coinops.robot_v1_configs(id) on delete restrict,
  cycle_id uuid references coinops.robot_v1_cycles(id) on delete restrict,
  slot_id uuid references coinops.robot_v1_slots(id) on delete restrict,
  event_type text not null check (event_type in ('CAPITAL_CHANGED','CAPITAL_NEXT_CYCLE','SHADOW_STARTED','PAUSED','RESUMED','KILL_SWITCH_ENABLED','KILL_SWITCH_DISABLED','CYCLE_STARTED','CYCLE_COMPLETED','RESET_ALLOWED','BUY_TRIGGERED','TP_TRIGGERED','INTRABAR_AMBIGUOUS','DATA_GAP')),
  previous_state jsonb not null default '{}'::jsonb check (jsonb_typeof(previous_state) = 'object'),
  next_state jsonb not null default '{}'::jsonb check (jsonb_typeof(next_state) = 'object'),
  observed_at timestamptz not null default timezone('utc', now()),
  idempotency_key text not null,
  created_at timestamptz not null default timezone('utc', now()),
  unique (product_id, tenant_id, user_id, idempotency_key),
  foreign key (product_id, tenant_id) references public.product_tenants(product_id, tenant_id) on delete restrict
);
create index robot_v1_audit_scope_observed_idx on coinops.robot_v1_audit_events(product_id, tenant_id, user_id, observed_at desc);

create table coinops.robot_v1_market_candles (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  config_id uuid not null references coinops.robot_v1_configs(id) on delete restrict,
  cycle_id uuid references coinops.robot_v1_cycles(id) on delete restrict,
  symbol text not null check (symbol in ('BTCUSDC','SOLUSDC')),
  candle_open_at timestamptz not null,
  candle_close_at timestamptz not null,
  open_price numeric(24,8) not null check (open_price > 0),
  high_price numeric(24,8) not null check (high_price > 0),
  low_price numeric(24,8) not null check (low_price > 0),
  close_price numeric(24,8) not null check (close_price > 0),
  created_at timestamptz not null default timezone('utc', now()),
  unique (config_id, candle_open_at),
  foreign key (product_id, tenant_id) references public.product_tenants(product_id, tenant_id) on delete restrict,
  check (high_price >= low_price)
);
create index robot_v1_candles_scope_time_idx on coinops.robot_v1_market_candles(product_id, tenant_id, user_id, candle_open_at desc);

alter table coinops.robot_v1_audit_events enable row level security;
alter table coinops.robot_v1_audit_events force row level security;
alter table coinops.robot_v1_market_candles enable row level security;
alter table coinops.robot_v1_market_candles force row level security;
create policy robot_v1_audit_events_owner_select on coinops.robot_v1_audit_events for select to authenticated using (private.coinops_can_access_row(product_id, tenant_id, user_id));
create policy robot_v1_market_candles_owner_select on coinops.robot_v1_market_candles for select to authenticated using (private.coinops_can_access_row(product_id, tenant_id, user_id));
revoke all on coinops.robot_v1_audit_events, coinops.robot_v1_market_candles from public, anon, authenticated;
grant select on coinops.robot_v1_audit_events, coinops.robot_v1_market_candles to authenticated, service_role;
grant insert, update on coinops.robot_v1_configs, coinops.robot_v1_cycles, coinops.robot_v1_slots, coinops.robot_v1_audit_events, coinops.robot_v1_market_candles to service_role;

comment on column coinops.robot_v1_configs.next_capital_usdc is 'Requested capital for the next complete Shadow cycle; it never changes an active grid.';
comment on table coinops.robot_v1_audit_events is 'Append-only operator and deterministic Shadow transition audit; contains no Binance credentials or real order references.';
comment on table coinops.robot_v1_market_candles is 'Read-only Binance public candle evidence used to avoid missing crossed Shadow levels between cron invocations.';
