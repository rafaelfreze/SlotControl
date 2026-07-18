create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  device_name text,
  platform text not null default 'unknown' check (platform in ('ios', 'android', 'desktop', 'unknown')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_success_at timestamptz,
  last_failure_at timestamptz,
  failure_count integer not null default 0 check (failure_count >= 0)
);

create index if not exists push_subscriptions_active_user_idx
  on public.push_subscriptions (user_id, is_active)
  where is_active;

create table if not exists public.notification_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  global_enabled boolean not null default false,
  btc_entry_enabled boolean not null default true,
  btc_exit_enabled boolean not null default true,
  sol_entry_enabled boolean not null default true,
  sol_exit_enabled boolean not null default true,
  manual_events_enabled boolean not null default true,
  automatic_events_enabled boolean not null default true,
  privacy_mode boolean not null default false,
  quiet_hours_enabled boolean not null default false,
  quiet_hours_start time,
  quiet_hours_end time,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint notification_preferences_quiet_hours_check check (
    (quiet_hours_enabled = false)
    or (quiet_hours_start is not null and quiet_hours_end is not null)
  )
);

create table if not exists public.notification_outbox (
  id uuid primary key default gen_random_uuid(),
  event_id text not null unique,
  user_id uuid not null references auth.users(id) on delete cascade,
  event_type text not null check (event_type in ('slot_entry', 'slot_exit', 'test')),
  origin text not null check (origin in ('manual', 'automatic', 'test')),
  asset text check (asset in ('BTC', 'SOL')),
  slot_id uuid references public.slots(id) on delete set null,
  operation_id uuid references public.history_events(id) on delete set null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'processing', 'sent', 'partial', 'failed', 'cancelled')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz not null default now(),
  processing_started_at timestamptz,
  processed_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists notification_outbox_ready_idx
  on public.notification_outbox (next_attempt_at, created_at)
  where status in ('pending', 'partial');
create index if not exists notification_outbox_user_created_idx
  on public.notification_outbox (user_id, created_at desc);

create table if not exists public.notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  outbox_id uuid not null references public.notification_outbox(id) on delete cascade,
  subscription_id uuid not null references public.push_subscriptions(id) on delete cascade,
  status text not null check (status in ('processing', 'sent', 'failed', 'expired', 'skipped')),
  http_status integer,
  attempted_at timestamptz not null default now(),
  completed_at timestamptz,
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (outbox_id, subscription_id)
);

create index if not exists notification_deliveries_outbox_idx
  on public.notification_deliveries (outbox_id, status);

create or replace function public.set_push_notification_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists push_subscriptions_set_updated_at on public.push_subscriptions;
create trigger push_subscriptions_set_updated_at
before update on public.push_subscriptions
for each row execute function public.set_push_notification_updated_at();

drop trigger if exists notification_preferences_set_updated_at on public.notification_preferences;
create trigger notification_preferences_set_updated_at
before update on public.notification_preferences
for each row execute function public.set_push_notification_updated_at();

drop trigger if exists notification_outbox_set_updated_at on public.notification_outbox;
create trigger notification_outbox_set_updated_at
before update on public.notification_outbox
for each row execute function public.set_push_notification_updated_at();

drop trigger if exists notification_deliveries_set_updated_at on public.notification_deliveries;
create trigger notification_deliveries_set_updated_at
before update on public.notification_deliveries
for each row execute function public.set_push_notification_updated_at();

alter table public.push_subscriptions enable row level security;
alter table public.notification_preferences enable row level security;
alter table public.notification_outbox enable row level security;
alter table public.notification_deliveries enable row level security;

drop policy if exists "Users can view own push subscriptions" on public.push_subscriptions;
create policy "Users can view own push subscriptions"
  on public.push_subscriptions for select to authenticated
  using ((select auth.uid()) = user_id);
drop policy if exists "Users can add own push subscriptions" on public.push_subscriptions;
create policy "Users can add own push subscriptions"
  on public.push_subscriptions for insert to authenticated
  with check ((select auth.uid()) = user_id);
drop policy if exists "Users can update own push subscriptions" on public.push_subscriptions;
create policy "Users can update own push subscriptions"
  on public.push_subscriptions for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
drop policy if exists "Users can remove own push subscriptions" on public.push_subscriptions;
create policy "Users can remove own push subscriptions"
  on public.push_subscriptions for delete to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can view own notification preferences" on public.notification_preferences;
create policy "Users can view own notification preferences"
  on public.notification_preferences for select to authenticated
  using ((select auth.uid()) = user_id);
drop policy if exists "Users can add own notification preferences" on public.notification_preferences;
create policy "Users can add own notification preferences"
  on public.notification_preferences for insert to authenticated
  with check ((select auth.uid()) = user_id);
