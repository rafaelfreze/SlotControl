-- Server-calculated, review-before-confirmation batches for manual operational
-- gains. The existing single-slot RPC remains the only owner of the compound
-- calculation and the accounting/ledger writes.

create table coinops.asset_manual_operational_gain_batches (
  id uuid primary key default gen_random_uuid(),
  product_code text not null default 'coinops' check (product_code = 'coinops'),
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  baseline_id uuid not null references coinops.monitoring_baselines(id) on delete restrict,
  asset text not null check (asset in ('BTC', 'SOL')),
  preparation_idempotency_key uuid not null,
  confirmation_idempotency_key uuid,
  below_operational_gains integer not null check (below_operational_gains between 1 and 1000),
  operational_gains_per_slot integer not null check (operational_gains_per_slot between 1 and 1000),
  expected_slot_ids uuid[] not null,
  expected_slot_count integer not null check (expected_slot_count between 1 and 25),
  open_slot_count integer not null default 0 check (open_slot_count between 0 and 25),
  total_amount_usdt numeric(20, 8) not null check (total_amount_usdt > 0),
  operational_total_before numeric(20, 8) not null,
  operational_total_after numeric(20, 8) not null,
  reason text not null check (char_length(btrim(reason)) between 1 and 500),
  items jsonb not null check (jsonb_typeof(items) = 'array'),
  status text not null default 'PREPARED'
    check (status in ('PREPARED', 'COMPLETED', 'CANCELLED', 'STALE', 'EXPIRED')),
  result jsonb not null default '{}'::jsonb,
  expires_at timestamptz not null,
  created_by uuid not null,
  confirmed_by uuid,
  confirmed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint asset_manual_operational_gain_batches_product_fk
    foreign key (product_code, product_id)
      references public.products(code, id) on delete restrict,
  constraint asset_manual_operational_gain_batches_tenant_fk
    foreign key (product_id, tenant_id)
      references public.product_tenants(product_id, tenant_id) on delete restrict,
  unique (product_id, tenant_id, user_id, id),
  unique (product_id, tenant_id, user_id, preparation_idempotency_key),
  check (
    cardinality(expected_slot_ids) = expected_slot_count
    and array_position(expected_slot_ids, null) is null
  ),
  check (
    status <> 'COMPLETED'
    or (
      confirmation_idempotency_key is not null
      and confirmed_by is not null
      and confirmed_at is not null
    )
  )
);

create unique index asset_manual_operational_gain_batches_scope_confirmation_uidx
  on coinops.asset_manual_operational_gain_batches
    (product_id, tenant_id, user_id, confirmation_idempotency_key)
  where confirmation_idempotency_key is not null;

create index asset_manual_operational_gain_batches_scope_status_created_idx
  on coinops.asset_manual_operational_gain_batches
    (product_id, tenant_id, user_id, asset, status, created_at desc);

alter table coinops.btc_external_contributions
  add column manual_gain_batch_id uuid,
  add column manual_gain_batch_sequence integer,
  add column manual_gain_batch_slot_count integer;

alter table coinops.btc_external_contributions
  add constraint btc_external_contributions_manual_gain_batch_fk
  foreign key (product_id, tenant_id, user_id, manual_gain_batch_id)
    references coinops.asset_manual_operational_gain_batches(product_id, tenant_id, user_id, id)
    on delete restrict;

alter table coinops.btc_external_contributions
  add constraint btc_external_contributions_manual_gain_batch_shape_check
  check (
    (manual_gain_batch_id is null and manual_gain_batch_sequence is null and manual_gain_batch_slot_count is null)
    or (
      manual_gain_batch_id is not null
      and manual_gain_batch_sequence is not null
      and manual_gain_batch_slot_count is not null
      and manual_gain_batch_slot_count between 1 and 25
      and manual_gain_batch_sequence between 1 and manual_gain_batch_slot_count
      and bulk_batch_id is null
    )
  );

create unique index btc_external_contributions_scope_manual_gain_batch_sequence_uidx
  on coinops.btc_external_contributions
    (product_id, tenant_id, user_id, manual_gain_batch_id, manual_gain_batch_sequence)
  where manual_gain_batch_id is not null;

