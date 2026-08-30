create or replace function coinops.validate_official_slot_entry(p_slot_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
#variable_conflict use_variable
declare
  scope_row record;
  baseline_id uuid;
  mode_name text;
  cycle_id uuid;
  cycle_number integer;
  requested record;
  expected_slot_id uuid;
  expected_slot_number integer;
  has_unmet_main_target boolean := false;
  recommendation_code text;
begin
  select * into strict scope_row
  from private.coinops_current_scope();

  select b.id, r.mode
    into baseline_id, mode_name
  from coinops.monitoring_baselines b
  join coinops.strategy_regime_state r on r.baseline_id = b.id
  where b.product_id = scope_row.product_id
    and b.tenant_id = scope_row.tenant_id
    and b.user_id = scope_row.user_id
    and b.status = 'ACTIVE';

  if not found then
    return jsonb_build_object(
      'ok', true,
      'active', false,
      'allowed', true,
      'recommended', false
    );
  end if;

  select c.id, c.cycle_number
    into cycle_id, cycle_number
  from coinops.operational_cycles c
  where c.baseline_id = baseline_id
    and c.status = 'ACTIVE';

  if not found then
    return jsonb_build_object(
      'ok', true,
      'active', true,
      'allowed', false,
      'recommended', false,
      'code', 'NO_ACTIVE_CYCLE'
    );
  end if;

  select p.*, s.status, p.asset as requested_asset
    into requested
  from coinops.slot_pool_configuration p
  join coinops.slots s on s.id = p.slot_id
  where p.baseline_id = baseline_id
    and p.slot_id = p_slot_id;

  if not found or not requested.enabled or not requested.funded then
    return jsonb_build_object(
      'ok', true,
      'active', true,
      'allowed', false,
      'recommended', false,
      'code', 'SLOT_NOT_ENABLED_OR_FUNDED'
    );
  end if;

  if requested.status = 'aberto' then
    return jsonb_build_object(
      'ok', true,
      'active', true,
      'allowed', false,
      'recommended', false,
      'asset', requested.requested_asset,
      'code', 'SLOT_ALREADY_OPEN'
    );
  end if;

  if requested.active_from_cycle > cycle_number then
    return jsonb_build_object(
      'ok', true,
      'active', true,
      'allowed', false,
      'recommended', false,
      'asset', requested.requested_asset,
      'code', 'SLOT_NOT_ACTIVE_FOR_CYCLE'
    );
  end if;

  if requested.pool = 'RESERVE'
    and not coalesce(requested.allow_reserve, false) then
    return jsonb_build_object(
      'ok', true,
      'active', true,
      'allowed', false,
      'recommended', false,
      'asset', requested.requested_asset,
      'code', 'RESERVE_NOT_ALLOWED'
    );
  end if;

  if mode_name = 'NORMAL_GROWTH' then
    select s.id, s.slot_number
      into expected_slot_id, expected_slot_number
    from coinops.cycle_slot_progress progress
    join coinops.slots s on s.id = progress.slot_id
    join coinops.slot_pool_configuration pool
      on pool.baseline_id = baseline_id
     and pool.slot_id = s.id
    where progress.cycle_id = cycle_id
      and progress.asset = requested.requested_asset
      and pool.asset = requested.requested_asset
      and progress.cycle_progress < progress.target
      and s.status <> 'aberto'
      and pool.enabled
      and pool.funded
      and pool.pool = 'MAIN'
      and pool.active_from_cycle <= cycle_number
    order by
      progress.cycle_progress,
      s.operational_gains,
      coalesce(progress.last_operated_at, 'epoch'::timestamptz),
      s.slot_number
    limit 1;

    if expected_slot_id is null then
      select exists(
        select 1
        from coinops.cycle_slot_progress progress
        join coinops.slot_pool_configuration pool
          on pool.baseline_id = baseline_id
         and pool.slot_id = progress.slot_id
        where progress.cycle_id = cycle_id
          and progress.asset = requested.requested_asset
          and pool.asset = requested.requested_asset
          and progress.cycle_progress < progress.target
          and pool.enabled
          and pool.funded
          and pool.pool = 'MAIN'
          and pool.active_from_cycle <= cycle_number
      ) into has_unmet_main_target;

      if has_unmet_main_target then
        select s.id, s.slot_number
          into expected_slot_id, expected_slot_number
        from coinops.cycle_slot_progress progress
        join coinops.slots s on s.id = progress.slot_id
        join coinops.slot_pool_configuration pool
          on pool.baseline_id = baseline_id
         and pool.slot_id = s.id
        where progress.cycle_id = cycle_id
          and progress.asset = requested.requested_asset
          and pool.asset = requested.requested_asset
          and progress.cycle_progress < progress.target
          and s.status <> 'aberto'
          and pool.enabled
          and pool.funded
          and pool.pool = 'RESERVE'
          and pool.allow_reserve
          and pool.active_from_cycle <= cycle_number
        order by
          progress.cycle_progress,
          s.operational_gains,
          coalesce(progress.last_operated_at, 'epoch'::timestamptz),
          s.slot_number
        limit 1;

        if expected_slot_id is null then
          recommendation_code := 'NO_ELIGIBLE_SLOT';
        end if;
      else
        recommendation_code := 'ALL_TARGETS_MET';
      end if;
    end if;
  else
    select s.id, s.slot_number
      into expected_slot_id, expected_slot_number
    from coinops.cycle_slot_progress progress
    join coinops.slots s on s.id = progress.slot_id
    join coinops.slot_pool_configuration pool
      on pool.baseline_id = baseline_id
     and pool.slot_id = s.id
    where progress.cycle_id = cycle_id
      and progress.asset = requested.requested_asset
      and pool.asset = requested.requested_asset
      and s.status <> 'aberto'
      and pool.enabled
      and pool.funded
      and pool.pool = 'MAIN'
      and pool.active_from_cycle <= cycle_number
    order by
      (s.operational_gains <> 0),
      s.operational_gains,
      s.operational_slot_value,
      coalesce(progress.last_operated_at, 'epoch'::timestamptz),
      s.slot_number
    limit 1;

    if expected_slot_id is null then
      select s.id, s.slot_number
        into expected_slot_id, expected_slot_number
      from coinops.cycle_slot_progress progress
      join coinops.slots s on s.id = progress.slot_id
      join coinops.slot_pool_configuration pool
        on pool.baseline_id = baseline_id
       and pool.slot_id = s.id
      where progress.cycle_id = cycle_id
        and progress.asset = requested.requested_asset
        and pool.asset = requested.requested_asset
        and s.status <> 'aberto'
        and pool.enabled
        and pool.funded
        and pool.pool = 'RESERVE'
        and pool.allow_reserve
        and pool.active_from_cycle <= cycle_number
      order by
        (s.operational_gains <> 0),
        s.operational_gains,
        s.operational_slot_value,
        coalesce(progress.last_operated_at, 'epoch'::timestamptz),
        s.slot_number
      limit 1;
    end if;

    if expected_slot_id is null then
      recommendation_code := 'NO_ELIGIBLE_SLOT';
    end if;
  end if;

  if expected_slot_id is not null then
    recommendation_code := case
      when expected_slot_id = p_slot_id then 'ALLOWED'
      else 'NOT_NEXT_PRIORITY'
    end;
  end if;

  return jsonb_build_object(
    'ok', true,
    'active', true,
    'allowed', true,
    'recommended', coalesce(expected_slot_id = p_slot_id, false),
    'asset', requested.requested_asset,
    'mode', mode_name,
    'expected_slot_id', expected_slot_id,
    'expected_slot_number', expected_slot_number,
    'code', recommendation_code
  );
end;
$function$;

revoke all on function coinops.validate_official_slot_entry(uuid)
  from public, anon, authenticated, service_role;

grant execute on function coinops.validate_official_slot_entry(uuid)
  to authenticated;
