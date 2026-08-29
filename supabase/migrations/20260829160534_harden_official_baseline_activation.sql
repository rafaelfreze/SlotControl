-- Harden the official CoinOps monitoring baseline.
-- Monitoring-only: no slots, positions, gains, contributions, redistribution
-- records or financial ledger rows are updated by this migration.

create or replace function private.coinops_build_official_monitoring_state(
  p_product_id uuid,
  p_tenant_id uuid,
  p_user_id uuid,
  p_btc_price numeric,
  p_sol_price numeric,
  p_btc_ath numeric
)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $fn$
#variable_conflict use_variable
declare
  timezone_name constant text := 'America/Campo_Grande';
  official_date_value date := (clock_timestamp() at time zone timezone_name)::date;
  slot_snapshots jsonb;
  asset_summaries jsonb;
  strategy_state jsonb;
  contribution_state jsonb;
  ledger_state jsonb;
  reconciliation_state jsonb;
  validation_errors jsonb;
  state_payload jsonb;
  state_hash_value text;
  account_summary jsonb;
  slot_count integer := 0;
  open_slot_count integer := 0;
  operational_total_value numeric := 0;
  realized_profit_value numeric := 0;
  open_pnl_value numeric := 0;
  external_contributions_value numeric := 0;
  real_gains_value numeric := 0;
  operational_gains_value numeric := 0;
  added_gains_value numeric := 0;