create unique index btc_external_contributions_scope_manual_gain_batch_slot_uidx
  on coinops.btc_external_contributions
    (product_id, tenant_id, user_id, manual_gain_batch_id, slot_id)
  where manual_gain_batch_id is not null;

create trigger coinops_scope_asset_manual_operational_gain_batches_v1
before insert or update on coinops.asset_manual_operational_gain_batches
for each row execute function private.coinops_apply_authenticated_scope();

create trigger asset_manual_operational_gain_batches_touch_updated_at
before update on coinops.asset_manual_operational_gain_batches
for each row execute function private.coinops_touch_updated_at();

alter table coinops.asset_manual_operational_gain_batches enable row level security;
alter table coinops.asset_manual_operational_gain_batches force row level security;

create policy asset_manual_operational_gain_batches_owner_select
on coinops.asset_manual_operational_gain_batches for select to authenticated
using (private.coinops_can_access_row(product_id, tenant_id, user_id));

revoke all on table coinops.asset_manual_operational_gain_batches
  from public, anon, authenticated, service_role;
grant select on table coinops.asset_manual_operational_gain_batches
  to authenticated, service_role;

create or replace function coinops.prepare_asset_manual_operational_gains_batch(
  p_asset text,
  p_below_operational_gains numeric,
  p_operational_gains_per_slot numeric,
  p_reason text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $prepare$
declare
  scope_row record;
  asset_code text := private.coinops_normalize_growth_asset(p_asset);
  caller_id uuid := (select auth.uid());
  active_baseline_id uuid;
  existing_batch coinops.asset_manual_operational_gain_batches%rowtype;
  normalized_below_gains integer;
  normalized_gains_per_slot integer;
  normalized_reason text := btrim(coalesce(p_reason, ''));
  batch_items jsonb := '[]'::jsonb;
  target_slot_ids uuid[];
  target_slot_count integer;
  target_open_count integer;
  total_amount numeric(20, 8);
  total_before numeric(20, 8);
  total_after numeric(20, 8);
  manual_gain_batch_id uuid := gen_random_uuid();
  batch_result jsonb;
begin
  if caller_id is null then
    raise exception 'COINOPS_AUTH_REQUIRED';
  end if;
  if p_idempotency_key is null then
    raise exception 'COINOPS_MANUAL_GAINS_BATCH_IDEMPOTENCY_REQUIRED';
  end if;
  if p_below_operational_gains is null
    or p_below_operational_gains <= 0
    or p_below_operational_gains <> trunc(p_below_operational_gains)
    or p_below_operational_gains > 1000 then
    raise exception 'COINOPS_MANUAL_GAINS_BATCH_THRESHOLD_INVALID';
  end if;
  if p_operational_gains_per_slot is null
    or p_operational_gains_per_slot <= 0
    or p_operational_gains_per_slot <> trunc(p_operational_gains_per_slot)
    or p_operational_gains_per_slot > 1000 then
    raise exception 'COINOPS_MANUAL_GAINS_MUST_BE_POSITIVE_INTEGER';
  end if;
  if char_length(normalized_reason) not between 1 and 500 then
    raise exception 'COINOPS_CONTRIBUTION_REASON_INVALID';
  end if;
  normalized_below_gains := p_below_operational_gains::integer;
  normalized_gains_per_slot := p_operational_gains_per_slot::integer;

  select * into strict scope_row from private.coinops_current_scope();
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'coinops:' || lower(asset_code) || '-capital:' || scope_row.product_id::text || ':'
      || scope_row.tenant_id::text || ':' || scope_row.user_id::text,
    0
  ));

  select batch_row.* into existing_batch
  from coinops.asset_manual_operational_gain_batches batch_row
  where batch_row.product_id = scope_row.product_id
    and batch_row.tenant_id = scope_row.tenant_id
    and batch_row.user_id = scope_row.user_id
    and batch_row.preparation_idempotency_key = p_idempotency_key
  for update;
  if found then
    if existing_batch.asset <> asset_code
      or existing_batch.below_operational_gains <> normalized_below_gains
      or existing_batch.operational_gains_per_slot <> normalized_gains_per_slot
      or existing_batch.reason <> normalized_reason then
      raise exception 'COINOPS_IDEMPOTENCY_CONFLICT';
    end if;
    return existing_batch.result || jsonb_build_object(
      'ok', existing_batch.status = 'PREPARED',
      'already_prepared', true,
      'status', existing_batch.status
    );
  end if;

  select baseline.id into active_baseline_id
  from coinops.monitoring_baselines baseline
  where baseline.product_id = scope_row.product_id
    and baseline.tenant_id = scope_row.tenant_id
    and baseline.user_id = scope_row.user_id
    and baseline.status = 'ACTIVE'
  order by baseline.started_at desc
  limit 1;
  if active_baseline_id is null then
    raise exception 'COINOPS_ACTIVE_BASELINE_REQUIRED';
  end if;

  -- The target is determined entirely on the server: enabled, funded MAIN
  -- slots 1-25 for this asset, with operational gains strictly below the
  -- threshold. OPEN slots intentionally remain eligible.
  perform pool.id
  from coinops.slot_pool_configuration pool
  join coinops.slots slot
    on slot.product_id = pool.product_id
   and slot.tenant_id = pool.tenant_id
   and slot.user_id = pool.user_id
   and slot.id = pool.slot_id
  join coinops.strategies strategy
    on strategy.product_id = slot.product_id
   and strategy.tenant_id = slot.tenant_id
   and strategy.user_id = slot.user_id
   and strategy.id = slot.strategy_id
  where pool.baseline_id = active_baseline_id
    and pool.product_id = scope_row.product_id
    and pool.tenant_id = scope_row.tenant_id
    and pool.user_id = scope_row.user_id
    and pool.asset = asset_code
    and pool.pool = 'MAIN'
    and pool.enabled
    and pool.funded
    and slot.slot_number between 1 and 25
    and strategy.asset = asset_code
    and slot.operational_gains < normalized_below_gains
  order by slot.slot_number, slot.id
  for update of pool, slot;

  with candidates as (
    select
      slot.id,
      slot.slot_number,
      slot.status,
      slot.operational_gains,
      slot.operational_slot_value,
      slot.accounting_version,
      slot.gain_rate,
      private.coinops_compound_operational_value_usdt(
        slot.operational_slot_value,
        slot.gain_rate,
        normalized_gains_per_slot
      ) as value_after
    from coinops.slot_pool_configuration pool
    join coinops.slots slot
      on slot.product_id = pool.product_id
     and slot.tenant_id = pool.tenant_id
     and slot.user_id = pool.user_id
     and slot.id = pool.slot_id
    join coinops.strategies strategy
      on strategy.product_id = slot.product_id
     and strategy.tenant_id = slot.tenant_id
     and strategy.user_id = slot.user_id
     and strategy.id = slot.strategy_id
    where pool.baseline_id = active_baseline_id
      and pool.product_id = scope_row.product_id
      and pool.tenant_id = scope_row.tenant_id
      and pool.user_id = scope_row.user_id
      and pool.asset = asset_code
      and pool.pool = 'MAIN'
      and pool.enabled
      and pool.funded
      and slot.slot_number between 1 and 25
      and strategy.asset = asset_code
      and slot.operational_gains < normalized_below_gains
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'slot_id', candidate.id,
      'slot_number', candidate.slot_number,
      'status', candidate.status,
      'operational_before', candidate.operational_gains,
      'operational_after', candidate.operational_gains + normalized_gains_per_slot,
      'value_before', candidate.operational_slot_value,
      'value_after', candidate.value_after,
      'amount_usdt', round(candidate.value_after - candidate.operational_slot_value, 8),
      'gain_rate', candidate.gain_rate,
      'accounting_version', candidate.accounting_version
    ) order by candidate.slot_number, candidate.id), '[]'::jsonb),
    array_agg(candidate.id order by candidate.id),
    count(*)::integer,
    count(*) filter (where candidate.status = 'aberto')::integer,
    round(coalesce(sum(round(candidate.value_after - candidate.operational_slot_value, 8)), 0), 8),
    round(coalesce(sum(candidate.operational_slot_value), 0), 8),
    round(coalesce(sum(candidate.value_after), 0), 8)
  into batch_items, target_slot_ids, target_slot_count, target_open_count,
    total_amount, total_before, total_after
  from candidates candidate;

  if coalesce(target_slot_count, 0) = 0 then
    raise exception 'COINOPS_MANUAL_GAINS_BATCH_EMPTY';
  end if;
  if total_amount <= 0 or total_after <> round(total_before + total_amount, 8) then
    raise exception 'COINOPS_MANUAL_GAINS_BATCH_PREVIEW_INVALID';
  end if;

  update coinops.asset_manual_operational_gain_batches batch_row
  set
    status = 'STALE',
    result = batch_row.result || jsonb_build_object(
      'ok', false,
      'status', 'STALE',
      'stale_reason', 'NEW_PREVIEW_PREPARED',
      'stale_at', timezone('utc', now())
    )
  where batch_row.product_id = scope_row.product_id
    and batch_row.tenant_id = scope_row.tenant_id
    and batch_row.user_id = scope_row.user_id
    and batch_row.asset = asset_code
    and batch_row.status = 'PREPARED';

  batch_result := jsonb_build_object(
    'ok', true,
    'status', 'PREPARED',
    'asset', asset_code,
    'batch_id', manual_gain_batch_id,
    'below_operational_gains', normalized_below_gains,
    'operational_gains_per_slot', normalized_gains_per_slot,
    'slot_count', target_slot_count,
    'open_slot_count', target_open_count,
    'free_slot_count', target_slot_count - target_open_count,
    'total_amount_usdt', total_amount,
    'operational_total_before', total_before,
    'operational_total_after', total_after,
    'scope', 'MAIN_ENABLED_FUNDED_BELOW_THRESHOLD',
    'items', batch_items,
    'expires_at', timezone('utc', now()) + interval '15 minutes',
    'already_prepared', false
  );

  insert into coinops.asset_manual_operational_gain_batches (
    id, product_code, product_id, tenant_id, user_id, baseline_id, asset,
    preparation_idempotency_key, below_operational_gains,
    operational_gains_per_slot, expected_slot_ids, expected_slot_count,
    open_slot_count, total_amount_usdt, operational_total_before,
    operational_total_after, reason, items, status, result, expires_at, created_by
  ) values (
    manual_gain_batch_id, 'coinops', scope_row.product_id, scope_row.tenant_id,
    scope_row.user_id, active_baseline_id, asset_code, p_idempotency_key,
    normalized_below_gains, normalized_gains_per_slot, target_slot_ids,
    target_slot_count, target_open_count, total_amount, total_before, total_after,
    normalized_reason, batch_items, 'PREPARED', batch_result,
    timezone('utc', now()) + interval '15 minutes', caller_id
  );

  return batch_result;
