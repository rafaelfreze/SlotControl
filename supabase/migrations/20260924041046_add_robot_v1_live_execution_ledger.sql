-- CoinOps 5.4: isolated BRL Spot ledger. This migration does not activate LIVE
-- and does not place, cancel, or import any Production exchange order.
alter table coinops.robot_v1_live_preparations
  drop constraint robot_v1_live_preparations_kill_switch_check,
  drop constraint robot_v1_live_preparations_live_enabled_check,
  add constraint robot_v1_live_preparations_safe_flags_check
    check (live_enabled or kill_switch);

alter table coinops.robot_v1_live_slot_accounts
  add column dust_quantity numeric(28,12) not null default 0 check (dust_quantity >= 0),
  add column dust_cost_brl numeric(20,8) not null default 0 check (dust_cost_brl >= 0);
alter table coinops.robot_v1_live_slot_accounts drop constraint robot_v1_live_slot_balance_check;
alter table coinops.robot_v1_live_slot_accounts add constraint robot_v1_live_slot_balance_check
  check (balance_brl = market_pnl_brl + manual_gain_brl + contribution_brl
    - fees_brl - dust_cost_brl);

create table coinops.robot_v1_live_runs (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  asset text not null check (asset in ('BTC','SOL')),
  symbol text not null,
  status text not null default 'PREPARING' check (status in ('PREPARING','ACTIVE','PAUSED','COMPLETED')),
  anchor_price numeric(24,8) not null check (anchor_price > 0),
  slot_notional_brl numeric(20,8) not null check (slot_notional_brl > 0),
  gain_rate numeric(12,8) not null check (gain_rate > 0 and gain_rate < 1),
  entry_spacing numeric(12,8) not null check (entry_spacing > 0 and entry_spacing < 1),
  entry_regime text not null check (entry_regime in ('NORMAL','POST_ATH')),
  config_version integer not null check (config_version > 0),
  config_snapshot jsonb not null check (jsonb_typeof(config_snapshot) = 'object'),
  strategy_version text not null,
  ath_transition_key text,
  ath_period_key text,
  previous_run_id uuid references coinops.robot_v1_live_runs(id) on delete restrict,
  reset_idempotency_key text unique,
  completed_at timestamptz,
  last_reconciled_at timestamptz,
  last_error text,
  lease_owner uuid,
  lease_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, product_id, tenant_id, user_id),
  foreign key (product_id,tenant_id,user_id,asset)
    references coinops.robot_v1_live_preparations(product_id,tenant_id,user_id,asset) on delete restrict,
  constraint robot_v1_live_run_pair check
    ((asset='BTC' and symbol='BTCBRL') or (asset='SOL' and symbol='SOLBRL'))
);
create unique index robot_v1_live_one_running_cycle on coinops.robot_v1_live_runs
  (product_id,tenant_id,user_id,asset) where status in ('PREPARING','ACTIVE','PAUSED');
create index robot_v1_live_runs_scope on coinops.robot_v1_live_runs (tenant_id,user_id,asset,created_at desc);

create table coinops.robot_v1_live_slots (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  slot_number integer not null check (slot_number between 1 and 25),
  entry_state text not null default 'PLANNED' check (entry_state in ('PLANNED','ARMED','OPEN','CLOSED','MISSED')),
  target_buy_price numeric(24,8) not null check (target_buy_price > 0),
  entry_reference_price numeric(24,8) not null check (entry_reference_price > 0),
  operation_sequence integer not null default 1 check (operation_sequence > 0),
  entry_origin text not null default 'GRID' check (entry_origin in ('GRID','REENTRY')),
  operational_rank integer check (operational_rank between 1 and 25),
  post_ath_group text check (post_ath_group in ('PRIMARY','RESERVE')),
  post_ath_group_rank integer check (post_ath_group_rank between 1 and 25),
  position_quantity numeric(28,12) not null default 0 check (position_quantity >= 0),
  position_committed_brl numeric(20,8) not null default 0 check (position_committed_brl >= 0),
  missed_at timestamptz,
  last_take_profit_price numeric(24,8),
  last_credited_sell_client_order_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (run_id,slot_number),
  unique (id,run_id,product_id,tenant_id,user_id),
  foreign key (run_id,product_id,tenant_id,user_id)
    references coinops.robot_v1_live_runs(id,product_id,tenant_id,user_id) on delete restrict
);
create unique index robot_v1_live_one_armed_slot on coinops.robot_v1_live_slots (run_id) where entry_state='ARMED';

create table coinops.robot_v1_live_orders (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,
  slot_id uuid not null,
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  slot_number integer not null check (slot_number between 1 and 25),
  operation_sequence integer not null check (operation_sequence > 0),
  side text not null check (side in ('BUY','SELL')),
  purpose text not null check (purpose in ('INITIAL','ENTRY','TP')),
  revision integer not null check (revision > 0),
  client_order_id text not null unique check
    (length(client_order_id)<=36 and client_order_id ~ '^COR1-(BTC|SOL)-[0-9]+-[0-9]+-(BUY|SELL)-[a-f0-9]{14}$'),
  exchange_order_id text,
  status text not null default 'PREPARED' check
    (status in ('PREPARED','NEW','PARTIALLY_FILLED','FILLED','CANCELED','EXPIRED','EXPIRED_IN_MATCH','REJECTED')),
  requested_quantity numeric(28,12),
  requested_quote numeric(20,8),
  price numeric(24,8),
  reserved_notional_brl numeric(20,8) not null check (reserved_notional_brl >= 0),
  executed_quantity numeric(28,12) not null default 0 check (executed_quantity >= 0),
  cumulative_quote numeric(20,8) not null default 0 check (cumulative_quote >= 0),
  fee_base numeric(28,12) not null default 0 check (fee_base >= 0),
  fee_quote numeric(20,8) not null default 0 check (fee_quote >= 0),
  fee_other jsonb not null default '[]'::jsonb check (jsonb_typeof(fee_other) = 'array'),
  trades_reconciled boolean not null default false,
  submission_guarded_at timestamptz,
  strategy_decision_id text,
  config_version integer not null,
  config_snapshot jsonb not null check (jsonb_typeof(config_snapshot) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (run_id,slot_number,side,revision),
  foreign key (run_id,product_id,tenant_id,user_id)
    references coinops.robot_v1_live_runs(id,product_id,tenant_id,user_id) on delete restrict,
  foreign key (slot_id,run_id,product_id,tenant_id,user_id)
    references coinops.robot_v1_live_slots(id,run_id,product_id,tenant_id,user_id) on delete restrict,
  constraint robot_v1_live_order_purpose check
    ((side='BUY' and purpose in ('INITIAL','ENTRY')) or (side='SELL' and purpose='TP')),
  constraint robot_v1_live_order_request check
    ((purpose='INITIAL' and requested_quote > 0 and requested_quantity is null and price is null)
      or (purpose in ('ENTRY','TP') and requested_quote is null and requested_quantity > 0 and price > 0))
);
create unique index robot_v1_live_one_active_buy on coinops.robot_v1_live_orders (run_id)
  where side='BUY' and status in ('PREPARED','NEW','PARTIALLY_FILLED');
create unique index robot_v1_live_one_active_tp_per_slot on coinops.robot_v1_live_orders
  (run_id,slot_id,operation_sequence) where side='SELL' and status in ('PREPARED','NEW','PARTIALLY_FILLED');
create index robot_v1_live_orders_run_slot on coinops.robot_v1_live_orders (run_id,slot_number,created_at);

create table coinops.robot_v1_live_fills (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references coinops.robot_v1_live_orders(id) on delete restrict,
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  symbol text not null check (symbol in ('BTCBRL','SOLBRL')),
  exchange_trade_id text not null check (exchange_trade_id ~ '^[0-9]+$'),
  quantity numeric(28,12) not null check (quantity > 0),
  quote_quantity numeric(20,8) not null check (quote_quantity > 0),
  commission numeric(28,12) not null check (commission >= 0),
  commission_asset text not null,
  commission_brl numeric(20,8) not null check (commission_brl >= 0),
  fee_fx_source text,
  fee_fx_observed_at timestamptz,
  filled_at timestamptz not null,
  collected_at timestamptz not null default now(),
  unique (symbol,exchange_trade_id)
);
create index robot_v1_live_fills_order on coinops.robot_v1_live_fills (order_id,filled_at);

create table coinops.robot_v1_live_events (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  event_key text not null,
  event_type text not null,
  slot_number integer check (slot_number between 1 and 25),
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details)='object'),
  observed_at timestamptz not null default now(),
  unique (run_id,event_key),
  foreign key (run_id,product_id,tenant_id,user_id)
    references coinops.robot_v1_live_runs(id,product_id,tenant_id,user_id) on delete restrict
);
create index robot_v1_live_events_run_time on coinops.robot_v1_live_events (run_id,observed_at desc);