begin
  if p_product_id is null or p_tenant_id is null or p_user_id is null
    or p_btc_price is null or p_sol_price is null or p_btc_ath is null
    or least(p_btc_price, p_sol_price, p_btc_ath) <= 0 then
    raise exception 'COINOPS_BASELINE_INPUT_INVALID';
  end if;

  select
    coalesce(jsonb_agg(
      source_snapshot || jsonb_build_object(
        'id',id,'slot_id',id,'strategy_id',strategy_id,'asset',asset,
        'slot_number',slot_number,'status',status,
        'operational_gains',operational_gains,'real_gains',real_gains,
        'added_gains',added_gains,'operational_value',operational_value,
        'open_pnl',open_pnl,'external_contributions',external_contributions,
        'entry',entry_price,'target',target_price,'quantity',position_quantity,
        'opened_at',position_opened_at,'rank',rank_value,'enabled',enabled,
        'funded',funded,'pool',pool_name,'has_ledger',has_ledger,
        'has_reconciliation',has_reconciliation,
        'has_opening_balance',has_opening_balance,
        'latest_ledger_value_matches',latest_ledger_value_matches,
        'missing_economic_trace',missing_economic_trace
      ) order by asset,slot_number,id
    ),'[]'::jsonb),
    count(*)::integer,
    count(*) filter(where status='aberto')::integer,
    round(coalesce(sum(operational_value),0),8),
    round(coalesce(sum(realized_profit),0),8),
    round(coalesce(sum(open_pnl),0),8),
    round(coalesce(sum(external_contributions),0),8),
    coalesce(sum(real_gains),0),
    round(coalesce(sum(operational_gains),0),8),
    coalesce(sum(added_gains),0)
  into slot_snapshots,slot_count,open_slot_count,operational_total_value,
    realized_profit_value,open_pnl_value,external_contributions_value,
    real_gains_value,operational_gains_value,added_gains_value
  from (
    select s.id,s.strategy_id,upper(st.asset) as asset,s.slot_number,s.status,
      s.operational_gains,s.real_gains,s.added_gains,
      coalesce(s.operational_slot_value,0) as operational_value,
      s.realized_profit,s.preco_entrada as entry_price,s.preco_alvo as target_price,
      s.position_quantity,s.position_opened_at,s.sort_order as rank_value,
      s.slot_number<=25 and coalesce(s.operational_slot_value,0)>0 as enabled,
      coalesce(s.operational_slot_value,0)>0 as funded,
      case when s.slot_number<=25 then 'MAIN' else 'RESERVE' end as pool_name,
      trace.ledger_count>0 as has_ledger,
      trace.reconciliation_count>0 as has_reconciliation,
      coalesce(s.operational_slot_value,0)>0
        and not (
          trace.reconciliation_count>0
          or (trace.has_opening_balance
            and abs(coalesce(s.operational_slot_value,0)-trace.latest_ledger_value)<=0.00000001)
        ) as missing_economic_trace,
      trace.has_opening_balance,
      trace.has_opening_balance
        and abs(coalesce(s.operational_slot_value,0)-trace.latest_ledger_value)<=0.00000001
        as latest_ledger_value_matches,
      coalesce(contribution.external_contributions,0) as external_contributions,
      case when s.status='aberto' and s.preco_entrada is not null and s.preco_entrada>0 then
        round(coalesce(s.position_notional_usdt,s.operational_slot_value,0)
          *((case when upper(st.asset)='BTC' then p_btc_price else p_sol_price end)/s.preco_entrada-1),8)
      else 0 end as open_pnl,
      to_jsonb(s) as source_snapshot
    from coinops.slots s
    join coinops.strategies st on st.id=s.strategy_id
    left join lateral (
      select round(coalesce(sum(c.accounting_amount_usdt) filter(where c.input_mode='USDT'),0),8) external_contributions
      from coinops.btc_external_contributions c
      where c.product_id=p_product_id and c.tenant_id=p_tenant_id and c.user_id=p_user_id and c.slot_id=s.id
    ) contribution on true
    left join lateral (
      select
        (select count(*) from coinops.slot_capital_ledger l
          where l.product_id=p_product_id and l.tenant_id=p_tenant_id
            and l.user_id=p_user_id and l.slot_id=s.id) ledger_count,
        exists(select 1 from coinops.slot_capital_ledger l
          where l.product_id=p_product_id and l.tenant_id=p_tenant_id
            and l.user_id=p_user_id and l.slot_id=s.id and l.entry_type='OPENING_BALANCE')
          has_opening_balance,
        coalesce((select l.value_after from coinops.slot_capital_ledger l
          where l.product_id=p_product_id and l.tenant_id=p_tenant_id
            and l.user_id=p_user_id and l.slot_id=s.id
          order by l.created_at desc,l.id desc limit 1),0) latest_ledger_value,
        (select count(*) from (
          select r.reconciliation_version,r.classification,r.stored_value,r.recalculated_value
          from coinops.slot_operational_reconciliations r
          where r.product_id=p_product_id and r.tenant_id=p_tenant_id
            and r.user_id=p_user_id and r.slot_id=s.id
          order by r.created_at desc,r.id desc limit 1
        ) latest
        where latest.reconciliation_version='COMPOUND_TOTAL_CAPITAL_V3_FULL_LEDGER'
          and latest.classification in('OK','DIVERGENTE_EXPLICAVEL')
          and abs(coalesce(s.operational_slot_value,0)-latest.stored_value)<=0.00000001
          and abs(coalesce(s.operational_slot_value,0)-latest.recalculated_value)<=0.00000001
        ) reconciliation_count
    ) trace on true
    where s.product_id=p_product_id and s.tenant_id=p_tenant_id and s.user_id=p_user_id
  ) slot_state;

  select jsonb_object_agg(asset_key,summary order by asset_key)
  into asset_summaries
  from (
    select desired.asset asset_key,jsonb_build_object(
      'asset',desired.asset,
      'operational_total',round(coalesce(stats.operational_total,0),8),
      'patrimony',round(coalesce(stats.operational_total,0)+coalesce(stats.open_pnl,0),8),
      'realized_profit',round(coalesce(stats.realized_profit,0),8),
      'open_pnl',round(coalesce(stats.open_pnl,0),8),
      'external_contributions',round(coalesce(stats.external_contributions,0),8),
      'slots',coalesce(stats.slots,0),'open',coalesce(stats.open_slots,0),
      'open_slots',coalesce(stats.open_slots,0),
      'free',coalesce(stats.slots,0)-coalesce(stats.open_slots,0),
      'free_slots',coalesce(stats.slots,0)-coalesce(stats.open_slots,0),
      'real_gains',coalesce(stats.real_gains,0),
      'operational_gains',round(coalesce(stats.operational_gains,0),8),
      'added_gains',coalesce(stats.added_gains,0)
    ) summary
    from (values('BTC'::text),('SOL'::text)) desired(asset)
    left join (
      select state.asset,count(*)::integer slots,
        count(*) filter(where state.status='aberto')::integer open_slots,
        sum(state.operational_value) operational_total,sum(state.realized_profit) realized_profit,
        sum(state.open_pnl) open_pnl,sum(state.external_contributions) external_contributions,
        sum(state.real_gains) real_gains,sum(state.operational_gains) operational_gains,
        sum(state.added_gains) added_gains
      from jsonb_to_recordset(slot_snapshots) as state(
        asset text,status text,operational_value numeric,realized_profit numeric,
        open_pnl numeric,external_contributions numeric,real_gains numeric,
        operational_gains numeric,added_gains numeric
      ) group by state.asset
    ) stats on stats.asset=desired.asset
  ) asset_rows;

  select coalesce(jsonb_agg(to_jsonb(st) order by upper(st.asset),st.id),'[]'::jsonb)
  into strategy_state from coinops.strategies st
  where st.product_id=p_product_id and st.tenant_id=p_tenant_id and st.user_id=p_user_id;

  select coalesce(jsonb_agg(to_jsonb(c) order by c.created_at,c.id),'[]'::jsonb)
  into contribution_state from coinops.btc_external_contributions c
  where c.product_id=p_product_id and c.tenant_id=p_tenant_id and c.user_id=p_user_id;

  select coalesce(jsonb_agg(to_jsonb(l) order by l.created_at,l.id),'[]'::jsonb)
  into ledger_state from coinops.slot_capital_ledger l
  where l.product_id=p_product_id and l.tenant_id=p_tenant_id and l.user_id=p_user_id;

  select coalesce(jsonb_agg(to_jsonb(r) order by r.created_at,r.id),'[]'::jsonb)
  into reconciliation_state from coinops.slot_operational_reconciliations r
  where r.product_id=p_product_id and r.tenant_id=p_tenant_id and r.user_id=p_user_id;

  select coalesce(jsonb_agg(error_code order by error_code),'[]'::jsonb)
  into validation_errors from (
    select 'NO_SLOTS'::text error_code where slot_count=0
    union all select 'BTC_STRATEGY_COUNT_INVALID' where (
      select count(*) from coinops.strategies st where st.product_id=p_product_id
        and st.tenant_id=p_tenant_id and st.user_id=p_user_id and upper(st.asset)='BTC')<>1
    union all select 'SOL_STRATEGY_COUNT_INVALID' where (
      select count(*) from coinops.strategies st where st.product_id=p_product_id
        and st.tenant_id=p_tenant_id and st.user_id=p_user_id and upper(st.asset)='SOL')<>1
    union all select 'UNSUPPORTED_SLOT_ASSET' where exists(
      select 1 from coinops.slots s join coinops.strategies st on st.id=s.strategy_id
      where s.product_id=p_product_id and s.tenant_id=p_tenant_id and s.user_id=p_user_id
        and upper(st.asset) not in('BTC','SOL'))
    union all select 'INVALID_OPERATIONAL_VALUE' where exists(
      select 1 from coinops.slots s where s.product_id=p_product_id and s.tenant_id=p_tenant_id
        and s.user_id=p_user_id and (s.operational_slot_value is null or s.operational_slot_value<0))
    union all select 'OPEN_SLOT_WITHOUT_VALID_ENTRY' where exists(
      select 1 from coinops.slots s where s.product_id=p_product_id and s.tenant_id=p_tenant_id
        and s.user_id=p_user_id and s.status='aberto' and (s.preco_entrada is null or s.preco_entrada<=0))
    union all select 'OPEN_SLOT_WITHOUT_CAPITAL' where exists(
      select 1 from coinops.slots s where s.product_id=p_product_id and s.tenant_id=p_tenant_id
        and s.user_id=p_user_id and s.status='aberto'
        and coalesce(s.position_notional_usdt,s.operational_slot_value,0)<=0)
    union all select 'FUNDED_SLOT_WITHOUT_ECONOMIC_TRACE' where exists(
      select 1 from jsonb_to_recordset(slot_snapshots)
        as trace(funded boolean,missing_economic_trace boolean)
      where trace.funded and trace.missing_economic_trace)
    union all select 'INVALID_SLOT_NUMBER' where exists(
      select 1 from coinops.slots s where s.product_id=p_product_id and s.tenant_id=p_tenant_id
        and s.user_id=p_user_id and s.slot_number not between 1 and 50)
    union all select 'DUPLICATE_ASSET_SLOT_NUMBER' where exists(
      select 1 from coinops.slots s join coinops.strategies st on st.id=s.strategy_id
      where s.product_id=p_product_id and s.tenant_id=p_tenant_id and s.user_id=p_user_id
      group by upper(st.asset),s.slot_number having count(*)>1)
  ) errors;

  account_summary:=jsonb_build_object(
    'operational_total',round(operational_total_value,8),
    'patrimony',round(operational_total_value+open_pnl_value,8),
    'realized_profit',round(realized_profit_value,8),'open_pnl',round(open_pnl_value,8),
    'external_contributions',round(external_contributions_value,8),
    'slots',slot_count,'open_slots',open_slot_count,'free_slots',slot_count-open_slot_count,
    'real_gains',real_gains_value,'operational_gains',round(operational_gains_value,8),
    'added_gains',added_gains_value,
    'missing_economic_trace_slots',(select count(*) from jsonb_to_recordset(slot_snapshots)
      as trace(funded boolean,missing_economic_trace boolean)
      where trace.funded and trace.missing_economic_trace),
    'prices',jsonb_build_object('BTC',round(p_btc_price,8),'SOL',round(p_sol_price,8)),
    'official_btc_ath',round(greatest(p_btc_ath,p_btc_price),8),'mode','NORMAL_GROWTH');

  state_payload:=jsonb_build_object(
    'scope',jsonb_build_object('product_id',p_product_id,'tenant_id',p_tenant_id,'user_id',p_user_id),
    'prices',jsonb_build_object('BTC',round(p_btc_price,8),'SOL',round(p_sol_price,8)),
    'official_btc_ath',round(greatest(p_btc_ath,p_btc_price),8),
    'slots',slot_snapshots,'strategies',strategy_state,
    'external_contributions',contribution_state,'capital_ledger',ledger_state,
    'operational_reconciliations',reconciliation_state);
  state_hash_value:=encode(
    extensions.digest(pg_catalog.convert_to(state_payload::text,'UTF8'),'sha256'),'hex');

  return jsonb_build_object(
    'ok',true,'ready',jsonb_array_length(validation_errors)=0,'errors',validation_errors,
    'already_active',exists(select 1 from coinops.monitoring_baselines b
      where b.product_id=p_product_id and b.tenant_id=p_tenant_id and b.user_id=p_user_id and b.status='ACTIVE'),
    'official_date',to_char(official_date_value,'YYYY-MM-DD'),'timezone',timezone_name,
    'slots',slot_count,'open_slots',open_slot_count,
    'operational_total',round(operational_total_value,8),
    'realized_profit_legacy',round(realized_profit_value,8),
    'external_contributions_legacy',round(external_contributions_value,8),
    'account',account_summary,'assets',asset_summaries,
    'slot_details',slot_snapshots,'slot_snapshots',slot_snapshots,'state_hash',state_hash_value);
