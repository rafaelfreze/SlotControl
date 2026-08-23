-- Cover the composite product foreign key used by the immutable operational
-- reconciliation report. This is intentionally additive and does not change
-- any CoinOps financial row.
create index if not exists slot_operational_reconciliations_product_fk_idx
  on coinops.slot_operational_reconciliations (product_code, product_id);
