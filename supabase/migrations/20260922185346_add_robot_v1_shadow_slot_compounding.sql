-- CoinOps V1 Shadow only. A physical slot keeps its balance across cycles and
-- logical ladder levels. Archived operations are the immutable profit source.
lock table coinops.robot_v1_slot_operations in access exclusive mode;

alter table coinops.robot_v1_slot_operations add column physical_slot_number integer;
update coinops.robot_v1_slot_operations o
set physical_slot_number = s.slot_number
from coinops.robot_v1_slots s
where s.id = o.slot_id and s.cycle_id = o.cycle_id;
create function coinops.set_robot_v1_operation_physical_slot()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  select s.slot_number into new.physical_slot_number
  from coinops.robot_v1_slots s
  where s.id = new.slot_id and s.cycle_id = new.cycle_id;
  if new.physical_slot_number is null then raise exception 'COINOPS_V1_PHYSICAL_SLOT_UNKNOWN'; end if;
  return new;
end $$;
revoke all on function coinops.set_robot_v1_operation_physical_slot() from public, anon, authenticated;
grant execute on function coinops.set_robot_v1_operation_physical_slot() to service_role;
create trigger robot_v1_operation_physical_slot
  before insert on coinops.robot_v1_slot_operations
  for each row execute function coinops.set_robot_v1_operation_physical_slot();
alter table coinops.robot_v1_slot_operations
  alter column physical_slot_number set not null,
  add constraint robot_v1_slot_operations_physical_number_check check (physical_slot_number between 1 and 25);

alter table coinops.robot_v1_cycles
  alter column capital_usdc type numeric(28,12),
  alter column slot_notional_usdc type numeric(28,12);

create table coinops.robot_v1_slot_accounts (
  config_id uuid not null references coinops.robot_v1_configs(id) on delete restrict,
  slot_number integer not null check (slot_number between 1 and 25),
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  initial_balance_usdc numeric(28,12) not null check (initial_balance_usdc > 0),
  balance_usdc numeric(28,12) not null check (balance_usdc > 0),
  gain_count integer not null default 0 check (gain_count >= 0),
  gross_profit_usdc numeric(28,12) not null default 0,
  fees_usdc numeric(28,12) not null default 0 check (fees_usdc >= 0),
  net_profit_usdc numeric(28,12) not null default 0,
  last_operation_id uuid references coinops.robot_v1_slot_operations(id) on delete restrict,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (config_id, slot_number),
  foreign key (product_id, tenant_id) references public.product_tenants(product_id, tenant_id) on delete restrict,
  constraint robot_v1_slot_accounts_balanced check (balance_usdc = initial_balance_usdc + net_profit_usdc)
);

create table coinops.robot_v1_slot_profit_credits (
  operation_id uuid primary key references coinops.robot_v1_slot_operations(id) on delete restrict,
  config_id uuid not null,
  slot_number integer not null,
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  previous_balance_usdc numeric(28,12) not null,
  net_profit_usdc numeric(28,12) not null,
  new_balance_usdc numeric(28,12) not null,
  credited_at timestamptz not null default timezone('utc', now()),
  foreign key (config_id, slot_number) references coinops.robot_v1_slot_accounts(config_id, slot_number) on delete restrict,
  foreign key (product_id, tenant_id) references public.product_tenants(product_id, tenant_id) on delete restrict,
  constraint robot_v1_slot_profit_credits_balanced check (new_balance_usdc = previous_balance_usdc + net_profit_usdc)
);
create index robot_v1_slot_accounts_scope_idx on coinops.robot_v1_slot_accounts(product_id, tenant_id, user_id);
create index robot_v1_slot_profit_credits_scope_idx on coinops.robot_v1_slot_profit_credits(product_id, tenant_id, user_id, config_id, slot_number);

alter table coinops.robot_v1_slot_accounts enable row level security;
alter table coinops.robot_v1_slot_accounts force row level security;
alter table coinops.robot_v1_slot_profit_credits enable row level security;
alter table coinops.robot_v1_slot_profit_credits force row level security;
create policy robot_v1_slot_accounts_owner_select on coinops.robot_v1_slot_accounts
  for select to authenticated using (private.coinops_can_access_row(product_id, tenant_id, user_id));
create policy robot_v1_slot_profit_credits_owner_select on coinops.robot_v1_slot_profit_credits
  for select to authenticated using (private.coinops_can_access_row(product_id, tenant_id, user_id));
revoke all on coinops.robot_v1_slot_accounts, coinops.robot_v1_slot_profit_credits from public, anon, authenticated;
grant select on coinops.robot_v1_slot_accounts, coinops.robot_v1_slot_profit_credits to authenticated, service_role;
grant insert, update on coinops.robot_v1_slot_accounts to service_role;
grant insert on coinops.robot_v1_slot_profit_credits to service_role;

-- Existing tests have fixed opening capital and deterministic ownership.
insert into coinops.robot_v1_slot_accounts
  (config_id, slot_number, product_id, tenant_id, user_id, initial_balance_usdc, balance_usdc)
