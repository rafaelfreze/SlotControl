alter table public.push_subscriptions
  add column if not exists last_seen_at timestamptz,
  add column if not exists revoked_at timestamptz;

update public.push_subscriptions
set last_seen_at = coalesce(last_seen_at, updated_at, created_at)
where last_seen_at is null;

create index if not exists push_subscriptions_active_last_seen_idx
  on public.push_subscriptions (user_id, last_seen_at desc)
  where is_active and revoked_at is null;

revoke all on table public.push_subscriptions from public, anon;
revoke references, trigger, truncate on table public.push_subscriptions from authenticated;
grant select, insert, update, delete on table public.push_subscriptions to authenticated;
