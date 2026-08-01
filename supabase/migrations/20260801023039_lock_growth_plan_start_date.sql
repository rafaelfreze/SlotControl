create or replace function public.lock_growth_plan_start_date()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $lock_start$
begin
  if tg_op = 'INSERT' then
    new.started_at := current_date;
  elsif new.started_at <> old.started_at then
    raise exception 'GROWTH_PLAN_START_DATE_IMMUTABLE';
  end if;

  return new;
end;
$lock_start$;

drop trigger if exists growth_plan_settings_lock_start_date on public.growth_plan_settings;
create trigger growth_plan_settings_lock_start_date
before insert or update on public.growth_plan_settings
for each row execute function public.lock_growth_plan_start_date();
