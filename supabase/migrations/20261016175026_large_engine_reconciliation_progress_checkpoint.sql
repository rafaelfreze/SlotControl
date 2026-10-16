-- CoinOps / OnPlay Platform otdfpmsegjxpqrzisfmi, schema coinops.
-- A progress checkpoint is NOT completed reconciliation or trading authority.
-- Existing ledger, RLS, order ownership and last_reconciled_at stay unchanged.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

alter table coinops.robot_v1_live_runs
  add column if not exists reconciliation_checkpoint jsonb;
comment on column coinops.robot_v1_live_runs.reconciliation_checkpoint is
  'LARGE_ENGINE_PROGRESS_V1: bounded, lease-fenced monotonic progress only; never full reconciliation freshness.';

create or replace function coinops.record_live_reconciliation_checkpoint(
  p_run_id uuid, p_lease_owner uuid, p_phase text, p_quantity_step numeric
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  r coinops.robot_v1_live_runs%rowtype;
  e coinops.trading_engines%rowtype;
  prep coinops.robot_v1_live_preparations%rowtype;
  previous jsonb; checkpoint jsonb; identity jsonb;
  observed timestamptz := clock_timestamp(); started timestamptz;
  previous_observed timestamptz; previous_started timestamptz;
  settled bigint; gains bigint; operations bigint;
  previous_settled bigint; previous_gains bigint; previous_operations bigint;
  owner_prefix text; v_event_key text; n integer; updated integer;
begin
  if coalesce(nullif(current_setting('request.jwt.claim.role',true),''),auth.jwt()->>'role','') <> 'service_role'
    or p_run_id is null then
    raise exception 'COINOPS_LIVE_LARGE_ENGINE_PROGRESS_SCOPE_DENIED';
  end if;
  if p_phase is null or p_phase not in ('CREDIT_SLOTS','RECYCLE_SLOTS')
    or p_quantity_step is null or p_quantity_step <= 0 or p_quantity_step > 1
    or p_quantity_step::text in ('NaN','Infinity','-Infinity') then
    raise exception 'COINOPS_LIVE_LARGE_ENGINE_PROGRESS_INVALID';
  end if;
  select * into r from coinops.robot_v1_live_runs where id=p_run_id for update;
  if not found then raise exception 'COINOPS_LIVE_LARGE_ENGINE_PROGRESS_SCOPE_DENIED'; end if;
  if p_lease_owner is null or r.lease_owner is distinct from p_lease_owner
    or r.lease_until is null or r.lease_until <= clock_timestamp() then
    raise exception 'COINOPS_LIVE_LARGE_ENGINE_PROGRESS_LEASE_DENIED';
  end if;
  select * into e from coinops.trading_engines where id=r.trading_engine_id;
  if not found or e.environment is distinct from 'REAL' or r.status is distinct from 'ACTIVE'
    or e.operator_id is distinct from r.operator_id or e.exchange_account_id is distinct from r.exchange_account_id
    or e.symbol is distinct from r.symbol or e.base_asset is distinct from r.asset
    or e.quote_asset is distinct from r.quote_asset or e.slot_count is distinct from r.slot_count
    or e.slot_count <= 25 or e.slot_count > 100 or e.legacy_compatible is distinct from false
    or e.executor_shard_id is null or e.executor_shard_id !~ '^executor-[0-9]{2,4}$'
    or not exists(select 1 from coinops.executor_shards sh where sh.id=e.executor_shard_id and sh.enabled)
    or not exists(select 1 from coinops.operators op where op.id=r.operator_id
      and op.product_id=r.product_id and op.tenant_id=r.tenant_id and op.user_id=r.user_id
      and op.status='ACTIVE' and not op.kill_switch)
    or not exists(select 1 from coinops.exchange_accounts a where a.id=r.exchange_account_id
      and a.operator_id=r.operator_id and a.status='ACTIVE' and not a.kill_switch) then
    raise exception 'COINOPS_LIVE_LARGE_ENGINE_PROGRESS_SCOPE_DENIED';
  end if;
  if e.status is distinct from 'ACTIVE' or e.kill_switch is distinct from false
    or e.strategy_config_pending is distinct from false or r.last_error is not null
    or exists(select 1 from coinops.robot_v1_live_alerts a where a.trading_engine_id=e.id
      and a.severity='CRITICAL' and a.resolved_at is null) then
    raise exception 'COINOPS_LIVE_LARGE_ENGINE_PROGRESS_UNSAFE';
  end if;
  select * into prep from coinops.robot_v1_live_preparations where trading_engine_id=e.id;
  if not found or prep.product_id is distinct from r.product_id or prep.tenant_id is distinct from r.tenant_id
    or prep.user_id is distinct from r.user_id or prep.operator_id is distinct from r.operator_id
    or prep.exchange_account_id is distinct from r.exchange_account_id or prep.asset is distinct from r.asset
    or prep.symbol is distinct from r.symbol or prep.quote_asset is distinct from r.quote_asset
    or prep.slot_count is distinct from e.slot_count or prep.kill_switch is distinct from false
    or prep.live_enabled is distinct from true then
    raise exception 'COINOPS_LIVE_LARGE_ENGINE_PROGRESS_UNSAFE';
  end if;
  n:=e.slot_count;
  -- Canonical complete physical sets, never inferred from a partial page.
  if (select count(*) from coinops.robot_v1_live_slots s where s.run_id=r.id) <> n
    or (select count(distinct slot_number) from coinops.robot_v1_live_slots s where s.run_id=r.id) <> n
    or exists(select 1 from coinops.robot_v1_live_slots s where s.run_id=r.id
      and (s.slot_number not between 1 and n or s.slot_number is null
        or s.product_id is distinct from r.product_id or s.tenant_id is distinct from r.tenant_id
        or s.user_id is distinct from r.user_id or s.operator_id is distinct from r.operator_id
        or s.exchange_account_id is distinct from r.exchange_account_id
        or s.trading_engine_id is distinct from r.trading_engine_id or s.quote_asset is distinct from r.quote_asset
        or s.operation_sequence is null or s.operation_sequence <= 0
        or s.position_quantity is null or s.position_quantity < 0
        or s.position_quantity::text in ('NaN','Infinity','-Infinity')))
    or (select count(*) from coinops.robot_v1_live_slot_accounts a where a.trading_engine_id=e.id) <> n
    or (select count(distinct slot_number) from coinops.robot_v1_live_slot_accounts a where a.trading_engine_id=e.id) <> n
    or exists(select 1 from coinops.robot_v1_live_slot_accounts a where a.trading_engine_id=e.id
      and (a.slot_number not between 1 and n or a.slot_number is null
        or a.product_id is distinct from r.product_id or a.tenant_id is distinct from r.tenant_id
        or a.user_id is distinct from r.user_id or a.operator_id is distinct from r.operator_id
        or a.exchange_account_id is distinct from r.exchange_account_id or a.quote_asset is distinct from r.quote_asset
        or a.asset is distinct from r.asset or a.gain_count is null or a.gain_count < 0)) then
    raise exception 'COINOPS_LIVE_LARGE_ENGINE_PROGRESS_UNSAFE';
  end if;
  owner_prefix:='C2-'||substr(encode(sha256(convert_to(r.exchange_account_id::text||'|'||e.id::text,'UTF8')),'hex'),1,10)||'-';
  if e.order_owner_prefix is distinct from owner_prefix then
    raise exception 'COINOPS_LIVE_LARGE_ENGINE_PROGRESS_SCOPE_DENIED';
  end if;
  -- Reject unknown/prepared dispatches, unaccounted fills, foreign operation
  -- rows and namespaces. The caller cannot assert ownership with a boolean.
  if exists(select 1 from coinops.robot_v1_live_orders o left join coinops.robot_v1_live_slots s
      on s.id=o.slot_id and s.run_id=r.id where o.run_id=r.id
    and (s.id is null or o.product_id is distinct from r.product_id or o.tenant_id is distinct from r.tenant_id
      or o.user_id is distinct from r.user_id or o.operator_id is distinct from r.operator_id
      or o.exchange_account_id is distinct from r.exchange_account_id or o.trading_engine_id is distinct from e.id
      or o.quote_asset is distinct from r.quote_asset or o.slot_number is distinct from s.slot_number
      or o.operation_sequence is null or o.operation_sequence < 1 or o.operation_sequence > s.operation_sequence
      or o.side is null or o.side not in ('BUY','SELL') or o.client_order_id is null
      or o.client_order_id !~ ('^'||owner_prefix||s.slot_number||'-'||substr(o.side,1,1)||'-[a-f0-9]{14}$')
      or o.status is null or o.status not in ('NEW','PARTIALLY_FILLED','FILLED','CANCELED','EXPIRED','EXPIRED_IN_MATCH','REJECTED')
      or o.executed_quantity is null or o.executed_quantity < 0
      or o.executed_quantity::text in ('NaN','Infinity','-Infinity')
      or o.executed_quantity > 0 and o.trades_reconciled is distinct from true
      or o.status in ('NEW','PARTIALLY_FILLED') and (o.exchange_order_id is null or o.exchange_order_id !~ '^[0-9]+$'
        or o.operation_sequence is distinct from s.operation_sequence
        or o.side='SELL' and (o.purpose is distinct from 'TP' or o.requested_quantity is null
          or o.requested_quantity < o.executed_quantity
          or abs((o.requested_quantity-o.executed_quantity)
            -case when s.position_quantity>=p_quantity_step then floor(s.position_quantity/p_quantity_step)*p_quantity_step
              else s.position_quantity end)>0.000000000001))))
    or (select count(*) from coinops.robot_v1_live_orders o where o.run_id=r.id and o.side='BUY'
      and o.status in ('NEW','PARTIALLY_FILLED')) > 1 then
    raise exception 'COINOPS_LIVE_LARGE_ENGINE_PROGRESS_UNSAFE';
  end if;
  -- Every sellable OPEN position has exactly one current resident owned TP,
  -- matching its remaining rounded quantity. Dust below canonical step is not
  -- an invented uncovered position. Exchange agreement is separately proven
  -- by the runtime immediately before this lease-fenced DB checkpoint.
  if exists(select 1 from coinops.robot_v1_live_slots s where s.run_id=r.id and s.position_quantity >= p_quantity_step
    and (s.entry_state is distinct from 'OPEN'
      or (select count(*) from coinops.robot_v1_live_orders o where o.run_id=r.id and o.slot_id=s.id
        and o.operation_sequence=s.operation_sequence and o.side='SELL' and o.purpose='TP'
        and o.status in ('NEW','PARTIALLY_FILLED')) <> 1
      or exists(select 1 from coinops.robot_v1_live_orders o where o.run_id=r.id and o.slot_id=s.id
        and o.operation_sequence=s.operation_sequence and o.side='SELL' and o.purpose='TP'
        and o.status in ('NEW','PARTIALLY_FILLED') and (o.requested_quantity is null or o.requested_quantity <= 0
          or o.price is null or o.price <= 0 or o.requested_quantity < o.executed_quantity
          or abs((o.requested_quantity-o.executed_quantity)
            - floor(s.position_quantity/p_quantity_step)*p_quantity_step)>0.000000000001)))) then
    raise exception 'COINOPS_LIVE_LARGE_ENGINE_PROGRESS_UNSAFE';
  end if;
  select count(*) into settled from coinops.robot_v1_live_orders o where o.run_id=r.id
    and o.status in ('FILLED','CANCELED','EXPIRED','EXPIRED_IN_MATCH','REJECTED') and o.trades_reconciled;
  select coalesce(sum(a.gain_count),0) into gains from coinops.robot_v1_live_slot_accounts a where a.trading_engine_id=e.id;
  select coalesce(sum(s.operation_sequence),0) into operations from coinops.robot_v1_live_slots s where s.run_id=r.id;
  if greatest(settled,gains,operations)>9007199254740991 then
    raise exception 'COINOPS_LIVE_LARGE_ENGINE_PROGRESS_INVALID';
  end if;
  identity:=jsonb_build_object('contract','LARGE_ENGINE_PROGRESS_V1','run_id',r.id,'operator_id',r.operator_id,
    'exchange_account_id',r.exchange_account_id,'trading_engine_id',e.id,'executor_shard_id',e.executor_shard_id,
    'symbol',r.symbol,'quote_asset',r.quote_asset,'slot_count',n,'quantity_step',p_quantity_step);
  previous:=r.reconciliation_checkpoint;
  if previous is not null then
    if jsonb_typeof(previous) is distinct from 'object' or not(previous @> identity)
      or not(previous ?& array['started_at','observed_at','phase','settled_orders','credited_gains','operation_total'])
      or previous->>'phase' not in ('CREDIT_SLOTS','RECYCLE_SLOTS')
      or previous->>'settled_orders' !~ '^(0|[1-9][0-9]*)$'
      or previous->>'credited_gains' !~ '^(0|[1-9][0-9]*)$'
      or previous->>'operation_total' !~ '^[1-9][0-9]*$' then
      raise exception 'COINOPS_LIVE_LARGE_ENGINE_PROGRESS_INVALID';
    end if;
    previous_started:=(previous->>'started_at')::timestamptz;
    previous_observed:=(previous->>'observed_at')::timestamptz;
    if previous_started is null or previous_observed is null or previous_started > previous_observed
      or previous_observed > observed+interval '5 seconds' then
      raise exception 'COINOPS_LIVE_LARGE_ENGINE_PROGRESS_INVALID';
    end if;
    -- Only completed reconciliation can close an old episode. An unchanged
    -- checkpoint or a new lease alone cannot reset its fifteen-minute bound.
    if r.last_reconciled_at is not null and r.last_reconciled_at > previous_observed then
      previous:=null;
    else
      if observed-previous_started > interval '15 minutes' then
        raise exception 'COINOPS_LIVE_LARGE_ENGINE_PROGRESS_STALE';
      end if;
      previous_settled:=(previous->>'settled_orders')::bigint;
      previous_gains:=(previous->>'credited_gains')::bigint;
      previous_operations:=(previous->>'operation_total')::bigint;
      if settled < previous_settled or gains < previous_gains or operations < previous_operations then
        raise exception 'COINOPS_LIVE_LARGE_ENGINE_PROGRESS_UNSAFE';
      end if;
      if settled=previous_settled and gains=previous_gains and operations=previous_operations then
        return previous;
      end if;
    end if;
  end if;
  started:=case when previous is null then observed else previous_started end;
  checkpoint:=identity||jsonb_build_object('phase',p_phase,'started_at',started,'observed_at',observed,
    'settled_orders',settled,'credited_gains',gains,'operation_total',operations);
  update coinops.robot_v1_live_runs set reconciliation_checkpoint=checkpoint
    where id=r.id and lease_owner=p_lease_owner and lease_until>clock_timestamp() and status='ACTIVE'
      and reconciliation_checkpoint is not distinct from r.reconciliation_checkpoint;
  get diagnostics updated=row_count;
  if updated<>1 then raise exception 'COINOPS_LIVE_LARGE_ENGINE_PROGRESS_LEASE_DENIED'; end if;
  v_event_key:='RECONCILIATION_PROGRESS:'||extract(epoch from started)::text||':'||settled||':'||gains||':'||operations;
  insert into coinops.robot_v1_live_events(run_id,product_id,tenant_id,user_id,operator_id,exchange_account_id,
    trading_engine_id,quote_asset,event_key,event_type,details,observed_at)
  values(r.id,r.product_id,r.tenant_id,r.user_id,r.operator_id,r.exchange_account_id,e.id,r.quote_asset,
    v_event_key,'RECONCILIATION_PROGRESS',checkpoint,observed)
  on conflict(run_id,event_key) do nothing;
  return checkpoint;
exception when invalid_text_representation or numeric_value_out_of_range or datetime_field_overflow or invalid_datetime_format then
  raise exception 'COINOPS_LIVE_LARGE_ENGINE_PROGRESS_INVALID';
end $$;

revoke all on function coinops.record_live_reconciliation_checkpoint(uuid,uuid,text,numeric) from public,anon,authenticated;
grant execute on function coinops.record_live_reconciliation_checkpoint(uuid,uuid,text,numeric) to service_role;
comment on function coinops.record_live_reconciliation_checkpoint(uuid,uuid,text,numeric) is
  'Service-only, non-authorizing checkpoint: exact lease/ledger protection and actual monotonic progress; never changes last_reconciled_at.';

-- The existing order -> run -> slot lock order is unchanged. A queued sync
-- must validate lease expiry AFTER acquiring the run lock using wall time,
-- not the transaction-start timestamp returned by now(). This static body
-- preserves the canonical sync exactly except for that single lease check.
create or replace function coinops.sync_robot_v1_live_order(
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
    or v_run.lease_until is null or v_run.lease_until<=clock_timestamp()
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
    from coinops.robot_v1_live_fills where order_id=v_order.id and commission_asset in ('BNB',v_run.quote_asset);
  for v_trade in select value from jsonb_array_elements(p_trades) as item(value) loop
    v_trade_id:=v_trade->>'id';
    v_qty:=(v_trade->>'quantity')::numeric;
    v_quote:=(v_trade->>'quoteQuantity')::numeric;
    v_fee:=(v_trade->>'commission')::numeric;
    v_fee_asset:=v_trade->>'commissionAsset';
    v_filled_at:=(v_trade->>'filledAt')::timestamptz;
    if v_trade_id !~ '^[0-9]+$' or v_qty<=0 or v_quote<=0 or v_fee<0
      or v_filled_at is null or v_filled_at>now()+interval '10 seconds'
      or v_fee_asset not in (v_run.asset,v_run.quote_asset,'BNB')
      or (v_trade->>'isBuyer')::boolean is distinct from (v_order.side='BUY') then
      raise exception 'COINOPS_LIVE_FILL_INVALID';
    end if;
    if v_fee_asset='BNB' then
      if p_bnb_brl_price is null or p_bnb_brl_price<=0 or p_bnb_brl_observed_at is null
        or abs(extract(epoch from now()-p_bnb_brl_observed_at))>600 then
        raise exception 'COINOPS_LIVE_BNB_FEE_PRICE_STALE';
      end if;
      v_fee_brl:=round(v_fee*p_bnb_brl_price,8);
    elsif v_fee_asset=v_run.quote_asset then v_fee_brl:=round(v_fee,8);
    else v_fee_brl:=round(v_fee*v_quote/v_qty,8);
    end if;
    insert into coinops.robot_v1_live_fills
      (order_id,product_id,tenant_id,user_id,symbol,exchange_trade_id,quantity,
        quote_quantity,commission,commission_asset,commission_brl,fee_fx_source,
        fee_fx_observed_at,filled_at)
    values (v_order.id,v_order.product_id,v_order.tenant_id,v_order.user_id,v_run.symbol,
      v_trade_id,v_qty,v_quote,v_fee,v_fee_asset,v_fee_brl,
      case when v_fee_asset='BNB' then 'BINANCE_SPOT_BNB'||v_run.quote_asset||'_TICKER' else null end,
      case when v_fee_asset='BNB' then p_bnb_brl_observed_at else null end,v_filled_at)
    on conflict (exchange_account_id,symbol,exchange_trade_id) do nothing;
    select * into strict v_previous from coinops.robot_v1_live_fills
      where exchange_account_id=v_run.exchange_account_id and symbol=v_run.symbol and exchange_trade_id=v_trade_id;
    if (v_previous.order_id,v_previous.quantity,v_previous.quote_quantity,
      v_previous.commission,v_previous.commission_asset,v_previous.filled_at)
      is distinct from (v_order.id,v_qty,v_quote,v_fee,v_fee_asset,v_filled_at) then
      raise exception 'COINOPS_LIVE_FILL_IDENTITY_COLLISION';
    end if;
  end loop;
  select coalesce(sum(quantity),0),coalesce(sum(quote_quantity),0),
    coalesce(sum(commission) filter (where commission_asset=v_run.asset),0),
    coalesce(sum(commission) filter (where commission_asset=v_run.quote_asset),0),
    coalesce(sum(commission_brl) filter (where commission_asset in ('BNB',v_run.quote_asset)),0)
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
commit;
