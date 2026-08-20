-- CoinOps: sequential compound accounting for BTC and SOL operational balances.
--
-- Rules:
--   * every gain compounds once over the immediately previous balance;
--   * manual gains are funded by the exact compound difference;
--   * a direct USDT contribution adds exactly its amount and does not fabricate
--     a real or operational gain;
--   * redistribution remains an exact cash debit/credit;
--   * real_gains and executed position fields are never rewritten.

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

revoke all on function private.coinops_compound_operational_value_usdt(numeric, numeric, integer)
  from public, anon, authenticated, service_role;

alter table coinops.btc_external_contributions
  add column if not exists input_mode text,
  add column if not exists accounting_amount_usdt numeric(20, 8);

update coinops.btc_external_contributions
set
  input_mode = coalesce(input_mode, 'MANUAL_GAINS'),
  accounting_amount_usdt = coalesce(accounting_amount_usdt, amount_usdt)
where input_mode is null or accounting_amount_usdt is null;

alter table coinops.btc_external_contributions
  alter column input_mode set default 'USDT',
  alter column input_mode set not null,
  alter column accounting_amount_usdt set not null,
  drop constraint if exists btc_external_contributions_input_mode_check,
  drop constraint if exists btc_external_contributions_accounting_amount_check,
  drop constraint if exists btc_external_contributions_gain_equivalent_check;

alter table coinops.btc_external_contributions
  add constraint btc_external_contributions_input_mode_check
    check (input_mode in ('MANUAL_GAINS', 'USDT')),
  add constraint btc_external_contributions_accounting_amount_check
    check (accounting_amount_usdt > 0),
  add constraint btc_external_contributions_gain_equivalent_check
    check (gain_equivalent >= 0);

alter table coinops.slot_capital_ledger
  drop constraint if exists slot_capital_ledger_check3;

alter table coinops.slot_capital_ledger
  add constraint slot_capital_ledger_check3 check (
    (entry_type = 'OPENING_BALANCE' and amount_usdt >= 0 and operational_gain_delta >= 0)
    or (entry_type = 'REAL_GAIN' and amount_usdt > 0 and operational_gain_delta = 1)
    or (entry_type = 'REDISTRIBUTION_DEBIT' and amount_usdt < 0 and operational_gain_delta < 0)
    or (entry_type = 'REDISTRIBUTION_CREDIT' and amount_usdt > 0 and operational_gain_delta > 0)
    or (entry_type = 'EXTERNAL_CONTRIBUTION' and amount_usdt > 0 and operational_gain_delta >= 0)
  );

create table if not exists coinops.slot_compounding_adjustments (
  id uuid primary key default gen_random_uuid(),
  product_code text not null default 'coinops' check (product_code = 'coinops'),
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  slot_id uuid not null,
  asset text not null check (asset in ('BTC', 'SOL')),
  adjustment_version text not null check (char_length(btrim(adjustment_version)) between 1 and 80),
  value_before numeric(20, 8) not null,
  value_after numeric(20, 8) not null,
  realized_profit_before numeric(20, 8) not null,
  realized_profit_after numeric(20, 8) not null,
  growth_contribution_before numeric(20, 8) not null,
  growth_contribution_after numeric(20, 8) not null,
  position_notional_before numeric(20, 8),
  position_notional_after numeric(20, 8),
  position_gain_unit_before numeric(20, 8),
  position_gain_unit_after numeric(20, 8),
  real_gains_snapshot integer not null,
  operational_gains_snapshot numeric(20, 8) not null,
  reason text not null check (char_length(btrim(reason)) between 1 and 500),
  created_by uuid not null,
  created_at timestamptz not null default timezone('utc', now()),
  constraint slot_compounding_adjustments_product_fk
    foreign key (product_code, product_id) references public.products(code, id) on delete restrict,
  constraint slot_compounding_adjustments_tenant_fk
    foreign key (product_id, tenant_id) references public.product_tenants(product_id, tenant_id) on delete restrict,
  constraint slot_compounding_adjustments_slot_fk
    foreign key (product_id, tenant_id, user_id, slot_id)
      references coinops.slots(product_id, tenant_id, user_id, id) on delete restrict,
  unique (product_id, tenant_id, user_id, slot_id, adjustment_version)
);

