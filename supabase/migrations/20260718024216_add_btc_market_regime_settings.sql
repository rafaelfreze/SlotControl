-- Estado global do ATH do BTC, configuracoes por usuario e estrategia por ativo.
-- Nenhuma operacao, slot, ganho historico ou capital operacional existente e alterado.

create table if not exists public.btc_market_state (
  singleton boolean primary key default true check (singleton),
  ath_price numeric(20,8) not null default 0 check (ath_price >= 0),
  current_price numeric(20,8) not null default 0 check (current_price >= 0),
  classification_price numeric(20,8) not null default 0 check (classification_price >= 0),
  distance_from_ath_percent numeric(12,6) not null default 0,
  calculated_mode text not null default 'NORMAL' check (calculated_mode in ('TOP', 'NORMAL', 'DEEP')),
  effective_mode text not null default 'NORMAL' check (effective_mode in ('TOP', 'NORMAL', 'DEEP')),
  source text not null default 'UNAVAILABLE',
  price_updated_at timestamptz,
  ath_updated_at timestamptz,
  classified_at timestamptz,
  mode_changed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.btc_market_state (singleton)
values (true)
on conflict (singleton) do nothing;

create table if not exists public.market_regime_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  top_threshold_percent numeric(8,4) not null default 5 check (top_threshold_percent > 0 and top_threshold_percent < 100),
  deep_threshold_percent numeric(8,4) not null default 30 check (deep_threshold_percent > top_threshold_percent and deep_threshold_percent < 100),
  hysteresis_percent numeric(8,4) not null default 0.5 check (hysteresis_percent >= 0 and hysteresis_percent <= 10),
  classification_timeframe text not null default 'DAILY_CLOSE' check (classification_timeframe = 'DAILY_CLOSE'),
  mode_source text not null default 'AUTO' check (mode_source in ('AUTO', 'MANUAL')),
  manual_mode text check (manual_mode in ('TOP', 'NORMAL', 'DEEP')),
  last_effective_mode text check (last_effective_mode in ('TOP', 'NORMAL', 'DEEP')),
  manual_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint market_regime_settings_manual_mode_required check ((mode_source = 'AUTO' and manual_mode is null) or (mode_source = 'MANUAL' and manual_mode is not null))
);

create table if not exists public.asset_market_strategy_settings (
  user_id uuid not null references auth.users(id) on delete cascade,
  asset text not null check (asset in ('BTC', 'SOL')),
  buy_drop_top_percent numeric(8,4) not null check (buy_drop_top_percent > 0 and buy_drop_top_percent <= 90),
  buy_drop_normal_percent numeric(8,4) not null check (buy_drop_normal_percent > 0 and buy_drop_normal_percent <= 90),
  buy_drop_deep_percent numeric(8,4) not null check (buy_drop_deep_percent > 0 and buy_drop_deep_percent <= 90),
  top_zero_reserve_count integer not null check (top_zero_reserve_count >= 0 and top_zero_reserve_count <= 25),
  normal_zero_reserve_count integer not null check (normal_zero_reserve_count >= 0 and normal_zero_reserve_count <= 25),
  deep_zero_reserve_count integer not null check (deep_zero_reserve_count >= 0 and deep_zero_reserve_count <= 25),
  deep_active_slot_limit integer check (deep_active_slot_limit is null or (deep_active_slot_limit > 0 and deep_active_slot_limit <= 25)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, asset)
);

create table if not exists public.market_regime_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  previous_mode text check (previous_mode in ('TOP', 'NORMAL', 'DEEP')),
  new_mode text not null check (new_mode in ('TOP', 'NORMAL', 'DEEP')),
  mode_source text not null check (mode_source in ('AUTO', 'MANUAL')),
  ath_price numeric(20,8) not null default 0,
  current_price numeric(20,8) not null default 0,
  distance_percent numeric(12,6) not null default 0,
  reason text,
  created_at timestamptz not null default now()
);

create index if not exists market_regime_history_user_created_idx
  on public.market_regime_history (user_id, created_at desc);

insert into public.market_regime_settings (user_id)
select distinct user_id
from (
  select user_id from public.strategies where user_id is not null
  union
  select user_id from public.user_settings where user_id is not null
) users
on conflict (user_id) do nothing;

insert into public.asset_market_strategy_settings (
  user_id, asset, buy_drop_top_percent, buy_drop_normal_percent, buy_drop_deep_percent,
  top_zero_reserve_count, normal_zero_reserve_count, deep_zero_reserve_count, deep_active_slot_limit
)
select user_id, 'BTC', 4, 2, 2, 5, 3, 0, 15
from public.market_regime_settings
on conflict (user_id, asset) do nothing;

insert into public.asset_market_strategy_settings (
  user_id, asset, buy_drop_top_percent, buy_drop_normal_percent, buy_drop_deep_percent,
  top_zero_reserve_count, normal_zero_reserve_count, deep_zero_reserve_count, deep_active_slot_limit
)
select user_id, 'SOL', 12, 8, 8, 3, 1, 0, null
from public.market_regime_settings
on conflict (user_id, asset) do nothing;

alter table public.btc_market_state enable row level security;
alter table public.market_regime_settings enable row level security;
alter table public.asset_market_strategy_settings enable row level security;
alter table public.market_regime_history enable row level security;

drop policy if exists "Authenticated users can read BTC market state" on public.btc_market_state;
create policy "Authenticated users can read BTC market state"
on public.btc_market_state for select to authenticated using (true);

drop policy if exists "Users can read own market regime settings" on public.market_regime_settings;
create policy "Users can read own market regime settings"
on public.market_regime_settings for select to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "Users can read own asset market settings" on public.asset_market_strategy_settings;
create policy "Users can read own asset market settings"
on public.asset_market_strategy_settings for select to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "Users can read own market regime history" on public.market_regime_history;
create policy "Users can read own market regime history"
on public.market_regime_history for select to authenticated
using ((select auth.uid()) = user_id);

revoke all on table public.btc_market_state from anon, authenticated;
revoke all on table public.market_regime_settings from anon, authenticated;
revoke all on table public.asset_market_strategy_settings from anon, authenticated;
revoke all on table public.market_regime_history from anon, authenticated;
grant select on table public.btc_market_state to authenticated;
grant select on table public.market_regime_settings to authenticated;
grant select on table public.asset_market_strategy_settings to authenticated;
grant select on table public.market_regime_history to authenticated;

alter table public.notification_outbox
  drop constraint if exists notification_outbox_event_type_check;
alter table public.notification_outbox
  add constraint notification_outbox_event_type_check
  check (event_type in ('slot_entry', 'slot_exit', 'test', 'market_regime'));
