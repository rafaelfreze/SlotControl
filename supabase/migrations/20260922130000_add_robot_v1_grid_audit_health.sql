-- Persist the distinction between a reusable physical slot and its current
-- place in the immutable compounded ladder. This is Shadow-only metadata.

alter table coinops.robot_v1_slots
  add column logical_level integer;

update coinops.robot_v1_slots s
set logical_level = greatest(
  1,
  round(ln(s.buy_price / c.anchor_price) / ln(1 - c.entry_spacing))::integer + 1
)
from coinops.robot_v1_cycles c
where c.id = s.cycle_id;

alter table coinops.robot_v1_slots
  alter column logical_level set not null,
  add constraint robot_v1_slots_logical_level_positive check (logical_level > 0),
  add constraint robot_v1_slots_cycle_logical_level_unique unique (cycle_id, logical_level);

alter table coinops.robot_v1_slot_operations
  add column logical_level integer;

update coinops.robot_v1_slot_operations o
set logical_level = greatest(
  1,
  round(ln(o.entry_price / c.anchor_price) / ln(1 - c.entry_spacing))::integer + 1
)
from coinops.robot_v1_cycles c
where c.id = o.cycle_id;

alter table coinops.robot_v1_slot_operations
  alter column logical_level set not null,
  add constraint robot_v1_slot_operations_logical_level_positive check (logical_level > 0);

alter table coinops.robot_v1_configs
  add column last_market_price numeric(24,8),
  add column last_market_observed_at timestamptz,
  add column last_engine_at timestamptz,
  add column last_engine_error text,
  add column grid_status text,
  add column grid_error text,
  add constraint robot_v1_configs_grid_status_check check (grid_status is null or grid_status in ('VALID', 'INVALID'));

alter table coinops.robot_v1_audit_events
  drop constraint robot_v1_audit_events_event_type_check,
  add constraint robot_v1_audit_events_event_type_check check (event_type in (
    'CAPITAL_CHANGED', 'CAPITAL_NEXT_CYCLE', 'PARAMETERS_NEXT_CYCLE',
    'SHADOW_STARTED', 'PAUSED', 'RESUMED', 'KILL_SWITCH_ENABLED', 'KILL_SWITCH_DISABLED',
    'CYCLE_STARTED', 'CYCLE_COMPLETED', 'CYCLE_RESTARTED', 'INITIAL_POSITION_OPENED',
    'SLOT_RECYCLED', 'GRID_INVALID', 'RESET_ALLOWED', 'BUY_TRIGGERED', 'TP_TRIGGERED',
    'INTRABAR_AMBIGUOUS', 'DATA_GAP'
  ));

comment on column coinops.robot_v1_slots.logical_level is 'Current compounded ladder level. A recycled physical slot can move to a later logical level.';
comment on column coinops.robot_v1_slot_operations.logical_level is 'Immutable compounded ladder level of the completed Shadow operation.';
comment on column coinops.robot_v1_configs.grid_status is 'Last V1 active-grid validation result. INVALID pauses new Shadow entries.';
