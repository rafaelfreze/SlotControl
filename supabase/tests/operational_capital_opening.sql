-- LOCAL-ONLY PostgreSQL contract regression for the operational capital cutover.
-- No dependency on the linked Supabase, no copied production data, no secrets.
-- This minimal scaffold is deliberately not an application bootstrap. It tests
-- the actual new migration against its existing-table/helper contracts only.
--
-- Example against a NEW disposable PostgreSQL database named exactly below:
-- psql -X -h 127.0.0.1 -p <local-port> -U <local-test-superuser> \
--   -d coinops_opening_test --set=coinops_fixture_mode=local-only \
--   --set=ON_ERROR_STOP=1 --file=supabase/tests/operational_capital_opening.sql
-- The caller must not supply a remote host. All fixture DDL/data rolls back.
\set ON_ERROR_STOP on
\if :{?coinops_fixture_mode}
\else
  do $$ begin raise exception 'COINOPS_LOCAL_FIXTURE_MODE_REQUIRED'; end $$;
\endif
select :'coinops_fixture_mode' = 'local-only' as allowed \gset
\if :allowed
\else
  do $$ begin raise exception 'COINOPS_LOCAL_FIXTURE_MODE_INVALID'; end $$;
\endif

begin;
set local statement_timeout = '30s';
set local lock_timeout = '5s';
do $guard$
begin
  if current_database() <> 'coinops_opening_test'
    or inet_server_addr() is null
    or not (inet_server_addr() << inet '127.0.0.0/8' or inet_server_addr() = inet '::1')
    or not (select rolsuper from pg_roles where rolname = current_user)
    or to_regnamespace('coinops') is not null
    or to_regnamespace('auth') is not null
    or exists (select 1 from pg_roles where rolname in ('anon','authenticated','service_role')) then
    raise exception 'COINOPS_NEW_LOCAL_TEST_CLUSTER_REQUIRED';
  end if;
end
$guard$;

\ir operational_capital_opening_fixture.sql
\ir ../migrations/20260921120400_add_operational_capital_opening.sql

insert into public.products(id, code) values
  ('10000000-0000-0000-0000-000000000001', 'coinops');
insert into public.platform_tenants(id) values
  ('20000000-0000-0000-0000-000000000001'),
  ('20000000-0000-0000-0000-000000000002');
insert into public.product_tenants(product_id, tenant_id) values
  ('10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001'),
  ('10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000002');
insert into auth.users(id) values
  ('30000000-0000-0000-0000-000000000001'),
  ('30000000-0000-0000-0000-000000000002'),
  ('30000000-0000-0000-0000-000000000003');
