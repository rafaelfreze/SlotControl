-- Selective capital contributions for an explicit subset of one LIVE engine.
-- OPEN positions remain immutable: their allocation is applied atomically only
-- after the proven TP settlement. This migration creates no contribution.
begin;
set local lock_timeout='3s';
set local statement_timeout='60s';

create table coinops.robot_v1_live_selective_contribution_batches (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  operator_id uuid not null,
  exchange_account_id uuid not null,
  trading_engine_id uuid not null,
  request_id uuid not null,
  request_fingerprint text not null check(request_fingerprint ~ '^[a-f0-9]{64}$'),
  quote_asset text not null check(quote_asset in ('BRL','USDT')),
  origin_currency text not null check(origin_currency in ('BRL','USDT')),
  origin_amount numeric(20,8) not null check(origin_amount>0),
  amount_quote numeric(20,8) not null check(amount_quote>0 and amount_quote=round(amount_quote,2)),
  evidence text,
  reason text not null check(length(btrim(reason)) between 3 and 160),
  source text not null default 'ADMIN_SELECTED_SLOTS'
    check(source='ADMIN_SELECTED_SLOTS'),
  created_at timestamptz not null default now(),
  unique(exchange_account_id,request_id),
  unique(id,trading_engine_id),
  foreign key(operator_id,product_id,tenant_id,user_id)
    references coinops.operators(id,product_id,tenant_id,user_id) on delete restrict,
  foreign key(exchange_account_id,operator_id)
    references coinops.exchange_accounts(id,operator_id) on delete restrict,
  foreign key(trading_engine_id,operator_id,exchange_account_id,quote_asset)
    references coinops.trading_engines(id,operator_id,exchange_account_id,quote_asset) on delete restrict
);

create table coinops.robot_v1_live_selective_contribution_allocations (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null,
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  operator_id uuid not null,
  exchange_account_id uuid not null,
  trading_engine_id uuid not null,
  symbol text not null,
  quote_asset text not null check(quote_asset in ('BRL','USDT')),
  slot_number integer not null check(slot_number between 1 and 25),
  amount_quote numeric(20,8) not null check(amount_quote>0 and amount_quote=round(amount_quote,2)),
  status text not null check(status in ('PENDING','APPLIED','CANCELLED')),
  source text not null default 'ADMIN_SELECTED_SLOTS' check(source='ADMIN_SELECTED_SLOTS'),
  slot_state_at_creation text not null check(slot_state_at_creation in ('PLANNED','ARMED','OPEN','CLOSED','MISSED')),
  operation_sequence_at_creation integer not null check(operation_sequence_at_creation>0),
  balance_before numeric(20,8) not null check(balance_before>=0),
  created_at timestamptz not null default now(),
  applied_at timestamptz,
  applied_operation_sequence integer check(applied_operation_sequence>0),
  cancelled_at timestamptz,
  unique(batch_id,trading_engine_id,slot_number),
  constraint selective_allocation_status_fields check(
    (status='PENDING' and applied_at is null and applied_operation_sequence is null and cancelled_at is null)
    or (status='APPLIED' and applied_at is not null and applied_operation_sequence is not null and cancelled_at is null)
    or (status='CANCELLED' and applied_at is null and applied_operation_sequence is null and cancelled_at is not null)
  ),
  foreign key(batch_id,trading_engine_id)
    references coinops.robot_v1_live_selective_contribution_batches(id,trading_engine_id) on delete restrict,
  foreign key(operator_id,product_id,tenant_id,user_id)
    references coinops.operators(id,product_id,tenant_id,user_id) on delete restrict,
  foreign key(exchange_account_id,operator_id)
    references coinops.exchange_accounts(id,operator_id) on delete restrict,
  foreign key(trading_engine_id,operator_id,exchange_account_id,quote_asset)
    references coinops.trading_engines(id,operator_id,exchange_account_id,quote_asset) on delete restrict
);
create index robot_v1_live_selective_allocations_slot_status_idx
  on coinops.robot_v1_live_selective_contribution_allocations
  (trading_engine_id,slot_number,status,created_at);

