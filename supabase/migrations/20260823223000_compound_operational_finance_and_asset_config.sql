-- CoinOps: authoritative compound operational accounting and asset-scoped plan config.
--
-- This migration is additive and preserves real gains, legacy added gains,
-- executed position snapshots and immutable financial history.  It changes
-- only the derived accounting used by future gains/redistributions and adds a
-- read-only reconciliation report for the safely reconstructible current
-- balances.

alter table coinops.growth_plan_settings
  add column if not exists btc_ladder_reference numeric(20, 8),
  add column if not exists sol_ladder_reference numeric(20, 8);

alter table coinops.growth_plan_settings
  drop constraint if exists growth_plan_settings_btc_ladder_reference_check,
  drop constraint if exists growth_plan_settings_sol_ladder_reference_check;

alter table coinops.growth_plan_settings
  add constraint growth_plan_settings_btc_ladder_reference_check
    check (
      btc_ladder_reference is null
      or (btc_ladder_reference > 0 and btc_ladder_reference = trunc(btc_ladder_reference))
    ),
  add constraint growth_plan_settings_sol_ladder_reference_check
    check (
      sol_ladder_reference is null
      or (sol_ladder_reference > 0 and sol_ladder_reference = trunc(sol_ladder_reference))
    );

-- Backfill each asset only from its own latest confirmed batch.  No BTC value
-- is ever copied to SOL (or vice versa).
update coinops.growth_plan_settings settings
set btc_ladder_reference = (
  select batch.reference_level
  from coinops.btc_redistribution_batches batch
  where batch.product_id = settings.product_id
    and batch.tenant_id = settings.tenant_id
    and batch.user_id = settings.user_id
    and batch.asset = 'BTC'
    and batch.status = 'COMPLETED'
  order by batch.completed_at desc nulls last, batch.created_at desc, batch.id desc
  limit 1
)
where settings.btc_ladder_reference is null;

update coinops.growth_plan_settings settings
set sol_ladder_reference = (
  select batch.reference_level
  from coinops.btc_redistribution_batches batch
  where batch.product_id = settings.product_id
    and batch.tenant_id = settings.tenant_id
    and batch.user_id = settings.user_id
    and batch.asset = 'SOL'
    and batch.status = 'COMPLETED'
  order by batch.completed_at desc nulls last, batch.created_at desc, batch.id desc
  limit 1
)
where settings.sol_ladder_reference is null;

alter table coinops.btc_redistribution_transfers
  add column if not exists donor_gain_rate numeric(12, 8),
  add column if not exists receiver_gain_rate numeric(12, 8);

alter table coinops.btc_redistribution_transfers
  drop constraint if exists btc_redistribution_transfers_donor_gain_rate_check,
  drop constraint if exists btc_redistribution_transfers_receiver_gain_rate_check;

alter table coinops.btc_redistribution_transfers
  add constraint btc_redistribution_transfers_donor_gain_rate_check
    check (donor_gain_rate is null or donor_gain_rate > 0),
  add constraint btc_redistribution_transfers_receiver_gain_rate_check
    check (receiver_gain_rate is null or receiver_gain_rate > 0);

-- Best available audit backfill for legacy transfers.  Historical amounts and
-- counters are never rewritten.
update coinops.btc_redistribution_transfers transfer
set
  donor_gain_rate = donor.gain_rate,
  receiver_gain_rate = receiver.gain_rate
from coinops.slots donor, coinops.slots receiver
where donor.product_id = transfer.product_id
  and donor.tenant_id = transfer.tenant_id
  and donor.user_id = transfer.user_id
  and donor.id = transfer.donor_slot_id
  and receiver.product_id = transfer.product_id
  and receiver.tenant_id = transfer.tenant_id
  and receiver.user_id = transfer.user_id
  and receiver.id = transfer.receiver_slot_id
  and (transfer.donor_gain_rate is null or transfer.receiver_gain_rate is null);

create or replace function private.coinops_compound_operational_value_usdt(
  p_value_before numeric,
  p_gain_rate numeric,
  p_gain_count integer
)
returns numeric
language sql
immutable
strict
set search_path = ''
as $compound$
  select case
    when p_value_before < 0 or p_gain_rate <= 0 or p_gain_count < 0 then null
    else round(p_value_before * power(1 + p_gain_rate, p_gain_count), 8)
  end;
$compound$;

create or replace function private.coinops_reverse_operational_gains_usdt(
  p_value_after numeric,
  p_gain_rate numeric,
  p_gain_count integer
)
returns numeric
language sql
immutable
strict
set search_path = ''
as $reverse$
  select case
    when p_value_after < 0 or p_gain_rate <= 0 or p_gain_count < 0 then null
    else round(p_value_after / power(1 + p_gain_rate, p_gain_count), 8)
  end;
$reverse$;

revoke all on function private.coinops_compound_operational_value_usdt(numeric, numeric, integer)
  from public, anon, authenticated, service_role;
revoke all on function private.coinops_reverse_operational_gains_usdt(numeric, numeric, integer)
  from public, anon, authenticated, service_role;

create or replace function private.coinops_apply_asset_realized_profit_on_real_gain()
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

  if asset_code in ('BTC', 'SOL') then
    if old.status = 'aberto'
      and new.status = 'gain'
      and new.real_gains = old.real_gains + 1
      and new.added_gains = old.added_gains
      and new.gains = old.gains + 1 then
      -- A manual gain is always the configured percentage of the complete
      -- operational balance immediately before the close.  The frozen
      -- position snapshot remains exclusively for open-market PnL.
      gain_unit := private.coinops_position_gain_unit_usdt(
        old.operational_slot_value,
        old.gain_rate
      );
      if gain_unit is null or gain_unit <= 0 then
        raise exception 'COINOPS_GROWTH_GAIN_UNIT_INVALID';
      end if;

      new.realized_profit := round(old.realized_profit + gain_unit, 8);
      new.operational_gains := old.operational_gains + 1;
      new.accounting_version := old.accounting_version + 1;
    end if;
  elsif new.gains > old.gains then
    new.realized_profit := round(
      (new.base_value + new.growth_contribution) * new.gain_rate * new.gains,
      8
    );
  end if;

  return new;
end;
$profit$;

