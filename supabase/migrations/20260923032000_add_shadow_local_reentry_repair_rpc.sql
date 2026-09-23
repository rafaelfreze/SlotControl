-- Atomic, service-role-only repair for a previously archived Shadow gain whose
-- physical slot was moved to the bottom by the superseded recycle rule.
create or replace function coinops.repair_robot_v1_shadow_local_reentry(
  p_cycle_id uuid,
  p_physical_slot integer,
  p_completed_operation_id uuid
) returns table(
  repaired boolean,
  reentry_price numeric,
  balance_after numeric,
  gain_count_after integer,
  armed_slot integer,
  current_slot_count integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cycle coinops.robot_v1_cycles%rowtype;
  v_slot coinops.robot_v1_slots%rowtype;
  v_operation coinops.robot_v1_slot_operations%rowtype;
  v_account coinops.robot_v1_slot_accounts%rowtype;
  v_other_open integer;
  v_armed_count integer;
  v_slot_count integer;
  v_next_quantity numeric;
  v_now timestamptz := timezone('utc', now());
begin
  if coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role' then
    raise exception 'COINOPS_SHADOW_REPAIR_SERVICE_ROLE_REQUIRED';
  end if;
  if p_physical_slot < 1 or p_physical_slot > 25 then
    raise exception 'COINOPS_SHADOW_REPAIR_INPUT_INVALID';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('coinops-shadow-local-reentry:' || p_cycle_id::text, 0));
  select * into strict v_cycle from coinops.robot_v1_cycles
    where id=p_cycle_id and execution_mode='SHADOW'
      and asset='SOL' and symbol='SOLUSDC'
      and status in ('GRID_ACTIVE','POSITIONS_ACTIVE') for update;
  select * into strict v_slot from coinops.robot_v1_slots
    where cycle_id=v_cycle.id and slot_number=p_physical_slot for update;
  select * into strict v_operation from coinops.robot_v1_slot_operations
    where id=p_completed_operation_id and cycle_id=v_cycle.id
      and slot_id=v_slot.id and physical_slot_number=p_physical_slot;
  select * into strict v_account from coinops.robot_v1_slot_accounts
    where config_id=v_cycle.config_id and slot_number=p_physical_slot for update;

  select count(*) into v_slot_count from coinops.robot_v1_slots where cycle_id=v_cycle.id;
  select count(*) into v_other_open from coinops.robot_v1_slots
    where cycle_id=v_cycle.id and id<>v_slot.id and status in ('TP_ACTIVE','OPEN','PARTIALLY_FILLED');
  select count(*) into v_armed_count from coinops.robot_v1_slots
    where cycle_id=v_cycle.id and entry_state='ARMED';

  if v_slot_count <> 25 or v_other_open < 1 or v_armed_count > 1
    or v_operation.closed_at is null or v_operation.entry_price <= 0
    or v_account.last_operation_id is distinct from v_operation.id
    or v_account.balance_usdc <> v_account.initial_balance_usdc + v_account.net_profit_usdc
    or v_account.gain_count < 1
    or v_slot.operation_sequence <> v_operation.operation_sequence + 1
    or v_slot.status <> 'PENDING' or v_slot.executed_quantity <> 0
    or v_slot.logical_level <= v_operation.logical_level then
    raise exception 'COINOPS_SHADOW_REPAIR_PRECONDITION_FAILED';
  end if;

  v_next_quantity := floor((v_account.balance_usdc / v_operation.entry_price) / 0.001) * 0.001;
  if v_next_quantity <= 0 or v_next_quantity * v_operation.entry_price < 5 then
    raise exception 'COINOPS_SHADOW_REPAIR_FILTER_INVALID';
  end if;

  update coinops.robot_v1_slots set entry_state='PLANNED', armed_at=null, updated_at=v_now
    where cycle_id=v_cycle.id and id<>v_slot.id and entry_state='ARMED';

  update coinops.robot_v1_slots set
    logical_level=v_operation.logical_level,
    allocation_usdc=v_account.balance_usdc,
    buy_price=v_operation.entry_price,
    requested_quantity=v_next_quantity,
    executed_quantity=0,
    average_fill_price=null,
    buy_status='PENDING',
    entry_state='ARMED',
    armed_at=v_now,
    missed_at=null,
    buy_trigger_price=null,
    buy_trigger_observed_price=null,
    buy_triggered_at=null,
    take_profit_price=null,
    take_profit_status='NONE',
    tp_trigger_observed_price=null,
    tp_triggered_at=null,
    realized_quote_pnl=null,
    buy_fee=0,
    sell_fee=0,
    status='PENDING',
    observed_at=v_now,
    updated_at=v_now
  where id=v_slot.id;

  insert into coinops.robot_v1_audit_events
    (product_id,tenant_id,user_id,config_id,cycle_id,slot_id,event_type,previous_state,next_state,observed_at,idempotency_key)
  values
    (v_cycle.product_id,v_cycle.tenant_id,v_cycle.user_id,v_cycle.config_id,v_cycle.id,v_slot.id,'SHADOW_STATE_REPAIRED',
      jsonb_build_object('logicalLevel',v_slot.logical_level,'buyPrice',v_slot.buy_price,'operationSequence',v_slot.operation_sequence),
      jsonb_build_object('physicalSlotNumber',v_slot.slot_number,'logicalLevel',v_operation.logical_level,'operationSequence',v_slot.operation_sequence,
        'previousEntryPrice',v_operation.entry_price,'reentryPrice',v_operation.entry_price,
        'balanceBefore',v_account.balance_usdc-v_operation.net_quote_pnl,'balanceAfter',v_account.balance_usdc,
        'gainCountBefore',v_account.gain_count-1,'gainCountAfter',v_account.gain_count,'otherOpenPositions',v_other_open,
        'localRecycleVsGlobalReset','LOCAL_REENTRY','repairReason','OFFICIAL_LOCAL_REENTRY_RULE'),
      v_now,'robot-v1-shadow-SHADOW_STATE_REPAIRED:' || v_operation.id::text),
    (v_cycle.product_id,v_cycle.tenant_id,v_cycle.user_id,v_cycle.config_id,v_cycle.id,v_slot.id,'SLOT_REENTRY_ARMED',
      jsonb_build_object('physicalSlotNumber',v_slot.slot_number,'operationSequence',v_operation.operation_sequence,'previousEntryPrice',v_operation.entry_price),
      jsonb_build_object('physicalSlotNumber',v_slot.slot_number,'logicalLevel',v_operation.logical_level,'operationSequence',v_slot.operation_sequence,
        'previousEntryPrice',v_operation.entry_price,'reentryPrice',v_operation.entry_price,
        'balanceBefore',v_account.balance_usdc-v_operation.net_quote_pnl,'balanceAfter',v_account.balance_usdc,
        'gainCountBefore',v_account.gain_count-1,'gainCountAfter',v_account.gain_count,'otherOpenPositions',v_other_open,
        'localRecycleVsGlobalReset','LOCAL_REENTRY','repairReason','OFFICIAL_LOCAL_REENTRY_RULE'),
      v_now,'robot-v1-shadow-SLOT_REENTRY_ARMED:' || v_operation.id::text)
  on conflict (product_id,tenant_id,user_id,idempotency_key) do nothing;

  select count(*) into v_armed_count from coinops.robot_v1_slots where cycle_id=v_cycle.id and entry_state='ARMED';
  if v_armed_count <> 1 or (select count(*) from coinops.robot_v1_slots where cycle_id=v_cycle.id) <> 25
    or not exists (select 1 from coinops.robot_v1_slots where id=v_slot.id and logical_level=v_operation.logical_level
      and buy_price=v_operation.entry_price and entry_state='ARMED' and operation_sequence=v_operation.operation_sequence+1)
    or v_account.balance_usdc <> (select balance_usdc from coinops.robot_v1_slot_accounts where config_id=v_cycle.config_id and slot_number=p_physical_slot)
    or v_account.gain_count <> (select gain_count from coinops.robot_v1_slot_accounts where config_id=v_cycle.config_id and slot_number=p_physical_slot) then
    raise exception 'COINOPS_SHADOW_REPAIR_POSTCONDITION_FAILED';
  end if;

  return query select true, v_operation.entry_price, v_account.balance_usdc, v_account.gain_count,
    p_physical_slot, v_slot_count;
end;
$$;

revoke all on function coinops.repair_robot_v1_shadow_local_reentry(uuid,integer,uuid) from public, anon, authenticated;
grant execute on function coinops.repair_robot_v1_shadow_local_reentry(uuid,integer,uuid) to service_role;
