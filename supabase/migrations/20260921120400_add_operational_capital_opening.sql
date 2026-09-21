-- Separate reporting cutover, never a rewrite of operational capital or trades.
-- Activation is a privileged, explicit operation after a reviewed snapshot hash.
create table coinops.capital_accounting_openings (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  idempotency_key uuid not null,
  activated_at timestamptz not null default clock_timestamp(),
  reason text not null check (length(btrim(reason)) >= 10),
  state_hash text not null check (state_hash ~ '^[0-9a-f]{64}$'),
  slots_snapshot jsonb not null check (jsonb_typeof(slots_snapshot) = 'array'),
  contributions_snapshot jsonb not null check (jsonb_typeof(contributions_snapshot) = 'array'),
  incorporated_contribution_ids uuid[] not null,
  audit_snapshot jsonb not null,
  unique (product_id, tenant_id, user_id),
  unique (id, product_id, tenant_id, user_id),
  unique (idempotency_key)
);

-- Immutable initial principal of slots created AFTER the cutover. This is a
-- reporting receipt, not an extra contribution applied to the slot's balance.
create table coinops.slot_initial_capital (
  id uuid primary key default gen_random_uuid(),
  opening_id uuid not null,
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  slot_id uuid not null unique,
  slot_number integer not null,
  asset text not null,
  amount_usdt numeric(20,8) not null check (amount_usdt >= 0),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (opening_id, product_id, tenant_id, user_id)
    references coinops.capital_accounting_openings(id, product_id, tenant_id, user_id)
);
create index slot_initial_capital_scope_idx
  on coinops.slot_initial_capital(product_id, tenant_id, user_id, created_at);
create index slot_initial_capital_opening_idx on coinops.slot_initial_capital(opening_id);

alter table coinops.capital_accounting_openings enable row level security;
alter table coinops.slot_initial_capital enable row level security;
create policy capital_accounting_openings_owner_select
  on coinops.capital_accounting_openings for select to authenticated
  using (private.coinops_can_access_row(product_id, tenant_id, user_id));
create policy slot_initial_capital_owner_select
  on coinops.slot_initial_capital for select to authenticated
  using (private.coinops_can_access_row(product_id, tenant_id, user_id));
revoke all on coinops.capital_accounting_openings, coinops.slot_initial_capital
  from public, anon, authenticated, service_role;
grant select on coinops.capital_accounting_openings, coinops.slot_initial_capital
  to authenticated, service_role;

create function private.coinops_keep_capital_opening_immutable()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'COINOPS_CAPITAL_OPENING_APPEND_ONLY';
end;
$$;
revoke all on function private.coinops_keep_capital_opening_immutable()
  from public, anon, authenticated, service_role;
create trigger capital_accounting_openings_immutable before update or delete
  on coinops.capital_accounting_openings for each row
  execute function private.coinops_keep_capital_opening_immutable();
create trigger slot_initial_capital_immutable before update or delete
  on coinops.slot_initial_capital for each row
  execute function private.coinops_keep_capital_opening_immutable();

create function private.coinops_capture_slot_initial_capital()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  opening_uuid uuid;
  slot_asset text;
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'COINOPS_CAPITAL_OPENING_READ_COMMITTED_REQUIRED';
  end if;
  select o.id into opening_uuid from coinops.capital_accounting_openings o
  where o.product_id = new.product_id and o.tenant_id = new.tenant_id
    and o.user_id = new.user_id;
  if opening_uuid is null then return new; end if;
  select upper(s.asset) into strict slot_asset from coinops.strategies s
  where s.id = new.strategy_id and s.product_id = new.product_id
    and s.tenant_id = new.tenant_id and s.user_id = new.user_id;
  insert into coinops.slot_initial_capital(
    opening_id, product_id, tenant_id, user_id, slot_id, slot_number, asset, amount_usdt
  ) values (
    opening_uuid, new.product_id, new.tenant_id, new.user_id,
    new.id, new.slot_number, slot_asset, new.base_value
  );
  return new;
