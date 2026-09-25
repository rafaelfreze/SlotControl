-- CoinOps operator-only Web Push. No trading state or orders are changed.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '60s';

alter table coinops.operators add constraint operators_id_user_push_unique unique (id, user_id);

create table coinops.operator_push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null references coinops.operators(id) on delete restrict,
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint_hash text not null check (endpoint_hash ~ '^[a-f0-9]{64}$'),
  endpoint text not null check (length(endpoint) between 20 and 2048),
  p256dh text not null check (length(p256dh) between 16 and 256),
  auth_secret text not null check (length(auth_secret) between 8 and 256),
  user_agent_label text not null default 'Navegador' check (length(user_agent_label) <= 80),
  warning_enabled boolean not null default true,
  enabled boolean not null default true,
  last_success_at timestamptz,
  last_test_at timestamptz,
  last_failure_at timestamptz,
  last_failure_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, endpoint_hash),
  foreign key (operator_id, user_id) references coinops.operators(id, user_id) on delete restrict
);
create index operator_push_subscriptions_operator_active
  on coinops.operator_push_subscriptions (operator_id, user_id) where enabled;

create table coinops.operator_push_deliveries (
  id uuid primary key default gen_random_uuid(),
  alert_id uuid not null references coinops.robot_v1_live_alerts(id) on delete restrict,
  opened_at timestamptz not null,
  subscription_id uuid not null references coinops.operator_push_subscriptions(id) on delete restrict,
  operator_id uuid not null references coinops.operators(id) on delete restrict,
  account_id uuid not null references coinops.exchange_accounts(id) on delete restrict,
  engine_id uuid not null references coinops.trading_engines(id) on delete restrict,
  severity text not null check (severity in ('WARNING', 'CRITICAL')),
  device_count integer not null default 0 check (device_count >= 0),
  status text not null default 'PENDING' check (status in ('PENDING','SENDING','SENT','FAILED','EXPIRED')),
  attempted_at timestamptz,
  sent_at timestamptz,
  lease_until timestamptz,
  next_attempt_at timestamptz not null default now(),
  attempt_count integer not null default 0 check (attempt_count between 0 and 5),
  error_code text,
  created_at timestamptz not null default now(),
  unique (alert_id, opened_at, subscription_id)
);
create index operator_push_deliveries_pending on coinops.operator_push_deliveries(status, next_attempt_at)
  where status in ('PENDING','SENDING');

-- Existing alert keys are reused after resolution. Reopening is a new incident.
create function private.coinops_push_new_incident() returns trigger language plpgsql
  set search_path = '' as $$
begin
  if old.resolved_at is not null and new.resolved_at is null then
    new.first_seen_at := now();
  end if;
  return new;
end $$;
revoke all on function private.coinops_push_new_incident() from public, anon, authenticated;
create trigger robot_v1_live_alert_push_incident before update on coinops.robot_v1_live_alerts
  for each row execute function private.coinops_push_new_incident();

alter table coinops.operator_push_subscriptions enable row level security;
alter table coinops.operator_push_subscriptions force row level security;
alter table coinops.operator_push_deliveries enable row level security;
alter table coinops.operator_push_deliveries force row level security;
revoke all on coinops.operator_push_subscriptions, coinops.operator_push_deliveries from public, anon, authenticated;
grant select, insert, update, delete on coinops.operator_push_subscriptions to service_role;
grant select, insert, update on coinops.operator_push_deliveries to service_role;

commit;
