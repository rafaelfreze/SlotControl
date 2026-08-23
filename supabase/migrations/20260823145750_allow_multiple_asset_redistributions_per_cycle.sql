-- Allow more than one confirmed ladder redistribution in the same 30-day
-- cycle for both BTC and SOL.
--
-- A completed batch remains immutable and each prepare/confirm request stays
-- idempotent through its existing UUID keys. The asset-scoped advisory lock,
-- snapshot validation and equity conservation checks are intentionally kept.

drop index if exists coinops.btc_redistribution_batches_completed_month_uidx;

create index if not exists growth_redistribution_batches_scope_cycle_status_idx
  on coinops.btc_redistribution_batches
    (product_id, tenant_id, user_id, asset, month_reference, status);

create or replace function coinops.prepare_asset_ladder_redistribution(
  p_asset text,
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
  asset_code text := private.coinops_normalize_growth_asset(p_asset);
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
    raise exception 'COINOPS_GROWTH_REFERENCE_MUST_BE_POSITIVE';
  end if;
  normalized_reference := round(p_reference_level, 8);
  select * into strict scope_row from private.coinops_current_scope();

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'coinops:' || lower(asset_code) || '-capital:' || scope_row.product_id::text || ':'
      || scope_row.tenant_id::text || ':' || scope_row.user_id::text,
    0
  ));

  select * into existing_batch
  from coinops.btc_redistribution_batches batch
  where batch.product_id = scope_row.product_id
    and batch.tenant_id = scope_row.tenant_id
    and batch.user_id = scope_row.user_id
    and batch.asset = asset_code
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

  select
    settings.started_at,
    case when asset_code = 'BTC' then settings.btc_monthly_goal else settings.sol_monthly_goal end
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
  plan_monthly_goal := coalesce(plan_monthly_goal, case when asset_code = 'BTC' then 7 else 1 end);
  plan_elapsed_days := greatest(current_date - plan_started_at, 0);
  plan_cycle_number := greatest(1, ceil(plan_elapsed_days::numeric / 30)::integer);
  plan_month_reference := plan_started_at + ((plan_cycle_number - 1) * 30);

  -- Only an outstanding preview for this asset/cycle becomes stale. Completed
  -- batches remain as immutable history and do not block a new redistribution.
  update coinops.btc_redistribution_batches batch
  set
    status = 'STALE',
    result = batch.result || jsonb_build_object('status', 'STALE', 'can_confirm', false)
  where batch.product_id = scope_row.product_id
    and batch.tenant_id = scope_row.tenant_id
    and batch.user_id = scope_row.user_id
    and batch.asset = asset_code
    and batch.month_reference = plan_month_reference
    and batch.status = 'PREPARED';

  preview_data := private.coinops_build_asset_ladder_preview(
    scope_row.product_id,
    scope_row.tenant_id,
    scope_row.user_id,
    asset_code,
    normalized_reference
  );
  if (preview_data ->> 'equity_difference_usdt')::numeric <> 0 then
    raise exception 'COINOPS_GROWTH_PREVIEW_EQUITY_MISMATCH';
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
    id, product_code, product_id, tenant_id, user_id, asset, month_reference,
    cycle_number, monthly_goal, reference_level, algorithm_version, status,
    prepare_idempotency_key, snapshot_hash, ranking_before, ranking_after,
    equity_before, equity_after, equity_difference, total_transferred_usdt,
    transfer_count, result, created_by
  ) values (
    batch_id, 'coinops', scope_row.product_id, scope_row.tenant_id,
    scope_row.user_id, asset_code, plan_month_reference, plan_cycle_number, plan_monthly_goal,
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
    batch_id, asset_code, plan_month_reference, transfer.sequence_number,
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

revoke all on function coinops.prepare_asset_ladder_redistribution(text, numeric, uuid)
  from public, anon, authenticated, service_role;
grant execute on function coinops.prepare_asset_ladder_redistribution(text, numeric, uuid)
  to authenticated;