create table coinops.robot_v1_live_alerts (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  asset text check (asset in ('BTC','SOL')),
  alert_key text not null,
  severity text not null check (severity in ('WARNING','CRITICAL')),
  code text not null,
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details)='object'),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  resolved_at timestamptz,
  unique (product_id,tenant_id,user_id,alert_key),
  foreign key (product_id,tenant_id) references public.product_tenants(product_id,tenant_id) on delete restrict
);
create index robot_v1_live_alerts_unresolved on coinops.robot_v1_live_alerts (tenant_id,severity,last_seen_at desc)
  where resolved_at is null;

create trigger robot_v1_live_runs_touch before update on coinops.robot_v1_live_runs
  for each row execute function private.coinops_touch_updated_at();
create trigger robot_v1_live_slots_touch before update on coinops.robot_v1_live_slots
  for each row execute function private.coinops_touch_updated_at();
create trigger robot_v1_live_orders_touch before update on coinops.robot_v1_live_orders
  for each row execute function private.coinops_touch_updated_at();

do $$ declare t text; begin
  foreach t in array array['robot_v1_live_runs','robot_v1_live_slots','robot_v1_live_orders',
    'robot_v1_live_fills','robot_v1_live_events','robot_v1_live_alerts'] loop
    execute format('alter table coinops.%I enable row level security', t);
    execute format('alter table coinops.%I force row level security', t);
    execute format('create policy %I on coinops.%I for select to authenticated using (private.coinops_can_access_row(product_id,tenant_id,user_id))', t || '_owner_read', t);
    execute format('revoke all on coinops.%I from public,anon,authenticated', t);
    execute format('grant select on coinops.%I to authenticated', t);
    execute format('grant select,insert,update on coinops.%I to service_role', t);
  end loop;
end $$;
revoke update on coinops.robot_v1_live_fills,coinops.robot_v1_live_events from service_role;

create function coinops.preserve_live_submission_guard() returns trigger language plpgsql
  security invoker set search_path='' as $$
begin
  if old.submission_guarded_at is not null
    and new.submission_guarded_at is distinct from old.submission_guarded_at then
    raise exception 'COINOPS_LIVE_SUBMISSION_GUARD_IMMUTABLE';
  end if;
  return new;
end $$;
create trigger robot_v1_live_submission_guard_immutable
  before update of submission_guarded_at on coinops.robot_v1_live_orders
  for each row execute function coinops.preserve_live_submission_guard();
revoke all on function coinops.preserve_live_submission_guard() from public,anon,authenticated;

alter table coinops.robot_v1_strategy_decisions drop constraint robot_v1_strategy_decisions_environment_check;
alter table coinops.robot_v1_strategy_decisions add constraint robot_v1_strategy_decisions_environment_check
  check (environment in ('SHADOW','TESTNET','REAL'));
create or replace function private.coinops_guard_strategy_decision() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    if (new.product_id,new.tenant_id,new.user_id,new.environment,new.asset,new.decision_id,new.strategy_version,new.cycle_id,new.slot_id,new.operation_id,new.operation_sequence,new.action_type,new.target_price,new.target_notional,new.priority,new.reason,new.expected_next_state,new.created_at)
       is distinct from
       (old.product_id,old.tenant_id,old.user_id,old.environment,old.asset,old.decision_id,old.strategy_version,old.cycle_id,old.slot_id,old.operation_id,old.operation_sequence,old.action_type,old.target_price,old.target_notional,old.priority,old.reason,old.expected_next_state,old.created_at) then
      raise exception 'COINOPS_STRATEGY_DECISION_IMMUTABLE';
    end if;
    return new;
  end if;
  if new.environment = 'TESTNET' then
    if not exists (select 1 from coinops.robot_v1_testnet_runs r where r.id=new.cycle_id and r.product_id=new.product_id and r.tenant_id=new.tenant_id and r.user_id=new.user_id and r.asset=new.asset)
      or (new.slot_id is not null and not exists (select 1 from coinops.robot_v1_testnet_slots s where s.id=new.slot_id and s.run_id=new.cycle_id)) then
      raise exception 'COINOPS_STRATEGY_DECISION_SCOPE_INVALID';
    end if;
  elsif new.environment = 'REAL' then
    if not exists (select 1 from coinops.robot_v1_live_runs r where r.id=new.cycle_id and r.product_id=new.product_id and r.tenant_id=new.tenant_id and r.user_id=new.user_id and r.asset=new.asset)
      or (new.slot_id is not null and not exists (select 1 from coinops.robot_v1_live_slots s where s.id=new.slot_id and s.run_id=new.cycle_id)) then
      raise exception 'COINOPS_STRATEGY_DECISION_SCOPE_INVALID';
    end if;
  else
    if not exists (select 1 from coinops.robot_v1_cycles c where c.id=new.cycle_id and c.product_id=new.product_id and c.tenant_id=new.tenant_id and c.user_id=new.user_id and c.asset=new.asset and c.execution_mode='SHADOW')
      or (new.slot_id is not null and not exists (select 1 from coinops.robot_v1_slots s where s.id=new.slot_id and s.cycle_id=new.cycle_id)) then
      raise exception 'COINOPS_STRATEGY_DECISION_SCOPE_INVALID';
    end if;
  end if;
  return new;