end
$fn$;

-- New callers provide BTC and SOL. The legacy wrapper keeps the old contract.
create or replace function coinops.process_official_monitoring_tick(
  p_btc_price numeric,p_sol_price numeric,p_observed_at timestamptz default clock_timestamp()
)
returns jsonb language plpgsql security definer set search_path=''
as $fn$
declare
  item record;
  current_cycle coinops.operational_cycles%rowtype;
  new_cycle_id uuid;
  event_count integer:=0;
  snapshot_day date;
  effective_sol_price numeric;
  snapshot_state jsonb;
  occupancy record;
begin
  if p_btc_price is null or p_btc_price<=0 or p_observed_at is null
    or (p_sol_price is not null and p_sol_price<=0) then
    raise exception 'COINOPS_OFFICIAL_MARKET_PRICE_INVALID';
  end if;

  for item in select b.*,r.mode,r.official_ath,r.defensive_anchor_ath
    from coinops.monitoring_baselines b join coinops.strategy_regime_state r on r.baseline_id=b.id
    where b.status='ACTIVE'
  loop
    perform pg_advisory_xact_lock(hashtextextended(item.id::text||':official-tick',0));
    select * into strict current_cycle from coinops.operational_cycles
    where baseline_id=item.id and status='ACTIVE';

    if item.mode='NORMAL_GROWTH' and p_btc_price>item.official_ath then
      perform private.coinops_close_official_cycle(current_cycle.id,p_observed_at,'NEW_ATH',true);
      new_cycle_id:=private.coinops_start_official_cycle(item.id,'DEFENSIVE_POST_ATH',p_observed_at);
      update coinops.strategy_regime_state set mode='DEFENSIVE_POST_ATH',official_ath=p_btc_price,
        defensive_anchor_ath=p_btc_price,current_btc_price=p_btc_price,mode_started_at=p_observed_at,
        last_price_at=p_observed_at,updated_at=clock_timestamp() where baseline_id=item.id;
      insert into coinops.strategy_regime_events(
        baseline_id,product_id,tenant_id,user_id,event_type,previous_mode,new_mode,
        btc_price,official_ath,defensive_anchor_ath,occurred_at)
      values(item.id,item.product_id,item.tenant_id,item.user_id,'NEW_ATH','NORMAL_GROWTH',
        'DEFENSIVE_POST_ATH',p_btc_price,p_btc_price,p_btc_price,p_observed_at);
      insert into coinops.monitoring_alerts(
        baseline_id,product_id,tenant_id,user_id,alert_type,severity,message,dedupe_key,occurred_at)
      values(item.id,item.product_id,item.tenant_id,item.user_id,'NEW_ATH','CRITICAL',
        'Novo ATH: modo defensivo ativado','NEW_ATH:'||p_observed_at::text,p_observed_at)
      on conflict do nothing;
      event_count:=event_count+1;
    elsif item.mode='DEFENSIVE_POST_ATH'
      and p_btc_price>coalesce(item.defensive_anchor_ath,item.official_ath) then
      update coinops.strategy_regime_state set official_ath=p_btc_price,
        defensive_anchor_ath=p_btc_price,current_btc_price=p_btc_price,
        last_price_at=p_observed_at,updated_at=clock_timestamp() where baseline_id=item.id;
      insert into coinops.strategy_regime_events(
        baseline_id,product_id,tenant_id,user_id,event_type,previous_mode,new_mode,
        btc_price,official_ath,defensive_anchor_ath,occurred_at)
      values(item.id,item.product_id,item.tenant_id,item.user_id,'DEFENSIVE_PEAK_UPDATED',
        'DEFENSIVE_POST_ATH','DEFENSIVE_POST_ATH',p_btc_price,p_btc_price,p_btc_price,p_observed_at);
      event_count:=event_count+1;
    elsif item.mode='DEFENSIVE_POST_ATH'
      and p_btc_price<=coalesce(item.defensive_anchor_ath,item.official_ath)*0.60 then
      perform private.coinops_close_official_cycle(current_cycle.id,p_observed_at,'STRONG_BOTTOM_REACHED',false);
      new_cycle_id:=private.coinops_start_official_cycle(item.id,'NORMAL_GROWTH',p_observed_at);
      update coinops.strategy_regime_state set mode='NORMAL_GROWTH',current_btc_price=p_btc_price,
        defensive_anchor_ath=null,mode_started_at=p_observed_at,last_price_at=p_observed_at,
        updated_at=clock_timestamp() where baseline_id=item.id;
      insert into coinops.strategy_regime_events(
        baseline_id,product_id,tenant_id,user_id,event_type,previous_mode,new_mode,
        btc_price,official_ath,occurred_at)
      values(item.id,item.product_id,item.tenant_id,item.user_id,'STRONG_BOTTOM_REACHED',
        'DEFENSIVE_POST_ATH','NORMAL_GROWTH',p_btc_price,item.official_ath,p_observed_at);
      insert into coinops.monitoring_alerts(
        baseline_id,product_id,tenant_id,user_id,alert_type,severity,message,dedupe_key,occurred_at)
      values(item.id,item.product_id,item.tenant_id,item.user_id,'STRONG_BOTTOM_REACHED','INFO',
        'Fundo Forte: modo normal reativado','STRONG_BOTTOM:'||p_observed_at::text,p_observed_at)
      on conflict do nothing;
      event_count:=event_count+1;
    elsif item.mode='NORMAL_GROWTH' and current_cycle.end_at is not null
      and p_observed_at>=current_cycle.end_at then
      perform private.coinops_close_official_cycle(
        current_cycle.id,current_cycle.end_at,'CYCLE_30_DAYS_COMPLETED',false);
      new_cycle_id:=private.coinops_start_official_cycle(item.id,'NORMAL_GROWTH',current_cycle.end_at);
      insert into coinops.monitoring_alerts(
        baseline_id,product_id,tenant_id,user_id,alert_type,severity,message,dedupe_key,occurred_at)
      values(item.id,item.product_id,item.tenant_id,item.user_id,'CYCLE_ENDED','ATTENTION',
        'Ciclo encerrado - revisar redistribuição','CYCLE_ENDED:'||current_cycle.id::text,p_observed_at)
      on conflict do nothing;
      event_count:=event_count+1;
    else
      update coinops.strategy_regime_state set current_btc_price=p_btc_price,
        last_price_at=p_observed_at,updated_at=clock_timestamp() where baseline_id=item.id;
    end if;

    effective_sol_price:=coalesce(p_sol_price,item.sol_price);
    snapshot_day:=(p_observed_at at time zone item.timezone)::date;
    snapshot_state:=private.coinops_build_official_monitoring_state(
      item.product_id,item.tenant_id,item.user_id,p_btc_price,effective_sol_price,
      greatest(item.official_ath,p_btc_price));

    -- Economic snapshots are immutable and limited to one row per cycle/day.
    insert into coinops.cycle_daily_snapshots(
      cycle_id,baseline_id,product_id,tenant_id,user_id,snapshot_date,timezone,metrics)
    select active_cycle.id,item.id,item.product_id,item.tenant_id,item.user_id,
      snapshot_day,item.timezone,jsonb_build_object(
        'kind','DAILY','state_hash',snapshot_state->>'state_hash',
        'mode',(select mode from coinops.strategy_regime_state where baseline_id=item.id),
        'account',(snapshot_state->'account')||jsonb_build_object(
          'mode',(select mode from coinops.strategy_regime_state where baseline_id=item.id)),
        'assets',snapshot_state->'assets',
        'prices',snapshot_state->'account'->'prices',
        'btc_drawdown_pct',round((p_btc_price/greatest(item.official_ath,p_btc_price)-1)*100,8),
        'cycle_progress',(select coalesce(jsonb_object_agg(asset,summary order by asset),'{}'::jsonb)
          from(select progress.asset,jsonb_build_object(
            'progress',round(coalesce(sum(progress.cycle_progress),0),8),
            'target',round(coalesce(max(progress.target),0),8),
            'target_total',round(coalesce(sum(progress.target),0),8),
            'slots',count(*),'slots_met',count(*) filter(
              where progress.target=0 or progress.cycle_progress>=progress.target)
          ) summary
          from coinops.cycle_slot_progress progress
          where progress.cycle_id=active_cycle.id group by progress.asset) cycle_assets),
        'sol_price_source',case when p_sol_price is null then 'BASELINE_FALLBACK' else 'LIVE' end,
        'legacy_excluded',true)
    from coinops.operational_cycles active_cycle
    where active_cycle.baseline_id=item.id and active_cycle.status='ACTIVE'
    on conflict(cycle_id,snapshot_date) do nothing;

    for occupancy in
      select pool.asset,count(*)::integer main_open
      from coinops.slot_pool_configuration pool join coinops.slots s on s.id=pool.slot_id
      where pool.baseline_id=item.id and pool.pool='MAIN' and pool.enabled and pool.funded
        and s.status='aberto'
      group by pool.asset having count(*)>=20
    loop
      insert into coinops.monitoring_alerts(
        baseline_id,product_id,tenant_id,user_id,alert_type,severity,message,
        dedupe_key,occurred_at,metadata)
      values(item.id,item.product_id,item.tenant_id,item.user_id,
        case when occupancy.main_open>=25 then 'MAIN_EXHAUSTED'
          when occupancy.main_open>=23 then 'MAIN_CRITICAL' else 'MAIN_ATTENTION' end,
        case when occupancy.main_open>=23 then 'CRITICAL' else 'ATTENTION' end,
        occupancy.asset||': '||occupancy.main_open||'/25 slots principais usados',
        'MAIN_USAGE:'||snapshot_day::text||':'||occupancy.asset||':'||
          case when occupancy.main_open>=25 then '25' when occupancy.main_open>=23 then '23' else '20' end,
        p_observed_at,jsonb_build_object('asset',occupancy.asset,'main_open',occupancy.main_open))
      on conflict do nothing;
    end loop;
  end loop;
  return jsonb_build_object('ok',true,'processed_events',event_count,'observed_at',p_observed_at);
