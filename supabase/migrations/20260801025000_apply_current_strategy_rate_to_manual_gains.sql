-- A manual gain adjustment can add more than one gain at once. The current
-- slot rate (kept in sync with its strategy) is applied only to the added gains.
create or replace function public.apply_realized_profit_on_real_gain()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $profit$
begin
  if new.gains > old.gains then
    new.realized_profit := round(
      old.realized_profit + (old.base_value + old.realized_profit + old.growth_contribution) * (power(1 + new.gain_rate, new.gains - old.gains) - 1),
      8
    );
  end if;

  return new;
end;
$profit$;
