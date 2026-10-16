-- CoinOps / OnPlay Platform otdfpmsegjxpqrzisfmi, schema coinops.
-- A partial TP has accounted fills without being terminal. This read-only
-- proof does not set trades_reconciled, credit gain or authorize new orders.
begin;
set local lock_timeout='3s';
set local statement_timeout='60s';

create or replace function private.coinops_partial_tp_fills_accounted(p_order_id uuid)
returns boolean language plpgsql stable set search_path='' as $$
declare o coinops.robot_v1_live_orders%rowtype;
  r coinops.robot_v1_live_runs%rowtype; s coinops.robot_v1_live_slots%rowtype;
  qty numeric; quote numeric; base_fee numeric; quote_fee numeric;
  other_fee numeric; bnb_fee numeric; position numeric; other_json jsonb;
begin
  select * into o from coinops.robot_v1_live_orders where id=p_order_id;
  if not found then return false; end if;
  select * into r from coinops.robot_v1_live_runs where id=o.run_id;
  if not found then return false; end if;
  select * into s from coinops.robot_v1_live_slots where id=o.slot_id and run_id=r.id;
  if not found or o.side is distinct from 'SELL' or o.purpose is distinct from 'TP'
    or o.status is distinct from 'PARTIALLY_FILLED'
    or o.exchange_order_id is null or o.exchange_order_id !~ '^[0-9]+$'
    or o.operation_sequence is distinct from s.operation_sequence
    or o.trading_engine_id is distinct from r.trading_engine_id
    or o.operator_id is distinct from r.operator_id or o.exchange_account_id is distinct from r.exchange_account_id
    or o.product_id is distinct from r.product_id or o.tenant_id is distinct from r.tenant_id
    or o.user_id is distinct from r.user_id or o.quote_asset is distinct from r.quote_asset
    or o.executed_quantity is null or o.executed_quantity <= 0 or o.requested_quantity is null
    or o.requested_quantity <= o.executed_quantity or o.cumulative_quote is null or o.cumulative_quote <= 0
    or o.fee_base is null or o.fee_base < 0 or o.fee_quote is null or o.fee_quote < 0
    or exists(select 1 from unnest(array[o.executed_quantity,o.requested_quantity,o.cumulative_quote,o.fee_base,o.fee_quote]) n
      where n::text in ('NaN','Infinity','-Infinity')) then return false; end if;
  if exists(select 1 from coinops.robot_v1_live_fills f where f.order_id=o.id and (
    f.product_id is distinct from o.product_id or f.tenant_id is distinct from o.tenant_id
    or f.user_id is distinct from o.user_id or f.operator_id is distinct from o.operator_id
    or f.exchange_account_id is distinct from o.exchange_account_id or f.trading_engine_id is distinct from o.trading_engine_id
    or f.symbol is distinct from r.symbol or f.exchange_trade_id is null or f.exchange_trade_id !~ '^[0-9]+$'
    or f.quantity is null or f.quantity <= 0 or f.quote_quantity is null or f.quote_quantity <= 0
    or f.commission is null or f.commission < 0 or f.commission_brl is null or f.commission_brl < 0
    or exists(select 1 from unnest(array[f.quantity,f.quote_quantity,f.commission,f.commission_brl]) n
      where n::text in ('NaN','Infinity','-Infinity'))
    or f.commission_asset is null or f.commission_asset not in (r.asset,r.quote_asset,'BNB')
    or f.filled_at is null or not isfinite(f.filled_at) or f.filled_at>clock_timestamp()+interval '10 seconds'
    or f.commission_asset=r.asset and f.commission_brl is distinct from round(f.commission*f.quote_quantity/f.quantity,8)
    or f.commission_asset=r.quote_asset and f.commission_brl is distinct from round(f.commission,8)
    or f.commission_asset='BNB' and (
      f.fee_fx_source is distinct from 'BINANCE_SPOT_BNB'||r.quote_asset||'_TICKER'
      or f.fee_fx_observed_at is null or not isfinite(f.fee_fx_observed_at))
  )) then return false; end if;
  select coalesce(sum(f.quantity),0),coalesce(sum(f.quote_quantity),0),
    coalesce(sum(f.commission) filter(where f.commission_asset=r.asset),0),
    coalesce(sum(f.commission) filter(where f.commission_asset=r.quote_asset),0),
    coalesce(sum(f.commission_brl) filter(where f.commission_asset in ('BNB',r.quote_asset)),0),
    coalesce(sum(f.commission) filter(where f.commission_asset='BNB'),0)
  into qty,quote,base_fee,quote_fee,other_fee,bnb_fee from coinops.robot_v1_live_fills f where f.order_id=o.id;
  other_json:=case when other_fee>0 then jsonb_build_array(jsonb_build_object('asset','BNB','amount',bnb_fee)) else '[]'::jsonb end;
  if abs(qty-o.executed_quantity)>0.000000000001 or abs(quote-o.cumulative_quote)>0.00000001
    or abs(base_fee-o.fee_base)>0.000000000001 or abs(quote_fee-o.fee_quote)>0.00000001
    or o.fee_other is distinct from other_json then return false; end if;
  -- Recompute the same operation's residual from canonical synced order totals.
  -- No slot/TP pair can certify itself by sharing the same wrong quantity.
  select coalesce(sum(case when x.side='BUY' then x.executed_quantity-x.fee_base
    else -x.executed_quantity-x.fee_base end),0) into position
  from coinops.robot_v1_live_orders x where x.run_id=r.id and x.slot_id=s.id
    and x.operation_sequence=s.operation_sequence and x.side in ('BUY','SELL');
  return position>=0 and s.position_quantity is not null
    and abs(position-s.position_quantity)<=0.000000000001;