end
$fn$;

create or replace function coinops.process_official_monitoring_tick(
  p_btc_price numeric,p_observed_at timestamptz default clock_timestamp()
)
returns jsonb language plpgsql security definer set search_path=''
as $fn$
begin
  return coinops.process_official_monitoring_tick(p_btc_price,null::numeric,p_observed_at);
end
$fn$;

-- Priority is evaluated independently for the requested asset.
create or replace function coinops.validate_official_slot_entry(p_slot_id uuid)
returns jsonb language plpgsql security definer stable set search_path=''
as $fn$
#variable_conflict use_variable
declare
  scope_row record;
  baseline_id uuid;
  mode_name text;
  cycle_id uuid;
  requested record;
  expected record;
begin
  select * into strict scope_row from private.coinops_current_scope();
  select b.id,r.mode into baseline_id,mode_name
  from coinops.monitoring_baselines b join coinops.strategy_regime_state r on r.baseline_id=b.id
  where b.product_id=scope_row.product_id and b.tenant_id=scope_row.tenant_id
    and b.user_id=scope_row.user_id and b.status='ACTIVE';
  if not found then return jsonb_build_object('ok',true,'active',false,'allowed',true);end if;

  select c.id into cycle_id from coinops.operational_cycles c
  where c.baseline_id=baseline_id and c.status='ACTIVE';
  if not found then return jsonb_build_object('ok',true,'active',true,'allowed',false,'code','NO_ACTIVE_CYCLE');end if;

  select p.*,s.status,p.asset requested_asset into requested
  from coinops.slot_pool_configuration p join coinops.slots s on s.id=p.slot_id
  where p.baseline_id=baseline_id and p.slot_id=p_slot_id;
  if not found or not requested.enabled or not requested.funded then
    return jsonb_build_object('ok',true,'active',true,'allowed',false,
      'code','SLOT_NOT_ENABLED_OR_FUNDED');
  end if;

  if mode_name='NORMAL_GROWTH' then
    select s.id,s.slot_number into expected
    from coinops.cycle_slot_progress progress
    join coinops.slots s on s.id=progress.slot_id
    join coinops.slot_pool_configuration pool on pool.baseline_id=baseline_id and pool.slot_id=s.id
    where progress.cycle_id=cycle_id and progress.asset=requested.requested_asset
      and pool.asset=requested.requested_asset and progress.cycle_progress<progress.target
      and s.status<>'aberto' and pool.enabled and pool.funded and pool.pool='MAIN'
    order by progress.cycle_progress,s.operational_gains,
      coalesce(progress.last_operated_at,'epoch'::timestamptz),s.slot_number limit 1;
    if not found then return jsonb_build_object('ok',true,'active',true,'allowed',false,
      'asset',requested.requested_asset,'code','ALL_TARGETS_MET');end if;
  else
    select s.id,s.slot_number into expected
    from coinops.cycle_slot_progress progress
    join coinops.slots s on s.id=progress.slot_id
    join coinops.slot_pool_configuration pool on pool.baseline_id=baseline_id and pool.slot_id=s.id
    where progress.cycle_id=cycle_id and progress.asset=requested.requested_asset
      and pool.asset=requested.requested_asset and s.status<>'aberto'
      and pool.enabled and pool.funded and pool.pool='MAIN'
    order by (s.operational_gains<>0),s.operational_gains,s.operational_slot_value,
      coalesce(progress.last_operated_at,'epoch'::timestamptz),s.slot_number limit 1;
    if not found then
      select s.id,s.slot_number into expected
      from coinops.cycle_slot_progress progress
      join coinops.slots s on s.id=progress.slot_id
      join coinops.slot_pool_configuration pool on pool.baseline_id=baseline_id and pool.slot_id=s.id
      where progress.cycle_id=cycle_id and progress.asset=requested.requested_asset
        and pool.asset=requested.requested_asset and s.status<>'aberto'
        and pool.enabled and pool.funded and pool.pool='RESERVE' and pool.allow_reserve
      order by (s.operational_gains<>0),s.operational_gains,s.operational_slot_value,
        coalesce(progress.last_operated_at,'epoch'::timestamptz),s.slot_number limit 1;
    end if;
    if not found then return jsonb_build_object('ok',true,'active',true,'allowed',false,
      'asset',requested.requested_asset,'code','NO_ELIGIBLE_SLOT');end if;
  end if;

  return jsonb_build_object('ok',true,'active',true,'allowed',expected.id=p_slot_id,
    'asset',requested.requested_asset,'mode',mode_name,'expected_slot_id',expected.id,
    'expected_slot_number',expected.slot_number,
    'code',case when expected.id=p_slot_id then 'ALLOWED' else 'NOT_NEXT_PRIORITY' end);
