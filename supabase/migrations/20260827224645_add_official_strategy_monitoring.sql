-- Official post-baseline monitoring for CoinOps.
-- Additive only: no legacy events, slot balances or financial ledgers are rewritten.

create table coinops.strategy_versions (
  id uuid primary key default gen_random_uuid(),
  product_code text not null default 'coinops' check (product_code = 'coinops'),
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  version integer not null check (version > 0),
  status text not null check (status in ('ACTIVE','SUPERSEDED')),
  effective_from timestamptz not null,
  effective_to timestamptz,
  configuration jsonb not null check (jsonb_typeof(configuration) = 'object'),
  notes text not null default '',
  created_by uuid not null,
  created_at timestamptz not null default timezone('utc', now()),
  unique (product_id, tenant_id, user_id, version),
  check (effective_to is null or effective_to > effective_from)
);

create unique index strategy_versions_one_active_idx
  on coinops.strategy_versions(product_id, tenant_id, user_id)
  where status = 'ACTIVE';

create table coinops.monitoring_baselines (
  id uuid primary key default gen_random_uuid(),
  product_code text not null default 'coinops' check (product_code = 'coinops'),
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  strategy_version_id uuid not null references coinops.strategy_versions(id) on delete restrict,
  idempotency_key uuid not null,
  official_date date not null default date '2026-08-27',
  started_at timestamptz not null,
  timezone text not null default 'America/Campo_Grande',
  status text not null default 'ACTIVE' check (status in ('ACTIVE','ARCHIVED')),
  btc_price numeric(24,8) not null check (btc_price > 0),
  sol_price numeric(24,8) not null check (sol_price > 0),
  official_btc_ath numeric(24,8) not null check (official_btc_ath > 0),
  summary jsonb not null default '{}'::jsonb,
  created_by uuid not null,
  created_at timestamptz not null default timezone('utc', now()),
  unique (product_id, tenant_id, user_id, idempotency_key)
);

create unique index monitoring_baselines_one_active_idx
  on coinops.monitoring_baselines(product_id, tenant_id, user_id)
  where status = 'ACTIVE';

create table coinops.monitoring_baseline_assets (
  id uuid primary key default gen_random_uuid(),
  baseline_id uuid not null references coinops.monitoring_baselines(id) on delete restrict,
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  asset text not null check (asset in ('BTC','SOL')),
  operational_total numeric(24,8) not null,
  realized_profit numeric(24,8) not null,
  open_pnl numeric(24,8) not null default 0,
  slots_existing integer not null,
  slots_enabled integer not null,
  slots_open integer not null,
  slots_free integer not null,
  created_at timestamptz not null default timezone('utc', now()),
  unique (baseline_id, asset)
);

create table coinops.monitoring_baseline_slots (
  id uuid primary key default gen_random_uuid(),
  baseline_id uuid not null references coinops.monitoring_baselines(id) on delete restrict,
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  slot_id uuid not null references coinops.slots(id) on delete restrict,
  strategy_id uuid not null,
  asset text not null check (asset in ('BTC','SOL')),
  slot_number integer not null check (slot_number between 1 and 50),
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  created_at timestamptz not null default timezone('utc', now()),
  unique (baseline_id, slot_id)
);

create table coinops.operational_cycles (
  id uuid primary key default gen_random_uuid(),
  baseline_id uuid not null references coinops.monitoring_baselines(id) on delete restrict,
  strategy_version_id uuid not null references coinops.strategy_versions(id) on delete restrict,
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  cycle_number integer not null check (cycle_number > 0),
  mode text not null check (mode in ('NORMAL_GROWTH','DEFENSIVE_POST_ATH')),
  status text not null check (status in ('ACTIVE','PARTIAL','AWAITING_CLOSURE','FINALIZED')),
  start_at timestamptz not null,
  end_at timestamptz,
  closed_at timestamptz,
  close_reason text,
  redistribution_status text not null default 'PENDING' check (redistribution_status in ('PENDING','CONFIRMED','SKIPPED','NOT_APPLICABLE')),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (baseline_id, cycle_number),
  check (end_at is null or end_at > start_at)
);

create unique index operational_cycles_one_active_idx
  on coinops.operational_cycles(baseline_id)
  where status = 'ACTIVE';