end
$prepare$;

create or replace function coinops.confirm_asset_manual_operational_gains_batch(
  p_asset text,
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
  asset_code text := private.coinops_normalize_growth_asset(p_asset);
  caller_id uuid := (select auth.uid());
  batch_row coinops.asset_manual_operational_gain_batches%rowtype;
  slot_before coinops.slots%rowtype;
  slot_after coinops.slots%rowtype;
  batch_item jsonb;
  item_result jsonb;
  result_items jsonb := '[]'::jsonb;
  manual_operational_gain_batch_id uuid;
  sequence_number integer := 0;
  child_idempotency_key uuid;
  contribution_id uuid;
  ledger_id uuid;
  stale_preview_count integer := 0;
  actual_total_amount numeric(20, 8) := 0;
  batch_result jsonb;
begin
  if caller_id is null then
    raise exception 'COINOPS_AUTH_REQUIRED';
  end if;
  if p_batch_id is null or p_idempotency_key is null then
    raise exception 'COINOPS_MANUAL_GAINS_BATCH_CONFIRMATION_REQUIRED';
  end if;

  select * into strict scope_row from private.coinops_current_scope();
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'coinops:' || lower(asset_code) || '-capital:' || scope_row.product_id::text || ':'
      || scope_row.tenant_id::text || ':' || scope_row.user_id::text,
    0
  ));

  select batch.* into batch_row
  from coinops.asset_manual_operational_gain_batches batch
  where batch.product_id = scope_row.product_id
    and batch.tenant_id = scope_row.tenant_id
    and batch.user_id = scope_row.user_id
    and batch.id = p_batch_id
    and batch.asset = asset_code
  for update;
  if not found then
    raise exception 'COINOPS_MANUAL_GAINS_BATCH_NOT_FOUND';
  end if;
  manual_operational_gain_batch_id := batch_row.id;

  if batch_row.status = 'COMPLETED' then
    if batch_row.confirmation_idempotency_key <> p_idempotency_key then
      raise exception 'COINOPS_IDEMPOTENCY_CONFLICT';
    end if;
    return batch_row.result || jsonb_build_object('already_applied', true);
  end if;
  if batch_row.status <> 'PREPARED' then
    return batch_row.result || jsonb_build_object(
      'ok', false,
      'status', batch_row.status,
      'code', 'COINOPS_MANUAL_GAINS_BATCH_NOT_PREPARED'
    );
  end if;
  if batch_row.expires_at <= timezone('utc', now()) then
    update coinops.asset_manual_operational_gain_batches batch
    set status = 'EXPIRED', result = batch.result || jsonb_build_object(
      'ok', false, 'status', 'EXPIRED', 'code', 'COINOPS_MANUAL_GAINS_BATCH_EXPIRED'
    )
    where batch.id = manual_operational_gain_batch_id;
    return jsonb_build_object(
      'ok', false,
      'status', 'EXPIRED',
      'code', 'COINOPS_MANUAL_GAINS_BATCH_EXPIRED'
    );
  end if;

  -- Verify the server snapshot before applying the first entry. A changed
  -- slot is never silently recalculated at confirmation time.
  for batch_item in
    select value
    from jsonb_array_elements(batch_row.items)
    order by (value ->> 'slot_number')::integer, value ->> 'slot_id'
  loop
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
      and slot.id = (batch_item ->> 'slot_id')::uuid
      and strategy.asset = asset_code
    for update of slot;

    if not found
      or slot_before.operational_gains is distinct from (batch_item ->> 'operational_before')::numeric
      or slot_before.operational_slot_value is distinct from (batch_item ->> 'value_before')::numeric
      or slot_before.accounting_version is distinct from (batch_item ->> 'accounting_version')::integer
      or slot_before.gain_rate is distinct from (batch_item ->> 'gain_rate')::numeric
      or slot_before.status is distinct from batch_item ->> 'status' then
      update coinops.asset_manual_operational_gain_batches batch
      set status = 'STALE', result = batch.result || jsonb_build_object(
        'ok', false,
        'status', 'STALE',
        'code', 'COINOPS_MANUAL_GAINS_BATCH_STALE',
        'stale_slot_id', batch_item ->> 'slot_id',
        'stale_at', timezone('utc', now())
      )
      where batch.id = manual_operational_gain_batch_id;
      return jsonb_build_object(
        'ok', false,
        'status', 'STALE',
        'code', 'COINOPS_MANUAL_GAINS_BATCH_STALE'
      );
    end if;
  end loop;

  for batch_item in
    select value
    from jsonb_array_elements(batch_row.items)
    order by (value ->> 'slot_number')::integer, value ->> 'slot_id'
  loop
    sequence_number := sequence_number + 1;
    select slot.* into strict slot_before
    from coinops.slots slot
    where slot.product_id = scope_row.product_id
      and slot.tenant_id = scope_row.tenant_id
      and slot.user_id = scope_row.user_id
      and slot.id = (batch_item ->> 'slot_id')::uuid;

    child_idempotency_key := gen_random_uuid();
    item_result := coinops.apply_asset_manual_operational_gains(
      asset_code,
      slot_before.id,
      batch_row.operational_gains_per_slot,
      batch_row.reason,
      child_idempotency_key
    );
    contribution_id := nullif(item_result ->> 'id', '')::uuid;
    if contribution_id is null then
      raise exception 'COINOPS_MANUAL_GAINS_BATCH_ITEM_RESULT_INVALID';
    end if;

    select slot.* into strict slot_after
    from coinops.slots slot
    where slot.product_id = scope_row.product_id
      and slot.tenant_id = scope_row.tenant_id
      and slot.user_id = scope_row.user_id
      and slot.id = slot_before.id;

    if slot_after.operational_slot_value is distinct from (batch_item ->> 'value_after')::numeric
      or slot_after.operational_gains is distinct from (batch_item ->> 'operational_after')::numeric
      or slot_after.real_gains is distinct from slot_before.real_gains
      or slot_after.status is distinct from slot_before.status
      or slot_after.accounting_version is distinct from slot_before.accounting_version + 1
      or slot_after.position_notional_usdt is distinct from slot_before.position_notional_usdt
      or slot_after.position_gain_unit_usdt is distinct from slot_before.position_gain_unit_usdt
      or slot_after.position_quantity is distinct from slot_before.position_quantity
      or slot_after.position_opened_at is distinct from slot_before.position_opened_at
      or slot_after.preco_entrada is distinct from slot_before.preco_entrada
      or slot_after.preco_alvo is distinct from slot_before.preco_alvo then
      raise exception 'COINOPS_MANUAL_GAINS_BATCH_ITEM_POSTCONDITION_FAILED';
    end if;

    update coinops.btc_external_contributions contribution
    set
      manual_gain_batch_id = manual_operational_gain_batch_id,
      manual_gain_batch_sequence = sequence_number,
      manual_gain_batch_slot_count = batch_row.expected_slot_count,
      result = contribution.result || jsonb_build_object(
        'manual_gain_batch_id', manual_operational_gain_batch_id,
        'manual_gain_batch_sequence', sequence_number,
        'manual_gain_batch_slot_count', batch_row.expected_slot_count,
        'status_at_contribution', slot_before.status
      )
    where contribution.product_id = scope_row.product_id
      and contribution.tenant_id = scope_row.tenant_id
      and contribution.user_id = scope_row.user_id
      and contribution.id = contribution_id;
    if not found then
      raise exception 'COINOPS_MANUAL_GAINS_BATCH_ITEM_NOT_FOUND';
    end if;

    update coinops.slot_capital_ledger ledger
    set metadata = ledger.metadata || jsonb_build_object(
      'manualGainBatchId', manual_operational_gain_batch_id,
      'manualGainBatchSequence', sequence_number,
      'manualGainBatchSlotCount', batch_row.expected_slot_count
    )
    where ledger.product_id = scope_row.product_id
      and ledger.tenant_id = scope_row.tenant_id
      and ledger.user_id = scope_row.user_id
      and ledger.external_contribution_id = contribution_id
    returning ledger.id into ledger_id;
    if not found then
      raise exception 'COINOPS_MANUAL_GAINS_BATCH_LEDGER_NOT_FOUND';
    end if;

    update coinops.cycle_progress_events event
    set metadata = event.metadata || jsonb_build_object(
      'manualGainBatchId', manual_operational_gain_batch_id,
      'manualGainBatchSequence', sequence_number,
      'manualGainBatchSlotCount', batch_row.expected_slot_count
    )
    where event.ledger_id = ledger_id;

    stale_preview_count := stale_preview_count
      + coalesce((item_result ->> 'stale_preview_count')::integer, 0);
    actual_total_amount := round(actual_total_amount + (item_result ->> 'amount_usdt')::numeric, 8);
    result_items := result_items || jsonb_build_array(batch_item || jsonb_build_object(
      'contribution_id', contribution_id,
      'sequence', sequence_number,
      'applied_at', timezone('utc', now())
    ));
  end loop;

  if sequence_number <> batch_row.expected_slot_count
    or actual_total_amount <> batch_row.total_amount_usdt then
    raise exception 'COINOPS_MANUAL_GAINS_BATCH_POSTCONDITION_FAILED';
  end if;

  batch_result := jsonb_build_object(
    'ok', true,
    'status', 'COMPLETED',
    'asset', asset_code,
    'batch_id', manual_operational_gain_batch_id,
    'below_operational_gains', batch_row.below_operational_gains,
    'operational_gains_per_slot', batch_row.operational_gains_per_slot,
    'slot_count', batch_row.expected_slot_count,
    'open_slot_count', batch_row.open_slot_count,
    'free_slot_count', batch_row.expected_slot_count - batch_row.open_slot_count,
    'total_amount_usdt', actual_total_amount,
    'operational_total_before', batch_row.operational_total_before,
    'operational_total_after', batch_row.operational_total_after,
    'items', result_items,
    'stale_preview_count', stale_preview_count,
    'already_applied', false,
    'completed_at', timezone('utc', now())
  );

  update coinops.asset_manual_operational_gain_batches batch
  set
    status = 'COMPLETED',
    confirmation_idempotency_key = p_idempotency_key,
    confirmed_by = caller_id,
    confirmed_at = timezone('utc', now()),
    result = batch_result
  where batch.id = manual_operational_gain_batch_id;

  return batch_result;
