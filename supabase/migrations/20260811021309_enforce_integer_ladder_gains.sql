-- CoinOps integer-only operational ladder.
--
-- Financial value remains precise to 8 decimals, but the ladder counter is a
-- discrete level. A transfer is proposed only when the same USDT amount is an
-- exact whole-gain multiple for both participants. Incompatible residual
-- capital stays in its current slot instead of becoming a fractional gain.

create table if not exists coinops.operational_gain_normalization_audit (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  asset text not null check (asset in ('BTC', 'SOL')),
  slot_id uuid not null,
  slot_number integer not null,
  operational_before numeric(20, 8) not null,
  operational_after numeric(20, 8) not null,
  retained_fraction_gains numeric(20, 8) not null,
  retained_fraction_usdt numeric(20, 8) not null,
  operational_value_usdt numeric(20, 8) not null,
  reason text not null default 'INTEGER_LADDER_CUTOVER',
  created_at timestamptz not null default timezone('utc', now()),
  constraint operational_gain_normalization_audit_slot_fk
    foreign key (product_id, tenant_id, user_id, slot_id)
      references coinops.slots(product_id, tenant_id, user_id, id) on delete restrict,
  check (operational_after = trunc(operational_after)),
  check (operational_before > operational_after),
  check (retained_fraction_gains = round(operational_before - operational_after, 8)),
  check (retained_fraction_gains > 0 and retained_fraction_gains < 1),
  check (retained_fraction_usdt >= 0)
);

create index if not exists operational_gain_normalization_audit_scope_created_idx
  on coinops.operational_gain_normalization_audit
    (product_id, tenant_id, user_id, created_at desc);

alter table coinops.operational_gain_normalization_audit enable row level security;
alter table coinops.operational_gain_normalization_audit force row level security;

drop policy if exists operational_gain_normalization_audit_owner_select
  on coinops.operational_gain_normalization_audit;
create policy operational_gain_normalization_audit_owner_select
on coinops.operational_gain_normalization_audit
for select
to authenticated
using (private.coinops_can_access_row(product_id, tenant_id, user_id));

revoke all on table coinops.operational_gain_normalization_audit
  from public, anon, authenticated, service_role;
grant select on table coinops.operational_gain_normalization_audit
  to authenticated, service_role;

insert into coinops.operational_gain_normalization_audit (
  product_id, tenant_id, user_id, asset, slot_id, slot_number,
  operational_before, operational_after, retained_fraction_gains,
  retained_fraction_usdt, operational_value_usdt
)
select
  slot.product_id,
  slot.tenant_id,
  slot.user_id,
  strategy.asset,
  slot.id,
  slot.slot_number,
  slot.operational_gains,
  trunc(slot.operational_gains),
  round(slot.operational_gains - trunc(slot.operational_gains), 8),
  round(
    (slot.operational_gains - trunc(slot.operational_gains))
      * private.coinops_gain_unit_usdt(
          slot.base_value,
          slot.growth_contribution,
          slot.gain_rate
        ),
    8
  ),
  slot.operational_slot_value
from coinops.slots slot
join coinops.strategies strategy
  on strategy.product_id = slot.product_id
 and strategy.tenant_id = slot.tenant_id
 and strategy.user_id = slot.user_id
 and strategy.id = slot.strategy_id
where strategy.asset in ('BTC', 'SOL')
  and slot.operational_gains <> trunc(slot.operational_gains);

update coinops.slots slot
set
  operational_gains = trunc(slot.operational_gains),
  accounting_version = slot.accounting_version + 1
from coinops.strategies strategy
where strategy.product_id = slot.product_id
  and strategy.tenant_id = slot.tenant_id
  and strategy.user_id = slot.user_id
  and strategy.id = slot.strategy_id
  and strategy.asset in ('BTC', 'SOL')
  and slot.operational_gains <> trunc(slot.operational_gains);

