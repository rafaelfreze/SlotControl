-- Separate a physical slot's USDC budget from the exchange-step-normalized
-- executable quantity. A small gain may increase the budget before a lot step
-- allows the next quantity increment.
alter table coinops.robot_v1_slots add column allocation_usdc numeric(28,12);
create function coinops.set_robot_v1_slot_allocation()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if new.allocation_usdc is null then
    select coalesce(a.balance_usdc, cy.slot_notional_usdc) into new.allocation_usdc
    from coinops.robot_v1_cycles cy
    left join coinops.robot_v1_slot_accounts a
      on a.config_id = cy.config_id and a.slot_number = new.slot_number
    where cy.id = new.cycle_id;
  end if;
  if new.allocation_usdc is null then raise exception 'COINOPS_V1_SLOT_ALLOCATION_UNKNOWN'; end if;
  return new;
end $$;
revoke all on function coinops.set_robot_v1_slot_allocation() from public, anon, authenticated;
grant execute on function coinops.set_robot_v1_slot_allocation() to service_role;
create trigger robot_v1_slot_allocation
  before insert on coinops.robot_v1_slots
  for each row execute function coinops.set_robot_v1_slot_allocation();
update coinops.robot_v1_slots s
set allocation_usdc = case
  when s.status = 'PENDING' and cy.status in ('STARTING','GRID_ACTIVE','POSITIONS_ACTIVE','RESETTING')
    then coalesce(a.balance_usdc, cy.slot_notional_usdc)
  else cy.slot_notional_usdc
end
from coinops.robot_v1_cycles cy
left join coinops.robot_v1_slot_accounts a on a.config_id = cy.config_id
where s.cycle_id = cy.id and (a.slot_number = s.slot_number or a.slot_number is null);
alter table coinops.robot_v1_slots
  alter column allocation_usdc set not null,
  add constraint robot_v1_slots_allocation_positive check (allocation_usdc > 0);

alter table coinops.robot_v1_slot_operations add column allocation_usdc numeric(28,12);
create or replace function coinops.set_robot_v1_operation_physical_slot()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  select s.slot_number, coalesce(new.allocation_usdc, s.allocation_usdc)
  into new.physical_slot_number, new.allocation_usdc
  from coinops.robot_v1_slots s
  where s.id = new.slot_id and s.cycle_id = new.cycle_id;
  if new.physical_slot_number is null or new.allocation_usdc is null then
    raise exception 'COINOPS_V1_PHYSICAL_SLOT_UNKNOWN';
  end if;
  return new;
end $$;
update coinops.robot_v1_slot_operations o
set allocation_usdc = cy.slot_notional_usdc
from coinops.robot_v1_cycles cy
where cy.id = o.cycle_id;
alter table coinops.robot_v1_slot_operations
  alter column allocation_usdc set not null,
  add constraint robot_v1_slot_operations_allocation_positive check (allocation_usdc > 0);

comment on column coinops.robot_v1_slots.allocation_usdc is 'Full compounded physical-slot budget for the current or next virtual BUY. Executable notional can be lower after Binance lot-step rounding.';
comment on column coinops.robot_v1_slot_operations.allocation_usdc is 'Physical-slot budget frozen when this completed Shadow operation was opened.';
