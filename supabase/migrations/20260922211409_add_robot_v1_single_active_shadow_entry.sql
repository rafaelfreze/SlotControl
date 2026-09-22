-- A calculated physical slot is not an exchange order. Only the next entry
-- may be armed; the remaining pending levels stay planned in CoinOps.
alter table coinops.robot_v1_slots
  add column entry_state text not null default 'NONE',
  add column armed_at timestamptz,
  add column missed_at timestamptz;

alter table coinops.robot_v1_slots
  add constraint robot_v1_slots_entry_state_check
  check (entry_state in ('NONE', 'ARMED', 'PLANNED')),
  add constraint robot_v1_slots_armed_only_pending_check
  check (entry_state <> 'ARMED' or (status = 'PENDING' and armed_at is not null));

-- The migration is additive to existing active Shadow cycles. The closest
-- still-pending price becomes the single armed entry at migration time;
-- the worker never retroactively fills candles that predate armed_at.
update coinops.robot_v1_slots s
set missed_at = clock_timestamp()
from coinops.robot_v1_cycles cy
join coinops.robot_v1_configs c on c.id = cy.config_id
where s.cycle_id = cy.id and s.status = 'PENDING'
  and cy.status in ('STARTING', 'GRID_ACTIVE', 'POSITIONS_ACTIVE', 'RESETTING')
  and c.last_market_price is not null and s.buy_price >= c.last_market_price;

with ranked as (
  select s.id, row_number() over (partition by s.cycle_id order by s.buy_price desc, s.slot_number) as position
  from coinops.robot_v1_slots s
  join coinops.robot_v1_cycles cy on cy.id = s.cycle_id
  where s.status = 'PENDING' and s.missed_at is null
    and cy.status in ('STARTING', 'GRID_ACTIVE', 'POSITIONS_ACTIVE', 'RESETTING')
)
update coinops.robot_v1_slots s
set entry_state = case when ranked.position = 1 then 'ARMED' else 'PLANNED' end,
    armed_at = case when ranked.position = 1 then clock_timestamp() else null end
from ranked where ranked.id = s.id;

update coinops.robot_v1_slots
set entry_state = 'PLANNED'
where status = 'PENDING' and entry_state = 'NONE';

create unique index robot_v1_one_armed_buy_per_cycle
  on coinops.robot_v1_slots (cycle_id)
  where entry_state = 'ARMED';

create index robot_v1_planned_entries_by_level
  on coinops.robot_v1_slots (cycle_id, buy_price desc)
  where status = 'PENDING' and entry_state = 'PLANNED';

comment on column coinops.robot_v1_slots.entry_state is 'Only one PENDING slot per cycle is ARMED; other PENDING physical slots are PLANNED, never simultaneous exchange orders.';
comment on column coinops.robot_v1_slots.missed_at is 'The planned level was crossed before an order could have resided there; never synthesize a retroactive fill.';

-- Future SOL/BRL pilot limits are deliberately unset. No Production writer
-- reads these columns and TESTNET/SHADOW remain the only accepted V1 modes.
alter table coinops.robot_v1_configs
  add column configured_live_capital_brl numeric(20, 8),
  add column max_order_notional_brl numeric(20, 8),
  add column max_total_exposure_brl numeric(20, 8);

alter table coinops.robot_v1_configs
  add constraint robot_v1_sol_brl_pilot_caps_check check (
    (configured_live_capital_brl is null and max_order_notional_brl is null and max_total_exposure_brl is null)
    or (asset = 'SOL' and configured_live_capital_brl > 0 and max_order_notional_brl > 0
      and max_total_exposure_brl > 0 and max_order_notional_brl <= max_total_exposure_brl
      and max_total_exposure_brl <= configured_live_capital_brl)
  );
