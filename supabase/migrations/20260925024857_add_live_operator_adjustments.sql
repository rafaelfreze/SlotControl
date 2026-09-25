-- Manual REAL gains and external capital use the existing live slot accounts.
-- This migration does not change an existing balance, position, order or cap.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';

create table coinops.robot_v1_live_adjustment_batches (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  operator_id uuid not null references coinops.operators(id),
  exchange_account_id uuid not null references coinops.exchange_accounts(id),
  request_id uuid not null,
  request_fingerprint text not null,
  kind text not null check (kind in ('MANUAL_GAIN','CAPITAL','REVERSAL')),
  quote_asset text not null check (quote_asset in ('BRL','USDT')),
  origin_currency text not null check (origin_currency in ('BRL','USDT')),
  origin_amount numeric(20,8) not null default 0,
  amount_quote numeric(20,8) not null default 0,
  fx_rate numeric(20,8),
  fx_observed_at timestamptz,
  evidence text,
  reason text not null check (length(btrim(reason)) between 3 and 160),
  reversal_of uuid references coinops.robot_v1_live_adjustment_batches(id),
  created_at timestamptz not null default now(),
  unique (exchange_account_id, request_id),
  unique (reversal_of)
);
create index robot_v1_live_adjustment_batches_scope_date_idx
  on coinops.robot_v1_live_adjustment_batches(exchange_account_id, created_at desc);

create table coinops.robot_v1_live_adjustment_items (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references coinops.robot_v1_live_adjustment_batches(id),
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  operator_id uuid not null,
  exchange_account_id uuid not null,
  trading_engine_id uuid not null references coinops.trading_engines(id),
  symbol text not null,
  quote_asset text not null check (quote_asset in ('BRL','USDT')),
  slot_number integer not null check (slot_number between 1 and 25),
  physical_slot_id text not null,
  amount_quote numeric(20,8) not null default 0,
  gain_units integer not null default 0,
  balance_before numeric(20,8) not null,
  balance_after numeric(20,8) not null,
  monthly_before integer not null,
  monthly_after integer not null,
  lifetime_before integer not null,
  lifetime_after integer not null,
  open_at_time boolean not null,
  position_committed_quote numeric(20,8) not null default 0,
  operation_sequence integer not null,
  period_key text not null,
  created_at timestamptz not null default now(),
  unique (batch_id, trading_engine_id, slot_number),
  constraint live_adjustment_item_balance_check check (balance_after=balance_before+amount_quote),
  constraint live_adjustment_item_gain_check check
    (monthly_after=monthly_before+gain_units and lifetime_after=lifetime_before+gain_units)
);
create index robot_v1_live_adjustment_items_engine_slot_idx
  on coinops.robot_v1_live_adjustment_items(trading_engine_id,slot_number,created_at desc);

create function coinops.reject_live_adjustment_mutation() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'COINOPS_LIVE_ADJUSTMENT_IMMUTABLE';
end $$;
create trigger robot_v1_live_adjustment_batches_immutable
  before update or delete on coinops.robot_v1_live_adjustment_batches
  for each row execute function coinops.reject_live_adjustment_mutation();
create trigger robot_v1_live_adjustment_items_immutable
  before update or delete on coinops.robot_v1_live_adjustment_items
  for each row execute function coinops.reject_live_adjustment_mutation();

alter table coinops.robot_v1_live_adjustment_batches enable row level security;
alter table coinops.robot_v1_live_adjustment_batches force row level security;
alter table coinops.robot_v1_live_adjustment_items enable row level security;
alter table coinops.robot_v1_live_adjustment_items force row level security;
create policy live_adjustment_batches_owner_read on coinops.robot_v1_live_adjustment_batches
  for select to authenticated using (private.coinops_can_access_row(product_id,tenant_id,user_id));
create policy live_adjustment_items_owner_read on coinops.robot_v1_live_adjustment_items
  for select to authenticated using (private.coinops_can_access_row(product_id,tenant_id,user_id));
