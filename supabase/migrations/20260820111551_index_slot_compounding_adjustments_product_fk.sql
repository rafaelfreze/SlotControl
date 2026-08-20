-- Cover the product catalog foreign key used by the compound-adjustment audit.
create index if not exists slot_compounding_adjustments_product_idx
  on coinops.slot_compounding_adjustments (product_code, product_id);
