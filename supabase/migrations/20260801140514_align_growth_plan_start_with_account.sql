create or replace function public.lock_growth_plan_start_date()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $lock_start$
begin
  if tg_op = 'INSERT' then
    select coalesce(profile.created_at::date, current_date)
      into new.started_at
    from public.profiles profile
    where profile.id = new.user_id;

    new.started_at := coalesce(new.started_at, current_date);
  elsif new.started_at <> old.started_at
    and current_setting('app.allow_growth_plan_start_backfill', true) is distinct from 'on' then
    raise exception 'GROWTH_PLAN_START_DATE_IMMUTABLE';
  end if;

  return new;
end;
$lock_start$;

select set_config('app.allow_growth_plan_start_backfill', 'on', true);

update public.growth_plan_settings settings
set started_at = profile.created_at::date
from public.profiles profile
where profile.id = settings.user_id
  and profile.created_at::date < settings.started_at;
