-- Reversible removal of a CoinOps-only viewer binding. Never delete shared Auth.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';
alter table coinops.viewer_access add column if not exists deleted_at timestamptz;
alter table coinops.viewer_access add constraint viewer_access_deleted_inactive
  check (deleted_at is null or status = 'INACTIVE');
comment on column coinops.viewer_access.deleted_at is
  'Soft removal by CoinOps ADMIN; retains Auth identity, audit binding and deny guard. CREATE may restore the same email within its operator.';
commit;
