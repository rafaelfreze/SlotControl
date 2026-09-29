-- The authenticated operator registry already exposes shard assignment in the UI,
-- but this column was not included in the existing column-level SELECT grant.
-- Keep access least-privilege and let the existing operator_owned RLS policy
-- continue to restrict rows to the signed-in operator.
begin;

grant select (executor_shard_id)
  on coinops.exchange_accounts
  to authenticated;

select pg_notify('pgrst', 'reload schema');

commit;
