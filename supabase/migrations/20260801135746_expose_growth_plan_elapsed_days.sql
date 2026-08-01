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
  v_elapsed_days integer;
  v_month_number integer;
  v_cycle_days integer;
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

  v_elapsed_days := greatest(current_date - v_settings.started_at::date, 0);
  v_month_number := greatest(1, ceil(v_elapsed_days::numeric / 30)::integer);
  v_cycle_days := v_month_number * 30;

  foreach v_asset in array array['BTC', 'SOL']
  loop
    v_monthly_goal := case when v_asset = 'BTC' then v_settings.btc_monthly_goal else v_settings.sol_monthly_goal end;
    v_cumulative_goal := v_month_number * v_monthly_goal;

    select ranked.id, ranked.slot_number, ranked.status, ranked.gains, ranked.real_gains, ranked.added_gains, ranked.display_rank
      into v_leader
    from (
      select
        s.id,
        s.slot_number,
        s.status,
        s.gains,
        s.real_gains,
        s.added_gains,
        row_number() over (order by s.gains desc, s.slot_number asc, s.sort_order asc, s.id asc)::integer as display_rank
      from public.slots s
      join public.strategies st on st.id = s.strategy_id
      where s.user_id = v_user_id
        and st.asset = v_asset
        and s.status in ('gain', 'zerado')
    ) ranked
    order by ranked.display_rank asc
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
          'cycle_days', v_cycle_days,
          'leader_slot_id', v_leader.id,
          'leader_slot_number', v_leader.slot_number,
          'leader_display_rank', v_leader.display_rank,
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
          'cycle_days', v_cycle_days,
          'leader_slot_id', null,
          'leader_slot_number', null,
          'leader_display_rank', null,
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
    'elapsed_days', v_elapsed_days,
    'month_number', v_month_number,
    'cycle_days', v_cycle_days,
    'btc_monthly_goal', v_settings.btc_monthly_goal,
    'sol_monthly_goal', v_settings.sol_monthly_goal,
    'plans', v_plans
  );
end;
$plan$;
