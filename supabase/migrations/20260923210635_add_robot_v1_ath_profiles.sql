-- CoinOps 4.3. This is an additive configuration/audit boundary. Existing
-- active Shadow/Testnet cycles and resident orders are not repriced or changed.
create table if not exists coinops.robot_v1_ath_profiles (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  environment text not null check (environment in ('SHADOW', 'TESTNET', 'REAL')),
  asset text not null check (asset in ('BTC', 'SOL')),
  config_version integer not null default 1 check (config_version > 0),
  gain_rate numeric(12,8) not null check (gain_rate between 0.001 and 0.2),
  normal_spacing_rate numeric(12,8) not null check (normal_spacing_rate between 0.001 and 0.2),
  post_ath_spacing_rate numeric(12,8) not null check (post_ath_spacing_rate between 0.001 and 0.2),
  next_gain_rate numeric(12,8) check (next_gain_rate between 0.001 and 0.2),
  next_normal_spacing_rate numeric(12,8) check (next_normal_spacing_rate between 0.001 and 0.2),
  next_post_ath_spacing_rate numeric(12,8) check (next_post_ath_spacing_rate between 0.001 and 0.2),
  next_config_version integer check (next_config_version > config_version),
  regime text not null default 'NORMAL' check (regime in ('NORMAL', 'POST_ATH')),
  ath_price numeric(24,8) check (ath_price > 0),
  previous_ath numeric(24,8) check (previous_ath > 0),
  ath_observed_at timestamptz,
  ath_source text,
  ath_verified_at timestamptz,
  ath_history_candle_count integer check (ath_history_candle_count > 0),
  ath_floor_reference numeric(24,8) check (ath_floor_reference > 0),
  ath_floor_source text,
  ath_floor_defined_at timestamptz,
  transition_key text,
  transition_events text[] not null default '{}',
  transition_observed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (product_id, tenant_id, user_id, environment, asset),
  constraint robot_v1_ath_profile_next_complete check (
    (next_config_version is null and next_gain_rate is null and next_normal_spacing_rate is null and next_post_ath_spacing_rate is null)
    or (next_config_version is not null and next_gain_rate is not null and next_normal_spacing_rate is not null and next_post_ath_spacing_rate is not null)
  ),
  constraint robot_v1_ath_profile_floor_complete check (
    (ath_floor_reference is null and ath_floor_source is null and ath_floor_defined_at is null)
    or (ath_floor_reference is not null and ath_floor_source is not null and ath_floor_defined_at is not null)
  )
);

alter table coinops.robot_v1_ath_profiles enable row level security;
alter table coinops.robot_v1_ath_profiles force row level security;
create policy robot_v1_ath_profiles_owner_read on coinops.robot_v1_ath_profiles
  for select to authenticated using (private.coinops_can_access_row(product_id, tenant_id, user_id));
revoke all on coinops.robot_v1_ath_profiles from anon, authenticated;
grant select on coinops.robot_v1_ath_profiles to authenticated;
grant all on coinops.robot_v1_ath_profiles to service_role;

-- Preserve the existing 0.5%/1% quick profile where one is already running.
-- The official post-ATH rate is a separate, editable value; REAL starts as
-- prepared data only and never receives exchange write capabilities.
insert into coinops.robot_v1_ath_profiles
  (product_id, tenant_id, user_id, environment, asset, gain_rate, normal_spacing_rate, post_ath_spacing_rate)
select c.product_id, c.tenant_id, c.user_id, 'SHADOW', c.asset,
  coalesce(cy.gain_rate, c.gain_rate), coalesce(cy.entry_spacing, c.entry_spacing),
  case c.asset when 'BTC' then 0.05 else 0.08 end
from coinops.robot_v1_configs c
left join lateral (
  select x.gain_rate, x.entry_spacing from coinops.robot_v1_cycles x
  where x.config_id = c.id and x.status in ('STARTING','GRID_ACTIVE','POSITIONS_ACTIVE','RESETTING')
  order by x.started_at desc limit 1
) cy on true
where c.execution_mode = 'SHADOW' and c.asset in ('BTC','SOL')
on conflict (product_id, tenant_id, user_id, environment, asset) do nothing;

insert into coinops.robot_v1_ath_profiles
  (product_id, tenant_id, user_id, environment, asset, gain_rate, normal_spacing_rate, post_ath_spacing_rate)
select c.product_id, c.tenant_id, c.user_id, 'TESTNET', c.asset,
  coalesce(r.gain_rate, case c.asset when 'BTC' then 0.012 else 0.055 end),
  coalesce(r.entry_spacing, case c.asset when 'BTC' then 0.02 else 0.03 end),
  case c.asset when 'BTC' then 0.05 else 0.08 end
from coinops.robot_v1_configs c
left join lateral (
  select t.gain_rate, t.entry_spacing from coinops.robot_v1_testnet_runs t
  where t.product_id = c.product_id and t.tenant_id = c.tenant_id and t.user_id = c.user_id
    and t.asset = c.asset and t.status in ('ACTIVE','PAUSED')
  order by t.created_at desc limit 1
) r on true
where c.execution_mode = 'SHADOW' and c.asset in ('BTC','SOL')
on conflict (product_id, tenant_id, user_id, environment, asset) do nothing;

insert into coinops.robot_v1_ath_profiles
  (product_id, tenant_id, user_id, environment, asset, gain_rate, normal_spacing_rate, post_ath_spacing_rate)
