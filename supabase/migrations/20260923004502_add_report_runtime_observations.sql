-- Phase 3.9: append-only runtime evidence, never an execution instruction.
create table coinops.report_runtime_observations (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  observation_version integer not null default 1 check (observation_version > 0),
  event_key text not null check (event_key ~ '^[a-f0-9]{64}$'),
  environment text not null check (environment in ('SHADOW', 'TESTNET', 'REAL')),
  asset text check (asset in ('BTC', 'SOL')),
  symbol text check (symbol in ('BTCUSDC', 'SOLUSDC', 'BTCUSDT', 'SOLUSDT', 'SOLBRL')),
  source text not null check (source in ('SHADOW_ENGINE', 'TESTNET_DIAGNOSTIC')),
  observed_at timestamptz not null,
  started_at timestamptz not null,
  finished_at timestamptz not null,
  status text not null check (status in ('COMPLETED', 'FAILED', 'SKIPPED')),
  error_code text check (error_code ~ '^[A-Z][A-Z0-9_-]{0,159}$'),
  metrics jsonb not null default '{}'::jsonb check (jsonb_typeof(metrics) = 'object' and octet_length(metrics::text) <= 32768),
  app_commit_sha text check (app_commit_sha ~ '^[a-f0-9]{7,64}$'),
  created_at timestamptz not null default timezone('utc', now()),
  unique (product_id, tenant_id, user_id, event_key),
  foreign key (product_id, tenant_id) references public.product_tenants(product_id, tenant_id) on delete restrict,
  check (finished_at >= started_at),
  check ((source = 'SHADOW_ENGINE' and environment = 'SHADOW' and asset is not null)
    or (source = 'TESTNET_DIAGNOSTIC' and environment = 'TESTNET')),
  check (metrics::text !~* '"(api[_-]?key|api[_-]?secret|access[_-]?token|refresh[_-]?token|authorization|cookie|password|secret)"[[:space:]]*:')
);
create index report_runtime_observations_scope_time_idx
  on coinops.report_runtime_observations(product_id, tenant_id, user_id, environment, observed_at desc);

alter table coinops.report_runtime_observations enable row level security;
alter table coinops.report_runtime_observations force row level security;
create policy report_runtime_observations_owner_select on coinops.report_runtime_observations
  for select to authenticated using (private.coinops_can_access_row(product_id, tenant_id, user_id));
revoke all on coinops.report_runtime_observations from public, anon, authenticated, service_role;
grant select on coinops.report_runtime_observations to authenticated, service_role;
grant insert on coinops.report_runtime_observations to service_role;
comment on table coinops.report_runtime_observations is
  'Versioned append-only evidence of actual engine runs and existing Testnet diagnostics. No credentials, no execution instructions, no synthetic historical snapshots.';
