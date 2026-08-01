-- Replace values left by the retired redistribution with the current strategy
-- rule: base capital plus its linear gain amount for every recorded gain.
update public.slots as slot
set
  gain_rate = strategy.gain_rate,
  realized_profit = round(
    (slot.base_value + slot.growth_contribution) * strategy.gain_rate * slot.gains,
    8
  )
from public.strategies as strategy
where strategy.id = slot.strategy_id
  and strategy.user_id = slot.user_id;

create or replace function public.apply_realized_profit_on_real_gain()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $profit$
begin
  if new.gains > old.gains then
    new.realized_profit := round(
      (new.base_value + new.growth_contribution) * new.gain_rate * new.gains,
      8
    );
  end if;

  return new;
end;
$profit$;
