-- CoinOps BTC ladder redistribution.
--
-- Production lives in the shared OnPlay Platform project, isolated in the
-- `coinops` schema. This migration deliberately leaves SOL and the legacy
-- `public` CoinOps project unchanged.

-- Keep an exact, per-owner checksum before replacing the generated value.
-- The temporary relation disappears with the migration transaction.
create temporary table coinops_btc_ladder_equity_before as
select
  slot.product_id,
  slot.tenant_id,
  slot.user_id,
  count(*)::bigint as slot_count,
  sum(slot.operational_slot_value)::numeric(30, 8) as equity
from coinops.slots slot
group by slot.product_id, slot.tenant_id, slot.user_id;

alter table coinops.slots
  add column if not exists operational_gains numeric(20, 8),
  add column if not exists redistribution_received_usdt numeric(20, 8) not null default 0,
  add column if not exists redistribution_sent_usdt numeric(20, 8) not null default 0,
  add column if not exists position_notional_usdt numeric(20, 8),
  add column if not exists position_gain_unit_usdt numeric(20, 8),
  add column if not exists position_quantity numeric(30, 16),
  add column if not exists position_opened_at timestamptz,
  add column if not exists accounting_version bigint not null default 0;

update coinops.slots
set operational_gains = gains
where operational_gains is null;

alter table coinops.slots
  alter column operational_gains set default 0,
  alter column operational_gains set not null;

alter table coinops.slots
  drop constraint if exists slots_operational_gains_nonnegative,
  drop constraint if exists slots_redistribution_received_nonnegative,
  drop constraint if exists slots_redistribution_sent_nonnegative,
  drop constraint if exists slots_position_notional_nonnegative,
  drop constraint if exists slots_position_gain_unit_positive,
  drop constraint if exists slots_position_quantity_nonnegative,
  drop constraint if exists slots_accounting_version_nonnegative,
  drop constraint if exists slots_redistribution_within_capital;

alter table coinops.slots
  add constraint slots_operational_gains_nonnegative check (operational_gains >= 0),
  add constraint slots_redistribution_received_nonnegative check (redistribution_received_usdt >= 0),
  add constraint slots_redistribution_sent_nonnegative check (redistribution_sent_usdt >= 0),
  add constraint slots_position_notional_nonnegative check (position_notional_usdt is null or position_notional_usdt >= 0),
  add constraint slots_position_gain_unit_positive check (position_gain_unit_usdt is null or position_gain_unit_usdt > 0),
  add constraint slots_position_quantity_nonnegative check (position_quantity is null or position_quantity >= 0),
  add constraint slots_accounting_version_nonnegative check (accounting_version >= 0),
  add constraint slots_redistribution_within_capital check (
    redistribution_sent_usdt
      <= base_value + realized_profit + growth_contribution + redistribution_received_usdt
  );

-- A generated column cannot have its expression altered in place. Recreating
-- it is lossless because all of its source columns remain untouched.
alter table coinops.slots drop column operational_slot_value;
alter table coinops.slots
  add column operational_slot_value numeric(20, 8)
  generated always as (
    round(
      base_value
      + realized_profit
      + growth_contribution
      + redistribution_received_usdt
      - redistribution_sent_usdt,
      8
    )
  ) stored;

alter table coinops.slots
  add constraint slots_operational_value_nonnegative check (operational_slot_value >= 0);

do $equity_guard$
declare
  mismatch_count integer;
begin
  select count(*)::integer
    into mismatch_count
  from coinops_btc_ladder_equity_before before_state
  full join (
    select
      slot.product_id,
      slot.tenant_id,
      slot.user_id,
      count(*)::bigint as slot_count,
      sum(slot.operational_slot_value)::numeric(30, 8) as equity
    from coinops.slots slot
    group by slot.product_id, slot.tenant_id, slot.user_id
  ) after_state
    on after_state.product_id = before_state.product_id
   and after_state.tenant_id = before_state.tenant_id
   and after_state.user_id = before_state.user_id
  where before_state.product_id is null
     or after_state.product_id is null
     or before_state.slot_count is distinct from after_state.slot_count
     or before_state.equity is distinct from after_state.equity;

  if mismatch_count <> 0 then
    raise exception 'COINOPS_BTC_CUTOVER_EQUITY_MISMATCH';
  end if;
end;
$equity_guard$;

drop table coinops_btc_ladder_equity_before;

-- Freeze the economic notional of positions that were already open before
-- this accounting model. JSON slotValue is preferred; the current operational
-- value is an explicit fallback for imported events without that snapshot.
update coinops.slots slot
set
  position_notional_usdt = coalesce(
    (
      select nullif(
        substring(history.detail from '"slotValue"[[:space:]]*:[[:space:]]*([0-9]+([.][0-9]+)?)'),
        ''
      )::numeric
      from coinops.history_events history
      where history.product_id = slot.product_id
        and history.tenant_id = slot.tenant_id
        and history.user_id = slot.user_id
        and history.slot_id = slot.id
        and history.action = 'Abertura'
        and history.detail ~ '"slotValue"[[:space:]]*:'
      order by history.event_at desc, history.id desc
      limit 1
    ),
    slot.operational_slot_value
  ),
  position_gain_unit_usdt = round(
    (slot.base_value + slot.growth_contribution) * slot.gain_rate,
    8
  ),
  position_quantity = case
    when slot.preco_entrada is not null and slot.preco_entrada > 0 then
      round(
        coalesce(
          (
            select nullif(
              substring(history.detail from '"slotValue"[[:space:]]*:[[:space:]]*([0-9]+([.][0-9]+)?)'),
              ''
            )::numeric
            from coinops.history_events history
            where history.product_id = slot.product_id
              and history.tenant_id = slot.tenant_id
              and history.user_id = slot.user_id
              and history.slot_id = slot.id
              and history.action = 'Abertura'
              and history.detail ~ '"slotValue"[[:space:]]*:'
            order by history.event_at desc, history.id desc
            limit 1
          ),
          slot.operational_slot_value
        ) / slot.preco_entrada,
        16
      )
    else null
  end,
  position_opened_at = coalesce(
    (
      select history.event_at
      from coinops.history_events history
      where history.product_id = slot.product_id
        and history.tenant_id = slot.tenant_id
        and history.user_id = slot.user_id
        and history.slot_id = slot.id
        and history.action = 'Abertura'
      order by history.event_at desc, history.id desc
      limit 1
    ),
    slot.updated_at,
    slot.created_at
  )
where slot.status = 'aberto'
  and exists (
    select 1
    from coinops.strategies strategy
    where strategy.product_id = slot.product_id
      and strategy.tenant_id = slot.tenant_id
      and strategy.user_id = slot.user_id
      and strategy.id = slot.strategy_id
      and strategy.asset = 'BTC'
  )
  and slot.position_notional_usdt is null;

create table coinops.btc_redistribution_batches (
  id uuid primary key default gen_random_uuid(),
  product_code text not null default 'coinops' check (product_code = 'coinops'),
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  month_reference date not null,
  cycle_number integer not null check (cycle_number > 0),
  monthly_goal integer not null check (monthly_goal between 1 and 1000),
  reference_level numeric(20, 8) not null check (reference_level > 0),
  algorithm_version text not null default 'BTC_LADDER_ASSISTED_V1',
  status text not null check (status in ('PREPARED', 'CANCELLED', 'COMPLETED', 'STALE', 'FAILED')),
  prepare_idempotency_key uuid not null,
  confirm_idempotency_key uuid,
  snapshot_hash text not null check (char_length(snapshot_hash) = 64),
  ranking_before jsonb not null default '[]'::jsonb,
  ranking_after jsonb not null default '[]'::jsonb,
  equity_before numeric(20, 8) not null,
  equity_after numeric(20, 8) not null,
  equity_difference numeric(20, 8) not null,
  total_transferred_usdt numeric(20, 8) not null default 0 check (total_transferred_usdt >= 0),
  transfer_count integer not null default 0 check (transfer_count >= 0),
  result jsonb not null default '{}'::jsonb,
  created_by uuid not null,
  confirmed_by uuid,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  expires_at timestamptz not null default (timezone('utc', now()) + interval '24 hours'),
  completed_at timestamptz,
  cancelled_at timestamptz,
  constraint btc_redistribution_batches_product_fk
    foreign key (product_code, product_id) references public.products(code, id) on delete restrict,
  constraint btc_redistribution_batches_tenant_fk
    foreign key (product_id, tenant_id) references public.product_tenants(product_id, tenant_id) on delete restrict,
  unique (product_id, tenant_id, user_id, id),
  unique (product_id, tenant_id, user_id, prepare_idempotency_key),
  unique (product_id, tenant_id, user_id, confirm_idempotency_key),
  check (equity_after - equity_before = equity_difference),
  check (status <> 'COMPLETED' or equity_difference = 0),
  check (confirmed_by is null or status = 'COMPLETED'),
  check (completed_at is null or status = 'COMPLETED'),
  check (cancelled_at is null or status = 'CANCELLED')
);

create unique index btc_redistribution_batches_completed_month_uidx
  on coinops.btc_redistribution_batches (product_id, tenant_id, user_id, month_reference)
  where status = 'COMPLETED';

create index btc_redistribution_batches_scope_created_idx
  on coinops.btc_redistribution_batches (product_id, tenant_id, user_id, created_at desc);

create table coinops.btc_redistribution_transfers (
  id uuid primary key default gen_random_uuid(),
  product_code text not null default 'coinops' check (product_code = 'coinops'),
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  batch_id uuid not null,
  asset text not null default 'BTC' check (asset = 'BTC'),
  month_reference date not null,
  sequence_number integer not null check (sequence_number > 0),
  donor_slot_id uuid not null,
  receiver_slot_id uuid not null,
  donor_slot_number integer not null,
  receiver_slot_number integer not null,
  donor_status text not null,
  receiver_status text not null,
  donor_gain_unit_usdt numeric(20, 8) not null check (donor_gain_unit_usdt > 0),
  receiver_gain_unit_usdt numeric(20, 8) not null check (receiver_gain_unit_usdt > 0),
  donor_gain_equivalent numeric(20, 8) not null check (donor_gain_equivalent > 0),
  receiver_gain_equivalent numeric(20, 8) not null check (receiver_gain_equivalent > 0),
  amount_usdt numeric(20, 8) not null check (amount_usdt > 0),
  donor_operational_before numeric(20, 8) not null,
  donor_operational_after numeric(20, 8) not null,
  receiver_operational_before numeric(20, 8) not null,
  receiver_operational_after numeric(20, 8) not null,
  donor_value_before numeric(20, 8) not null,
  donor_value_after numeric(20, 8) not null,
  receiver_value_before numeric(20, 8) not null,
  receiver_value_after numeric(20, 8) not null,
  donor_real_gains integer not null,
  receiver_real_gains integer not null,
  created_by uuid not null,
  created_at timestamptz not null default timezone('utc', now()),
  constraint btc_redistribution_transfers_product_fk
    foreign key (product_code, product_id) references public.products(code, id) on delete restrict,
  constraint btc_redistribution_transfers_tenant_fk
    foreign key (product_id, tenant_id) references public.product_tenants(product_id, tenant_id) on delete restrict,
  constraint btc_redistribution_transfers_batch_fk
    foreign key (product_id, tenant_id, user_id, batch_id)
      references coinops.btc_redistribution_batches(product_id, tenant_id, user_id, id) on delete restrict,
  constraint btc_redistribution_transfers_donor_fk
    foreign key (product_id, tenant_id, user_id, donor_slot_id)
      references coinops.slots(product_id, tenant_id, user_id, id) on delete restrict,
  constraint btc_redistribution_transfers_receiver_fk
    foreign key (product_id, tenant_id, user_id, receiver_slot_id)
      references coinops.slots(product_id, tenant_id, user_id, id) on delete restrict,
  check (donor_slot_id <> receiver_slot_id),
  check (round(donor_operational_before - donor_operational_after, 8) = donor_gain_equivalent),
  check (round(receiver_operational_after - receiver_operational_before, 8) = receiver_gain_equivalent),
  check (round(donor_value_before - donor_value_after, 8) = amount_usdt),
  check (round(receiver_value_after - receiver_value_before, 8) = amount_usdt),
  unique (product_id, tenant_id, user_id, id),
  unique (product_id, tenant_id, user_id, batch_id, sequence_number)
);

create index btc_redistribution_transfers_scope_batch_idx
  on coinops.btc_redistribution_transfers (product_id, tenant_id, user_id, batch_id, sequence_number);
create index btc_redistribution_transfers_scope_donor_idx
  on coinops.btc_redistribution_transfers (product_id, tenant_id, user_id, donor_slot_id);
create index btc_redistribution_transfers_scope_receiver_idx
  on coinops.btc_redistribution_transfers (product_id, tenant_id, user_id, receiver_slot_id);

create table coinops.btc_external_contributions (
  id uuid primary key default gen_random_uuid(),
  product_code text not null default 'coinops' check (product_code = 'coinops'),
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  slot_id uuid not null,
  slot_number integer not null,
  idempotency_key uuid not null,
  amount_usdt numeric(20, 8) not null check (amount_usdt > 0),
  gain_unit_before_usdt numeric(20, 8) not null check (gain_unit_before_usdt > 0),
  gain_unit_after_usdt numeric(20, 8) not null check (gain_unit_after_usdt > 0),
  gain_equivalent numeric(20, 8) not null check (gain_equivalent > 0),
  operational_before numeric(20, 8) not null,
  operational_after numeric(20, 8) not null,
  value_before numeric(20, 8) not null,
  value_after numeric(20, 8) not null,
  reason text not null check (char_length(btrim(reason)) between 1 and 500),
  applied_by uuid not null,
  result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  constraint btc_external_contributions_product_fk
    foreign key (product_code, product_id) references public.products(code, id) on delete restrict,
  constraint btc_external_contributions_tenant_fk
    foreign key (product_id, tenant_id) references public.product_tenants(product_id, tenant_id) on delete restrict,
  constraint btc_external_contributions_slot_fk
    foreign key (product_id, tenant_id, user_id, slot_id)
      references coinops.slots(product_id, tenant_id, user_id, id) on delete restrict,
  check (round(operational_after - operational_before, 8) = gain_equivalent),
  check (round(value_after - value_before, 8) = amount_usdt),
  unique (product_id, tenant_id, user_id, id),
  unique (product_id, tenant_id, user_id, idempotency_key)
);

create index btc_external_contributions_scope_created_idx
  on coinops.btc_external_contributions (product_id, tenant_id, user_id, created_at desc);
create index btc_external_contributions_scope_slot_created_idx
  on coinops.btc_external_contributions (product_id, tenant_id, user_id, slot_id, created_at desc);