end $$;

alter table coinops.robot_v1_monthly_slot_gains drop constraint robot_v1_monthly_slot_gains_evidence_basis_check;
alter table coinops.robot_v1_monthly_slot_gains add constraint robot_v1_monthly_slot_gains_evidence_basis_check
  check (evidence_basis in ('SHADOW_CONFIRMED_TP_CLOSE','TESTNET_EXCHANGE_FILL',
    'TESTNET_CREDIT_FALLBACK','REAL_EXCHANGE_FILL','MANUAL_TARGET_GAIN','MANUAL_GAIN_REVERSAL'));
create or replace view coinops.robot_v1_slot_gain_totals with (security_invoker = true) as
select product_id, tenant_id, user_id, environment, asset, slot_number, physical_slot_id,
  coalesce(sum(gain_units),0)::integer as lifetime_gain_count,
  coalesce(sum(gain_units) filter (where period_key = to_char(now() at time zone 'America/Campo_Grande', 'YYYY-MM')),0)::integer as monthly_gain_count,
  to_char(now() at time zone 'America/Campo_Grande', 'YYYY-MM') as period_key,
  'America/Campo_Grande'::text as timezone,
  count(*) filter (where evidence_basis in ('SHADOW_CONFIRMED_TP_CLOSE','TESTNET_EXCHANGE_FILL','TESTNET_CREDIT_FALLBACK','REAL_EXCHANGE_FILL'))::integer as market_gain_count,
  coalesce(sum(gain_units) filter (where evidence_basis in ('MANUAL_TARGET_GAIN','MANUAL_GAIN_REVERSAL')),0)::integer as manual_gain_count,
  count(*) filter (where period_key = to_char(now() at time zone 'America/Campo_Grande', 'YYYY-MM')
    and evidence_basis in ('SHADOW_CONFIRMED_TP_CLOSE','TESTNET_EXCHANGE_FILL','TESTNET_CREDIT_FALLBACK','REAL_EXCHANGE_FILL'))::integer as monthly_market_gain_count,
  coalesce(sum(gain_units) filter (where period_key = to_char(now() at time zone 'America/Campo_Grande', 'YYYY-MM')
    and evidence_basis in ('MANUAL_TARGET_GAIN','MANUAL_GAIN_REVERSAL')),0)::integer as monthly_manual_gain_count
from coinops.robot_v1_monthly_slot_gains
group by product_id, tenant_id, user_id, environment, asset, slot_number, physical_slot_id;

-- One short transaction reserves capital across BTC and SOL before dispatch.
-- External Binance I/O always happens after this transaction commits.
create function coinops.prepare_robot_v1_live_order(
  p_run_id uuid, p_slot_id uuid, p_side text, p_purpose text,
  p_revision integer, p_client_order_id text, p_quantity numeric,
  p_quote numeric, p_price numeric, p_decision_id text, p_lease_owner uuid
) returns coinops.robot_v1_live_orders language plpgsql
security definer set search_path='' as $$
declare
  v_run coinops.robot_v1_live_runs%rowtype;
  v_slot coinops.robot_v1_live_slots%rowtype;
  v_config coinops.robot_v1_live_preparations%rowtype;
  v_global coinops.robot_v1_live_global_caps%rowtype;
  v_existing coinops.robot_v1_live_orders%rowtype;
  v_order coinops.robot_v1_live_orders%rowtype;
  v_notional numeric;
  v_asset_exposure numeric;
  v_global_exposure numeric;
  v_accounts integer;
  v_account_balance numeric;
