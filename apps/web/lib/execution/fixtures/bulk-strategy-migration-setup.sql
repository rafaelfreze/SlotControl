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
  created_at timestamptz default now()
);
create table coinops.robot_v1_ath_profiles (
  id uuid primary key, trading_engine_id uuid not null, operator_id uuid not null,
  exchange_account_id uuid not null, environment text not null,
  product_id uuid not null, tenant_id uuid not null, user_id uuid not null,
  config_version integer not null, next_config_version integer,
  post_ath_spacing_rate numeric not null, regime text not null, updated_at timestamptz default now()
);
create table coinops.robot_v1_live_orders (
  id uuid primary key, run_id uuid not null references coinops.robot_v1_live_runs(id),
  side text not null, status text not null, submission_guarded_at timestamptz
);