create table coinops.slot_capital_ledger (
  id uuid primary key default gen_random_uuid(),
  product_code text not null default 'coinops' check (product_code = 'coinops'),
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  slot_id uuid not null,
  batch_id uuid,
  transfer_id uuid,
  external_contribution_id uuid,
  entry_type text not null check (entry_type in (
    'OPENING_BALANCE', 'REAL_GAIN', 'REDISTRIBUTION_DEBIT',
    'REDISTRIBUTION_CREDIT', 'EXTERNAL_CONTRIBUTION'
  )),
  amount_usdt numeric(20, 8) not null,
  operational_gain_delta numeric(20, 8) not null,
  operational_before numeric(20, 8) not null,
  operational_after numeric(20, 8) not null,
  value_before numeric(20, 8) not null,
  value_after numeric(20, 8) not null,
  gain_unit_before_usdt numeric(20, 8),
  gain_unit_after_usdt numeric(20, 8),
  redistribution_received_before numeric(20, 8) not null,
  redistribution_received_after numeric(20, 8) not null,
  redistribution_sent_before numeric(20, 8) not null,
  redistribution_sent_after numeric(20, 8) not null,
  real_gains_snapshot integer not null,
  added_gains_snapshot integer not null,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid not null,
  created_at timestamptz not null default timezone('utc', now()),
  constraint slot_capital_ledger_product_fk
    foreign key (product_code, product_id) references public.products(code, id) on delete restrict,
  constraint slot_capital_ledger_tenant_fk
    foreign key (product_id, tenant_id) references public.product_tenants(product_id, tenant_id) on delete restrict,
  constraint slot_capital_ledger_slot_fk
    foreign key (product_id, tenant_id, user_id, slot_id)
      references coinops.slots(product_id, tenant_id, user_id, id) on delete restrict,
  constraint slot_capital_ledger_batch_fk
    foreign key (product_id, tenant_id, user_id, batch_id)
      references coinops.btc_redistribution_batches(product_id, tenant_id, user_id, id) on delete restrict,
  constraint slot_capital_ledger_transfer_fk
    foreign key (product_id, tenant_id, user_id, transfer_id)
      references coinops.btc_redistribution_transfers(product_id, tenant_id, user_id, id) on delete restrict,
  constraint slot_capital_ledger_contribution_fk
    foreign key (product_id, tenant_id, user_id, external_contribution_id)
      references coinops.btc_external_contributions(product_id, tenant_id, user_id, id) on delete restrict,
  unique (product_id, tenant_id, user_id, id),
  check (
    (entry_type in ('REDISTRIBUTION_DEBIT', 'REDISTRIBUTION_CREDIT') and batch_id is not null and transfer_id is not null)
    or (entry_type = 'EXTERNAL_CONTRIBUTION' and external_contribution_id is not null)
    or (entry_type in ('OPENING_BALANCE', 'REAL_GAIN'))
  ),
  check (round(operational_after - operational_before, 8) = operational_gain_delta),
  check (round(value_after - value_before, 8) = amount_usdt),
  check (
    (entry_type = 'OPENING_BALANCE' and amount_usdt >= 0 and operational_gain_delta >= 0)
    or (entry_type = 'REAL_GAIN' and amount_usdt > 0 and operational_gain_delta = 1)
    or (entry_type = 'REDISTRIBUTION_DEBIT' and amount_usdt < 0 and operational_gain_delta < 0)
    or (entry_type in ('REDISTRIBUTION_CREDIT', 'EXTERNAL_CONTRIBUTION')
      and amount_usdt > 0 and operational_gain_delta > 0)
  )
);

create index slot_capital_ledger_scope_slot_created_idx
  on coinops.slot_capital_ledger (product_id, tenant_id, user_id, slot_id, created_at desc);
create index slot_capital_ledger_scope_batch_idx
  on coinops.slot_capital_ledger (product_id, tenant_id, user_id, batch_id, created_at);
create unique index slot_capital_ledger_opening_balance_uidx
  on coinops.slot_capital_ledger (product_id, tenant_id, user_id, slot_id, entry_type)
  where entry_type = 'OPENING_BALANCE';
create unique index slot_capital_ledger_transfer_entry_uidx
  on coinops.slot_capital_ledger (product_id, tenant_id, user_id, transfer_id, entry_type)
  where transfer_id is not null;
create unique index slot_capital_ledger_external_entry_uidx
  on coinops.slot_capital_ledger (product_id, tenant_id, user_id, external_contribution_id, entry_type)
  where external_contribution_id is not null;

create table coinops.growth_plan_goal_audit (
  id uuid primary key default gen_random_uuid(),
  product_code text not null default 'coinops' check (product_code = 'coinops'),
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  asset text not null check (asset = 'BTC'),
  previous_goal integer check (previous_goal is null or previous_goal between 1 and 1000),
  new_goal integer not null check (new_goal between 1 and 1000),
  changed_by uuid not null,
  created_at timestamptz not null default timezone('utc', now()),
  constraint growth_plan_goal_audit_product_fk
    foreign key (product_code, product_id) references public.products(code, id) on delete restrict,
  constraint growth_plan_goal_audit_tenant_fk
    foreign key (product_id, tenant_id) references public.product_tenants(product_id, tenant_id) on delete restrict,
  unique (product_id, tenant_id, user_id, id)
);

create index growth_plan_goal_audit_scope_created_idx
  on coinops.growth_plan_goal_audit (product_id, tenant_id, user_id, created_at desc);

-- Existing scope trigger is reused so every new row remains tied to the one
-- active CoinOps membership of the authenticated user.
create trigger coinops_scope_btc_redistribution_batches_v1
before insert or update on coinops.btc_redistribution_batches
for each row execute function private.coinops_apply_authenticated_scope();

create trigger btc_redistribution_batches_touch_updated_at
before update on coinops.btc_redistribution_batches
for each row execute function private.coinops_touch_updated_at();

create trigger coinops_scope_btc_redistribution_transfers_v1
before insert or update on coinops.btc_redistribution_transfers
for each row execute function private.coinops_apply_authenticated_scope();

create trigger coinops_scope_btc_external_contributions_v1
before insert or update on coinops.btc_external_contributions
for each row execute function private.coinops_apply_authenticated_scope();

create trigger coinops_scope_slot_capital_ledger_v1
before insert or update on coinops.slot_capital_ledger
for each row execute function private.coinops_apply_authenticated_scope();

create trigger coinops_scope_growth_plan_goal_audit_v1
before insert or update on coinops.growth_plan_goal_audit
for each row execute function private.coinops_apply_authenticated_scope();

alter table coinops.btc_redistribution_batches enable row level security;
alter table coinops.btc_redistribution_batches force row level security;
alter table coinops.btc_redistribution_transfers enable row level security;
alter table coinops.btc_redistribution_transfers force row level security;
alter table coinops.btc_external_contributions enable row level security;
alter table coinops.btc_external_contributions force row level security;
alter table coinops.slot_capital_ledger enable row level security;
alter table coinops.slot_capital_ledger force row level security;
alter table coinops.growth_plan_goal_audit enable row level security;
alter table coinops.growth_plan_goal_audit force row level security;

create policy btc_redistribution_batches_owner_select
on coinops.btc_redistribution_batches for select to authenticated
using (private.coinops_can_access_row(product_id, tenant_id, user_id));

create policy btc_redistribution_transfers_owner_select
on coinops.btc_redistribution_transfers for select to authenticated
using (private.coinops_can_access_row(product_id, tenant_id, user_id));

create policy btc_external_contributions_owner_select
on coinops.btc_external_contributions for select to authenticated
using (private.coinops_can_access_row(product_id, tenant_id, user_id));

create policy slot_capital_ledger_owner_select
on coinops.slot_capital_ledger for select to authenticated
using (private.coinops_can_access_row(product_id, tenant_id, user_id));

create policy growth_plan_goal_audit_owner_select
on coinops.growth_plan_goal_audit for select to authenticated
using (private.coinops_can_access_row(product_id, tenant_id, user_id));

revoke all on table coinops.btc_redistribution_batches from public, anon, authenticated;
revoke all on table coinops.btc_redistribution_transfers from public, anon, authenticated;
revoke all on table coinops.btc_external_contributions from public, anon, authenticated;
revoke all on table coinops.slot_capital_ledger from public, anon, authenticated;
revoke all on table coinops.growth_plan_goal_audit from public, anon, authenticated;

grant select on table coinops.btc_redistribution_batches to authenticated, service_role;
grant select on table coinops.btc_redistribution_transfers to authenticated, service_role;
grant select on table coinops.btc_external_contributions to authenticated, service_role;
grant select on table coinops.slot_capital_ledger to authenticated, service_role;
grant select on table coinops.growth_plan_goal_audit to authenticated, service_role;

create or replace function private.coinops_current_scope()
returns table(product_id uuid, tenant_id uuid, user_id uuid)
language plpgsql
security definer
stable
set search_path = ''
as $scope$
declare
  authenticated_user_id uuid := (select auth.uid());
  matched_count integer;
begin
  if authenticated_user_id is null then
    raise exception 'COINOPS_AUTH_REQUIRED';
  end if;

  select count(*)::integer
    into matched_count
  from public.product_memberships membership
  join public.products product on product.id = membership.product_id
  join public.product_tenants tenant_link
    on tenant_link.product_id = membership.product_id
   and tenant_link.tenant_id = membership.tenant_id
  join public.platform_tenants tenant on tenant.id = tenant_link.tenant_id
  where membership.user_id = authenticated_user_id
    and membership.status = 'active'
    and membership.role_key in ('coinops.owner', 'coinops.operator')
    and product.code = 'coinops'
    and product.product_type = 'internal'
    and product.status = 'active'
    and tenant_link.status = 'active'
    and tenant.status = 'active';

  if matched_count = 0 then
    raise exception 'COINOPS_ACTIVE_INTERNAL_MEMBERSHIP_REQUIRED';
  end if;
  if matched_count <> 1 then
    raise exception 'COINOPS_TENANT_CONTEXT_AMBIGUOUS';
  end if;

  return query
  select membership.product_id, membership.tenant_id, authenticated_user_id
  from public.product_memberships membership
  join public.products product on product.id = membership.product_id
  join public.product_tenants tenant_link
    on tenant_link.product_id = membership.product_id
   and tenant_link.tenant_id = membership.tenant_id
  join public.platform_tenants tenant on tenant.id = tenant_link.tenant_id
  where membership.user_id = authenticated_user_id
    and membership.status = 'active'
    and membership.role_key in ('coinops.owner', 'coinops.operator')
    and product.code = 'coinops'
    and product.product_type = 'internal'
    and product.status = 'active'
    and tenant_link.status = 'active'
    and tenant.status = 'active'
  order by membership.created_at
  limit 1;
end;
$scope$;

create or replace function private.coinops_gain_unit_usdt(
  base_value numeric,
  growth_contribution numeric,
  gain_rate numeric
)
returns numeric
language sql
immutable
strict
set search_path = ''
as $gain_unit$
  select round((base_value + growth_contribution) * gain_rate, 8);
$gain_unit$;

create or replace function private.coinops_capture_btc_position_snapshot()
returns trigger
language plpgsql
security definer
set search_path = ''
as $position$
declare
  asset_code text;
  calculated_notional numeric(20, 8);
begin
  select strategy.asset
    into asset_code
  from coinops.strategies strategy
  where strategy.product_id = new.product_id
    and strategy.tenant_id = new.tenant_id
    and strategy.user_id = new.user_id
    and strategy.id = new.strategy_id;

  if asset_code <> 'BTC' or new.status <> 'aberto' then
    return new;
  end if;

  if tg_op = 'UPDATE' and old.status = 'aberto' then
    return new;
  end if;

  calculated_notional := case
    when tg_op = 'UPDATE' then old.operational_slot_value
    else round(
      new.base_value
      + new.realized_profit
      + new.growth_contribution
      + new.redistribution_received_usdt
      - new.redistribution_sent_usdt,
      8
    )
  end;

  if calculated_notional is null or calculated_notional < 0 then
    raise exception 'COINOPS_BTC_POSITION_NOTIONAL_INVALID';
  end if;

  new.position_notional_usdt := calculated_notional;
  new.position_gain_unit_usdt := private.coinops_gain_unit_usdt(
    new.base_value,
    new.growth_contribution,
    new.gain_rate
  );
  new.position_quantity := case
    when new.preco_entrada is not null and new.preco_entrada > 0 then
      round(calculated_notional / new.preco_entrada, 16)
    else null
  end;
  new.position_opened_at := timezone('utc', now());

  if new.position_gain_unit_usdt is null or new.position_gain_unit_usdt <= 0 then
    raise exception 'COINOPS_BTC_GAIN_UNIT_INVALID';
  end if;

  return new;
end;
$position$;

create or replace function private.coinops_apply_realized_profit_on_real_gain()
returns trigger
language plpgsql
security definer
set search_path = ''
as $profit$
declare
  asset_code text;
  gain_unit numeric(20, 8);
begin
  select strategy.asset
    into asset_code
  from coinops.strategies strategy
  where strategy.product_id = new.product_id
    and strategy.tenant_id = new.tenant_id
    and strategy.user_id = new.user_id
    and strategy.id = new.strategy_id;

  if asset_code = 'BTC' then
    if old.status = 'aberto'
      and new.status = 'gain'
      and new.real_gains = old.real_gains + 1
      and new.added_gains = old.added_gains
      and new.gains = old.gains + 1 then
      gain_unit := coalesce(
        old.position_gain_unit_usdt,
        private.coinops_gain_unit_usdt(old.base_value, old.growth_contribution, old.gain_rate)
      );
      if gain_unit is null or gain_unit <= 0 then
        raise exception 'COINOPS_BTC_GAIN_UNIT_INVALID';
      end if;

      new.realized_profit := round(old.realized_profit + gain_unit, 8);
      new.operational_gains := round(old.operational_gains + 1, 8);
      new.accounting_version := old.accounting_version + 1;
    end if;
  else
    -- SOL retains the existing behavior and is outside this feature scope.
    if new.gains is distinct from old.gains then
      new.operational_gains := new.gains;
    end if;
    if new.gains > old.gains then
      new.realized_profit := round(
        (new.base_value + new.growth_contribution) * new.gain_rate * new.gains,
        8
      );
    end if;
  end if;

  return new;
end;
$profit$;