begin
  select * into strict v_run from coinops.robot_v1_live_runs where id=p_run_id for update;
  if (v_run.status <> 'ACTIVE' and not (p_side='SELL' and v_run.status='PAUSED'))
    or p_lease_owner is null
    or v_run.lease_owner is distinct from p_lease_owner
    or v_run.lease_until is null or v_run.lease_until <= now()
    or (v_run.last_error is not null and p_side='BUY') then
    raise exception 'COINOPS_LIVE_LEASE_OR_RUN_BLOCKED';
  end if;
  select * into strict v_global from coinops.robot_v1_live_global_caps
    where product_id=v_run.product_id and tenant_id=v_run.tenant_id and user_id=v_run.user_id for update;
  select * into strict v_config from coinops.robot_v1_live_preparations
    where product_id=v_run.product_id and tenant_id=v_run.tenant_id
      and user_id=v_run.user_id and asset=v_run.asset for update;
  select * into strict v_slot from coinops.robot_v1_live_slots
    where id=p_slot_id and run_id=p_run_id and product_id=v_run.product_id
      and tenant_id=v_run.tenant_id and user_id=v_run.user_id for update;
  if v_config.symbol<>v_run.symbol or v_config.slot_count<>25
    or v_config.configured_live_capital_brl > (case v_run.asset when 'BTC' then 450 else 275 end)
    or v_config.max_order_notional_brl > (case v_run.asset when 'BTC' then 18 else 11 end)
    or v_config.max_total_exposure_brl > (case v_run.asset when 'BTC' then 450 else 275 end)
    or v_global.max_total_live_exposure_brl > 725 then
    raise exception 'COINOPS_LIVE_HARD_CAP_INVALID';
  end if;
  select * into v_existing from coinops.robot_v1_live_orders where client_order_id=p_client_order_id;
  if found then
    if (v_existing.run_id,v_existing.slot_id,v_existing.side,v_existing.purpose,
      v_existing.revision,v_existing.requested_quantity,v_existing.requested_quote,
      v_existing.price,v_existing.strategy_decision_id)
      is distinct from (p_run_id,p_slot_id,p_side,p_purpose,p_revision,p_quantity,
        p_quote,p_price,p_decision_id) then
      raise exception 'COINOPS_LIVE_ORDER_IDENTITY_COLLISION';
    end if;
    return v_existing;
  end if;
  if p_revision < 1 or p_client_order_id !~ ('^COR1-'||v_run.asset||'-'||v_slot.slot_number||'-'||p_revision||'-'||p_side||'-[a-f0-9]{14}$')
    or p_decision_id !~ '^[a-f0-9]{64}$' or not exists
      (select 1 from coinops.robot_v1_strategy_decisions d where d.environment='REAL'
        and d.cycle_id=p_run_id and d.slot_id=p_slot_id and d.decision_id=p_decision_id
        and d.product_id=v_run.product_id and d.tenant_id=v_run.tenant_id and d.user_id=v_run.user_id)
    or (p_side,p_purpose) not in (('BUY','INITIAL'),('BUY','ENTRY'),('SELL','TP')) then
    raise exception 'COINOPS_LIVE_ORDER_INTENT_INVALID';
  end if;
  if p_purpose='INITIAL' then
    if p_quote is null or p_quote<=0 or p_quantity is not null or p_price is not null
      or v_slot.operation_sequence<>1 or v_slot.operational_rank<>1 then
      raise exception 'COINOPS_LIVE_INITIAL_INTENT_INVALID';
    end if;
    v_notional:=p_quote;
  else
    if p_quantity is null or p_quantity<=0 or p_quote is not null or p_price is null or p_price<=0 then
      raise exception 'COINOPS_LIVE_LIMIT_INTENT_INVALID';
    end if;
    v_notional:=round(p_quantity*p_price,8);
  end if;
  if p_side='BUY' then
    if not v_config.live_enabled or v_config.kill_switch or v_slot.entry_state<>'PLANNED'
      or v_notional > v_config.max_order_notional_brl
      or exists (select 1 from coinops.robot_v1_live_orders o where o.run_id=p_run_id
        and o.side='BUY' and o.status in ('PREPARED','NEW','PARTIALLY_FILLED')) then
      raise exception 'COINOPS_LIVE_NEW_BUY_BLOCKED';
    end if;
    select count(*),coalesce(sum(contribution_brl),0) into v_accounts,v_account_balance
      from coinops.robot_v1_live_slot_accounts a where a.product_id=v_run.product_id
        and a.tenant_id=v_run.tenant_id and a.user_id=v_run.user_id and a.asset=v_run.asset;
    if v_accounts<>25 or v_account_balance>v_config.configured_live_capital_brl
      or v_account_balance<=0 or v_notional>
        (select balance_brl from coinops.robot_v1_live_slot_accounts a
          where a.product_id=v_run.product_id and a.tenant_id=v_run.tenant_id
            and a.user_id=v_run.user_id and a.asset=v_run.asset and a.slot_number=v_slot.slot_number)
      then raise exception 'COINOPS_LIVE_SLOT_CAPITAL_INVALID';
    end if;
    select coalesce(sum(s.position_committed_brl),0) into v_asset_exposure
      from coinops.robot_v1_live_slots s join coinops.robot_v1_live_runs r on r.id=s.run_id
      where r.product_id=v_run.product_id and r.tenant_id=v_run.tenant_id
        and r.user_id=v_run.user_id and r.asset=v_run.asset and r.status in ('ACTIVE','PAUSED');
    select v_asset_exposure+coalesce(sum(greatest(o.reserved_notional_brl-o.cumulative_quote,0)),0)
      into v_asset_exposure from coinops.robot_v1_live_orders o
      join coinops.robot_v1_live_runs r on r.id=o.run_id
      where r.product_id=v_run.product_id and r.tenant_id=v_run.tenant_id
        and r.user_id=v_run.user_id and r.asset=v_run.asset and r.status in ('ACTIVE','PAUSED')
        and o.side='BUY' and o.status in ('PREPARED','NEW','PARTIALLY_FILLED');
    select coalesce(sum(s.position_committed_brl),0) into v_global_exposure
      from coinops.robot_v1_live_slots s join coinops.robot_v1_live_runs r on r.id=s.run_id
      where r.product_id=v_run.product_id and r.tenant_id=v_run.tenant_id
        and r.user_id=v_run.user_id and r.status in ('ACTIVE','PAUSED');
    select v_global_exposure+coalesce(sum(greatest(o.reserved_notional_brl-o.cumulative_quote,0)),0)
      into v_global_exposure from coinops.robot_v1_live_orders o
      join coinops.robot_v1_live_runs r on r.id=o.run_id
      where r.product_id=v_run.product_id and r.tenant_id=v_run.tenant_id
        and r.user_id=v_run.user_id and r.status in ('ACTIVE','PAUSED')
        and o.side='BUY' and o.status in ('PREPARED','NEW','PARTIALLY_FILLED');
    if v_asset_exposure+v_notional>v_config.max_total_exposure_brl
      or v_global_exposure+v_notional>v_global.max_total_live_exposure_brl then
      raise exception 'COINOPS_LIVE_EXPOSURE_CAP_DENIED';
    end if;
  elsif v_slot.position_quantity<=0 or p_quantity>v_slot.position_quantity
    or v_slot.entry_state<>'OPEN' then
    raise exception 'COINOPS_LIVE_TP_POSITION_UNVERIFIED';
  end if;
  insert into coinops.robot_v1_live_orders
    (run_id,slot_id,product_id,tenant_id,user_id,slot_number,operation_sequence,
      side,purpose,revision,client_order_id,requested_quantity,requested_quote,price,
      reserved_notional_brl,strategy_decision_id,config_version,config_snapshot)
  values (v_run.id,v_slot.id,v_run.product_id,v_run.tenant_id,v_run.user_id,v_slot.slot_number,
    v_slot.operation_sequence,p_side,p_purpose,p_revision,p_client_order_id,p_quantity,p_quote,p_price,
    case when p_side='BUY' then v_notional else 0 end,p_decision_id,
    v_run.config_version,v_run.config_snapshot) returning * into v_order;
  return v_order;
end $$;
revoke all on function coinops.prepare_robot_v1_live_order(uuid,uuid,text,text,integer,text,numeric,numeric,numeric,text,uuid)
  from public,anon,authenticated;
grant execute on function coinops.prepare_robot_v1_live_order(uuid,uuid,text,text,integer,text,numeric,numeric,numeric,text,uuid)
  to service_role;

-- A complete exchange trade snapshot is inserted immutably and projected onto
-- the position in one transaction. No fill or fee is invented from order status.
create function coinops.sync_robot_v1_live_order(
  p_order_id uuid, p_exchange_order_id text, p_status text,
  p_executed_quantity numeric, p_cumulative_quote numeric, p_trades jsonb,
  p_bnb_brl_price numeric, p_bnb_brl_observed_at timestamptz, p_lease_owner uuid
) returns coinops.robot_v1_live_orders language plpgsql
security definer set search_path='' as $$
declare
  v_order coinops.robot_v1_live_orders%rowtype;
  v_run coinops.robot_v1_live_runs%rowtype;
  v_slot coinops.robot_v1_live_slots%rowtype;
  v_trade jsonb;
  v_previous coinops.robot_v1_live_fills%rowtype;
  v_trade_id text;
  v_qty numeric;
  v_quote numeric;
  v_fee numeric;
  v_fee_asset text;
  v_fee_brl numeric;
  v_filled_at timestamptz;
  v_sum_qty numeric;
  v_sum_quote numeric;
  v_fee_base numeric;
  v_fee_quote numeric;
  v_other_fee numeric;
  v_old_other_fee numeric;
  v_delta_qty numeric;
  v_delta_quote numeric;
  v_delta_base_fee numeric;
  v_delta_other_fee numeric;