end
$fn$;

create or replace function coinops.activate_official_monitoring_baseline(
  p_idempotency_key uuid,p_btc_price numeric,p_sol_price numeric,p_btc_ath numeric,
  p_expected_state_hash text
)
returns jsonb language plpgsql security definer set search_path=''
as $fn$
#variable_conflict use_variable
declare
  scope_row record;
  existing coinops.monitoring_baselines%rowtype;
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

  select * into existing from coinops.monitoring_baselines b
  where b.product_id=scope_row.product_id and b.tenant_id=scope_row.tenant_id
    and b.user_id=scope_row.user_id and b.status='ACTIVE';
  if found then
    if existing.idempotency_key=p_idempotency_key then
      return jsonb_build_object('ok',true,'already_active',true,'baseline_id',existing.id,
        'started_at',existing.started_at,'official_date',existing.official_date);
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
  on conflict(cycle_id,snapshot_date) do nothing;

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

create or replace function coinops.activate_official_monitoring_baseline(
  p_idempotency_key uuid,p_btc_price numeric,p_sol_price numeric,p_btc_ath numeric
)
returns jsonb language plpgsql security definer set search_path=''
as $fn$
declare scope_row record;preview jsonb;
begin
  select * into strict scope_row from private.coinops_current_scope();
  preview:=private.coinops_build_official_monitoring_state(
    scope_row.product_id,scope_row.tenant_id,scope_row.user_id,p_btc_price,p_sol_price,p_btc_ath);
  return coinops.activate_official_monitoring_baseline(
    p_idempotency_key,p_btc_price,p_sol_price,p_btc_ath,preview->>'state_hash');
