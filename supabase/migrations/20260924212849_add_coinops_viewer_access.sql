-- CoinOps client portal: account-bound, read-only Auth identity. No trading rows change.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';

create table coinops.viewer_access (
  user_id uuid primary key references auth.users(id) on delete restrict,
  operator_id uuid not null references coinops.operators(id) on delete restrict,
  exchange_account_id uuid not null,
  role text not null default 'VIEWER' check (role = 'VIEWER'),
  display_name text not null check (length(btrim(display_name)) between 1 and 80),
  email text not null check (length(btrim(email)) between 3 and 320),
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'INACTIVE')),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (exchange_account_id, operator_id)
    references coinops.exchange_accounts(id, operator_id) on delete restrict
);
create index viewer_access_operator_idx on coinops.viewer_access(operator_id, exchange_account_id);
create unique index viewer_access_operator_email_idx on coinops.viewer_access(operator_id, lower(email));
alter table coinops.viewer_access enable row level security;
alter table coinops.viewer_access force row level security;
revoke all on coinops.viewer_access from public, anon, authenticated;
grant select (user_id, exchange_account_id, role, display_name, status)
  on coinops.viewer_access to authenticated;
grant all on coinops.viewer_access to service_role;
create policy viewer_self_read on coinops.viewer_access for select to authenticated
  using (user_id = (select auth.uid()));

-- A VIEWER cannot acquire the old operator permissions through a later
-- platform membership or stale JWT. The existing owner/operator predicate
-- remains unchanged for every non-viewer identity.
create or replace function private.coinops_can_access_row(
  target_product_id uuid, target_tenant_id uuid, target_user_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select not exists (
    select 1 from coinops.viewer_access viewer
    where viewer.user_id = (select auth.uid())
  ) and (
    private.is_platform_admin()
    or (
      (select auth.uid()) = target_user_id
      and exists (
        select 1 from public.product_memberships membership
        join public.product_tenants tenant_link
          on tenant_link.product_id = membership.product_id
         and tenant_link.tenant_id = membership.tenant_id
        join public.platform_tenants tenant on tenant.id = tenant_link.tenant_id
        join public.products product on product.id = tenant_link.product_id
        where membership.product_id = target_product_id
          and membership.tenant_id = target_tenant_id
          and membership.user_id = (select auth.uid())
          and membership.status = 'active'
          and membership.role_key in ('coinops.owner', 'coinops.operator')
          and tenant_link.status = 'active'
          and tenant.status = 'active'
          and product.code = 'coinops'
          and product.product_type = 'internal'
          and product.status = 'active'
      )
    )
  );
$$;
revoke all on function private.coinops_can_access_row(uuid, uuid, uuid) from public, anon;
grant execute on function private.coinops_can_access_row(uuid, uuid, uuid) to authenticated, service_role;
commit;
