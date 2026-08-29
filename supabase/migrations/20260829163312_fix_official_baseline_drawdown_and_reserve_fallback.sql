-- Correct BASELINE snapshot drawdown without duplicating the transactional
-- activation function. DAILY snapshots already calculate this metric directly.
create or replace function private.coinops_set_baseline_snapshot_drawdown()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $fn$
declare
  btc_price numeric;
  btc_ath numeric;
begin
  if coalesce(new.metrics->>'kind','') <> 'BASELINE' then
    return new;
  end if;

  btc_price := nullif(new.metrics #>> '{prices,BTC}','')::numeric;
  btc_ath := nullif(new.metrics #>> '{account,official_btc_ath}','')::numeric;

  if btc_price is null or btc_price <= 0 or btc_ath is null or btc_ath <= 0 then
    return new;
  end if;

  new.metrics := jsonb_set(
    new.metrics,
    '{btc_drawdown_pct}',
    to_jsonb(round(
      ((btc_price / nullif(greatest(btc_ath,btc_price),0)) - 1) * 100,
      8
    )),
    true
  );
  return new;
end
$fn$;

drop trigger if exists coinops_set_baseline_snapshot_drawdown_v1
  on coinops.cycle_daily_snapshots;
create trigger coinops_set_baseline_snapshot_drawdown_v1
before insert on coinops.cycle_daily_snapshots
for each row
execute function private.coinops_set_baseline_snapshot_drawdown();

revoke all on function private.coinops_set_baseline_snapshot_drawdown()
  from public,anon,authenticated,service_role;

-- MAIN remains authoritative. In NORMAL, reserve is considered only while at
-- least one MAIN is below target but every such MAIN is currently unavailable.
create or replace function coinops.validate_official_slot_entry(p_slot_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $fn$
#variable_conflict use_variable
declare
  scope_row record;
  baseline_id uuid;
  mode_name text;
  cycle_id uuid;
  cycle_number integer;
  requested record;
  expected record;
  has_unmet_main_target boolean := false;
begin
  select * into strict scope_row from private.coinops_current_scope();
  select b.id,r.mode into baseline_id,mode_name
  from coinops.monitoring_baselines b
  join coinops.strategy_regime_state r on r.baseline_id=b.id
  where b.product_id=scope_row.product_id
    and b.tenant_id=scope_row.tenant_id
    and b.user_id=scope_row.user_id
    and b.status='ACTIVE';
  if not found then
    return jsonb_build_object('ok',true,'active',false,'allowed',true);
  end if;

  select c.id,c.cycle_number into cycle_id,cycle_number
  from coinops.operational_cycles c
  where c.baseline_id=baseline_id and c.status='ACTIVE';
  if not found then
    return jsonb_build_object(
      'ok',true,'active',true,'allowed',false,'code','NO_ACTIVE_CYCLE'
    );
  end if;

  select p.*,s.status,p.asset requested_asset into requested
  from coinops.slot_pool_configuration p
  join coinops.slots s on s.id=p.slot_id
  where p.baseline_id=baseline_id and p.slot_id=p_slot_id;
  if not found or not requested.enabled or not requested.funded then
    return jsonb_build_object(
      'ok',true,'active',true,'allowed',false,
      'code','SLOT_NOT_ENABLED_OR_FUNDED'
    );
  end if;

  if mode_name='NORMAL_GROWTH' then
    select s.id,s.slot_number into expected
    from coinops.cycle_slot_progress progress
    join coinops.slots s on s.id=progress.slot_id
    join coinops.slot_pool_configuration pool
      on pool.baseline_id=baseline_id and pool.slot_id=s.id
    where progress.cycle_id=cycle_id
      and progress.asset=requested.requested_asset
      and pool.asset=requested.requested_asset
      and progress.cycle_progress<progress.target
      and s.status<>'aberto'
      and pool.enabled and pool.funded
      and pool.pool='MAIN'
      and pool.active_from_cycle<=cycle_number
    order by progress.cycle_progress,s.operational_gains,
      coalesce(progress.last_operated_at,'epoch'::timestamptz),s.slot_number
    limit 1;

    if not found then
      select exists(
        select 1
        from coinops.cycle_slot_progress progress
        join coinops.slot_pool_configuration pool
          on pool.baseline_id=baseline_id and pool.slot_id=progress.slot_id
        where progress.cycle_id=cycle_id
          and progress.asset=requested.requested_asset
          and pool.asset=requested.requested_asset
          and progress.cycle_progress<progress.target
          and pool.enabled and pool.funded
          and pool.pool='MAIN'
          and pool.active_from_cycle<=cycle_number
      ) into has_unmet_main_target;

      if not has_unmet_main_target then
        return jsonb_build_object(
          'ok',true,'active',true,'allowed',false,
          'asset',requested.requested_asset,'code','ALL_TARGETS_MET'
        );
      end if;

      select s.id,s.slot_number into expected
      from coinops.cycle_slot_progress progress
      join coinops.slots s on s.id=progress.slot_id
      join coinops.slot_pool_configuration pool
        on pool.baseline_id=baseline_id and pool.slot_id=s.id
      where progress.cycle_id=cycle_id
        and progress.asset=requested.requested_asset
        and pool.asset=requested.requested_asset
        and progress.cycle_progress<progress.target
        and s.status<>'aberto'
        and pool.enabled and pool.funded
        and pool.pool='RESERVE' and pool.allow_reserve
        and pool.active_from_cycle<=cycle_number
      order by progress.cycle_progress,s.operational_gains,
        coalesce(progress.last_operated_at,'epoch'::timestamptz),s.slot_number
      limit 1;
    end if;

    if not found then
      return jsonb_build_object(
        'ok',true,'active',true,'allowed',false,
        'asset',requested.requested_asset,'code','NO_ELIGIBLE_SLOT'
      );
    end if;
  else
    select s.id,s.slot_number into expected
    from coinops.cycle_slot_progress progress
    join coinops.slots s on s.id=progress.slot_id
    join coinops.slot_pool_configuration pool
      on pool.baseline_id=baseline_id and pool.slot_id=s.id
    where progress.cycle_id=cycle_id
      and progress.asset=requested.requested_asset
      and pool.asset=requested.requested_asset
      and s.status<>'aberto'
      and pool.enabled and pool.funded
      and pool.pool='MAIN'
      and pool.active_from_cycle<=cycle_number
    order by (s.operational_gains<>0),s.operational_gains,s.operational_slot_value,
      coalesce(progress.last_operated_at,'epoch'::timestamptz),s.slot_number
    limit 1;

    if not found then
      select s.id,s.slot_number into expected
      from coinops.cycle_slot_progress progress
      join coinops.slots s on s.id=progress.slot_id
      join coinops.slot_pool_configuration pool
        on pool.baseline_id=baseline_id and pool.slot_id=s.id
      where progress.cycle_id=cycle_id
        and progress.asset=requested.requested_asset
        and pool.asset=requested.requested_asset
        and s.status<>'aberto'
        and pool.enabled and pool.funded
        and pool.pool='RESERVE' and pool.allow_reserve
        and pool.active_from_cycle<=cycle_number
      order by (s.operational_gains<>0),s.operational_gains,s.operational_slot_value,
        coalesce(progress.last_operated_at,'epoch'::timestamptz),s.slot_number
      limit 1;
    end if;

    if not found then
      return jsonb_build_object(
        'ok',true,'active',true,'allowed',false,
        'asset',requested.requested_asset,'code','NO_ELIGIBLE_SLOT'
      );
    end if;
  end if;

  return jsonb_build_object(
    'ok',true,'active',true,'allowed',expected.id=p_slot_id,
    'asset',requested.requested_asset,'mode',mode_name,
    'expected_slot_id',expected.id,
    'expected_slot_number',expected.slot_number,
    'code',case when expected.id=p_slot_id
      then 'ALLOWED' else 'NOT_NEXT_PRIORITY' end
  );
end
$fn$;

revoke all on function coinops.validate_official_slot_entry(uuid)
  from public,anon,authenticated,service_role;
grant execute on function coinops.validate_official_slot_entry(uuid)
  to authenticated;