select c.id, n.slot_number, c.product_id, c.tenant_id, c.user_id,
       c.capital_usdc / 25, c.capital_usdc / 25
from coinops.robot_v1_configs c
cross join generate_series(1, 25) as n(slot_number)
where c.execution_mode = 'SHADOW' and c.shadow_test_started_at is not null
on conflict (config_id, slot_number) do nothing;

do $$
begin
  if exists (
    select 1 from coinops.robot_v1_slot_operations o
    join coinops.robot_v1_cycles cy on cy.id = o.cycle_id
    join coinops.robot_v1_configs c on c.id = cy.config_id
    left join coinops.robot_v1_slots s on s.id = o.slot_id and s.cycle_id = cy.id
    where c.execution_mode = 'SHADOW' and c.shadow_test_started_at is not null
      and cy.started_at >= c.shadow_test_started_at
      and (s.id is null or s.slot_number not between 1 and 25 or o.physical_slot_number <> s.slot_number
        or (o.product_id, o.tenant_id, o.user_id) is distinct from (c.product_id, c.tenant_id, c.user_id))
  ) then
    raise exception 'COINOPS_V1_SHADOW_OPERATION_OWNERSHIP_INVALID';
  end if;
end $$;

with history as (
  select o.id as operation_id, c.id as config_id, s.slot_number,
         c.product_id, c.tenant_id, c.user_id, o.net_quote_pnl,
         a.initial_balance_usdc,
         sum(o.net_quote_pnl) over (partition by c.id, s.slot_number order by o.closed_at, o.id) as running_net
  from coinops.robot_v1_slot_operations o
  join coinops.robot_v1_cycles cy on cy.id = o.cycle_id
  join coinops.robot_v1_configs c on c.id = cy.config_id
  join coinops.robot_v1_slots s on s.id = o.slot_id and s.cycle_id = cy.id
  join coinops.robot_v1_slot_accounts a on a.config_id = c.id and a.slot_number = s.slot_number
  where c.execution_mode = 'SHADOW' and c.shadow_test_started_at is not null
    and cy.started_at >= c.shadow_test_started_at
)
insert into coinops.robot_v1_slot_profit_credits
  (operation_id, config_id, slot_number, product_id, tenant_id, user_id,
   previous_balance_usdc, net_profit_usdc, new_balance_usdc)
select operation_id, config_id, slot_number, product_id, tenant_id, user_id,
       initial_balance_usdc + running_net - net_quote_pnl,
       net_quote_pnl, initial_balance_usdc + running_net
from history
on conflict (operation_id) do nothing;

with totals as (
  select c.config_id, c.slot_number, count(*)::integer as gains,
         sum(o.gross_quote_pnl) as gross, sum(o.estimated_quote_fees) as fees,
         sum(o.net_quote_pnl) as net,
         (array_agg(o.id order by o.closed_at desc, o.id desc))[1] as last_operation_id
  from coinops.robot_v1_slot_profit_credits c
  join coinops.robot_v1_slot_operations o on o.id = c.operation_id
  group by c.config_id, c.slot_number
)
update coinops.robot_v1_slot_accounts a
set balance_usdc = a.initial_balance_usdc + t.net,
    gain_count = t.gains, gross_profit_usdc = t.gross,
    fees_usdc = t.fees, net_profit_usdc = t.net,
    last_operation_id = t.last_operation_id, updated_at = timezone('utc', now())
from totals t
where a.config_id = t.config_id and a.slot_number = t.slot_number;

alter table coinops.robot_v1_audit_events
  drop constraint robot_v1_audit_events_event_type_check,
  add constraint robot_v1_audit_events_event_type_check check (event_type in (
    'CAPITAL_CHANGED', 'CAPITAL_NEXT_CYCLE', 'PARAMETERS_NEXT_CYCLE',
    'SHADOW_STARTED', 'PAUSED', 'RESUMED', 'KILL_SWITCH_ENABLED', 'KILL_SWITCH_DISABLED',
    'CYCLE_STARTED', 'CYCLE_COMPLETED', 'CYCLE_RESTARTED', 'INITIAL_POSITION_OPENED',
    'SLOT_RECYCLED', 'GRID_INVALID', 'RESET_ALLOWED', 'BUY_TRIGGERED', 'TP_TRIGGERED',
    'SLOT_PROFIT_CREDITED', 'SLOT_BALANCE_UPDATED',
    'INTRABAR_AMBIGUOUS', 'DATA_GAP'
  ));

insert into coinops.robot_v1_audit_events
  (product_id, tenant_id, user_id, config_id, cycle_id, slot_id, event_type,
   previous_state, next_state, observed_at, idempotency_key)
select c.product_id, c.tenant_id, c.user_id, c.config_id,
       o.cycle_id, o.slot_id, e.event_type,
       jsonb_build_object('balanceUsdc', c.previous_balance_usdc),
       jsonb_build_object('operationId', o.id, 'slotNumber', c.slot_number,
         'netProfitUsdc', c.net_profit_usdc, 'balanceUsdc', c.new_balance_usdc),
       o.closed_at, 'robot-v1-shadow-' || e.event_type || ':' || o.id::text