begin
  select * into strict v_order from coinops.robot_v1_live_orders where id=p_order_id for update;
  select * into strict v_run from coinops.robot_v1_live_runs where id=v_order.run_id for update;
  select * into strict v_slot from coinops.robot_v1_live_slots where id=v_order.slot_id for update;
  if p_lease_owner is null or v_run.lease_owner is distinct from p_lease_owner
    or v_run.lease_until is null or v_run.lease_until<=now()
    or v_run.status not in ('ACTIVE','PAUSED') then
    raise exception 'COINOPS_LIVE_LEASE_BLOCKED';
  end if;
  if p_exchange_order_id is null or p_exchange_order_id !~ '^[0-9]+$'
    or p_status not in ('NEW','PARTIALLY_FILLED','FILLED','CANCELED','EXPIRED','EXPIRED_IN_MATCH','REJECTED')
    or p_executed_quantity is null or p_cumulative_quote is null
    or p_executed_quantity<0 or p_cumulative_quote<0
    or (p_executed_quantity>0 and p_cumulative_quote<=0)
    or v_order.exchange_order_id is not null and v_order.exchange_order_id<>p_exchange_order_id
    or p_executed_quantity<v_order.executed_quantity
    or p_cumulative_quote<v_order.cumulative_quote
    or v_order.status in ('FILLED','CANCELED','EXPIRED','EXPIRED_IN_MATCH','REJECTED')
      and v_order.status<>p_status
    or jsonb_typeof(p_trades)<>'array' or jsonb_array_length(p_trades)>1000 then
    raise exception 'COINOPS_LIVE_ORDER_SNAPSHOT_INVALID';
  end if;
  select coalesce(sum(commission_brl),0) into v_old_other_fee
    from coinops.robot_v1_live_fills where order_id=v_order.id and commission_asset in ('BNB','BRL');
  for v_trade in select value from jsonb_array_elements(p_trades) as item(value) loop
    v_trade_id:=v_trade->>'id';
    v_qty:=(v_trade->>'quantity')::numeric;
    v_quote:=(v_trade->>'quoteQuantity')::numeric;
    v_fee:=(v_trade->>'commission')::numeric;
    v_fee_asset:=v_trade->>'commissionAsset';
    v_filled_at:=(v_trade->>'filledAt')::timestamptz;
    if v_trade_id !~ '^[0-9]+$' or v_qty<=0 or v_quote<=0 or v_fee<0
      or v_filled_at is null or v_filled_at>now()+interval '10 seconds'
      or v_fee_asset not in (v_run.asset,'BRL','BNB')
      or (v_trade->>'isBuyer')::boolean is distinct from (v_order.side='BUY') then
      raise exception 'COINOPS_LIVE_FILL_INVALID';
    end if;
    if v_fee_asset='BNB' then
      if p_bnb_brl_price is null or p_bnb_brl_price<=0 or p_bnb_brl_observed_at is null
        or abs(extract(epoch from now()-p_bnb_brl_observed_at))>600 then
        raise exception 'COINOPS_LIVE_BNB_FEE_PRICE_STALE';
      end if;
      v_fee_brl:=round(v_fee*p_bnb_brl_price,8);
    elsif v_fee_asset='BRL' then v_fee_brl:=round(v_fee,8);
    else v_fee_brl:=round(v_fee*v_quote/v_qty,8);
    end if;
    insert into coinops.robot_v1_live_fills
      (order_id,product_id,tenant_id,user_id,symbol,exchange_trade_id,quantity,
        quote_quantity,commission,commission_asset,commission_brl,fee_fx_source,
        fee_fx_observed_at,filled_at)
    values (v_order.id,v_order.product_id,v_order.tenant_id,v_order.user_id,v_run.symbol,
      v_trade_id,v_qty,v_quote,v_fee,v_fee_asset,v_fee_brl,
      case when v_fee_asset='BNB' then 'BINANCE_SPOT_BNBBRL_TICKER' else null end,
      case when v_fee_asset='BNB' then p_bnb_brl_observed_at else null end,v_filled_at)
    on conflict (symbol,exchange_trade_id) do nothing;
    select * into strict v_previous from coinops.robot_v1_live_fills
      where symbol=v_run.symbol and exchange_trade_id=v_trade_id;
    if (v_previous.order_id,v_previous.quantity,v_previous.quote_quantity,
      v_previous.commission,v_previous.commission_asset,v_previous.filled_at)
      is distinct from (v_order.id,v_qty,v_quote,v_fee,v_fee_asset,v_filled_at) then
      raise exception 'COINOPS_LIVE_FILL_IDENTITY_COLLISION';
    end if;
  end loop;
  select coalesce(sum(quantity),0),coalesce(sum(quote_quantity),0),
    coalesce(sum(commission) filter (where commission_asset=v_run.asset),0),
    coalesce(sum(commission) filter (where commission_asset='BRL'),0),
    coalesce(sum(commission_brl) filter (where commission_asset in ('BNB','BRL')),0)
    into v_sum_qty,v_sum_quote,v_fee_base,v_fee_quote,v_other_fee
    from coinops.robot_v1_live_fills where order_id=v_order.id;
  if abs(v_sum_qty-p_executed_quantity)>0.000000000001
    or abs(v_sum_quote-p_cumulative_quote)>0.00000001
    or p_status='FILLED' and v_sum_qty<=0 then
    raise exception 'COINOPS_LIVE_TRADE_SNAPSHOT_INCOMPLETE';
  end if;
  v_delta_qty:=v_sum_qty-v_order.executed_quantity;
  v_delta_quote:=v_sum_quote-v_order.cumulative_quote;
  v_delta_base_fee:=v_fee_base-v_order.fee_base;
  v_delta_other_fee:=v_other_fee-v_old_other_fee;
  if v_delta_qty<0 or v_delta_quote<0 or v_delta_base_fee<0 or v_delta_other_fee<0 then
    raise exception 'COINOPS_LIVE_FILL_REGRESSION';
  end if;
  if v_order.side='BUY' then
    update coinops.robot_v1_live_slots set
      position_quantity=position_quantity+v_delta_qty-v_delta_base_fee,
      position_committed_brl=position_committed_brl+v_delta_quote+v_delta_other_fee,
      entry_state=case when v_sum_qty>0 then 'OPEN' else entry_state end
    where id=v_slot.id;
  else
    if v_slot.position_quantity+0.000000000001<v_delta_qty+v_delta_base_fee then
      raise exception 'COINOPS_LIVE_POSITION_OVERSOLD';
    end if;
    update coinops.robot_v1_live_slots set
      position_quantity=greatest(0,position_quantity-v_delta_qty-v_delta_base_fee)
    where id=v_slot.id;
  end if;
  update coinops.robot_v1_live_orders set exchange_order_id=p_exchange_order_id,
    status=p_status,executed_quantity=v_sum_qty,cumulative_quote=v_sum_quote,
    fee_base=v_fee_base,fee_quote=v_fee_quote,
    fee_other=case when v_other_fee>0 then jsonb_build_array(jsonb_build_object('asset','BNB',
      'amount',(select coalesce(sum(commission),0) from coinops.robot_v1_live_fills
        where order_id=v_order.id and commission_asset='BNB')))
      else '[]'::jsonb end,
    trades_reconciled=p_status in ('FILLED','CANCELED','EXPIRED','EXPIRED_IN_MATCH','REJECTED')
  where id=v_order.id returning * into v_order;
  insert into coinops.robot_v1_live_events
    (run_id,product_id,tenant_id,user_id,event_key,event_type,slot_number,details)
  values (v_run.id,v_run.product_id,v_run.tenant_id,v_run.user_id,
    v_order.client_order_id||':'||p_status||':'||v_sum_qty::text,
    'ORDER_OBSERVED',v_order.slot_number,
    jsonb_build_object('client_order_id',v_order.client_order_id,
      'exchange_order_id',p_exchange_order_id,'status',p_status,
      'executed_quantity',v_sum_qty,'cumulative_quote',v_sum_quote))
  on conflict (run_id,event_key) do nothing;
  return v_order;