end;
$$;
revoke all on function private.coinops_capture_slot_initial_capital()
  from public, anon, authenticated, service_role;
create trigger coinops_capture_slot_initial_capital after insert on coinops.slots
  for each row execute function private.coinops_capture_slot_initial_capital();

-- Admin-only preview; no client grant, no SECURITY DEFINER, no public RPC.
create function private.coinops_capital_opening_snapshot(
  p_product_id uuid, p_tenant_id uuid, p_user_id uuid
) returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'slots', coalesce((select jsonb_agg(to_jsonb(s) order by s.id)
      from coinops.slots s where s.product_id = p_product_id
        and s.tenant_id = p_tenant_id and s.user_id = p_user_id), '[]'::jsonb),
    'contributions', coalesce((select jsonb_agg(to_jsonb(c) order by c.id)
      from coinops.btc_external_contributions c where c.product_id = p_product_id
        and c.tenant_id = p_tenant_id and c.user_id = p_user_id), '[]'::jsonb),
    'audit', jsonb_build_object(
      'ledger_hash', (select encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(l)
        order by l.id), '[]'::jsonb)::text, 'UTF8')), 'hex')
        from coinops.slot_capital_ledger l where l.product_id = p_product_id
          and l.tenant_id = p_tenant_id and l.user_id = p_user_id),
      'history_hash', (select encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(h)
        order by h.id), '[]'::jsonb)::text, 'UTF8')), 'hex')
        from coinops.history_events h where h.product_id = p_product_id
          and h.tenant_id = p_tenant_id and h.user_id = p_user_id)
    )
  );