create or replace function private.coinops_enforce_slot_gain_breakdown()
returns trigger
language plpgsql
set search_path = ''
as $gain_breakdown$
declare
  asset_code text;
  strategy_base_value numeric;
  strategy_gain_rate numeric;
  internal_capital_mutation boolean := current_user = pg_catalog.pg_get_userbyid(
    (select relation.relowner from pg_catalog.pg_class relation where relation.oid = tg_relid)
  );
  valid_real_gain boolean := false;
  valid_open_snapshot boolean := false;
  isolated_strategy_rate_sync boolean := false;
  valid_strategy_rate_sync boolean := false;
  expected_real_gain_unit numeric(20, 8);
begin
  if new.gains <> new.real_gains + new.added_gains then
    raise exception 'COINOPS_GAIN_BREAKDOWN_INVALID';
  end if;

  select strategy.asset, strategy.base_value, strategy.gain_rate
    into asset_code, strategy_base_value, strategy_gain_rate
  from coinops.strategies strategy
  where strategy.product_id = new.product_id
    and strategy.tenant_id = new.tenant_id
    and strategy.user_id = new.user_id
    and strategy.id = new.strategy_id;

  if asset_code is null then
    raise exception 'COINOPS_SLOT_STRATEGY_SCOPE_INVALID';
  end if;

  if tg_op = 'INSERT' then
    if asset_code = 'BTC'
      and not internal_capital_mutation
      and (
        new.base_value is distinct from strategy_base_value
        or new.gain_rate is distinct from strategy_gain_rate
        or new.real_gains <> 0
        or new.added_gains <> 0
        or new.gains <> 0
        or new.operational_gains <> 0
        or new.realized_profit <> 0
        or new.growth_contribution <> 0
        or new.redistribution_received_usdt <> 0
        or new.redistribution_sent_usdt <> 0
        or new.accounting_version <> 0
      ) then
      raise exception 'COINOPS_BTC_INITIAL_CAPITAL_REQUIRES_SERVER_VALUES';
    end if;
    return new;
  end if;

  valid_real_gain :=
    old.status = 'aberto'
    and new.status = 'gain'
    and new.real_gains = old.real_gains + 1
    and new.added_gains = old.added_gains
    and new.gains = old.gains + 1;

  if asset_code = 'BTC' then
    if valid_real_gain then
      expected_real_gain_unit := coalesce(
        old.position_gain_unit_usdt,
        round((old.base_value + old.growth_contribution) * old.gain_rate, 8)
      );
      valid_real_gain :=
        expected_real_gain_unit is not null
        and expected_real_gain_unit > 0
        and new.base_value is not distinct from old.base_value
        and (
          new.gain_rate is not distinct from old.gain_rate
          or new.gain_rate = strategy_gain_rate
        )
        and new.growth_contribution is not distinct from old.growth_contribution
        and new.redistribution_received_usdt is not distinct from old.redistribution_received_usdt
        and new.redistribution_sent_usdt is not distinct from old.redistribution_sent_usdt
        and new.realized_profit = round(old.realized_profit + expected_real_gain_unit, 8)
        and new.operational_gains = round(old.operational_gains + 1, 8)
        and new.accounting_version = old.accounting_version + 1
        and new.position_notional_usdt is not distinct from old.position_notional_usdt
        and new.position_gain_unit_usdt is not distinct from old.position_gain_unit_usdt
        and new.position_quantity is not distinct from old.position_quantity
        and new.position_opened_at is not distinct from old.position_opened_at;
    end if;

    if new.real_gains < old.real_gains then
      raise exception 'COINOPS_BTC_REAL_GAINS_IMMUTABLE';
    end if;
    if new.real_gains <> old.real_gains and not valid_real_gain then
      raise exception 'COINOPS_REAL_GAINS_REQUIRE_SLOT_CLOSE';
    end if;
    if new.added_gains <> old.added_gains then
      raise exception 'COINOPS_BTC_ADDED_GAINS_LEGACY_READ_ONLY';
    end if;

    valid_open_snapshot :=
      old.status <> 'aberto'
      and new.status = 'aberto'
      and new.position_notional_usdt is not null
      and new.position_notional_usdt = old.operational_slot_value
      and new.position_gain_unit_usdt is not null
      and new.position_gain_unit_usdt > 0
      and new.position_opened_at is not null;

    isolated_strategy_rate_sync :=
      new.gain_rate = strategy_gain_rate
      and new.status is not distinct from old.status
      and new.gains is not distinct from old.gains
      and new.real_gains is not distinct from old.real_gains
      and new.added_gains is not distinct from old.added_gains
      and new.base_value is not distinct from old.base_value
      and new.realized_profit is not distinct from old.realized_profit
      and new.growth_contribution is not distinct from old.growth_contribution
      and new.operational_gains is not distinct from old.operational_gains
      and new.redistribution_received_usdt is not distinct from old.redistribution_received_usdt
      and new.redistribution_sent_usdt is not distinct from old.redistribution_sent_usdt
      and new.position_notional_usdt is not distinct from old.position_notional_usdt
      and new.position_gain_unit_usdt is not distinct from old.position_gain_unit_usdt
      and new.position_quantity is not distinct from old.position_quantity
      and new.position_opened_at is not distinct from old.position_opened_at
      and new.accounting_version is not distinct from old.accounting_version;

    valid_strategy_rate_sync :=
      new.gain_rate = strategy_gain_rate
      and (isolated_strategy_rate_sync or valid_real_gain or valid_open_snapshot);

    if old.status = 'aberto' and new.status = 'gain' and not valid_real_gain then
      raise exception 'COINOPS_BTC_CLOSE_REQUIRES_EXACT_REAL_GAIN';
    end if;

    if new.base_value is distinct from old.base_value
      and not internal_capital_mutation then
      raise exception 'COINOPS_BTC_BASE_VALUE_REQUIRES_RPC';
    end if;

    if new.gain_rate is distinct from old.gain_rate
      and not internal_capital_mutation
      and not valid_strategy_rate_sync then
      raise exception 'COINOPS_BTC_GAIN_RATE_REQUIRES_RPC';
    end if;

    if (
      new.operational_gains is distinct from old.operational_gains
      or new.redistribution_received_usdt is distinct from old.redistribution_received_usdt
      or new.redistribution_sent_usdt is distinct from old.redistribution_sent_usdt
      or new.growth_contribution is distinct from old.growth_contribution
      or new.realized_profit is distinct from old.realized_profit
      or new.accounting_version is distinct from old.accounting_version
    ) and not internal_capital_mutation and not valid_real_gain then
      raise exception 'COINOPS_BTC_CAPITAL_MUTATION_REQUIRES_RPC';
    end if;

    if (
      new.position_notional_usdt is distinct from old.position_notional_usdt
      or new.position_gain_unit_usdt is distinct from old.position_gain_unit_usdt
      or new.position_quantity is distinct from old.position_quantity
      or new.position_opened_at is distinct from old.position_opened_at
    ) and not internal_capital_mutation and not valid_open_snapshot and not valid_real_gain then
      raise exception 'COINOPS_BTC_POSITION_SNAPSHOT_INVALID';
    end if;
  else
    if new.real_gains <> old.real_gains
      and not valid_real_gain
      and not (
        new.status = 'zerado'
        and new.gains = 0
        and new.real_gains = 0
        and new.added_gains = 0
      ) then
      raise exception 'COINOPS_REAL_GAINS_REQUIRE_SLOT_CLOSE';
    end if;
    if new.added_gains < old.added_gains
      and not (new.status = 'zerado' and new.gains = 0 and new.real_gains = 0 and new.added_gains = 0) then
      raise exception 'COINOPS_ADDED_GAINS_CANNOT_DECREASE_WITHOUT_RESET';
    end if;
    if new.added_gains <> old.added_gains
      and old.status not in ('gain', 'zerado')
      and not (new.status = 'zerado' and new.gains = 0 and new.real_gains = 0 and new.added_gains = 0) then
      raise exception 'COINOPS_ADDED_GAINS_REQUIRE_CLOSED_SLOT';
    end if;
  end if;

  return new;
end;
$gain_breakdown$;

drop trigger if exists slots_apply_realized_profit_on_real_gain on coinops.slots;
create trigger slots_apply_realized_profit_on_real_gain
before update of gains on coinops.slots
for each row execute function private.coinops_apply_realized_profit_on_real_gain();

drop trigger if exists slots_capture_btc_position_snapshot on coinops.slots;
create trigger slots_capture_btc_position_snapshot
before insert or update of status, preco_entrada, base_value, gain_rate on coinops.slots
for each row execute function private.coinops_capture_btc_position_snapshot();

drop trigger if exists slots_enforce_gain_breakdown on coinops.slots;
create trigger slots_enforce_gain_breakdown
before insert or update of gains, real_gains, added_gains, status,
  operational_gains, redistribution_received_usdt, redistribution_sent_usdt,
  base_value, gain_rate, growth_contribution, realized_profit,
  position_notional_usdt, position_gain_unit_usdt, position_quantity,
  position_opened_at, accounting_version
on coinops.slots
for each row execute function private.coinops_enforce_slot_gain_breakdown();

create or replace function private.coinops_protect_strategy_asset()
returns trigger
language plpgsql
set search_path = ''
as $strategy_asset$
declare
  internal_strategy_mutation boolean := current_user = pg_catalog.pg_get_userbyid(
    (select relation.relowner from pg_catalog.pg_class relation where relation.oid = tg_relid)
  );
begin
  if new.asset is distinct from old.asset
    and exists (
      select 1
      from coinops.slots slot
      where slot.product_id = old.product_id
        and slot.tenant_id = old.tenant_id
        and slot.user_id = old.user_id
        and slot.strategy_id = old.id
    ) then
    raise exception 'COINOPS_STRATEGY_ASSET_IMMUTABLE_WITH_SLOTS';
  end if;
  if old.asset = 'BTC'
    and not internal_strategy_mutation
    and (
      new.base_value is distinct from old.base_value
      or new.gain_rate is distinct from old.gain_rate
    ) then
    raise exception 'COINOPS_BTC_STRATEGY_CAPITAL_CONFIG_REQUIRES_RPC';
  end if;
  return new;
end;
$strategy_asset$;

drop trigger if exists strategies_protect_asset_with_slots on coinops.strategies;
create trigger strategies_protect_asset_with_slots
before update of asset, base_value, gain_rate on coinops.strategies
for each row execute function private.coinops_protect_strategy_asset();

create or replace function private.coinops_record_btc_real_gain()
returns trigger
language plpgsql
security definer
set search_path = ''
as $ledger$
declare
  asset_code text;
begin
  select strategy.asset
    into asset_code
  from coinops.strategies strategy
  where strategy.product_id = new.product_id
    and strategy.tenant_id = new.tenant_id
    and strategy.user_id = new.user_id
    and strategy.id = new.strategy_id;

  if asset_code = 'BTC'
    and old.status = 'aberto'
    and new.status = 'gain'
    and new.real_gains = old.real_gains + 1
    and new.added_gains = old.added_gains
    and new.gains = old.gains + 1 then
    insert into coinops.slot_capital_ledger (
      product_code, product_id, tenant_id, user_id, slot_id, entry_type,
      amount_usdt, operational_gain_delta, operational_before, operational_after,
      value_before, value_after, gain_unit_before_usdt, gain_unit_after_usdt,
      redistribution_received_before,
      redistribution_received_after, redistribution_sent_before,
      redistribution_sent_after, real_gains_snapshot, added_gains_snapshot,
      metadata, created_by
    ) values (
      'coinops', new.product_id, new.tenant_id, new.user_id, new.id, 'REAL_GAIN',
      round(new.operational_slot_value - old.operational_slot_value, 8),
      round(new.operational_gains - old.operational_gains, 8),
      old.operational_gains, new.operational_gains,
      old.operational_slot_value, new.operational_slot_value,
      coalesce(
        old.position_gain_unit_usdt,
        private.coinops_gain_unit_usdt(old.base_value, old.growth_contribution, old.gain_rate)
      ),
      coalesce(
        old.position_gain_unit_usdt,
        private.coinops_gain_unit_usdt(old.base_value, old.growth_contribution, old.gain_rate)
      ),
      old.redistribution_received_usdt, new.redistribution_received_usdt,
      old.redistribution_sent_usdt, new.redistribution_sent_usdt,
      new.real_gains, new.added_gains,
      jsonb_build_object(
        'positionNotionalUsdt', old.position_notional_usdt,
        'positionGainUnitUsdt', old.position_gain_unit_usdt,
        'positionQuantity', old.position_quantity,
        'positionOpenedAt', old.position_opened_at,
        'statusBefore', old.status,
        'statusAfter', new.status
      ),
      coalesce((select auth.uid()), new.user_id)
    );
  end if;

  return new;
end;
$ledger$;

drop trigger if exists slots_record_btc_real_gain on coinops.slots;
create trigger slots_record_btc_real_gain
after update of gains, real_gains, status on coinops.slots
for each row execute function private.coinops_record_btc_real_gain();

create or replace function private.coinops_audit_btc_growth_goal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $audit$
begin
  if tg_op = 'INSERT' or new.btc_monthly_goal is distinct from old.btc_monthly_goal then
    insert into coinops.growth_plan_goal_audit (
      product_code, product_id, tenant_id, user_id, asset,
      previous_goal, new_goal, changed_by
    ) values (
      'coinops', new.product_id, new.tenant_id, new.user_id, 'BTC',
      case when tg_op = 'INSERT' then null else old.btc_monthly_goal end,
      new.btc_monthly_goal,
      coalesce((select auth.uid()), new.user_id)
    );
  end if;
  return new;
end;
$audit$;

drop trigger if exists growth_plan_settings_audit_btc_goal on coinops.growth_plan_settings;
create trigger growth_plan_settings_audit_btc_goal
after insert or update of btc_monthly_goal on coinops.growth_plan_settings
for each row execute function private.coinops_audit_btc_growth_goal();

-- Baseline is append-only and records exactly what existed at cutover. Legacy
-- added gains are identified but never reclassified as external contributions.
insert into coinops.slot_capital_ledger (
  product_code, product_id, tenant_id, user_id, slot_id, entry_type,
  amount_usdt, operational_gain_delta, operational_before, operational_after,
  value_before, value_after, gain_unit_before_usdt, gain_unit_after_usdt,
  redistribution_received_before,
  redistribution_received_after, redistribution_sent_before,
  redistribution_sent_after, real_gains_snapshot, added_gains_snapshot,
  metadata, created_by
)
select
  'coinops', slot.product_id, slot.tenant_id, slot.user_id, slot.id,
  'OPENING_BALANCE', slot.operational_slot_value, slot.operational_gains,
  0, slot.operational_gains, 0, slot.operational_slot_value,
  private.coinops_gain_unit_usdt(slot.base_value, slot.growth_contribution, slot.gain_rate),
  private.coinops_gain_unit_usdt(slot.base_value, slot.growth_contribution, slot.gain_rate),
  0, slot.redistribution_received_usdt, 0, slot.redistribution_sent_usdt,
  slot.real_gains, slot.added_gains,
  jsonb_build_object(
    'schemaVersion', 1,
    'source', 'BTC_LADDER_CUTOVER',
    'legacyGains', slot.gains,
    'legacyAddedGains', slot.added_gains,
    'legacyAddedClassification', case when slot.added_gains > 0 then 'LEGACY_UNVERIFIED' else 'NONE' end,
    'status', slot.status,
    'positionNotionalUsdt', slot.position_notional_usdt,
    'positionGainUnitUsdt', slot.position_gain_unit_usdt,
    'positionQuantity', slot.position_quantity,
    'positionOpenedAt', slot.position_opened_at
  ),
  slot.user_id
