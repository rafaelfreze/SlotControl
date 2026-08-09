-- A data operacional pertence ao plano CoinOps, não ao ciclo de vida do
-- usuário em auth.users. A consolidação de Auth pode recriar a conta sem
-- alterar o início real da operação. Esta migration permite corrigir essa
-- data por uma RPC autenticada, auditada e isolada por escopo.

create table coinops.growth_plan_start_audit (
  id uuid primary key default gen_random_uuid(),
  product_code text not null default 'coinops' check (product_code = 'coinops'),
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  previous_started_at date,
  new_started_at date not null,
  stale_preview_count integer not null default 0 check (stale_preview_count >= 0),
  changed_by uuid not null,
  created_at timestamptz not null default timezone('utc', now()),
  constraint growth_plan_start_audit_product_fk
    foreign key (product_code, product_id) references public.products(code, id) on delete restrict,
  constraint growth_plan_start_audit_tenant_fk
    foreign key (product_id, tenant_id) references public.product_tenants(product_id, tenant_id) on delete restrict,
  unique (product_id, tenant_id, user_id, id)
);

create index growth_plan_start_audit_scope_created_idx
  on coinops.growth_plan_start_audit (product_id, tenant_id, user_id, created_at desc);
create index growth_plan_start_audit_product_idx
  on coinops.growth_plan_start_audit (product_code, product_id);

create trigger coinops_scope_growth_plan_start_audit_v1
before insert or update on coinops.growth_plan_start_audit
for each row execute function private.coinops_apply_authenticated_scope();

alter table coinops.growth_plan_start_audit enable row level security;
alter table coinops.growth_plan_start_audit force row level security;

create policy growth_plan_start_audit_owner_select
on coinops.growth_plan_start_audit for select to authenticated
using (private.coinops_can_access_row(product_id, tenant_id, user_id));

revoke all on table coinops.growth_plan_start_audit from public, anon, authenticated;
grant select on table coinops.growth_plan_start_audit to authenticated, service_role;

create or replace function private.coinops_lock_growth_plan_start_date()
returns trigger
language plpgsql
set search_path = ''
as $lock_start$
declare
  edit_is_authorized boolean := current_setting(
    'app.allow_coinops_growth_start_edit', true
  ) = 'on';
begin
  if tg_op = 'INSERT' then
    if edit_is_authorized then
      new.started_at := coalesce(new.started_at, current_date);
    else
      select profile.created_at::date
        into new.started_at
      from public.platform_profiles profile
      where profile.id = new.user_id;

      new.started_at := coalesce(new.started_at, current_date);
    end if;
  elsif new.started_at is distinct from old.started_at
    and not edit_is_authorized
    and current_setting(
      'app.allow_coinops_growth_start_backfill', true
    ) is distinct from 'on' then
    raise exception 'COINOPS_GROWTH_PLAN_START_DATE_IMMUTABLE';
  end if;

  return new;
end;
$lock_start$;

create or replace function coinops.update_growth_plan_started_at(
  p_started_at date
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $update_start$
declare
  scope_row record;
  settings_before coinops.growth_plan_settings%rowtype;
  settings_after coinops.growth_plan_settings%rowtype;
  settings_exists boolean := false;
  caller_id uuid := (select auth.uid());
  stale_count integer := 0;
  elapsed_days integer;
  cycle_number integer;
begin
  if p_started_at is null then
    raise exception 'COINOPS_GROWTH_PLAN_START_DATE_INVALID';
  end if;
  if p_started_at > current_date then
    raise exception 'COINOPS_GROWTH_PLAN_START_DATE_FUTURE';
  end if;

  select * into strict scope_row from private.coinops_current_scope();

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'coinops:growth-plan-start:' || scope_row.product_id::text || ':'
      || scope_row.tenant_id::text || ':' || scope_row.user_id::text,
    0
  ));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'coinops:btc-ladder:' || scope_row.product_id::text || ':'
      || scope_row.tenant_id::text || ':' || scope_row.user_id::text,
    0
  ));

  select settings.* into settings_before
  from coinops.growth_plan_settings settings
  where settings.product_id = scope_row.product_id
    and settings.tenant_id = scope_row.tenant_id
    and settings.user_id = scope_row.user_id
  for update;
  settings_exists := found;

  if settings_exists and settings_before.started_at = p_started_at then
    settings_after := settings_before;
  else
    perform pg_catalog.set_config(
      'app.allow_coinops_growth_start_edit', 'on', true
    );

    if not settings_exists then
      insert into coinops.growth_plan_settings (
        product_code, product_id, tenant_id, user_id, started_at,
        btc_monthly_goal, sol_monthly_goal
      ) values (
        'coinops', scope_row.product_id, scope_row.tenant_id,
        scope_row.user_id, p_started_at, 7, 1
      )
      returning * into strict settings_after;
    else
      update coinops.growth_plan_settings settings
      set started_at = p_started_at
      where settings.product_id = scope_row.product_id
        and settings.tenant_id = scope_row.tenant_id
        and settings.user_id = scope_row.user_id
      returning * into strict settings_after;
    end if;
  end if;

  if settings_before.started_at is distinct from settings_after.started_at then
    update coinops.btc_redistribution_batches batch
    set
      status = 'STALE',
      result = coalesce(batch.result, '{}'::jsonb) || jsonb_build_object(
        'staleReason', 'PLAN_START_DATE_CHANGED',
        'previousStartedAt', settings_before.started_at,
        'newStartedAt', settings_after.started_at,
        'staleAt', timezone('utc', now())
      ),
      updated_at = timezone('utc', now())
    where batch.product_id = scope_row.product_id
      and batch.tenant_id = scope_row.tenant_id
      and batch.user_id = scope_row.user_id
      and batch.status = 'PREPARED';
    get diagnostics stale_count = row_count;

    insert into coinops.growth_plan_start_audit (
      product_code, product_id, tenant_id, user_id,
      previous_started_at, new_started_at, stale_preview_count, changed_by
    ) values (
      'coinops', scope_row.product_id, scope_row.tenant_id,
      scope_row.user_id, settings_before.started_at,
      settings_after.started_at, stale_count, caller_id
    );

    insert into coinops.history_events (
      product_code, product_id, tenant_id, user_id, action, detail
    ) values (
      'coinops', scope_row.product_id, scope_row.tenant_id,
      scope_row.user_id, 'Plano', jsonb_build_object(
        'schemaVersion', 1,
        'eventType', 'growth_plan_start_date_changed',
        'previousStartedAt', settings_before.started_at,
        'newStartedAt', settings_after.started_at,
        'stalePreviewCount', stale_count,
        'changedBy', caller_id
      )::text
    );
  end if;

  elapsed_days := greatest(current_date - settings_after.started_at, 0);
  cycle_number := greatest(
    ceil(greatest(elapsed_days, 1)::numeric / 30)::integer,
    1
  );

  return jsonb_build_object(
    'ok', true,
    'started_at', settings_after.started_at,
    'elapsed_days', elapsed_days,
    'cycle_number', cycle_number,
    'cycle_days', cycle_number * 30,
    'stale_preview_count', stale_count,
    'updated_at', settings_after.updated_at
  );
end;
$update_start$;

revoke all on function private.coinops_lock_growth_plan_start_date()
  from public, anon, authenticated, service_role;
revoke all on function coinops.update_growth_plan_started_at(date)
  from public, anon, authenticated, service_role;
grant execute on function coinops.update_growth_plan_started_at(date)
  to authenticated;
