-- Bind the baseline daily snapshot upsert to its explicit unique constraint.
-- This avoids PL/pgSQL variable substitution in the conflict target; no financial rule changes.

create or replace function coinops.activate_official_monitoring_baseline(
  p_idempotency_key uuid,p_btc_price numeric,p_sol_price numeric,p_btc_ath numeric,
  p_expected_state_hash text
)
returns jsonb language plpgsql security definer set search_path=''
as $fn$
#variable_conflict use_variable
declare
  scope_row record;
  existing_baseline coinops.monitoring_baselines%rowtype;
  before_preview jsonb;
  after_preview jsonb;
  before_account jsonb;
  after_account jsonb;
  version_id uuid;
  baseline_id uuid;
  cycle_id uuid;
  activated_at timestamptz:=clock_timestamp();
  timezone_name constant text:='America/Campo_Grande';
  official_date_value date;
  version_number integer;
  slot_snapshot jsonb;
begin
  if p_idempotency_key is null or p_expected_state_hash is null
    or p_expected_state_hash !~ '^[0-9a-f]{64}$'
    or p_btc_price is null or p_sol_price is null or p_btc_ath is null
    or least(p_btc_price,p_sol_price,p_btc_ath)<=0 then
    raise exception 'COINOPS_BASELINE_INPUT_INVALID';
  end if;

  select * into strict scope_row from private.coinops_current_scope();
  perform pg_advisory_xact_lock(hashtextextended(
    scope_row.product_id::text||scope_row.tenant_id::text||scope_row.user_id::text||':official-baseline',0));

  select * into existing_baseline from coinops.monitoring_baselines b
  where b.product_id=scope_row.product_id and b.tenant_id=scope_row.tenant_id
    and b.user_id=scope_row.user_id and b.status='ACTIVE';
  if found then
    if existing_baseline.idempotency_key=p_idempotency_key then
      return jsonb_build_object('ok',true,'already_active',true,'baseline_id',existing_baseline.id,
        'started_at',existing_baseline.started_at,'official_date',existing_baseline.official_date);
    end if;
    raise exception 'COINOPS_OFFICIAL_BASELINE_ALREADY_ACTIVE';
  end if;

  if exists(select 1 from coinops.strategy_versions v where v.product_id=scope_row.product_id
    and v.tenant_id=scope_row.tenant_id and v.user_id=scope_row.user_id and v.status='ACTIVE') then
    raise exception 'COINOPS_ACTIVE_STRATEGY_WITHOUT_BASELINE';
  end if;

  -- Read locks serialize this snapshot against supported financial mutations.
  perform s.id from coinops.slots s where s.product_id=scope_row.product_id
    and s.tenant_id=scope_row.tenant_id and s.user_id=scope_row.user_id order by s.id for share;
  perform st.id from coinops.strategies st where st.product_id=scope_row.product_id
    and st.tenant_id=scope_row.tenant_id and st.user_id=scope_row.user_id order by st.id for share;
  perform c.id from coinops.btc_external_contributions c where c.product_id=scope_row.product_id
    and c.tenant_id=scope_row.tenant_id and c.user_id=scope_row.user_id order by c.id for share;

  before_preview:=private.coinops_build_official_monitoring_state(
    scope_row.product_id,scope_row.tenant_id,scope_row.user_id,p_btc_price,p_sol_price,p_btc_ath);
  if coalesce((before_preview->>'ready')::boolean,false) is not true then
    raise exception 'COINOPS_BASELINE_PREVIEW_NOT_READY: %',before_preview->'errors';
  end if;
  if before_preview->>'state_hash'<>lower(p_expected_state_hash) then
    raise exception 'COINOPS_BASELINE_STATE_CHANGED';
  end if;

  official_date_value:=(activated_at at time zone timezone_name)::date;
  before_account:=before_preview->'account';
  select coalesce(max(v.version),0)+1 into version_number from coinops.strategy_versions v
  where v.product_id=scope_row.product_id and v.tenant_id=scope_row.tenant_id and v.user_id=scope_row.user_id;

  insert into coinops.strategy_versions(
    product_id,tenant_id,user_id,version,status,effective_from,configuration,notes,created_by)
  values(scope_row.product_id,scope_row.tenant_id,scope_row.user_id,version_number,'ACTIVE',activated_at,
    jsonb_build_object(
      'official_date',to_char(official_date_value,'YYYY-MM-DD'),'timezone',timezone_name,
      'modes',jsonb_build_object(
        'NORMAL_GROWTH',jsonb_build_object(
          'BTC',jsonb_build_object('entry_spacing_pct',2,'cycle_target',7),
          'SOL',jsonb_build_object('entry_spacing_pct',3,'cycle_target',2)),
        'DEFENSIVE_POST_ATH',jsonb_build_object(
          'BTC',jsonb_build_object('entry_spacing_pct',5),
          'SOL',jsonb_build_object('entry_spacing_pct',8))),
      'defensive_exit_drawdown_pct',40,'main_slots',25,'reserve_slots',25,
      'legacy_cutoff_at',activated_at),
    'Estratégia oficial pós-baseline; legado preservado sem reprocessamento.',scope_row.user_id)
  returning id into version_id;

  insert into coinops.monitoring_baselines(
    product_id,tenant_id,user_id,strategy_version_id,idempotency_key,official_date,started_at,
    timezone,btc_price,sol_price,official_btc_ath,summary,created_by)
  values(scope_row.product_id,scope_row.tenant_id,scope_row.user_id,version_id,p_idempotency_key,
    official_date_value,activated_at,timezone_name,round(p_btc_price,8),round(p_sol_price,8),
    round(greatest(p_btc_ath,p_btc_price),8),jsonb_build_object(
      'account',before_account,'assets',before_preview->'assets','state_hash',before_preview->>'state_hash',
      'legacy_cutoff_at',activated_at,'legacy_excluded_from_cycles',true),scope_row.user_id)
  returning id into baseline_id;

  insert into coinops.monitoring_baseline_assets(
    baseline_id,product_id,tenant_id,user_id,asset,operational_total,realized_profit,
    open_pnl,slots_existing,slots_enabled,slots_open,slots_free)
  select baseline_id,scope_row.product_id,scope_row.tenant_id,scope_row.user_id,asset_name,
    (before_preview->'assets'->asset_name->>'operational_total')::numeric,
    (before_preview->'assets'->asset_name->>'realized_profit')::numeric,
    (before_preview->'assets'->asset_name->>'open_pnl')::numeric,
    (before_preview->'assets'->asset_name->>'slots')::integer,
    (select count(*)::integer from jsonb_array_elements(before_preview->'slot_snapshots') item(value)
      where item.value->>'asset'=asset_name and (item.value->>'enabled')::boolean),
    (before_preview->'assets'->asset_name->>'open_slots')::integer,
    (before_preview->'assets'->asset_name->>'free_slots')::integer
  from(values('BTC'::text),('SOL'::text)) assets(asset_name);

  for slot_snapshot in select value from jsonb_array_elements(before_preview->'slot_snapshots') item(value)
  loop
    insert into coinops.monitoring_baseline_slots(
      baseline_id,product_id,tenant_id,user_id,slot_id,strategy_id,asset,slot_number,snapshot)
    values(baseline_id,scope_row.product_id,scope_row.tenant_id,scope_row.user_id,
      (slot_snapshot->>'slot_id')::uuid,(slot_snapshot->>'strategy_id')::uuid,
      slot_snapshot->>'asset',(slot_snapshot->>'slot_number')::integer,slot_snapshot);
  end loop;

  insert into coinops.slot_pool_configuration(
    baseline_id,product_id,tenant_id,user_id,asset,slot_number,slot_id,pool,
    enabled,funded,allow_reserve,active_from_cycle)
  select baseline_id,scope_row.product_id,scope_row.tenant_id,scope_row.user_id,
    asset_name,slot_number_value,nullif(existing.slot_id,'')::uuid,
    case when slot_number_value<=25 then 'MAIN' else 'RESERVE' end,
    existing.slot_id is not null and slot_number_value<=25 and existing.operational_value>0,
    existing.slot_id is not null and existing.operational_value>0,false,1
  from(values('BTC'::text),('SOL'::text)) assets(asset_name)
  cross join generate_series(1,50) slot_number_value
  left join lateral(
    select item.value->>'slot_id' slot_id,(item.value->>'operational_value')::numeric operational_value
    from jsonb_array_elements(before_preview->'slot_snapshots') item(value)
    where item.value->>'asset'=asset_name
      and (item.value->>'slot_number')::integer=slot_number_value limit 1
  ) existing on true;

  insert into coinops.operational_cycles(
    baseline_id,strategy_version_id,product_id,tenant_id,user_id,cycle_number,
    mode,status,start_at,end_at,redistribution_status)
  values(baseline_id,version_id,scope_row.product_id,scope_row.tenant_id,scope_row.user_id,
    1,'NORMAL_GROWTH','ACTIVE',activated_at,activated_at+interval '30 days','PENDING')
  returning id into cycle_id;

  insert into coinops.cycle_slot_progress(
    cycle_id,baseline_id,product_id,tenant_id,user_id,slot_id,asset,target,
    lifetime_real_gains_start,lifetime_operational_gains_start,operational_value_start,last_operated_at)
  select cycle_id,baseline_id,scope_row.product_id,scope_row.tenant_id,scope_row.user_id,
    s.id,pool.asset,case when pool.asset='BTC' then 7 else 2 end,
    s.real_gains,s.operational_gains,s.operational_slot_value,coalesce(s.position_opened_at,s.updated_at)
  from coinops.slot_pool_configuration pool join coinops.slots s on s.id=pool.slot_id
  where pool.baseline_id=baseline_id and pool.pool='MAIN' and pool.enabled and pool.funded;

  insert into coinops.strategy_regime_state(
    baseline_id,product_id,tenant_id,user_id,mode,official_ath,current_btc_price,mode_started_at,last_price_at)
  values(baseline_id,scope_row.product_id,scope_row.tenant_id,scope_row.user_id,
    'NORMAL_GROWTH',greatest(p_btc_ath,p_btc_price),p_btc_price,activated_at,activated_at);

  insert into coinops.strategy_regime_events(
    baseline_id,product_id,tenant_id,user_id,event_type,new_mode,btc_price,official_ath,occurred_at,metadata)
  values(baseline_id,scope_row.product_id,scope_row.tenant_id,scope_row.user_id,
    'BASELINE_STARTED','NORMAL_GROWTH',p_btc_price,greatest(p_btc_ath,p_btc_price),activated_at,
    jsonb_build_object('official_date',to_char(official_date_value,'YYYY-MM-DD'),
      'state_hash',before_preview->>'state_hash'));

  insert into coinops.cycle_reports(
    cycle_id,baseline_id,strategy_version_id,product_id,tenant_id,user_id,status,payload)
  values(cycle_id,baseline_id,version_id,scope_row.product_id,scope_row.tenant_id,scope_row.user_id,
    'DRAFT',jsonb_build_object('cycle',1,'mode','NORMAL_GROWTH','legacy_excluded',true));

  insert into coinops.cycle_daily_snapshots(
    cycle_id,baseline_id,product_id,tenant_id,user_id,snapshot_date,timezone,metrics)
  values(cycle_id,baseline_id,scope_row.product_id,scope_row.tenant_id,scope_row.user_id,
    official_date_value,timezone_name,jsonb_build_object(
      'kind','BASELINE','state_hash',before_preview->>'state_hash','mode','NORMAL_GROWTH',
      'account',before_account,'assets',before_preview->'assets','prices',before_account->'prices',
      'btc_drawdown_pct',0,
      'cycle_progress',jsonb_build_object(
        'BTC',jsonb_build_object('progress',0,'target',7,
          'target_total',7*(select count(*) from jsonb_array_elements(before_preview->'slot_snapshots') item(value)
            where item.value->>'asset'='BTC' and (item.value->>'enabled')::boolean),
          'slots',(select count(*) from jsonb_array_elements(before_preview->'slot_snapshots') item(value)
            where item.value->>'asset'='BTC' and (item.value->>'enabled')::boolean),'slots_met',0),
        'SOL',jsonb_build_object('progress',0,'target',2,
          'target_total',2*(select count(*) from jsonb_array_elements(before_preview->'slot_snapshots') item(value)
            where item.value->>'asset'='SOL' and (item.value->>'enabled')::boolean),
          'slots',(select count(*) from jsonb_array_elements(before_preview->'slot_snapshots') item(value)
            where item.value->>'asset'='SOL' and (item.value->>'enabled')::boolean),'slots_met',0)),
      'cycle_targets',jsonb_build_object('BTC',7,'SOL',2),'legacy_excluded',true))
  on conflict on constraint cycle_daily_snapshots_cycle_id_snapshot_date_key do nothing;

  after_preview:=private.coinops_build_official_monitoring_state(
    scope_row.product_id,scope_row.tenant_id,scope_row.user_id,p_btc_price,p_sol_price,p_btc_ath);
  after_account:=after_preview->'account';
  if after_preview->>'state_hash'<>before_preview->>'state_hash'
    or (after_account->>'operational_total')::numeric<>(before_account->>'operational_total')::numeric
    or (after_account->>'patrimony')::numeric<>(before_account->>'patrimony')::numeric then
    raise exception 'COINOPS_BASELINE_POST_SNAPSHOT_RECONCILIATION_FAILED';
  end if;

  return jsonb_build_object(
    'ok',true,'already_active',false,'baseline_id',baseline_id,
    'strategy_version',version_number,'cycle_id',cycle_id,'started_at',activated_at,
    'official_date',to_char(official_date_value,'YYYY-MM-DD'),'timezone',timezone_name,
    'mode','NORMAL_GROWTH','state_hash',before_preview->>'state_hash',
    'reconciliation',jsonb_build_object(
      'state_hash_before',before_preview->>'state_hash','state_hash_after',after_preview->>'state_hash',
      'operational_total_before',before_account->'operational_total',
      'operational_total_after',after_account->'operational_total',
      'patrimony_before',before_account->'patrimony','patrimony_after',after_account->'patrimony',
      'difference',round((after_account->>'patrimony')::numeric-(before_account->>'patrimony')::numeric,8),
      'financial_state_preserved',true));
end
$fn$;