revoke all on coinops.robot_v1_live_adjustment_batches from public,anon,authenticated;
revoke all on coinops.robot_v1_live_adjustment_items from public,anon,authenticated;
grant select on coinops.robot_v1_live_adjustment_batches,coinops.robot_v1_live_adjustment_items to authenticated;
grant all on coinops.robot_v1_live_adjustment_batches,coinops.robot_v1_live_adjustment_items to service_role;

-- The existing monthly-gain identity trigger resolves manual evidence through
-- private.coinops_parent_engine. Extend only that parent lookup to the new
-- immutable LIVE item source; all other parent resolution remains unchanged.
create or replace function private.coinops_parent_engine(p_table text,p_id uuid) returns uuid
language plpgsql stable security definer set search_path='' as $$
declare result uuid;
begin
  if p_table not in ('robot_v1_configs','robot_v1_cycles','robot_v1_slots','robot_v1_slot_operations',
    'robot_v1_testnet_runs','robot_v1_testnet_slots','robot_v1_testnet_orders','robot_v1_testnet_events',
    'robot_v1_live_runs','robot_v1_live_slots','robot_v1_live_orders','robot_v1_live_events',
    'robot_v1_ath_profiles','robot_v1_manual_adjustments') then
    raise exception 'COINOPS_ENGINE_PARENT_INVALID';
  end if;
  if p_table='robot_v1_manual_adjustments' then
    select trading_engine_id into result from coinops.robot_v1_manual_adjustments where id=p_id;
    if result is null then
      select trading_engine_id into result from coinops.robot_v1_live_adjustment_items
        where id=p_id and gain_units<>0;
    end if;
    if result is null then raise exception 'COINOPS_ENGINE_PARENT_MISSING'; end if;
  else
    execute format('select trading_engine_id from coinops.%I where id=$1',p_table)
      into strict result using p_id;
  end if;
  if result is null then raise exception 'COINOPS_ENGINE_PARENT_UNBOUND'; end if;
  return result;
exception when no_data_found then raise exception 'COINOPS_ENGINE_PARENT_MISSING';
end $$;

