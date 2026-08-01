-- Slot Control is moving from internal redistribution to external, programmed
-- contributions. Financial operation history remains in history_events.

alter table public.slots drop column if exists operational_slot_value;

alter table public.slots
  add column if not exists realized_profit numeric(18, 8) not null default 0,
  add column if not exists growth_contribution numeric(18, 8) not null default 0;

update public.slots
set realized_profit = reinvested_profit
where realized_profit = 0 and reinvested_profit > 0;

alter table public.slots
  drop constraint if exists slots_realized_profit_check,
  drop constraint if exists slots_growth_contribution_check;

alter table public.slots
  add constraint slots_realized_profit_check check (realized_profit >= 0),
  add constraint slots_growth_contribution_check check (growth_contribution >= 0);

alter table public.slots
  add column operational_slot_value numeric(18, 8)
  generated always as (round((base_value + reinvested_profit + growth_contribution), 8)) stored;

create or replace function public.apply_realized_profit_on_real_gain()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $profit$
begin
  if new.gains > old.gains then
    new.realized_profit := round(
      old.realized_profit + (old.base_value + old.realized_profit + old.growth_contribution) * new.gain_rate,
      8
    );
  end if;

  return new;
end;
$profit$;

drop trigger if exists slots_apply_realized_profit_on_real_gain on public.slots;
create trigger slots_apply_realized_profit_on_real_gain
before update of gains on public.slots
for each row
execute function public.apply_realized_profit_on_real_gain();

create table if not exists public.growth_plan_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  started_at date not null default current_date,
  btc_monthly_goal integer not null default 7 check (btc_monthly_goal > 0 and btc_monthly_goal <= 1000),
  sol_monthly_goal integer not null default 1 check (sol_monthly_goal > 0 and sol_monthly_goal <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.programmed_growth_contributions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  asset text not null check (asset in ('BTC', 'SOL')),
  month_number integer not null check (month_number > 0),
  cumulative_goal integer not null check (cumulative_goal >= 0),
  slot_id uuid not null references public.slots(id) on delete restrict,
  slot_number integer not null check (slot_number > 0),
  gains_before integer not null check (gains_before >= 0),
  gains_after integer not null check (gains_after >= gains_before),
  value_before numeric(18, 8) not null check (value_before >= 0),
  value_after numeric(18, 8) not null check (value_after >= value_before),
  contributed_amount numeric(18, 8) not null check (contributed_amount > 0),
  note text,
  applied_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (user_id, asset, month_number)
);

create index if not exists programmed_growth_contributions_user_created_idx
  on public.programmed_growth_contributions (user_id, created_at desc);

insert into public.growth_plan_settings (user_id)
select id from auth.users
on conflict (user_id) do nothing;

create or replace function public.set_growth_plan_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $updated_at$
begin
  new.updated_at := now();
  return new;
end;
$updated_at$;

drop trigger if exists growth_plan_settings_set_updated_at on public.growth_plan_settings;
create trigger growth_plan_settings_set_updated_at
before update on public.growth_plan_settings
for each row execute function public.set_growth_plan_updated_at();

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
  v_contribution numeric(18, 8);
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

    select s.id, s.slot_number, s.status, s.gains, s.gain_rate, s.operational_slot_value
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
      v_contribution := case
        when v_missing_gains > 0 and v_leader.gain_rate > 0
          then round(v_leader.operational_slot_value * (power(1 + v_leader.gain_rate, v_missing_gains) - 1), 8)
        else 0
      end;

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
          'leader_value', v_leader.operational_slot_value,
          'missing_gains', v_missing_gains,
          'required_contribution', v_contribution,
          'already_applied', exists (
            select 1 from public.programmed_growth_contributions c
            where c.user_id = v_user_id and c.asset = v_asset and c.month_number = v_month_number
          )
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
          'leader_value', null,
          'missing_gains', null,
          'required_contribution', 0,
          'already_applied', false
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

