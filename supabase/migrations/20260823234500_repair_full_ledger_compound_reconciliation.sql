-- CoinOps: repair the historical reconciliation using the complete immutable
-- capital ledger. The prior V2 report correctly refused slots without a
-- SEQUENTIAL_COMPOUND_V1 adjustment, but applying only one reconstructible
-- side of a legacy transfer could leave received/sent components unbalanced.
-- This V3 replay starts at OPENING_BALANCE for every BTC/SOL slot and applies
-- both sides of every transfer atomically.

create temporary table coinops_full_reconcile_state on commit drop as
select
  slot.product_id,
  slot.tenant_id,
  slot.user_id,
  slot.id as slot_id,
  strategy.asset,
  slot.base_value,
  slot.gain_rate,
  slot.real_gains,
  slot.operational_gains as stored_operational_gains,
  slot.operational_slot_value as stored_value,
  slot.realized_profit as realized_profit_before,
  slot.growth_contribution as growth_before,
  slot.redistribution_received_usdt as received_before,
  slot.redistribution_sent_usdt as sent_before,
  private.coinops_compound_operational_value_usdt(
    coalesce(opening.gain_unit_after_usdt / nullif(slot.gain_rate, 0), slot.base_value),
    slot.gain_rate,
    opening.operational_after::integer
  ) as expected_value,
  greatest(round(
    coalesce(opening.gain_unit_after_usdt / nullif(slot.gain_rate, 0), slot.base_value)
      - slot.base_value,
    8
  ), 0)::numeric(20, 8) as expected_growth,
  opening.operational_after::numeric(20, 8) as expected_operational_gains,
  0::numeric(20, 8) as expected_received,
  0::numeric(20, 8) as expected_sent,
  0::integer as replayed_events,
  (opening.id is not null)::boolean as is_reconstructible,
  jsonb_build_object(
    'status', slot.status,
    'positionNotionalUsdt', slot.position_notional_usdt,
    'positionGainUnitUsdt', slot.position_gain_unit_usdt,
    'positionQuantity', slot.position_quantity,
    'entry', slot.preco_entrada,
    'target', slot.preco_alvo,
    'openedAt', slot.position_opened_at
  ) as position_snapshot
from coinops.slots slot
join coinops.strategies strategy
  on strategy.product_id = slot.product_id
 and strategy.tenant_id = slot.tenant_id
 and strategy.user_id = slot.user_id
 and strategy.id = slot.strategy_id
left join lateral (
  select ledger.*
  from coinops.slot_capital_ledger ledger
  where ledger.product_id = slot.product_id
    and ledger.tenant_id = slot.tenant_id
    and ledger.user_id = slot.user_id
    and ledger.slot_id = slot.id
    and ledger.entry_type = 'OPENING_BALANCE'
  order by ledger.created_at, ledger.id
  limit 1
) opening on true
where strategy.asset in ('BTC', 'SOL');

create unique index coinops_full_reconcile_state_pk
  on coinops_full_reconcile_state(product_id, tenant_id, user_id, slot_id);

create temporary table coinops_full_corrected_transfers (
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  transfer_id uuid not null,
  amount_usdt numeric(20, 8) not null,
  primary key (product_id, tenant_id, user_id, transfer_id)
) on commit drop;

create temporary table coinops_full_corrected_contributions (
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  contribution_id uuid not null,
  accounting_amount_usdt numeric(20, 8) not null,
  primary key (product_id, tenant_id, user_id, contribution_id)
) on commit drop;

do $coverage$
begin
  if exists (
    select 1 from coinops_full_reconcile_state where not is_reconstructible
  ) then
    raise exception 'COINOPS_FULL_RECONCILIATION_OPENING_COVERAGE_FAILED';
  end if;
end;
$coverage$;

do $replay$
declare
  event_row record;
  state_row record;
  corrected_amount numeric(20, 8);