create trigger robot_v1_live_selective_batches_immutable
  before update or delete on coinops.robot_v1_live_selective_contribution_batches
  for each row execute function coinops.reject_live_adjustment_mutation();

create function private.coinops_guard_selective_allocation_update() returns trigger
language plpgsql set search_path='' as $$
begin
  if tg_op='DELETE' then raise exception 'COINOPS_SELECTIVE_CONTRIBUTION_IMMUTABLE'; end if;
  if (to_jsonb(new)-'status'-'applied_at'-'applied_operation_sequence'-'cancelled_at')
    is distinct from (to_jsonb(old)-'status'-'applied_at'-'applied_operation_sequence'-'cancelled_at')
    or old.status<>'PENDING' or new.status not in ('APPLIED','CANCELLED') then
    raise exception 'COINOPS_SELECTIVE_CONTRIBUTION_IMMUTABLE';
  end if;
  return new;
end $$;
revoke all on function private.coinops_guard_selective_allocation_update() from public,anon,authenticated;
create trigger robot_v1_live_selective_allocations_guard
  before update or delete on coinops.robot_v1_live_selective_contribution_allocations
  for each row execute function private.coinops_guard_selective_allocation_update();

alter table coinops.robot_v1_live_selective_contribution_batches enable row level security;
alter table coinops.robot_v1_live_selective_contribution_batches force row level security;
alter table coinops.robot_v1_live_selective_contribution_allocations enable row level security;
alter table coinops.robot_v1_live_selective_contribution_allocations force row level security;
create policy selective_contribution_batches_owner_read
  on coinops.robot_v1_live_selective_contribution_batches for select to authenticated
  using(private.coinops_operator_owned(operator_id));
create policy selective_contribution_allocations_owner_read
  on coinops.robot_v1_live_selective_contribution_allocations for select to authenticated
  using(private.coinops_operator_owned(operator_id));
revoke all on coinops.robot_v1_live_selective_contribution_batches,
  coinops.robot_v1_live_selective_contribution_allocations from public,anon,authenticated;
grant select on coinops.robot_v1_live_selective_contribution_batches,
  coinops.robot_v1_live_selective_contribution_allocations to authenticated;
grant all on coinops.robot_v1_live_selective_contribution_batches,
  coinops.robot_v1_live_selective_contribution_allocations to service_role;

