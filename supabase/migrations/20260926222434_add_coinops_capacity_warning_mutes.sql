-- An operator may acknowledge noncritical capacity warnings for one shard.
-- Incident history, critical alerts and admission protection remain unchanged.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '60s';

create table coinops.executor_capacity_warning_mutes (
  operator_id uuid not null references coinops.operators(id) on delete cascade,
  shard_id text not null references coinops.executor_shards(id) on delete restrict,
  muted_at timestamptz not null default now(),
  primary key (operator_id, shard_id)
);
alter table coinops.executor_capacity_warning_mutes enable row level security;
alter table coinops.executor_capacity_warning_mutes force row level security;
revoke all on coinops.executor_capacity_warning_mutes from public, anon, authenticated;
grant select, insert, delete on coinops.executor_capacity_warning_mutes to service_role;
commit;
