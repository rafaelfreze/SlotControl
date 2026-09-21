-- MINIMAL TEST CONTRACT ONLY. This is not the CoinOps bootstrap and must never
-- be applied to Supabase or an existing application database. The runner wraps
-- this entire fixture, the actual migration, and assertions in one rollback.

create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create schema private;
create schema coinops;
create schema extensions;
create extension pgcrypto with schema extensions;
grant usage on schema auth, private, coinops to authenticated, service_role;
grant usage on schema coinops to anon;

create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
create table auth.users (id uuid primary key);
create table public.products (
  id uuid primary key,
  code text not null,
  status text not null default 'active',
  product_type text not null default 'internal',
  unique (code, id)
);
create table public.platform_tenants (
  id uuid primary key,
  status text not null default 'active'
);
create table public.product_tenants (
  product_id uuid not null,
  tenant_id uuid not null,
  status text not null default 'active',
  primary key (product_id, tenant_id)
);
create table public.product_memberships (
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  role_key text not null default 'coinops.owner',
  status text not null default 'active'
);

-- The fixture models the existing scope helper contract, not its bootstrap.
-- Membership, tenant, product and user are checked independently so the new
-- migration's RLS policies are tested against own/foreign/inactive scopes.
create function private.coinops_can_access_row(
  p_product_id uuid, p_tenant_id uuid, p_user_id uuid
) returns boolean language sql stable security definer set search_path = '' as $$
  select p_user_id = (select auth.uid()) and exists (
    select 1 from public.product_memberships m
    join public.products p on p.id = m.product_id
    join public.product_tenants pt
      on pt.product_id = m.product_id and pt.tenant_id = m.tenant_id
    join public.platform_tenants t on t.id = pt.tenant_id
    where m.product_id = p_product_id and m.tenant_id = p_tenant_id
      and m.user_id = p_user_id and m.status = 'active'
      and m.role_key in ('coinops.owner', 'coinops.operator')
      and p.code = 'coinops' and p.product_type = 'internal'
      and p.status = 'active' and pt.status = 'active' and t.status = 'active'
  )
$$;

create function private.coinops_current_scope()
returns table (product_id uuid, tenant_id uuid, user_id uuid)
language plpgsql stable security definer set search_path = '' as $$
declare matches integer;
begin
  if auth.uid() is null then raise exception 'COINOPS_AUTH_REQUIRED'; end if;
  select count(*) into matches from public.product_memberships m
  where private.coinops_can_access_row(m.product_id, m.tenant_id, m.user_id);
  if matches = 0 then raise exception 'COINOPS_ACTIVE_INTERNAL_MEMBERSHIP_REQUIRED'; end if;
  if matches <> 1 then raise exception 'COINOPS_TENANT_CONTEXT_AMBIGUOUS'; end if;
  return query select m.product_id, m.tenant_id, m.user_id
  from public.product_memberships m
  where private.coinops_can_access_row(m.product_id, m.tenant_id, m.user_id);
end
$$;

create table coinops.strategies (
  id uuid primary key,
  product_code text not null default 'coinops',
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  asset text not null,
  base_value numeric(20,8) not null default 25,
  gain_rate numeric(12,8) not null default 0.02,
  unique (product_id, tenant_id, user_id, id)
);
create table coinops.slots (
  id uuid primary key default gen_random_uuid(),
  product_code text not null default 'coinops',
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  strategy_id uuid not null references coinops.strategies(id),
  slot_number integer not null,
  sort_order integer not null default 1,
  status text not null default 'zerado',
  gains integer not null default 0,
  real_gains integer not null default 0,
  added_gains integer not null default 0,
  operational_gains numeric(20,8) not null default 0,
  base_value numeric(20,8) not null default 25,
  gain_rate numeric(12,8) not null default 0.02,
  realized_profit numeric(20,8) not null default 0,
  growth_contribution numeric(20,8) not null default 0,
  redistribution_received_usdt numeric(20,8) not null default 0,
  redistribution_sent_usdt numeric(20,8) not null default 0,
  operational_slot_value numeric(20,8) generated always as (
    base_value + realized_profit + growth_contribution
      + redistribution_received_usdt - redistribution_sent_usdt
  ) stored,
  position_notional_usdt numeric(20,8),
  position_gain_unit_usdt numeric(20,8),
  position_quantity numeric(30,16),
  position_opened_at timestamptz,
  accounting_version integer not null default 0,
  preco_entrada numeric(20,8),
  preco_atual numeric(20,8),
  preco_alvo numeric(20,8),
  started_once boolean not null default false,
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (product_id, tenant_id, user_id, id),
  unique (product_id, tenant_id, user_id, strategy_id, slot_number)
);
create table coinops.btc_external_contributions (
  id uuid primary key default gen_random_uuid(),
  product_code text not null default 'coinops',
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  slot_id uuid not null references coinops.slots(id),
  slot_number integer not null,
  asset text not null,
  input_mode text not null default 'USDT',
  amount_usdt numeric(20,8) not null,
  accounting_amount_usdt numeric(20,8),
  gain_equivalent numeric(20,8) not null default 0,
  operational_before numeric(20,8) not null default 0,
  operational_after numeric(20,8) not null default 0,
  reason text not null default 'Local test fixture',
  applied_by uuid,
  bulk_batch_id uuid,
  bulk_sequence integer,
  bulk_slot_count integer,
  manual_gain_batch_id uuid,
  manual_gain_batch_sequence integer,
  manual_gain_batch_slot_count integer,
  created_at timestamptz not null default now(),
  unique (product_id, tenant_id, user_id, id)
);

create table coinops.slot_capital_ledger (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  slot_id uuid not null,
  entry_type text not null,
  amount_usdt numeric(20,8) not null,
  metadata jsonb not null default '{}'
);
create table coinops.history_events (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  slot_id uuid,
  action text not null,
  detail text not null,
  event_at timestamptz not null default now()
);

alter table coinops.strategies enable row level security;
alter table coinops.slots enable row level security;
alter table coinops.btc_external_contributions enable row level security;
create policy test_strategies_scope on coinops.strategies for select to authenticated
  using (private.coinops_can_access_row(product_id, tenant_id, user_id));
create policy test_slots_scope on coinops.slots for select to authenticated
  using (private.coinops_can_access_row(product_id, tenant_id, user_id));
create policy test_slots_insert_scope on coinops.slots for insert to authenticated
  with check (private.coinops_can_access_row(product_id, tenant_id, user_id));
create policy test_contributions_scope on coinops.btc_external_contributions for select to authenticated
  using (private.coinops_can_access_row(product_id, tenant_id, user_id));
grant select on coinops.strategies, coinops.slots, coinops.btc_external_contributions
  to authenticated, service_role;
grant insert on coinops.slots to authenticated;

create function pg_temp.assert_true(p_test boolean, p_message text)
returns void language plpgsql as $$
begin
  if p_test is distinct from true then raise exception 'FAIL: %', p_message; end if;
  raise notice 'PASS: %', p_message;
end
$$;

create function pg_temp.assert_raises(p_command text, p_message text)
returns void language plpgsql as $$
declare caught boolean := false;
begin
  begin
    execute p_command;
  exception when others then
    if position(p_message in sqlerrm) = 0 then raise; end if;
    caught := true;
  end;
  perform pg_temp.assert_true(caught, 'rejects ' || p_message);
end
$$;