from coinops.slots slot
join coinops.strategies strategy
  on strategy.product_id = slot.product_id
 and strategy.tenant_id = slot.tenant_id
 and strategy.user_id = slot.user_id
 and strategy.id = slot.strategy_id
where strategy.asset = 'BTC'
on conflict do nothing;

-- Canonical server-side preview. The ordering is deterministic: donors follow
-- the operational ranking, while receivers closest to the assisted reference
-- are completed first. Slot status is intentionally not a filter.
create or replace function private.coinops_build_btc_ladder_preview(
  p_product_id uuid,
  p_tenant_id uuid,
  p_user_id uuid,
  p_reference_level numeric
)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $preview$
declare
  algorithm_version constant text := 'BTC_LADDER_ASSISTED_V1';
  state_by_slot jsonb := '{}'::jsonb;
  ranking_before jsonb := '[]'::jsonb;
  ranking_after jsonb := '[]'::jsonb;
  donors jsonb := '[]'::jsonb;
  receivers jsonb := '[]'::jsonb;
  transfers jsonb := '[]'::jsonb;
  snapshot_payload jsonb;
  snapshot_hash text;
  slot_record record;
  donor_record record;
  receiver_record record;
  donor_state jsonb;
  receiver_state jsonb;
  gain_unit numeric(20, 8);
  donor_operational_before numeric(20, 8);
  donor_operational_after numeric(20, 8);
  receiver_operational_before numeric(20, 8);
  receiver_operational_after numeric(20, 8);
  donor_value_before numeric(20, 8);
  donor_value_after numeric(20, 8);
  receiver_value_before numeric(20, 8);
  receiver_value_after numeric(20, 8);
  donor_gain_unit numeric(20, 8);
  receiver_gain_unit numeric(20, 8);
  donor_excess numeric(20, 8);
  receiver_deficit numeric(20, 8);
  donor_capacity_usdt numeric(20, 8);
  receiver_need_usdt numeric(20, 8);
  amount_usdt numeric(20, 8);
  donor_gain_equivalent numeric(20, 8);
  receiver_gain_equivalent numeric(20, 8);
  equity_before numeric(20, 8) := 0;
  equity_after numeric(20, 8) := 0;
  equity_difference numeric(20, 8) := 0;
  total_transferred_usdt numeric(20, 8) := 0;
  available_excess_gains numeric(20, 8) := 0;
  available_excess_usdt numeric(20, 8) := 0;
  remaining_excess_gains numeric(20, 8) := 0;
  remaining_excess_usdt numeric(20, 8) := 0;
  remaining_deficit_gains numeric(20, 8) := 0;
  remaining_deficit_usdt numeric(20, 8) := 0;
  transfer_count integer := 0;
begin
  if p_product_id is null or p_tenant_id is null or p_user_id is null then
    raise exception 'COINOPS_SCOPE_REQUIRED';
  end if;
  if p_reference_level is not null and p_reference_level <= 0 then
    raise exception 'COINOPS_BTC_REFERENCE_MUST_BE_POSITIVE';
  end if;

  for slot_record in
    select
      slot.id,
      slot.slot_number,
      slot.sort_order,
      slot.status,
      slot.real_gains,
      slot.added_gains,
      slot.operational_gains,
      slot.operational_slot_value,
      slot.accounting_version,
      slot.base_value,
      slot.growth_contribution,
      slot.gain_rate,
      slot.position_notional_usdt,
      slot.position_gain_unit_usdt,
      slot.position_quantity,
      slot.preco_entrada,
      slot.preco_alvo,
      slot.position_opened_at
    from coinops.slots slot
    join coinops.strategies strategy
      on strategy.product_id = slot.product_id
     and strategy.tenant_id = slot.tenant_id
     and strategy.user_id = slot.user_id
     and strategy.id = slot.strategy_id
    where slot.product_id = p_product_id
      and slot.tenant_id = p_tenant_id
      and slot.user_id = p_user_id
      and strategy.asset = 'BTC'
    order by slot.operational_gains desc, slot.slot_number, slot.sort_order, slot.id
  loop
    gain_unit := private.coinops_gain_unit_usdt(
      slot_record.base_value,
      slot_record.growth_contribution,
      slot_record.gain_rate
    );
    if gain_unit is null or gain_unit <= 0 then
      raise exception 'COINOPS_BTC_GAIN_UNIT_INVALID_FOR_SLOT:%', slot_record.id;
    end if;
    if slot_record.operational_gains < 0 or slot_record.operational_slot_value < 0 then
      raise exception 'COINOPS_BTC_OPERATIONAL_STATE_INVALID_FOR_SLOT:%', slot_record.id;
    end if;

    state_by_slot := state_by_slot || jsonb_build_object(
      slot_record.id::text,
      jsonb_build_object(
        'slot_id', slot_record.id,
        'slot_number', slot_record.slot_number,
        'sort_order', slot_record.sort_order,
        'status', slot_record.status,
        'real_gains', slot_record.real_gains,
        'added_gains', slot_record.added_gains,
        'operational_gains', round(slot_record.operational_gains, 8),
        'operational_value_usdt', round(slot_record.operational_slot_value, 8),
        'gain_unit_usdt', gain_unit,
        'accounting_version', slot_record.accounting_version,
        'position_notional_usdt', slot_record.position_notional_usdt,
        'position_gain_unit_usdt', slot_record.position_gain_unit_usdt,
        'position_quantity', slot_record.position_quantity,
        'entry', slot_record.preco_entrada,
        'target', slot_record.preco_alvo,
        'position_opened_at', slot_record.position_opened_at
      )
    );
  end loop;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'rank', ranked.rank,
        'slot_id', ranked.slot_id,
        'slot_number', ranked.slot_number,
        'status', ranked.status,
        'real_gains', ranked.real_gains,
        'operational_gains', ranked.operational_gains,
        'operational_value_usdt', ranked.operational_value_usdt,
        'gain_unit_usdt', ranked.gain_unit_usdt,
        'reference_difference_gains', case
          when p_reference_level is null then null
          else round(ranked.operational_gains - p_reference_level, 8)
        end,
        'excess_gains', case
          when p_reference_level is null then 0
          else round(greatest(ranked.operational_gains - p_reference_level, 0), 8)
        end,
        'deficit_gains', case
          when p_reference_level is null then 0
          else round(greatest(p_reference_level - ranked.operational_gains, 0), 8)
        end
      ) order by ranked.rank
    ),
    '[]'::jsonb
  )
  into ranking_before
  from (
    select
      row_number() over (
        order by (entry.value ->> 'operational_gains')::numeric desc,
          (entry.value ->> 'slot_number')::integer,
          (entry.value ->> 'sort_order')::integer,
          entry.key
      ) as rank,
      (entry.value ->> 'slot_id')::uuid as slot_id,
      (entry.value ->> 'slot_number')::integer as slot_number,
      entry.value ->> 'status' as status,
      (entry.value ->> 'real_gains')::integer as real_gains,
      (entry.value ->> 'operational_gains')::numeric as operational_gains,
      (entry.value ->> 'operational_value_usdt')::numeric as operational_value_usdt,
      (entry.value ->> 'gain_unit_usdt')::numeric as gain_unit_usdt
    from jsonb_each(state_by_slot) entry
  ) ranked;

  select coalesce(sum((entry.value ->> 'operational_value_usdt')::numeric), 0)
    into equity_before
  from jsonb_each(state_by_slot) entry;

  if p_reference_level is not null then
    select
      coalesce(sum(greatest((entry.value ->> 'operational_gains')::numeric - p_reference_level, 0)), 0),
      coalesce(sum(round(
        greatest((entry.value ->> 'operational_gains')::numeric - p_reference_level, 0)
          * (entry.value ->> 'gain_unit_usdt')::numeric,
        8
      )), 0)
    into available_excess_gains, available_excess_usdt
    from jsonb_each(state_by_slot) entry;
  end if;

  select coalesce(jsonb_agg(item order by (item ->> 'rank')::integer), '[]'::jsonb)
    into donors
  from jsonb_array_elements(ranking_before) item
  where (item ->> 'excess_gains')::numeric > 0;

  select coalesce(jsonb_agg(item order by (item ->> 'rank')::integer), '[]'::jsonb)
    into receivers
  from jsonb_array_elements(ranking_before) item
  where (item ->> 'deficit_gains')::numeric > 0;

  for donor_record in
    select entry.key as slot_key
    from jsonb_each(state_by_slot) entry
    where (entry.value ->> 'operational_gains')::numeric > p_reference_level
    order by (entry.value ->> 'operational_gains')::numeric desc,
      (entry.value ->> 'slot_number')::integer,
      (entry.value ->> 'sort_order')::integer,
      entry.key
  loop
    for receiver_record in
      select entry.key as slot_key
      from jsonb_each(state_by_slot) entry
      where (entry.value ->> 'operational_gains')::numeric < p_reference_level
      order by (entry.value ->> 'operational_gains')::numeric desc,
        (entry.value ->> 'slot_number')::integer,
        (entry.value ->> 'sort_order')::integer,
        entry.key
    loop
      donor_state := state_by_slot -> donor_record.slot_key;
      receiver_state := state_by_slot -> receiver_record.slot_key;
      donor_operational_before := (donor_state ->> 'operational_gains')::numeric;
      receiver_operational_before := (receiver_state ->> 'operational_gains')::numeric;
      donor_excess := round(donor_operational_before - p_reference_level, 8);
      receiver_deficit := round(p_reference_level - receiver_operational_before, 8);

      exit when donor_excess <= 0;
      continue when receiver_deficit <= 0;

      donor_gain_unit := (donor_state ->> 'gain_unit_usdt')::numeric;
      receiver_gain_unit := (receiver_state ->> 'gain_unit_usdt')::numeric;
      donor_value_before := (donor_state ->> 'operational_value_usdt')::numeric;
      receiver_value_before := (receiver_state ->> 'operational_value_usdt')::numeric;
      donor_capacity_usdt := round(donor_excess * donor_gain_unit, 8);
      receiver_need_usdt := round(receiver_deficit * receiver_gain_unit, 8);
      amount_usdt := round(least(donor_capacity_usdt, receiver_need_usdt), 8);

      continue when amount_usdt <= 0;
      if amount_usdt > donor_value_before then
        raise exception 'COINOPS_BTC_DONOR_VALUE_INSUFFICIENT:%', donor_record.slot_key;
      end if;

      donor_gain_equivalent := round(amount_usdt / donor_gain_unit, 8);
      receiver_gain_equivalent := round(amount_usdt / receiver_gain_unit, 8);
      donor_operational_after := round(donor_operational_before - donor_gain_equivalent, 8);
      receiver_operational_after := round(receiver_operational_before + receiver_gain_equivalent, 8);
      donor_value_after := round(donor_value_before - amount_usdt, 8);
      receiver_value_after := round(receiver_value_before + amount_usdt, 8);

      if donor_operational_after < 0 or donor_value_after < 0 then
        raise exception 'COINOPS_BTC_DONOR_RESULT_INVALID:%', donor_record.slot_key;
      end if;

      transfer_count := transfer_count + 1;
      total_transferred_usdt := round(total_transferred_usdt + amount_usdt, 8);
      transfers := transfers || jsonb_build_array(jsonb_build_object(
        'sequence_number', transfer_count,
        'donor_slot_id', (donor_state ->> 'slot_id')::uuid,
        'receiver_slot_id', (receiver_state ->> 'slot_id')::uuid,
        'donor_slot_number', (donor_state ->> 'slot_number')::integer,
        'receiver_slot_number', (receiver_state ->> 'slot_number')::integer,
        'donor_status', donor_state ->> 'status',
        'receiver_status', receiver_state ->> 'status',
        'donor_gain_unit_usdt', donor_gain_unit,
        'receiver_gain_unit_usdt', receiver_gain_unit,
        'donor_gain_equivalent', donor_gain_equivalent,
        'receiver_gain_equivalent', receiver_gain_equivalent,
        'amount_usdt', amount_usdt,
        'debited_usdt', amount_usdt,
        'credited_usdt', amount_usdt,
        'donor_operational_before', donor_operational_before,
        'donor_operational_after', donor_operational_after,
        'receiver_operational_before', receiver_operational_before,
        'receiver_operational_after', receiver_operational_after,
        'donor_value_before', donor_value_before,
        'donor_value_after', donor_value_after,
        'receiver_value_before', receiver_value_before,
        'receiver_value_after', receiver_value_after,
        'donor_real_gains', (donor_state ->> 'real_gains')::integer,
        'receiver_real_gains', (receiver_state ->> 'real_gains')::integer
      ));

      state_by_slot := jsonb_set(
        jsonb_set(state_by_slot, array[donor_record.slot_key, 'operational_gains'], to_jsonb(donor_operational_after), false),
        array[donor_record.slot_key, 'operational_value_usdt'],
        to_jsonb(donor_value_after),
        false
      );
      state_by_slot := jsonb_set(
        jsonb_set(state_by_slot, array[receiver_record.slot_key, 'operational_gains'], to_jsonb(receiver_operational_after), false),
        array[receiver_record.slot_key, 'operational_value_usdt'],
        to_jsonb(receiver_value_after),
        false
      );
    end loop;
  end loop;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'rank', ranked.rank,
        'slot_id', ranked.slot_id,
        'slot_number', ranked.slot_number,
        'status', ranked.status,
        'real_gains', ranked.real_gains,
        'operational_gains', ranked.operational_gains,
        'operational_value_usdt', ranked.operational_value_usdt,
        'gain_unit_usdt', ranked.gain_unit_usdt,
        'reference_difference_gains', case
          when p_reference_level is null then null
          else round(ranked.operational_gains - p_reference_level, 8)
        end,
        'excess_gains', case
          when p_reference_level is null then 0
          else round(greatest(ranked.operational_gains - p_reference_level, 0), 8)
        end,
        'deficit_gains', case
          when p_reference_level is null then 0
          else round(greatest(p_reference_level - ranked.operational_gains, 0), 8)
        end
      ) order by ranked.rank
    ),
    '[]'::jsonb
  )
  into ranking_after
  from (
    select
      row_number() over (
        order by (entry.value ->> 'operational_gains')::numeric desc,
          (entry.value ->> 'slot_number')::integer,
          (entry.value ->> 'sort_order')::integer,
          entry.key
      ) as rank,
      (entry.value ->> 'slot_id')::uuid as slot_id,
      (entry.value ->> 'slot_number')::integer as slot_number,
      entry.value ->> 'status' as status,
      (entry.value ->> 'real_gains')::integer as real_gains,
      (entry.value ->> 'operational_gains')::numeric as operational_gains,
      (entry.value ->> 'operational_value_usdt')::numeric as operational_value_usdt,
      (entry.value ->> 'gain_unit_usdt')::numeric as gain_unit_usdt
    from jsonb_each(state_by_slot) entry
  ) ranked;

  select coalesce(sum((entry.value ->> 'operational_value_usdt')::numeric), 0)
    into equity_after
  from jsonb_each(state_by_slot) entry;

  if p_reference_level is not null then
    select
      coalesce(sum(greatest((entry.value ->> 'operational_gains')::numeric - p_reference_level, 0)), 0),
      coalesce(sum(round(
        greatest((entry.value ->> 'operational_gains')::numeric - p_reference_level, 0)
          * (entry.value ->> 'gain_unit_usdt')::numeric,
        8
      )), 0),
      coalesce(sum(greatest(p_reference_level - (entry.value ->> 'operational_gains')::numeric, 0)), 0),
      coalesce(sum(round(
        greatest(p_reference_level - (entry.value ->> 'operational_gains')::numeric, 0)
          * (entry.value ->> 'gain_unit_usdt')::numeric,
        8
      )), 0)
    into remaining_excess_gains, remaining_excess_usdt,
      remaining_deficit_gains, remaining_deficit_usdt
    from jsonb_each(state_by_slot) entry;
  end if;

  equity_before := round(equity_before, 8);
  equity_after := round(equity_after, 8);
  equity_difference := round(equity_after - equity_before, 8);
  if equity_difference <> 0 then
    raise exception 'COINOPS_BTC_PREVIEW_EQUITY_MISMATCH:%', equity_difference;
  end if;

  snapshot_payload := jsonb_build_object(
    'algorithm_version', algorithm_version,
    'product_id', p_product_id,
    'tenant_id', p_tenant_id,
    'user_id', p_user_id,
    'reference_level', case when p_reference_level is null then null else round(p_reference_level, 8) end,
    'ranking_before', ranking_before
  );
  snapshot_hash := encode(
    extensions.digest(pg_catalog.convert_to(snapshot_payload::text, 'UTF8'), 'sha256'),
    'hex'
  );

  return jsonb_build_object(
    'ok', true,
    'algorithm_version', algorithm_version,
    'status', 'DRAFT',
    'snapshot_hash', snapshot_hash,
    'reference_level', case when p_reference_level is null then null else round(p_reference_level, 8) end,
    'ranking_before', ranking_before,
    'ranking_after', ranking_after,
    'donors', donors,
    'receivers', receivers,
    'transfers', transfers,
    'transfer_count', transfer_count,
    'total_transferred_usdt', total_transferred_usdt,
    'equity_before_usdt', equity_before,
    'equity_after_usdt', equity_after,
    'equity_difference_usdt', equity_difference,
    'available_excess_gains', round(available_excess_gains, 8),
    'available_excess_usdt', round(available_excess_usdt, 8),
    'remaining_excess_gains', round(remaining_excess_gains, 8),
    'remaining_excess_usdt', round(remaining_excess_usdt, 8),
    'remaining_deficit_gains', round(remaining_deficit_gains, 8),
    'remaining_deficit_usdt', round(remaining_deficit_usdt, 8),
    'is_conserved', true,
    'can_confirm', transfer_count > 0
  );