create index if not exists slot_compounding_adjustments_scope_created_idx
  on coinops.slot_compounding_adjustments
    (product_id, tenant_id, user_id, created_at desc);

-- Replay the immutable capital ledger in event order. The opening row contains
-- the pre-ledger gain count and unit, allowing the old linear balance to be
-- replaced by the equivalent sequentially compounded balance without guessing
-- from free-form history text.
create temporary table coinops_compound_replay on commit drop as
with recursive
asset_slots as (
  select
    slot.product_id, slot.tenant_id, slot.user_id, slot.id as slot_id,
    strategy.asset, slot.base_value, slot.gain_rate
  from coinops.slots slot
  join coinops.strategies strategy
    on strategy.product_id = slot.product_id
   and strategy.tenant_id = slot.tenant_id
   and strategy.user_id = slot.user_id
   and strategy.id = slot.strategy_id
  where strategy.asset in ('BTC', 'SOL')
),
ordered_events as (
  select
    ledger.*,
    asset_slot.asset,
    asset_slot.base_value,
    asset_slot.gain_rate,
    row_number() over (
      partition by ledger.product_id, ledger.tenant_id, ledger.user_id, ledger.slot_id
      order by ledger.created_at, ledger.id
    ) as event_number
  from coinops.slot_capital_ledger ledger
  join asset_slots asset_slot
    on asset_slot.product_id = ledger.product_id
   and asset_slot.tenant_id = ledger.tenant_id
   and asset_slot.user_id = ledger.user_id
   and asset_slot.slot_id = ledger.slot_id
),
replay as (
  select
    event.product_id, event.tenant_id, event.user_id, event.slot_id,
    event.asset, event.base_value, event.gain_rate, event.event_number,
    event.external_contribution_id,
    private.coinops_compound_operational_value_usdt(
      coalesce(event.gain_unit_after_usdt / nullif(event.gain_rate, 0), event.base_value),
      event.gain_rate,
      event.operational_after::integer
    ) as balance_after,
    greatest(
      round(coalesce(event.gain_unit_after_usdt / nullif(event.gain_rate, 0), event.base_value) - event.base_value, 8),
      0
    )::numeric(20, 8) as effective_growth_after,
    null::numeric(20, 8) as effective_contribution_amount
  from ordered_events event
  where event.event_number = 1
    and event.entry_type = 'OPENING_BALANCE'

  union all

  select
    event.product_id, event.tenant_id, event.user_id, event.slot_id,
    event.asset, event.base_value, event.gain_rate, event.event_number,
    event.external_contribution_id,
    case
      when event.entry_type in ('REAL_GAIN', 'EXTERNAL_CONTRIBUTION') then
        private.coinops_compound_operational_value_usdt(
          replay.balance_after,
          event.gain_rate,
          event.operational_gain_delta::integer
        )
      when event.entry_type in ('REDISTRIBUTION_DEBIT', 'REDISTRIBUTION_CREDIT') then
        round(replay.balance_after + event.amount_usdt, 8)
      else replay.balance_after
    end::numeric(20, 8) as balance_after,
    case
      when event.entry_type = 'EXTERNAL_CONTRIBUTION' then
        round(
          replay.effective_growth_after
          + private.coinops_compound_operational_value_usdt(
              replay.balance_after,
              event.gain_rate,
              event.operational_gain_delta::integer
            )
          - replay.balance_after,
          8
        )
      else replay.effective_growth_after
    end::numeric(20, 8) as effective_growth_after,
    case
      when event.entry_type = 'EXTERNAL_CONTRIBUTION' then
        round(
          private.coinops_compound_operational_value_usdt(
            replay.balance_after,
            event.gain_rate,
            event.operational_gain_delta::integer
          ) - replay.balance_after,
          8
        )
      else null
    end::numeric(20, 8) as effective_contribution_amount
  from replay
  join ordered_events event
    on event.product_id = replay.product_id
   and event.tenant_id = replay.tenant_id
   and event.user_id = replay.user_id
   and event.slot_id = replay.slot_id
   and event.event_number = replay.event_number + 1
)
select * from replay;