update coinops.btc_redistribution_batches batch
set
  status = 'STALE',
  updated_at = timezone('utc', now()),
  result = batch.result || jsonb_build_object(
    'status', 'STALE',
    'can_confirm', false,
    'stale_reason', 'INTEGER_LADDER_CUTOVER',
    'stale_at', timezone('utc', now())
  )
where batch.status = 'PREPARED';

alter table coinops.slots
  drop constraint if exists slots_operational_gains_integer_check;
alter table coinops.slots
  add constraint slots_operational_gains_integer_check
  check (operational_gains = trunc(operational_gains));

create or replace function private.coinops_build_asset_ladder_preview(
  p_product_id uuid,
  p_tenant_id uuid,
  p_user_id uuid,
  p_asset text,
  p_reference_level numeric
)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $preview$
declare
  asset_code text := private.coinops_normalize_growth_asset(p_asset);
  algorithm_version text := asset_code || '_LADDER_WHOLE_GAINS_V3';
  state_by_slot jsonb := '{}'::jsonb;
  ranking_before jsonb := '[]'::jsonb;
  ranking_after jsonb := '[]'::jsonb;
  donors jsonb := '[]'::jsonb;
  receivers jsonb := '[]'::jsonb;
  transfers jsonb := '[]'::jsonb;
  snapshot_payload jsonb;
  snapshot_hash text;
  slot_record record;
  donor_record record;
  receiver_record record;
  donor_state jsonb;
  receiver_state jsonb;
  gain_unit numeric(20, 8);
  donor_operational_before numeric(20, 8);
  donor_operational_after numeric(20, 8);
  receiver_operational_before numeric(20, 8);
  receiver_operational_after numeric(20, 8);
  donor_value_before numeric(20, 8);
  donor_value_after numeric(20, 8);
  receiver_value_before numeric(20, 8);
  receiver_value_after numeric(20, 8);
  donor_gain_unit numeric(20, 8);
  receiver_gain_unit numeric(20, 8);
  donor_excess numeric(20, 8);
  receiver_deficit numeric(20, 8);
  donor_capacity_usdt numeric(20, 8);
  amount_usdt numeric(20, 8);
  donor_gain_equivalent numeric(20, 8);
  receiver_gain_equivalent numeric(20, 8);
  candidate_amount numeric(20, 8);
  candidate_donor_gains numeric(20, 8);
  candidate_receiver_gains integer;
  equity_before numeric(20, 8) := 0;
  equity_after numeric(20, 8) := 0;
  equity_difference numeric(20, 8) := 0;
  total_transferred_usdt numeric(20, 8) := 0;
  available_excess_gains numeric(20, 8) := 0;
  available_excess_usdt numeric(20, 8) := 0;
  remaining_excess_gains numeric(20, 8) := 0;
  remaining_excess_usdt numeric(20, 8) := 0;
  remaining_deficit_gains numeric(20, 8) := 0;
  remaining_deficit_usdt numeric(20, 8) := 0;
  transfer_count integer := 0;