end $$;
revoke all on function coinops.sync_robot_v1_live_order(uuid,text,text,numeric,numeric,jsonb,numeric,timestamptz,uuid)
  from public,anon,authenticated;
grant execute on function coinops.sync_robot_v1_live_order(uuid,text,text,numeric,numeric,jsonb,numeric,timestamptz,uuid)
  to service_role;

-- Credit only an exchange-proven terminal TP. Dust is inventory with its own
-- cost basis; it is never duplicated as spendable BRL in the next operation.
create function coinops.credit_robot_v1_live_closed_slot(
  p_run_id uuid,p_slot_id uuid,p_operation_sequence integer,
  p_tp_client_order_id text,p_quantity_step numeric,p_lease_owner uuid
) returns coinops.robot_v1_live_slot_accounts language plpgsql
security definer set search_path='' as $$
declare
  v_run coinops.robot_v1_live_runs%rowtype;
  v_slot coinops.robot_v1_live_slots%rowtype;
  v_account coinops.robot_v1_live_slot_accounts%rowtype;
  v_tp coinops.robot_v1_live_orders%rowtype;
  v_buy_quantity numeric;
  v_sold_quantity numeric;
  v_buy_quote numeric;
  v_sell_quote numeric;
  v_fee_brl numeric;
  v_dust numeric;
  v_dust_basis numeric;
  v_gross_pnl numeric;
  v_net_pnl numeric;
  v_fill_at timestamptz;
begin
  select * into strict v_run from coinops.robot_v1_live_runs where id=p_run_id for update;
  select * into strict v_slot from coinops.robot_v1_live_slots
    where id=p_slot_id and run_id=p_run_id for update;
  select * into strict v_account from coinops.robot_v1_live_slot_accounts
    where product_id=v_run.product_id and tenant_id=v_run.tenant_id
      and user_id=v_run.user_id and asset=v_run.asset and slot_number=v_slot.slot_number for update;
  if v_run.lease_owner is distinct from p_lease_owner or p_lease_owner is null
    or v_run.lease_until is null or v_run.lease_until<=now()
    or p_quantity_step<=0 or p_operation_sequence<>v_slot.operation_sequence then
    raise exception 'COINOPS_LIVE_CREDIT_LEASE_OR_SEQUENCE_INVALID';
  end if;
  if v_slot.last_credited_sell_client_order_id=p_tp_client_order_id then return v_account; end if;
  select * into strict v_tp from coinops.robot_v1_live_orders where run_id=p_run_id
    and slot_id=p_slot_id and operation_sequence=p_operation_sequence
    and client_order_id=p_tp_client_order_id and side='SELL' and purpose='TP';
  if v_tp.status<>'FILLED' or not v_tp.trades_reconciled
    or v_slot.entry_state<>'OPEN' or v_slot.position_quantity>=p_quantity_step
    or exists (select 1 from coinops.robot_v1_live_orders o where o.run_id=p_run_id
      and o.slot_id=p_slot_id and o.operation_sequence=p_operation_sequence
      and (o.status not in ('FILLED','CANCELED','EXPIRED','EXPIRED_IN_MATCH','REJECTED')
        or o.executed_quantity>0 and not o.trades_reconciled)) then
    raise exception 'COINOPS_LIVE_TP_CLOSURE_NOT_PROVEN';
  end if;
  select coalesce(sum(o.executed_quantity-o.fee_base),0),
    coalesce(sum(o.cumulative_quote),0) into v_buy_quantity,v_buy_quote
    from coinops.robot_v1_live_orders o where o.run_id=p_run_id and o.slot_id=p_slot_id
      and o.operation_sequence=p_operation_sequence and o.side='BUY';
  select coalesce(sum(o.executed_quantity+o.fee_base),0),
    coalesce(sum(o.cumulative_quote),0) into v_sold_quantity,v_sell_quote
    from coinops.robot_v1_live_orders o where o.run_id=p_run_id and o.slot_id=p_slot_id
      and o.operation_sequence=p_operation_sequence and o.side='SELL';
  select coalesce(sum(f.commission_brl),0) into v_fee_brl
    from coinops.robot_v1_live_fills f join coinops.robot_v1_live_orders o on o.id=f.order_id
    where o.run_id=p_run_id and o.slot_id=p_slot_id and o.operation_sequence=p_operation_sequence
      and f.commission_asset in ('BNB','BRL');
  select max(f.filled_at) into v_fill_at from coinops.robot_v1_live_fills f where f.order_id=v_tp.id;
  v_dust:=v_buy_quantity-v_sold_quantity;
  if v_buy_quantity<=0 or v_sold_quantity<=0 or v_dust< -0.000000000001
    or v_dust>=p_quantity_step or abs(v_dust-v_slot.position_quantity)>0.000000000001
    or v_fill_at is null then
    raise exception 'COINOPS_LIVE_POSITION_CLOSURE_MISMATCH';
  end if;
  v_dust_basis:=round(v_buy_quote*greatest(v_dust,0)/v_buy_quantity,8);
  v_gross_pnl:=round(v_sell_quote-v_buy_quote+v_dust_basis,8);
  v_net_pnl:=v_gross_pnl-v_fee_brl;
  update coinops.robot_v1_live_slot_accounts set
    balance_brl=balance_brl+v_sell_quote-v_buy_quote-v_fee_brl,
    market_pnl_brl=market_pnl_brl+v_gross_pnl,
    fees_brl=fees_brl+v_fee_brl,
    dust_quantity=dust_quantity+greatest(v_dust,0),
    dust_cost_brl=dust_cost_brl+v_dust_basis,
    gain_count=gain_count+case when v_net_pnl>0 then 1 else 0 end
  where product_id=v_run.product_id and tenant_id=v_run.tenant_id and user_id=v_run.user_id
    and asset=v_run.asset and slot_number=v_slot.slot_number returning * into v_account;
  update coinops.robot_v1_live_slots set entry_state='CLOSED',position_quantity=0,
    position_committed_brl=0,last_take_profit_price=v_tp.price,
    last_credited_sell_client_order_id=p_tp_client_order_id where id=v_slot.id;
  insert into coinops.robot_v1_live_events
    (run_id,product_id,tenant_id,user_id,event_key,event_type,slot_number,details)
  values (v_run.id,v_run.product_id,v_run.tenant_id,v_run.user_id,
    p_tp_client_order_id||':CREDITED','SLOT_PROFIT_CREDITED',v_slot.slot_number,
    jsonb_build_object('tp_client_order_id',p_tp_client_order_id,'buy_quote_brl',v_buy_quote,
      'sell_quote_brl',v_sell_quote,'fees_brl',v_fee_brl,'dust_quantity',greatest(v_dust,0),
      'dust_basis_brl',v_dust_basis,'gross_pnl_brl',v_gross_pnl,'net_pnl_brl',v_net_pnl,
      'balance_after_brl',v_account.balance_brl,'gain_count_after',v_account.gain_count));
  if v_net_pnl>0 then
    insert into coinops.robot_v1_monthly_slot_gains
      (environment,source_id,product_id,tenant_id,user_id,asset,slot_number,
        physical_slot_id,credited_at,effective_gain_at,evidence_basis,period_key)
    values ('REAL',v_tp.id,v_run.product_id,v_run.tenant_id,v_run.user_id,v_run.asset,
      v_slot.slot_number,'REAL:'||v_run.product_id||':'||v_run.tenant_id||':'||v_run.user_id
        ||':'||v_run.asset||':'||v_slot.slot_number,now(),v_fill_at,'REAL_EXCHANGE_FILL',
      to_char(v_fill_at at time zone 'America/Campo_Grande','YYYY-MM'));
  end if;
  return v_account;
