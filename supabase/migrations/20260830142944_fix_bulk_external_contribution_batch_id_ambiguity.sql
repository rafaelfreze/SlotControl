-- Fix the PL/pgSQL variable/column ambiguity found when the batch updates
-- coinops.slot_capital_ledger, which already has a batch_id column.
-- No financial, scope, RLS, or idempotency rule changes.

create or replace function coinops.apply_asset_external_contribution_batch(
  p_asset text,
  p_amount_per_slot_usdt numeric,
  p_expected_slot_ids uuid[],
  p_reason text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $batch$
declare
  scope_row record;
  active_baseline_id uuid;
  existing_batch coinops.asset_external_contribution_batches%rowtype;
  slot_before record;
  slot_after coinops.slots%rowtype;
  progress_before record;
  progress_after record;
  had_progress boolean;
  asset_code text := private.coinops_normalize_growth_asset(p_asset);
  caller_id uuid := (select auth.uid());
  normalized_amount numeric(20, 8) := round(p_amount_per_slot_usdt, 8);
  normalized_reason text := btrim(coalesce(p_reason, ''));
  normalized_expected_slot_ids uuid[];
  target_slot_ids uuid[];
  expected_slot_count integer;
  target_slot_count integer;
  target_open_count integer;
  sequence_number integer := 0;
  contribution_count integer;
  ledger_count integer;
  stale_preview_count integer := 0;
  batch_operational_before numeric(20, 8);
  batch_operational_after numeric(20, 8);
  expected_total_amount numeric(20, 8);
  bulk_contribution_batch_id uuid := gen_random_uuid();
  child_idempotency_key uuid;
  contribution_id uuid;
  target_ledger_id uuid;
  item_result jsonb;
  batch_items jsonb := '[]'::jsonb;
  batch_result jsonb;
begin
  if caller_id is null then
    raise exception 'COINOPS_AUTH_REQUIRED';
  end if;
  if p_idempotency_key is null then
    raise exception 'COINOPS_BULK_CONTRIBUTION_IDEMPOTENCY_REQUIRED';
  end if;
  if normalized_amount is null or normalized_amount <= 0 then
    raise exception 'COINOPS_CONTRIBUTION_AMOUNT_INVALID';
  end if;
  select array_agg(expected.slot_id order by expected.slot_id)
  into normalized_expected_slot_ids
  from (
    select distinct candidate.slot_id
    from unnest(p_expected_slot_ids) as candidate(slot_id)
    where candidate.slot_id is not null
  ) expected;
  expected_slot_count := coalesce(cardinality(normalized_expected_slot_ids), 0);
  if expected_slot_count not between 1 and 25
    or expected_slot_count <> coalesce(cardinality(p_expected_slot_ids), 0) then
    raise exception 'COINOPS_BULK_CONTRIBUTION_SLOT_COUNT_INVALID';
  end if;
  if char_length(normalized_reason) not between 1 and 500 then
    raise exception 'COINOPS_CONTRIBUTION_REASON_INVALID';
  end if;

  select * into strict scope_row from private.coinops_current_scope();
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'coinops:' || lower(asset_code) || '-capital:' || scope_row.product_id::text || ':'
      || scope_row.tenant_id::text || ':' || scope_row.user_id::text,
    0
  ));

  select batch_row.* into existing_batch
  from coinops.asset_external_contribution_batches batch_row
  where batch_row.product_id = scope_row.product_id
    and batch_row.tenant_id = scope_row.tenant_id
    and batch_row.user_id = scope_row.user_id
    and batch_row.idempotency_key = p_idempotency_key;

  if found then
    if existing_batch.asset <> asset_code
      or existing_batch.amount_per_slot_usdt <> normalized_amount
      or existing_batch.expected_slot_ids <> normalized_expected_slot_ids
      or existing_batch.reason <> normalized_reason then
      raise exception 'COINOPS_IDEMPOTENCY_CONFLICT';
    end if;
    if existing_batch.status <> 'COMPLETED' then
      raise exception 'COINOPS_BULK_CONTRIBUTION_INCOMPLETE';
    end if;
    return existing_batch.result || jsonb_build_object('already_applied', true);
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

  -- Lock the complete target set in a deterministic order before the first
  -- per-slot call. A failure anywhere rolls the whole function back.
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
  order by slot.slot_number, slot.id
  for update of pool, slot;

  select
    array_agg(slot.id order by slot.id),
    count(*)::integer,
    count(*) filter (where slot.status = 'aberto')::integer,
    round(coalesce(sum(slot.operational_slot_value), 0), 8)
  into target_slot_ids, target_slot_count, target_open_count, batch_operational_before
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
    and strategy.asset = asset_code;

  if target_slot_ids is distinct from normalized_expected_slot_ids then
    raise exception 'COINOPS_BULK_CONTRIBUTION_SCOPE_CHANGED';
  end if;
  expected_total_amount := round(normalized_amount * target_slot_count, 8);

  insert into coinops.asset_external_contribution_batches (
    id, product_code, product_id, tenant_id, user_id, baseline_id, asset, idempotency_key,
    amount_per_slot_usdt, expected_slot_ids, expected_slot_count, open_slot_count,
    operational_total_before, reason, status, created_by
  ) values (
    bulk_contribution_batch_id, 'coinops', scope_row.product_id, scope_row.tenant_id,
    scope_row.user_id, active_baseline_id, asset_code, p_idempotency_key, normalized_amount,
    normalized_expected_slot_ids, target_slot_count, target_open_count, batch_operational_before,
    normalized_reason, 'PROCESSING', caller_id
  );

  for slot_before in
    select slot.*
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
    order by slot.slot_number, slot.id
  loop
    sequence_number := sequence_number + 1;

    select progress.id, progress.last_operated_at, progress.cycle_progress
    into progress_before
    from coinops.cycle_slot_progress progress
    join coinops.operational_cycles cycle on cycle.id = progress.cycle_id
    where progress.product_id = scope_row.product_id
      and progress.tenant_id = scope_row.tenant_id
      and progress.user_id = scope_row.user_id
      and progress.slot_id = slot_before.id
      and cycle.status = 'ACTIVE'
    order by cycle.start_at desc
    limit 1;
    had_progress := found;

    child_idempotency_key := gen_random_uuid();
    item_result := coinops.apply_asset_external_contribution(
      asset_code,
      slot_before.id,
      normalized_amount,
      normalized_reason,
      child_idempotency_key
    );
    contribution_id := nullif(item_result ->> 'id', '')::uuid;
    if contribution_id is null then
      raise exception 'COINOPS_BULK_CONTRIBUTION_ITEM_RESULT_INVALID';
    end if;

    select slot.* into strict slot_after
    from coinops.slots slot
    where slot.product_id = scope_row.product_id
      and slot.tenant_id = scope_row.tenant_id
      and slot.user_id = scope_row.user_id
      and slot.id = slot_before.id;

    if slot_after.operational_slot_value <> round(slot_before.operational_slot_value + normalized_amount, 8)
      or slot_after.growth_contribution <> round(slot_before.growth_contribution + normalized_amount, 8)
      or slot_after.status is distinct from slot_before.status
      or slot_after.real_gains is distinct from slot_before.real_gains
      or slot_after.operational_gains is distinct from slot_before.operational_gains
      or slot_after.added_gains is distinct from slot_before.added_gains
      or slot_after.realized_profit is distinct from slot_before.realized_profit
      or slot_after.base_value is distinct from slot_before.base_value
      or slot_after.gain_rate is distinct from slot_before.gain_rate
      or slot_after.redistribution_received_usdt is distinct from slot_before.redistribution_received_usdt
      or slot_after.redistribution_sent_usdt is distinct from slot_before.redistribution_sent_usdt
      or slot_after.position_notional_usdt is distinct from slot_before.position_notional_usdt
      or slot_after.position_gain_unit_usdt is distinct from slot_before.position_gain_unit_usdt
      or slot_after.position_quantity is distinct from slot_before.position_quantity
      or slot_after.position_opened_at is distinct from slot_before.position_opened_at
      or slot_after.preco_entrada is distinct from slot_before.preco_entrada
      or slot_after.preco_atual is distinct from slot_before.preco_atual
      or slot_after.preco_alvo is distinct from slot_before.preco_alvo then
      raise exception 'COINOPS_BULK_CONTRIBUTION_ITEM_POSTCONDITION_FAILED';
    end if;

    if had_progress then
      select progress.id, progress.last_operated_at, progress.cycle_progress
      into progress_after
      from coinops.cycle_slot_progress progress
      where progress.id = progress_before.id;
      if not found
        or progress_after.last_operated_at is distinct from progress_before.last_operated_at
        or progress_after.cycle_progress is distinct from progress_before.cycle_progress then
        raise exception 'COINOPS_BULK_CONTRIBUTION_CYCLE_POSTCONDITION_FAILED';
      end if;
    end if;

    update coinops.btc_external_contributions contribution
    set
      bulk_batch_id = bulk_contribution_batch_id,
      bulk_sequence = sequence_number,
      bulk_slot_count = target_slot_count,
      result = contribution.result || jsonb_build_object(
        'bulk_batch_id', bulk_contribution_batch_id,
        'bulk_sequence', sequence_number,
        'bulk_slot_count', target_slot_count,
        'status_at_contribution', slot_before.status
      )
    where contribution.product_id = scope_row.product_id
      and contribution.tenant_id = scope_row.tenant_id
      and contribution.user_id = scope_row.user_id
      and contribution.id = contribution_id;
    if not found then
      raise exception 'COINOPS_BULK_CONTRIBUTION_ITEM_NOT_FOUND';
    end if;

    update coinops.slot_capital_ledger ledger
    set metadata = ledger.metadata || jsonb_build_object(
      'bulkBatchId', bulk_contribution_batch_id,
      'bulkSequence', sequence_number,
      'bulkSlotCount', target_slot_count
    )
    where ledger.product_id = scope_row.product_id
      and ledger.tenant_id = scope_row.tenant_id
      and ledger.user_id = scope_row.user_id
      and ledger.external_contribution_id = contribution_id
    returning ledger.id into target_ledger_id;
    if not found then
      raise exception 'COINOPS_BULK_CONTRIBUTION_LEDGER_NOT_FOUND';
    end if;

    update coinops.cycle_progress_events event
    set metadata = event.metadata || jsonb_build_object(
      'bulkBatchId', bulk_contribution_batch_id,
      'bulkSequence', sequence_number,
      'bulkSlotCount', target_slot_count
    )
    where event.ledger_id = target_ledger_id;

    stale_preview_count := stale_preview_count
      + coalesce((item_result ->> 'stale_preview_count')::integer, 0);
    batch_items := batch_items || jsonb_build_array(jsonb_build_object(
      'contribution_id', contribution_id,
      'sequence', sequence_number,
      'slot_id', slot_after.id,
      'slot_number', slot_after.slot_number,
      'status', slot_before.status,
      'value_before', slot_before.operational_slot_value,
      'value_after', slot_after.operational_slot_value
    ));
  end loop;

  select round(coalesce(sum(slot.operational_slot_value), 0), 8)
  into batch_operational_after
  from coinops.slot_pool_configuration pool
  join coinops.slots slot
    on slot.product_id = pool.product_id
   and slot.tenant_id = pool.tenant_id
   and slot.user_id = pool.user_id
   and slot.id = pool.slot_id
  where pool.baseline_id = active_baseline_id
    and pool.product_id = scope_row.product_id
    and pool.tenant_id = scope_row.tenant_id
    and pool.user_id = scope_row.user_id
    and pool.asset = asset_code
    and pool.pool = 'MAIN'
    and pool.enabled
    and pool.funded
    and slot.slot_number between 1 and 25;

  select count(*)::integer into contribution_count
  from coinops.btc_external_contributions contribution
  where contribution.product_id = scope_row.product_id
    and contribution.tenant_id = scope_row.tenant_id
    and contribution.user_id = scope_row.user_id
    and contribution.bulk_batch_id = bulk_contribution_batch_id;

  select count(*)::integer into ledger_count
  from coinops.slot_capital_ledger ledger
  join coinops.btc_external_contributions contribution
    on contribution.product_id = ledger.product_id
   and contribution.tenant_id = ledger.tenant_id
   and contribution.user_id = ledger.user_id
   and contribution.id = ledger.external_contribution_id
  where contribution.product_id = scope_row.product_id
    and contribution.tenant_id = scope_row.tenant_id
    and contribution.user_id = scope_row.user_id
    and contribution.bulk_batch_id = bulk_contribution_batch_id;

  if sequence_number <> target_slot_count
    or contribution_count <> target_slot_count
    or ledger_count <> target_slot_count
    or batch_operational_after <> round(batch_operational_before + expected_total_amount, 8) then
    raise exception 'COINOPS_BULK_CONTRIBUTION_BATCH_POSTCONDITION_FAILED';
  end if;

  batch_result := jsonb_build_object(
    'ok', true,
    'status', 'COMPLETED',
    'asset', asset_code,
    'batch_id', bulk_contribution_batch_id,
    'amount_per_slot_usdt', normalized_amount,
    'slot_count', target_slot_count,
    'open_slot_count', target_open_count,
    'free_slot_count', target_slot_count - target_open_count,
    'total_amount_usdt', expected_total_amount,
    'operational_total_before', batch_operational_before,
    'operational_total_after', batch_operational_after,
    'operational_total_delta', round(batch_operational_after - batch_operational_before, 8),
    'stale_preview_count', stale_preview_count,
    'scope', 'MAIN_ENABLED_FUNDED',
    'items', batch_items,
    'already_applied', false,
    'created_at', timezone('utc', now())
  );

  update coinops.asset_external_contribution_batches batch_row
  set
    applied_slot_count = target_slot_count,
    open_slot_count = target_open_count,
    total_amount_usdt = expected_total_amount,
    operational_total_after = batch_operational_after,
    status = 'COMPLETED',
    result = batch_result
  where batch_row.product_id = scope_row.product_id
    and batch_row.tenant_id = scope_row.tenant_id
    and batch_row.user_id = scope_row.user_id
    and batch_row.id = bulk_contribution_batch_id;

  return batch_result;
end
$batch$;
