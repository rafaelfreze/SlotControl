-- CoinOps 5.1: BRL-native configuration only. No executable REAL mode, order
-- transport, financial ledger mutation or change to Shadow/Testnet runtime.
create table coinops.robot_v1_live_preparations (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  asset text not null check (asset in ('BTC','SOL')),
  symbol text not null,
  quote_asset text not null default 'BRL' check (quote_asset = 'BRL'),
  slot_count integer not null default 25 check (slot_count = 25),
  monthly_target integer not null,
  configured_live_capital_brl numeric(20,8) not null check (configured_live_capital_brl > 0),
  max_order_notional_brl numeric(20,8) not null check (max_order_notional_brl > 0),
  max_total_exposure_brl numeric(20,8) not null check (max_total_exposure_brl > 0),
  compounding_enabled boolean not null default true check (compounding_enabled),
  single_active_entry boolean not null default true check (single_active_entry),
  initial_market_enabled boolean not null default true check (initial_market_enabled),
  local_reentry_enabled boolean not null default true check (local_reentry_enabled),
  kill_switch boolean not null default true check (kill_switch),
  live_enabled boolean not null default false check (not live_enabled),
  config_version integer not null default 1 check (config_version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (product_id, tenant_id) references public.product_tenants(product_id, tenant_id) on delete restrict,
  unique (product_id, tenant_id, user_id, asset),
  constraint robot_v1_live_preparation_pair check
    ((asset = 'BTC' and symbol = 'BTCBRL' and monthly_target = 7)
      or (asset = 'SOL' and symbol = 'SOLBRL' and monthly_target = 2)),
  constraint robot_v1_live_preparation_caps check
    (max_order_notional_brl <= max_total_exposure_brl
      and max_total_exposure_brl <= configured_live_capital_brl)
);
create index robot_v1_live_preparations_scope_idx on coinops.robot_v1_live_preparations
  (product_id, tenant_id, user_id, asset);
alter table coinops.robot_v1_live_preparations enable row level security;
alter table coinops.robot_v1_live_preparations force row level security;
create policy robot_v1_live_preparations_owner_read on coinops.robot_v1_live_preparations
  for select to authenticated using (private.coinops_can_access_row(product_id, tenant_id, user_id));
revoke all on coinops.robot_v1_live_preparations from public, anon, authenticated;
grant select on coinops.robot_v1_live_preparations to authenticated;
grant all on coinops.robot_v1_live_preparations to service_role;

create table coinops.robot_v1_live_global_caps (
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  max_total_live_exposure_brl numeric(20,8) not null check (max_total_live_exposure_brl > 0),
  config_version integer not null default 1 check (config_version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (product_id, tenant_id, user_id),
  foreign key (product_id, tenant_id) references public.product_tenants(product_id, tenant_id) on delete restrict
);
alter table coinops.robot_v1_live_global_caps enable row level security;
alter table coinops.robot_v1_live_global_caps force row level security;
create policy robot_v1_live_global_caps_owner_read on coinops.robot_v1_live_global_caps
  for select to authenticated using (private.coinops_can_access_row(product_id, tenant_id, user_id));
revoke all on coinops.robot_v1_live_global_caps from public, anon, authenticated;
grant select on coinops.robot_v1_live_global_caps to authenticated;
grant all on coinops.robot_v1_live_global_caps to service_role;

-- Immutable audit of every future preparation edit, including the seeded state.
create table coinops.robot_v1_live_preparation_events (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  asset text,
  config_version integer not null,
  event_type text not null check (event_type in ('SEEDED','UPDATED')),
  snapshot jsonb not null,
  observed_at timestamptz not null default now(),
  foreign key (product_id, tenant_id) references public.product_tenants(product_id, tenant_id) on delete restrict
);
create index robot_v1_live_preparation_events_scope_idx on coinops.robot_v1_live_preparation_events
  (product_id, tenant_id, user_id, observed_at desc);
alter table coinops.robot_v1_live_preparation_events enable row level security;
alter table coinops.robot_v1_live_preparation_events force row level security;
create policy robot_v1_live_preparation_events_owner_read on coinops.robot_v1_live_preparation_events
  for select to authenticated using (private.coinops_can_access_row(product_id, tenant_id, user_id));
revoke all on coinops.robot_v1_live_preparation_events from public, anon, authenticated;
grant select on coinops.robot_v1_live_preparation_events to authenticated;
grant all on coinops.robot_v1_live_preparation_events to service_role;
create function coinops.audit_robot_v1_live_preparation() returns trigger language plpgsql
security invoker set search_path = '' as $$
begin
  insert into coinops.robot_v1_live_preparation_events
    (product_id,tenant_id,user_id,asset,config_version,event_type,snapshot)
  values (new.product_id,new.tenant_id,new.user_id,
    case when tg_table_name = 'robot_v1_live_preparations' then new.asset else null end,
    new.config_version,case when tg_op = 'INSERT' then 'SEEDED' else 'UPDATED' end,
    to_jsonb(new) - 'created_at' - 'updated_at');
  return new;
end $$;
-- Separate trigger functions avoid referencing asset on the global-cap record.
create trigger robot_v1_live_preparations_audit after insert or update on coinops.robot_v1_live_preparations
  for each row execute function coinops.audit_robot_v1_live_preparation();
revoke all on function coinops.audit_robot_v1_live_preparation() from public, anon, authenticated;

create function coinops.audit_robot_v1_live_global_cap() returns trigger language plpgsql
security invoker set search_path = '' as $$
begin
  insert into coinops.robot_v1_live_preparation_events
    (product_id,tenant_id,user_id,asset,config_version,event_type,snapshot)
  values (new.product_id,new.tenant_id,new.user_id,null,new.config_version,
    case when tg_op = 'INSERT' then 'SEEDED' else 'UPDATED' end,
    to_jsonb(new) - 'created_at' - 'updated_at');
  return new;
end $$;
create trigger robot_v1_live_global_caps_audit after insert or update on coinops.robot_v1_live_global_caps
  for each row execute function coinops.audit_robot_v1_live_global_cap();
revoke all on function coinops.audit_robot_v1_live_global_cap() from public, anon, authenticated;

-- No REAL trades or manual credits exist. Keep a BRL-only prepared ledger,
-- distinct from historical USDC Shadow/Testnet and the legacy REAL-USDC table.
create table coinops.robot_v1_live_slot_accounts (
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  asset text not null check (asset in ('BTC','SOL')),
  slot_number integer not null check (slot_number between 1 and 25),
  quote_asset text not null default 'BRL' check (quote_asset = 'BRL'),
  balance_brl numeric(20,8) not null default 0 check (balance_brl >= 0),
  market_pnl_brl numeric(20,8) not null default 0,
  manual_gain_brl numeric(20,8) not null default 0,
  contribution_brl numeric(20,8) not null default 0,
  fees_brl numeric(20,8) not null default 0,
  gain_count integer not null default 0 check (gain_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (product_id,tenant_id,user_id,asset,slot_number),
  foreign key (product_id,tenant_id) references public.product_tenants(product_id,tenant_id) on delete restrict,
  constraint robot_v1_live_slot_balance_check check
    (balance_brl = market_pnl_brl + manual_gain_brl + contribution_brl - fees_brl)
);
alter table coinops.robot_v1_live_slot_accounts enable row level security;
alter table coinops.robot_v1_live_slot_accounts force row level security;
create policy robot_v1_live_slot_accounts_owner_read on coinops.robot_v1_live_slot_accounts
  for select to authenticated using (private.coinops_can_access_row(product_id,tenant_id,user_id));
revoke all on coinops.robot_v1_live_slot_accounts from public,anon,authenticated;
grant select on coinops.robot_v1_live_slot_accounts to authenticated;
grant all on coinops.robot_v1_live_slot_accounts to service_role;

-- Reject the obsolete REAL-USDC adjustment path at the database boundary.
-- There were no REAL adjustments or nonzero prepared accounts at migration.
create function coinops.block_real_usdc_prepared_account() returns trigger language plpgsql
security invoker set search_path = '' as $$
begin
  raise exception 'COINOPS_REAL_USDC_LEDGER_DISABLED';
end $$;
create trigger robot_v1_real_usdc_prepared_account_block
  before insert or update on coinops.robot_v1_real_prepared_slot_accounts
  for each row execute function coinops.block_real_usdc_prepared_account();
revoke all on function coinops.block_real_usdc_prepared_account() from public,anon,authenticated;

-- Values are a conservative initial authorization from the public Binance
-- 2026-09-23 snapshot (BTCBRL 437365, SOLBRL 595.2). Fresh filters/price
-- must be recomputed before any readiness PASS or future execution.
insert into coinops.robot_v1_live_preparations
  (product_id,tenant_id,user_id,asset,symbol,monthly_target,
    configured_live_capital_brl,max_order_notional_brl,max_total_exposure_brl)
select product_id,tenant_id,user_id,asset,asset || 'BRL',
  case asset when 'BTC' then 7 else 2 end,
  case asset when 'BTC' then 447.00 else 269.75 end,
  case asset when 'BTC' then 17.88 else 10.79 end,
  case asset when 'BTC' then 447.00 else 269.75 end
from coinops.robot_v1_ath_profiles where environment = 'REAL' and asset in ('BTC','SOL')
on conflict (product_id,tenant_id,user_id,asset) do nothing;
insert into coinops.robot_v1_live_global_caps
  (product_id,tenant_id,user_id,max_total_live_exposure_brl)
select distinct product_id,tenant_id,user_id,716.75
from coinops.robot_v1_ath_profiles where environment = 'REAL'
on conflict (product_id,tenant_id,user_id) do nothing;
insert into coinops.robot_v1_live_slot_accounts (product_id,tenant_id,user_id,asset,slot_number)
select p.product_id,p.tenant_id,p.user_id,p.asset,g.slot_number
from coinops.robot_v1_live_preparations p cross join generate_series(1,25) as g(slot_number)
on conflict (product_id,tenant_id,user_id,asset,slot_number) do nothing;

-- Change only the still-unmodified 4.3 REAL defaults. No Shadow/Testnet
-- profile, cycle, order or ledger record is touched.
update coinops.robot_v1_ath_profiles set normal_spacing_rate = 0.01,
  config_version = config_version + 1, updated_at = now()
where environment = 'REAL' and asset = 'BTC' and normal_spacing_rate = 0.02
  and gain_rate = 0.012 and config_version = 1 and next_config_version is null;
update coinops.robot_v1_ath_profiles set normal_spacing_rate = 0.015,
  config_version = config_version + 1, updated_at = now()
where environment = 'REAL' and asset = 'SOL' and normal_spacing_rate = 0.03
  and gain_rate = 0.055 and config_version = 1 and next_config_version is null;

comment on table coinops.robot_v1_live_preparations is
  'BRL-native no-write REAL preparation. CHECK constraints force live_enabled=false and kill_switch=true.';