end $$;
revoke all on function coinops.credit_robot_v1_live_closed_slot(uuid,uuid,integer,text,numeric,uuid)
  from public,anon,authenticated;
grant execute on function coinops.credit_robot_v1_live_closed_slot(uuid,uuid,integer,text,numeric,uuid)
  to service_role;

-- Activation is a separate, atomic gate after executor write capability has
-- been validated with kill ON and then deliberately released outside SQL.
create function coinops.activate_robot_v1_live_cycle(p_run_id uuid)
returns coinops.robot_v1_live_runs language plpgsql
security definer set search_path='' as $$
declare
  v_run coinops.robot_v1_live_runs%rowtype;
  v_config coinops.robot_v1_live_preparations%rowtype;
  v_global coinops.robot_v1_live_global_caps%rowtype;
  v_count integer;
  v_contribution numeric;
begin
  select * into strict v_run from coinops.robot_v1_live_runs where id=p_run_id for update;
  select * into strict v_global from coinops.robot_v1_live_global_caps
    where product_id=v_run.product_id and tenant_id=v_run.tenant_id and user_id=v_run.user_id for update;
  select * into strict v_config from coinops.robot_v1_live_preparations
    where product_id=v_run.product_id and tenant_id=v_run.tenant_id
      and user_id=v_run.user_id and asset=v_run.asset for update;
  if v_run.status='ACTIVE' and v_config.live_enabled and not v_config.kill_switch then return v_run; end if;
  if v_run.status<>'PREPARING' or v_config.live_enabled or not v_config.kill_switch
    or v_config.slot_count<>25 or v_config.configured_live_capital_brl>(case v_run.asset when 'BTC' then 450 else 275 end)
    or v_config.max_order_notional_brl>(case v_run.asset when 'BTC' then 18 else 11 end)
    or v_config.max_total_exposure_brl>(case v_run.asset when 'BTC' then 450 else 275 end)
    or v_global.max_total_live_exposure_brl>725
    or exists (select 1 from coinops.robot_v1_live_orders where run_id=v_run.id) then
    raise exception 'COINOPS_LIVE_ACTIVATION_GATE_FAILED';
  end if;
  select count(*) into v_count from coinops.robot_v1_live_slots where run_id=v_run.id;
  if v_count<>25 then raise exception 'COINOPS_LIVE_SLOT_COUNT_INVALID'; end if;
  select count(*),coalesce(sum(contribution_brl),0) into v_count,v_contribution
    from coinops.robot_v1_live_slot_accounts where product_id=v_run.product_id
      and tenant_id=v_run.tenant_id and user_id=v_run.user_id and asset=v_run.asset
      and balance_brl=contribution_brl and manual_gain_brl=0 and market_pnl_brl=0 and fees_brl=0;
  if v_count<>25 or v_contribution<>v_config.configured_live_capital_brl then
    raise exception 'COINOPS_LIVE_PRINCIPAL_NOT_PROVEN';
  end if;
  update coinops.robot_v1_live_preparations set live_enabled=true,kill_switch=false,
    config_version=config_version+1 where id=v_config.id;
  update coinops.robot_v1_live_runs set status='ACTIVE' where id=v_run.id returning * into v_run;
  insert into coinops.robot_v1_live_events
    (run_id,product_id,tenant_id,user_id,event_key,event_type,details)
  values (v_run.id,v_run.product_id,v_run.tenant_id,v_run.user_id,
    'RUN_ACTIVATED','RUN_ACTIVATED',jsonb_build_object('asset',v_run.asset,
      'capital_brl',v_contribution,'strategy_version',v_run.strategy_version));
  return v_run;
end $$;
revoke all on function coinops.activate_robot_v1_live_cycle(uuid) from public,anon,authenticated;
grant execute on function coinops.activate_robot_v1_live_cycle(uuid) to service_role;