create or replace function private.coinops_enforce_asset_gain_breakdown()
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
    if asset_code in ('BTC', 'SOL')
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
      raise exception 'COINOPS_GROWTH_INITIAL_CAPITAL_REQUIRES_SERVER_VALUES';
    end if;
    return new;
  end if;

  valid_real_gain :=
    old.status = 'aberto'
    and new.status = 'gain'
    and new.real_gains = old.real_gains + 1
    and new.added_gains = old.added_gains
    and new.gains = old.gains + 1;

  if asset_code in ('BTC', 'SOL') then
    if valid_real_gain then
      expected_real_gain_unit := private.coinops_position_gain_unit_usdt(
        old.operational_slot_value,
        old.gain_rate
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
        and new.operational_gains = old.operational_gains + 1
        and new.accounting_version = old.accounting_version + 1
        and new.position_notional_usdt is not distinct from old.position_notional_usdt
        and new.position_gain_unit_usdt is not distinct from old.position_gain_unit_usdt
        and new.position_quantity is not distinct from old.position_quantity
        and new.position_opened_at is not distinct from old.position_opened_at;
    end if;

    if new.real_gains < old.real_gains then
      raise exception 'COINOPS_GROWTH_REAL_GAINS_IMMUTABLE';
    end if;
    if new.real_gains <> old.real_gains and not valid_real_gain then
      raise exception 'COINOPS_REAL_GAINS_REQUIRE_SLOT_CLOSE';
    end if;
    if new.added_gains <> old.added_gains then
      raise exception 'COINOPS_GROWTH_ADDED_GAINS_LEGACY_READ_ONLY';
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
      raise exception 'COINOPS_GROWTH_CLOSE_REQUIRES_EXACT_REAL_GAIN';
    end if;
    if new.base_value is distinct from old.base_value
      and not internal_capital_mutation then
      raise exception 'COINOPS_GROWTH_BASE_VALUE_REQUIRES_RPC';
    end if;
    if new.gain_rate is distinct from old.gain_rate
      and not internal_capital_mutation
      and not valid_strategy_rate_sync then
      raise exception 'COINOPS_GROWTH_GAIN_RATE_REQUIRES_RPC';
    end if;
    if (
      new.operational_gains is distinct from old.operational_gains
      or new.redistribution_received_usdt is distinct from old.redistribution_received_usdt
      or new.redistribution_sent_usdt is distinct from old.redistribution_sent_usdt
      or new.growth_contribution is distinct from old.growth_contribution
      or new.realized_profit is distinct from old.realized_profit
      or new.accounting_version is distinct from old.accounting_version
    ) and not internal_capital_mutation and not valid_real_gain then
      raise exception 'COINOPS_GROWTH_CAPITAL_MUTATION_REQUIRES_RPC';
    end if;
    if (
      new.position_notional_usdt is distinct from old.position_notional_usdt
      or new.position_gain_unit_usdt is distinct from old.position_gain_unit_usdt
      or new.position_quantity is distinct from old.position_quantity
      or new.position_opened_at is distinct from old.position_opened_at
    ) and not internal_capital_mutation and not valid_open_snapshot and not valid_real_gain then
      raise exception 'COINOPS_GROWTH_POSITION_SNAPSHOT_INVALID';
    end if;
  end if;

  return new;
end;
$gain_breakdown$;

create or replace function private.coinops_record_asset_real_gain()
returns trigger
language plpgsql
security definer
set search_path = ''
as $ledger$
declare
  asset_code text;
  gain_unit_before numeric(20, 8);
  gain_unit_after numeric(20, 8);
begin
  select strategy.asset
    into asset_code
  from coinops.strategies strategy
  where strategy.product_id = new.product_id
    and strategy.tenant_id = new.tenant_id
    and strategy.user_id = new.user_id
    and strategy.id = new.strategy_id;

  if asset_code in ('BTC', 'SOL')
    and old.status = 'aberto'
    and new.status = 'gain'
    and new.real_gains = old.real_gains + 1
    and new.added_gains = old.added_gains
    and new.gains = old.gains + 1 then
    gain_unit_before := private.coinops_position_gain_unit_usdt(
      old.operational_slot_value, old.gain_rate
    );
    gain_unit_after := private.coinops_position_gain_unit_usdt(
      new.operational_slot_value, new.gain_rate
    );

    insert into coinops.slot_capital_ledger (
      product_code, product_id, tenant_id, user_id, slot_id, entry_type,
      amount_usdt, operational_gain_delta, operational_before, operational_after,
      value_before, value_after, gain_unit_before_usdt, gain_unit_after_usdt,
      redistribution_received_before, redistribution_received_after,
      redistribution_sent_before, redistribution_sent_after,
      real_gains_snapshot, added_gains_snapshot, metadata, created_by
    ) values (
      'coinops', new.product_id, new.tenant_id, new.user_id, new.id, 'REAL_GAIN',
      round(new.operational_slot_value - old.operational_slot_value, 8),
      new.operational_gains - old.operational_gains,
      old.operational_gains, new.operational_gains,
      old.operational_slot_value, new.operational_slot_value,
      gain_unit_before, gain_unit_after,
      old.redistribution_received_usdt, new.redistribution_received_usdt,
      old.redistribution_sent_usdt, new.redistribution_sent_usdt,
      new.real_gains, new.added_gains,
      jsonb_build_object(
        'asset', asset_code,
        'gainRateUsed', old.gain_rate,
        'operationalValueBefore', old.operational_slot_value,
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

-- V5 values every whole operational gain against the slot's current total
-- operational capital. Removing gains is the exact inverse operation. The
-- same cash amount is credited to the receiver, so a redistribution changes
-- neither equity nor real_gains.
do $preview_patch$
declare
  preview_function oid;
  function_definition text;
  old_allocation text := $old$
        donor_capacity_usdt := round(donor_excess * donor_gain_unit, 8);

        -- Spend as many whole donor gains as the current receiver can absorb
        -- without crossing the reference. The exact USDT debit is credited;
        -- only complete receiver gains advance its operational counter.
        candidate_donor_gains := least(
          donor_excess::integer,
          trunc((receiver_deficit * receiver_gain_unit) / donor_gain_unit)::integer
        );
        amount_usdt := 0;
        donor_gain_equivalent := 0;
        receiver_gain_equivalent := 0;

        while candidate_donor_gains > 0 loop
          candidate_amount := round(candidate_donor_gains * donor_gain_unit, 8);
          candidate_receiver_gains := least(
            receiver_deficit::integer,
            trunc(candidate_amount / receiver_gain_unit)::integer
          );
          if candidate_receiver_gains > 0 then
            amount_usdt := candidate_amount;
            donor_gain_equivalent := candidate_donor_gains;
            receiver_gain_equivalent := candidate_receiver_gains;
            exit;
          end if;
          candidate_donor_gains := candidate_donor_gains - 1;
        end loop;
$old$;
  new_allocation text := $new$
        donor_capacity_usdt := round(
          donor_value_before - private.coinops_reverse_operational_gains_usdt(
            donor_value_before,
            (donor_state ->> 'gain_rate')::numeric,
            donor_excess::integer
          ),
          8
        );

        candidate_donor_gains := least(
          donor_excess::integer,
          receiver_deficit::integer
        );
        amount_usdt := 0;
        donor_gain_equivalent := 0;
        receiver_gain_equivalent := 0;

        while candidate_donor_gains > 0 loop
          candidate_amount := round(
            donor_value_before - private.coinops_reverse_operational_gains_usdt(
              donor_value_before,
              (donor_state ->> 'gain_rate')::numeric,
              candidate_donor_gains::integer
            ),
            8
          );
          candidate_receiver_gains := receiver_deficit::integer;
          while candidate_receiver_gains > 0 loop
            exit when round(
              private.coinops_compound_operational_value_usdt(
                receiver_value_before,
                (receiver_state ->> 'gain_rate')::numeric,
                candidate_receiver_gains
              ) - receiver_value_before,
              8
            ) <= candidate_amount;
            candidate_receiver_gains := candidate_receiver_gains - 1;
          end loop;
          if candidate_receiver_gains > 0 then
            amount_usdt := candidate_amount;
            donor_gain_equivalent := candidate_donor_gains;
            receiver_gain_equivalent := candidate_receiver_gains;
            exit;
          end if;
          candidate_donor_gains := candidate_donor_gains - 1;
        end loop;
$new$;
  old_available text := $old$
      coalesce(sum(round(
        greatest((entry.value ->> 'operational_gains')::numeric - p_reference_level, 0)
          * (entry.value ->> 'gain_unit_usdt')::numeric,
        8
      )), 0)
$old$;
  new_available text := $new$
      coalesce(sum(round(
        (entry.value ->> 'operational_value_usdt')::numeric
          - private.coinops_reverse_operational_gains_usdt(
              (entry.value ->> 'operational_value_usdt')::numeric,
              (entry.value ->> 'gain_rate')::numeric,
              greatest(
                (entry.value ->> 'operational_gains')::numeric - p_reference_level,
                0
              )::integer
            ),
        8
      )), 0)
$new$;
  old_remaining text := $old$
      coalesce(sum(round(greatest((entry.value ->> 'operational_gains')::numeric - p_reference_level, 0)
        * (entry.value ->> 'gain_unit_usdt')::numeric, 8)), 0),
      coalesce(sum(greatest(p_reference_level - (entry.value ->> 'operational_gains')::numeric, 0)), 0),
      coalesce(sum(round(greatest(p_reference_level - (entry.value ->> 'operational_gains')::numeric, 0)
        * (entry.value ->> 'gain_unit_usdt')::numeric, 8)), 0)
$old$;
  new_remaining text := $new$
      coalesce(sum(round(
        (entry.value ->> 'operational_value_usdt')::numeric
          - private.coinops_reverse_operational_gains_usdt(
              (entry.value ->> 'operational_value_usdt')::numeric,
              (entry.value ->> 'gain_rate')::numeric,
              greatest(
                (entry.value ->> 'operational_gains')::numeric - p_reference_level,
                0
              )::integer
            ),
        8
      )), 0),
      coalesce(sum(greatest(p_reference_level - (entry.value ->> 'operational_gains')::numeric, 0)), 0),
      coalesce(sum(round(
        private.coinops_compound_operational_value_usdt(
          (entry.value ->> 'operational_value_usdt')::numeric,
          (entry.value ->> 'gain_rate')::numeric,
          greatest(
            p_reference_level - (entry.value ->> 'operational_gains')::numeric,
            0
          )::integer
        ) - (entry.value ->> 'operational_value_usdt')::numeric,
        8
      )), 0)
$new$;
begin
  preview_function := to_regprocedure(
    'private.coinops_build_asset_ladder_preview(uuid,uuid,uuid,text,numeric)'
  );
  if preview_function is null then
    raise exception 'COINOPS_GROWTH_PREVIEW_FUNCTION_NOT_FOUND';
  end if;

  function_definition := pg_get_functiondef(preview_function);
  if position('''_LADDER_ALL_DONORS_WHOLE_GAINS_V4''' in function_definition) = 0
    or position(old_allocation in function_definition) = 0
    or position(old_available in function_definition) = 0
    or position(old_remaining in function_definition) = 0 then
    raise exception 'COINOPS_GROWTH_PREVIEW_V4_DEFINITION_UNEXPECTED';
  end if;

  function_definition := replace(
    function_definition,
    '''_LADDER_ALL_DONORS_WHOLE_GAINS_V4''',
    '''_LADDER_COMPOUND_BALANCE_V5'''
  );
  function_definition := replace(
    function_definition,
    $old$private.coinops_gain_unit_usdt(
      slot_record.base_value,
      slot_record.growth_contribution,
      slot_record.gain_rate
    )$old$,
    $new$private.coinops_position_gain_unit_usdt(
      slot_record.operational_slot_value,
      slot_record.gain_rate
    )$new$
  );
  function_definition := replace(
    function_definition,
    $old$        'gain_unit_usdt', gain_unit,
        'accounting_version'$old$,
    $new$        'gain_unit_usdt', gain_unit,
        'gain_rate', round(slot_record.gain_rate, 8),
        'accounting_version'$new$
  );
  function_definition := replace(function_definition, old_available, new_available);
  function_definition := replace(function_definition, old_allocation, new_allocation);
  function_definition := replace(function_definition, old_remaining, new_remaining);
  function_definition := replace(
    function_definition,
    $old$          'receiver_gain_unit_usdt', receiver_gain_unit,
          'donor_gain_equivalent'$old$,
    $new$          'receiver_gain_unit_usdt', receiver_gain_unit,
          'donor_gain_rate', (donor_state ->> 'gain_rate')::numeric,
          'receiver_gain_rate', (receiver_state ->> 'gain_rate')::numeric,
          'donor_gain_equivalent'$new$
  );

  execute function_definition;
end;
$preview_patch$;

update coinops.btc_redistribution_batches batch
set
  status = 'STALE',
  result = batch.result || jsonb_build_object(
    'status', 'STALE',
    'can_confirm', false,
    'stale_reason', 'COMPOUND_ALGORITHM_UPDATED'
  ),
  updated_at = timezone('utc', now())
where batch.status = 'PREPARED';

revoke all on function private.coinops_build_asset_ladder_preview(uuid, uuid, uuid, text, numeric)
  from public, anon, authenticated, service_role;

-- Persist the exact asset rates used by every prepared transfer.
do $prepare_patch$
declare
  function_definition text;
begin
  function_definition := pg_get_functiondef(
    to_regprocedure('coinops.prepare_asset_ladder_redistribution(text,numeric,uuid)')
  );
  function_definition := replace(
    function_definition,
    $old$    donor_gain_unit_usdt, receiver_gain_unit_usdt, donor_gain_equivalent,$old$,
    $new$    donor_gain_unit_usdt, receiver_gain_unit_usdt, donor_gain_rate,
    receiver_gain_rate, donor_gain_equivalent,$new$
  );
  function_definition := replace(
    function_definition,
    $old$    transfer.donor_gain_unit_usdt, transfer.receiver_gain_unit_usdt,
    transfer.donor_gain_equivalent,$old$,
    $new$    transfer.donor_gain_unit_usdt, transfer.receiver_gain_unit_usdt,
    transfer.donor_gain_rate, transfer.receiver_gain_rate,
    transfer.donor_gain_equivalent,$new$
  );
  function_definition := replace(
    function_definition,
    $old$    receiver_gain_unit_usdt numeric,
    donor_gain_equivalent numeric,$old$,
    $new$    receiver_gain_unit_usdt numeric,
    donor_gain_rate numeric,
    receiver_gain_rate numeric,
    donor_gain_equivalent numeric,$new$
  );
  if position('donor_gain_rate' in function_definition) = 0
    or position('receiver_gain_rate' in function_definition) = 0 then
    raise exception 'COINOPS_GROWTH_PREPARE_RATE_PATCH_FAILED';
  end if;
  execute function_definition;
end;
$prepare_patch$;

-- Confirm revalidates both the current total-capital unit and the persisted
-- asset rate. The OPEN position snapshot remains frozen and is never used as
-- the realized Gain basis.
do $confirm_patch$
declare
  function_definition text;
begin
  function_definition := pg_get_functiondef(
    to_regprocedure('coinops.confirm_asset_ladder_redistribution(text,uuid,uuid)')
  );
  function_definition := replace(
    function_definition,
    $old$      or private.coinops_gain_unit_usdt(
        donor_before.base_value, donor_before.growth_contribution, donor_before.gain_rate
      ) <> transfer_row.donor_gain_unit_usdt
      or private.coinops_gain_unit_usdt(
        receiver_before.base_value, receiver_before.growth_contribution, receiver_before.gain_rate
      ) <> transfer_row.receiver_gain_unit_usdt then$old$,
    $new$      or private.coinops_position_gain_unit_usdt(
        donor_before.operational_slot_value, donor_before.gain_rate
      ) <> transfer_row.donor_gain_unit_usdt
      or private.coinops_position_gain_unit_usdt(
        receiver_before.operational_slot_value, receiver_before.gain_rate
      ) <> transfer_row.receiver_gain_unit_usdt
      or donor_before.gain_rate <> transfer_row.donor_gain_rate
      or receiver_before.gain_rate <> transfer_row.receiver_gain_rate then$new$
  );
  function_definition := replace(
    function_definition,
    $old$      transfer_row.donor_gain_unit_usdt, transfer_row.donor_gain_unit_usdt,$old$,
    $new$      transfer_row.donor_gain_unit_usdt,
      private.coinops_position_gain_unit_usdt(
        donor_after.operational_slot_value, donor_after.gain_rate
      ),$new$
  );
  function_definition := replace(
    function_definition,
    $old$      transfer_row.receiver_gain_unit_usdt, transfer_row.receiver_gain_unit_usdt,$old$,
    $new$      transfer_row.receiver_gain_unit_usdt,
      private.coinops_position_gain_unit_usdt(
        receiver_after.operational_slot_value, receiver_after.gain_rate
      ),$new$
  );
  function_definition := replace(
    function_definition,
    $old$        'referenceLevel', batch_row.reference_level,
        'counterpartySlotId', receiver_after.id,$old$,
    $new$        'referenceLevel', batch_row.reference_level,
        'gainRateUsed', transfer_row.donor_gain_rate,
        'counterpartySlotId', receiver_after.id$new$
  );
  function_definition := replace(
    function_definition,
    $old$        'referenceLevel', batch_row.reference_level,
        'counterpartySlotId', donor_after.id,$old$,
    $new$        'referenceLevel', batch_row.reference_level,
        'gainRateUsed', transfer_row.receiver_gain_rate,
        'counterpartySlotId', donor_after.id$new$
  );
  if position('donor_before.gain_rate <> transfer_row.donor_gain_rate' in function_definition) = 0 then
    raise exception 'COINOPS_GROWTH_CONFIRM_RATE_PATCH_FAILED';
  end if;
  execute function_definition;
end;
$confirm_patch$;

revoke all on function coinops.prepare_asset_ladder_redistribution(text, numeric, uuid)
  from public, anon, authenticated, service_role;
revoke all on function coinops.confirm_asset_ladder_redistribution(text, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function coinops.prepare_asset_ladder_redistribution(text, numeric, uuid)
  to authenticated;
grant execute on function coinops.confirm_asset_ladder_redistribution(text, uuid, uuid)
  to authenticated;

alter table coinops.growth_plan_goal_audit
  add column if not exists previous_reference numeric(20, 8),
  add column if not exists new_reference numeric(20, 8);

alter table coinops.growth_plan_goal_audit
  drop constraint if exists growth_plan_goal_audit_previous_reference_check;
alter table coinops.growth_plan_goal_audit
  add constraint growth_plan_goal_audit_previous_reference_check
  check (
    previous_reference is null
    or (previous_reference > 0 and previous_reference = trunc(previous_reference))
  );
alter table coinops.growth_plan_goal_audit
  drop constraint if exists growth_plan_goal_audit_new_reference_check;
alter table coinops.growth_plan_goal_audit
  add constraint growth_plan_goal_audit_new_reference_check
  check (
    new_reference is null
    or (new_reference > 0 and new_reference = trunc(new_reference))
  );

create or replace function coinops.update_growth_plan_config(
  p_asset text,
  p_monthly_goal integer,
  p_ladder_reference numeric
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $config$
declare
  scope_row record;
  asset_code text := private.coinops_normalize_growth_asset(p_asset);
  settings_before coinops.growth_plan_settings%rowtype;
  settings_after coinops.growth_plan_settings%rowtype;
  initial_started_at date;
  normalized_reference numeric(20, 8) := round(p_ladder_reference, 8);
  previous_goal integer;
  previous_reference numeric(20, 8);
  caller_id uuid := (select auth.uid());
begin
  if p_monthly_goal is null or p_monthly_goal not between 1 and 1000 then
    raise exception 'COINOPS_GROWTH_GOAL_INVALID';
  end if;
  if normalized_reference is null
    or normalized_reference <= 0
    or normalized_reference <> trunc(normalized_reference) then
    raise exception 'COINOPS_GROWTH_REFERENCE_MUST_BE_POSITIVE_INTEGER';
  end if;

  select * into strict scope_row from private.coinops_current_scope();
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'coinops:growth-config:' || asset_code || ':' || scope_row.product_id::text || ':'
      || scope_row.tenant_id::text || ':' || scope_row.user_id::text,
    0
  ));

  select * into settings_before
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
      btc_monthly_goal, sol_monthly_goal,
      btc_ladder_reference, sol_ladder_reference
    ) values (
      'coinops', scope_row.product_id, scope_row.tenant_id, scope_row.user_id,
      initial_started_at,
      case when asset_code = 'BTC' then p_monthly_goal else 7 end,
      case when asset_code = 'SOL' then p_monthly_goal else 1 end,
      case when asset_code = 'BTC' then normalized_reference else null end,
      case when asset_code = 'SOL' then normalized_reference else null end
    )
    returning * into strict settings_after;
    previous_goal := null;
    previous_reference := null;
  else
    previous_goal := case when asset_code = 'BTC'
      then settings_before.btc_monthly_goal else settings_before.sol_monthly_goal end;
    previous_reference := case when asset_code = 'BTC'
      then settings_before.btc_ladder_reference else settings_before.sol_ladder_reference end;

    update coinops.growth_plan_settings settings
    set
      btc_monthly_goal = case when asset_code = 'BTC'
        then p_monthly_goal else settings.btc_monthly_goal end,
      sol_monthly_goal = case when asset_code = 'SOL'
        then p_monthly_goal else settings.sol_monthly_goal end,
      btc_ladder_reference = case when asset_code = 'BTC'
        then normalized_reference else settings.btc_ladder_reference end,
      sol_ladder_reference = case when asset_code = 'SOL'
        then normalized_reference else settings.sol_ladder_reference end,
      updated_at = timezone('utc', now())
    where settings.product_id = scope_row.product_id
      and settings.tenant_id = scope_row.tenant_id
      and settings.user_id = scope_row.user_id
    returning * into strict settings_after;
  end if;

  insert into coinops.growth_plan_goal_audit (
    product_code, product_id, tenant_id, user_id, asset,
    previous_goal, new_goal, previous_reference, new_reference,
    changed_by
  ) values (
    'coinops', scope_row.product_id, scope_row.tenant_id, scope_row.user_id,
    asset_code, previous_goal, p_monthly_goal, previous_reference,
    normalized_reference, caller_id
  );

  update coinops.btc_redistribution_batches batch
  set
    status = 'STALE',
    result = batch.result || jsonb_build_object(
      'status', 'STALE', 'can_confirm', false, 'stale_reason', 'ASSET_CONFIG_UPDATED'
    ),
    updated_at = timezone('utc', now())
  where batch.product_id = scope_row.product_id
    and batch.tenant_id = scope_row.tenant_id
    and batch.user_id = scope_row.user_id
    and batch.asset = asset_code
    and batch.status = 'PREPARED';

  return jsonb_build_object(
    'ok', true,
    'asset', asset_code,
    'monthly_goal', p_monthly_goal,
    'ladder_reference', normalized_reference,
    'btc_monthly_goal', settings_after.btc_monthly_goal,
    'sol_monthly_goal', settings_after.sol_monthly_goal,
    'btc_ladder_reference', settings_after.btc_ladder_reference,
    'sol_ladder_reference', settings_after.sol_ladder_reference,
    'started_at', settings_after.started_at,
    'updated_at', settings_after.updated_at
  );
end;
$config$;

do $plan_patch$
declare
  function_definition text;
  old_reference_lookup text := $old$
  select batch.reference_level
    into plan_reference_level
  from coinops.btc_redistribution_batches batch
  where batch.product_id = scope_row.product_id
    and batch.tenant_id = scope_row.tenant_id
    and batch.user_id = scope_row.user_id
    and batch.asset = asset_code
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
    and batch.asset = asset_code
      and batch.status = 'COMPLETED'
    order by batch.completed_at desc nulls last, batch.created_at desc, batch.id desc
    limit 1;
  end if;

$old$;
begin
  function_definition := pg_get_functiondef(
    to_regprocedure('coinops.get_asset_ladder_plan(text)')
  );
  function_definition := replace(
    function_definition,
    $old$    settings.started_at,
    case when asset_code = 'BTC' then settings.btc_monthly_goal else settings.sol_monthly_goal end
  into plan_started_at, plan_monthly_goal$old$,
    $new$    settings.started_at,
    case when asset_code = 'BTC' then settings.btc_monthly_goal else settings.sol_monthly_goal end,
    case when asset_code = 'BTC' then settings.btc_ladder_reference else settings.sol_ladder_reference end
  into plan_started_at, plan_monthly_goal, plan_reference_level$new$
  );
  function_definition := replace(function_definition, old_reference_lookup, '');
  if position('settings.btc_ladder_reference' in function_definition) = 0
    or position(old_reference_lookup in function_definition) > 0 then
    raise exception 'COINOPS_GROWTH_PLAN_CONFIG_PATCH_FAILED';
  end if;
  execute function_definition;
end;
$plan_patch$;

revoke all on function coinops.update_growth_plan_config(text, integer, numeric)
  from public, anon, authenticated, service_role;
grant execute on function coinops.update_growth_plan_config(text, integer, numeric)
  to authenticated;

comment on function coinops.update_growth_plan_config(text, integer, numeric) is
  'Persists one asset goal and ladder reference without reading or writing the other asset configuration.';

do $prepare_config_patch$
declare
  function_definition text;
begin
  function_definition := pg_get_functiondef(
    to_regprocedure('coinops.prepare_asset_ladder_redistribution(text,numeric,uuid)')
  );
  function_definition := replace(
    function_definition,
    $old$  normalized_reference numeric(20, 8);$old$,
    $new$  normalized_reference numeric(20, 8);
  configured_reference numeric(20, 8);$new$
  );
  function_definition := replace(
    function_definition,
    $old$  select
    settings.started_at,
    case when asset_code = 'BTC' then settings.btc_monthly_goal else settings.sol_monthly_goal end
    into plan_started_at, plan_monthly_goal$old$,
    $new$  select
    settings.started_at,
    case when asset_code = 'BTC' then settings.btc_monthly_goal else settings.sol_monthly_goal end,
    case when asset_code = 'BTC' then settings.btc_ladder_reference else settings.sol_ladder_reference end
    into plan_started_at, plan_monthly_goal, configured_reference$new$
  );
  function_definition := replace(
    function_definition,
    $old$  plan_started_at := coalesce($old$,
    $new$  if configured_reference is not null
    and normalized_reference <> configured_reference then
    raise exception 'COINOPS_GROWTH_REFERENCE_DIFFERS_FROM_SAVED_CONFIG';
  end if;
  normalized_reference := coalesce(configured_reference, normalized_reference);

  plan_started_at := coalesce($new$
  );
  if position('configured_reference numeric' in function_definition) = 0
    or position('COINOPS_GROWTH_REFERENCE_DIFFERS_FROM_SAVED_CONFIG' in function_definition) = 0 then
    raise exception 'COINOPS_GROWTH_PREPARE_CONFIG_PATCH_FAILED';
  end if;
  execute function_definition;
end;
$prepare_config_patch$;

revoke all on function coinops.prepare_asset_ladder_redistribution(text, numeric, uuid)
  from public, anon, authenticated, service_role;
grant execute on function coinops.prepare_asset_ladder_redistribution(text, numeric, uuid)
  to authenticated;

create table if not exists coinops.slot_operational_reconciliations (
  id uuid primary key default gen_random_uuid(),
  product_code text not null default 'coinops' check (product_code = 'coinops'),
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  slot_id uuid not null,
  asset text not null check (asset in ('BTC', 'SOL')),
  reconciliation_version text not null,
  classification text not null check (
    classification in ('OK', 'DIVERGENTE_EXPLICAVEL', 'DIVERGENTE_INCONSISTENTE')
  ),
  reason text not null,
  real_gains_snapshot integer not null,
  operational_gains_snapshot numeric(20, 8) not null,
  stored_value numeric(20, 8) not null,
  recalculated_value numeric(20, 8),
  value_difference numeric(20, 8),
  realized_profit_before numeric(20, 8) not null,
  realized_profit_after numeric(20, 8),
  redistribution_received_before numeric(20, 8) not null,
  redistribution_received_after numeric(20, 8),
  redistribution_sent_before numeric(20, 8) not null,
  redistribution_sent_after numeric(20, 8),
  position_snapshot jsonb not null default '{}'::jsonb,
  details jsonb not null default '{}'::jsonb,
  reconciled_by uuid not null,
  created_at timestamptz not null default timezone('utc', now()),
  constraint slot_operational_reconciliations_product_fk
    foreign key (product_code, product_id)
      references public.products(code, id) on delete restrict,
  constraint slot_operational_reconciliations_tenant_fk
    foreign key (product_id, tenant_id)
      references public.product_tenants(product_id, tenant_id) on delete restrict,
  constraint slot_operational_reconciliations_slot_fk
    foreign key (product_id, tenant_id, user_id, slot_id)
      references coinops.slots(product_id, tenant_id, user_id, id) on delete restrict,
  unique (product_id, tenant_id, user_id, slot_id, reconciliation_version)
);

create index if not exists slot_operational_reconciliations_scope_created_idx
  on coinops.slot_operational_reconciliations
    (product_id, tenant_id, user_id, created_at desc);

drop trigger if exists coinops_scope_slot_operational_reconciliations_v1
  on coinops.slot_operational_reconciliations;
create trigger coinops_scope_slot_operational_reconciliations_v1
before insert or update on coinops.slot_operational_reconciliations
for each row execute function private.coinops_apply_authenticated_scope();

alter table coinops.slot_operational_reconciliations enable row level security;
alter table coinops.slot_operational_reconciliations force row level security;
drop policy if exists slot_operational_reconciliations_owner_select
  on coinops.slot_operational_reconciliations;
create policy slot_operational_reconciliations_owner_select
on coinops.slot_operational_reconciliations for select to authenticated
using (private.coinops_can_access_row(product_id, tenant_id, user_id));

revoke all on table coinops.slot_operational_reconciliations
  from public, anon, authenticated;
grant select on table coinops.slot_operational_reconciliations
  to authenticated, service_role;

-- Reconstruct only the period after the audited sequential-compound cutover.
-- Every event is replayed using the current total balance. Legacy transfer
-- rows remain immutable; their exact correction is recorded here.
create temporary table coinops_operational_reconcile_state on commit drop as
select
  slot.product_id,
  slot.tenant_id,
  slot.user_id,
  slot.id as slot_id,
  strategy.asset,
  slot.gain_rate,
  slot.real_gains,
  slot.operational_gains as stored_operational_gains,
  slot.operational_slot_value as stored_value,
  slot.realized_profit as realized_profit_before,
  slot.redistribution_received_usdt as received_before,
  slot.redistribution_sent_usdt as sent_before,
  adjustment.created_at as anchor_at,
  adjustment.value_after as expected_value,
  adjustment.operational_gains_snapshot as expected_operational_gains,
  coalesce((
    select round(sum(ledger.amount_usdt), 8)
    from coinops.slot_capital_ledger ledger
    where ledger.product_id = slot.product_id
      and ledger.tenant_id = slot.tenant_id
      and ledger.user_id = slot.user_id
      and ledger.slot_id = slot.id
      and ledger.entry_type = 'REDISTRIBUTION_CREDIT'
      and ledger.created_at <= adjustment.created_at
  ), 0)::numeric(20, 8) as expected_received,
  coalesce((
    select round(sum(-ledger.amount_usdt), 8)
    from coinops.slot_capital_ledger ledger
    where ledger.product_id = slot.product_id
      and ledger.tenant_id = slot.tenant_id
      and ledger.user_id = slot.user_id
      and ledger.slot_id = slot.id
      and ledger.entry_type = 'REDISTRIBUTION_DEBIT'
      and ledger.created_at <= adjustment.created_at
  ), 0)::numeric(20, 8) as expected_sent,
  0::integer as replayed_events,
  (adjustment.id is not null)::boolean as is_reconstructible
from coinops.slots slot
join coinops.strategies strategy
  on strategy.product_id = slot.product_id
 and strategy.tenant_id = slot.tenant_id
 and strategy.user_id = slot.user_id
 and strategy.id = slot.strategy_id
left join lateral (
  select audit.*
  from coinops.slot_compounding_adjustments audit
  where audit.product_id = slot.product_id
    and audit.tenant_id = slot.tenant_id
    and audit.user_id = slot.user_id
    and audit.slot_id = slot.id
    and audit.adjustment_version = 'SEQUENTIAL_COMPOUND_V1'
  order by audit.created_at desc, audit.id desc
  limit 1
) adjustment on true
where strategy.asset in ('BTC', 'SOL');

create unique index coinops_operational_reconcile_state_pk
  on coinops_operational_reconcile_state(product_id, tenant_id, user_id, slot_id);

create temporary table coinops_operational_corrected_transfers (
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  transfer_id uuid not null,
  amount_usdt numeric(20, 8) not null,
  primary key (product_id, tenant_id, user_id, transfer_id)
) on commit drop;

do $replay$
declare
  event_row record;
  state_row record;
  corrected_amount numeric(20, 8);
begin
  for event_row in
    select ledger.*
    from coinops.slot_capital_ledger ledger
    join coinops_operational_reconcile_state state
      on state.product_id = ledger.product_id
     and state.tenant_id = ledger.tenant_id
     and state.user_id = ledger.user_id
     and state.slot_id = ledger.slot_id
    where state.is_reconstructible
      and ledger.created_at > state.anchor_at
    order by ledger.created_at,
      case ledger.entry_type
        when 'REDISTRIBUTION_DEBIT' then 1
        when 'REDISTRIBUTION_CREDIT' then 2
        else 0
      end,
      ledger.id
  loop
    select * into strict state_row
    from coinops_operational_reconcile_state state
    where state.product_id = event_row.product_id
      and state.tenant_id = event_row.tenant_id
      and state.user_id = event_row.user_id
      and state.slot_id = event_row.slot_id;

    if event_row.entry_type = 'REAL_GAIN' then
      update coinops_operational_reconcile_state state set
        expected_value = private.coinops_compound_operational_value_usdt(
          state.expected_value, state.gain_rate, event_row.operational_gain_delta::integer
        ),
        expected_operational_gains = state.expected_operational_gains
          + event_row.operational_gain_delta,
        replayed_events = state.replayed_events + 1
      where state.product_id = event_row.product_id
        and state.tenant_id = event_row.tenant_id
        and state.user_id = event_row.user_id
        and state.slot_id = event_row.slot_id;
    elsif event_row.entry_type = 'EXTERNAL_CONTRIBUTION' then
      update coinops_operational_reconcile_state state set
        expected_value = case when event_row.operational_gain_delta = 0
          then round(state.expected_value + event_row.amount_usdt, 8)
          else private.coinops_compound_operational_value_usdt(
            state.expected_value, state.gain_rate, event_row.operational_gain_delta::integer
          ) end,
        expected_operational_gains = state.expected_operational_gains
          + event_row.operational_gain_delta,
        replayed_events = state.replayed_events + 1
      where state.product_id = event_row.product_id
        and state.tenant_id = event_row.tenant_id
        and state.user_id = event_row.user_id
        and state.slot_id = event_row.slot_id;
    elsif event_row.entry_type = 'REDISTRIBUTION_DEBIT' then
      corrected_amount := round(
        state_row.expected_value
          - private.coinops_reverse_operational_gains_usdt(
              state_row.expected_value,
              state_row.gain_rate,
              abs(event_row.operational_gain_delta)::integer
            ),
        8
      );
      insert into coinops_operational_corrected_transfers (
        product_id, tenant_id, user_id, transfer_id, amount_usdt
      ) values (
        event_row.product_id, event_row.tenant_id, event_row.user_id,
        event_row.transfer_id, corrected_amount
      ) on conflict (product_id, tenant_id, user_id, transfer_id)
        do update set amount_usdt = excluded.amount_usdt;

      update coinops_operational_reconcile_state state set
        expected_value = round(state.expected_value - corrected_amount, 8),
        expected_operational_gains = state.expected_operational_gains
          + event_row.operational_gain_delta,
        expected_sent = round(state.expected_sent + corrected_amount, 8),
        replayed_events = state.replayed_events + 1
      where state.product_id = event_row.product_id
        and state.tenant_id = event_row.tenant_id
        and state.user_id = event_row.user_id
        and state.slot_id = event_row.slot_id;
    elsif event_row.entry_type = 'REDISTRIBUTION_CREDIT' then
      select transfer.amount_usdt into corrected_amount
      from coinops_operational_corrected_transfers transfer
      where transfer.product_id = event_row.product_id
        and transfer.tenant_id = event_row.tenant_id
        and transfer.user_id = event_row.user_id
        and transfer.transfer_id = event_row.transfer_id;
      if corrected_amount is null then
        update coinops_operational_reconcile_state state
        set is_reconstructible = false
        where state.product_id = event_row.product_id
          and state.tenant_id = event_row.tenant_id
          and state.user_id = event_row.user_id
          and state.slot_id = event_row.slot_id;
      else
        update coinops_operational_reconcile_state state set
          expected_value = round(state.expected_value + corrected_amount, 8),
          expected_operational_gains = state.expected_operational_gains
            + event_row.operational_gain_delta,
          expected_received = round(state.expected_received + corrected_amount, 8),
          replayed_events = state.replayed_events + 1
        where state.product_id = event_row.product_id
          and state.tenant_id = event_row.tenant_id
          and state.user_id = event_row.user_id
          and state.slot_id = event_row.slot_id;
      end if;
    end if;
  end loop;
end;
$replay$;

do $replay_validation$
begin
  if exists (
    select 1
    from coinops_operational_reconcile_state state
    where state.is_reconstructible
      and (
        state.expected_value is null
        or state.expected_value < 0
        or state.expected_operational_gains <> state.stored_operational_gains
        or state.expected_received < 0
        or state.expected_sent < 0
      )
  ) then
    raise exception 'COINOPS_OPERATIONAL_RECONCILIATION_REPLAY_INVALID';
  end if;
  if round(
    coalesce((select sum(amount_usdt) from coinops_operational_corrected_transfers), 0)
    - coalesce((
        select sum(transfer.amount_usdt)
        from coinops_operational_corrected_transfers transfer
        join coinops.slot_capital_ledger ledger
          on ledger.product_id = transfer.product_id
         and ledger.tenant_id = transfer.tenant_id
         and ledger.user_id = transfer.user_id
         and ledger.transfer_id = transfer.transfer_id
         and ledger.entry_type = 'REDISTRIBUTION_CREDIT'
      ), 0),
    8
  ) <> 0 then
    raise exception 'COINOPS_OPERATIONAL_RECONCILIATION_TRANSFER_CONSERVATION_FAILED';
  end if;
end;
$replay_validation$;

insert into coinops.slot_operational_reconciliations (
  product_code, product_id, tenant_id, user_id, slot_id, asset,
  reconciliation_version, classification, reason,
  real_gains_snapshot, operational_gains_snapshot,
  stored_value, recalculated_value, value_difference,
  realized_profit_before, realized_profit_after,
  redistribution_received_before, redistribution_received_after,
  redistribution_sent_before, redistribution_sent_after,
  position_snapshot, details, reconciled_by
)
select
  'coinops', state.product_id, state.tenant_id, state.user_id, state.slot_id,
  state.asset, 'COMPOUND_TOTAL_CAPITAL_V2',
  case
    when not state.is_reconstructible then 'DIVERGENTE_INCONSISTENTE'
    when state.expected_operational_gains <> state.stored_operational_gains
      then 'DIVERGENTE_INCONSISTENTE'
    when state.expected_value = state.stored_value
      and state.expected_received = state.received_before
      and state.expected_sent = state.sent_before then 'OK'
    else 'DIVERGENTE_EXPLICAVEL'
  end,
  case
    when not state.is_reconstructible then 'Âncora ou par de transferência insuficiente para replay seguro.'
    when state.expected_operational_gains <> state.stored_operational_gains
      then 'Contador operacional atual diverge do ledger posterior à âncora.'
    when state.expected_value = state.stored_value
      and state.expected_received = state.received_before
      and state.expected_sent = state.sent_before
      then 'Saldo já coincide com composição sobre o capital operacional total.'
    else 'Eventos posteriores à âncora foram reconstruídos com composição e redistribuição inversa exatas.'
  end,
  state.real_gains, state.stored_operational_gains,
  state.stored_value, state.expected_value,
  case when state.expected_value is null then null
    else round(state.expected_value - state.stored_value, 8) end,
  state.realized_profit_before,
  case when state.is_reconstructible
      and state.expected_operational_gains = state.stored_operational_gains then
    round(
      state.realized_profit_before
      + state.expected_value - state.stored_value
      - (state.expected_received - state.received_before)
      + (state.expected_sent - state.sent_before),
      8
    )
    else null end,
  state.received_before,
  case when state.is_reconstructible then state.expected_received else null end,
  state.sent_before,
  case when state.is_reconstructible then state.expected_sent else null end,
  jsonb_build_object(
    'status', slot.status,
    'positionNotionalUsdt', slot.position_notional_usdt,
    'positionGainUnitUsdt', slot.position_gain_unit_usdt,
    'positionQuantity', slot.position_quantity,
    'entry', slot.preco_entrada,
    'target', slot.preco_alvo,
    'openedAt', slot.position_opened_at
  ),
  jsonb_build_object(
    'anchorAt', state.anchor_at,
    'replayedEvents', state.replayed_events,
    'gainRate', state.gain_rate,
    'receivedDelta', case when state.is_reconstructible
      then round(state.expected_received - state.received_before, 8) else null end,
    'sentDelta', case when state.is_reconstructible
      then round(state.expected_sent - state.sent_before, 8) else null end
  ),
  state.user_id
from coinops_operational_reconcile_state state
join coinops.slots slot
  on slot.product_id = state.product_id
 and slot.tenant_id = state.tenant_id
 and slot.user_id = state.user_id
 and slot.id = state.slot_id
on conflict (product_id, tenant_id, user_id, slot_id, reconciliation_version)
do nothing;

do $safe_reconciliation$
begin
  if exists (
    select 1
    from coinops.slot_operational_reconciliations audit
    where audit.reconciliation_version = 'COMPOUND_TOTAL_CAPITAL_V2'
      and audit.classification = 'DIVERGENTE_EXPLICAVEL'
      and (audit.realized_profit_after is null or audit.realized_profit_after < 0)
  ) then
    raise exception 'COINOPS_OPERATIONAL_RECONCILIATION_NEGATIVE_REALIZED_PROFIT';
  end if;

  update coinops.slots slot
  set
    realized_profit = audit.realized_profit_after,
    redistribution_received_usdt = audit.redistribution_received_after,
    redistribution_sent_usdt = audit.redistribution_sent_after,
    accounting_version = slot.accounting_version + 1
  from coinops.slot_operational_reconciliations audit
  where audit.product_id = slot.product_id
    and audit.tenant_id = slot.tenant_id
    and audit.user_id = slot.user_id
    and audit.slot_id = slot.id
    and audit.reconciliation_version = 'COMPOUND_TOTAL_CAPITAL_V2'
    and audit.classification = 'DIVERGENTE_EXPLICAVEL';

  if exists (
    select 1
    from coinops.slot_operational_reconciliations audit
    join coinops.slots slot
      on slot.product_id = audit.product_id
     and slot.tenant_id = audit.tenant_id
     and slot.user_id = audit.user_id
     and slot.id = audit.slot_id
    where audit.reconciliation_version = 'COMPOUND_TOTAL_CAPITAL_V2'
      and audit.classification = 'DIVERGENTE_EXPLICAVEL'
      and (
        slot.operational_slot_value <> audit.recalculated_value
        or slot.real_gains <> audit.real_gains_snapshot
        or slot.operational_gains <> audit.operational_gains_snapshot
        or slot.position_notional_usdt is distinct from
          (audit.position_snapshot ->> 'positionNotionalUsdt')::numeric
        or slot.position_gain_unit_usdt is distinct from
          (audit.position_snapshot ->> 'positionGainUnitUsdt')::numeric
        or slot.position_quantity is distinct from
          (audit.position_snapshot ->> 'positionQuantity')::numeric
        or slot.preco_entrada is distinct from (audit.position_snapshot ->> 'entry')::numeric
        or slot.preco_alvo is distinct from (audit.position_snapshot ->> 'target')::numeric
        or slot.position_opened_at is distinct from
          (audit.position_snapshot ->> 'openedAt')::timestamptz
      )
  ) then
    raise exception 'COINOPS_OPERATIONAL_RECONCILIATION_POSTCONDITION_FAILED';
  end if;
end;
$safe_reconciliation$;

comment on table coinops.slot_operational_reconciliations is
  'Immutable dry-run and applied reconciliation evidence for total-capital compounding; financial history and position snapshots remain unchanged.';