create table coinops.slot_pool_configuration (
  id uuid primary key default gen_random_uuid(),
  baseline_id uuid not null references coinops.monitoring_baselines(id) on delete restrict,
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  asset text not null check (asset in ('BTC','SOL')),
  slot_number integer not null check (slot_number between 1 and 50),
  slot_id uuid references coinops.slots(id) on delete restrict,
  pool text not null check (pool in ('MAIN','RESERVE')),
  enabled boolean not null default false,
  funded boolean not null default false,
  allow_reserve boolean not null default false,
  active_from_cycle integer not null default 1 check (active_from_cycle > 0),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (baseline_id, asset, slot_number),
  unique (baseline_id, slot_id)
);

create table coinops.cycle_slot_progress (
  id uuid primary key default gen_random_uuid(),
  cycle_id uuid not null references coinops.operational_cycles(id) on delete restrict,
  baseline_id uuid not null references coinops.monitoring_baselines(id) on delete restrict,
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  slot_id uuid not null references coinops.slots(id) on delete restrict,
  asset text not null check (asset in ('BTC','SOL')),
  target numeric(20,8) not null check (target >= 0),
  lifetime_real_gains_start integer not null,
  lifetime_operational_gains_start numeric(20,8) not null,
  operational_value_start numeric(24,8) not null,
  cycle_real_gains numeric(20,8) not null default 0,
  cycle_redistribution_in numeric(20,8) not null default 0,
  cycle_redistribution_out numeric(20,8) not null default 0,
  cycle_external_gain_equivalent numeric(20,8) not null default 0,
  cycle_progress numeric(20,8) generated always as
    (cycle_real_gains + cycle_redistribution_in - cycle_redistribution_out + cycle_external_gain_equivalent) stored,
  entries_count integer not null default 0,
  gains_count integer not null default 0,
  opened_seconds bigint not null default 0,
  last_operated_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (cycle_id, slot_id)
);

