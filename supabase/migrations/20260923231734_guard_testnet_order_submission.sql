-- CoinOps only. Consuming a dispatch permit is not evidence of an exchange ACK.
-- After an uncertain POST, recovery is GET-only for the same durable identity.
alter table coinops.robot_v1_testnet_orders
  add column if not exists submission_guarded_at timestamptz;

-- During a rolling deployment an old runtime may still insert orders without
-- this field. Treat those as uncertain too; the new runtime explicitly inserts
-- NULL before its compare-and-set consumes the first dispatch permit.
alter table coinops.robot_v1_testnet_orders
  alter column submission_guarded_at set default clock_timestamp();

comment on column coinops.robot_v1_testnet_orders.submission_guarded_at is
  'Immutable time at which the single submission permit was consumed. Not a sent/ack/fill timestamp. Non-null PREPARED rows recover by reads only.';

-- A pre-migration PREPARED row may already have reached Binance. Preserve that
-- uncertainty rather than replaying a MARKET order whose ACK was lost.
update coinops.robot_v1_testnet_orders
set submission_guarded_at = clock_timestamp()
where status = 'PREPARED' and submission_guarded_at is null;

create or replace function coinops.preserve_testnet_submission_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.submission_guarded_at is not null
    and new.submission_guarded_at is distinct from old.submission_guarded_at then
    raise exception 'COINOPS_TESTNET_SUBMISSION_GUARD_IMMUTABLE';
  end if;
  return new;
end;
$$;
revoke all on function coinops.preserve_testnet_submission_guard() from public, anon, authenticated;
grant execute on function coinops.preserve_testnet_submission_guard() to service_role;

create trigger robot_v1_testnet_submission_guard_immutable
before update of submission_guarded_at on coinops.robot_v1_testnet_orders
for each row execute function coinops.preserve_testnet_submission_guard();