begin
  for event_row in
    select event.*
    from (
      select
        ledger.product_id, ledger.tenant_id, ledger.user_id, ledger.slot_id,
        ledger.entry_type, ledger.operational_gain_delta, ledger.amount_usdt,
        ledger.external_contribution_id, ledger.transfer_id,
        null::numeric as adjustment_value_after,
        null::numeric as adjustment_growth_after,
        null::numeric as adjustment_operational_gains,
        ledger.created_at, ledger.id
      from coinops.slot_capital_ledger ledger
      join coinops_full_reconcile_state state
        on state.product_id = ledger.product_id
       and state.tenant_id = ledger.tenant_id
       and state.user_id = ledger.user_id
       and state.slot_id = ledger.slot_id
      where ledger.entry_type <> 'OPENING_BALANCE'

      union all

      select
        adjustment.product_id, adjustment.tenant_id, adjustment.user_id,
        adjustment.slot_id, 'COMPOUND_ADJUSTMENT'::text,
        0::numeric, 0::numeric, null::uuid, null::uuid,
        adjustment.value_after, adjustment.growth_contribution_after,
        adjustment.operational_gains_snapshot,
        adjustment.created_at, adjustment.id
      from coinops.slot_compounding_adjustments adjustment
      join coinops_full_reconcile_state state
        on state.product_id = adjustment.product_id
       and state.tenant_id = adjustment.tenant_id
       and state.user_id = adjustment.user_id
       and state.slot_id = adjustment.slot_id
      where adjustment.adjustment_version = 'SEQUENTIAL_COMPOUND_V1'
    ) event
    order by event.created_at,
      case event.entry_type
        when 'REDISTRIBUTION_DEBIT' then 1
        when 'REDISTRIBUTION_CREDIT' then 2
        when 'COMPOUND_ADJUSTMENT' then 3
        else 0
      end,
      event.id
  loop
    select * into strict state_row
    from coinops_full_reconcile_state state
    where state.product_id = event_row.product_id
      and state.tenant_id = event_row.tenant_id
      and state.user_id = event_row.user_id
      and state.slot_id = event_row.slot_id;

    if event_row.entry_type = 'COMPOUND_ADJUSTMENT' then
      update coinops_full_reconcile_state state set
        expected_value = event_row.adjustment_value_after,
        expected_growth = event_row.adjustment_growth_after,
        expected_operational_gains = event_row.adjustment_operational_gains,
        replayed_events = state.replayed_events + 1
      where state.product_id = event_row.product_id
        and state.tenant_id = event_row.tenant_id
        and state.user_id = event_row.user_id
        and state.slot_id = event_row.slot_id;
    elsif event_row.entry_type = 'REAL_GAIN' then
      update coinops_full_reconcile_state state set
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
      corrected_amount := case when event_row.operational_gain_delta = 0
        then event_row.amount_usdt
        else round(
          private.coinops_compound_operational_value_usdt(
            state_row.expected_value,
            state_row.gain_rate,
            event_row.operational_gain_delta::integer
          ) - state_row.expected_value,
          8
        ) end;

      insert into coinops_full_corrected_contributions (
        product_id, tenant_id, user_id, contribution_id, accounting_amount_usdt
      ) values (
        event_row.product_id, event_row.tenant_id, event_row.user_id,
        event_row.external_contribution_id, corrected_amount
      ) on conflict (product_id, tenant_id, user_id, contribution_id)
        do update set accounting_amount_usdt = excluded.accounting_amount_usdt;

      update coinops_full_reconcile_state state set
        expected_value = round(state.expected_value + corrected_amount, 8),
        expected_growth = round(state.expected_growth + corrected_amount, 8),
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
      insert into coinops_full_corrected_transfers (
        product_id, tenant_id, user_id, transfer_id, amount_usdt
      ) values (
        event_row.product_id, event_row.tenant_id, event_row.user_id,
        event_row.transfer_id, corrected_amount
      ) on conflict (product_id, tenant_id, user_id, transfer_id)
        do update set amount_usdt = excluded.amount_usdt;

      update coinops_full_reconcile_state state set
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
      select transfer.amount_usdt into strict corrected_amount
      from coinops_full_corrected_transfers transfer
      where transfer.product_id = event_row.product_id
        and transfer.tenant_id = event_row.tenant_id
        and transfer.user_id = event_row.user_id
        and transfer.transfer_id = event_row.transfer_id;

      update coinops_full_reconcile_state state set
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
  end loop;
end;
$replay$;

do $validity$
declare
  invalid_details jsonb;
begin
  if exists (
    select 1 from coinops_full_reconcile_state state
    where state.expected_value is null
      or state.expected_value < 0
      or state.expected_growth < 0
      or state.expected_operational_gains <> state.stored_operational_gains
      or state.expected_received < 0
      or state.expected_sent < 0
      or round(
        state.expected_value - state.base_value - state.expected_growth
          - state.expected_received + state.expected_sent,
        8
      ) < 0
  ) then
    select jsonb_agg(jsonb_build_object(
      'asset', state.asset,
      'slotId', state.slot_id,
      'expectedValue', state.expected_value,
      'expectedGrowth', state.expected_growth,
      'expectedOperational', state.expected_operational_gains,
      'storedOperational', state.stored_operational_gains,
      'expectedReceived', state.expected_received,
      'expectedSent', state.expected_sent,
      'derivedRealized', round(
        state.expected_value - state.base_value - state.expected_growth
          - state.expected_received + state.expected_sent,
        8
      )
    ) order by state.asset, state.slot_id)
    into invalid_details
    from coinops_full_reconcile_state state
    where state.expected_value is null
      or state.expected_value < 0
      or state.expected_growth < 0
      or state.expected_operational_gains <> state.stored_operational_gains
      or state.expected_received < 0
      or state.expected_sent < 0
      or round(
        state.expected_value - state.base_value - state.expected_growth
          - state.expected_received + state.expected_sent,
        8
      ) < 0;

    raise exception 'COINOPS_FULL_RECONCILIATION_RESULT_INVALID: %', invalid_details;
  end if;

  if exists (
    select 1
    from coinops_full_corrected_transfers transfer
    left join coinops.slot_capital_ledger credit
      on credit.product_id = transfer.product_id
     and credit.tenant_id = transfer.tenant_id
     and credit.user_id = transfer.user_id
     and credit.transfer_id = transfer.transfer_id
     and credit.entry_type = 'REDISTRIBUTION_CREDIT'
    where credit.id is null
  ) then
    raise exception 'COINOPS_FULL_RECONCILIATION_TRANSFER_PAIR_MISSING';
  end if;

  if exists (
    select 1
    from (
      select product_id, tenant_id, user_id, asset,
        round(sum(expected_received), 8) as received,
        round(sum(expected_sent), 8) as sent
      from coinops_full_reconcile_state
      group by product_id, tenant_id, user_id, asset
    ) totals
    where totals.received <> totals.sent
  ) then
    raise exception 'COINOPS_FULL_RECONCILIATION_EQUITY_NOT_CONSERVED';
  end if;