create function coinops.apply_live_operator_adjustment(
  p_operator_id uuid, p_account_id uuid, p_created_by uuid,
  p_kind text, p_quote_asset text, p_origin_currency text,
  p_origin_amount numeric, p_amount_quote numeric, p_fx_rate numeric,
  p_fx_observed_at timestamptz, p_evidence text, p_reason text,
  p_allocations jsonb, p_expected_account_cap numeric, p_request_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_operator coinops.operators%rowtype;
  v_account coinops.exchange_accounts%rowtype;
  v_cap coinops.account_quote_caps%rowtype;
  v_batch coinops.robot_v1_live_adjustment_batches%rowtype;
  v_engine coinops.trading_engines%rowtype;
  v_run coinops.robot_v1_live_runs%rowtype;
  v_slot coinops.robot_v1_live_slots%rowtype;
  v_slot_account coinops.robot_v1_live_slot_accounts%rowtype;
  v_item jsonb;
  v_item_id uuid;
  v_number integer;
  v_delta numeric;
  v_units integer;
  v_total numeric := 0;
  v_engine_delta numeric;
  v_monthly integer;
  v_lifetime integer;
  v_period text := to_char(now() at time zone 'America/Campo_Grande','YYYY-MM');
  v_physical_slot_id text;
  v_fingerprint text;
  v_seen text[] := '{}';
begin
  if coalesce(nullif(current_setting('request.jwt.claim.role',true),''),auth.jwt()->>'role','') <> 'service_role'
    or p_operator_id is null or p_account_id is null or p_created_by is null or p_request_id is null
    or p_kind not in ('MANUAL_GAIN','CAPITAL') or p_quote_asset not in ('BRL','USDT')
    or p_origin_currency not in ('BRL','USDT') or p_amount_quote is null or p_origin_amount is null
    or p_expected_account_cap is null or length(btrim(coalesce(p_reason,''))) not between 3 and 160
    or jsonb_typeof(p_allocations)<>'array' or jsonb_array_length(p_allocations) not between 1 and 50 then
    raise exception 'COINOPS_LIVE_ADJUSTMENT_INPUT_DENIED';
  end if;
  if p_kind='MANUAL_GAIN' and (jsonb_array_length(p_allocations)<>1 or p_amount_quote<>0 or p_origin_amount<>0)
    or p_kind='CAPITAL' and (p_amount_quote<=0 or p_amount_quote<>round(p_amount_quote,2)
      or p_origin_amount<=0 or p_origin_amount<>round(p_origin_amount,2)) then
    raise exception 'COINOPS_LIVE_ADJUSTMENT_AMOUNT_DENIED';
  end if;
  if p_origin_currency=p_quote_asset then
    if p_origin_amount<>p_amount_quote or p_fx_rate is not null or p_fx_observed_at is not null then
      raise exception 'COINOPS_LIVE_ADJUSTMENT_FX_DENIED';
    end if;
  elsif p_kind<>'CAPITAL' or p_origin_currency<>'BRL' or p_quote_asset<>'USDT'
    or p_fx_rate is null or p_fx_rate<=0 or p_fx_observed_at is null
    or p_fx_observed_at<now()-interval '10 minutes' or p_fx_observed_at>now()+interval '10 seconds'
    or abs(p_origin_amount/p_amount_quote-p_fx_rate)>0.0001
    or length(btrim(coalesce(p_evidence,'')))<8 then
    raise exception 'COINOPS_LIVE_ADJUSTMENT_FX_EVIDENCE_REQUIRED';
  end if;
  v_fingerprint:=md5(jsonb_build_object('operator',p_operator_id,'account',p_account_id,
    'kind',p_kind,'quote',p_quote_asset,'origin',p_origin_currency,'originAmount',p_origin_amount,
    'amount',p_amount_quote,'fx',p_fx_rate,'fxAt',p_fx_observed_at,'evidence',p_evidence,
    'reason',btrim(p_reason),'allocations',p_allocations)::text);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_account_id::text,0));
  select * into v_batch from coinops.robot_v1_live_adjustment_batches
    where exchange_account_id=p_account_id and request_id=p_request_id;
  if v_batch.id is not null then
    if v_batch.request_fingerprint<>v_fingerprint then raise exception 'COINOPS_LIVE_ADJUSTMENT_REPLAY_CONFLICT'; end if;
    return jsonb_build_object('id',v_batch.id,'status','REPLAYED');
  end if;
  select * into v_operator from coinops.operators where id=p_operator_id for share;
  select * into v_account from coinops.exchange_accounts
    where id=p_account_id and operator_id=p_operator_id for share;
  select * into v_cap from coinops.account_quote_caps
    where exchange_account_id=p_account_id and operator_id=p_operator_id and quote_asset=p_quote_asset for update;
  if v_operator.id is null or v_operator.status<>'ACTIVE' or v_operator.user_id<>p_created_by
    or v_account.id is null or v_account.status<>'ACTIVE' or v_cap.exchange_account_id is null
    or v_cap.hard_cap_quote<>p_expected_account_cap then
    raise exception 'COINOPS_LIVE_ADJUSTMENT_SCOPE_DENIED';
  end if;
  insert into coinops.robot_v1_live_adjustment_batches
    (product_id,tenant_id,user_id,operator_id,exchange_account_id,request_id,request_fingerprint,
      kind,quote_asset,origin_currency,origin_amount,amount_quote,fx_rate,fx_observed_at,evidence,reason)
  values(v_operator.product_id,v_operator.tenant_id,v_operator.user_id,p_operator_id,p_account_id,
    p_request_id,v_fingerprint,p_kind,p_quote_asset,p_origin_currency,p_origin_amount,
    p_amount_quote,p_fx_rate,p_fx_observed_at,nullif(btrim(coalesce(p_evidence,'')),''),btrim(p_reason))
  returning * into v_batch;
  for v_item in select value from jsonb_array_elements(p_allocations) loop
    if jsonb_typeof(v_item)<>'object' or not (v_item ?& array['engineId','slotNumber','amount','gainUnits','balanceBefore','operationSequence','monthlyBefore','lifetimeBefore'])
      or (select count(*) from jsonb_object_keys(v_item))<>8 then
      raise exception 'COINOPS_LIVE_ADJUSTMENT_ITEM_DENIED';
    end if;
    select * into v_engine from coinops.trading_engines
      where id=(v_item->>'engineId')::uuid and exchange_account_id=p_account_id
        and operator_id=p_operator_id and environment='REAL' and quote_asset=p_quote_asset for update;
    v_number:=(v_item->>'slotNumber')::integer;
    v_delta:=(v_item->>'amount')::numeric;
    v_units:=(v_item->>'gainUnits')::integer;
    if v_engine.id is null or v_engine.status<>'ACTIVE' or v_number not between 1 and 25
      or (v_engine.id::text||':'||v_number::text)=any(v_seen)
      or v_delta is null or v_units is null or v_delta<>round(v_delta,2)
      or p_kind='CAPITAL' and (v_delta<=0 or v_units<>0)
      or p_kind='MANUAL_GAIN' and (v_delta<>0 or v_units not between 1 and 25) then
      raise exception 'COINOPS_LIVE_ADJUSTMENT_ITEM_DENIED';
    end if;
    v_seen:=array_append(v_seen,v_engine.id::text||':'||v_number::text);
    v_physical_slot_id:=case when v_engine.legacy_compatible then
      'REAL:'||v_operator.product_id::text||':'||v_operator.tenant_id::text||':'||
        v_operator.user_id::text||':'||v_engine.base_asset||':'||v_number::text
      else 'REAL:'||v_engine.id::text||':'||v_number::text end;
    select * into v_run from coinops.robot_v1_live_runs
      where trading_engine_id=v_engine.id and status in ('ACTIVE','PAUSED') for update;
    if v_run.id is null or v_run.lease_until>now() then raise exception 'COINOPS_LIVE_ADJUSTMENT_ENGINE_BUSY'; end if;
    select * into v_slot from coinops.robot_v1_live_slots
      where run_id=v_run.id and trading_engine_id=v_engine.id and slot_number=v_number for share;
    select * into v_slot_account from coinops.robot_v1_live_slot_accounts
      where trading_engine_id=v_engine.id and slot_number=v_number for update;
    if v_slot.id is null or v_slot_account.trading_engine_id is null
      or v_slot_account.balance_brl<>(v_item->>'balanceBefore')::numeric
      or v_slot.operation_sequence<>(v_item->>'operationSequence')::integer then
      raise exception 'COINOPS_LIVE_ADJUSTMENT_PREVIEW_STALE';
    end if;
    if exists(select 1 from coinops.robot_v1_monthly_slot_gains
      where trading_engine_id=v_engine.id and environment='REAL' and slot_number=v_number
        and physical_slot_id<>v_physical_slot_id) then
      raise exception 'COINOPS_LIVE_ADJUSTMENT_PHYSICAL_SLOT_MISMATCH';
    end if;
    select coalesce(sum(gain_units),0)::integer,
      coalesce(sum(gain_units) filter(where period_key=v_period),0)::integer
      into v_lifetime,v_monthly from coinops.robot_v1_monthly_slot_gains
      where trading_engine_id=v_engine.id and environment='REAL' and slot_number=v_number;
    if v_lifetime<>(v_item->>'lifetimeBefore')::integer
      or v_monthly<>(v_item->>'monthlyBefore')::integer then
      raise exception 'COINOPS_LIVE_ADJUSTMENT_PREVIEW_STALE';
    end if;
    insert into coinops.robot_v1_live_adjustment_items
      (batch_id,product_id,tenant_id,user_id,operator_id,exchange_account_id,trading_engine_id,
        symbol,quote_asset,slot_number,physical_slot_id,amount_quote,gain_units,balance_before,balance_after,
        monthly_before,monthly_after,lifetime_before,lifetime_after,open_at_time,position_committed_quote,
        operation_sequence,period_key)
    values(v_batch.id,v_operator.product_id,v_operator.tenant_id,v_operator.user_id,p_operator_id,
      p_account_id,v_engine.id,v_engine.symbol,p_quote_asset,v_number,
      v_physical_slot_id,v_delta,v_units,
      v_slot_account.balance_brl,v_slot_account.balance_brl+v_delta,
      v_monthly,v_monthly+v_units,v_lifetime,v_lifetime+v_units,
      v_slot.entry_state='OPEN',v_slot.position_committed_brl,v_slot.operation_sequence,v_period)
    returning id into v_item_id;
    update coinops.robot_v1_live_slot_accounts set balance_brl=balance_brl+v_delta,
      contribution_brl=contribution_brl+v_delta,gain_count=gain_count+v_units
      where trading_engine_id=v_engine.id and slot_number=v_number;
    if v_units>0 then
      insert into coinops.robot_v1_monthly_slot_gains
        (environment,source_id,product_id,tenant_id,user_id,operator_id,exchange_account_id,
          trading_engine_id,quote_asset,asset,slot_number,physical_slot_id,
          credited_at,effective_gain_at,evidence_basis,period_key,gain_units)
      values('REAL',v_item_id,v_operator.product_id,v_operator.tenant_id,v_operator.user_id,
        p_operator_id,p_account_id,v_engine.id,p_quote_asset,v_engine.base_asset,v_number,
        v_physical_slot_id,
        now(),now(),'MANUAL_TARGET_GAIN',v_period,v_units);
    end if;
    v_total:=v_total+v_delta;
  end loop;
  if v_total<>p_amount_quote then raise exception 'COINOPS_LIVE_ADJUSTMENT_SUM_MISMATCH'; end if;
  if p_kind='CAPITAL' then
    for v_engine in select * from coinops.trading_engines
      where id in (select distinct trading_engine_id from coinops.robot_v1_live_adjustment_items where batch_id=v_batch.id)
      order by id for update loop
      select sum(amount_quote) into v_engine_delta from coinops.robot_v1_live_adjustment_items
        where batch_id=v_batch.id and trading_engine_id=v_engine.id;
      if v_account.is_legacy_default and
        v_engine.hard_cap_quote+v_engine_delta>(case v_engine.base_asset when 'BTC' then 450 else 275 end) then
        raise exception 'COINOPS_LIVE_ADJUSTMENT_LEGACY_CAP_DENIED';
      end if;
      update coinops.trading_engines set hard_cap_quote=hard_cap_quote+v_engine_delta where id=v_engine.id;
      update coinops.robot_v1_live_preparations set
        configured_live_capital_brl=configured_live_capital_brl+v_engine_delta,
        max_order_notional_brl=max_order_notional_brl+v_engine_delta,
        max_total_exposure_brl=max_total_exposure_brl+v_engine_delta,
        config_version=config_version+1
        where trading_engine_id=v_engine.id;
      if not found then raise exception 'COINOPS_LIVE_ADJUSTMENT_PREPARATION_MISSING'; end if;
    end loop;
    if v_account.is_legacy_default and v_cap.hard_cap_quote+p_amount_quote>725 then
      raise exception 'COINOPS_LIVE_ADJUSTMENT_LEGACY_CAP_DENIED';
    end if;
    update coinops.account_quote_caps set hard_cap_quote=hard_cap_quote+p_amount_quote,
      updated_at=now() where exchange_account_id=p_account_id and quote_asset=p_quote_asset;
  end if;
  return jsonb_build_object('id',v_batch.id,'status','APPLIED','amount_quote',p_amount_quote,
    'item_count',jsonb_array_length(p_allocations));
end $$;
revoke all on function coinops.apply_live_operator_adjustment(uuid,uuid,uuid,text,text,text,numeric,numeric,numeric,timestamptz,text,text,jsonb,numeric,uuid)
  from public,anon,authenticated;
grant execute on function coinops.apply_live_operator_adjustment(uuid,uuid,uuid,text,text,text,numeric,numeric,numeric,timestamptz,text,text,jsonb,numeric,uuid)
  to service_role;
commit;