do $coverage$
declare
  asset_slot_count integer;
  replayed_slot_count integer;
begin
  select count(*)::integer into asset_slot_count
  from coinops.slots slot
  join coinops.strategies strategy
    on strategy.product_id = slot.product_id
   and strategy.tenant_id = slot.tenant_id
   and strategy.user_id = slot.user_id
   and strategy.id = slot.strategy_id
  where strategy.asset in ('BTC', 'SOL');

  select count(*)::integer into replayed_slot_count
  from (
    select distinct product_id, tenant_id, user_id, slot_id
    from coinops_compound_replay
  ) replayed;

  if replayed_slot_count <> asset_slot_count then
    raise exception 'COINOPS_COMPOUND_BACKFILL_LEDGER_COVERAGE_FAILED';
  end if;
end;
$coverage$;

update coinops.btc_external_contributions contribution
set accounting_amount_usdt = replay.effective_contribution_amount
from coinops_compound_replay replay
where replay.external_contribution_id = contribution.id
  and replay.effective_contribution_amount is not null;

create temporary table coinops_compound_final on commit drop as
select distinct on (product_id, tenant_id, user_id, slot_id)
  product_id, tenant_id, user_id, slot_id, asset,
  balance_after, effective_growth_after
from coinops_compound_replay
order by product_id, tenant_id, user_id, slot_id, event_number desc;

do $validity$
begin
  if exists (
    select 1
    from coinops_compound_final final
    join coinops.slots slot
      on slot.product_id = final.product_id
     and slot.tenant_id = final.tenant_id
     and slot.user_id = final.user_id
     and slot.id = final.slot_id
    where final.balance_after is null
       or final.balance_after < 0
       or final.effective_growth_after < 0
       or round(
            final.balance_after - slot.base_value - final.effective_growth_after
            - slot.redistribution_received_usdt + slot.redistribution_sent_usdt,
            8
          ) < 0
  ) then
    raise exception 'COINOPS_COMPOUND_BACKFILL_INVALID_RESULT';
  end if;
end;
$validity$;

insert into coinops.slot_compounding_adjustments (
  product_code, product_id, tenant_id, user_id, slot_id, asset,
  adjustment_version, value_before, value_after,
  realized_profit_before, realized_profit_after,
  growth_contribution_before, growth_contribution_after,
  position_notional_before, position_notional_after,
  position_gain_unit_before, position_gain_unit_after,
  real_gains_snapshot, operational_gains_snapshot, reason, created_by
)
select
  'coinops', slot.product_id, slot.tenant_id, slot.user_id, slot.id, final.asset,
  'SEQUENTIAL_COMPOUND_V1', slot.operational_slot_value, final.balance_after,
  slot.realized_profit,
  round(
    final.balance_after - slot.base_value - final.effective_growth_after
    - slot.redistribution_received_usdt + slot.redistribution_sent_usdt,
    8
  ),
  slot.growth_contribution, final.effective_growth_after,
  slot.position_notional_usdt, slot.position_notional_usdt,
  slot.position_gain_unit_usdt,
  case
    when slot.status = 'aberto' then
      private.coinops_position_gain_unit_usdt(slot.position_notional_usdt, slot.gain_rate)
    else slot.position_gain_unit_usdt
  end,
  slot.real_gains, slot.operational_gains,
  'Correção auditável do saldo linear para composição sequencial por evento.',
  slot.user_id
from coinops_compound_final final
join coinops.slots slot
  on slot.product_id = final.product_id
 and slot.tenant_id = final.tenant_id
 and slot.user_id = final.user_id
 and slot.id = final.slot_id
where slot.operational_slot_value is distinct from final.balance_after
   or slot.growth_contribution is distinct from final.effective_growth_after
   or (
     slot.status = 'aberto'
     and slot.position_gain_unit_usdt is distinct from
       private.coinops_position_gain_unit_usdt(slot.position_notional_usdt, slot.gain_rate)
   )
