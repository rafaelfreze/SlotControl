-- Cover the two foreign keys reported by the Supabase performance advisor.
create index asset_external_contribution_batches_product_fk_idx
  on coinops.asset_external_contribution_batches (product_code, product_id);

create index asset_external_contribution_batches_baseline_id_idx
  on coinops.asset_external_contribution_batches (baseline_id);
