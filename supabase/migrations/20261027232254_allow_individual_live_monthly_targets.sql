-- CoinOps / OnPlay Platform / coinops. No financial row is modified.
-- The plan, bulk editor and runtime use a positive per-engine monthly target.
-- The legacy asset-specific CHECK (BTC=7/SOL=2) rejected valid new plans at
-- INSERT, rolling back engine/cap/reservation creation with SQLSTATE 23514.
-- Defaults remain BTC=7/SOL=2; existing targets and all ledger history stay put.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

alter table coinops.robot_v1_live_preparations
  drop constraint robot_v1_live_monthly_target,
  add constraint robot_v1_live_monthly_target
    check (monthly_target >= 1) not valid;

alter table coinops.robot_v1_live_preparations
  validate constraint robot_v1_live_monthly_target;