on conflict (product_id, tenant_id, user_id, slot_id, adjustment_version) do nothing;

update coinops.slots slot
set
  realized_profit = round(
    final.balance_after - slot.base_value - final.effective_growth_after
    - slot.redistribution_received_usdt + slot.redistribution_sent_usdt,
    8
  ),
  growth_contribution = final.effective_growth_after,
  position_gain_unit_usdt = case
    when slot.status = 'aberto' then
      private.coinops_position_gain_unit_usdt(slot.position_notional_usdt, slot.gain_rate)
    else slot.position_gain_unit_usdt
  end,
  accounting_version = slot.accounting_version + 1
from coinops_compound_final final
where slot.product_id = final.product_id
  and slot.tenant_id = final.tenant_id
  and slot.user_id = final.user_id
  and slot.id = final.slot_id
  and (
    slot.operational_slot_value is distinct from final.balance_after
    or slot.growth_contribution is distinct from final.effective_growth_after
    or (
      slot.status = 'aberto'
      and slot.position_gain_unit_usdt is distinct from
        private.coinops_position_gain_unit_usdt(slot.position_notional_usdt, slot.gain_rate)
    )
  );

do $postcondition$
begin
  if exists (
    select 1
    from coinops_compound_final final
    join coinops.slots slot
      on slot.product_id = final.product_id
     and slot.tenant_id = final.tenant_id
     and slot.user_id = final.user_id
     and slot.id = final.slot_id
    where slot.operational_slot_value <> final.balance_after
       or slot.real_gains < 0
       or slot.operational_gains <> trunc(slot.operational_gains)
       or (
         slot.status = 'aberto'
         and (
           slot.position_notional_usdt is null
           or slot.position_gain_unit_usdt <>
             private.coinops_position_gain_unit_usdt(slot.position_notional_usdt, slot.gain_rate)
         )
       )
  ) then
    raise exception 'COINOPS_COMPOUND_BACKFILL_POSTCONDITION_FAILED';
  end if;
end;
$postcondition$;

update coinops.btc_redistribution_batches batch
set
  status = 'STALE',
  updated_at = timezone('utc', now()),
  result = batch.result || jsonb_build_object(
    'status', 'STALE',
    'can_confirm', false,
    'stale_reason', 'COMPOUND_BALANCE_NORMALIZED',
    'stale_at', timezone('utc', now())
  )
where batch.status = 'PREPARED';