end
$fn$;

-- A partial cycle ends at the actual regime transition, never at its former boundary.
create or replace function private.coinops_close_official_cycle(
  p_cycle_id uuid,p_closed_at timestamptz,p_reason text,p_partial boolean default false
)
returns void language plpgsql security definer set search_path=''
as $fn$
begin
  update coinops.operational_cycles set
    status=case when p_partial then 'PARTIAL' else 'AWAITING_CLOSURE' end,
    end_at=p_closed_at,closed_at=p_closed_at,close_reason=p_reason,updated_at=clock_timestamp()
  where id=p_cycle_id and status='ACTIVE';
  update coinops.cycle_reports set status='AWAITING_CLOSURE',generated_at=clock_timestamp(),
    updated_at=clock_timestamp() where cycle_id=p_cycle_id and status='DRAFT';
end
$fn$;

revoke all on function private.coinops_build_official_monitoring_state(uuid,uuid,uuid,numeric,numeric,numeric)
  from public,anon,authenticated,service_role;

create or replace function coinops.preview_official_monitoring_baseline_details(
  p_btc_price numeric,p_sol_price numeric,p_btc_ath numeric
)
returns jsonb language plpgsql security definer stable set search_path=''
as $fn$
declare scope_row record;
begin
  select * into strict scope_row from private.coinops_current_scope();
  return private.coinops_build_official_monitoring_state(
    scope_row.product_id,scope_row.tenant_id,scope_row.user_id,p_btc_price,p_sol_price,p_btc_ath);
