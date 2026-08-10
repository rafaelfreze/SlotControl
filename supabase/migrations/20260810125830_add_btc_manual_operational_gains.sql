-- Adds a gains-first entry point for manual BTC capital contributions.
-- The existing contribution ledger remains the single source of truth: this
-- RPC converts the requested integer operational gains into the exact USDT
-- amount required by the post-contribution gain unit, then delegates the
-- financial mutation to apply_btc_external_contribution.

create or replace function coinops.apply_btc_manual_operational_gains(
  p_slot_id uuid,
  p_operational_gains numeric,
  p_reason text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $manual_gains$
declare
  scope_row record;
  existing_contribution coinops.btc_external_contributions%rowtype;
  slot_row coinops.slots%rowtype;
  normalized_gains numeric(20, 8);
  normalized_reason text;
  base_capital numeric(20, 8);
  raw_amount numeric;
  candidate_amount numeric(20, 8);
  candidate_gain_unit numeric(20, 8);
  candidate_gain_equivalent numeric(20, 8);
  adjustment integer;
  result jsonb;
  stale_preview_count integer := 0;
begin
  if p_slot_id is null or p_idempotency_key is null then
    raise exception 'COINOPS_SLOT_AND_IDEMPOTENCY_REQUIRED';
  end if;

  normalized_gains := round(p_operational_gains, 8);
  normalized_reason := btrim(coalesce(p_reason, ''));
  if normalized_gains is null
    or normalized_gains <= 0
    or normalized_gains <> trunc(normalized_gains)
    or normalized_gains > 1000 then
    raise exception 'COINOPS_MANUAL_GAINS_MUST_BE_POSITIVE_INTEGER';
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

  select contribution.* into existing_contribution
  from coinops.btc_external_contributions contribution
  where contribution.product_id = scope_row.product_id
    and contribution.tenant_id = scope_row.tenant_id
    and contribution.user_id = scope_row.user_id
    and contribution.idempotency_key = p_idempotency_key;

  if found then
    if existing_contribution.slot_id <> p_slot_id
      or existing_contribution.gain_equivalent <> normalized_gains
      or existing_contribution.reason <> normalized_reason then
      raise exception 'COINOPS_IDEMPOTENCY_CONFLICT';
    end if;
    return existing_contribution.result || jsonb_build_object(
      'input_mode', 'OPERATIONAL_GAINS',
      'requested_operational_gains', normalized_gains,
      'already_applied', true
    );
  end if;

  select slot.* into slot_row
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

  if slot_row.gain_rate is null or slot_row.gain_rate <= 0 then
    raise exception 'COINOPS_BTC_GAIN_UNIT_INVALID';
  end if;
  if normalized_gains * slot_row.gain_rate >= 1 then
    raise exception 'COINOPS_MANUAL_GAINS_TOO_LARGE_FOR_SINGLE_ADJUSTMENT';
  end if;

  base_capital := round(slot_row.base_value + slot_row.growth_contribution, 8);
  if base_capital <= 0 then
    raise exception 'COINOPS_BTC_GAIN_UNIT_INVALID';
  end if;

  raw_amount := normalized_gains * slot_row.gain_rate * base_capital
    / (1 - normalized_gains * slot_row.gain_rate);
  candidate_amount := round(raw_amount, 8);

  -- Find the nearest 8-decimal USDT amount whose post-contribution unit
  -- converts back to exactly the requested integer gains. The loop normally
  -- finishes within a few cents of the analytical solution.
  for adjustment in 0..100000 loop
    if adjustment > 0 then
      candidate_amount := round(raw_amount - adjustment * 0.00000001, 8);
    end if;
    if candidate_amount > 0 then
      candidate_gain_unit := private.coinops_gain_unit_usdt(
        slot_row.base_value,
        slot_row.growth_contribution + candidate_amount,
        slot_row.gain_rate
      );
      candidate_gain_equivalent := round(candidate_amount / candidate_gain_unit, 8);
      exit when candidate_gain_equivalent = normalized_gains;
    end if;

    if adjustment > 0 then
      candidate_amount := round(raw_amount + adjustment * 0.00000001, 8);
      candidate_gain_unit := private.coinops_gain_unit_usdt(
        slot_row.base_value,
        slot_row.growth_contribution + candidate_amount,
        slot_row.gain_rate
      );
      candidate_gain_equivalent := round(candidate_amount / candidate_gain_unit, 8);
      exit when candidate_gain_equivalent = normalized_gains;
    end if;
  end loop;

  if candidate_amount is null
    or candidate_amount <= 0
    or candidate_gain_equivalent is distinct from normalized_gains then
    raise exception 'COINOPS_MANUAL_GAINS_EXACT_AMOUNT_NOT_FOUND';
  end if;

  result := coinops.apply_btc_external_contribution(
    p_slot_id,
    candidate_amount,
    normalized_reason,
    p_idempotency_key
  );

  if round((result ->> 'gain_equivalent')::numeric, 8) <> normalized_gains then
    raise exception 'COINOPS_MANUAL_GAINS_POSTCONDITION_FAILED';
  end if;

  update coinops.btc_redistribution_batches batch
  set
    status = 'STALE',
    updated_at = timezone('utc', now()),
    result = batch.result || jsonb_build_object(
      'status', 'STALE',
      'can_confirm', false,
      'stale_reason', 'MANUAL_OPERATIONAL_GAINS_APPLIED',
      'stale_at', timezone('utc', now())
    )
  where batch.product_id = scope_row.product_id
    and batch.tenant_id = scope_row.tenant_id
    and batch.user_id = scope_row.user_id
    and batch.status = 'PREPARED';
  get diagnostics stale_preview_count = row_count;

  return result || jsonb_build_object(
    'input_mode', 'OPERATIONAL_GAINS',
    'requested_operational_gains', normalized_gains,
    'stale_preview_count', stale_preview_count,
    'already_applied', false
  );
end;
$manual_gains$;

comment on function coinops.apply_btc_manual_operational_gains(uuid, numeric, text, uuid)
is 'Adds exact integer BTC operational gains as an audited external contribution; real gains and open-position snapshots remain unchanged.';

revoke all on function coinops.apply_btc_manual_operational_gains(uuid, numeric, text, uuid)
from public, anon, authenticated, service_role;

grant execute on function coinops.apply_btc_manual_operational_gains(uuid, numeric, text, uuid)
to authenticated;