end;
$preview$;

create or replace function coinops.get_btc_ladder_plan()
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $plan$
declare
  scope_row record;
  plan_started_at date;
  plan_elapsed_days integer;
  plan_cycle_number integer;
  plan_cycle_days integer;
  plan_month_reference date;
  cycle_started_at timestamptz;
  plan_monthly_goal integer;
  suggested_reference_level numeric(20, 8) := null;
  plan_reference_level numeric(20, 8);
  preview_data jsonb;
  active_preview jsonb;
  history_data jsonb := '[]'::jsonb;
  contributions_data jsonb := '[]'::jsonb;
  cutover_at timestamptz;
  real_gains_month bigint := 0;
  real_gains_month_source text;
begin
  select * into strict scope_row from private.coinops_current_scope();

  select
    settings.started_at,
    settings.btc_monthly_goal
  into plan_started_at, plan_monthly_goal
  from coinops.growth_plan_settings settings
  where settings.product_id = scope_row.product_id
    and settings.tenant_id = scope_row.tenant_id
    and settings.user_id = scope_row.user_id;

  plan_started_at := coalesce(
    plan_started_at,
    (
      select min(slot.created_at)::date
      from coinops.slots slot
      where slot.product_id = scope_row.product_id
        and slot.tenant_id = scope_row.tenant_id
        and slot.user_id = scope_row.user_id
    ),
    current_date
  );
  plan_monthly_goal := coalesce(plan_monthly_goal, 7);
  plan_elapsed_days := greatest(current_date - plan_started_at, 0);
  plan_cycle_number := greatest(1, ceil(plan_elapsed_days::numeric / 30)::integer);
  plan_cycle_days := plan_cycle_number * 30;
  plan_month_reference := plan_started_at + ((plan_cycle_number - 1) * 30);
  cycle_started_at := plan_month_reference::timestamp at time zone 'UTC';
  select batch.reference_level
    into plan_reference_level
  from coinops.btc_redistribution_batches batch
  where batch.product_id = scope_row.product_id
    and batch.tenant_id = scope_row.tenant_id
    and batch.user_id = scope_row.user_id
    and batch.month_reference = plan_month_reference
    and batch.status = 'PREPARED'
    and batch.expires_at > timezone('utc', now())
  order by batch.created_at desc, batch.id desc
  limit 1;

  if plan_reference_level is null then
    select batch.reference_level
      into plan_reference_level
    from coinops.btc_redistribution_batches batch
    where batch.product_id = scope_row.product_id
      and batch.tenant_id = scope_row.tenant_id
      and batch.user_id = scope_row.user_id
      and batch.status = 'COMPLETED'
    order by batch.completed_at desc nulls last, batch.created_at desc, batch.id desc
    limit 1;
  end if;

  preview_data := private.coinops_build_btc_ladder_preview(
    scope_row.product_id,
    scope_row.tenant_id,
    scope_row.user_id,
    plan_reference_level
  );

  select batch.result
    into active_preview
  from coinops.btc_redistribution_batches batch
  where batch.product_id = scope_row.product_id
    and batch.tenant_id = scope_row.tenant_id
    and batch.user_id = scope_row.user_id
    and batch.month_reference = plan_month_reference
    and batch.status = 'PREPARED'
    and batch.expires_at > timezone('utc', now())
  order by batch.created_at desc, batch.id desc
  limit 1;

  select min(ledger.created_at)
    into cutover_at
  from coinops.slot_capital_ledger ledger
  where ledger.product_id = scope_row.product_id
    and ledger.tenant_id = scope_row.tenant_id
    and ledger.user_id = scope_row.user_id
    and ledger.entry_type = 'OPENING_BALANCE';

  if cutover_at is null or cycle_started_at >= cutover_at then
    real_gains_month_source := 'LEDGER';
    select count(*)::bigint
      into real_gains_month
    from coinops.slot_capital_ledger ledger
    where ledger.product_id = scope_row.product_id
      and ledger.tenant_id = scope_row.tenant_id
      and ledger.user_id = scope_row.user_id
      and ledger.entry_type = 'REAL_GAIN'
      and ledger.created_at >= cycle_started_at
      and ledger.created_at < cycle_started_at + interval '30 days';
  else
    -- Before cutover, history is the best available estimate. It is exposed as
    -- such and never presented as ledger-exact financial provenance.
    real_gains_month_source := 'LEGACY_HISTORY_ESTIMATE';
    select count(*)::bigint
      into real_gains_month
    from coinops.history_events history
    join coinops.strategies strategy
      on strategy.product_id = history.product_id
     and strategy.tenant_id = history.tenant_id
     and strategy.user_id = history.user_id
     and strategy.id = history.strategy_id
    where history.product_id = scope_row.product_id
      and history.tenant_id = scope_row.tenant_id
      and history.user_id = scope_row.user_id
      and strategy.asset = 'BTC'
      and history.action = 'Gain'
      and history.event_at >= cycle_started_at
      and history.event_at < cycle_started_at + interval '30 days';
  end if;

  select coalesce(jsonb_agg(history_item.payload order by history_item.created_at desc), '[]'::jsonb)
    into history_data
  from (
    select
      batch.created_at,
      jsonb_build_object(
        'batch_id', batch.id,
        'status', batch.status,
        'month_reference', batch.month_reference,
        'reference_level', batch.reference_level,
        'snapshot_hash', batch.snapshot_hash,
        'equity_before_usdt', batch.equity_before,
        'equity_after_usdt', batch.equity_after,
        'equity_difference_usdt', batch.equity_difference,
        'total_transferred_usdt', batch.total_transferred_usdt,
        'transfer_count', batch.transfer_count,
        'created_by', batch.created_by,
        'confirmed_by', batch.confirmed_by,
        'created_at', batch.created_at,
        'completed_at', batch.completed_at,
        'cancelled_at', batch.cancelled_at,
        'transfers', coalesce((
          select jsonb_agg(
            jsonb_build_object(
              'id', transfer.id,
              'sequence_number', transfer.sequence_number,
              'donor_slot_id', transfer.donor_slot_id,
              'receiver_slot_id', transfer.receiver_slot_id,
              'donor_slot_number', transfer.donor_slot_number,
              'receiver_slot_number', transfer.receiver_slot_number,
              'donor_status', transfer.donor_status,
              'receiver_status', transfer.receiver_status,
              'donor_gain_equivalent', transfer.donor_gain_equivalent,
              'receiver_gain_equivalent', transfer.receiver_gain_equivalent,
              'amount_usdt', transfer.amount_usdt,
              'donor_operational_before', transfer.donor_operational_before,
              'donor_operational_after', transfer.donor_operational_after,
              'receiver_operational_before', transfer.receiver_operational_before,
              'receiver_operational_after', transfer.receiver_operational_after,
              'created_by', transfer.created_by
            ) order by transfer.sequence_number
          )
          from coinops.btc_redistribution_transfers transfer
          where transfer.product_id = batch.product_id
            and transfer.tenant_id = batch.tenant_id
            and transfer.user_id = batch.user_id
            and transfer.batch_id = batch.id
        ), '[]'::jsonb)
      ) as payload
    from coinops.btc_redistribution_batches batch
    where batch.product_id = scope_row.product_id
      and batch.tenant_id = scope_row.tenant_id
      and batch.user_id = scope_row.user_id
      and batch.status <> 'PREPARED'
    order by batch.created_at desc
    limit 12
  ) history_item;

  select coalesce(jsonb_agg(contribution_item.payload order by contribution_item.created_at desc), '[]'::jsonb)
    into contributions_data
  from (
    select
      contribution.created_at,
      jsonb_build_object(
        'id', contribution.id,
        'slot_id', contribution.slot_id,
        'slot_number', contribution.slot_number,
        'amount_usdt', contribution.amount_usdt,
        'gain_unit_before_usdt', contribution.gain_unit_before_usdt,
        'gain_unit_after_usdt', contribution.gain_unit_after_usdt,
        'gain_equivalent', contribution.gain_equivalent,
        'operational_before', contribution.operational_before,
        'operational_after', contribution.operational_after,
        'value_before', contribution.value_before,
        'value_after', contribution.value_after,
        'reason', contribution.reason,
        'applied_by', contribution.applied_by,
        'created_at', contribution.created_at
      ) as payload
    from coinops.btc_external_contributions contribution
    where contribution.product_id = scope_row.product_id
      and contribution.tenant_id = scope_row.tenant_id
      and contribution.user_id = scope_row.user_id
    order by contribution.created_at desc
    limit 20
  ) contribution_item;

  return jsonb_build_object(
    'ok', true,
    'monthly_goal', plan_monthly_goal,
    'started_at', plan_started_at,
    'elapsed_days', plan_elapsed_days,
    'cycle_number', plan_cycle_number,
    'cycle_days', plan_cycle_days,
    'month_reference', plan_month_reference,
    'real_gains_month', real_gains_month,
    'real_gains_month_source', real_gains_month_source,
    'real_gains_month_is_complete', real_gains_month_source = 'LEDGER',
    'suggested_reference_level', suggested_reference_level,
    'reference_level', plan_reference_level,
    'available_excess_gains', case
      when plan_reference_level is null then null::jsonb
      else preview_data -> 'available_excess_gains'
    end,
    'available_excess_usdt', case
      when plan_reference_level is null then null::jsonb
      else preview_data -> 'available_excess_usdt'
    end,
    'ladder', preview_data -> 'ranking_before',
    'preview', active_preview,
    'history', history_data,
    'contributions', contributions_data
  );
end;
$plan$;