create or replace function coinops.apply_asset_external_contribution(
  p_asset text,
  p_slot_id uuid,
  p_amount_usdt numeric,
  p_reason text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $contribution$
declare
  scope_row record;
  asset_code text := private.coinops_normalize_growth_asset(p_asset);
  existing_contribution coinops.btc_external_contributions%rowtype;
  slot_before coinops.slots%rowtype;
  slot_after coinops.slots%rowtype;
  contribution_id uuid := gen_random_uuid();
  caller_id uuid := (select auth.uid());
  normalized_amount numeric(20, 8) := round(p_amount_usdt, 8);
  normalized_reason text := btrim(coalesce(p_reason, ''));
  gain_unit_before numeric(20, 8);
  gain_unit_after numeric(20, 8);
  contribution_result jsonb;
  stale_preview_count integer := 0;
begin
  if caller_id is null then raise exception 'COINOPS_AUTH_REQUIRED'; end if;
  if p_slot_id is null or p_idempotency_key is null then
    raise exception 'COINOPS_SLOT_AND_IDEMPOTENCY_REQUIRED';
  end if;
  if normalized_amount is null or normalized_amount <= 0 then
    raise exception 'COINOPS_CONTRIBUTION_AMOUNT_INVALID';
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

  select * into existing_contribution
  from coinops.btc_external_contributions contribution
  where contribution.product_id = scope_row.product_id
    and contribution.tenant_id = scope_row.tenant_id
    and contribution.user_id = scope_row.user_id
    and contribution.idempotency_key = p_idempotency_key
    and contribution.asset = asset_code;
  if found then
    if existing_contribution.input_mode <> 'USDT'
      or existing_contribution.slot_id <> p_slot_id
      or existing_contribution.amount_usdt <> normalized_amount
      or existing_contribution.reason <> normalized_reason then
      raise exception 'COINOPS_IDEMPOTENCY_CONFLICT';
    end if;
    return existing_contribution.result || jsonb_build_object('already_applied', true);
  end if;

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
    and slot.id = p_slot_id
    and strategy.asset = asset_code
  for update of slot;
  if not found then raise exception 'COINOPS_GROWTH_SLOT_NOT_FOUND'; end if;

  gain_unit_before := private.coinops_position_gain_unit_usdt(
    slot_before.operational_slot_value, slot_before.gain_rate
  );
  gain_unit_after := private.coinops_position_gain_unit_usdt(
    slot_before.operational_slot_value + normalized_amount, slot_before.gain_rate
  );
  if gain_unit_before is null or gain_unit_after is null then
    raise exception 'COINOPS_GROWTH_GAIN_UNIT_INVALID';
  end if;

  update coinops.slots slot
  set
    growth_contribution = round(slot.growth_contribution + normalized_amount, 8),
    accounting_version = slot.accounting_version + 1
  where slot.product_id = scope_row.product_id
    and slot.tenant_id = scope_row.tenant_id
    and slot.user_id = scope_row.user_id
    and slot.id = slot_before.id
  returning * into strict slot_after;

  if slot_after.operational_slot_value <> round(slot_before.operational_slot_value + normalized_amount, 8)
    or slot_after.operational_gains <> slot_before.operational_gains
    or slot_after.real_gains <> slot_before.real_gains
    or slot_after.position_notional_usdt is distinct from slot_before.position_notional_usdt
    or slot_after.position_gain_unit_usdt is distinct from slot_before.position_gain_unit_usdt
    or slot_after.preco_entrada is distinct from slot_before.preco_entrada
    or slot_after.preco_alvo is distinct from slot_before.preco_alvo then
    raise exception 'COINOPS_CONTRIBUTION_POSTCONDITION_FAILED';
  end if;

  contribution_result := jsonb_build_object(
    'ok', true, 'asset', asset_code, 'status', 'APPLIED',
    'input_mode', 'USDT', 'id', contribution_id,
    'slot_id', slot_after.id, 'slot_number', slot_after.slot_number,
    'amount_usdt', normalized_amount, 'accounting_amount_usdt', normalized_amount,
    'gain_equivalent', 0,
    'operational_before', slot_before.operational_gains,
    'operational_after', slot_after.operational_gains,
    'value_before', slot_before.operational_slot_value,
    'value_after', slot_after.operational_slot_value,
    'reason', normalized_reason, 'created_at', timezone('utc', now()),
    'already_applied', false
  );

  insert into coinops.btc_external_contributions (
    id, product_code, product_id, tenant_id, user_id, asset, slot_id, slot_number,
    idempotency_key, amount_usdt, accounting_amount_usdt, input_mode,
    gain_unit_before_usdt, gain_unit_after_usdt, gain_equivalent,
    operational_before, operational_after, value_before, value_after,
    reason, applied_by, result
  ) values (
    contribution_id, 'coinops', scope_row.product_id, scope_row.tenant_id,
    scope_row.user_id, asset_code, slot_after.id, slot_after.slot_number,
    p_idempotency_key, normalized_amount, normalized_amount, 'USDT',
    gain_unit_before, gain_unit_after, 0,
    slot_before.operational_gains, slot_after.operational_gains,
    slot_before.operational_slot_value, slot_after.operational_slot_value,
    normalized_reason, caller_id, contribution_result
  );

  insert into coinops.slot_capital_ledger (
    product_code, product_id, tenant_id, user_id, slot_id,
    external_contribution_id, entry_type, amount_usdt,
    operational_gain_delta, operational_before, operational_after,
    value_before, value_after, gain_unit_before_usdt, gain_unit_after_usdt,
    redistribution_received_before, redistribution_received_after,
    redistribution_sent_before, redistribution_sent_after,
    real_gains_snapshot, added_gains_snapshot, metadata, created_by
  ) values (
    'coinops', scope_row.product_id, scope_row.tenant_id, scope_row.user_id,
    slot_after.id, contribution_id, 'EXTERNAL_CONTRIBUTION', normalized_amount,
    0, slot_before.operational_gains, slot_after.operational_gains,
    slot_before.operational_slot_value, slot_after.operational_slot_value,
    gain_unit_before, gain_unit_after,
    slot_before.redistribution_received_usdt, slot_after.redistribution_received_usdt,
    slot_before.redistribution_sent_usdt, slot_after.redistribution_sent_usdt,
    slot_after.real_gains, slot_after.added_gains,
    jsonb_build_object('asset', asset_code, 'inputMode', 'USDT',
      'reason', normalized_reason, 'statusAtContribution', slot_before.status),
    caller_id
  );

  update coinops.btc_redistribution_batches batch
  set status = 'STALE', updated_at = timezone('utc', now()),
      result = batch.result || jsonb_build_object(
        'status', 'STALE', 'can_confirm', false,
        'stale_reason', 'EXTERNAL_BALANCE_APPLIED', 'stale_at', timezone('utc', now())
      )
  where batch.product_id = scope_row.product_id
    and batch.tenant_id = scope_row.tenant_id
    and batch.user_id = scope_row.user_id
    and batch.asset = asset_code
    and batch.status = 'PREPARED';
  get diagnostics stale_preview_count = row_count;

  contribution_result := contribution_result || jsonb_build_object(
    'stale_preview_count', stale_preview_count
  );
  update coinops.btc_external_contributions
  set result = contribution_result
  where id = contribution_id;
  return contribution_result;
end;
$contribution$;

create or replace function coinops.apply_asset_manual_operational_gains(
  p_asset text,
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
  asset_code text := private.coinops_normalize_growth_asset(p_asset);
  existing_contribution coinops.btc_external_contributions%rowtype;
  slot_before coinops.slots%rowtype;
  slot_after coinops.slots%rowtype;
  contribution_id uuid := gen_random_uuid();
  caller_id uuid := (select auth.uid());
  normalized_gains integer;
  normalized_reason text := btrim(coalesce(p_reason, ''));
  compounded_value numeric(20, 8);
  required_amount numeric(20, 8);
  gain_unit_before numeric(20, 8);
  gain_unit_after numeric(20, 8);
  contribution_result jsonb;
  stale_preview_count integer := 0;
begin
  if caller_id is null then raise exception 'COINOPS_AUTH_REQUIRED'; end if;
  if p_slot_id is null or p_idempotency_key is null then
    raise exception 'COINOPS_SLOT_AND_IDEMPOTENCY_REQUIRED';
  end if;
  if p_operational_gains is null
    or p_operational_gains <= 0
    or p_operational_gains <> trunc(p_operational_gains)
    or p_operational_gains > 1000 then
    raise exception 'COINOPS_MANUAL_GAINS_MUST_BE_POSITIVE_INTEGER';
  end if;
  normalized_gains := p_operational_gains::integer;
  if char_length(normalized_reason) not between 1 and 500 then
    raise exception 'COINOPS_CONTRIBUTION_REASON_INVALID';
  end if;

  select * into strict scope_row from private.coinops_current_scope();
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'coinops:' || lower(asset_code) || '-capital:' || scope_row.product_id::text || ':'
      || scope_row.tenant_id::text || ':' || scope_row.user_id::text,
    0
  ));

  select * into existing_contribution
  from coinops.btc_external_contributions contribution
  where contribution.product_id = scope_row.product_id
    and contribution.tenant_id = scope_row.tenant_id
    and contribution.user_id = scope_row.user_id
    and contribution.idempotency_key = p_idempotency_key
    and contribution.asset = asset_code;
  if found then
    if existing_contribution.input_mode <> 'MANUAL_GAINS'
      or existing_contribution.slot_id <> p_slot_id
      or existing_contribution.gain_equivalent <> normalized_gains
      or existing_contribution.reason <> normalized_reason then
      raise exception 'COINOPS_IDEMPOTENCY_CONFLICT';
    end if;
    return existing_contribution.result || jsonb_build_object('already_applied', true);
  end if;

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
    and slot.id = p_slot_id
    and strategy.asset = asset_code
  for update of slot;
  if not found then raise exception 'COINOPS_GROWTH_SLOT_NOT_FOUND'; end if;

  compounded_value := private.coinops_compound_operational_value_usdt(
    slot_before.operational_slot_value, slot_before.gain_rate, normalized_gains
  );
  required_amount := round(compounded_value - slot_before.operational_slot_value, 8);
  if compounded_value is null or compounded_value > 999999999999.99999999
    or required_amount <= 0 then
    raise exception 'COINOPS_MANUAL_GAINS_RESULT_OUT_OF_RANGE';
  end if;

  gain_unit_before := private.coinops_position_gain_unit_usdt(
    slot_before.operational_slot_value, slot_before.gain_rate
  );
  gain_unit_after := private.coinops_position_gain_unit_usdt(
    compounded_value, slot_before.gain_rate
  );

  update coinops.slots slot
  set
    growth_contribution = round(slot.growth_contribution + required_amount, 8),
    operational_gains = slot.operational_gains + normalized_gains,
    accounting_version = slot.accounting_version + 1
  where slot.product_id = scope_row.product_id
    and slot.tenant_id = scope_row.tenant_id
    and slot.user_id = scope_row.user_id
    and slot.id = slot_before.id
  returning * into strict slot_after;

  if slot_after.operational_slot_value <> compounded_value
    or slot_after.operational_gains <> slot_before.operational_gains + normalized_gains
    or slot_after.real_gains <> slot_before.real_gains
    or slot_after.position_notional_usdt is distinct from slot_before.position_notional_usdt
    or slot_after.position_gain_unit_usdt is distinct from slot_before.position_gain_unit_usdt
    or slot_after.preco_entrada is distinct from slot_before.preco_entrada
    or slot_after.preco_alvo is distinct from slot_before.preco_alvo then
    raise exception 'COINOPS_MANUAL_GAINS_POSTCONDITION_FAILED';
  end if;

  contribution_result := jsonb_build_object(
    'ok', true, 'asset', asset_code, 'status', 'APPLIED',
    'input_mode', 'MANUAL_GAINS', 'id', contribution_id,
    'slot_id', slot_after.id, 'slot_number', slot_after.slot_number,
    'amount_usdt', required_amount, 'accounting_amount_usdt', required_amount,
    'gain_equivalent', normalized_gains,
    'requested_operational_gains', normalized_gains,
    'operational_before', slot_before.operational_gains,
    'operational_after', slot_after.operational_gains,
    'value_before', slot_before.operational_slot_value,
    'value_after', slot_after.operational_slot_value,
    'gain_unit_before_usdt', gain_unit_before,
    'gain_unit_after_usdt', gain_unit_after,
    'reason', normalized_reason, 'created_at', timezone('utc', now()),
    'already_applied', false
  );

  insert into coinops.btc_external_contributions (
    id, product_code, product_id, tenant_id, user_id, asset, slot_id, slot_number,
    idempotency_key, amount_usdt, accounting_amount_usdt, input_mode,
    gain_unit_before_usdt, gain_unit_after_usdt, gain_equivalent,
    operational_before, operational_after, value_before, value_after,
    reason, applied_by, result
  ) values (
    contribution_id, 'coinops', scope_row.product_id, scope_row.tenant_id,
    scope_row.user_id, asset_code, slot_after.id, slot_after.slot_number,
    p_idempotency_key, required_amount, required_amount, 'MANUAL_GAINS',
    gain_unit_before, gain_unit_after, normalized_gains,
    slot_before.operational_gains, slot_after.operational_gains,
    slot_before.operational_slot_value, slot_after.operational_slot_value,
    normalized_reason, caller_id, contribution_result
  );

  insert into coinops.slot_capital_ledger (
    product_code, product_id, tenant_id, user_id, slot_id,
    external_contribution_id, entry_type, amount_usdt,
    operational_gain_delta, operational_before, operational_after,
    value_before, value_after, gain_unit_before_usdt, gain_unit_after_usdt,
    redistribution_received_before, redistribution_received_after,
    redistribution_sent_before, redistribution_sent_after,
    real_gains_snapshot, added_gains_snapshot, metadata, created_by
  ) values (
    'coinops', scope_row.product_id, scope_row.tenant_id, scope_row.user_id,
    slot_after.id, contribution_id, 'EXTERNAL_CONTRIBUTION', required_amount,
    normalized_gains, slot_before.operational_gains, slot_after.operational_gains,
    slot_before.operational_slot_value, slot_after.operational_slot_value,
    gain_unit_before, gain_unit_after,
    slot_before.redistribution_received_usdt, slot_after.redistribution_received_usdt,
    slot_before.redistribution_sent_usdt, slot_after.redistribution_sent_usdt,
    slot_after.real_gains, slot_after.added_gains,
    jsonb_build_object('asset', asset_code, 'inputMode', 'MANUAL_GAINS',
      'requestedOperationalGains', normalized_gains,
      'reason', normalized_reason, 'statusAtContribution', slot_before.status),
    caller_id
  );

  update coinops.btc_redistribution_batches batch
  set status = 'STALE', updated_at = timezone('utc', now()),
      result = batch.result || jsonb_build_object(
        'status', 'STALE', 'can_confirm', false,
        'stale_reason', 'MANUAL_OPERATIONAL_GAINS_APPLIED',
        'stale_at', timezone('utc', now())
      )
  where batch.product_id = scope_row.product_id
    and batch.tenant_id = scope_row.tenant_id
    and batch.user_id = scope_row.user_id
    and batch.asset = asset_code
    and batch.status = 'PREPARED';
  get diagnostics stale_preview_count = row_count;

  contribution_result := contribution_result || jsonb_build_object(
    'stale_preview_count', stale_preview_count
  );
  update coinops.btc_external_contributions
  set result = contribution_result
  where id = contribution_id;
  return contribution_result;