exception when data_exception then return false;
end $$;
revoke all on function private.coinops_partial_tp_fills_accounted(uuid) from public,anon,authenticated;
grant execute on function private.coinops_partial_tp_fills_accounted(uuid) to service_role;

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
        and not private.coinops_partial_tp_fills_accounted(o.id)
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

-- One database-only GET for all current partial TPs of a checkpointed run.
-- The expected checkpoint and returned facts fence interleaved watchdog reads;
-- no caller-provided order list or boolean can certify a foreign/missing fill.
create or replace function coinops.prove_partial_tp_checkpoint_fills(p_run_id uuid,p_expected_checkpoint jsonb)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare r coinops.robot_v1_live_runs%rowtype; e coinops.trading_engines%rowtype;
  observed timestamptz; started timestamptz; facts jsonb;
begin
  if coalesce(nullif(current_setting('request.jwt.claim.role',true),''),auth.jwt()->>'role','')<>'service_role' then
    raise exception 'COINOPS_LIVE_PARTIAL_TP_PROOF_SCOPE_DENIED'; end if;
  select * into r from coinops.robot_v1_live_runs where id=p_run_id;
  if not found or r.status is distinct from 'ACTIVE' or r.last_error is not null
    or r.reconciliation_checkpoint is null or r.reconciliation_checkpoint is distinct from p_expected_checkpoint
    or p_expected_checkpoint->>'contract' is distinct from 'LARGE_ENGINE_PROGRESS_V1' then
    raise exception 'COINOPS_LIVE_PARTIAL_TP_PROOF_SCOPE_DENIED'; end if;
  select * into e from coinops.trading_engines where id=r.trading_engine_id;
  if not found or e.environment is distinct from 'REAL' or e.status is distinct from 'ACTIVE'
    or e.kill_switch is distinct from false or e.strategy_config_pending is distinct from false
    or e.slot_count<=25 or e.slot_count>100 or e.slot_count is distinct from r.slot_count
    or e.operator_id is distinct from r.operator_id or e.exchange_account_id is distinct from r.exchange_account_id
    or e.symbol is distinct from r.symbol
    or not(p_expected_checkpoint @> jsonb_build_object('run_id',r.id,'operator_id',r.operator_id,
      'exchange_account_id',r.exchange_account_id,'trading_engine_id',e.id,'executor_shard_id',e.executor_shard_id,
      'symbol',r.symbol,'quote_asset',r.quote_asset,'slot_count',e.slot_count)) then
    raise exception 'COINOPS_LIVE_PARTIAL_TP_PROOF_SCOPE_DENIED'; end if;
  observed:=(p_expected_checkpoint->>'observed_at')::timestamptz;
  started:=(p_expected_checkpoint->>'started_at')::timestamptz;
  if observed is null or started is null or not isfinite(observed) or not isfinite(started)
    or observed<started or observed>clock_timestamp()+interval '5 seconds'
    or clock_timestamp()-observed>interval '150 seconds' or clock_timestamp()-started>interval '15 minutes'
    or r.last_reconciled_at>observed then
    raise exception 'COINOPS_LIVE_PARTIAL_TP_PROOF_STALE'; end if;
  if exists(select 1 from coinops.robot_v1_live_orders o where o.run_id=r.id and o.executed_quantity>0
    and o.trades_reconciled is distinct from true and not private.coinops_partial_tp_fills_accounted(o.id)) then
    raise exception 'COINOPS_LIVE_PARTIAL_TP_PROOF_UNSAFE'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',o.id,'slot_id',o.slot_id,'client_order_id',o.client_order_id,
    'exchange_order_id',o.exchange_order_id,'status',o.status,'side',o.side,'purpose',o.purpose,
    'operation_sequence',o.operation_sequence,'executed_quantity',o.executed_quantity,'cumulative_quote',o.cumulative_quote,
    'fee_base',o.fee_base,'fee_quote',o.fee_quote,'fee_other',o.fee_other,'slot_position_quantity',s.position_quantity) order by o.id),'[]'::jsonb)
  into facts from coinops.robot_v1_live_orders o join coinops.robot_v1_live_slots s on s.id=o.slot_id and s.run_id=r.id
  where o.run_id=r.id and o.side='SELL' and o.status='PARTIALLY_FILLED' and o.executed_quantity>0
    and o.trades_reconciled is distinct from true;
  if jsonb_array_length(facts)<1 or jsonb_array_length(facts)>e.slot_count then
    raise exception 'COINOPS_LIVE_PARTIAL_TP_PROOF_UNSAFE'; end if;
  return jsonb_build_object('contract','PARTIAL_TP_FILLS_PROOF_V1','run_id',r.id,'checkpoint',r.reconciliation_checkpoint,'orders',facts);
exception when data_exception then raise exception 'COINOPS_LIVE_PARTIAL_TP_PROOF_UNSAFE';
end $$;
revoke all on function coinops.prove_partial_tp_checkpoint_fills(uuid,jsonb) from public,anon,authenticated;
grant execute on function coinops.prove_partial_tp_checkpoint_fills(uuid,jsonb) to service_role;
commit;
