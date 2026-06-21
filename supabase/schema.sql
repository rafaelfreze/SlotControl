-- SlotGain Control - Supabase schema
-- Etapa 1: base de dados com Auth, dados por usuario e Row Level Security.

create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.strategies (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  key text not null,
  title text not null,
  display_name text not null,
  asset text not null,
  base_value numeric(18, 8) not null,
  gain_rate numeric(12, 8) not null,
  initial_slots integer not null default 0,
  drop_percent numeric(8, 4) not null default 0,
  restart_amount integer not null default 0,
  redistribution_target integer not null default 0,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, key),
  check (base_value >= 0),
  check (gain_rate >= 0),
  check (initial_slots >= 0),
  check (restart_amount >= 0),
  check (redistribution_target >= 0)
);

create table if not exists public.slots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  strategy_id uuid not null references public.strategies(id) on delete cascade,
  slot_number integer not null,
  sort_order integer not null,
  status text not null default 'zerado',
  gains integer not null default 0,
  base_value numeric(18, 8) not null,
  gain_rate numeric(12, 8) not null,
  started_once boolean not null default false,
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, strategy_id, slot_number),
  check (slot_number > 0),
  check (sort_order > 0),
  check (status in ('zerado', 'aberto', 'gain', 'hold')),
  check (gains >= 0),
  check (base_value >= 0),
  check (gain_rate >= 0)
);

create table if not exists public.history_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  strategy_id uuid references public.strategies(id) on delete set null,
  slot_id uuid references public.slots(id) on delete set null,
  action text not null,
  detail text not null default '',
  strategy_key text,
  slot_number integer,
  event_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists public.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  settings jsonb not null default '{}'::jsonb,
  app_version integer not null default 1,
  last_migrated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.user_exports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  export_type text not null default 'json',
  file_name text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists strategies_user_id_idx on public.strategies (user_id);
create index if not exists slots_user_id_idx on public.slots (user_id);
create index if not exists slots_strategy_id_idx on public.slots (strategy_id);
create index if not exists slots_user_strategy_order_idx on public.slots (user_id, strategy_id, sort_order);
create index if not exists history_events_user_event_idx on public.history_events (user_id, event_at desc);
create index if not exists history_events_slot_id_idx on public.history_events (slot_id);
create index if not exists user_exports_user_created_idx on public.user_exports (user_id, created_at desc);

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

drop trigger if exists strategies_set_updated_at on public.strategies;
create trigger strategies_set_updated_at
before update on public.strategies
for each row execute function public.set_updated_at();

drop trigger if exists slots_set_updated_at on public.slots;
create trigger slots_set_updated_at
before update on public.slots
for each row execute function public.set_updated_at();

drop trigger if exists user_settings_set_updated_at on public.user_settings;
create trigger user_settings_set_updated_at
before update on public.user_settings
for each row execute function public.set_updated_at();

create or replace function public.create_default_strategies_for_user(target_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.strategies (
    user_id,
    key,
    title,
    display_name,
    asset,
    base_value,
    gain_rate,
    initial_slots,
    drop_percent,
    restart_amount,
    redistribution_target,
    sort_order
  )
  values
    (
      target_user_id,
      'btc',
      'BTC 1%',
      'BTC 1% | Novo Slot 2%',
      'BTC',
      10,
      0.01,
      25,
      2,
      5,
      50,
      1
    ),
    (
      target_user_id,
      'sol',
      'SOL 5%',
      'SOL 5% | Novo Slot 12%',
      'SOL',
      25,
      0.05,
      10,
      12,
      3,
      10,
      2
    )
  on conflict (user_id, key) do nothing;
end;
$$;

create or replace function public.create_default_slots_for_user(target_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.slots (
    user_id,
    strategy_id,
    slot_number,
    sort_order,
    status,
    gains,
    base_value,
    gain_rate,
    started_once
  )
  select
    target_user_id,
    strategy.id,
    slot_number,
    slot_number,
    'zerado',
    0,
    strategy.base_value,
    strategy.gain_rate,
    false
  from public.strategies strategy
  cross join generate_series(1, 25) as slot_number
  where strategy.user_id = target_user_id
    and strategy.key = 'btc'
  on conflict (user_id, strategy_id, slot_number) do nothing;

  insert into public.slots (
    user_id,
    strategy_id,
    slot_number,
    sort_order,
    status,
    gains,
    base_value,
    gain_rate,
    started_once
  )
  select
    target_user_id,
    strategy.id,
    slot_number,
    25 + slot_number,
    'zerado',
    0,
    strategy.base_value,
    strategy.gain_rate,
    false
  from public.strategies strategy
  cross join generate_series(1, 10) as slot_number
  where strategy.user_id = target_user_id
    and strategy.key = 'sol'
  on conflict (user_id, strategy_id, slot_number) do nothing;
end;
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'display_name', new.raw_user_meta_data ->> 'name')
  )
  on conflict (id) do nothing;

  insert into public.user_settings (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  perform public.create_default_strategies_for_user(new.id);
  perform public.create_default_slots_for_user(new.id);

  return new;
end;
$$;

revoke all on function public.create_default_strategies_for_user(uuid) from public, anon, authenticated;
revoke all on function public.create_default_slots_for_user(uuid) from public, anon, authenticated;
revoke all on function public.handle_new_user() from public, anon, authenticated;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.strategies enable row level security;
alter table public.slots enable row level security;
alter table public.history_events enable row level security;
alter table public.user_settings enable row level security;
alter table public.user_exports enable row level security;

drop policy if exists "Users can read own profile" on public.profiles;
create policy "Users can read own profile"
on public.profiles for select
using (id = auth.uid());

drop policy if exists "Users can insert own profile" on public.profiles;
create policy "Users can insert own profile"
on public.profiles for insert
with check (id = auth.uid());

drop policy if exists "Users can update own profile" on public.profiles;
create policy "Users can update own profile"
on public.profiles for update
using (id = auth.uid())
with check (id = auth.uid());

drop policy if exists "Users can manage own strategies" on public.strategies;
create policy "Users can manage own strategies"
on public.strategies for all
using (user_id = auth.uid())
with check (user_id = auth.uid());

drop policy if exists "Users can manage own slots" on public.slots;
create policy "Users can manage own slots"
on public.slots for all
using (user_id = auth.uid())
with check (user_id = auth.uid());

drop policy if exists "Users can manage own history" on public.history_events;
create policy "Users can manage own history"
on public.history_events for all
using (user_id = auth.uid())
with check (user_id = auth.uid());

drop policy if exists "Users can manage own settings" on public.user_settings;
create policy "Users can manage own settings"
on public.user_settings for all
using (user_id = auth.uid())
with check (user_id = auth.uid());

drop policy if exists "Users can manage own exports" on public.user_exports;
create policy "Users can manage own exports"
on public.user_exports for all
using (user_id = auth.uid())
with check (user_id = auth.uid());