create or replace function coinops.prepare_btc_ladder_redistribution(
  p_reference_level numeric,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $prepare$
declare
  scope_row record;
  existing_batch coinops.btc_redistribution_batches%rowtype;
  plan_started_at date;
  plan_elapsed_days integer;
  plan_cycle_number integer;
  plan_month_reference date;
  plan_monthly_goal integer;
  normalized_reference numeric(20, 8);
  preview_data jsonb;
  prepared_result jsonb;
  batch_id uuid := gen_random_uuid();
  caller_id uuid := (select auth.uid());
begin
  if p_idempotency_key is null then
    raise exception 'COINOPS_IDEMPOTENCY_KEY_REQUIRED';
  end if;
  if p_reference_level is null or p_reference_level <= 0 then
    raise exception 'COINOPS_BTC_REFERENCE_MUST_BE_POSITIVE';
  end if;
  normalized_reference := round(p_reference_level, 8);
  select * into strict scope_row from private.coinops_current_scope();

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'coinops:btc-capital:' || scope_row.product_id::text || ':'
      || scope_row.tenant_id::text || ':' || scope_row.user_id::text,
    0
  ));

  select * into existing_batch
  from coinops.btc_redistribution_batches batch
  where batch.product_id = scope_row.product_id
    and batch.tenant_id = scope_row.tenant_id
    and batch.user_id = scope_row.user_id
    and batch.prepare_idempotency_key = p_idempotency_key;
  if found then
    if existing_batch.reference_level is distinct from normalized_reference then
      raise exception 'COINOPS_IDEMPOTENCY_CONFLICT';
    end if;
    return existing_batch.result || jsonb_build_object(
      'status', existing_batch.status,
      'can_confirm', existing_batch.status = 'PREPARED'
    );
  end if;

  select settings.started_at, settings.btc_monthly_goal
    into plan_started_at, plan_monthly_goal
  from coinops.growth_plan_settings settings
  where settings.product_id = scope_row.product_id
    and settings.tenant_id = scope_row.tenant_id
    and settings.user_id = scope_row.user_id;
  plan_started_at := coalesce(
    plan_started_at,
    (
      select min(slot.created_at)::date
      from coinops.slots slot
      where slot.product_id = scope_row.product_id
        and slot.tenant_id = scope_row.tenant_id
        and slot.user_id = scope_row.user_id
    ),
    current_date
  );
  plan_monthly_goal := coalesce(plan_monthly_goal, 7);
  plan_elapsed_days := greatest(current_date - plan_started_at, 0);
  plan_cycle_number := greatest(1, ceil(plan_elapsed_days::numeric / 30)::integer);
  plan_month_reference := plan_started_at + ((plan_cycle_number - 1) * 30);

  if exists (
    select 1
    from coinops.btc_redistribution_batches batch
    where batch.product_id = scope_row.product_id
      and batch.tenant_id = scope_row.tenant_id
      and batch.user_id = scope_row.user_id
      and batch.month_reference = plan_month_reference
      and batch.status = 'COMPLETED'
  ) then
    raise exception 'COINOPS_BTC_MONTH_ALREADY_COMPLETED';
  end if;

  update coinops.btc_redistribution_batches batch
  set
    status = 'STALE',
    result = batch.result || jsonb_build_object('status', 'STALE', 'can_confirm', false)
  where batch.product_id = scope_row.product_id
    and batch.tenant_id = scope_row.tenant_id
    and batch.user_id = scope_row.user_id
    and batch.month_reference = plan_month_reference
    and batch.status = 'PREPARED';

  preview_data := private.coinops_build_btc_ladder_preview(
    scope_row.product_id,
    scope_row.tenant_id,
    scope_row.user_id,
    normalized_reference
  );
  if (preview_data ->> 'equity_difference_usdt')::numeric <> 0 then
    raise exception 'COINOPS_BTC_PREVIEW_EQUITY_MISMATCH';
  end if;

  if (preview_data ->> 'transfer_count')::integer = 0 then
    return preview_data || jsonb_build_object(
      'batch_id', null,
      'status', 'BALANCED',
      'month_reference', plan_month_reference,
      'cycle_number', plan_cycle_number,
      'monthly_goal', plan_monthly_goal
    );
  end if;

  prepared_result := preview_data || jsonb_build_object(
    'batch_id', batch_id,
    'status', 'PREPARED',
    'month_reference', plan_month_reference,
    'cycle_number', plan_cycle_number,
    'monthly_goal', plan_monthly_goal,
    'created_at', timezone('utc', now())
  );

  insert into coinops.btc_redistribution_batches (
    id, product_code, product_id, tenant_id, user_id, month_reference,
    cycle_number, monthly_goal, reference_level, algorithm_version, status,
    prepare_idempotency_key, snapshot_hash, ranking_before, ranking_after,
    equity_before, equity_after, equity_difference, total_transferred_usdt,
    transfer_count, result, created_by
  ) values (
    batch_id, 'coinops', scope_row.product_id, scope_row.tenant_id,
    scope_row.user_id, plan_month_reference, plan_cycle_number, plan_monthly_goal,
    normalized_reference, preview_data ->> 'algorithm_version', 'PREPARED',
    p_idempotency_key, preview_data ->> 'snapshot_hash',
    preview_data -> 'ranking_before', preview_data -> 'ranking_after',
    (preview_data ->> 'equity_before_usdt')::numeric,
    (preview_data ->> 'equity_after_usdt')::numeric,
    (preview_data ->> 'equity_difference_usdt')::numeric,
    (preview_data ->> 'total_transferred_usdt')::numeric,
    (preview_data ->> 'transfer_count')::integer,
    prepared_result, caller_id
  );

  insert into coinops.btc_redistribution_transfers (
    product_code, product_id, tenant_id, user_id, batch_id, asset,
    month_reference, sequence_number, donor_slot_id, receiver_slot_id,
    donor_slot_number, receiver_slot_number, donor_status, receiver_status,
    donor_gain_unit_usdt, receiver_gain_unit_usdt, donor_gain_equivalent,
    receiver_gain_equivalent, amount_usdt, donor_operational_before,
    donor_operational_after, receiver_operational_before,
    receiver_operational_after, donor_value_before, donor_value_after,
    receiver_value_before, receiver_value_after, donor_real_gains,
    receiver_real_gains, created_by
  )
  select
    'coinops', scope_row.product_id, scope_row.tenant_id, scope_row.user_id,
    batch_id, 'BTC', plan_month_reference, transfer.sequence_number,
    transfer.donor_slot_id, transfer.receiver_slot_id,
    transfer.donor_slot_number, transfer.receiver_slot_number,
    transfer.donor_status, transfer.receiver_status,
    transfer.donor_gain_unit_usdt, transfer.receiver_gain_unit_usdt,
    transfer.donor_gain_equivalent, transfer.receiver_gain_equivalent,
    transfer.amount_usdt, transfer.donor_operational_before,
    transfer.donor_operational_after, transfer.receiver_operational_before,
    transfer.receiver_operational_after, transfer.donor_value_before,
    transfer.donor_value_after, transfer.receiver_value_before,
    transfer.receiver_value_after, transfer.donor_real_gains,
    transfer.receiver_real_gains, caller_id
  from jsonb_to_recordset(preview_data -> 'transfers') as transfer(
    sequence_number integer,
    donor_slot_id uuid,
    receiver_slot_id uuid,
    donor_slot_number integer,
    receiver_slot_number integer,
    donor_status text,
    receiver_status text,
    donor_gain_unit_usdt numeric,
    receiver_gain_unit_usdt numeric,
    donor_gain_equivalent numeric,
    receiver_gain_equivalent numeric,
    amount_usdt numeric,
    donor_operational_before numeric,
    donor_operational_after numeric,
    receiver_operational_before numeric,
    receiver_operational_after numeric,
    donor_value_before numeric,
    donor_value_after numeric,
    receiver_value_before numeric,
    receiver_value_after numeric,
    donor_real_gains integer,
    receiver_real_gains integer
  );

  return prepared_result;
end;
$prepare$;

create or replace function coinops.confirm_btc_ladder_redistribution(
  p_batch_id uuid,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $confirm$
declare
  scope_row record;
  batch_row coinops.btc_redistribution_batches%rowtype;
  idempotent_batch coinops.btc_redistribution_batches%rowtype;
  transfer_row coinops.btc_redistribution_transfers%rowtype;
  donor_before coinops.slots%rowtype;
  donor_after coinops.slots%rowtype;
  receiver_before coinops.slots%rowtype;
  receiver_after coinops.slots%rowtype;
  recomputed_preview jsonb;
  caller_id uuid := (select auth.uid());
  actual_equity_before numeric(20, 8);
  actual_equity_after numeric(20, 8);
  actual_equity_difference numeric(20, 8);
  persisted_transfer_count integer;
  persisted_transfer_total numeric(20, 8);
  confirmed_timestamp timestamptz := timezone('utc', now());
  completed_result jsonb;
begin
  if p_batch_id is null or p_idempotency_key is null then
    raise exception 'COINOPS_BATCH_AND_IDEMPOTENCY_REQUIRED';
  end if;
  select * into strict scope_row from private.coinops_current_scope();

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'coinops:btc-capital:' || scope_row.product_id::text || ':'
      || scope_row.tenant_id::text || ':' || scope_row.user_id::text,
    0
  ));

  select * into idempotent_batch
  from coinops.btc_redistribution_batches batch
  where batch.product_id = scope_row.product_id
    and batch.tenant_id = scope_row.tenant_id
    and batch.user_id = scope_row.user_id
    and batch.confirm_idempotency_key = p_idempotency_key;
  if found then
    if idempotent_batch.id <> p_batch_id then
      raise exception 'COINOPS_IDEMPOTENCY_CONFLICT';
    end if;
    return idempotent_batch.result;
  end if;

  select * into batch_row
  from coinops.btc_redistribution_batches batch
  where batch.product_id = scope_row.product_id
    and batch.tenant_id = scope_row.tenant_id
    and batch.user_id = scope_row.user_id
    and batch.id = p_batch_id
  for update;
  if not found then
    raise exception 'COINOPS_BTC_BATCH_NOT_FOUND';
  end if;
  if batch_row.status = 'COMPLETED' then
    return batch_row.result || jsonb_build_object('already_completed', true);
  end if;
  if batch_row.status <> 'PREPARED' then
    raise exception 'COINOPS_BTC_BATCH_NOT_PREPARED:%', batch_row.status;
  end if;
  if batch_row.expires_at <= timezone('utc', now()) then
    raise exception 'COINOPS_BTC_BATCH_EXPIRED';
  end if;
  if batch_row.transfer_count <= 0 or batch_row.total_transferred_usdt <= 0 then
    raise exception 'COINOPS_BTC_BATCH_EMPTY';
  end if;

  -- Lock every BTC slot in deterministic order before recomputing. This also
  -- serializes a concurrent real gain, open/close or manual contribution.
  perform slot.id
  from coinops.slots slot
  join coinops.strategies strategy
    on strategy.product_id = slot.product_id
   and strategy.tenant_id = slot.tenant_id
   and strategy.user_id = slot.user_id
   and strategy.id = slot.strategy_id
  where slot.product_id = scope_row.product_id
    and slot.tenant_id = scope_row.tenant_id
    and slot.user_id = scope_row.user_id
    and strategy.asset = 'BTC'
  order by slot.id
  for update of slot;

  recomputed_preview := private.coinops_build_btc_ladder_preview(
    scope_row.product_id,
    scope_row.tenant_id,
    scope_row.user_id,
    batch_row.reference_level
  );
  if recomputed_preview ->> 'algorithm_version' <> batch_row.algorithm_version
    or recomputed_preview ->> 'snapshot_hash' <> batch_row.snapshot_hash then
    raise exception 'COINOPS_BTC_BATCH_STALE';
  end if;
  if (recomputed_preview ->> 'equity_difference_usdt')::numeric <> 0
    or batch_row.equity_difference <> 0 then
    raise exception 'COINOPS_BTC_CONSERVATION_FAILED';
  end if;

  select count(*)::integer, coalesce(round(sum(transfer.amount_usdt), 8), 0)
    into persisted_transfer_count, persisted_transfer_total
  from coinops.btc_redistribution_transfers transfer
  where transfer.product_id = scope_row.product_id
    and transfer.tenant_id = scope_row.tenant_id
    and transfer.user_id = scope_row.user_id
    and transfer.batch_id = batch_row.id;
  if persisted_transfer_count <> batch_row.transfer_count
    or persisted_transfer_total <> batch_row.total_transferred_usdt
    or persisted_transfer_count <> (recomputed_preview ->> 'transfer_count')::integer
    or persisted_transfer_total <> (recomputed_preview ->> 'total_transferred_usdt')::numeric then
    raise exception 'COINOPS_BTC_BATCH_TRANSFER_SET_INVALID';
  end if;

  select round(coalesce(sum(slot.operational_slot_value), 0), 8)
    into actual_equity_before
  from coinops.slots slot
  join coinops.strategies strategy
    on strategy.product_id = slot.product_id
   and strategy.tenant_id = slot.tenant_id
   and strategy.user_id = slot.user_id
   and strategy.id = slot.strategy_id
  where slot.product_id = scope_row.product_id
    and slot.tenant_id = scope_row.tenant_id
    and slot.user_id = scope_row.user_id
    and strategy.asset = 'BTC';
  if actual_equity_before <> batch_row.equity_before then
    raise exception 'COINOPS_BTC_BATCH_EQUITY_CHANGED';
  end if;

  for transfer_row in
    select *
    from coinops.btc_redistribution_transfers transfer
    where transfer.product_id = scope_row.product_id
      and transfer.tenant_id = scope_row.tenant_id
      and transfer.user_id = scope_row.user_id
      and transfer.batch_id = batch_row.id
    order by transfer.sequence_number
  loop
    select slot.* into strict donor_before
    from coinops.slots slot
    join coinops.strategies strategy
      on strategy.product_id = slot.product_id
     and strategy.tenant_id = slot.tenant_id
     and strategy.user_id = slot.user_id
     and strategy.id = slot.strategy_id
    where slot.product_id = scope_row.product_id
      and slot.tenant_id = scope_row.tenant_id
      and slot.user_id = scope_row.user_id
      and slot.id = transfer_row.donor_slot_id
      and strategy.asset = 'BTC';

    select slot.* into strict receiver_before
    from coinops.slots slot
    join coinops.strategies strategy
      on strategy.product_id = slot.product_id
     and strategy.tenant_id = slot.tenant_id
     and strategy.user_id = slot.user_id
     and strategy.id = slot.strategy_id
    where slot.product_id = scope_row.product_id
      and slot.tenant_id = scope_row.tenant_id
      and slot.user_id = scope_row.user_id
      and slot.id = transfer_row.receiver_slot_id
      and strategy.asset = 'BTC';

    if donor_before.status <> transfer_row.donor_status
      or receiver_before.status <> transfer_row.receiver_status
      or donor_before.real_gains <> transfer_row.donor_real_gains
      or receiver_before.real_gains <> transfer_row.receiver_real_gains
      or donor_before.operational_gains <> transfer_row.donor_operational_before
      or receiver_before.operational_gains <> transfer_row.receiver_operational_before
      or donor_before.operational_slot_value <> transfer_row.donor_value_before
      or receiver_before.operational_slot_value <> transfer_row.receiver_value_before
      or private.coinops_gain_unit_usdt(
        donor_before.base_value, donor_before.growth_contribution, donor_before.gain_rate
      ) <> transfer_row.donor_gain_unit_usdt
      or private.coinops_gain_unit_usdt(
        receiver_before.base_value, receiver_before.growth_contribution, receiver_before.gain_rate
      ) <> transfer_row.receiver_gain_unit_usdt then
      raise exception 'COINOPS_BTC_TRANSFER_SNAPSHOT_MISMATCH:%', transfer_row.sequence_number;
    end if;

    update coinops.slots slot
    set
      operational_gains = transfer_row.donor_operational_after,
      redistribution_sent_usdt = round(slot.redistribution_sent_usdt + transfer_row.amount_usdt, 8),
      accounting_version = slot.accounting_version + 1
    where slot.product_id = scope_row.product_id
      and slot.tenant_id = scope_row.tenant_id
      and slot.user_id = scope_row.user_id
      and slot.id = transfer_row.donor_slot_id
    returning * into strict donor_after;

    update coinops.slots slot
    set
      operational_gains = transfer_row.receiver_operational_after,
      redistribution_received_usdt = round(slot.redistribution_received_usdt + transfer_row.amount_usdt, 8),
      accounting_version = slot.accounting_version + 1
    where slot.product_id = scope_row.product_id
      and slot.tenant_id = scope_row.tenant_id
      and slot.user_id = scope_row.user_id
      and slot.id = transfer_row.receiver_slot_id
    returning * into strict receiver_after;

    if donor_after.operational_slot_value <> transfer_row.donor_value_after
      or receiver_after.operational_slot_value <> transfer_row.receiver_value_after
      or donor_after.real_gains <> donor_before.real_gains
      or receiver_after.real_gains <> receiver_before.real_gains
      or donor_after.added_gains <> donor_before.added_gains
      or receiver_after.added_gains <> receiver_before.added_gains
      or donor_after.status <> donor_before.status
      or receiver_after.status <> receiver_before.status
      or donor_after.position_notional_usdt is distinct from donor_before.position_notional_usdt
      or donor_after.position_gain_unit_usdt is distinct from donor_before.position_gain_unit_usdt
      or donor_after.position_quantity is distinct from donor_before.position_quantity
      or donor_after.position_opened_at is distinct from donor_before.position_opened_at
      or donor_after.preco_entrada is distinct from donor_before.preco_entrada
      or donor_after.preco_alvo is distinct from donor_before.preco_alvo
      or receiver_after.position_notional_usdt is distinct from receiver_before.position_notional_usdt
      or receiver_after.position_gain_unit_usdt is distinct from receiver_before.position_gain_unit_usdt
      or receiver_after.position_quantity is distinct from receiver_before.position_quantity
      or receiver_after.position_opened_at is distinct from receiver_before.position_opened_at
      or receiver_after.preco_entrada is distinct from receiver_before.preco_entrada
      or receiver_after.preco_alvo is distinct from receiver_before.preco_alvo then
      raise exception 'COINOPS_BTC_TRANSFER_POSTCONDITION_FAILED:%', transfer_row.sequence_number;
    end if;

    insert into coinops.slot_capital_ledger (
      product_code, product_id, tenant_id, user_id, slot_id, batch_id,
      transfer_id, entry_type, amount_usdt, operational_gain_delta,
      operational_before, operational_after, value_before, value_after,
      gain_unit_before_usdt, gain_unit_after_usdt,
      redistribution_received_before, redistribution_received_after,
      redistribution_sent_before, redistribution_sent_after,
      real_gains_snapshot, added_gains_snapshot, metadata, created_by
    ) values (
      'coinops', scope_row.product_id, scope_row.tenant_id, scope_row.user_id,
      donor_after.id, batch_row.id, transfer_row.id, 'REDISTRIBUTION_DEBIT',
      -transfer_row.amount_usdt,
      round(donor_after.operational_gains - donor_before.operational_gains, 8),
      donor_before.operational_gains, donor_after.operational_gains,
      donor_before.operational_slot_value, donor_after.operational_slot_value,
      transfer_row.donor_gain_unit_usdt, transfer_row.donor_gain_unit_usdt,
      donor_before.redistribution_received_usdt, donor_after.redistribution_received_usdt,
      donor_before.redistribution_sent_usdt, donor_after.redistribution_sent_usdt,
      donor_after.real_gains, donor_after.added_gains,
      jsonb_build_object(
        'asset', 'BTC',
        'monthReference', batch_row.month_reference,
        'referenceLevel', batch_row.reference_level,
        'counterpartySlotId', receiver_after.id,
        'statusAtTransfer', donor_before.status,
        'positionNotionalUsdt', donor_before.position_notional_usdt,
        'positionGainUnitUsdt', donor_before.position_gain_unit_usdt,
        'positionQuantity', donor_before.position_quantity,
        'positionOpenedAt', donor_before.position_opened_at
      ),
      caller_id
    );

    insert into coinops.slot_capital_ledger (
      product_code, product_id, tenant_id, user_id, slot_id, batch_id,
      transfer_id, entry_type, amount_usdt, operational_gain_delta,
      operational_before, operational_after, value_before, value_after,
      gain_unit_before_usdt, gain_unit_after_usdt,
      redistribution_received_before, redistribution_received_after,
      redistribution_sent_before, redistribution_sent_after,
      real_gains_snapshot, added_gains_snapshot, metadata, created_by
    ) values (
      'coinops', scope_row.product_id, scope_row.tenant_id, scope_row.user_id,
      receiver_after.id, batch_row.id, transfer_row.id, 'REDISTRIBUTION_CREDIT',
      transfer_row.amount_usdt,
      round(receiver_after.operational_gains - receiver_before.operational_gains, 8),
      receiver_before.operational_gains, receiver_after.operational_gains,
      receiver_before.operational_slot_value, receiver_after.operational_slot_value,
      transfer_row.receiver_gain_unit_usdt, transfer_row.receiver_gain_unit_usdt,
      receiver_before.redistribution_received_usdt, receiver_after.redistribution_received_usdt,
      receiver_before.redistribution_sent_usdt, receiver_after.redistribution_sent_usdt,
      receiver_after.real_gains, receiver_after.added_gains,
      jsonb_build_object(
        'asset', 'BTC',
        'monthReference', batch_row.month_reference,
        'referenceLevel', batch_row.reference_level,
        'counterpartySlotId', donor_after.id,
        'statusAtTransfer', receiver_before.status,
        'positionNotionalUsdt', receiver_before.position_notional_usdt,
        'positionGainUnitUsdt', receiver_before.position_gain_unit_usdt,
        'positionQuantity', receiver_before.position_quantity,
        'positionOpenedAt', receiver_before.position_opened_at
      ),
      caller_id
    );
  end loop;

  select round(coalesce(sum(slot.operational_slot_value), 0), 8)
    into actual_equity_after
  from coinops.slots slot
  join coinops.strategies strategy
    on strategy.product_id = slot.product_id
   and strategy.tenant_id = slot.tenant_id
   and strategy.user_id = slot.user_id
   and strategy.id = slot.strategy_id
  where slot.product_id = scope_row.product_id
    and slot.tenant_id = scope_row.tenant_id
    and slot.user_id = scope_row.user_id
    and strategy.asset = 'BTC';
  actual_equity_difference := round(actual_equity_after - actual_equity_before, 8);
  if actual_equity_difference <> 0
    or actual_equity_after <> batch_row.equity_after then
    raise exception 'COINOPS_BTC_CONFIRM_EQUITY_MISMATCH:%', actual_equity_difference;
  end if;

  completed_result := batch_row.result || jsonb_build_object(
    'status', 'COMPLETED',
    'confirmed_at', confirmed_timestamp,
    'completed_at', confirmed_timestamp,
    'equity_before_usdt', actual_equity_before,
    'equity_after_usdt', actual_equity_after,
    'equity_difference_usdt', actual_equity_difference,
    'can_confirm', false,
    'already_completed', false
  );

  update coinops.btc_redistribution_batches batch
  set
    status = 'COMPLETED',
    confirm_idempotency_key = p_idempotency_key,
    confirmed_by = caller_id,
    completed_at = confirmed_timestamp,
    equity_before = actual_equity_before,
    equity_after = actual_equity_after,
    equity_difference = actual_equity_difference,
    result = completed_result
  where batch.product_id = scope_row.product_id
    and batch.tenant_id = scope_row.tenant_id
    and batch.user_id = scope_row.user_id
    and batch.id = batch_row.id;

  return completed_result;
