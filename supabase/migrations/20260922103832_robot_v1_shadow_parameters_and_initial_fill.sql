-- V1 Shadow parameters are isolated from the BTC/SOL operational strategy.
-- Active cycles retain their persisted snapshot; changes apply only to a new cycle.

alter table coinops.robot_v1_configs
  add column gain_rate numeric(12,8),
  add column entry_spacing numeric(12,8),
  add column next_gain_rate numeric(12,8),
  add column next_entry_spacing numeric(12,8);

update coinops.robot_v1_configs
set gain_rate = case asset when 'BTC' then 0.012 else 0.055 end,
    entry_spacing = case asset when 'BTC' then 0.02 else 0.03 end
where gain_rate is null or entry_spacing is null;

alter table coinops.robot_v1_configs
  alter column gain_rate set not null,
  alter column entry_spacing set not null,
  add constraint robot_v1_configs_gain_rate_range check (gain_rate >= 0.001 and gain_rate <= 0.20),
  add constraint robot_v1_configs_entry_spacing_range check (entry_spacing >= 0.001 and entry_spacing <= 0.20),
  add constraint robot_v1_configs_next_gain_rate_range check (next_gain_rate is null or (next_gain_rate >= 0.001 and next_gain_rate <= 0.20)),
  add constraint robot_v1_configs_next_entry_spacing_range check (next_entry_spacing is null or (next_entry_spacing >= 0.001 and next_entry_spacing <= 0.20));

alter table coinops.robot_v1_cycles
  add column gain_rate numeric(12,8),
  add column entry_spacing numeric(12,8),
  add column completion_reason text;

update coinops.robot_v1_cycles
set gain_rate = case asset when 'BTC' then 0.012 else 0.055 end,
    entry_spacing = case asset when 'BTC' then 0.02 else 0.03 end
where gain_rate is null or entry_spacing is null;

alter table coinops.robot_v1_cycles
  alter column gain_rate set not null,
  alter column entry_spacing set not null,
  add constraint robot_v1_cycles_gain_rate_range check (gain_rate >= 0.001 and gain_rate <= 0.20),
  add constraint robot_v1_cycles_entry_spacing_range check (entry_spacing >= 0.001 and entry_spacing <= 0.20);

alter table coinops.robot_v1_audit_events
  drop constraint robot_v1_audit_events_event_type_check,
  add constraint robot_v1_audit_events_event_type_check check (event_type in (
    'CAPITAL_CHANGED', 'CAPITAL_NEXT_CYCLE', 'PARAMETERS_NEXT_CYCLE',
    'SHADOW_STARTED', 'PAUSED', 'RESUMED', 'KILL_SWITCH_ENABLED', 'KILL_SWITCH_DISABLED',
    'CYCLE_STARTED', 'CYCLE_COMPLETED', 'CYCLE_RESTARTED', 'INITIAL_POSITION_OPENED',
    'RESET_ALLOWED', 'BUY_TRIGGERED', 'TP_TRIGGERED', 'INTRABAR_AMBIGUOUS', 'DATA_GAP'
  ));

comment on column coinops.robot_v1_configs.gain_rate is 'Current V1 Shadow gain fraction only; never the principal BTC/SOL strategy rate.';
comment on column coinops.robot_v1_configs.entry_spacing is 'Current V1 Shadow compounded entry spacing fraction only.';
comment on column coinops.robot_v1_configs.next_gain_rate is 'Requested gain fraction for the next V1 Shadow cycle.';
comment on column coinops.robot_v1_configs.next_entry_spacing is 'Requested compounded spacing fraction for the next V1 Shadow cycle.';
comment on column coinops.robot_v1_cycles.completion_reason is 'Shadow lifecycle reason such as TEST_RESTARTED; historical slots remain immutable.';