select c.product_id, c.tenant_id, c.user_id, 'REAL', c.asset,
  case c.asset when 'BTC' then 0.012 else 0.055 end,
  case c.asset when 'BTC' then 0.02 else 0.03 end,
  case c.asset when 'BTC' then 0.05 else 0.08 end
from coinops.robot_v1_configs c
where c.execution_mode = 'SHADOW' and c.asset in ('BTC','SOL')
on conflict (product_id, tenant_id, user_id, environment, asset) do nothing;

alter table coinops.robot_v1_cycles
  add column if not exists config_version integer,
  add column if not exists config_snapshot jsonb,
  add column if not exists entry_regime text check (entry_regime in ('NORMAL','POST_ATH')),
  add column if not exists ath_transition_key text,
  add column if not exists ath_period_key text;
alter table coinops.robot_v1_testnet_runs
  add column if not exists config_version integer,
  add column if not exists config_snapshot jsonb,
  add column if not exists entry_regime text check (entry_regime in ('NORMAL','POST_ATH')),
  add column if not exists ath_transition_key text,
  add column if not exists ath_period_key text;
alter table coinops.robot_v1_slots
  add column if not exists operational_rank integer check (operational_rank between 1 and 25),
  add column if not exists post_ath_group text check (post_ath_group in ('PRIMARY','RESERVE')),
  add column if not exists post_ath_group_rank integer check (post_ath_group_rank between 1 and 25),
  add column if not exists entry_origin text not null default 'GRID' check (entry_origin in ('GRID','REENTRY')),
  add column if not exists config_version integer,
  add column if not exists config_snapshot jsonb;
-- Existing local reentries are identified by their durable operation sequence;
-- do not rewrite an OPEN position or an archived operation's history.
update coinops.robot_v1_slots set entry_origin = 'REENTRY'
where operation_sequence > 1 and status = 'PENDING' and entry_origin = 'GRID';
alter table coinops.robot_v1_slot_operations
  add column if not exists config_version integer,
  add column if not exists config_snapshot jsonb;
alter table coinops.robot_v1_testnet_slots
  add column if not exists operational_rank integer check (operational_rank between 1 and 25),
  add column if not exists post_ath_group text check (post_ath_group in ('PRIMARY','RESERVE')),
  add column if not exists post_ath_group_rank integer check (post_ath_group_rank between 1 and 25);
alter table coinops.robot_v1_testnet_orders
  add column if not exists config_version integer,
  add column if not exists config_snapshot jsonb;

-- Adopt only the current active runtime values. These are migration-time
-- snapshots, not fabricated historical operation settings or ATH transitions.
update coinops.robot_v1_cycles cy set
  config_version = p.config_version,
  config_snapshot = jsonb_build_object('gain_rate', cy.gain_rate,
    'normal_spacing_rate', cy.entry_spacing,
    'post_ath_spacing_rate', p.post_ath_spacing_rate,
    'regime', 'NORMAL', 'snapshot_basis', 'MIGRATION_ADOPTION'),
  entry_regime = 'NORMAL'
from coinops.robot_v1_ath_profiles p
where p.environment = 'SHADOW' and p.asset = cy.asset
  and p.product_id = cy.product_id and p.tenant_id = cy.tenant_id and p.user_id = cy.user_id
  and cy.status in ('STARTING','GRID_ACTIVE','POSITIONS_ACTIVE','RESETTING')
  and cy.config_version is null;
update coinops.robot_v1_testnet_runs r set
  config_version = p.config_version,
  config_snapshot = jsonb_build_object('gain_rate', r.gain_rate,
    'normal_spacing_rate', r.entry_spacing,
    'post_ath_spacing_rate', p.post_ath_spacing_rate,
    'regime', 'NORMAL', 'snapshot_basis', 'MIGRATION_ADOPTION'),
  entry_regime = 'NORMAL'
from coinops.robot_v1_ath_profiles p
where p.environment = 'TESTNET' and p.asset = r.asset
  and p.product_id = r.product_id and p.tenant_id = r.tenant_id and p.user_id = r.user_id
  and r.status in ('ACTIVE','PAUSED') and r.config_version is null;
update coinops.robot_v1_slots s set
  config_version = cy.config_version, config_snapshot = cy.config_snapshot
from coinops.robot_v1_cycles cy
where s.cycle_id = cy.id and cy.config_version is not null
  and s.status = 'PENDING' and s.config_version is null;

create table if not exists coinops.robot_v1_ath_events (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references coinops.robot_v1_ath_profiles(id),
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  environment text not null check (environment in ('SHADOW','TESTNET','REAL')),
  asset text not null check (asset in ('BTC','SOL')),
  event_key text not null,
  event_type text not null,
  cycle_id uuid,
  details jsonb not null default '{}'::jsonb,
  observed_at timestamptz not null default now(),
  unique (profile_id, event_key)
);
create index if not exists robot_v1_ath_events_scope_at_idx on coinops.robot_v1_ath_events
  (tenant_id, user_id, environment, asset, observed_at desc);
alter table coinops.robot_v1_ath_events enable row level security;
alter table coinops.robot_v1_ath_events force row level security;
create policy robot_v1_ath_events_owner_read on coinops.robot_v1_ath_events
  for select to authenticated using (private.coinops_can_access_row(product_id, tenant_id, user_id));
revoke all on coinops.robot_v1_ath_events from anon, authenticated;
grant select on coinops.robot_v1_ath_events to authenticated;
grant all on coinops.robot_v1_ath_events to service_role;

comment on table coinops.robot_v1_ath_profiles is 'Environment-isolated CoinOps ATH configuration. REAL is prepared only; LIVE remains blocked.';
