-- Gains reais sao produzidos somente pelo fechamento de um slot aberto.
-- Gains adicionados permitem cumprir a meta sem alterar valores ou eventos financeiros anteriores.

alter table public.slots
  add column if not exists real_gains integer not null default 0,
  add column if not exists added_gains integer not null default 0;

with last_reset as (
  select slot_id, max(event_at) as event_at
  from public.history_events
  where action = 'Zerar'
    and slot_id is not null
  group by slot_id
), recorded_real_gains as (
  select history.slot_id, count(*)::integer as gains
  from public.history_events history
  left join last_reset reset on reset.slot_id = history.slot_id
  where history.action = 'Gain'
    and history.slot_id is not null
    and (reset.event_at is null or history.event_at > reset.event_at)
  group by history.slot_id
)
update public.slots slot
set
  real_gains = least(slot.gains, coalesce(recorded_real_gains.gains, 0)),
  added_gains = slot.gains - least(slot.gains, coalesce(recorded_real_gains.gains, 0))
from recorded_real_gains
where recorded_real_gains.slot_id = slot.id;

update public.slots
set
  real_gains = 0,
  added_gains = gains
where real_gains = 0
  and added_gains = 0
  and gains > 0;

alter table public.slots
  drop constraint if exists slots_real_gains_check,
  drop constraint if exists slots_added_gains_check,
  drop constraint if exists slots_gain_breakdown_check;

alter table public.slots
  add constraint slots_real_gains_check check (real_gains >= 0),
  add constraint slots_added_gains_check check (added_gains >= 0),
  add constraint slots_gain_breakdown_check check (gains = real_gains + added_gains);

create or replace function public.enforce_slot_gain_breakdown()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $gain_breakdown$
begin
  if new.gains <> new.real_gains + new.added_gains then
    raise exception 'A soma de gains reais e adicionados deve ser igual ao total de gains.';
  end if;

  if tg_op = 'UPDATE' then
    if new.status = 'zerado'
      and new.gains = 0
      and new.real_gains = 0
      and new.added_gains = 0 then
      return new;
    end if;

    if new.real_gains <> old.real_gains
      and not (
        old.status = 'aberto'
        and new.status = 'gain'
        and new.real_gains = old.real_gains + 1
        and new.added_gains = old.added_gains
        and new.gains = old.gains + 1
      ) then
      raise exception 'Gains reais so podem ser registrados ao fechar um slot aberto.';
    end if;

    if new.added_gains < old.added_gains then
      raise exception 'Gains adicionados nao podem ser reduzidos sem zerar o slot.';
    end if;

    if new.added_gains <> old.added_gains
      and old.status not in ('gain', 'zerado') then
      raise exception 'Gains adicionados so podem ser aplicados em slots fechados.';
    end if;
  end if;

  return new;
end;
$gain_breakdown$;

drop trigger if exists slots_enforce_gain_breakdown on public.slots;
create trigger slots_enforce_gain_breakdown
before update of gains, real_gains, added_gains, status on public.slots
for each row
execute function public.enforce_slot_gain_breakdown();

create or replace function public.get_programmed_growth_plan()
returns jsonb
language plpgsql
security invoker
stable
set search_path = public, pg_temp
as $plan$
declare
  v_user_id uuid := auth.uid();
  v_settings public.growth_plan_settings%rowtype;
  v_month_number integer;
  v_asset text;
  v_monthly_goal integer;
  v_cumulative_goal integer;
  v_leader record;
  v_missing_gains integer;
  v_plans jsonb := '{}'::jsonb;
begin
  if v_user_id is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  select * into v_settings
  from public.growth_plan_settings
  where user_id = v_user_id;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'SETTINGS_NOT_FOUND');
  end if;

  v_month_number := greatest(
    1,
    (extract(year from current_date)::integer - extract(year from v_settings.started_at)::integer) * 12
      + extract(month from current_date)::integer - extract(month from v_settings.started_at)::integer + 1
  );

  foreach v_asset in array array['BTC', 'SOL']
  loop
    v_monthly_goal := case when v_asset = 'BTC' then v_settings.btc_monthly_goal else v_settings.sol_monthly_goal end;
    v_cumulative_goal := v_month_number * v_monthly_goal;

    select s.id, s.slot_number, s.status, s.gains, s.real_gains, s.added_gains
      into v_leader
    from public.slots s
    join public.strategies st on st.id = s.strategy_id
    where s.user_id = v_user_id
      and st.asset = v_asset
      and s.status in ('gain', 'zerado')
    order by s.gains desc, s.slot_number asc, s.sort_order asc, s.id asc
    limit 1;

    if found then
      v_missing_gains := greatest(v_cumulative_goal - v_leader.gains, 0);
      v_plans := v_plans || jsonb_build_object(
        v_asset,
        jsonb_build_object(
          'asset', v_asset,
          'monthly_goal', v_monthly_goal,
          'cumulative_goal', v_cumulative_goal,
          'month_number', v_month_number,
          'leader_slot_id', v_leader.id,
          'leader_slot_number', v_leader.slot_number,
          'leader_status', v_leader.status,
          'leader_gains', v_leader.gains,
          'leader_real_gains', v_leader.real_gains,
          'leader_added_gains', v_leader.added_gains,
          'missing_gains', v_missing_gains
        )
      );
    else
      v_plans := v_plans || jsonb_build_object(
        v_asset,
        jsonb_build_object(
          'asset', v_asset,
          'monthly_goal', v_monthly_goal,
          'cumulative_goal', v_cumulative_goal,
          'month_number', v_month_number,
          'leader_slot_id', null,
          'leader_slot_number', null,
          'leader_status', null,
          'leader_gains', null,
          'leader_real_gains', null,
          'leader_added_gains', null,
          'missing_gains', null
        )
      );
    end if;
  end loop;

  return jsonb_build_object(
    'ok', true,
    'started_at', v_settings.started_at,
    'month_number', v_month_number,
    'btc_monthly_goal', v_settings.btc_monthly_goal,
    'sol_monthly_goal', v_settings.sol_monthly_goal,
    'plans', v_plans
  );
end;
$plan$;

drop function if exists public.apply_programmed_growth_contribution(text, text);