create function coinops.apply_live_selective_contribution(
  p_operator_id uuid,p_account_id uuid,p_engine_id uuid,p_created_by uuid,
  p_quote_asset text,p_origin_currency text,p_origin_amount numeric,p_amount_quote numeric,
  p_evidence text,p_reason text,p_allocations jsonb,p_expected_account_cap numeric,
  p_request_id uuid,p_request_fingerprint text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_operator coinops.operators%rowtype;
  v_account coinops.exchange_accounts%rowtype;
  v_engine coinops.trading_engines%rowtype;
  v_cap coinops.account_quote_caps%rowtype;
  v_batch coinops.robot_v1_live_selective_contribution_batches%rowtype;
  v_run coinops.robot_v1_live_runs%rowtype;
  v_slot coinops.robot_v1_live_slots%rowtype;
  v_slot_account coinops.robot_v1_live_slot_accounts%rowtype;
  v_item jsonb;
  v_number integer;
  v_amount numeric;
  v_total numeric:=0;
  v_pending integer:=0;
  v_applied integer:=0;
  v_seen integer[]:='{}';
begin
  if coalesce(nullif(current_setting('request.jwt.claim.role',true),''),auth.jwt()->>'role','')<>'service_role'
    or p_operator_id is null or p_account_id is null or p_engine_id is null or p_created_by is null
    or p_request_id is null or p_quote_asset not in ('BRL','USDT')
    or p_origin_currency not in ('BRL','USDT') or p_origin_amount is null or p_origin_amount<=0
    or p_amount_quote is null or p_amount_quote<=0 or p_amount_quote<>round(p_amount_quote,2)
    or p_expected_account_cap is null or length(btrim(coalesce(p_reason,''))) not between 3 and 160
    or p_request_fingerprint !~ '^[a-f0-9]{64}$'
    or jsonb_typeof(p_allocations)<>'array' or jsonb_array_length(p_allocations) not between 1 and 25 then
    raise exception 'COINOPS_SELECTIVE_CONTRIBUTION_INPUT_DENIED';
  end if;
  -- Serialize the natural idempotency key before the first lookup. Concurrent
  -- double-clicks therefore converge to the committed batch instead of racing
  -- the unique constraint or applying the cap twice.
  perform pg_advisory_xact_lock(hashtextextended(p_account_id::text||':'||p_request_id::text,0));
  select * into v_batch from coinops.robot_v1_live_selective_contribution_batches
    where exchange_account_id=p_account_id and request_id=p_request_id;
  if v_batch.id is not null then
    if v_batch.request_fingerprint<>p_request_fingerprint then
      raise exception 'COINOPS_SELECTIVE_CONTRIBUTION_REPLAY_CONFLICT';
    end if;
    return jsonb_build_object('id',v_batch.id,'status','REPLAYED','amount_quote',v_batch.amount_quote,
      'item_count',(select count(*) from coinops.robot_v1_live_selective_contribution_allocations where batch_id=v_batch.id),
      'pending_count',(select count(*) from coinops.robot_v1_live_selective_contribution_allocations where batch_id=v_batch.id and status='PENDING'));
  end if;
  select * into v_operator from coinops.operators where id=p_operator_id for share;
  select * into v_account from coinops.exchange_accounts
    where id=p_account_id and operator_id=p_operator_id for share;
  select * into v_engine from coinops.trading_engines
    where id=p_engine_id and operator_id=p_operator_id and exchange_account_id=p_account_id
      and environment='REAL' and quote_asset=p_quote_asset for update;
  select * into v_cap from coinops.account_quote_caps
    where exchange_account_id=p_account_id and operator_id=p_operator_id and quote_asset=p_quote_asset for update;
  select * into v_run from coinops.robot_v1_live_runs
    where trading_engine_id=p_engine_id and status in ('ACTIVE','PAUSED') for update;
  if v_operator.id is null or v_operator.status<>'ACTIVE' or v_operator.user_id<>p_created_by
    or v_account.id is null or v_account.status<>'ACTIVE'
    or v_engine.id is null or v_engine.status<>'ACTIVE' or v_engine.kill_switch
    or v_cap.exchange_account_id is null or v_cap.hard_cap_quote<>p_expected_account_cap
    or v_run.id is null or v_run.lease_until>now() then
    raise exception 'COINOPS_SELECTIVE_CONTRIBUTION_SCOPE_DENIED';
  end if;
  insert into coinops.robot_v1_live_selective_contribution_batches
    (product_id,tenant_id,user_id,operator_id,exchange_account_id,trading_engine_id,
      request_id,request_fingerprint,quote_asset,origin_currency,origin_amount,
      amount_quote,evidence,reason)
  values(v_operator.product_id,v_operator.tenant_id,v_operator.user_id,p_operator_id,p_account_id,
    p_engine_id,p_request_id,p_request_fingerprint,p_quote_asset,p_origin_currency,p_origin_amount,
    p_amount_quote,nullif(btrim(coalesce(p_evidence,'')),''),btrim(p_reason)) returning * into v_batch;
  for v_item in select value from jsonb_array_elements(p_allocations) loop
    if jsonb_typeof(v_item)<>'object'
      or not (v_item ?& array['engineId','slotNumber','amount','balanceBefore','operationSequence'])
      or (select count(*) from jsonb_object_keys(v_item))<>5
      or (v_item->>'engineId')::uuid<>p_engine_id then
      raise exception 'COINOPS_SELECTIVE_CONTRIBUTION_ITEM_DENIED';
    end if;
    v_number:=(v_item->>'slotNumber')::integer;
    v_amount:=(v_item->>'amount')::numeric;
    if v_number not between 1 and 25 or v_number=any(v_seen)
      or v_amount is null or v_amount<=0 or v_amount<>round(v_amount,2) then
      raise exception 'COINOPS_SELECTIVE_CONTRIBUTION_ITEM_DENIED';
    end if;
    v_seen:=array_append(v_seen,v_number);
    select * into v_slot from coinops.robot_v1_live_slots
      where run_id=v_run.id and trading_engine_id=p_engine_id and slot_number=v_number for share;
    select * into v_slot_account from coinops.robot_v1_live_slot_accounts
      where trading_engine_id=p_engine_id and slot_number=v_number for update;
    if v_slot.id is null or v_slot_account.trading_engine_id is null
      or v_slot_account.balance_brl<>(v_item->>'balanceBefore')::numeric
      or v_slot.operation_sequence<>(v_item->>'operationSequence')::integer then
      raise exception 'COINOPS_SELECTIVE_CONTRIBUTION_PREVIEW_STALE';
    end if;
    insert into coinops.robot_v1_live_selective_contribution_allocations
      (batch_id,product_id,tenant_id,user_id,operator_id,exchange_account_id,trading_engine_id,
        symbol,quote_asset,slot_number,amount_quote,status,slot_state_at_creation,
        operation_sequence_at_creation,balance_before,applied_at,applied_operation_sequence)
    values(v_batch.id,v_operator.product_id,v_operator.tenant_id,v_operator.user_id,p_operator_id,
      p_account_id,p_engine_id,v_engine.symbol,p_quote_asset,v_number,v_amount,
      case when v_slot.entry_state='OPEN' then 'PENDING' else 'APPLIED' end,v_slot.entry_state,
      v_slot.operation_sequence,v_slot_account.balance_brl,
      case when v_slot.entry_state='OPEN' then null else now() end,
      case when v_slot.entry_state='OPEN' then null else v_slot.operation_sequence end);
    if v_slot.entry_state='OPEN' then v_pending:=v_pending+1;
    else
      update coinops.robot_v1_live_slot_accounts set
        balance_brl=balance_brl+v_amount,contribution_brl=contribution_brl+v_amount
        where trading_engine_id=p_engine_id and slot_number=v_number;
      v_applied:=v_applied+1;
    end if;
    v_total:=v_total+v_amount;
  end loop;
  if v_total<>p_amount_quote then raise exception 'COINOPS_SELECTIVE_CONTRIBUTION_SUM_MISMATCH'; end if;
  update coinops.trading_engines set hard_cap_quote=hard_cap_quote+p_amount_quote where id=p_engine_id;
  update coinops.robot_v1_live_preparations set
    configured_live_capital_brl=configured_live_capital_brl+p_amount_quote,
    max_order_notional_brl=max_order_notional_brl+p_amount_quote,
    max_total_exposure_brl=max_total_exposure_brl+p_amount_quote,config_version=config_version+1
    where trading_engine_id=p_engine_id;
  if not found then raise exception 'COINOPS_SELECTIVE_CONTRIBUTION_PREPARATION_MISSING'; end if;
  update coinops.account_quote_caps set hard_cap_quote=hard_cap_quote+p_amount_quote,updated_at=now()
    where exchange_account_id=p_account_id and quote_asset=p_quote_asset;
  return jsonb_build_object('id',v_batch.id,'status','APPLIED','amount_quote',p_amount_quote,
    'item_count',jsonb_array_length(p_allocations),'pending_count',v_pending,'applied_count',v_applied);
end $$;
revoke all on function coinops.apply_live_selective_contribution(uuid,uuid,uuid,uuid,text,text,numeric,numeric,text,text,jsonb,numeric,uuid,text)
  from public,anon,authenticated;
grant execute on function coinops.apply_live_selective_contribution(uuid,uuid,uuid,uuid,text,text,numeric,numeric,text,text,jsonb,numeric,uuid,text)
  to service_role;

-- Same official TP settlement, with pending capital applied after the old
-- position and gain are finalized and before the slot can be planned again.
create or replace function coinops.credit_robot_v1_live_closed_slot(
  p_run_id uuid,p_slot_id uuid,p_operation_sequence integer,
  p_tp_client_order_id text,p_quantity_step numeric,p_lease_owner uuid
) returns coinops.robot_v1_live_slot_accounts language plpgsql
security definer set search_path='' as $$
declare
  v_run coinops.robot_v1_live_runs%rowtype;
  v_slot coinops.robot_v1_live_slots%rowtype;
  v_account coinops.robot_v1_live_slot_accounts%rowtype;
  v_tp coinops.robot_v1_live_orders%rowtype;
  v_buy_quantity numeric; v_sold_quantity numeric; v_buy_quote numeric; v_sell_quote numeric;
  v_fee_brl numeric; v_dust numeric; v_dust_basis numeric; v_gross_pnl numeric; v_net_pnl numeric;
  v_fill_at timestamptz; v_pending numeric:=0; v_pending_count integer:=0;
begin
  select * into strict v_run from coinops.robot_v1_live_runs where id=p_run_id for update;
  select * into strict v_slot from coinops.robot_v1_live_slots where id=p_slot_id and run_id=p_run_id for update;
  select * into strict v_account from coinops.robot_v1_live_slot_accounts
    where product_id=v_run.product_id and tenant_id=v_run.tenant_id and user_id=v_run.user_id
      and trading_engine_id=v_run.trading_engine_id and asset=v_run.asset and slot_number=v_slot.slot_number for update;
  if v_run.lease_owner is distinct from p_lease_owner or p_lease_owner is null
    or v_run.lease_until is null or v_run.lease_until<=now() or p_quantity_step<=0
    or p_operation_sequence<>v_slot.operation_sequence then
    raise exception 'COINOPS_LIVE_CREDIT_LEASE_OR_SEQUENCE_INVALID';
  end if;
  if v_slot.last_credited_sell_client_order_id=p_tp_client_order_id then return v_account; end if;
  select * into strict v_tp from coinops.robot_v1_live_orders where run_id=p_run_id
    and slot_id=p_slot_id and operation_sequence=p_operation_sequence
    and client_order_id=p_tp_client_order_id and side='SELL' and purpose='TP';
  if v_tp.status<>'FILLED' or not v_tp.trades_reconciled or v_slot.entry_state<>'OPEN'
    or v_slot.position_quantity>=p_quantity_step
    or exists(select 1 from coinops.robot_v1_live_orders o where o.run_id=p_run_id
      and o.slot_id=p_slot_id and o.operation_sequence=p_operation_sequence
      and (o.status not in ('FILLED','CANCELED','EXPIRED','EXPIRED_IN_MATCH','REJECTED')
        or o.executed_quantity>0 and not o.trades_reconciled)) then
    raise exception 'COINOPS_LIVE_TP_CLOSURE_NOT_PROVEN';
  end if;
  select coalesce(sum(o.executed_quantity-o.fee_base),0),coalesce(sum(o.cumulative_quote),0)
    into v_buy_quantity,v_buy_quote from coinops.robot_v1_live_orders o
    where o.run_id=p_run_id and o.slot_id=p_slot_id and o.operation_sequence=p_operation_sequence and o.side='BUY';
  select coalesce(sum(o.executed_quantity+o.fee_base),0),coalesce(sum(o.cumulative_quote),0)
    into v_sold_quantity,v_sell_quote from coinops.robot_v1_live_orders o
    where o.run_id=p_run_id and o.slot_id=p_slot_id and o.operation_sequence=p_operation_sequence and o.side='SELL';
  select coalesce(sum(f.commission_brl),0) into v_fee_brl
    from coinops.robot_v1_live_fills f join coinops.robot_v1_live_orders o on o.id=f.order_id
    where o.run_id=p_run_id and o.slot_id=p_slot_id and o.operation_sequence=p_operation_sequence
      and f.commission_asset in ('BNB',v_run.quote_asset);
  select max(f.filled_at) into v_fill_at from coinops.robot_v1_live_fills f where f.order_id=v_tp.id;
  v_dust:=v_buy_quantity-v_sold_quantity;
  if v_buy_quantity<=0 or v_sold_quantity<=0 or v_dust< -0.000000000001 or v_dust>=p_quantity_step
    or abs(v_dust-v_slot.position_quantity)>0.000000000001 or v_fill_at is null then
    raise exception 'COINOPS_LIVE_POSITION_CLOSURE_MISMATCH';
  end if;
  v_dust_basis:=round(v_buy_quote*greatest(v_dust,0)/v_buy_quantity,8);
  v_gross_pnl:=round(v_sell_quote-v_buy_quote+v_dust_basis,8);
  v_net_pnl:=v_gross_pnl-v_fee_brl;
  update coinops.robot_v1_live_slot_accounts set
    balance_brl=balance_brl+v_sell_quote-v_buy_quote-v_fee_brl,
    market_pnl_brl=market_pnl_brl+v_gross_pnl,fees_brl=fees_brl+v_fee_brl,
    dust_quantity=dust_quantity+greatest(v_dust,0),dust_cost_brl=dust_cost_brl+v_dust_basis,
    gain_count=gain_count+case when v_net_pnl>0 then 1 else 0 end
    where trading_engine_id=v_run.trading_engine_id and slot_number=v_slot.slot_number returning * into v_account;
  update coinops.robot_v1_live_slots set entry_state='CLOSED',position_quantity=0,position_committed_brl=0,
    last_take_profit_price=v_tp.price,last_credited_sell_client_order_id=p_tp_client_order_id where id=v_slot.id;
  insert into coinops.robot_v1_live_events(run_id,product_id,tenant_id,user_id,event_key,event_type,slot_number,details)
  values(v_run.id,v_run.product_id,v_run.tenant_id,v_run.user_id,p_tp_client_order_id||':CREDITED',
    'SLOT_PROFIT_CREDITED',v_slot.slot_number,jsonb_build_object('tp_client_order_id',p_tp_client_order_id,
      'buy_quote_brl',v_buy_quote,'sell_quote_brl',v_sell_quote,'fees_brl',v_fee_brl,
      'dust_quantity',greatest(v_dust,0),'dust_basis_brl',v_dust_basis,'gross_pnl_brl',v_gross_pnl,
      'net_pnl_brl',v_net_pnl,'balance_after_brl',v_account.balance_brl,'gain_count_after',v_account.gain_count))
  on conflict(run_id,event_key) do nothing;
  if v_net_pnl>0 then
    insert into coinops.robot_v1_monthly_slot_gains(environment,source_id,product_id,tenant_id,user_id,
      asset,slot_number,physical_slot_id,credited_at,effective_gain_at,evidence_basis,period_key)
    values('REAL',v_tp.id,v_run.product_id,v_run.tenant_id,v_run.user_id,v_run.asset,v_slot.slot_number,
      'REAL:'||v_run.product_id||':'||v_run.tenant_id||':'||v_run.user_id||':'||v_run.asset||':'||v_slot.slot_number,
      now(),v_fill_at,'REAL_EXCHANGE_FILL',to_char(v_fill_at at time zone 'America/Campo_Grande','YYYY-MM'));
  end if;
  with applied as (
    update coinops.robot_v1_live_selective_contribution_allocations set status='APPLIED',applied_at=now(),
      applied_operation_sequence=v_slot.operation_sequence+1
    where trading_engine_id=v_run.trading_engine_id and slot_number=v_slot.slot_number and status='PENDING'
    returning amount_quote
  ) select coalesce(sum(amount_quote),0),count(*) into v_pending,v_pending_count from applied;
  if v_pending>0 then
    update coinops.robot_v1_live_slot_accounts set balance_brl=balance_brl+v_pending,
      contribution_brl=contribution_brl+v_pending
      where trading_engine_id=v_run.trading_engine_id and slot_number=v_slot.slot_number returning * into v_account;
    insert into coinops.robot_v1_live_events(run_id,product_id,tenant_id,user_id,event_key,event_type,slot_number,details)
    values(v_run.id,v_run.product_id,v_run.tenant_id,v_run.user_id,
      p_tp_client_order_id||':SELECTIVE_CONTRIBUTION_APPLIED','SELECTIVE_CONTRIBUTION_APPLIED',v_slot.slot_number,
      jsonb_build_object('amount_quote',v_pending,'allocation_count',v_pending_count,
        'applied_operation_sequence',v_slot.operation_sequence+1,'balance_after',v_account.balance_brl))
    on conflict(run_id,event_key) do nothing;
  end if;
  return v_account;
end $$;

commit;