from coinops.robot_v1_slot_profit_credits c
join coinops.robot_v1_slot_operations o on o.id = c.operation_id
cross join (values ('SLOT_PROFIT_CREDITED'), ('SLOT_BALANCE_UPDATED')) as e(event_type)
on conflict (product_id, tenant_id, user_id, idempotency_key) do nothing;

create function coinops.credit_robot_v1_shadow_operation()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  v_config coinops.robot_v1_configs%rowtype;
  v_cycle coinops.robot_v1_cycles%rowtype;
  v_slot coinops.robot_v1_slots%rowtype;
  v_account coinops.robot_v1_slot_accounts%rowtype;
  v_credited uuid;
begin
  select * into strict v_cycle from coinops.robot_v1_cycles where id = new.cycle_id;
  select * into strict v_config from coinops.robot_v1_configs where id = v_cycle.config_id;
  select * into strict v_slot from coinops.robot_v1_slots where id = new.slot_id and cycle_id = new.cycle_id;
  if v_config.execution_mode <> 'SHADOW' or v_cycle.execution_mode <> 'SHADOW'
    or v_config.shadow_test_started_at is null or v_cycle.started_at < v_config.shadow_test_started_at
    or (new.product_id, new.tenant_id, new.user_id) is distinct from (v_config.product_id, v_config.tenant_id, v_config.user_id)
    or (v_cycle.product_id, v_cycle.tenant_id, v_cycle.user_id) is distinct from (v_config.product_id, v_config.tenant_id, v_config.user_id)
    or (v_slot.product_id, v_slot.tenant_id, v_slot.user_id) is distinct from (v_config.product_id, v_config.tenant_id, v_config.user_id)
    or new.physical_slot_number <> v_slot.slot_number
  then raise exception 'COINOPS_V1_SHADOW_CREDIT_SCOPE_INVALID'; end if;

  select * into strict v_account from coinops.robot_v1_slot_accounts
  where config_id = v_config.id and slot_number = v_slot.slot_number
    and product_id = v_config.product_id and tenant_id = v_config.tenant_id and user_id = v_config.user_id
  for update;

  insert into coinops.robot_v1_slot_profit_credits
    (operation_id, config_id, slot_number, product_id, tenant_id, user_id,
     previous_balance_usdc, net_profit_usdc, new_balance_usdc)
  values (new.id, v_config.id, v_slot.slot_number, v_config.product_id, v_config.tenant_id, v_config.user_id,
          v_account.balance_usdc, new.net_quote_pnl, v_account.balance_usdc + new.net_quote_pnl)
  on conflict (operation_id) do nothing returning operation_id into v_credited;
  if v_credited is null then return new; end if;

  update coinops.robot_v1_slot_accounts
  set balance_usdc = v_account.balance_usdc + new.net_quote_pnl,
      gain_count = gain_count + 1,
      gross_profit_usdc = gross_profit_usdc + new.gross_quote_pnl,
      fees_usdc = fees_usdc + new.estimated_quote_fees,
      net_profit_usdc = net_profit_usdc + new.net_quote_pnl,
      last_operation_id = new.id, updated_at = timezone('utc', now())
  where config_id = v_config.id and slot_number = v_slot.slot_number;

  insert into coinops.robot_v1_audit_events
    (product_id, tenant_id, user_id, config_id, cycle_id, slot_id, event_type,
     previous_state, next_state, observed_at, idempotency_key)
  select v_config.product_id, v_config.tenant_id, v_config.user_id, v_config.id,
         new.cycle_id, new.slot_id, e.event_type,
         jsonb_build_object('balanceUsdc', v_account.balance_usdc),
         jsonb_build_object('operationId', new.id, 'slotNumber', v_slot.slot_number,
           'netProfitUsdc', new.net_quote_pnl, 'balanceUsdc', v_account.balance_usdc + new.net_quote_pnl),
         new.closed_at, 'robot-v1-shadow-' || e.event_type || ':' || new.id::text
  from (values ('SLOT_PROFIT_CREDITED'), ('SLOT_BALANCE_UPDATED')) as e(event_type)
  on conflict (product_id, tenant_id, user_id, idempotency_key) do nothing;
  return new;
end $$;

revoke all on function coinops.credit_robot_v1_shadow_operation() from public, anon, authenticated;
grant execute on function coinops.credit_robot_v1_shadow_operation() to service_role;
create trigger robot_v1_shadow_operation_credit
  after insert on coinops.robot_v1_slot_operations
  for each row execute function coinops.credit_robot_v1_shadow_operation();

comment on table coinops.robot_v1_slot_accounts is 'Current virtual USDC balance for each physical V1 Shadow slot; survives cycle reanchors.';
comment on table coinops.robot_v1_slot_profit_credits is 'One immutable, idempotent credit per completed Shadow operation, with before and after balances.';