insert into public.product_memberships(product_id, tenant_id, user_id, status) values
  ('10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'active'),
  ('10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000002', 'active'),
  ('10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000003', 'inactive');
insert into coinops.strategies(id, product_id, tenant_id, user_id, asset) values
  ('40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'BTC'),
  ('40000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'SOL'),
  ('40000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000002', 'BTC'),
  ('40000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000001', 'BTC');
insert into coinops.slots(id, product_id, tenant_id, user_id, strategy_id, slot_number,
  status, real_gains, added_gains, operational_gains, base_value, realized_profit,
  growth_contribution, position_notional_usdt, position_gain_unit_usdt,
  position_quantity, position_opened_at, preco_entrada, preco_alvo)
values
  ('50000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', 1,
    'aberto', 20, 2, 24, 10, 4, 15, 29, 0.58, 0.0003625, '2026-09-01 00:00:00Z', 80000, 81600),
  ('50000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000002', 1,
    'gain', 4, 0, 6, 25, 5, 5.2, null, null, null, null, null, null),
  ('50000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000003', 1,
    'zerado', 0, 0, 0, 25, 0, 0, null, null, null, null, null, null),
  ('50000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000004', 1,
    'zerado', 0, 0, 0, 25, 0, 0, null, null, null, null, null, null);

insert into coinops.btc_external_contributions(id, product_id, tenant_id, user_id,
  slot_id, slot_number, asset, input_mode, amount_usdt, accounting_amount_usdt,
  gain_equivalent, created_at)
values
  ('60000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001', 1, 'BTC', 'MANUAL_GAINS', 4, 3.75, 24, '2026-08-10 12:00:00Z'),
  ('60000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000002', 1, 'SOL', 'MANUAL_GAINS', 5.2, 5.2, 3, '2026-08-26 12:00:00Z'),
  ('60000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001', 1, 'BTC', 'USDT', 11.25, 11.25, 0, '2026-08-30 12:00:00Z'),
  ('60000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000002', '50000000-0000-0000-0000-000000000003', 1, 'BTC', 'USDT', 7, 7, 0, '2026-08-30 12:00:00Z'),
  ('60000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000004', 1, 'BTC', 'USDT', 9, 9, 0, '2026-08-30 12:00:00Z');

insert into coinops.slot_capital_ledger(product_id, tenant_id, user_id, slot_id, entry_type, amount_usdt)
values ('10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001', 'REAL_GAIN', 0.58);
insert into coinops.history_events(product_id, tenant_id, user_id, slot_id, action, detail)
values ('10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001', 'open', 'Existing frozen position');

select pg_temp.assert_true((select count(*) = 0 from coinops.slot_initial_capital), 'no receipt for slots before opening');
create temp table test_before as select private.coinops_capital_opening_snapshot(
  '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001') snapshot;
alter table test_before add column state_hash text;
update test_before set state_hash = encode(sha256(convert_to(snapshot::text, 'UTF8')), 'hex');

select pg_temp.assert_raises($q$select private.coinops_activate_capital_opening(
  '10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001',
  repeat('0',64),'70000000-0000-0000-0000-000000000001','Owner approved local fixture')$q$, 'COINOPS_CAPITAL_OPENING_SNAPSHOT_CHANGED');
select pg_temp.assert_true((select count(*) = 0 from coinops.capital_accounting_openings), 'wrong snapshot performs no write');
select pg_temp.assert_raises($q$select private.coinops_activate_capital_opening(
  '10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000002','30000000-0000-0000-0000-000000000001',
  repeat('0',64),'70000000-0000-0000-0000-000000000001','Owner approved local fixture')$q$, 'COINOPS_CAPITAL_OPENING_INVALID_SCOPE');
select pg_temp.assert_raises($q$select private.coinops_activate_capital_opening(
  '10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000003',
  repeat('0',64),'70000000-0000-0000-0000-000000000001','Owner approved local fixture')$q$, 'COINOPS_CAPITAL_OPENING_INVALID_SCOPE');

create temp table test_activation as select private.coinops_activate_capital_opening(
  '10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001',
  state_hash,'70000000-0000-0000-0000-000000000001','Owner approved local fixture') result from test_before;
select pg_temp.assert_true((select result->>'replayed' = 'false' and (result->>'slot_count')::int = 2
  and (result->>'incorporated_contribution_count')::int = 3 from test_activation), 'opening snapshots exactly the requested scope');
select pg_temp.assert_true((select private.coinops_capital_opening_snapshot(
  '10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001') = snapshot
  from test_before), 'all raw slots, positions, profits, gains, contribution rows, ledger and history preserved');
select pg_temp.assert_true((select cardinality(incorporated_contribution_ids) = 3
  and jsonb_array_length(slots_snapshot) = 2 and jsonb_array_length(contributions_snapshot) = 3
  from coinops.capital_accounting_openings), 'append-only opening contains original evidence');
select pg_temp.assert_true((select count(*) = 0 from coinops.capital_reporting_entries
  where user_id = '30000000-0000-0000-0000-000000000001'
    and tenant_id = '20000000-0000-0000-0000-000000000001' and not incorporated_in_opening), 'current reporting counters reset without removing history');
select pg_temp.assert_true((select private.coinops_activate_capital_opening(
  '10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001',
  state_hash,'70000000-0000-0000-0000-000000000001','Owner approved local fixture')->>'replayed' = 'true'
  from test_before), 'same key/hash/reason replays idempotently');
select pg_temp.assert_true((select count(*) = 1 from coinops.capital_accounting_openings), 'replay does not duplicate opening');
select pg_temp.assert_raises($q$select private.coinops_activate_capital_opening(
  '10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001',
  (select state_hash from test_before),'70000000-0000-0000-0000-000000000002','Owner approved local fixture')$q$, 'COINOPS_CAPITAL_OPENING_ALREADY_ACTIVATED');
select pg_temp.assert_raises($q$update coinops.capital_accounting_openings set reason = 'tampered opening'$q$, 'COINOPS_CAPITAL_OPENING_APPEND_ONLY');
select pg_temp.assert_raises($q$delete from coinops.capital_accounting_openings$q$, 'COINOPS_CAPITAL_OPENING_APPEND_ONLY');

-- A later receipt with an older event time must count: membership is by ID,
-- not timestamp, so imports and backdated entries cannot disappear silently.
insert into coinops.btc_external_contributions(id, product_id, tenant_id, user_id,
  slot_id, slot_number, asset, input_mode, amount_usdt, accounting_amount_usdt, gain_equivalent, created_at)
values ('60000000-0000-0000-0000-000000000006', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001', 1, 'BTC', 'MANUAL_GAINS', 2.5, 2.5, 3, '2026-01-01 00:00:00Z');
insert into coinops.slots(id, product_id, tenant_id, user_id, strategy_id, slot_number, base_value)
values
  ('50000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', 2, 25),
  ('50000000-0000-0000-0000-000000000006', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000003', 2, 25);
select pg_temp.assert_true((select count(*) = 1 and sum(amount_usdt) = 25 from coinops.slot_initial_capital), 'only new slot of activated scope captures its principal once');
select pg_temp.assert_true((select operational_slot_value = 25 and growth_contribution = 0 from coinops.slots
  where id = '50000000-0000-0000-0000-000000000005'), 'initial receipt does not add funding twice to slot balance');
update coinops.slots set base_value = 99 where id = '50000000-0000-0000-0000-000000000005';
select pg_temp.assert_true((select count(*) = 1 and sum(amount_usdt) = 25 from coinops.slot_initial_capital), 'later base-value edits neither change nor duplicate original principal');
select pg_temp.assert_raises($q$update coinops.slot_initial_capital set amount_usdt = 99$q$, 'COINOPS_CAPITAL_OPENING_APPEND_ONLY');
select pg_temp.assert_raises($q$delete from coinops.slot_initial_capital$q$, 'COINOPS_CAPITAL_OPENING_APPEND_ONLY');
select pg_temp.assert_true((select sum(accounting_amount_usdt) = 27.5 and sum(gain_equivalent) = 3
  from coinops.capital_reporting_entries where user_id = '30000000-0000-0000-0000-000000000001'
  and tenant_id = '20000000-0000-0000-0000-000000000001' and not incorporated_in_opening), 'new gains and new-slot capital count exactly once after activation');
select pg_temp.assert_true((select count(*) = 3 from coinops.capital_reporting_entries where incorporated_in_opening), 'original receipts retained after new entries');

set local role authenticated;
set local request.jwt.claim.sub = '30000000-0000-0000-0000-000000000001';
select pg_temp.assert_true((select count(*) = 1 from coinops.capital_accounting_openings), 'owner reads own opening');
select pg_temp.assert_true((select count(*) = 1 from coinops.slot_initial_capital), 'owner reads own initial-principal receipt');
select pg_temp.assert_true((select count(*) = 5 from coinops.capital_reporting_entries), 'security-invoker view excludes foreign tenant and user rows');
insert into coinops.slots(id, product_id, tenant_id, user_id, strategy_id, slot_number, base_value)
values ('50000000-0000-0000-0000-000000000007', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', 3, 30);
select pg_temp.assert_true((select count(*) = 2 and sum(amount_usdt) = 55 from coinops.slot_initial_capital), 'authenticated slot insert runs the restricted receipt trigger');
select pg_temp.assert_true((select operational_slot_value = 30 and growth_contribution = 0 from coinops.slots
  where id = '50000000-0000-0000-0000-000000000007'), 'authenticated creation preserves exact initial operational balance');
select pg_temp.assert_raises($q$select private.coinops_activate_capital_opening(
  '10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001',
  repeat('0',64),'70000000-0000-0000-0000-000000000002','Unauthorized client operation')$q$, 'permission denied');
select pg_temp.assert_raises($q$select private.coinops_capital_opening_snapshot(
  '10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001')$q$, 'permission denied');
select pg_temp.assert_raises($q$insert into coinops.slot_initial_capital(slot_id) values(gen_random_uuid())$q$, 'permission denied');
select pg_temp.assert_raises($q$update coinops.capital_accounting_openings set reason = 'Unauthorized client change'$q$, 'permission denied');
set local request.jwt.claim.sub = '30000000-0000-0000-0000-000000000002';
select pg_temp.assert_true((select count(*) = 0 from coinops.capital_accounting_openings), 'other tenant cannot read owner opening');
select pg_temp.assert_true((select count(*) = 0 from coinops.slot_initial_capital), 'other tenant cannot read owner principal');
select pg_temp.assert_true((select count(*) = 1 and sum(amount_usdt) = 7 from coinops.capital_reporting_entries), 'other owner retains pre-cutover reporting');
set local request.jwt.claim.sub = '30000000-0000-0000-0000-000000000003';
select pg_temp.assert_true((select count(*) = 0 from coinops.capital_reporting_entries), 'inactive member sees no reporting rows');
set local request.jwt.claim.sub = '';
select pg_temp.assert_true((select count(*) = 0 from coinops.capital_reporting_entries), 'missing auth identity sees no reporting rows');
reset role;
set local role anon;
select pg_temp.assert_raises('select * from coinops.capital_reporting_entries', 'permission denied');
reset role;
set local role service_role;
select pg_temp.assert_raises($q$select private.coinops_activate_capital_opening(
  '10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001',
  repeat('0',64),'70000000-0000-0000-0000-000000000002','Unauthorized service operation')$q$, 'permission denied');
reset role;

select pg_temp.assert_true((select private.coinops_activate_capital_opening(
  '10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001',
  state_hash,'70000000-0000-0000-0000-000000000001','Owner approved local fixture')->>'replayed' = 'true'
  from test_before), 'replay after new movements keeps the same immutable opening');

rollback;
select to_regnamespace('coinops') is null as fixture_fully_rolled_back;

-- Repeatable-read cannot safely see a concurrent cutover after waiting for its
-- relation lock. Both new-slot capture and activation deliberately reject it.
begin isolation level repeatable read;
set local statement_timeout = '30s';
\ir operational_capital_opening_fixture.sql
\ir ../migrations/20260921120400_add_operational_capital_opening.sql
select pg_temp.assert_raises($q$select private.coinops_activate_capital_opening(
  '10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001',
  repeat('0',64),'70000000-0000-0000-0000-000000000001','Owner approved local fixture')$q$, 'COINOPS_CAPITAL_OPENING_READ_COMMITTED_REQUIRED');
insert into coinops.strategies(id, product_id, tenant_id, user_id, asset) values
  ('40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'BTC');
select pg_temp.assert_raises($q$insert into coinops.slots(id, product_id, tenant_id, user_id, strategy_id, slot_number, base_value)
values ('50000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', 1, 25)$q$, 'COINOPS_CAPITAL_OPENING_READ_COMMITTED_REQUIRED');
rollback;
select to_regnamespace('coinops') is null as isolation_fixture_fully_rolled_back;
