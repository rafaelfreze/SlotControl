-- CoinOps growth gains compound from the complete operational balance.
--
-- The visible operational balance already includes base capital, realized
-- gains, external contributions and the net redistribution balance.  New BTC
-- and SOL positions must therefore freeze that full balance as their notional
-- and calculate the next real gain from it.  Existing OPEN snapshots are not
-- rewritten by this migration.

create or replace function private.coinops_position_gain_unit_usdt(
  p_operational_value numeric,
  p_gain_rate numeric
)
returns numeric
language sql
immutable
strict
set search_path = ''
as $position_gain_unit$
  select case
    when p_operational_value < 0 or p_gain_rate <= 0 then null
    else round(p_operational_value * p_gain_rate, 8)
  end;
$position_gain_unit$;

revoke all on function private.coinops_position_gain_unit_usdt(numeric, numeric)
  from public, anon, authenticated, service_role;

create or replace function private.coinops_capture_asset_position_snapshot()
returns trigger
language plpgsql
security definer
set search_path = ''
as $position$
declare
  asset_code text;
  calculated_notional numeric(20, 8);
begin
  select strategy.asset
    into asset_code
  from coinops.strategies strategy
  where strategy.product_id = new.product_id
    and strategy.tenant_id = new.tenant_id
    and strategy.user_id = new.user_id
    and strategy.id = new.strategy_id;

  if asset_code not in ('BTC', 'SOL') or new.status <> 'aberto' then
    return new;
  end if;

  -- Never rewrite a position that is already executing.  Contributions and
  -- redistributions received while OPEN remain accounting adjustments and are
  -- incorporated only when the next position is opened.
  if tg_op = 'UPDATE' and old.status = 'aberto' then
    return new;
  end if;

  calculated_notional := case
    when tg_op = 'UPDATE' then old.operational_slot_value
    else round(
      new.base_value
      + new.realized_profit
      + new.growth_contribution
      + new.redistribution_received_usdt
      - new.redistribution_sent_usdt,
      8
    )
  end;

  if calculated_notional is null or calculated_notional < 0 then
    raise exception 'COINOPS_GROWTH_POSITION_NOTIONAL_INVALID';
  end if;

  new.position_notional_usdt := calculated_notional;
  new.position_gain_unit_usdt := private.coinops_position_gain_unit_usdt(
    calculated_notional,
    new.gain_rate
  );
  new.position_quantity := case
    when new.preco_entrada is not null and new.preco_entrada > 0 then
      round(calculated_notional / new.preco_entrada, 16)
    else null
  end;
  new.position_opened_at := timezone('utc', now());

  if new.position_gain_unit_usdt is null or new.position_gain_unit_usdt <= 0 then
    raise exception 'COINOPS_GROWTH_GAIN_UNIT_INVALID';
  end if;

  return new;
end;
$position$;

revoke all on function private.coinops_capture_asset_position_snapshot()
  from public, anon, authenticated, service_role;

comment on function private.coinops_position_gain_unit_usdt(numeric, numeric) is
  'Calculates one future real gain from the full operational balance frozen when a BTC or SOL position opens.';

comment on function private.coinops_capture_asset_position_snapshot() is
  'Freezes the complete operational balance and its gain value for each new BTC or SOL position without rewriting an already OPEN position.';