drop policy if exists "Users can update own notification preferences" on public.notification_preferences;
create policy "Users can update own notification preferences"
  on public.notification_preferences for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create or replace function public.enqueue_slot_notification_from_history()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_metadata jsonb := '{}'::jsonb;
  v_asset text;
  v_event_type text;
  v_origin text;
  v_gain_rate numeric;
begin
  if new.slot_id is null or new.action not in ('Abertura', 'Gain', 'entrada_automatica', 'auto_gain') then
    return new;
  end if;

  begin
    v_metadata := coalesce(new.detail::jsonb, '{}'::jsonb);
  exception when others then
    v_metadata := '{}'::jsonb;
  end;

  select upper(s.asset), s.gain_rate
    into v_asset, v_gain_rate
  from public.strategies s
  where s.id = new.strategy_id and s.user_id = new.user_id;

  v_asset := coalesce(upper(nullif(v_metadata ->> 'asset', '')), v_asset);
  if v_asset not in ('BTC', 'SOL') then
    return new;
  end if;

  if new.action in ('Abertura', 'entrada_automatica') then
    v_event_type := 'slot_entry';
  else
    v_event_type := 'slot_exit';
  end if;

  v_origin := case
    when new.action in ('entrada_automatica', 'auto_gain')
      or upper(coalesce(v_metadata ->> 'origin', '')) in ('AUTO_GAIN', 'CRON') then 'automatic'
    else 'manual'
  end;

  insert into public.notification_outbox (
    event_id,
    user_id,
    event_type,
    origin,
    asset,
    slot_id,
    operation_id,
    payload
  ) values (
    'history:' || new.id::text,
    new.user_id,
    v_event_type,
    v_origin,
    v_asset,
    new.slot_id,
    new.id,
    jsonb_strip_nulls(jsonb_build_object(
      'eventId', 'history:' || new.id::text,
      'asset', v_asset,
      'eventType', v_event_type,
      'origin', v_origin,
      'slotId', new.slot_id,
      'slotNumber', new.slot_number,
      'entryPrice', coalesce(v_metadata -> 'executedPrice', v_metadata -> 'expectedPrice'),
      'exitPrice', v_metadata -> 'executedPrice',
      'targetPrice', v_metadata -> 'targetPrice',
      'gainRate', v_gain_rate,
      'realizedProfit', v_metadata -> 'realizedProfit',
      'gains', v_metadata -> 'gains',
      'operationId', new.id,
      'url', '/slots?asset=' || lower(v_asset) || '&slot=' || new.slot_id::text
    ))
  ) on conflict (event_id) do nothing;

  return new;
end;
$$;

revoke all on function public.enqueue_slot_notification_from_history() from public;

drop trigger if exists history_events_enqueue_slot_notification on public.history_events;
create trigger history_events_enqueue_slot_notification
after insert on public.history_events
for each row execute function public.enqueue_slot_notification_from_history();

create or replace function public.queue_push_test_notification()
returns public.notification_outbox
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_outbox public.notification_outbox;
  v_event_id text := 'test:' || gen_random_uuid()::text;
begin
  if v_user_id is null then
    raise exception 'Autenticacao obrigatoria';
  end if;

  insert into public.notification_outbox (
    event_id, user_id, event_type, origin, payload
  ) values (
    v_event_id,
    v_user_id,
    'test',
    'test',
    jsonb_build_object(
      'eventId', v_event_id,
      'title', 'Teste de notificacoes do Slot Control',
      'body', 'As notificacoes deste celular estao configuradas. Toque para abrir o painel.',
      'url', '/config'
    )
  ) returning * into v_outbox;

  return v_outbox;
end;
$$;

revoke all on function public.queue_push_test_notification() from public;
grant execute on function public.queue_push_test_notification() to authenticated;

create or replace function public.claim_notification_outbox(p_limit integer default 25)
returns setof public.notification_outbox
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  with candidates as (
    select id
    from public.notification_outbox
    where (
      status in ('pending', 'partial') and next_attempt_at <= now()
    ) or (
      status = 'processing' and processing_started_at < now() - interval '10 minutes'
    )
    order by created_at
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 25), 100))
  )
  update public.notification_outbox o
  set status = 'processing',
      attempt_count = o.attempt_count + 1,
      processing_started_at = now(),
      last_error = null
  from candidates c
  where o.id = c.id
  returning o.*;
end;
$$;

revoke all on function public.claim_notification_outbox(integer) from public;
grant execute on function public.claim_notification_outbox(integer) to service_role;

grant select, insert, update, delete on public.push_subscriptions to authenticated;
grant select, insert, update on public.notification_preferences to authenticated;
grant select, insert, update, delete on public.push_subscriptions to service_role;
grant select, insert, update, delete on public.notification_preferences to service_role;
grant select, insert, update, delete on public.notification_outbox to service_role;
grant select, insert, update, delete on public.notification_deliveries to service_role;
