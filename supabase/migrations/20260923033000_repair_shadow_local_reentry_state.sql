-- One-time, idempotent repair for the observed SOL Shadow state created by the
-- superseded bottom-of-grid recycle rule. No generated identifier is embedded;
-- a clean database or an already repaired database remains unchanged.
do $$
declare
  v_candidate record;
  v_count integer;
begin
  select count(*) into v_count
  from coinops.robot_v1_cycles c
  join coinops.robot_v1_slots s on s.cycle_id=c.id and s.slot_number=2
  join coinops.robot_v1_slot_accounts a on a.config_id=c.config_id and a.slot_number=2
  join coinops.robot_v1_slot_operations o on o.id=a.last_operation_id
  where c.execution_mode='SHADOW' and c.asset='SOL' and c.symbol='SOLUSDC'
    and c.status in ('GRID_ACTIVE','POSITIONS_ACTIVE')
    and s.status='PENDING' and s.entry_state='PLANNED' and s.operation_sequence=o.operation_sequence+1
    and s.logical_level>o.logical_level and s.executed_quantity=0
    and o.physical_slot_number=2 and o.entry_price=117.90 and o.take_profit_price=118.48
    and o.net_quote_pnl=0.0493 and o.closed_at is not null
    and a.balance_usdc=10.0986 and a.gain_count=2 and a.net_profit_usdc=0.0986
    and exists (select 1 from coinops.robot_v1_slots open_slot where open_slot.cycle_id=c.id and open_slot.id<>s.id and open_slot.status in ('TP_ACTIVE','OPEN','PARTIALLY_FILLED'))
    and (select count(*) from coinops.robot_v1_slots all_slots where all_slots.cycle_id=c.id)=25;

  if v_count > 1 then raise exception 'COINOPS_SHADOW_REPAIR_AMBIGUOUS'; end if;
  if v_count = 0 then return; end if;

  select c.id as cycle_id, o.id as operation_id into strict v_candidate
  from coinops.robot_v1_cycles c
  join coinops.robot_v1_slots s on s.cycle_id=c.id and s.slot_number=2
  join coinops.robot_v1_slot_accounts a on a.config_id=c.config_id and a.slot_number=2
  join coinops.robot_v1_slot_operations o on o.id=a.last_operation_id
  where c.execution_mode='SHADOW' and c.asset='SOL' and c.symbol='SOLUSDC'
    and c.status in ('GRID_ACTIVE','POSITIONS_ACTIVE')
    and s.status='PENDING' and s.entry_state='PLANNED' and s.operation_sequence=o.operation_sequence+1
    and s.logical_level>o.logical_level and s.executed_quantity=0
    and o.physical_slot_number=2 and o.entry_price=117.90 and o.take_profit_price=118.48
    and o.net_quote_pnl=0.0493 and o.closed_at is not null
    and a.balance_usdc=10.0986 and a.gain_count=2 and a.net_profit_usdc=0.0986
    and exists (select 1 from coinops.robot_v1_slots open_slot where open_slot.cycle_id=c.id and open_slot.id<>s.id and open_slot.status in ('TP_ACTIVE','OPEN','PARTIALLY_FILLED'))
    and (select count(*) from coinops.robot_v1_slots all_slots where all_slots.cycle_id=c.id)=25;

  -- Migration sessions do not carry a PostgREST JWT claim. Set the local
  -- transaction claim explicitly; the RPC remains revoked from user roles.
  perform set_config('request.jwt.claim.role','service_role',true);
  perform * from coinops.repair_robot_v1_shadow_local_reentry(v_candidate.cycle_id, 2, v_candidate.operation_id);
end;
$$;