end
$fn$;

create or replace function coinops.preview_official_monitoring_baseline()
returns jsonb language plpgsql security definer stable set search_path=''
as $fn$
declare scope_row record;timezone_name constant text:='America/Campo_Grande';
begin
  select * into strict scope_row from private.coinops_current_scope();
  return jsonb_build_object(
    'ok',true,'already_active',exists(select 1 from coinops.monitoring_baselines b
      where b.product_id=scope_row.product_id and b.tenant_id=scope_row.tenant_id
        and b.user_id=scope_row.user_id and b.status='ACTIVE'),
    'official_date',to_char((clock_timestamp() at time zone timezone_name)::date,'YYYY-MM-DD'),
    'timezone',timezone_name,
    'slots',(select count(*) from coinops.slots s where s.product_id=scope_row.product_id
      and s.tenant_id=scope_row.tenant_id and s.user_id=scope_row.user_id),
    'open_slots',(select count(*) from coinops.slots s where s.product_id=scope_row.product_id
      and s.tenant_id=scope_row.tenant_id and s.user_id=scope_row.user_id and s.status='aberto'),
    'operational_total',(select round(coalesce(sum(s.operational_slot_value),0),8) from coinops.slots s
      where s.product_id=scope_row.product_id and s.tenant_id=scope_row.tenant_id and s.user_id=scope_row.user_id),
    'realized_profit_legacy',(select round(coalesce(sum(s.realized_profit),0),8) from coinops.slots s
      where s.product_id=scope_row.product_id and s.tenant_id=scope_row.tenant_id and s.user_id=scope_row.user_id),
    'external_contributions_legacy',(select round(coalesce(sum(c.accounting_amount_usdt)
      filter(where c.input_mode='USDT'),0),8) from coinops.btc_external_contributions c
      where c.product_id=scope_row.product_id and c.tenant_id=scope_row.tenant_id and c.user_id=scope_row.user_id));
