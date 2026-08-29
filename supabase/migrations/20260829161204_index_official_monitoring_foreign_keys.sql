-- Index only the unindexed foreign-key columns from official monitoring.
-- Additive and monitoring-only: no data or domain behavior is changed.

create index if not exists cycle_daily_snapshots_baseline_id_idx
  on coinops.cycle_daily_snapshots (baseline_id);

create index if not exists cycle_progress_events_cycle_id_idx
  on coinops.cycle_progress_events (cycle_id);

create index if not exists cycle_progress_events_progress_id_idx
  on coinops.cycle_progress_events (progress_id);

create index if not exists cycle_progress_events_slot_id_idx
  on coinops.cycle_progress_events (slot_id);

create index if not exists cycle_reports_baseline_id_idx
  on coinops.cycle_reports (baseline_id);

create index if not exists cycle_reports_strategy_version_id_idx
  on coinops.cycle_reports (strategy_version_id);

create index if not exists cycle_slot_progress_baseline_id_idx
  on coinops.cycle_slot_progress (baseline_id);

create index if not exists cycle_slot_progress_slot_id_idx
  on coinops.cycle_slot_progress (slot_id);

create index if not exists monitoring_baseline_slots_slot_id_idx
  on coinops.monitoring_baseline_slots (slot_id);

create index if not exists monitoring_baselines_strategy_version_id_idx
  on coinops.monitoring_baselines (strategy_version_id);

create index if not exists operational_cycles_strategy_version_id_idx
  on coinops.operational_cycles (strategy_version_id);

create index if not exists slot_pool_configuration_slot_id_idx
  on coinops.slot_pool_configuration (slot_id);

create index if not exists strategy_regime_events_baseline_id_idx
  on coinops.strategy_regime_events (baseline_id);