end
$confirm$;

create or replace function coinops.cancel_asset_manual_operational_gains_batch(
  p_asset text,
  p_batch_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $cancel$
declare
  scope_row record;
  asset_code text := private.coinops_normalize_growth_asset(p_asset);
  caller_id uuid := (select auth.uid());
  batch_row coinops.asset_manual_operational_gain_batches%rowtype;
begin
  if caller_id is null then
    raise exception 'COINOPS_AUTH_REQUIRED';
  end if;
  if p_batch_id is null then
    raise exception 'COINOPS_MANUAL_GAINS_BATCH_NOT_FOUND';
  end if;

  select * into strict scope_row from private.coinops_current_scope();
  select batch.* into batch_row
  from coinops.asset_manual_operational_gain_batches batch
  where batch.product_id = scope_row.product_id
    and batch.tenant_id = scope_row.tenant_id
    and batch.user_id = scope_row.user_id
    and batch.id = p_batch_id
    and batch.asset = asset_code
  for update;
  if not found then
    raise exception 'COINOPS_MANUAL_GAINS_BATCH_NOT_FOUND';
  end if;
  if batch_row.status = 'PREPARED' then
    update coinops.asset_manual_operational_gain_batches batch
    set status = 'CANCELLED', result = batch.result || jsonb_build_object(
      'ok', false, 'status', 'CANCELLED', 'cancelled_at', timezone('utc', now())
    )
    where batch.id = batch_row.id;
  end if;
  return jsonb_build_object(
    'ok', true,
    'status', case when batch_row.status = 'PREPARED' then 'CANCELLED' else batch_row.status end,
    'batch_id', batch_row.id,
    'already_closed', batch_row.status <> 'PREPARED'
  );
end
$cancel$;

revoke all on function coinops.prepare_asset_manual_operational_gains_batch(
  text, numeric, numeric, text, uuid
) from public, anon, authenticated, service_role;
grant execute on function coinops.prepare_asset_manual_operational_gains_batch(
  text, numeric, numeric, text, uuid
) to authenticated;

revoke all on function coinops.confirm_asset_manual_operational_gains_batch(
  text, uuid, uuid
) from public, anon, authenticated, service_role;
grant execute on function coinops.confirm_asset_manual_operational_gains_batch(
  text, uuid, uuid
) to authenticated;

revoke all on function coinops.cancel_asset_manual_operational_gains_batch(
  text, uuid
) from public, anon, authenticated, service_role;
grant execute on function coinops.cancel_asset_manual_operational_gains_batch(
  text, uuid
) to authenticated;

comment on table coinops.asset_manual_operational_gain_batches is
  'Immutable server-calculated previews and completed audit headers for all-or-nothing manual operational gains across eligible MAIN slots.';
comment on function coinops.prepare_asset_manual_operational_gains_batch(
  text, numeric, numeric, text, uuid
) is
  'Prepares a reviewable batch for enabled, funded MAIN BTC or SOL slots 1-25 strictly below an operational-gain threshold; no slot is changed.';
comment on function coinops.confirm_asset_manual_operational_gains_batch(
  text, uuid, uuid
) is
  'Confirms a fresh manual-gain batch atomically by reusing the authoritative per-slot compounding RPC; real gains and positions remain unchanged.';