create table coinops.cycle_progress_events (
  id uuid primary key default gen_random_uuid(),
  cycle_id uuid not null references coinops.operational_cycles(id) on delete restrict,
  progress_id uuid not null references coinops.cycle_slot_progress(id) on delete restrict,
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  slot_id uuid not null references coinops.slots(id) on delete restrict,
  ledger_id uuid references coinops.slot_capital_ledger(id) on delete restrict,
  event_type text not null check (event_type in ('REAL_GAIN','REDISTRIBUTION_IN','REDISTRIBUTION_OUT','EXTERNAL_CONTRIBUTION','ENTRY','CLOSE')),
  progress_delta numeric(20,8) not null default 0,
  amount_usdt numeric(24,8) not null default 0,
  occurred_at timestamptz not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create unique index cycle_progress_events_ledger_idx
  on coinops.cycle_progress_events(ledger_id) where ledger_id is not null;

create table coinops.strategy_regime_state (
  baseline_id uuid primary key references coinops.monitoring_baselines(id) on delete restrict,
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  mode text not null check (mode in ('NORMAL_GROWTH','DEFENSIVE_POST_ATH')),
  official_ath numeric(24,8) not null,
  defensive_anchor_ath numeric(24,8),
  current_btc_price numeric(24,8) not null,
  mode_started_at timestamptz not null,
  last_price_at timestamptz not null,
  updated_at timestamptz not null default timezone('utc', now())
);

create table coinops.strategy_regime_events (
  id uuid primary key default gen_random_uuid(),
  baseline_id uuid not null references coinops.monitoring_baselines(id) on delete restrict,
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  event_type text not null check (event_type in ('BASELINE_STARTED','NEW_ATH','DEFENSIVE_PEAK_UPDATED','STRONG_BOTTOM_REACHED')),
  previous_mode text,
  new_mode text not null,
  btc_price numeric(24,8) not null,
  official_ath numeric(24,8) not null,
  defensive_anchor_ath numeric(24,8),
  occurred_at timestamptz not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create table coinops.cycle_daily_snapshots (
  id uuid primary key default gen_random_uuid(),
  cycle_id uuid not null references coinops.operational_cycles(id) on delete restrict,
  baseline_id uuid not null references coinops.monitoring_baselines(id) on delete restrict,
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  snapshot_date date not null,
  timezone text not null,
  metrics jsonb not null,
  created_at timestamptz not null default timezone('utc', now()),
  unique (cycle_id, snapshot_date)
);

create table coinops.cycle_reports (
  id uuid primary key default gen_random_uuid(),
  cycle_id uuid not null references coinops.operational_cycles(id) on delete restrict,
  baseline_id uuid not null references coinops.monitoring_baselines(id) on delete restrict,
  strategy_version_id uuid not null references coinops.strategy_versions(id) on delete restrict,
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  status text not null default 'DRAFT' check (status in ('DRAFT','AWAITING_CLOSURE','FINALIZED')),
  report_version integer not null default 1 check (report_version > 0),
  payload jsonb not null default '{}'::jsonb,
  generated_at timestamptz,
  finalized_at timestamptz,
  finalized_by uuid,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (cycle_id, report_version),
  check ((status = 'FINALIZED') = (finalized_at is not null))
);

create table coinops.monitoring_alerts (
  id uuid primary key default gen_random_uuid(),
  baseline_id uuid not null references coinops.monitoring_baselines(id) on delete restrict,
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  alert_type text not null,
  severity text not null check (severity in ('INFO','ATTENTION','CRITICAL')),
  message text not null,
  dedupe_key text not null,
  occurred_at timestamptz not null,
  read_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  unique (baseline_id, dedupe_key)
);

create index cycle_progress_scope_idx on coinops.cycle_slot_progress(product_id,tenant_id,user_id,cycle_id,asset,cycle_progress);
create index regime_events_scope_idx on coinops.strategy_regime_events(product_id,tenant_id,user_id,occurred_at desc);
create index reports_scope_idx on coinops.cycle_reports(product_id,tenant_id,user_id,created_at desc);
create index alerts_scope_idx on coinops.monitoring_alerts(product_id,tenant_id,user_id,occurred_at desc);

-- Every table remains private. Authenticated users can only read their own scope;
-- writes are performed by narrowly granted security-definer functions.
do $rls$
declare
  table_name text;
begin
  foreach table_name in array array[
    'strategy_versions','monitoring_baselines','monitoring_baseline_assets','monitoring_baseline_slots',
    'operational_cycles','slot_pool_configuration','cycle_slot_progress','cycle_progress_events',
    'strategy_regime_state','strategy_regime_events','cycle_daily_snapshots','cycle_reports','monitoring_alerts'
  ] loop
    execute format('alter table coinops.%I enable row level security', table_name);
    execute format('alter table coinops.%I force row level security', table_name);
    execute format('create policy %I on coinops.%I for select to authenticated using (private.coinops_can_access_row(product_id,tenant_id,user_id))', table_name || '_owner_select', table_name);
    execute format('revoke all on table coinops.%I from public, anon, authenticated', table_name);
    execute format('grant select on table coinops.%I to authenticated, service_role', table_name);
  end loop;
end
$rls$;

create or replace function coinops.preview_official_monitoring_baseline()
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $fn$
declare
  scope_row record;
  result jsonb;
begin
  select * into strict scope_row from private.coinops_current_scope();
  select jsonb_build_object(
    'ok', true,
    'already_active', exists(select 1 from coinops.monitoring_baselines b where b.product_id=scope_row.product_id and b.tenant_id=scope_row.tenant_id and b.user_id=scope_row.user_id and b.status='ACTIVE'),
    'official_date', '2026-08-27',
    'timezone', 'America/Campo_Grande',
    'slots', (select count(*) from coinops.slots s where s.product_id=scope_row.product_id and s.tenant_id=scope_row.tenant_id and s.user_id=scope_row.user_id),
    'open_slots', (select count(*) from coinops.slots s where s.product_id=scope_row.product_id and s.tenant_id=scope_row.tenant_id and s.user_id=scope_row.user_id and s.status='aberto'),
    'operational_total', (select round(coalesce(sum(s.operational_slot_value),0),8) from coinops.slots s where s.product_id=scope_row.product_id and s.tenant_id=scope_row.tenant_id and s.user_id=scope_row.user_id),
    'realized_profit_legacy', (select round(coalesce(sum(s.realized_profit),0),8) from coinops.slots s where s.product_id=scope_row.product_id and s.tenant_id=scope_row.tenant_id and s.user_id=scope_row.user_id),
    'external_contributions_legacy', (select round(coalesce(sum(s.growth_contribution),0),8) from coinops.slots s where s.product_id=scope_row.product_id and s.tenant_id=scope_row.tenant_id and s.user_id=scope_row.user_id),
    'assets', (select coalesce(jsonb_object_agg(asset,asset_summary),'{}'::jsonb) from (
      select st.asset,
        jsonb_build_object('slots',count(*),'open',count(*) filter(where s.status='aberto'),'operational_total',round(coalesce(sum(s.operational_slot_value),0),8)) asset_summary
      from coinops.slots s join coinops.strategies st on st.id=s.strategy_id
      where s.product_id=scope_row.product_id and s.tenant_id=scope_row.tenant_id and s.user_id=scope_row.user_id
      group by st.asset
    ) asset_rows)
  ) into result;
  return result;
end
$fn$;

create or replace function coinops.activate_official_monitoring_baseline(
  p_idempotency_key uuid,
  p_btc_price numeric,
  p_sol_price numeric,
  p_btc_ath numeric
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
#variable_conflict use_variable
declare
  scope_row record;
  existing coinops.monitoring_baselines%rowtype;
  version_id uuid;
  baseline_id uuid;
  cycle_id uuid;
  activated_at timestamptz := timezone('utc', now());
  version_number integer;
  slot_count integer;
begin
  if p_idempotency_key is null or least(p_btc_price,p_sol_price,p_btc_ath) <= 0 then raise exception 'COINOPS_BASELINE_INPUT_INVALID'; end if;
  select * into strict scope_row from private.coinops_current_scope();
  perform pg_advisory_xact_lock(hashtextextended(scope_row.product_id::text || scope_row.tenant_id::text || scope_row.user_id::text || ':official-baseline',0));

  select * into existing from coinops.monitoring_baselines b
  where b.product_id=scope_row.product_id and b.tenant_id=scope_row.tenant_id and b.user_id=scope_row.user_id and b.status='ACTIVE';
  if found then
    if existing.idempotency_key = p_idempotency_key then return jsonb_build_object('ok',true,'already_active',true,'baseline_id',existing.id,'started_at',existing.started_at); end if;
    raise exception 'COINOPS_OFFICIAL_BASELINE_ALREADY_ACTIVE';
  end if;

  select coalesce(max(v.version),0)+1 into version_number from coinops.strategy_versions v
  where v.product_id=scope_row.product_id and v.tenant_id=scope_row.tenant_id and v.user_id=scope_row.user_id;

  insert into coinops.strategy_versions(product_id,tenant_id,user_id,version,status,effective_from,configuration,notes,created_by)
  values(scope_row.product_id,scope_row.tenant_id,scope_row.user_id,version_number,'ACTIVE',activated_at,
    jsonb_build_object('official_date','2026-08-27','timezone','America/Campo_Grande','modes',jsonb_build_object(
      'NORMAL_GROWTH',jsonb_build_object('BTC',jsonb_build_object('entry_spacing_pct',2,'cycle_target',7),'SOL',jsonb_build_object('entry_spacing_pct',3,'cycle_target',2)),
      'DEFENSIVE_POST_ATH',jsonb_build_object('BTC',jsonb_build_object('entry_spacing_pct',5),'SOL',jsonb_build_object('entry_spacing_pct',8))),
      'defensive_exit_drawdown_pct',40,'main_slots',25,'reserve_slots',25),
    'Estratégia oficial pós-baseline; legado preservado sem reprocessamento.',scope_row.user_id)
  returning id into version_id;

  select count(*) into slot_count from coinops.slots s
  where s.product_id=scope_row.product_id and s.tenant_id=scope_row.tenant_id and s.user_id=scope_row.user_id;

  insert into coinops.monitoring_baselines(product_id,tenant_id,user_id,strategy_version_id,idempotency_key,started_at,btc_price,sol_price,official_btc_ath,summary,created_by)
  values(scope_row.product_id,scope_row.tenant_id,scope_row.user_id,version_id,p_idempotency_key,activated_at,p_btc_price,p_sol_price,greatest(p_btc_ath,p_btc_price),
    jsonb_build_object('slots',slot_count,'operational_total',(select round(coalesce(sum(s.operational_slot_value),0),8) from coinops.slots s where s.product_id=scope_row.product_id and s.tenant_id=scope_row.tenant_id and s.user_id=scope_row.user_id),
      'realized_profit_legacy',(select round(coalesce(sum(s.realized_profit),0),8) from coinops.slots s where s.product_id=scope_row.product_id and s.tenant_id=scope_row.tenant_id and s.user_id=scope_row.user_id)),scope_row.user_id)
  returning id into baseline_id;

  insert into coinops.monitoring_baseline_assets(baseline_id,product_id,tenant_id,user_id,asset,operational_total,realized_profit,slots_existing,slots_enabled,slots_open,slots_free)
  select baseline_id,scope_row.product_id,scope_row.tenant_id,scope_row.user_id,st.asset,
    round(coalesce(sum(s.operational_slot_value),0),8),round(coalesce(sum(s.realized_profit),0),8),count(*),
    count(*) filter(where s.slot_number<=25 and s.operational_slot_value>0),count(*) filter(where s.status='aberto'),count(*) filter(where s.status<>'aberto')
  from coinops.slots s join coinops.strategies st on st.id=s.strategy_id
  where s.product_id=scope_row.product_id and s.tenant_id=scope_row.tenant_id and s.user_id=scope_row.user_id
  group by st.asset;

  insert into coinops.monitoring_baseline_slots(baseline_id,product_id,tenant_id,user_id,slot_id,strategy_id,asset,slot_number,snapshot)
  select baseline_id,scope_row.product_id,scope_row.tenant_id,scope_row.user_id,s.id,s.strategy_id,st.asset,s.slot_number,
    jsonb_build_object('status',s.status,'real_gains',s.real_gains,'operational_gains',s.operational_gains,'added_gains',s.added_gains,
      'external_contribution',s.growth_contribution,'operational_value',s.operational_slot_value,'entry',s.preco_entrada,'target',s.preco_alvo,
      'position_quantity',s.position_quantity,'opened_at',s.position_opened_at,'rank',s.sort_order,'enabled',s.slot_number<=25)
  from coinops.slots s join coinops.strategies st on st.id=s.strategy_id
  where s.product_id=scope_row.product_id and s.tenant_id=scope_row.tenant_id and s.user_id=scope_row.user_id;

  insert into coinops.slot_pool_configuration(baseline_id,product_id,tenant_id,user_id,asset,slot_number,slot_id,pool,enabled,funded,active_from_cycle)
  select baseline_id,scope_row.product_id,scope_row.tenant_id,scope_row.user_id,a.asset,n,s.id,
    case when n<=25 then 'MAIN' else 'RESERVE' end,
    (s.id is not null and n<=25 and s.operational_slot_value>0),(s.id is not null and s.operational_slot_value>0),1
  from (values('BTC'),('SOL')) a(asset) cross join generate_series(1,50) n
  left join coinops.strategies st on st.product_id=scope_row.product_id and st.tenant_id=scope_row.tenant_id and st.user_id=scope_row.user_id and st.asset=a.asset
  left join coinops.slots s on s.strategy_id=st.id and s.slot_number=n;

  insert into coinops.operational_cycles(baseline_id,strategy_version_id,product_id,tenant_id,user_id,cycle_number,mode,status,start_at,end_at,redistribution_status)
  values(baseline_id,version_id,scope_row.product_id,scope_row.tenant_id,scope_row.user_id,1,'NORMAL_GROWTH','ACTIVE',activated_at,activated_at+interval '30 days','PENDING') returning id into cycle_id;

  insert into coinops.cycle_slot_progress(cycle_id,baseline_id,product_id,tenant_id,user_id,slot_id,asset,target,lifetime_real_gains_start,lifetime_operational_gains_start,operational_value_start,last_operated_at)
  select cycle_id,baseline_id,scope_row.product_id,scope_row.tenant_id,scope_row.user_id,s.id,p.asset,case when p.asset='BTC' then 7 else 2 end,
    s.real_gains,s.operational_gains,s.operational_slot_value,coalesce(s.position_opened_at,s.updated_at)
  from coinops.slot_pool_configuration p join coinops.slots s on s.id=p.slot_id
  where p.baseline_id=baseline_id and p.pool='MAIN' and p.enabled and p.funded;

  insert into coinops.strategy_regime_state(baseline_id,product_id,tenant_id,user_id,mode,official_ath,current_btc_price,mode_started_at,last_price_at)
  values(baseline_id,scope_row.product_id,scope_row.tenant_id,scope_row.user_id,'NORMAL_GROWTH',greatest(p_btc_ath,p_btc_price),p_btc_price,activated_at,activated_at);
  insert into coinops.strategy_regime_events(baseline_id,product_id,tenant_id,user_id,event_type,new_mode,btc_price,official_ath,occurred_at,metadata)
  values(baseline_id,scope_row.product_id,scope_row.tenant_id,scope_row.user_id,'BASELINE_STARTED','NORMAL_GROWTH',p_btc_price,greatest(p_btc_ath,p_btc_price),activated_at,jsonb_build_object('official_date','2026-08-27'));
  insert into coinops.cycle_reports(cycle_id,baseline_id,strategy_version_id,product_id,tenant_id,user_id,status,payload)
  values(cycle_id,baseline_id,version_id,scope_row.product_id,scope_row.tenant_id,scope_row.user_id,'DRAFT',jsonb_build_object('cycle',1,'legacy_excluded',true));

  return jsonb_build_object('ok',true,'already_active',false,'baseline_id',baseline_id,'strategy_version',version_number,'cycle_id',cycle_id,'started_at',activated_at,'mode','NORMAL_GROWTH');
end
$fn$;

create or replace function private.coinops_capture_cycle_ledger_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  progress coinops.cycle_slot_progress%rowtype;
  event_name text;
  progress_delta numeric;
begin
  if new.entry_type='OPENING_BALANCE' then return new; end if;
  select p.* into progress from coinops.cycle_slot_progress p join coinops.operational_cycles c on c.id=p.cycle_id
  where p.product_id=new.product_id and p.tenant_id=new.tenant_id and p.user_id=new.user_id and p.slot_id=new.slot_id
    and c.status='ACTIVE' and new.created_at>=c.start_at and (c.end_at is null or new.created_at<c.end_at)
  order by c.start_at desc limit 1;
  if not found then return new; end if;
  event_name := case new.entry_type when 'REAL_GAIN' then 'REAL_GAIN' when 'REDISTRIBUTION_CREDIT' then 'REDISTRIBUTION_IN' when 'REDISTRIBUTION_DEBIT' then 'REDISTRIBUTION_OUT' else 'EXTERNAL_CONTRIBUTION' end;
  progress_delta := case when new.entry_type='REDISTRIBUTION_DEBIT' then -abs(new.operational_gain_delta) else abs(new.operational_gain_delta) end;
  insert into coinops.cycle_progress_events(cycle_id,progress_id,product_id,tenant_id,user_id,slot_id,ledger_id,event_type,progress_delta,amount_usdt,occurred_at,metadata)
  values(progress.cycle_id,progress.id,new.product_id,new.tenant_id,new.user_id,new.slot_id,new.id,event_name,progress_delta,new.amount_usdt,new.created_at,new.metadata)
  on conflict (ledger_id) where ledger_id is not null do nothing;
  if found then
    update coinops.cycle_slot_progress set
      cycle_real_gains=cycle_real_gains+case when new.entry_type='REAL_GAIN' then abs(new.operational_gain_delta) else 0 end,
      cycle_redistribution_in=cycle_redistribution_in+case when new.entry_type='REDISTRIBUTION_CREDIT' then abs(new.operational_gain_delta) else 0 end,
      cycle_redistribution_out=cycle_redistribution_out+case when new.entry_type='REDISTRIBUTION_DEBIT' then abs(new.operational_gain_delta) else 0 end,
      cycle_external_gain_equivalent=cycle_external_gain_equivalent+case when new.entry_type='EXTERNAL_CONTRIBUTION' then abs(new.operational_gain_delta) else 0 end,
      gains_count=gains_count+case when new.entry_type='REAL_GAIN' then 1 else 0 end,
      last_operated_at=new.created_at,updated_at=timezone('utc',now()) where id=progress.id;
  end if;
  return new;
end
$fn$;

create trigger coinops_capture_cycle_ledger_event_v1
after insert on coinops.slot_capital_ledger
for each row execute function private.coinops_capture_cycle_ledger_event();

create or replace function coinops.get_official_monitoring_overview()
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $fn$
declare
  scope_row record;
  baseline coinops.monitoring_baselines%rowtype;
  cycle coinops.operational_cycles%rowtype;
  regime coinops.strategy_regime_state%rowtype;
  result jsonb;
begin
  select * into strict scope_row from private.coinops_current_scope();
  select * into baseline from coinops.monitoring_baselines b where b.product_id=scope_row.product_id and b.tenant_id=scope_row.tenant_id and b.user_id=scope_row.user_id and b.status='ACTIVE';
  if not found then return jsonb_build_object('ok',true,'active',false); end if;
  select * into cycle from coinops.operational_cycles c where c.baseline_id=baseline.id and c.status='ACTIVE';
  select * into regime from coinops.strategy_regime_state r where r.baseline_id=baseline.id;
  select jsonb_build_object(
    'ok',true,'active',true,
    'baseline',jsonb_build_object('id',baseline.id,'official_date',baseline.official_date,'started_at',baseline.started_at,'timezone',baseline.timezone,'summary',baseline.summary),
    'strategy',jsonb_build_object('version',(select v.version from coinops.strategy_versions v where v.id=baseline.strategy_version_id),'mode',regime.mode,
      'btc_spacing',case when regime.mode='NORMAL_GROWTH' then 2 else 5 end,'sol_spacing',case when regime.mode='NORMAL_GROWTH' then 3 else 8 end,
      'official_ath',regime.official_ath,'defensive_anchor_ath',regime.defensive_anchor_ath),
    'cycle',jsonb_build_object('id',cycle.id,'number',cycle.cycle_number,'mode',cycle.mode,'start_at',cycle.start_at,'end_at',cycle.end_at,
      'days_remaining',case when cycle.end_at is null then null else greatest(0,ceil(extract(epoch from (cycle.end_at-timezone('utc',now())))/86400.0)) end),
    'assets',(select coalesce(jsonb_object_agg(asset,payload),'{}'::jsonb) from (
      select p.asset,jsonb_build_object('target',case when regime.mode='NORMAL_GROWTH' then max(p.target) else null end,
        'enabled',count(*),'below_target',count(*) filter(where p.cycle_progress<p.target),
        'next_slot',(array_agg(jsonb_build_object('slot_id',p.slot_id,'slot_number',s.slot_number,'progress',p.cycle_progress,'operational_gains',s.operational_gains)
          order by p.cycle_progress,s.operational_gains,coalesce(p.last_operated_at,'epoch'::timestamptz),s.slot_number) filter(where regime.mode<>'NORMAL_GROWTH' or p.cycle_progress<p.target))[1]) payload
      from coinops.cycle_slot_progress p join coinops.slots s on s.id=p.slot_id where p.cycle_id=cycle.id group by p.asset
    ) asset_rows),
    'pools',(select coalesce(jsonb_object_agg(asset,payload),'{}'::jsonb) from (
      select asset,jsonb_build_object('main_enabled',count(*) filter(where pool='MAIN' and enabled and funded),'main_open',count(*) filter(where pool='MAIN' and enabled and funded and s.status='aberto'),
        'reserve_enabled',count(*) filter(where pool='RESERVE' and enabled and funded),'reserve_available',count(*) filter(where pool='RESERVE' and not enabled)) payload
      from coinops.slot_pool_configuration p left join coinops.slots s on s.id=p.slot_id where p.baseline_id=baseline.id group by asset
    ) pool_rows),
    'reports',(select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'cycle_id',r.cycle_id,'status',r.status,'version',r.report_version) order by r.created_at desc),'[]'::jsonb) from coinops.cycle_reports r where r.baseline_id=baseline.id)
  ) into result;
  return result;
end
$fn$;

revoke all on function coinops.preview_official_monitoring_baseline() from public,anon,authenticated,service_role;
grant execute on function coinops.preview_official_monitoring_baseline() to authenticated;
revoke all on function coinops.activate_official_monitoring_baseline(uuid,numeric,numeric,numeric) from public,anon,authenticated,service_role;
grant execute on function coinops.activate_official_monitoring_baseline(uuid,numeric,numeric,numeric) to authenticated;
revoke all on function coinops.get_official_monitoring_overview() from public,anon,authenticated,service_role;
grant execute on function coinops.get_official_monitoring_overview() to authenticated;
revoke all on function private.coinops_capture_cycle_ledger_event() from public,anon,authenticated,service_role;