begin
  if p_product_id is null or p_tenant_id is null or p_user_id is null then
    raise exception 'COINOPS_SCOPE_REQUIRED';
  end if;
  if p_reference_level is not null
    and (p_reference_level <= 0 or p_reference_level <> trunc(p_reference_level)) then
    raise exception 'COINOPS_GROWTH_REFERENCE_MUST_BE_POSITIVE_INTEGER';
  end if;

  for slot_record in
    select
      slot.id, slot.slot_number, slot.sort_order, slot.status,
      slot.real_gains, slot.added_gains, slot.operational_gains,
      slot.operational_slot_value, slot.accounting_version,
      slot.base_value, slot.growth_contribution, slot.gain_rate,
      slot.position_notional_usdt, slot.position_gain_unit_usdt,
      slot.position_quantity, slot.preco_entrada, slot.preco_alvo,
      slot.position_opened_at
    from coinops.slots slot
    join coinops.strategies strategy
      on strategy.product_id = slot.product_id
     and strategy.tenant_id = slot.tenant_id
     and strategy.user_id = slot.user_id
     and strategy.id = slot.strategy_id
    where slot.product_id = p_product_id
      and slot.tenant_id = p_tenant_id
      and slot.user_id = p_user_id
      and strategy.asset = asset_code
    order by slot.operational_gains desc, slot.slot_number, slot.sort_order, slot.id
  loop
    gain_unit := private.coinops_gain_unit_usdt(
      slot_record.base_value,
      slot_record.growth_contribution,
      slot_record.gain_rate
    );
    if gain_unit is null or gain_unit <= 0 then
      raise exception 'COINOPS_GROWTH_GAIN_UNIT_INVALID_FOR_SLOT:%', slot_record.id;
    end if;
    if slot_record.operational_gains < 0
      or slot_record.operational_gains <> trunc(slot_record.operational_gains)
      or slot_record.operational_slot_value < 0 then
      raise exception 'COINOPS_GROWTH_OPERATIONAL_STATE_MUST_BE_WHOLE_FOR_SLOT:%', slot_record.id;
    end if;

    state_by_slot := state_by_slot || jsonb_build_object(
      slot_record.id::text,
      jsonb_build_object(
        'slot_id', slot_record.id,
        'slot_number', slot_record.slot_number,
        'sort_order', slot_record.sort_order,
        'status', slot_record.status,
        'real_gains', slot_record.real_gains,
        'added_gains', slot_record.added_gains,
        'operational_gains', slot_record.operational_gains,
        'operational_value_usdt', round(slot_record.operational_slot_value, 8),
        'gain_unit_usdt', gain_unit,
        'accounting_version', slot_record.accounting_version,
        'position_notional_usdt', slot_record.position_notional_usdt,
        'position_gain_unit_usdt', slot_record.position_gain_unit_usdt,
        'position_quantity', slot_record.position_quantity,
        'entry', slot_record.preco_entrada,
        'target', slot_record.preco_alvo,
        'position_opened_at', slot_record.position_opened_at
      )
    );
  end loop;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'rank', ranked.rank,
        'slot_id', ranked.slot_id,
        'slot_number', ranked.slot_number,
        'status', ranked.status,
        'real_gains', ranked.real_gains,
        'operational_gains', ranked.operational_gains,
        'operational_value_usdt', ranked.operational_value_usdt,
        'gain_unit_usdt', ranked.gain_unit_usdt,
        'reference_difference_gains', case when p_reference_level is null then null
          else ranked.operational_gains - p_reference_level end,
        'excess_gains', case when p_reference_level is null then 0
          else greatest(ranked.operational_gains - p_reference_level, 0) end,
        'deficit_gains', case when p_reference_level is null then 0
          else greatest(p_reference_level - ranked.operational_gains, 0) end
      ) order by ranked.rank
    ),
    '[]'::jsonb
  ) into ranking_before
  from (
    select
      row_number() over (
        order by (entry.value ->> 'operational_gains')::numeric desc,
          (entry.value ->> 'slot_number')::integer,
          (entry.value ->> 'sort_order')::integer,
          entry.key
      ) as rank,
      (entry.value ->> 'slot_id')::uuid as slot_id,
      (entry.value ->> 'slot_number')::integer as slot_number,
      entry.value ->> 'status' as status,
      (entry.value ->> 'real_gains')::integer as real_gains,
      (entry.value ->> 'operational_gains')::numeric as operational_gains,
      (entry.value ->> 'operational_value_usdt')::numeric as operational_value_usdt,
      (entry.value ->> 'gain_unit_usdt')::numeric as gain_unit_usdt
    from jsonb_each(state_by_slot) entry
  ) ranked;

  select coalesce(sum((entry.value ->> 'operational_value_usdt')::numeric), 0)
    into equity_before
  from jsonb_each(state_by_slot) entry;

  if p_reference_level is not null then
    select
      coalesce(sum(greatest((entry.value ->> 'operational_gains')::numeric - p_reference_level, 0)), 0),
      coalesce(sum(round(
        greatest((entry.value ->> 'operational_gains')::numeric - p_reference_level, 0)
          * (entry.value ->> 'gain_unit_usdt')::numeric,
        8
      )), 0)
    into available_excess_gains, available_excess_usdt
    from jsonb_each(state_by_slot) entry;
  end if;

  select coalesce(jsonb_agg(item order by (item ->> 'rank')::integer), '[]'::jsonb)
    into donors
  from jsonb_array_elements(ranking_before) item
  where (item ->> 'excess_gains')::numeric > 0;

  select coalesce(jsonb_agg(item order by (item ->> 'rank')::integer), '[]'::jsonb)
    into receivers
  from jsonb_array_elements(ranking_before) item
  where (item ->> 'deficit_gains')::numeric > 0;

  if p_reference_level is not null then
    for donor_record in
      select entry.key as slot_key
      from jsonb_each(state_by_slot) entry
      where (entry.value ->> 'operational_gains')::numeric > p_reference_level
      order by (entry.value ->> 'operational_gains')::numeric desc,
        (entry.value ->> 'slot_number')::integer,
        (entry.value ->> 'sort_order')::integer,
        entry.key
    loop
      for receiver_record in
        select entry.key as slot_key
        from jsonb_each(state_by_slot) entry
        where (entry.value ->> 'operational_gains')::numeric < p_reference_level
        order by (entry.value ->> 'operational_gains')::numeric desc,
          (entry.value ->> 'slot_number')::integer,
          (entry.value ->> 'sort_order')::integer,
          entry.key
      loop
        donor_state := state_by_slot -> donor_record.slot_key;
        receiver_state := state_by_slot -> receiver_record.slot_key;
        donor_operational_before := (donor_state ->> 'operational_gains')::numeric;
        receiver_operational_before := (receiver_state ->> 'operational_gains')::numeric;
        donor_excess := donor_operational_before - p_reference_level;
        receiver_deficit := p_reference_level - receiver_operational_before;

        exit when donor_excess <= 0;
        continue when receiver_deficit <= 0;

        donor_gain_unit := (donor_state ->> 'gain_unit_usdt')::numeric;
        receiver_gain_unit := (receiver_state ->> 'gain_unit_usdt')::numeric;
        donor_value_before := (donor_state ->> 'operational_value_usdt')::numeric;
        receiver_value_before := (receiver_state ->> 'operational_value_usdt')::numeric;
        donor_capacity_usdt := round(donor_excess * donor_gain_unit, 8);

        candidate_receiver_gains := least(
          receiver_deficit::integer,
          trunc(donor_capacity_usdt / receiver_gain_unit)::integer
        );
        amount_usdt := 0;
        donor_gain_equivalent := 0;
        receiver_gain_equivalent := 0;

        while candidate_receiver_gains > 0 loop
          candidate_amount := round(candidate_receiver_gains * receiver_gain_unit, 8);
          candidate_donor_gains := round(candidate_amount / donor_gain_unit, 8);
          if candidate_donor_gains = trunc(candidate_donor_gains)
            and candidate_donor_gains > 0
            and candidate_donor_gains <= donor_excess then
            amount_usdt := candidate_amount;
            donor_gain_equivalent := candidate_donor_gains;
            receiver_gain_equivalent := candidate_receiver_gains;
            exit;
          end if;
          candidate_receiver_gains := candidate_receiver_gains - 1;
        end loop;

        continue when amount_usdt <= 0;
        if amount_usdt > donor_value_before then
          raise exception 'COINOPS_GROWTH_DONOR_VALUE_INSUFFICIENT:%', donor_record.slot_key;
        end if;

        donor_operational_after := donor_operational_before - donor_gain_equivalent;
        receiver_operational_after := receiver_operational_before + receiver_gain_equivalent;
        donor_value_after := round(donor_value_before - amount_usdt, 8);
        receiver_value_after := round(receiver_value_before + amount_usdt, 8);

        if donor_operational_after < 0
          or donor_operational_after <> trunc(donor_operational_after)
          or receiver_operational_after <> trunc(receiver_operational_after)
          or donor_value_after < 0 then
          raise exception 'COINOPS_GROWTH_WHOLE_GAIN_RESULT_INVALID:%', donor_record.slot_key;
        end if;

        transfer_count := transfer_count + 1;
        total_transferred_usdt := round(total_transferred_usdt + amount_usdt, 8);
        transfers := transfers || jsonb_build_array(jsonb_build_object(
          'sequence_number', transfer_count,
          'donor_slot_id', (donor_state ->> 'slot_id')::uuid,
          'receiver_slot_id', (receiver_state ->> 'slot_id')::uuid,
          'donor_slot_number', (donor_state ->> 'slot_number')::integer,
          'receiver_slot_number', (receiver_state ->> 'slot_number')::integer,
          'donor_status', donor_state ->> 'status',
          'receiver_status', receiver_state ->> 'status',
          'donor_gain_unit_usdt', donor_gain_unit,
          'receiver_gain_unit_usdt', receiver_gain_unit,
          'donor_gain_equivalent', donor_gain_equivalent,
          'receiver_gain_equivalent', receiver_gain_equivalent,
          'amount_usdt', amount_usdt,
          'debited_usdt', amount_usdt,
          'credited_usdt', amount_usdt,
          'donor_operational_before', donor_operational_before,
          'donor_operational_after', donor_operational_after,
          'receiver_operational_before', receiver_operational_before,
          'receiver_operational_after', receiver_operational_after,
          'donor_value_before', donor_value_before,
          'donor_value_after', donor_value_after,
          'receiver_value_before', receiver_value_before,
          'receiver_value_after', receiver_value_after,
          'donor_real_gains', (donor_state ->> 'real_gains')::integer,
          'receiver_real_gains', (receiver_state ->> 'real_gains')::integer
        ));

        state_by_slot := jsonb_set(
          jsonb_set(state_by_slot, array[donor_record.slot_key, 'operational_gains'], to_jsonb(donor_operational_after), false),
          array[donor_record.slot_key, 'operational_value_usdt'], to_jsonb(donor_value_after), false
        );
        state_by_slot := jsonb_set(
          jsonb_set(state_by_slot, array[receiver_record.slot_key, 'operational_gains'], to_jsonb(receiver_operational_after), false),
          array[receiver_record.slot_key, 'operational_value_usdt'], to_jsonb(receiver_value_after), false
        );
      end loop;
    end loop;
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'rank', ranked.rank,
        'slot_id', ranked.slot_id,
        'slot_number', ranked.slot_number,
        'status', ranked.status,
        'real_gains', ranked.real_gains,
        'operational_gains', ranked.operational_gains,
        'operational_value_usdt', ranked.operational_value_usdt,
        'gain_unit_usdt', ranked.gain_unit_usdt,
        'reference_difference_gains', case when p_reference_level is null then null
          else ranked.operational_gains - p_reference_level end,
        'excess_gains', case when p_reference_level is null then 0
          else greatest(ranked.operational_gains - p_reference_level, 0) end,
        'deficit_gains', case when p_reference_level is null then 0
          else greatest(p_reference_level - ranked.operational_gains, 0) end
      ) order by ranked.rank
    ),
    '[]'::jsonb
  ) into ranking_after
  from (
    select
      row_number() over (
        order by (entry.value ->> 'operational_gains')::numeric desc,
          (entry.value ->> 'slot_number')::integer,
          (entry.value ->> 'sort_order')::integer,
          entry.key
      ) as rank,
      (entry.value ->> 'slot_id')::uuid as slot_id,
      (entry.value ->> 'slot_number')::integer as slot_number,
      entry.value ->> 'status' as status,
      (entry.value ->> 'real_gains')::integer as real_gains,
      (entry.value ->> 'operational_gains')::numeric as operational_gains,
      (entry.value ->> 'operational_value_usdt')::numeric as operational_value_usdt,
      (entry.value ->> 'gain_unit_usdt')::numeric as gain_unit_usdt
    from jsonb_each(state_by_slot) entry
  ) ranked;

  select coalesce(sum((entry.value ->> 'operational_value_usdt')::numeric), 0)
    into equity_after
  from jsonb_each(state_by_slot) entry;

  if p_reference_level is not null then
    select
      coalesce(sum(greatest((entry.value ->> 'operational_gains')::numeric - p_reference_level, 0)), 0),
      coalesce(sum(round(greatest((entry.value ->> 'operational_gains')::numeric - p_reference_level, 0)
        * (entry.value ->> 'gain_unit_usdt')::numeric, 8)), 0),
      coalesce(sum(greatest(p_reference_level - (entry.value ->> 'operational_gains')::numeric, 0)), 0),
      coalesce(sum(round(greatest(p_reference_level - (entry.value ->> 'operational_gains')::numeric, 0)
        * (entry.value ->> 'gain_unit_usdt')::numeric, 8)), 0)
    into remaining_excess_gains, remaining_excess_usdt,
      remaining_deficit_gains, remaining_deficit_usdt
    from jsonb_each(state_by_slot) entry;
  end if;

  equity_before := round(equity_before, 8);
  equity_after := round(equity_after, 8);
  equity_difference := round(equity_after - equity_before, 8);
  if equity_difference <> 0 then
    raise exception 'COINOPS_GROWTH_PREVIEW_EQUITY_MISMATCH:%', equity_difference;
  end if;

  snapshot_payload := jsonb_build_object(
    'algorithm_version', algorithm_version,
    'asset', asset_code,
    'product_id', p_product_id,
    'tenant_id', p_tenant_id,
    'user_id', p_user_id,
    'reference_level', p_reference_level,
    'ranking_before', ranking_before
  );
  snapshot_hash := encode(
    extensions.digest(pg_catalog.convert_to(snapshot_payload::text, 'UTF8'), 'sha256'),
    'hex'
  );

  return jsonb_build_object(
    'ok', true,
    'algorithm_version', algorithm_version,
    'asset', asset_code,
    'status', 'DRAFT',
    'snapshot_hash', snapshot_hash,
    'reference_level', p_reference_level,
    'ranking_before', ranking_before,
    'ranking_after', ranking_after,
    'donors', donors,
    'receivers', receivers,
    'transfers', transfers,
    'transfer_count', transfer_count,
    'total_transferred_usdt', total_transferred_usdt,
    'equity_before_usdt', equity_before,
    'equity_after_usdt', equity_after,
    'equity_difference_usdt', equity_difference,
    'available_excess_gains', available_excess_gains,
    'available_excess_usdt', round(available_excess_usdt, 8),
    'remaining_excess_gains', remaining_excess_gains,
    'remaining_excess_usdt', round(remaining_excess_usdt, 8),
    'remaining_deficit_gains', remaining_deficit_gains,
    'remaining_deficit_usdt', round(remaining_deficit_usdt, 8),
    'is_conserved', true,
    'can_confirm', transfer_count > 0
  );
end;
$preview$;

revoke all on function private.coinops_build_asset_ladder_preview(uuid, uuid, uuid, text, numeric)
  from public, anon, authenticated, service_role;

comment on table coinops.operational_gain_normalization_audit is
  'Immutable cutover audit for fractional operational levels retained as capital in one slot.';
comment on constraint slots_operational_gains_integer_check on coinops.slots is
  'Operational ladder levels are discrete whole gains; financial residual remains in slot capital.';