end
$fn$;

revoke all on function coinops.preview_official_monitoring_baseline_details(numeric,numeric,numeric)
  from public,anon,authenticated,service_role;
grant execute on function coinops.preview_official_monitoring_baseline_details(numeric,numeric,numeric)
  to authenticated;

revoke all on function coinops.preview_official_monitoring_baseline()
  from public,anon,authenticated,service_role;
grant execute on function coinops.preview_official_monitoring_baseline() to authenticated;

revoke all on function coinops.activate_official_monitoring_baseline(uuid,numeric,numeric,numeric,text)
  from public,anon,authenticated,service_role;
grant execute on function coinops.activate_official_monitoring_baseline(uuid,numeric,numeric,numeric,text)
  to authenticated;

revoke all on function coinops.activate_official_monitoring_baseline(uuid,numeric,numeric,numeric)
  from public,anon,authenticated,service_role;

revoke all on function private.coinops_close_official_cycle(uuid,timestamptz,text,boolean)
  from public,anon,authenticated,service_role;

revoke all on function coinops.validate_official_slot_entry(uuid)
  from public,anon,authenticated,service_role;
grant execute on function coinops.validate_official_slot_entry(uuid) to authenticated;

revoke all on function coinops.process_official_monitoring_tick(numeric,numeric,timestamptz)
  from public,anon,authenticated,service_role;
grant execute on function coinops.process_official_monitoring_tick(numeric,numeric,timestamptz)
  to service_role;

revoke all on function coinops.process_official_monitoring_tick(numeric,timestamptz)
  from public,anon,authenticated,service_role;
grant execute on function coinops.process_official_monitoring_tick(numeric,timestamptz)
  to service_role;