end;
$validity$;

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
  state.asset, 'COMPOUND_TOTAL_CAPITAL_V3_FULL_LEDGER',
  case when state.expected_value = state.stored_value
    and state.expected_growth = state.growth_before
    and state.expected_received = state.received_before
    and state.expected_sent = state.sent_before then 'OK'
    else 'DIVERGENTE_EXPLICAVEL' end,
  'Replay completo do ledger desde OPENING_BALANCE com gain composto e transferências pareadas.',
  state.real_gains, state.stored_operational_gains,
  state.stored_value, state.expected_value,
  round(state.expected_value - state.stored_value, 8),
  state.realized_profit_before,
  round(
    state.expected_value - state.base_value - state.expected_growth
      - state.expected_received + state.expected_sent,
    8
  ),
  state.received_before, state.expected_received,
  state.sent_before, state.expected_sent,
  state.position_snapshot,
  jsonb_build_object(
    'replayedEvents', state.replayed_events,
    'gainRate', state.gain_rate,
    'growthBefore', state.growth_before,
    'growthAfter', state.expected_growth,
    'receivedDelta', round(state.expected_received - state.received_before, 8),
    'sentDelta', round(state.expected_sent - state.sent_before, 8)
  ),
  state.user_id
from coinops_full_reconcile_state state
on conflict (product_id, tenant_id, user_id, slot_id, reconciliation_version)
do nothing;

update coinops.btc_external_contributions contribution
set accounting_amount_usdt = corrected.accounting_amount_usdt
from coinops_full_corrected_contributions corrected
where contribution.product_id = corrected.product_id
  and contribution.tenant_id = corrected.tenant_id
  and contribution.user_id = corrected.user_id
  and contribution.id = corrected.contribution_id;

update coinops.slots slot
set
  realized_profit = audit.realized_profit_after,
  growth_contribution = (audit.details ->> 'growthAfter')::numeric,
  redistribution_received_usdt = audit.redistribution_received_after,
  redistribution_sent_usdt = audit.redistribution_sent_after,
  accounting_version = slot.accounting_version + 1
from coinops.slot_operational_reconciliations audit
where audit.product_id = slot.product_id
  and audit.tenant_id = slot.tenant_id
  and audit.user_id = slot.user_id
  and audit.slot_id = slot.id
  and audit.reconciliation_version = 'COMPOUND_TOTAL_CAPITAL_V3_FULL_LEDGER'
  and audit.classification = 'DIVERGENTE_EXPLICAVEL';

do $postconditions$
begin
  if exists (
    select 1
    from coinops.slot_operational_reconciliations audit
    join coinops.slots slot
      on slot.product_id = audit.product_id
     and slot.tenant_id = audit.tenant_id
     and slot.user_id = audit.user_id
     and slot.id = audit.slot_id
    where audit.reconciliation_version = 'COMPOUND_TOTAL_CAPITAL_V3_FULL_LEDGER'
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
    raise exception 'COINOPS_FULL_RECONCILIATION_POSTCONDITION_FAILED';
  end if;

  if exists (
    select 1
    from (
      select slot.product_id, slot.tenant_id, slot.user_id, strategy.asset,
        round(sum(slot.redistribution_received_usdt), 8) as received,
        round(sum(slot.redistribution_sent_usdt), 8) as sent
      from coinops.slots slot
      join coinops.strategies strategy
        on strategy.product_id = slot.product_id
       and strategy.tenant_id = slot.tenant_id
       and strategy.user_id = slot.user_id
       and strategy.id = slot.strategy_id
      where strategy.asset in ('BTC', 'SOL')
      group by slot.product_id, slot.tenant_id, slot.user_id, strategy.asset
    ) totals
    where totals.received <> totals.sent
  ) then
    raise exception 'COINOPS_FULL_RECONCILIATION_POST_EQUITY_NOT_CONSERVED';
  end if;
end;
$postconditions$;

comment on table coinops.slot_operational_reconciliations is
  'Immutable V2/V3 reconciliation evidence. V3 is authoritative because it replays the complete paired ledger from OPENING_BALANCE.';
