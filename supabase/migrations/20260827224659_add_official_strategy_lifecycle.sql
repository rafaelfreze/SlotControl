-- Lifecycle processor, entry eligibility and immutable report closure.

create or replace function private.coinops_start_official_cycle(
  p_baseline_id uuid,
  p_mode text,
  p_start_at timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  baseline coinops.monitoring_baselines%rowtype;
  cycle_id uuid;
  next_number integer;
begin
  select * into strict baseline from coinops.monitoring_baselines where id=p_baseline_id and status='ACTIVE';
  select coalesce(max(cycle_number),0)+1 into next_number from coinops.operational_cycles where baseline_id=p_baseline_id;
  insert into coinops.operational_cycles(baseline_id,strategy_version_id,product_id,tenant_id,user_id,cycle_number,mode,status,start_at,end_at,redistribution_status)
  values(baseline.id,baseline.strategy_version_id,baseline.product_id,baseline.tenant_id,baseline.user_id,next_number,p_mode,'ACTIVE',p_start_at,
    case when p_mode='NORMAL_GROWTH' then p_start_at+interval '30 days' else null end,
    case when p_mode='NORMAL_GROWTH' then 'PENDING' else 'NOT_APPLICABLE' end)
  returning id into cycle_id;

  insert into coinops.cycle_slot_progress(cycle_id,baseline_id,product_id,tenant_id,user_id,slot_id,asset,target,lifetime_real_gains_start,lifetime_operational_gains_start,operational_value_start,last_operated_at)
  select cycle_id,baseline.id,baseline.product_id,baseline.tenant_id,baseline.user_id,s.id,p.asset,
    case when p_mode='NORMAL_GROWTH' then case when p.asset='BTC' then 7 else 2 end else 0 end,
    s.real_gains,s.operational_gains,s.operational_slot_value,coalesce(s.position_opened_at,s.updated_at)
  from coinops.slot_pool_configuration p join coinops.slots s on s.id=p.slot_id
  where p.baseline_id=baseline.id and p.enabled and p.funded and p.active_from_cycle<=next_number
    and (p.pool='MAIN' or p.allow_reserve);

  insert into coinops.cycle_reports(cycle_id,baseline_id,strategy_version_id,product_id,tenant_id,user_id,status,payload)
  values(cycle_id,baseline.id,baseline.strategy_version_id,baseline.product_id,baseline.tenant_id,baseline.user_id,'DRAFT',
    jsonb_build_object('cycle',next_number,'mode',p_mode,'legacy_excluded',true));
  return cycle_id;
end
$fn$;

create or replace function private.coinops_close_official_cycle(
  p_cycle_id uuid,
  p_closed_at timestamptz,
  p_reason text,
  p_partial boolean default false
)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  update coinops.operational_cycles set status=case when p_partial then 'PARTIAL' else 'AWAITING_CLOSURE' end,
    end_at=coalesce(end_at,p_closed_at),closed_at=p_closed_at,close_reason=p_reason,updated_at=timezone('utc',now())
  where id=p_cycle_id and status='ACTIVE';
  update coinops.cycle_reports set status='AWAITING_CLOSURE',generated_at=timezone('utc',now()),updated_at=timezone('utc',now())
  where cycle_id=p_cycle_id and status='DRAFT';
end
$fn$;

create or replace function private.coinops_capture_cycle_slot_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  progress coinops.cycle_slot_progress%rowtype;
  event_name text;
  event_time timestamptz := timezone('utc',now());
begin
  if old.status=new.status then return new; end if;
  if old.status<>'aberto' and new.status='aberto' then event_name:='ENTRY';
  elsif old.status='aberto' and new.status<>'aberto' then event_name:='CLOSE';
  else return new;
  end if;
  select p.* into progress from coinops.cycle_slot_progress p join coinops.operational_cycles c on c.id=p.cycle_id
  where p.product_id=new.product_id and p.tenant_id=new.tenant_id and p.user_id=new.user_id and p.slot_id=new.id and c.status='ACTIVE'
  order by c.start_at desc limit 1;
  if not found then return new; end if;
  insert into coinops.cycle_progress_events(cycle_id,progress_id,product_id,tenant_id,user_id,slot_id,event_type,progress_delta,amount_usdt,occurred_at,metadata)
  values(progress.cycle_id,progress.id,new.product_id,new.tenant_id,new.user_id,new.id,event_name,0,0,event_time,
    jsonb_build_object('status_before',old.status,'status_after',new.status,'entry',new.preco_entrada,'target',new.preco_alvo));
  update coinops.cycle_slot_progress set
    entries_count=entries_count+case when event_name='ENTRY' then 1 else 0 end,
    opened_seconds=opened_seconds+case when event_name='CLOSE' then greatest(0,extract(epoch from (event_time-coalesce(old.position_opened_at,old.updated_at)))::bigint) else 0 end,
    last_operated_at=event_time,updated_at=event_time where id=progress.id;
  return new;
end
$fn$;

create trigger coinops_capture_cycle_slot_status_v1
after update of status on coinops.slots
for each row execute function private.coinops_capture_cycle_slot_status();

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
  requested record;
  expected record;
begin
  select * into strict scope_row from private.coinops_current_scope();
  select b.id,r.mode into baseline_id,mode_name from coinops.monitoring_baselines b join coinops.strategy_regime_state r on r.baseline_id=b.id
  where b.product_id=scope_row.product_id and b.tenant_id=scope_row.tenant_id and b.user_id=scope_row.user_id and b.status='ACTIVE';
  if not found then return jsonb_build_object('ok',true,'active',false,'allowed',true); end if;
  select c.id into cycle_id from coinops.operational_cycles c where c.baseline_id=baseline_id and c.status='ACTIVE';
  select p.*,s.status into requested from coinops.slot_pool_configuration p join coinops.slots s on s.id=p.slot_id
  where p.baseline_id=baseline_id and p.slot_id=p_slot_id;
  if not found or not requested.enabled or not requested.funded then return jsonb_build_object('ok',true,'active',true,'allowed',false,'code','SLOT_NOT_ENABLED_OR_FUNDED'); end if;

  if mode_name='NORMAL_GROWTH' then
    select s.id,s.slot_number into expected
    from coinops.cycle_slot_progress c join coinops.slots s on s.id=c.slot_id join coinops.slot_pool_configuration p on p.baseline_id=baseline_id and p.slot_id=s.id
    where c.cycle_id=cycle_id and c.cycle_progress<c.target and s.status<>'aberto' and p.enabled and p.funded and p.pool='MAIN'
    order by c.cycle_progress,s.operational_gains,coalesce(c.last_operated_at,'epoch'::timestamptz),s.slot_number limit 1;
    if not found then return jsonb_build_object('ok',true,'active',true,'allowed',false,'code','ALL_TARGETS_MET'); end if;
  else
    select s.id,s.slot_number into expected
    from coinops.cycle_slot_progress c join coinops.slots s on s.id=c.slot_id join coinops.slot_pool_configuration p on p.baseline_id=baseline_id and p.slot_id=s.id
    where c.cycle_id=cycle_id and s.status<>'aberto' and p.enabled and p.funded and p.pool='MAIN'
    order by (s.operational_gains<>0),s.operational_gains,s.operational_slot_value,coalesce(c.last_operated_at,'epoch'::timestamptz),s.slot_number limit 1;
    if not found then
      select s.id,s.slot_number into expected from coinops.cycle_slot_progress c join coinops.slots s on s.id=c.slot_id join coinops.slot_pool_configuration p on p.baseline_id=baseline_id and p.slot_id=s.id
      where c.cycle_id=cycle_id and s.status<>'aberto' and p.enabled and p.funded and p.pool='RESERVE' and p.allow_reserve
      order by (s.operational_gains<>0),s.operational_gains,s.operational_slot_value,coalesce(c.last_operated_at,'epoch'::timestamptz),s.slot_number limit 1;
    end if;
    if not found then return jsonb_build_object('ok',true,'active',true,'allowed',false,'code','NO_ELIGIBLE_SLOT'); end if;
  end if;
  return jsonb_build_object('ok',true,'active',true,'allowed',expected.id=p_slot_id,'mode',mode_name,'expected_slot_id',expected.id,'expected_slot_number',expected.slot_number,
    'code',case when expected.id=p_slot_id then 'ALLOWED' else 'NOT_NEXT_PRIORITY' end);
end
$fn$;

create or replace function coinops.process_official_monitoring_tick(p_btc_price numeric,p_observed_at timestamptz default timezone('utc',now()))
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  item record;
  current_cycle coinops.operational_cycles%rowtype;
  new_cycle_id uuid;
  event_count integer := 0;
  snapshot_day date;
  main_open integer;
begin
  if p_btc_price is null or p_btc_price<=0 then raise exception 'COINOPS_OFFICIAL_BTC_PRICE_INVALID'; end if;
  for item in
    select b.*,r.mode,r.official_ath,r.defensive_anchor_ath from coinops.monitoring_baselines b join coinops.strategy_regime_state r on r.baseline_id=b.id where b.status='ACTIVE'
  loop
    perform pg_advisory_xact_lock(hashtextextended(item.id::text||':official-tick',0));
    select * into current_cycle from coinops.operational_cycles where baseline_id=item.id and status='ACTIVE';
    if item.mode='NORMAL_GROWTH' and p_btc_price>item.official_ath then
      perform private.coinops_close_official_cycle(current_cycle.id,p_observed_at,'NEW_ATH',true);
      new_cycle_id:=private.coinops_start_official_cycle(item.id,'DEFENSIVE_POST_ATH',p_observed_at);
      update coinops.strategy_regime_state set mode='DEFENSIVE_POST_ATH',official_ath=p_btc_price,defensive_anchor_ath=p_btc_price,current_btc_price=p_btc_price,mode_started_at=p_observed_at,last_price_at=p_observed_at,updated_at=timezone('utc',now()) where baseline_id=item.id;
      insert into coinops.strategy_regime_events(baseline_id,product_id,tenant_id,user_id,event_type,previous_mode,new_mode,btc_price,official_ath,defensive_anchor_ath,occurred_at)
      values(item.id,item.product_id,item.tenant_id,item.user_id,'NEW_ATH','NORMAL_GROWTH','DEFENSIVE_POST_ATH',p_btc_price,p_btc_price,p_btc_price,p_observed_at);
      insert into coinops.monitoring_alerts(baseline_id,product_id,tenant_id,user_id,alert_type,severity,message,dedupe_key,occurred_at)
      values(item.id,item.product_id,item.tenant_id,item.user_id,'NEW_ATH','CRITICAL','Novo ATH: modo defensivo ativado','NEW_ATH:'||p_observed_at::text,p_observed_at) on conflict do nothing;
      event_count:=event_count+1;
    elsif item.mode='DEFENSIVE_POST_ATH' and p_btc_price>coalesce(item.defensive_anchor_ath,item.official_ath) then
      update coinops.strategy_regime_state set official_ath=p_btc_price,defensive_anchor_ath=p_btc_price,current_btc_price=p_btc_price,last_price_at=p_observed_at,updated_at=timezone('utc',now()) where baseline_id=item.id;
      insert into coinops.strategy_regime_events(baseline_id,product_id,tenant_id,user_id,event_type,previous_mode,new_mode,btc_price,official_ath,defensive_anchor_ath,occurred_at)
      values(item.id,item.product_id,item.tenant_id,item.user_id,'DEFENSIVE_PEAK_UPDATED','DEFENSIVE_POST_ATH','DEFENSIVE_POST_ATH',p_btc_price,p_btc_price,p_btc_price,p_observed_at);
      event_count:=event_count+1;
    elsif item.mode='DEFENSIVE_POST_ATH' and p_btc_price<=coalesce(item.defensive_anchor_ath,item.official_ath)*0.60 then
      perform private.coinops_close_official_cycle(current_cycle.id,p_observed_at,'STRONG_BOTTOM_REACHED',false);
      new_cycle_id:=private.coinops_start_official_cycle(item.id,'NORMAL_GROWTH',p_observed_at);
      update coinops.strategy_regime_state set mode='NORMAL_GROWTH',current_btc_price=p_btc_price,defensive_anchor_ath=null,mode_started_at=p_observed_at,last_price_at=p_observed_at,updated_at=timezone('utc',now()) where baseline_id=item.id;
      insert into coinops.strategy_regime_events(baseline_id,product_id,tenant_id,user_id,event_type,previous_mode,new_mode,btc_price,official_ath,occurred_at)
      values(item.id,item.product_id,item.tenant_id,item.user_id,'STRONG_BOTTOM_REACHED','DEFENSIVE_POST_ATH','NORMAL_GROWTH',p_btc_price,item.official_ath,p_observed_at);
      insert into coinops.monitoring_alerts(baseline_id,product_id,tenant_id,user_id,alert_type,severity,message,dedupe_key,occurred_at)
      values(item.id,item.product_id,item.tenant_id,item.user_id,'STRONG_BOTTOM_REACHED','INFO','Fundo Forte: modo normal reativado','STRONG_BOTTOM:'||p_observed_at::text,p_observed_at) on conflict do nothing;
      event_count:=event_count+1;
    elsif item.mode='NORMAL_GROWTH' and current_cycle.end_at is not null and p_observed_at>=current_cycle.end_at then
      perform private.coinops_close_official_cycle(current_cycle.id,current_cycle.end_at,'CYCLE_30_DAYS_COMPLETED',false);
      new_cycle_id:=private.coinops_start_official_cycle(item.id,'NORMAL_GROWTH',current_cycle.end_at);
      insert into coinops.monitoring_alerts(baseline_id,product_id,tenant_id,user_id,alert_type,severity,message,dedupe_key,occurred_at)
      values(item.id,item.product_id,item.tenant_id,item.user_id,'CYCLE_ENDED','ATTENTION','Ciclo encerrado — revisar redistribuição','CYCLE_ENDED:'||current_cycle.id::text,p_observed_at) on conflict do nothing;
      event_count:=event_count+1;
    else
      update coinops.strategy_regime_state set current_btc_price=p_btc_price,last_price_at=p_observed_at,updated_at=timezone('utc',now()) where baseline_id=item.id;
    end if;

    snapshot_day:=(p_observed_at at time zone item.timezone)::date;
    select count(*) into main_open from coinops.slot_pool_configuration p join coinops.slots s on s.id=p.slot_id where p.baseline_id=item.id and p.pool='MAIN' and p.enabled and p.funded and s.status='aberto';
    insert into coinops.cycle_daily_snapshots(cycle_id,baseline_id,product_id,tenant_id,user_id,snapshot_date,timezone,metrics)
    select c.id,item.id,item.product_id,item.tenant_id,item.user_id,snapshot_day,item.timezone,
      jsonb_build_object('btc_price',p_btc_price,'mode',(select mode from coinops.strategy_regime_state where baseline_id=item.id),'operational_total',(select round(coalesce(sum(s.operational_slot_value),0),8) from coinops.slots s where s.product_id=item.product_id and s.tenant_id=item.tenant_id and s.user_id=item.user_id),'open_slots',(select count(*) from coinops.slots s where s.product_id=item.product_id and s.tenant_id=item.tenant_id and s.user_id=item.user_id and s.status='aberto'),'main_open',main_open)
    from coinops.operational_cycles c where c.baseline_id=item.id and c.status='ACTIVE'
    on conflict(cycle_id,snapshot_date) do update set metrics=excluded.metrics;

    if main_open>=20 then
      insert into coinops.monitoring_alerts(baseline_id,product_id,tenant_id,user_id,alert_type,severity,message,dedupe_key,occurred_at,metadata)
      values(item.id,item.product_id,item.tenant_id,item.user_id,case when main_open>=25 then 'MAIN_EXHAUSTED' when main_open>=23 then 'MAIN_CRITICAL' else 'MAIN_ATTENTION' end,
        case when main_open>=23 then 'CRITICAL' else 'ATTENTION' end,main_open||'/25 slots principais usados','MAIN_USAGE:'||snapshot_day::text||':'||main_open,p_observed_at,jsonb_build_object('main_open',main_open)) on conflict do nothing;
    end if;
  end loop;
  return jsonb_build_object('ok',true,'processed_events',event_count,'observed_at',p_observed_at);
end
$fn$;

create or replace function coinops.skip_official_cycle_redistribution(p_cycle_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare scope_row record;begin
  select * into strict scope_row from private.coinops_current_scope();
  update coinops.operational_cycles set redistribution_status='SKIPPED',updated_at=timezone('utc',now())
  where id=p_cycle_id and product_id=scope_row.product_id and tenant_id=scope_row.tenant_id and user_id=scope_row.user_id and status<>'ACTIVE' and redistribution_status='PENDING';
  if not found then raise exception 'COINOPS_CYCLE_NOT_ELIGIBLE_FOR_SKIP';end if;
  return jsonb_build_object('ok',true,'cycle_id',p_cycle_id,'redistribution_status','SKIPPED');
end
$fn$;

create or replace function coinops.finalize_official_cycle_report(p_report_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
#variable_conflict use_variable
declare scope_row record;report coinops.cycle_reports%rowtype;cycle coinops.operational_cycles%rowtype;payload jsonb;begin
  select * into strict scope_row from private.coinops_current_scope();
  select * into report from coinops.cycle_reports where id=p_report_id and product_id=scope_row.product_id and tenant_id=scope_row.tenant_id and user_id=scope_row.user_id for update;
  if not found then raise exception 'COINOPS_REPORT_NOT_FOUND';end if;
  if report.status='FINALIZED' then return jsonb_build_object('ok',true,'already_finalized',true,'report_id',report.id);end if;
  select * into strict cycle from coinops.operational_cycles where id=report.cycle_id;
  if cycle.status='ACTIVE' or cycle.redistribution_status not in('CONFIRMED','SKIPPED','NOT_APPLICABLE') then raise exception 'COINOPS_REPORT_NOT_READY';end if;
  select jsonb_build_object('cycle',cycle.cycle_number,'period',jsonb_build_object('start',cycle.start_at,'end',cycle.end_at),'mode',cycle.mode,'close_reason',cycle.close_reason,'redistribution_status',cycle.redistribution_status,'legacy_excluded',true,
    'assets',coalesce(jsonb_object_agg(asset,asset_payload),'{}'::jsonb)) into payload from(
      select p.asset,jsonb_build_object('slots',count(*),'target',max(p.target),'met',count(*)filter(where p.target=0 or p.cycle_progress>=p.target),'real_gains',sum(p.cycle_real_gains),'redistribution_in',sum(p.cycle_redistribution_in),'redistribution_out',sum(p.cycle_redistribution_out),'external_equivalent',sum(p.cycle_external_gain_equivalent),'entries',sum(p.entries_count),'gains',sum(p.gains_count))asset_payload
      from coinops.cycle_slot_progress p where p.cycle_id=cycle.id group by p.asset
    )asset_rows;
  update coinops.cycle_reports set status='FINALIZED',payload=payload,generated_at=timezone('utc',now()),finalized_at=timezone('utc',now()),finalized_by=scope_row.user_id,updated_at=timezone('utc',now()) where id=report.id;
  update coinops.operational_cycles set status='FINALIZED',updated_at=timezone('utc',now()) where id=cycle.id;
  return jsonb_build_object('ok',true,'already_finalized',false,'report_id',report.id,'payload',payload);
end
$fn$;

create or replace function private.coinops_protect_finalized_report()
returns trigger language plpgsql set search_path='' as $fn$
begin if old.status='FINALIZED' then raise exception 'COINOPS_FINALIZED_REPORT_IMMUTABLE';end if;return new;end
$fn$;
create trigger coinops_protect_finalized_report_v1 before update or delete on coinops.cycle_reports for each row execute function private.coinops_protect_finalized_report();

revoke all on function private.coinops_start_official_cycle(uuid,text,timestamptz) from public,anon,authenticated,service_role;
revoke all on function private.coinops_close_official_cycle(uuid,timestamptz,text,boolean) from public,anon,authenticated,service_role;
revoke all on function private.coinops_capture_cycle_slot_status() from public,anon,authenticated,service_role;
revoke all on function private.coinops_protect_finalized_report() from public,anon,authenticated,service_role;
revoke all on function coinops.validate_official_slot_entry(uuid) from public,anon,authenticated,service_role;
grant execute on function coinops.validate_official_slot_entry(uuid) to authenticated;
revoke all on function coinops.process_official_monitoring_tick(numeric,timestamptz) from public,anon,authenticated,service_role;
grant execute on function coinops.process_official_monitoring_tick(numeric,timestamptz) to service_role;
revoke all on function coinops.skip_official_cycle_redistribution(uuid) from public,anon,authenticated,service_role;
grant execute on function coinops.skip_official_cycle_redistribution(uuid) to authenticated;
revoke all on function coinops.finalize_official_cycle_report(uuid) from public,anon,authenticated,service_role;
grant execute on function coinops.finalize_official_cycle_report(uuid) to authenticated;
