-- 4.1.1: permit idempotent, narrowly scoped repair evidence from the Shadow
-- engine. This migration changes no balance, position, order, or history.
alter table coinops.robot_v1_audit_events
  drop constraint robot_v1_audit_events_event_type_check;
alter table coinops.robot_v1_audit_events
  add constraint robot_v1_audit_events_event_type_check check (event_type in (
    'CAPITAL_CHANGED', 'CAPITAL_NEXT_CYCLE', 'PARAMETERS_NEXT_CYCLE',
    'SHADOW_STARTED', 'PAUSED', 'RESUMED', 'KILL_SWITCH_ENABLED', 'KILL_SWITCH_DISABLED',
    'CYCLE_STARTED', 'CYCLE_COMPLETED', 'CYCLE_RESTARTED', 'INITIAL_POSITION_OPENED',
    'SLOT_RECYCLED', 'SLOT_REENTRY_PLANNED', 'SLOT_REENTRY_ARMED', 'SHADOW_STATE_REPAIRED',
    'GRID_INVALID', 'RESET_ALLOWED', 'BUY_TRIGGERED', 'TP_TRIGGERED',
    'SLOT_PROFIT_CREDITED', 'SLOT_BALANCE_UPDATED', 'NEXT_BUY_ARMED', 'NEXT_BUY_DISARMED',
    'MISSED_LEVEL_DURING_REARM', 'INTRABAR_AMBIGUOUS', 'DATA_GAP',
    'SHADOW_TICK_DRIFT_REPAIRED', 'SHADOW_GRID_AUTO_RESUMED'
  ));
