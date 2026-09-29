do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
end $$;
create schema auth;
create schema private;
create schema coinops;
create function auth.jwt() returns jsonb language sql stable as $$select '{}'::jsonb$$;
create function private.coinops_can_access_row(uuid,uuid,uuid) returns boolean language sql stable as $$select true$$;

create table coinops.operators (
  id uuid primary key, product_id uuid not null, tenant_id uuid not null, user_id uuid not null,
  status text not null, kill_switch boolean not null,
  unique(id,product_id,tenant_id,user_id)
);
create table coinops.exchange_accounts (
  id uuid primary key, operator_id uuid not null,
  display_name text not null, status text not null,
  is_legacy_default boolean not null, kill_switch boolean not null,
  executor_shard_id text
);
grant select (id,operator_id,display_name,status,is_legacy_default,kill_switch)
  on coinops.exchange_accounts to authenticated;
create table coinops.trading_engines (
  id uuid primary key, operator_id uuid not null, exchange_account_id uuid not null,
  environment text not null, status text not null, kill_switch boolean not null,
  symbol text not null, quote_asset text not null, updated_at timestamptz default now(),
  unique(id,operator_id,exchange_account_id,quote_asset)
);
create table coinops.robot_v1_live_runs (
  id uuid primary key, trading_engine_id uuid not null, operator_id uuid not null,
  exchange_account_id uuid not null, symbol text not null,
  product_id uuid not null, tenant_id uuid not null, user_id uuid not null,
  status text not null, lease_owner uuid, lease_until timestamptz,
  config_version integer not null, entry_regime text not null,
  last_reconciled_at timestamptz, last_error text, gain_rate numeric, entry_spacing numeric,
  created_at timestamptz default now()
);
create table coinops.robot_v1_ath_profiles (
  id uuid primary key, trading_engine_id uuid not null, operator_id uuid not null,
  exchange_account_id uuid not null, environment text not null,
  product_id uuid not null, tenant_id uuid not null, user_id uuid not null,
  config_version integer not null, next_config_version integer,
  gain_rate numeric not null default .055, normal_spacing_rate numeric not null default .03,
  post_ath_spacing_rate numeric not null, regime text not null, updated_at timestamptz default now()
);
create table coinops.robot_v1_live_orders (
  id uuid primary key, run_id uuid not null references coinops.robot_v1_live_runs(id),
  side text not null, status text not null, submission_guarded_at timestamptz,
  operator_id uuid, exchange_account_id uuid, trading_engine_id uuid, purpose text,
  slot_number integer, client_order_id text, exchange_order_id text, price numeric,
  requested_quantity numeric, requested_quote numeric, executed_quantity numeric,
  cumulative_quote numeric, created_at timestamptz default now(), updated_at timestamptz default now(),
  fee_base numeric, fee_quote numeric, fee_other numeric, reserved_notional_brl numeric,
  reserved_notional_quote numeric
);
create table coinops.robot_v1_live_preparations (
  id uuid primary key, trading_engine_id uuid not null,
  operator_id uuid not null, exchange_account_id uuid not null,
  monthly_target integer not null default 2, live_enabled boolean not null default true,
  kill_switch boolean not null default false
);
create table coinops.robot_v1_live_slots (
  id uuid primary key, run_id uuid not null, operator_id uuid not null,
  exchange_account_id uuid not null, trading_engine_id uuid not null, slot_number integer not null,
  entry_state text, target_buy_price numeric, operational_rank integer, post_ath_group text,
  post_ath_group_rank integer, operation_sequence integer, position_quantity numeric,
  position_committed_brl numeric, position_committed_quote numeric, missed_at timestamptz
);
create table coinops.robot_v1_live_slot_accounts (
  operator_id uuid, exchange_account_id uuid, trading_engine_id uuid, slot_number integer,
  balance_brl numeric, balance_quote numeric, contribution_brl numeric, contribution_quote numeric,
  market_pnl_brl numeric, market_pnl_quote numeric, manual_gain_brl numeric, manual_gain_quote numeric,
  fees_brl numeric, fees_quote numeric, gain_count integer, dust_quantity numeric,
  dust_cost_brl numeric, dust_cost_quote numeric
);
create table coinops.robot_v1_live_selective_contribution_allocations (
  operator_id uuid, exchange_account_id uuid, trading_engine_id uuid, slot_number integer,
  amount_quote numeric, status text, created_at timestamptz default now(), applied_at timestamptz
);
create table coinops.robot_v1_live_events (
  operator_id uuid, exchange_account_id uuid, trading_engine_id uuid, run_id uuid,
  event_type text, slot_number integer, observed_at timestamptz, details jsonb
);
create table coinops.robot_v1_live_alerts (
  operator_id uuid, exchange_account_id uuid, trading_engine_id uuid,
  severity text, code text, last_seen_at timestamptz, resolved_at timestamptz
);
create table coinops.robot_v1_slot_gain_totals (
  operator_id uuid, exchange_account_id uuid, trading_engine_id uuid, slot_number integer,
  physical_slot_id text, period_key text, lifetime_gain_count integer, monthly_gain_count integer,
  market_gain_count integer, manual_gain_count integer, monthly_market_gain_count integer,
  monthly_manual_gain_count integer
);