create or replace function public.apply_programmed_growth_contribution(
  p_asset text,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $apply$
declare
  v_user_id uuid := auth.uid();
  v_asset text := upper(trim(p_asset));
  v_settings public.growth_plan_settings%rowtype;
  v_month_number integer;
  v_monthly_goal integer;
  v_cumulative_goal integer;
  v_leader public.slots%rowtype;
  v_missing_gains integer;
  v_amount numeric(18, 8);
  v_value_before numeric(18, 8);
  v_value_after numeric(18, 8);
  v_note text := nullif(left(trim(coalesce(p_note, '')), 500), '');
begin
  if v_user_id is null then
    return jsonb_build_object('ok', false, 'code', 'AUTH_REQUIRED', 'message', 'Faça login para aplicar o aporte.');
  end if;
  if v_asset not in ('BTC', 'SOL') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_ASSET', 'message', 'Ativo inválido para o plano de crescimento.');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('programmed-growth:' || v_user_id::text || ':' || v_asset, 0));

  select * into v_settings from public.growth_plan_settings where user_id = v_user_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'SETTINGS_NOT_FOUND', 'message', 'As configurações do plano não foram encontradas.');
  end if;

  v_month_number := greatest(
    1,
    (extract(year from current_date)::integer - extract(year from v_settings.started_at)::integer) * 12
      + extract(month from current_date)::integer - extract(month from v_settings.started_at)::integer + 1
  );
  v_monthly_goal := case when v_asset = 'BTC' then v_settings.btc_monthly_goal else v_settings.sol_monthly_goal end;
  v_cumulative_goal := v_month_number * v_monthly_goal;

  if exists (
    select 1 from public.programmed_growth_contributions
    where user_id = v_user_id and asset = v_asset and month_number = v_month_number
  ) then
    return jsonb_build_object('ok', false, 'code', 'ALREADY_APPLIED', 'message', 'O aporte deste mês já foi registrado.');
  end if;

  select s.* into v_leader
  from public.slots s
  join public.strategies st on st.id = s.strategy_id
  where s.user_id = v_user_id
    and st.asset = v_asset
    and s.status in ('gain', 'zerado')
  order by s.gains desc, s.slot_number asc, s.sort_order asc, s.id asc
  limit 1
  for update of s;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'NO_CLOSED_SLOT', 'message', 'Não há slot fechado disponível para receber aporte.');
  end if;
  if v_leader.status = 'aberto' then
    return jsonb_build_object('ok', false, 'code', 'OPEN_SLOT', 'message', 'Slots abertos nunca recebem aporte.');
  end if;

  v_missing_gains := greatest(v_cumulative_goal - v_leader.gains, 0);
  if v_missing_gains = 0 then
    return jsonb_build_object('ok', false, 'code', 'GOAL_REACHED', 'message', 'A meta acumulada deste mês já foi atingida.');
  end if;
  if v_leader.gain_rate <= 0 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_GAIN_RATE', 'message', 'O slot líder não possui uma taxa de gain válida.');
  end if;

  v_value_before := v_leader.operational_slot_value;
  v_amount := round(v_value_before * (power(1 + v_leader.gain_rate, v_missing_gains) - 1), 8);
  if v_amount <= 0 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_AMOUNT', 'message', 'O valor calculado para o aporte é inválido.');
  end if;

  update public.slots
  set growth_contribution = growth_contribution + v_amount
  where id = v_leader.id
    and user_id = v_user_id
    and status in ('gain', 'zerado')
  returning operational_slot_value into v_value_after;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'SLOT_CHANGED', 'message', 'O slot mudou durante o processamento. Nenhum aporte foi aplicado.');
  end if;

  insert into public.programmed_growth_contributions (
    user_id, asset, month_number, cumulative_goal, slot_id, slot_number,
    gains_before, gains_after, value_before, value_after, contributed_amount, note, applied_by
  ) values (
    v_user_id, v_asset, v_month_number, v_cumulative_goal, v_leader.id, v_leader.slot_number,
    v_leader.gains, v_leader.gains, v_value_before, v_value_after, v_amount, v_note, v_user_id
  );

  insert into public.history_events (user_id, strategy_id, slot_id, action, detail, strategy_key, slot_number)
  select
    v_user_id,
    v_leader.strategy_id,
    v_leader.id,
    'aporte_programado',
    jsonb_build_object(
      'schemaVersion', 1,
      'message', format('Aporte programado de %s aplicado no slot %s de %s.', v_amount, v_leader.slot_number, v_asset),
      'asset', v_asset,
      'eventType', 'aporte_programado',
      'origin', 'MANUAL',
      'monthNumber', v_month_number,
      'cumulativeGoal', v_cumulative_goal,
      'gainsBefore', v_leader.gains,
      'gainsAfter', v_leader.gains,
      'valueBefore', v_value_before,
      'valueAfter', v_value_after,
      'contributedAmount', v_amount,
      'note', v_note
    )::text,
    st.key,
    v_leader.slot_number
  from public.strategies st
  where st.id = v_leader.strategy_id;

  return jsonb_build_object(
    'ok', true,
    'asset', v_asset,
    'month_number', v_month_number,
    'cumulative_goal', v_cumulative_goal,
    'slot_id', v_leader.id,
    'slot_number', v_leader.slot_number,
    'gains_before', v_leader.gains,
    'gains_after', v_leader.gains,
    'value_before', v_value_before,
    'value_after', v_value_after,
    'contributed_amount', v_amount,
    'message', 'Aporte programado aplicado com sucesso.'
  );
end;
$apply$;

alter table public.growth_plan_settings enable row level security;
alter table public.programmed_growth_contributions enable row level security;

create policy "Users can manage own growth plan settings"
on public.growth_plan_settings for all
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy "Users can read own programmed growth contributions"
on public.programmed_growth_contributions for select
to authenticated
using ((select auth.uid()) = user_id);

revoke all on function public.get_programmed_growth_plan() from public, anon;
grant execute on function public.get_programmed_growth_plan() to authenticated;
revoke all on function public.apply_programmed_growth_contribution(text, text) from public, anon;
grant execute on function public.apply_programmed_growth_contribution(text, text) to authenticated;
