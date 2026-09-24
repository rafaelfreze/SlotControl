-- CoinOps 5.6 contract step. Apply ONLY after the engine-aware application and
-- executor deployment are READY. The preceding expand migration already added
-- every replacement key; no rows, financial history or exchange IDs are changed.
begin;
do $$declare r record;begin
 for r in select c.conname,t.relname from pg_constraint c
 join pg_class t on t.oid=c.conrelid join pg_namespace n on n.oid=t.relnamespace
 where n.nspname='coinops' and c.contype='u' and (
  (t.relname='robot_v1_strategy_decisions' and pg_get_constraintdef(c.oid)='UNIQUE (product_id, tenant_id, user_id, environment, decision_id)')
  or (t.relname in ('robot_v1_audit_events','robot_v1_slots') and pg_get_constraintdef(c.oid)='UNIQUE (product_id, tenant_id, user_id, idempotency_key)')
  or (t.relname='robot_v1_live_alerts' and pg_get_constraintdef(c.oid)='UNIQUE (product_id, tenant_id, user_id, alert_key)')
  or (t.relname in ('robot_v1_live_runs','robot_v1_testnet_runs') and pg_get_constraintdef(c.oid)='UNIQUE (reset_idempotency_key)')
 ) loop execute format('alter table coinops.%I drop constraint %I',r.relname,r.conname);end loop;
end $$;
drop index coinops.robot_v1_testnet_reset_idempotency;
commit;