end;
$confirm$;

create or replace function coinops.cancel_btc_ladder_redistribution(
  p_batch_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $cancel$
declare
  scope_row record;
  batch_row coinops.btc_redistribution_batches%rowtype;
  cancelled_timestamp timestamptz := timezone('utc', now());
  cancelled_result jsonb;
begin
  if p_batch_id is null then
    raise exception 'COINOPS_BATCH_REQUIRED';
  end if;
  select * into strict scope_row from private.coinops_current_scope();

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'coinops:btc-capital:' || scope_row.product_id::text || ':'
      || scope_row.tenant_id::text || ':' || scope_row.user_id::text,
    0
  ));

  select * into batch_row
  from coinops.btc_redistribution_batches batch
  where batch.product_id = scope_row.product_id
    and batch.tenant_id = scope_row.tenant_id
    and batch.user_id = scope_row.user_id
    and batch.id = p_batch_id
  for update;
  if not found then
    raise exception 'COINOPS_BTC_BATCH_NOT_FOUND';
  end if;
  if batch_row.status = 'CANCELLED' then
    return batch_row.result;
  end if;
  if batch_row.status <> 'PREPARED' then
    raise exception 'COINOPS_BTC_BATCH_NOT_CANCELLABLE:%', batch_row.status;
  end if;

  cancelled_result := batch_row.result || jsonb_build_object(
    'status', 'CANCELLED',
    'cancelled_at', cancelled_timestamp,
    'can_confirm', false
  );
  update coinops.btc_redistribution_batches batch
  set
    status = 'CANCELLED',
    cancelled_at = cancelled_timestamp,
    result = cancelled_result
  where batch.product_id = scope_row.product_id
    and batch.tenant_id = scope_row.tenant_id
    and batch.user_id = scope_row.user_id
    and batch.id = batch_row.id;

  return cancelled_result;
end;
$cancel$;

create or replace function coinops.apply_btc_external_contribution(
  p_slot_id uuid,
  p_amount_usdt numeric,
  p_reason text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $contribution$
declare
  scope_row record;
  existing_contribution coinops.btc_external_contributions%rowtype;
  slot_before coinops.slots%rowtype;
  slot_after coinops.slots%rowtype;
  contribution_id uuid := gen_random_uuid();
  caller_id uuid := (select auth.uid());
  normalized_amount numeric(20, 8);
  normalized_reason text;
  gain_unit_before numeric(20, 8);
  gain_unit_after numeric(20, 8);
  gain_equivalent numeric(20, 8);
  contribution_result jsonb;
begin
  if p_slot_id is null or p_idempotency_key is null then
    raise exception 'COINOPS_SLOT_AND_IDEMPOTENCY_REQUIRED';
  end if;
  normalized_amount := round(p_amount_usdt, 8);
  normalized_reason := btrim(coalesce(p_reason, ''));
  if normalized_amount is null or normalized_amount <= 0 then
    raise exception 'COINOPS_CONTRIBUTION_AMOUNT_MUST_BE_POSITIVE';
  end if;
  if char_length(normalized_reason) not between 1 and 500 then
    raise exception 'COINOPS_CONTRIBUTION_REASON_INVALID';
  end if;

  select * into strict scope_row from private.coinops_current_scope();
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'coinops:btc-capital:' || scope_row.product_id::text || ':'
      || scope_row.tenant_id::text || ':' || scope_row.user_id::text,
    0
  ));

  select * into existing_contribution
  from coinops.btc_external_contributions contribution
  where contribution.product_id = scope_row.product_id
    and contribution.tenant_id = scope_row.tenant_id
    and contribution.user_id = scope_row.user_id
    and contribution.idempotency_key = p_idempotency_key;
  if found then
    if existing_contribution.slot_id <> p_slot_id
      or existing_contribution.amount_usdt <> normalized_amount
      or existing_contribution.reason <> normalized_reason then
      raise exception 'COINOPS_IDEMPOTENCY_CONFLICT';
    end if;
    return existing_contribution.result;
  end if;

  select slot.* into slot_before
  from coinops.slots slot
  join coinops.strategies strategy
    on strategy.product_id = slot.product_id
   and strategy.tenant_id = slot.tenant_id
   and strategy.user_id = slot.user_id
   and strategy.id = slot.strategy_id
  where slot.product_id = scope_row.product_id
    and slot.tenant_id = scope_row.tenant_id
    and slot.user_id = scope_row.user_id
    and slot.id = p_slot_id
    and strategy.asset = 'BTC'
  for update of slot;
  if not found then
    raise exception 'COINOPS_BTC_SLOT_NOT_FOUND';
  end if;

  gain_unit_before := private.coinops_gain_unit_usdt(
    slot_before.base_value,
    slot_before.growth_contribution,
    slot_before.gain_rate
  );
  gain_unit_after := private.coinops_gain_unit_usdt(
    slot_before.base_value,
    slot_before.growth_contribution + normalized_amount,
    slot_before.gain_rate
  );
  if gain_unit_before is null or gain_unit_before <= 0
    or gain_unit_after is null or gain_unit_after <= 0 then
    raise exception 'COINOPS_BTC_GAIN_UNIT_INVALID';
  end if;
  -- The post-contribution unit is authoritative. Using the previous unit would
  -- overstate the new slot's redistribution capacity.
  gain_equivalent := round(normalized_amount / gain_unit_after, 8);
  if gain_equivalent <= 0 then
    raise exception 'COINOPS_CONTRIBUTION_GAIN_EQUIVALENT_INVALID';
  end if;

  update coinops.slots slot
  set
    growth_contribution = round(slot.growth_contribution + normalized_amount, 8),
    operational_gains = round(slot.operational_gains + gain_equivalent, 8),
    accounting_version = slot.accounting_version + 1
  where slot.product_id = scope_row.product_id
    and slot.tenant_id = scope_row.tenant_id
    and slot.user_id = scope_row.user_id
    and slot.id = slot_before.id
  returning * into strict slot_after;

  if slot_after.operational_slot_value <> round(slot_before.operational_slot_value + normalized_amount, 8)
    or slot_after.real_gains <> slot_before.real_gains
    or slot_after.added_gains <> slot_before.added_gains
    or slot_after.status <> slot_before.status
    or slot_after.position_notional_usdt is distinct from slot_before.position_notional_usdt
    or slot_after.position_gain_unit_usdt is distinct from slot_before.position_gain_unit_usdt
    or slot_after.position_quantity is distinct from slot_before.position_quantity
    or slot_after.position_opened_at is distinct from slot_before.position_opened_at
    or slot_after.preco_entrada is distinct from slot_before.preco_entrada
    or slot_after.preco_alvo is distinct from slot_before.preco_alvo then
    raise exception 'COINOPS_CONTRIBUTION_POSTCONDITION_FAILED';
  end if;

  contribution_result := jsonb_build_object(
    'ok', true,
    'status', 'APPLIED',
    'id', contribution_id,
    'slot_id', slot_after.id,
    'slot_number', slot_after.slot_number,
    'amount_usdt', normalized_amount,
    'gain_unit_before_usdt', gain_unit_before,
    'gain_unit_after_usdt', gain_unit_after,
    'gain_equivalent', gain_equivalent,
    'operational_before', slot_before.operational_gains,
    'operational_after', slot_after.operational_gains,
    'value_before', slot_before.operational_slot_value,
    'value_after', slot_after.operational_slot_value,
    'reason', normalized_reason,
    'created_at', timezone('utc', now())
  );

  insert into coinops.btc_external_contributions (
    id, product_code, product_id, tenant_id, user_id, slot_id, slot_number,
    idempotency_key, amount_usdt, gain_unit_before_usdt,
    gain_unit_after_usdt, gain_equivalent, operational_before,
    operational_after, value_before, value_after, reason, applied_by, result
  ) values (
    contribution_id, 'coinops', scope_row.product_id, scope_row.tenant_id,
    scope_row.user_id, slot_after.id, slot_after.slot_number,
    p_idempotency_key, normalized_amount, gain_unit_before, gain_unit_after,
    gain_equivalent, slot_before.operational_gains, slot_after.operational_gains,
    slot_before.operational_slot_value, slot_after.operational_slot_value,
    normalized_reason, caller_id, contribution_result
  );

  insert into coinops.slot_capital_ledger (
    product_code, product_id, tenant_id, user_id, slot_id,
    external_contribution_id, entry_type, amount_usdt,
    operational_gain_delta, operational_before, operational_after,
    value_before, value_after, gain_unit_before_usdt, gain_unit_after_usdt,
    redistribution_received_before, redistribution_received_after,
    redistribution_sent_before, redistribution_sent_after,
    real_gains_snapshot, added_gains_snapshot, metadata, created_by
  ) values (
    'coinops', scope_row.product_id, scope_row.tenant_id, scope_row.user_id,
    slot_after.id, contribution_id, 'EXTERNAL_CONTRIBUTION', normalized_amount,
    gain_equivalent, slot_before.operational_gains, slot_after.operational_gains,
    slot_before.operational_slot_value, slot_after.operational_slot_value,
    gain_unit_before, gain_unit_after,
    slot_before.redistribution_received_usdt, slot_after.redistribution_received_usdt,
    slot_before.redistribution_sent_usdt, slot_after.redistribution_sent_usdt,
    slot_after.real_gains, slot_after.added_gains,
    jsonb_build_object(
      'asset', 'BTC',
      'reason', normalized_reason,
      'statusAtContribution', slot_before.status,
      'positionNotionalUsdt', slot_before.position_notional_usdt,
      'positionGainUnitUsdt', slot_before.position_gain_unit_usdt,
      'positionQuantity', slot_before.position_quantity,
      'positionOpenedAt', slot_before.position_opened_at
    ),
    caller_id
  );

  return contribution_result;