$$;
revoke all on function private.coinops_capital_opening_snapshot(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;

create function private.coinops_activate_capital_opening(
  p_product_id uuid, p_tenant_id uuid, p_user_id uuid,
  p_expected_hash text, p_idempotency_key uuid, p_reason text
) returns jsonb language plpgsql set search_path = '' set lock_timeout = '5s' as $$
declare
  existing coinops.capital_accounting_openings%rowtype;
  snapshot jsonb;
  snapshot_hash text;
  contribution_ids uuid[];
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'COINOPS_CAPITAL_OPENING_READ_COMMITTED_REQUIRED';
  end if;
  if p_expected_hash is null or p_idempotency_key is null
    or p_reason is null or length(btrim(p_reason)) < 10 then
    raise exception 'COINOPS_CAPITAL_OPENING_INVALID_CONFIRMATION';
  end if;
  -- These are existing shared-platform identity dependencies, not new ownership.
  if not exists (
    select 1 from public.product_memberships m
    join public.products p on p.id = m.product_id
    join public.product_tenants pt on pt.product_id = m.product_id and pt.tenant_id = m.tenant_id
    join public.platform_tenants t on t.id = pt.tenant_id
    where m.product_id = p_product_id and m.tenant_id = p_tenant_id and m.user_id = p_user_id
      and m.status = 'active' and m.role_key in ('coinops.owner', 'coinops.operator')
      and p.code = 'coinops' and p.product_type = 'internal' and p.status = 'active'
      and pt.status = 'active' and t.status = 'active'
  ) then raise exception 'COINOPS_CAPITAL_OPENING_INVALID_SCOPE'; end if;

  -- Brief table-level serialization is intentional for this one-off operation:
  -- it also closes the concurrent INSERT/new-slot gap of row/advisory locks.
  -- No mutations of the locked financial tables take place here.
  lock table coinops.slots, coinops.btc_external_contributions,
    coinops.slot_capital_ledger, coinops.history_events in share row exclusive mode;
  select * into existing from coinops.capital_accounting_openings o
  where o.product_id = p_product_id and o.tenant_id = p_tenant_id and o.user_id = p_user_id;
  if found then
    if existing.idempotency_key <> p_idempotency_key or existing.state_hash <> p_expected_hash
      or existing.reason <> p_reason then
      raise exception 'COINOPS_CAPITAL_OPENING_ALREADY_ACTIVATED';
    end if;
    return jsonb_build_object('id', existing.id, 'activated_at', existing.activated_at,
      'state_hash', existing.state_hash, 'replayed', true);
  end if;
  snapshot := private.coinops_capital_opening_snapshot(p_product_id, p_tenant_id, p_user_id);
  snapshot_hash := encode(sha256(convert_to(snapshot::text, 'UTF8')), 'hex');
  if snapshot_hash <> p_expected_hash then
    raise exception 'COINOPS_CAPITAL_OPENING_SNAPSHOT_CHANGED';
  end if;
  if jsonb_array_length(snapshot->'slots') = 0 then
    raise exception 'COINOPS_CAPITAL_OPENING_EMPTY_SCOPE';
  end if;
  select coalesce(array_agg((c->>'id')::uuid order by c->>'id'), '{}'::uuid[])
    into contribution_ids from jsonb_array_elements(snapshot->'contributions') c;
  insert into coinops.capital_accounting_openings(
    product_id, tenant_id, user_id, idempotency_key, reason, state_hash,
    slots_snapshot, contributions_snapshot, incorporated_contribution_ids, audit_snapshot
  ) values (
    p_product_id, p_tenant_id, p_user_id, p_idempotency_key, p_reason, snapshot_hash,
    snapshot->'slots', snapshot->'contributions', contribution_ids, snapshot->'audit'
  ) returning * into existing;
  if private.coinops_capital_opening_snapshot(p_product_id, p_tenant_id, p_user_id) <> snapshot then
    raise exception 'COINOPS_CAPITAL_OPENING_FINANCIAL_STATE_CHANGED';
  end if;
  return jsonb_build_object('id', existing.id, 'activated_at', existing.activated_at,
    'state_hash', existing.state_hash, 'replayed', false,
    'slot_count', jsonb_array_length(snapshot->'slots'),
    'incorporated_contribution_count', cardinality(contribution_ids));
end;
$$;
revoke all on function private.coinops_activate_capital_opening(uuid, uuid, uuid, text, uuid, text)
  from public, anon, authenticated, service_role;

create view coinops.capital_reporting_entries with (security_invoker = true) as
select c.id, c.product_id, c.tenant_id, c.user_id, c.asset, c.slot_id, c.slot_number,
  c.amount_usdt, c.accounting_amount_usdt, c.gain_equivalent, c.input_mode,
  c.operational_before, c.operational_after, c.reason, c.applied_by, c.created_at,
  c.bulk_batch_id, c.bulk_sequence, c.bulk_slot_count,
  c.manual_gain_batch_id, c.manual_gain_batch_sequence, c.manual_gain_batch_slot_count,
  coalesce(c.id = any(o.incorporated_contribution_ids), false) as incorporated_in_opening,
  'CONTRIBUTION'::text as source
from coinops.btc_external_contributions c
left join coinops.capital_accounting_openings o
  on o.product_id = c.product_id and o.tenant_id = c.tenant_id and o.user_id = c.user_id
union all
select f.id, f.product_id, f.tenant_id, f.user_id, f.asset, f.slot_id, f.slot_number,
  f.amount_usdt, f.amount_usdt, 0::numeric, 'USDT'::text,
  0::numeric, 0::numeric, 'Capital inicial de novo slot'::text, f.user_id, f.created_at,
  null::uuid, null::integer, null::integer, null::uuid, null::integer, null::integer,
  false, 'SLOT_INITIAL_CAPITAL'::text
from coinops.slot_initial_capital f;
revoke all on coinops.capital_reporting_entries from public, anon, authenticated, service_role;
grant select on coinops.capital_reporting_entries to authenticated, service_role;

comment on table coinops.capital_accounting_openings is
  'Owner-approved reporting opening. Full original slot/contribution snapshots; no trade or balance mutation.';
comment on table coinops.slot_initial_capital is
  'Immutable post-opening initial principal, recorded once on slot insertion; never added to slot capital twice.';
comment on view coinops.capital_reporting_entries is
  'RLS-preserving reporting receipts. Current counters exclude incorporated_in_opening; history retains all receipts.';
