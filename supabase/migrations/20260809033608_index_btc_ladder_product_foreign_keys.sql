-- Cover the shared OnPlay Platform product foreign keys used by the CoinOps
-- BTC ladder tables. Scope-specific indexes remain available for user reads.

create index btc_redistribution_batches_product_fk_idx
  on coinops.btc_redistribution_batches (product_code, product_id);

create index btc_redistribution_transfers_product_fk_idx
  on coinops.btc_redistribution_transfers (product_code, product_id);

create index btc_external_contributions_product_fk_idx
  on coinops.btc_external_contributions (product_code, product_id);

create index slot_capital_ledger_product_fk_idx
  on coinops.slot_capital_ledger (product_code, product_id);

create index growth_plan_goal_audit_product_fk_idx
  on coinops.growth_plan_goal_audit (product_code, product_id);