end;
$contribution$;

create or replace function coinops.update_growth_plan_goal(
  p_asset text,
  p_monthly_goal integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $goal$
declare
  scope_row record;
  asset_code text := upper(btrim(coalesce(p_asset, '')));
  settings_row coinops.growth_plan_settings%rowtype;
  initial_started_at date;
begin
  if asset_code not in ('BTC', 'SOL') then
    raise exception 'COINOPS_GROWTH_GOAL_ASSET_INVALID';
  end if;
  if p_monthly_goal is null or p_monthly_goal not between 1 and 1000 then
    raise exception 'COINOPS_GROWTH_GOAL_INVALID';
  end if;
  select * into strict scope_row from private.coinops_current_scope();

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'coinops:growth-goal:' || scope_row.product_id::text || ':'
      || scope_row.tenant_id::text || ':' || scope_row.user_id::text,
    0
  ));

  select * into settings_row
  from coinops.growth_plan_settings settings
  where settings.product_id = scope_row.product_id
    and settings.tenant_id = scope_row.tenant_id
    and settings.user_id = scope_row.user_id
  for update;

  if not found then
    select coalesce(min(slot.created_at)::date, current_date)
      into initial_started_at
    from coinops.slots slot
    where slot.product_id = scope_row.product_id
      and slot.tenant_id = scope_row.tenant_id
      and slot.user_id = scope_row.user_id;

    insert into coinops.growth_plan_settings (
      product_code, product_id, tenant_id, user_id, started_at,
      btc_monthly_goal, sol_monthly_goal
    ) values (
      'coinops', scope_row.product_id, scope_row.tenant_id, scope_row.user_id,
      initial_started_at,
      case when asset_code = 'BTC' then p_monthly_goal else 7 end,
      case when asset_code = 'SOL' then p_monthly_goal else 1 end
    )
    returning * into strict settings_row;
  elsif asset_code = 'BTC' then
    update coinops.growth_plan_settings settings
    set
      btc_monthly_goal = p_monthly_goal,
      updated_at = timezone('utc', now())
    where settings.product_id = scope_row.product_id
      and settings.tenant_id = scope_row.tenant_id
      and settings.user_id = scope_row.user_id
    returning * into strict settings_row;
  else
    update coinops.growth_plan_settings settings
    set
      sol_monthly_goal = p_monthly_goal,
      updated_at = timezone('utc', now())
    where settings.product_id = scope_row.product_id
      and settings.tenant_id = scope_row.tenant_id
      and settings.user_id = scope_row.user_id
    returning * into strict settings_row;
  end if;

  return jsonb_build_object(
    'ok', true,
    'asset', asset_code,
    'monthly_goal', p_monthly_goal,
    'btc_monthly_goal', settings_row.btc_monthly_goal,
    'sol_monthly_goal', settings_row.sol_monthly_goal,
    'started_at', settings_row.started_at,
    'updated_at', settings_row.updated_at
  );
end;
$goal$;

create or replace function coinops.update_btc_strategy(
  p_strategy_id uuid,
  p_title text,
  p_base_value numeric,
  p_gain_rate numeric,
  p_drop_percent numeric,
  p_restart_amount integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $btc_strategy$
declare
  scope_row record;
  strategy_before coinops.strategies%rowtype;
  strategy_after coinops.strategies%rowtype;
  normalized_title text := btrim(coalesce(p_title, ''));
  normalized_base_value numeric := round(p_base_value, 8);
  normalized_gain_rate numeric := round(p_gain_rate, 8);
  normalized_drop_percent numeric := round(p_drop_percent, 8);
  position_snapshot_before jsonb;
  position_snapshot_after jsonb;
  affected_slot_count integer := 0;
  caller_id uuid := (select auth.uid());
begin
  if p_strategy_id is null or char_length(normalized_title) not between 1 and 120 then
    raise exception 'COINOPS_BTC_STRATEGY_ID_OR_TITLE_INVALID';
  end if;
  if normalized_base_value is null or normalized_base_value <= 0
    or normalized_gain_rate is null or normalized_gain_rate <= 0 or normalized_gain_rate > 1
    or normalized_drop_percent is null or normalized_drop_percent < 0 or normalized_drop_percent > 100
    or p_restart_amount is null or p_restart_amount < 0 then
    raise exception 'COINOPS_BTC_STRATEGY_VALUES_INVALID';
  end if;
  select * into strict scope_row from private.coinops_current_scope();

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'coinops:btc-strategy:' || scope_row.product_id::text || ':'
      || scope_row.tenant_id::text || ':' || scope_row.user_id::text
      || ':' || p_strategy_id::text,
    0
  ));

  select strategy.* into strategy_before
  from coinops.strategies strategy
  where strategy.product_id = scope_row.product_id
    and strategy.tenant_id = scope_row.tenant_id
    and strategy.user_id = scope_row.user_id
    and strategy.id = p_strategy_id
    and strategy.asset = 'BTC'
  for update;
  if not found then
    raise exception 'COINOPS_BTC_STRATEGY_NOT_FOUND';
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'slotId', slot.id,
      'status', slot.status,
      'realGains', slot.real_gains,
      'addedGains', slot.added_gains,
      'operationalGains', slot.operational_gains,
      'operationalValue', slot.operational_slot_value,
      'entry', slot.preco_entrada,
      'target', slot.preco_alvo,
      'positionNotional', slot.position_notional_usdt,
      'positionGainUnit', slot.position_gain_unit_usdt,
      'positionQuantity', slot.position_quantity,
      'positionOpenedAt', slot.position_opened_at
    ) order by slot.id
  ), '[]'::jsonb)
  into position_snapshot_before
  from coinops.slots slot
  where slot.product_id = scope_row.product_id
    and slot.tenant_id = scope_row.tenant_id
    and slot.user_id = scope_row.user_id
    and slot.strategy_id = strategy_before.id;

  update coinops.strategies strategy
  set
    title = normalized_title,
    display_name = normalized_title || ' | Novo Slot ' || normalized_drop_percent::text || '%',
    base_value = normalized_base_value,
    gain_rate = normalized_gain_rate,
    drop_percent = normalized_drop_percent,
    restart_amount = p_restart_amount,
    updated_at = timezone('utc', now())
  where strategy.product_id = scope_row.product_id
    and strategy.tenant_id = scope_row.tenant_id
    and strategy.user_id = scope_row.user_id
    and strategy.id = strategy_before.id
  returning * into strict strategy_after;

  update coinops.slots slot
  set gain_rate = normalized_gain_rate
  where slot.product_id = scope_row.product_id
    and slot.tenant_id = scope_row.tenant_id
    and slot.user_id = scope_row.user_id
    and slot.strategy_id = strategy_after.id;
  get diagnostics affected_slot_count = row_count;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'slotId', slot.id,
      'status', slot.status,
      'realGains', slot.real_gains,
      'addedGains', slot.added_gains,
      'operationalGains', slot.operational_gains,
      'operationalValue', slot.operational_slot_value,
      'entry', slot.preco_entrada,
      'target', slot.preco_alvo,
      'positionNotional', slot.position_notional_usdt,
      'positionGainUnit', slot.position_gain_unit_usdt,
      'positionQuantity', slot.position_quantity,
      'positionOpenedAt', slot.position_opened_at
    ) order by slot.id
  ), '[]'::jsonb)
  into position_snapshot_after
  from coinops.slots slot
  where slot.product_id = scope_row.product_id
    and slot.tenant_id = scope_row.tenant_id
    and slot.user_id = scope_row.user_id
    and slot.strategy_id = strategy_after.id;

  if position_snapshot_after is distinct from position_snapshot_before then
    raise exception 'COINOPS_BTC_STRATEGY_SYNC_CHANGED_SLOT_STATE';
  end if;
  if exists (
    select 1
    from coinops.slots slot
    where slot.product_id = scope_row.product_id
      and slot.tenant_id = scope_row.tenant_id
      and slot.user_id = scope_row.user_id
      and slot.strategy_id = strategy_after.id
      and slot.gain_rate is distinct from normalized_gain_rate
  ) then
    raise exception 'COINOPS_BTC_STRATEGY_RATE_SYNC_FAILED';
  end if;

  insert into coinops.history_events (
    product_code, product_id, tenant_id, user_id, strategy_id, action, detail
  ) values (
    'coinops', scope_row.product_id, scope_row.tenant_id, scope_row.user_id,
    strategy_after.id, 'Estrategia', jsonb_build_object(
      'schemaVersion', 1,
      'eventType', 'btc_strategy_updated_atomically',
      'title', strategy_after.title,
      'baseValue', strategy_after.base_value,
      'gainRate', strategy_after.gain_rate,
      'dropPercent', strategy_after.drop_percent,
      'restartAmount', strategy_after.restart_amount,
      'affectedSlots', affected_slot_count,
      'updatedBy', caller_id
    )::text
  );

  return jsonb_build_object(
    'ok', true,
    'id', strategy_after.id,
    'key', strategy_after.key,
    'title', strategy_after.title,
    'base_value', strategy_after.base_value,
    'gain_rate', strategy_after.gain_rate,
    'drop_percent', strategy_after.drop_percent,
    'restart_amount', strategy_after.restart_amount,
    'affected_slot_count', affected_slot_count
  );
end;
$btc_strategy$;

-- SECURITY DEFINER entry points are intentionally narrow. New financial
-- tables remain read-only to authenticated clients; every mutation is
-- recalculated and authorized inside these RPCs.
revoke all on function private.coinops_current_scope() from public, anon, authenticated, service_role;
revoke all on function private.coinops_gain_unit_usdt(numeric, numeric, numeric) from public, anon, authenticated, service_role;
revoke all on function private.coinops_capture_btc_position_snapshot() from public, anon, authenticated, service_role;
revoke all on function private.coinops_apply_realized_profit_on_real_gain() from public, anon, authenticated, service_role;
revoke all on function private.coinops_enforce_slot_gain_breakdown() from public, anon, authenticated, service_role;
revoke all on function private.coinops_protect_strategy_asset() from public, anon, authenticated, service_role;
revoke all on function private.coinops_record_btc_real_gain() from public, anon, authenticated, service_role;
revoke all on function private.coinops_audit_btc_growth_goal() from public, anon, authenticated, service_role;
revoke all on function private.coinops_build_btc_ladder_preview(uuid, uuid, uuid, numeric) from public, anon, authenticated, service_role;

revoke all on function coinops.get_btc_ladder_plan() from public, anon, authenticated, service_role;
revoke all on function coinops.prepare_btc_ladder_redistribution(numeric, uuid) from public, anon, authenticated, service_role;
revoke all on function coinops.confirm_btc_ladder_redistribution(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function coinops.cancel_btc_ladder_redistribution(uuid) from public, anon, authenticated, service_role;
revoke all on function coinops.apply_btc_external_contribution(uuid, numeric, text, uuid) from public, anon, authenticated, service_role;
revoke all on function coinops.update_growth_plan_goal(text, integer) from public, anon, authenticated, service_role;
revoke all on function coinops.update_btc_strategy(uuid, text, numeric, numeric, numeric, integer) from public, anon, authenticated, service_role;

revoke insert, update, delete on table coinops.growth_plan_settings from public, anon, authenticated;

grant usage on schema coinops to authenticated, service_role;
grant execute on function coinops.get_btc_ladder_plan() to authenticated;
grant execute on function coinops.prepare_btc_ladder_redistribution(numeric, uuid) to authenticated;
grant execute on function coinops.confirm_btc_ladder_redistribution(uuid, uuid) to authenticated;
grant execute on function coinops.cancel_btc_ladder_redistribution(uuid) to authenticated;
grant execute on function coinops.apply_btc_external_contribution(uuid, numeric, text, uuid) to authenticated;
grant execute on function coinops.update_growth_plan_goal(text, integer) to authenticated;
grant execute on function coinops.update_btc_strategy(uuid, text, numeric, numeric, numeric, integer) to authenticated;
