-- Cover every FK introduced by selective contribution presets. This keeps
-- delete/restrict checks bounded without changing preset or ledger semantics.
begin;
set local lock_timeout='3s';
set local statement_timeout='30s';

create index robot_v1_live_selective_presets_scope_fk_idx
  on coinops.robot_v1_live_selective_contribution_presets
  (operator_id,product_id,tenant_id,user_id);
create index robot_v1_live_selective_preset_usages_scope_fk_idx
  on coinops.robot_v1_live_selective_contribution_preset_usages
  (operator_id,product_id,tenant_id,user_id);
create index robot_v1_live_selective_preset_usages_preset_fk_idx
  on coinops.robot_v1_live_selective_contribution_preset_usages(preset_id);
create index robot_v1_live_selective_preset_usages_engine_fk_idx
  on coinops.robot_v1_live_selective_contribution_preset_usages(trading_engine_id);

commit;
