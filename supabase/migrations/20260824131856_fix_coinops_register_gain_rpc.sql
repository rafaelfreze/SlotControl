-- Route manual real-gain closes through an explicitly authorized server-side
-- transaction. Direct authenticated REST updates cannot execute the private
-- gain-unit helper used by the slot integrity trigger and were returning 403.
-- The RPC keeps that helper private, derives every financial value in the
-- database and makes concurrent/repeated closes idempotent at slot state level.

create or replace function coinops.register_asset_real_gain(p_slot_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $gain$
declare
  scope_row record;
  caller_id uuid := (select auth.uid());
  slot_before coinops.slots%rowtype;
  slot_after coinops.slots%rowtype;
  asset_code text;
  strategy_gain_rate numeric(12, 8);
  expected_gain_amount numeric(20, 8);
begin
  if caller_id is null then
    raise exception 'COINOPS_AUTH_REQUIRED';
  end if;
  if p_slot_id is null then
    raise exception 'COINOPS_SLOT_REQUIRED';
  end if;

  select * into strict scope_row
  from private.coinops_current_scope();

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'coinops:real-gain:' || scope_row.product_id::text || ':'
      || scope_row.tenant_id::text || ':' || scope_row.user_id::text || ':'
      || p_slot_id::text,
    0
  ));

  select slot.* into slot_before
  from coinops.slots slot
  where slot.product_id = scope_row.product_id
    and slot.tenant_id = scope_row.tenant_id
    and slot.user_id = scope_row.user_id
    and slot.id = p_slot_id
  for update of slot;

  if not found then
    raise exception 'COINOPS_SLOT_NOT_FOUND';
  end if;

  select upper(strategy.asset), strategy.gain_rate
    into asset_code, strategy_gain_rate
  from coinops.strategies strategy
  where strategy.product_id = scope_row.product_id
    and strategy.tenant_id = scope_row.tenant_id
    and strategy.user_id = scope_row.user_id
    and strategy.id = slot_before.strategy_id;

  if asset_code not in ('BTC', 'SOL')
    or strategy_gain_rate is null
    or strategy_gain_rate <= 0 then
    raise exception 'COINOPS_SLOT_STRATEGY_INVALID';
  end if;

  -- A repeated request after a successful close must never count another gain.
  if slot_before.status <> 'aberto' then
    if slot_before.status = 'gain' then
      return jsonb_build_object(
        'ok', true,
        'already_applied', true,
        'asset', asset_code,
        'slot_id', slot_before.id,
        'slot_number', slot_before.slot_number,
        'status_after', slot_before.status,
        'gains_after', slot_before.gains,
        'real_gains_after', slot_before.real_gains,
        'operational_gains_after', slot_before.operational_gains,
        'value_after', slot_before.operational_slot_value,
        'accounting_version', slot_before.accounting_version
      );
    end if;
    raise exception 'COINOPS_SLOT_NOT_OPEN';
  end if;

  expected_gain_amount := private.coinops_position_gain_unit_usdt(
    slot_before.operational_slot_value,
    slot_before.gain_rate
  );
  if expected_gain_amount is null or expected_gain_amount <= 0 then
    raise exception 'COINOPS_GROWTH_GAIN_UNIT_INVALID';
  end if;

  update coinops.slots slot
  set
    status = 'gain',
    gains = slot.gains + 1,
    real_gains = slot.real_gains + 1,
    added_gains = slot.added_gains,
    gain_rate = strategy_gain_rate,
    started_once = true,
    preco_entrada = null,
    preco_atual = null,
    preco_alvo = null
  where slot.product_id = scope_row.product_id
    and slot.tenant_id = scope_row.tenant_id
    and slot.user_id = scope_row.user_id
    and slot.id = slot_before.id
    and slot.status = 'aberto'
  returning * into strict slot_after;

  if slot_after.status <> 'gain'
    or slot_after.gains <> slot_before.gains + 1
    or slot_after.real_gains <> slot_before.real_gains + 1
    or slot_after.added_gains <> slot_before.added_gains
    or slot_after.operational_gains <> slot_before.operational_gains + 1
    or slot_after.realized_profit <> round(slot_before.realized_profit + expected_gain_amount, 8)
    or slot_after.operational_slot_value <> round(slot_before.operational_slot_value + expected_gain_amount, 8)
    or slot_after.accounting_version <> slot_before.accounting_version + 1
    or slot_after.base_value is distinct from slot_before.base_value
    or slot_after.growth_contribution is distinct from slot_before.growth_contribution
    or slot_after.redistribution_received_usdt is distinct from slot_before.redistribution_received_usdt
    or slot_after.redistribution_sent_usdt is distinct from slot_before.redistribution_sent_usdt
    or slot_after.position_notional_usdt is distinct from slot_before.position_notional_usdt
    or slot_after.position_gain_unit_usdt is distinct from slot_before.position_gain_unit_usdt
    or slot_after.position_quantity is distinct from slot_before.position_quantity
    or slot_after.position_opened_at is distinct from slot_before.position_opened_at then
    raise exception 'COINOPS_REAL_GAIN_POSTCONDITION_FAILED';
  end if;

  return jsonb_build_object(
    'ok', true,
    'already_applied', false,
    'asset', asset_code,
    'slot_id', slot_after.id,
    'slot_number', slot_after.slot_number,
    'status_before', slot_before.status,
    'status_after', slot_after.status,
    'gains_after', slot_after.gains,
    'real_gains_after', slot_after.real_gains,
    'operational_gains_after', slot_after.operational_gains,
    'value_before', slot_before.operational_slot_value,
    'value_after', slot_after.operational_slot_value,
    'realized_profit_before', slot_before.realized_profit,
    'realized_profit_after', slot_after.realized_profit,
    'gain_amount_usdt', expected_gain_amount,
    'accounting_version', slot_after.accounting_version
  );
end;
$gain$;

revoke all on function coinops.register_asset_real_gain(uuid)
  from public, anon, authenticated, service_role;
grant execute on function coinops.register_asset_real_gain(uuid)
  to authenticated, service_role;

comment on function coinops.register_asset_real_gain(uuid) is
  'Closes one scoped OPEN BTC/SOL slot as one real gain, atomically and idempotently, while preserving the executed position snapshot.';