end;
$manual_gains$;

revoke all on function coinops.apply_asset_external_contribution(text, uuid, numeric, text, uuid)
  from public, anon;
grant execute on function coinops.apply_asset_external_contribution(text, uuid, numeric, text, uuid)
  to authenticated;

revoke all on function coinops.apply_asset_manual_operational_gains(text, uuid, numeric, text, uuid)
  from public, anon;
grant execute on function coinops.apply_asset_manual_operational_gains(text, uuid, numeric, text, uuid)
  to authenticated;

alter table coinops.slot_compounding_adjustments enable row level security;
alter table coinops.slot_compounding_adjustments force row level security;

drop policy if exists slot_compounding_adjustments_owner_select
  on coinops.slot_compounding_adjustments;
create policy slot_compounding_adjustments_owner_select
  on coinops.slot_compounding_adjustments
  for select
  to authenticated
  using (private.coinops_can_access_row(product_id, tenant_id, user_id));

create trigger coinops_scope_slot_compounding_adjustments_v1
before insert or update on coinops.slot_compounding_adjustments
for each row execute function private.coinops_apply_authenticated_scope();

revoke all on table coinops.slot_compounding_adjustments from public, anon, authenticated;
grant select on table coinops.slot_compounding_adjustments to authenticated, service_role;

comment on function private.coinops_compound_operational_value_usdt(numeric, numeric, integer) is
  'Applies whole gains sequentially to the immediately previous operational balance.';
comment on table coinops.slot_compounding_adjustments is
  'Immutable audit of the one-time conversion from legacy linear balances to sequential compounding.';
comment on column coinops.btc_external_contributions.amount_usdt is
  'Original amount recorded when the contribution was created; preserved for historical audit.';
comment on column coinops.btc_external_contributions.accounting_amount_usdt is
  'Effective amount used by current compound accounting; differs only for audited legacy corrections.';