-- The old run is completed and the successor's 25 physical slots are created
-- in one transaction. A retry returns the same successor, never a second run.
create function coinops.restart_robot_v1_live_cycle(
  p_old_run_id uuid,p_reset_key text,p_anchor_price numeric,p_gain_rate numeric,
  p_entry_spacing numeric,p_regime text,p_config_version integer,p_config_snapshot jsonb,
  p_transition_key text,p_period_key text,p_plans jsonb,p_lease_owner uuid
) returns coinops.robot_v1_live_runs language plpgsql
security definer set search_path='' as $$
declare
  v_old coinops.robot_v1_live_runs%rowtype;
  v_new coinops.robot_v1_live_runs%rowtype;
  v_config coinops.robot_v1_live_preparations%rowtype;
  v_count integer;
  v_total numeric;
  v_number integer;
  v_plan jsonb;
  v_rank integer;
  v_price numeric;
  v_group text;
  v_group_rank integer;
  v_ranks integer[]:='{}';
begin
  select * into strict v_old from coinops.robot_v1_live_runs
    where id=p_old_run_id for update;
  select * into v_new from coinops.robot_v1_live_runs
    where previous_run_id=p_old_run_id and reset_idempotency_key=p_reset_key;
  if found then return v_new; end if;
  select * into strict v_config from coinops.robot_v1_live_preparations
    where product_id=v_old.product_id and tenant_id=v_old.tenant_id
      and user_id=v_old.user_id and asset=v_old.asset for update;
  if v_old.status<>'ACTIVE' or v_old.last_error is not null
    or p_lease_owner is null or v_old.lease_owner is distinct from p_lease_owner
    or v_old.lease_until is null or v_old.lease_until<=now()
    or not v_config.live_enabled or v_config.kill_switch
    or p_reset_key is null or length(p_reset_key)<16
    or p_anchor_price is null or p_anchor_price<=0
    or p_gain_rate is null or p_gain_rate<0.001 or p_gain_rate>0.2
    or p_entry_spacing is null or p_entry_spacing<0.001 or p_entry_spacing>0.2
    or p_regime not in ('NORMAL','POST_ATH')
    or p_config_version is null or p_config_version<1
    or jsonb_typeof(p_config_snapshot)<>'object'
    or jsonb_typeof(p_plans)<>'array' or jsonb_array_length(p_plans)<>25
    or p_period_key !~ '^[0-9]{4}-[0-9]{2}$'
    or exists (select 1 from coinops.robot_v1_live_slots
      where run_id=v_old.id and position_quantity>0)
    or exists (select 1 from coinops.robot_v1_live_orders
      where run_id=v_old.id and status in ('PREPARED','NEW','PARTIALLY_FILLED')) then
    raise exception 'COINOPS_LIVE_RESET_GATE_FAILED';
  end if;
  select count(*),coalesce(sum(balance_brl),0) into v_count,v_total
    from coinops.robot_v1_live_slot_accounts
    where product_id=v_old.product_id and tenant_id=v_old.tenant_id
      and user_id=v_old.user_id and asset=v_old.asset and balance_brl>0;
  if v_count<>25 or v_total<=0 then raise exception 'COINOPS_LIVE_RESET_BALANCE_INVALID'; end if;
  for v_number in 1..25 loop
    v_plan:=p_plans->(v_number-1);
    if (v_plan->>'slot_number')::integer is distinct from v_number then
      raise exception 'COINOPS_LIVE_RESET_PHYSICAL_SLOT_INVALID';
    end if;
    v_rank:=(v_plan->>'operational_rank')::integer;
    v_price:=(v_plan->>'target_buy_price')::numeric;
    v_group:=v_plan->>'post_ath_group';
    v_group_rank:=(v_plan->>'post_ath_group_rank')::integer;
    if v_price is null or v_price<=0 or v_rank is not null and
      (v_rank<1 or v_rank>25 or v_rank=any(v_ranks))
      or v_group is not null and v_group not in ('PRIMARY','RESERVE')
      or v_group_rank is not null and (v_group is null or v_group_rank<1 or v_group_rank>25) then
      raise exception 'COINOPS_LIVE_RESET_PLAN_INVALID';
    end if;
    if v_rank is not null then v_ranks:=array_append(v_ranks,v_rank); end if;
  end loop;
  update coinops.robot_v1_live_runs set status='COMPLETED',completed_at=now()
    where id=v_old.id;
  insert into coinops.robot_v1_live_runs
    (product_id,tenant_id,user_id,asset,symbol,status,anchor_price,slot_notional_brl,
      gain_rate,entry_spacing,entry_regime,config_version,config_snapshot,strategy_version,
      ath_transition_key,ath_period_key,previous_run_id,reset_idempotency_key)
  values (v_old.product_id,v_old.tenant_id,v_old.user_id,v_old.asset,v_old.symbol,'ACTIVE',
    p_anchor_price,round(v_total/25,8),p_gain_rate,p_entry_spacing,p_regime,
    p_config_version,p_config_snapshot,v_old.strategy_version,
    p_transition_key,p_period_key,v_old.id,p_reset_key) returning * into v_new;
  for v_number in 1..25 loop
    v_plan:=p_plans->(v_number-1);
    insert into coinops.robot_v1_live_slots
      (run_id,product_id,tenant_id,user_id,slot_number,target_buy_price,
        entry_reference_price,operational_rank,post_ath_group,post_ath_group_rank)
    values (v_new.id,v_new.product_id,v_new.tenant_id,v_new.user_id,v_number,
      (v_plan->>'target_buy_price')::numeric,(v_plan->>'target_buy_price')::numeric,
      (v_plan->>'operational_rank')::integer,v_plan->>'post_ath_group',
      (v_plan->>'post_ath_group_rank')::integer);
  end loop;
  insert into coinops.robot_v1_live_events
    (run_id,product_id,tenant_id,user_id,event_key,event_type,details)
  values (v_new.id,v_new.product_id,v_new.tenant_id,v_new.user_id,
    'RUN_REANCHORED','RUN_REANCHORED',jsonb_build_object('previous_run_id',v_old.id,
      'anchor_price',p_anchor_price,'reset_key',p_reset_key));
  return v_new;
end $$;
revoke all on function coinops.restart_robot_v1_live_cycle(uuid,text,numeric,numeric,numeric,text,integer,jsonb,text,text,jsonb,uuid)
  from public,anon,authenticated;
grant execute on function coinops.restart_robot_v1_live_cycle(uuid,text,numeric,numeric,numeric,text,integer,jsonb,text,text,jsonb,uuid)
  to service_role;

comment on table coinops.robot_v1_live_runs is 'BRL Spot REAL execution ledger; migration alone does not activate trading.';
