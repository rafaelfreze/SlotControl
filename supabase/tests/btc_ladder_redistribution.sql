-- CoinOps BTC ladder redistribution: transactional integration fixture.
--
-- LOCAL/FIXTURE ONLY. This script must never be pointed at the linked or
-- production Supabase database. It requires the shared CoinOps scaffold and
-- 20260809033335_add_btc_ladder_redistribution.sql to be applied first.
--
-- Example (PowerShell, local PostgreSQL only):
--   & psql.exe $env:COINOPS_LOCAL_DATABASE_URL `
--     --set=coinops_fixture_mode=local-only `
--     --set=ON_ERROR_STOP=1 `
--     --file=supabase/tests/btc_ladder_redistribution.sql
--
-- Every fixture and mutation is inside one transaction and the final command
-- is ROLLBACK. With ON_ERROR_STOP, an assertion failure closes the connection
-- with the transaction uncommitted, so PostgreSQL rolls it back as well.

\set ON_ERROR_STOP on

\if :{?coinops_fixture_mode}
\else
  \echo 'Refusing to run: pass --set=coinops_fixture_mode=local-only against a local fixture database.'
  do $$ begin raise exception 'COINOPS_LOCAL_FIXTURE_MODE_REQUIRED'; end $$;
\endif

select :'coinops_fixture_mode' = 'local-only' as coinops_fixture_allowed \gset
\if :coinops_fixture_allowed
\else
  \echo 'Refusing to run: coinops_fixture_mode must be exactly local-only.'
  do $$ begin raise exception 'COINOPS_LOCAL_FIXTURE_MODE_INVALID'; end $$;
\endif

begin;

set local statement_timeout = '30s';
set local lock_timeout = '5s';

do $preflight$
declare
  is_superuser boolean;
  server_address inet;
begin
  select role.rolsuper
    into is_superuser
  from pg_catalog.pg_roles role
  where role.rolname = current_user;

  if not coalesce(is_superuser, false) then
    raise exception 'TEST_LOCAL_SUPERUSER_REQUIRED';
  end if;
  if current_database() <> 'coinops_ladder_test' then
    raise exception 'TEST_LOCAL_DATABASE_REQUIRED';
  end if;

  server_address := pg_catalog.inet_server_addr();
  if server_address is not null
    and not (
      server_address << inet '127.0.0.0/8'
      or server_address = inet '::1'
    ) then
    raise exception 'TEST_LOOPBACK_SERVER_REQUIRED';
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
    raise exception 'TEST_AUTHENTICATED_ROLE_REQUIRED';
  end if;
  if to_regprocedure('coinops.prepare_btc_ladder_redistribution(numeric,uuid)') is null
    or to_regprocedure('coinops.confirm_btc_ladder_redistribution(uuid,uuid)') is null
    or to_regprocedure('coinops.apply_btc_external_contribution(uuid,numeric,text,uuid)') is null then
    raise exception 'TEST_BTC_LADDER_MIGRATION_REQUIRED';
  end if;
end;
$preflight$;

create temporary table fixture_scope (
  product_id uuid not null,
  tenant_id uuid not null,
  primary key (product_id, tenant_id)
) on commit drop;

insert into fixture_scope (product_id, tenant_id)
select product.id, tenant_link.tenant_id
from public.products product
join public.product_tenants tenant_link on tenant_link.product_id = product.id
join public.platform_tenants tenant on tenant.id = tenant_link.tenant_id
where product.code = 'coinops'
  and product.product_type = 'internal'
  and product.status = 'active'
  and tenant_link.status = 'active'
  and tenant.status = 'active'
order by product.id, tenant_link.tenant_id
limit 1;

create or replace function pg_temp.assert_true(
  condition boolean,
  message text
)
returns void
language plpgsql
as $assert$
begin
  if condition is not true then
    raise exception 'TEST_ASSERTION_FAILED: %', message;
  end if;
end;
$assert$;

create or replace function pg_temp.assert_numeric(
  actual numeric,
  expected numeric,
  message text,
  tolerance numeric default 0.00000001
)
returns void
language plpgsql
as $assert_numeric$
begin
  if actual is null or expected is null or abs(actual - expected) > tolerance then
    raise exception 'TEST_ASSERTION_FAILED: % (actual=%, expected=%)', message, actual, expected;
  end if;
end;
$assert_numeric$;

create or replace function pg_temp.expect_error(
  statement text,
  expected_fragment text default null
)
returns void
language plpgsql
as $expect_error$
declare
  caught_message text;
begin
  begin
    execute statement;
  exception
    when others then
      caught_message := sqlerrm;
  end;

  if caught_message is null then
    raise exception 'TEST_EXPECTED_ERROR_NOT_RAISED: %', statement;
  end if;
  if expected_fragment is not null
    and position(expected_fragment in caught_message) = 0 then
    raise exception 'TEST_UNEXPECTED_ERROR: expected %, received %', expected_fragment, caught_message;
  end if;
end;
$expect_error$;

select pg_temp.assert_true(
  (select count(*) from fixture_scope) = 1,
  'the local scaffold must expose one active CoinOps product/tenant pair'
);

-- Real Supabase scaffolds may enforce a membership FK to auth.users. The
-- minimal local scaffold intentionally does not create auth.users, hence the
-- guarded dynamic insert.
do $auth_fixture$
begin
  if to_regclass('auth.users') is not null then
    execute $insert_users$
      insert into auth.users (
        id, aud, role, email, encrypted_password,
        email_confirmed_at, created_at, updated_at
      ) values
        (
          '91000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated',
          'btc-ladder-a@fixture.invalid', 'fixture-only', now(), now(), now()
        ),
        (
          '91000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated',
          'btc-ladder-b@fixture.invalid', 'fixture-only', now(), now(), now()
        ),
        (
          '91000000-0000-0000-0000-000000000003', 'authenticated', 'authenticated',
          'btc-ladder-no-membership@fixture.invalid', 'fixture-only', now(), now(), now()
        )
      on conflict (id) do nothing
    $insert_users$;
  end if;
end;
$auth_fixture$;

insert into public.product_memberships (
  product_id, tenant_id, user_id, role_key, status
)
select scope.product_id, scope.tenant_id, fixture.user_id, 'coinops.owner', 'active'
from fixture_scope scope
cross join (values
  ('91000000-0000-0000-0000-000000000001'::uuid),
  ('91000000-0000-0000-0000-000000000002'::uuid)
) fixture(user_id);

insert into coinops.strategies (
  id, product_id, tenant_id, user_id, key, title, display_name, asset,
  base_value, gain_rate, initial_slots, drop_percent, restart_amount, sort_order
)
select
  fixture.strategy_id,
  scope.product_id,
  scope.tenant_id,
  fixture.user_id,
  'btc',
  'BTC fixture',
  'BTC fixture',
  'BTC',
  10,
  0.01,
  fixture.slot_count,
  0,
  0,
  1
from fixture_scope scope
cross join (values
  (
    '92000000-0000-0000-0000-000000000001'::uuid,
    '91000000-0000-0000-0000-000000000001'::uuid,
    2
  ),
  (
    '92000000-0000-0000-0000-000000000002'::uuid,
    '91000000-0000-0000-0000-000000000002'::uuid,
    3
  )
) fixture(strategy_id, user_id, slot_count);

insert into coinops.slots (
  id, product_id, tenant_id, user_id, strategy_id,
  slot_number, sort_order, status, gains, real_gains, added_gains,
  operational_gains, base_value, gain_rate, realized_profit,
  growth_contribution, started_once, notes,
  preco_entrada, preco_atual, preco_alvo
)
select
  fixture.slot_id,
  scope.product_id,
  scope.tenant_id,
  fixture.user_id,
  fixture.strategy_id,
  fixture.slot_number,
  fixture.slot_number,
  fixture.status,
  fixture.real_gains,
  fixture.real_gains,
  0,
  fixture.operational_gains,
  10,
  0.01,
  fixture.realized_profit,
  0,
  true,
  'btc ladder SQL fixture',
  fixture.entry,
  fixture.current_price,
  fixture.target
from fixture_scope scope
cross join (values
  -- Scenario 1: A20/B10, both closed.
  (
    '93000000-0000-0000-0000-000000000001'::uuid,
    '91000000-0000-0000-0000-000000000001'::uuid,
    '92000000-0000-0000-0000-000000000001'::uuid,
    1, 'gain', 20, 20::numeric, 2::numeric, null::numeric, null::numeric, null::numeric
  ),
  (
    '93000000-0000-0000-0000-000000000002'::uuid,
    '91000000-0000-0000-0000-000000000001'::uuid,
    '92000000-0000-0000-0000-000000000001'::uuid,
    2, 'gain', 10, 10::numeric, 1::numeric, null::numeric, null::numeric, null::numeric
  ),
  -- Scenario 2: A20/B10/C12. A is OPEN and must still donate.
  (
    '94000000-0000-0000-0000-000000000001'::uuid,
    '91000000-0000-0000-0000-000000000002'::uuid,
    '92000000-0000-0000-0000-000000000002'::uuid,
    1, 'aberto', 20, 20::numeric, 2::numeric, 100::numeric, 102::numeric, 101::numeric
  ),
  (
    '94000000-0000-0000-0000-000000000002'::uuid,
    '91000000-0000-0000-0000-000000000002'::uuid,
    '92000000-0000-0000-0000-000000000002'::uuid,
    2, 'gain', 10, 10::numeric, 1::numeric, null::numeric, null::numeric, null::numeric
  ),
  (
    '94000000-0000-0000-0000-000000000003'::uuid,
    '91000000-0000-0000-0000-000000000002'::uuid,
    '92000000-0000-0000-0000-000000000002'::uuid,
    3, 'gain', 12, 12::numeric, 1.2::numeric, null::numeric, null::numeric, null::numeric
  )
) fixture(
  slot_id, user_id, strategy_id, slot_number, status, real_gains,
  operational_gains, realized_profit, entry, current_price, target
);

insert into coinops.growth_plan_settings (
  product_id, tenant_id, user_id, started_at, btc_monthly_goal, sol_monthly_goal
)
select scope.product_id, scope.tenant_id, fixture.user_id, current_date - 31, 7, 1
from fixture_scope scope
cross join (values
  ('91000000-0000-0000-0000-000000000001'::uuid),
  ('91000000-0000-0000-0000-000000000002'::uuid)
) fixture(user_id);

create temporary table open_snapshot on commit drop as
select
  id,
  status,
  position_notional_usdt,
  position_gain_unit_usdt,
  position_quantity,
  position_opened_at,
  preco_entrada,
  preco_atual,
  preco_alvo
from coinops.slots
where id = '94000000-0000-0000-0000-000000000001';

select pg_temp.assert_true(
  (select count(*) from open_snapshot) = 1
    and (select position_opened_at is not null from open_snapshot),
  'opening the BTC fixture must freeze a position snapshot'
);
select pg_temp.assert_numeric(
  (select position_notional_usdt from open_snapshot), 12,
  'the OPEN donor notional must be frozen at 12 USDT'
);
select pg_temp.assert_numeric(
  (select position_quantity from open_snapshot), 0.12,
  'the OPEN donor quantity must be frozen at 0.12 BTC'
);

-- -------------------------------------------------------------------------
-- Scenario 1: A20/B10 at reference 14 -> A16/B14.
-- Prepare and confirm keys are intentionally replayed.
-- -------------------------------------------------------------------------

select pg_catalog.set_config(
  'request.jwt.claim.sub', '91000000-0000-0000-0000-000000000001', true
);
set local role authenticated;

do $rpc$
begin
  perform coinops.prepare_btc_ladder_redistribution(
    14, '95000000-0000-0000-0000-000000000001'
  );
  perform coinops.prepare_btc_ladder_redistribution(
    14, '95000000-0000-0000-0000-000000000001'
  );
end;
$rpc$;

reset role;

select pg_temp.assert_true(
  (
    select count(*)
    from coinops.btc_redistribution_batches
    where user_id = '91000000-0000-0000-0000-000000000001'
      and prepare_idempotency_key = '95000000-0000-0000-0000-000000000001'
  ) = 1,
  'replaying a prepare key must not create a second batch'
);
select pg_temp.assert_true(
  (
    select monthly_goal = 7
      and reference_level = 14
      and transfer_count = 1
      and total_transferred_usdt = 0.4
      and equity_before = 23
      and equity_after = 23
      and equity_difference = 0
    from coinops.btc_redistribution_batches
    where prepare_idempotency_key = '95000000-0000-0000-0000-000000000001'
  ),
  'meta 7 is velocity; the explicit reference 14 drives a conserved preview'
);
select pg_temp.assert_true(
  (
    select donor_slot_id = '93000000-0000-0000-0000-000000000001'
      and receiver_slot_id = '93000000-0000-0000-0000-000000000002'
      and donor_operational_before = 20
      and donor_operational_after = 16
      and receiver_operational_before = 10
      and receiver_operational_after = 14
      and amount_usdt = 0.4
    from coinops.btc_redistribution_transfers
    where batch_id = (
      select id from coinops.btc_redistribution_batches
      where prepare_idempotency_key = '95000000-0000-0000-0000-000000000001'
    )
  ),
  'A20/B10 preview must propose A16/B14 and transfer exactly 0.4 USDT'
);

select pg_catalog.set_config(
  'request.jwt.claim.sub', '91000000-0000-0000-0000-000000000001', true
);
set local role authenticated;

do $rpc$
begin
  perform coinops.confirm_btc_ladder_redistribution(
    (
      select id from coinops.btc_redistribution_batches
      where prepare_idempotency_key = '95000000-0000-0000-0000-000000000001'
    ),
    '96000000-0000-0000-0000-000000000001'
  );
  -- Same confirmation key: idempotent replay.
  perform coinops.confirm_btc_ladder_redistribution(
    (
      select id from coinops.btc_redistribution_batches
      where prepare_idempotency_key = '95000000-0000-0000-0000-000000000001'
    ),
    '96000000-0000-0000-0000-000000000001'
  );
  -- Different key against an already completed batch: no second effect.
  perform coinops.confirm_btc_ladder_redistribution(
    (
      select id from coinops.btc_redistribution_batches
      where prepare_idempotency_key = '95000000-0000-0000-0000-000000000001'
    ),
    '96000000-0000-0000-0000-000000000002'
  );
end;
$rpc$;

reset role;

select pg_temp.assert_numeric(
  (select operational_gains from coinops.slots where id = '93000000-0000-0000-0000-000000000001'),
  16,
  'A must end at operational_gains 16'
);
select pg_temp.assert_numeric(
  (select operational_gains from coinops.slots where id = '93000000-0000-0000-0000-000000000002'),
  14,
  'B must end at operational_gains 14'
);
select pg_temp.assert_true(
  (
    select real_gains = 20 and gains = 20 and added_gains = 0
    from coinops.slots
    where id = '93000000-0000-0000-0000-000000000001'
  ) and (
    select real_gains = 10 and gains = 10 and added_gains = 0
    from coinops.slots
    where id = '93000000-0000-0000-0000-000000000002'
  ),
  'redistribution must not reclassify real, legacy-added, or compatibility gains'
);
select pg_temp.assert_true(
  (
    select count(*) = 2 and round(sum(amount_usdt), 8) = 0
    from coinops.slot_capital_ledger
    where batch_id = (
      select id from coinops.btc_redistribution_batches
      where prepare_idempotency_key = '95000000-0000-0000-0000-000000000001'
    )
  ),
  'one transfer must create exactly one balanced debit/credit pair despite replay'
);
select pg_temp.assert_true(
  (
    select status = 'COMPLETED'
      and confirm_idempotency_key = '96000000-0000-0000-0000-000000000001'
      and equity_difference = 0
    from coinops.btc_redistribution_batches
    where prepare_idempotency_key = '95000000-0000-0000-0000-000000000001'
  ),
  'the first confirmation key remains authoritative and equity is conserved'
);

-- Manual contribution: no real gain; use the post-contribution gain unit and
-- remain idempotent on replay.
select pg_catalog.set_config(
  'request.jwt.claim.sub', '91000000-0000-0000-0000-000000000001', true
);
set local role authenticated;

do $rpc$
begin
  perform coinops.apply_btc_external_contribution(
    '93000000-0000-0000-0000-000000000002',
    1,
    'fixture external contribution',
    '97000000-0000-0000-0000-000000000001'
  );
  perform coinops.apply_btc_external_contribution(
    '93000000-0000-0000-0000-000000000002',
    1,
    'fixture external contribution',
    '97000000-0000-0000-0000-000000000001'
  );
end;
$rpc$;

reset role;

select pg_temp.assert_true(
  (
    select real_gains = 10
      and gains = 10
      and added_gains = 0
      and growth_contribution = 1
      and redistribution_received_usdt = 0.4
      and operational_slot_value = 12.4
    from coinops.slots
    where id = '93000000-0000-0000-0000-000000000002'
  ),
  'external contribution must add capital without creating a real gain'
);
select pg_temp.assert_numeric(
  (select operational_gains from coinops.slots where id = '93000000-0000-0000-0000-000000000002'),
  23.09090909,
  '1 USDT contribution must use post-contribution unit 0.11'
);
select pg_temp.assert_true(
  (
    select count(*) = 1
      and min(gain_unit_before_usdt) = 0.1
      and min(gain_unit_after_usdt) = 0.11
      and min(gain_equivalent) = 9.09090909
    from coinops.btc_external_contributions
    where idempotency_key = '97000000-0000-0000-0000-000000000001'
  ) and (
    select count(*) = 1 and min(amount_usdt) = 1
    from coinops.slot_capital_ledger
    where external_contribution_id = (
      select id from coinops.btc_external_contributions
      where idempotency_key = '97000000-0000-0000-0000-000000000001'
    )
      and entry_type = 'EXTERNAL_CONTRIBUTION'
  ),
  'contribution replay must not duplicate capital or ledger entries'
);

-- -------------------------------------------------------------------------
-- Scenario 2: A20/B10/C12 at reference 14 -> A14/B14/C14.
-- A is OPEN, remains eligible to donate, and keeps its executed snapshot.
-- -------------------------------------------------------------------------

select pg_catalog.set_config(
  'request.jwt.claim.sub', '91000000-0000-0000-0000-000000000002', true
);
set local role authenticated;

do $rpc$
begin
  perform coinops.prepare_btc_ladder_redistribution(
    14, '95000000-0000-0000-0000-000000000002'
  );
end;
$rpc$;

reset role;

select pg_temp.assert_true(
  (
    select transfer_count = 2
      and total_transferred_usdt = 0.6
      and equity_before = 34.2
      and equity_after = 34.2
      and equity_difference = 0
    from coinops.btc_redistribution_batches
    where prepare_idempotency_key = '95000000-0000-0000-0000-000000000002'
  ),
  'cascade preview must conserve 34.2 USDT across two transfers'
);
select pg_temp.assert_true(
  (
    select count(*) = 2
      and bool_and(donor_slot_id = '94000000-0000-0000-0000-000000000001')
      and min(donor_status) = 'aberto'
      and max(donor_status) = 'aberto'
    from coinops.btc_redistribution_transfers
    where batch_id = (
      select id from coinops.btc_redistribution_batches
      where prepare_idempotency_key = '95000000-0000-0000-0000-000000000002'
    )
  ),
  'the OPEN slot A must be accepted as donor for the entire cascade'
);
select pg_temp.assert_true(
  (
    select receiver_slot_id = '94000000-0000-0000-0000-000000000003'
      and amount_usdt = 0.2
      and donor_operational_after = 18
      and receiver_operational_after = 14
    from coinops.btc_redistribution_transfers
    where batch_id = (
      select id from coinops.btc_redistribution_batches
      where prepare_idempotency_key = '95000000-0000-0000-0000-000000000002'
    ) and sequence_number = 1
  ) and (
    select receiver_slot_id = '94000000-0000-0000-0000-000000000002'
      and amount_usdt = 0.4
      and donor_operational_after = 14
      and receiver_operational_after = 14
    from coinops.btc_redistribution_transfers
    where batch_id = (
      select id from coinops.btc_redistribution_batches
      where prepare_idempotency_key = '95000000-0000-0000-0000-000000000002'
    ) and sequence_number = 2
  ),
  'the deterministic cascade must fill C12 before B10, then leave all at 14'
);

select pg_catalog.set_config(
  'request.jwt.claim.sub', '91000000-0000-0000-0000-000000000002', true
);
set local role authenticated;

do $rpc$
begin
  perform coinops.confirm_btc_ladder_redistribution(
    (
      select id from coinops.btc_redistribution_batches
      where prepare_idempotency_key = '95000000-0000-0000-0000-000000000002'
    ),
    '96000000-0000-0000-0000-000000000003'
  );
end;
$rpc$;

reset role;

select pg_temp.assert_true(
  (
    select operational_gains = 14
      and operational_slot_value = 11.4
      and redistribution_sent_usdt = 0.6
      and real_gains = 20
      and gains = 20
      and added_gains = 0
      and status = 'aberto'
    from coinops.slots
    where id = '94000000-0000-0000-0000-000000000001'
  ),
  'OPEN donor A must be debited immediately without changing real gains or status'
);
select pg_temp.assert_true(
  (
    select operational_gains = 14
      and operational_slot_value = 11.4
      and redistribution_received_usdt = 0.4
      and real_gains = 10
    from coinops.slots
    where id = '94000000-0000-0000-0000-000000000002'
  ) and (
    select operational_gains = 14
      and operational_slot_value = 11.4
      and redistribution_received_usdt = 0.2
      and real_gains = 12
    from coinops.slots
    where id = '94000000-0000-0000-0000-000000000003'
  ),
  'receivers B and C must reach operational level 14 without real gain changes'
);
select pg_temp.assert_true(
  (
    select current_slot.position_notional_usdt is not distinct from snapshot.position_notional_usdt
      and current_slot.position_gain_unit_usdt is not distinct from snapshot.position_gain_unit_usdt
      and current_slot.position_quantity is not distinct from snapshot.position_quantity
      and current_slot.position_opened_at is not distinct from snapshot.position_opened_at
      and current_slot.preco_entrada is not distinct from snapshot.preco_entrada
      and current_slot.preco_atual is not distinct from snapshot.preco_atual
      and current_slot.preco_alvo is not distinct from snapshot.preco_alvo
    from coinops.slots current_slot
    join open_snapshot snapshot on snapshot.id = current_slot.id
  ),
  'redistribution must not rewrite quantity, entry, current, target, or position timestamp'
);
select pg_temp.assert_true(
  (
    select count(*) = 4
      and round(sum(amount_usdt), 8) = 0
      and round(sum(amount_usdt) filter (where entry_type = 'REDISTRIBUTION_DEBIT'), 8) = -0.6
      and round(sum(amount_usdt) filter (where entry_type = 'REDISTRIBUTION_CREDIT'), 8) = 0.6
    from coinops.slot_capital_ledger
    where batch_id = (
      select id from coinops.btc_redistribution_batches
      where prepare_idempotency_key = '95000000-0000-0000-0000-000000000002'
    )
  ),
  'cascade ledger debits must exactly equal credits'
);

-- Closing the previously OPEN donor adds exactly one real gain. The 0.6 USDT
-- already sent remains debited and therefore cannot reappear at close.
update coinops.slots
set
  status = 'gain',
  gains = gains + 1,
  real_gains = real_gains + 1
where id = '94000000-0000-0000-0000-000000000001';

select pg_temp.assert_true(
  (
    select status = 'gain'
      and real_gains = 21
      and gains = 21
      and added_gains = 0
      and operational_gains = 15
      and realized_profit = 2.1
      and redistribution_sent_usdt = 0.6
      and operational_slot_value = 11.5
    from coinops.slots
    where id = '94000000-0000-0000-0000-000000000001'
  ),
  'closing after redistribution must add one gain while preserving the prior debit'
);
select pg_temp.assert_true(
  (
    select current_slot.position_notional_usdt is not distinct from snapshot.position_notional_usdt
      and current_slot.position_gain_unit_usdt is not distinct from snapshot.position_gain_unit_usdt
      and current_slot.position_quantity is not distinct from snapshot.position_quantity
      and current_slot.position_opened_at is not distinct from snapshot.position_opened_at
      and current_slot.preco_entrada is not distinct from snapshot.preco_entrada
      and current_slot.preco_atual is not distinct from snapshot.preco_atual
      and current_slot.preco_alvo is not distinct from snapshot.preco_alvo
    from coinops.slots current_slot
    join open_snapshot snapshot on snapshot.id = current_slot.id
  ),
  'real close must also preserve the executed position snapshot'
);
select pg_temp.assert_true(
  (
    select count(*) = 1
      and min(amount_usdt) = 0.1
      and min(operational_before) = 14
      and min(operational_after) = 15
      and min(value_before) = 11.4
      and min(value_after) = 11.5
    from coinops.slot_capital_ledger
    where slot_id = '94000000-0000-0000-0000-000000000001'
      and entry_type = 'REAL_GAIN'
      and created_at >= (select min(created_at) from coinops.btc_redistribution_batches
        where prepare_idempotency_key = '95000000-0000-0000-0000-000000000002')
  ),
  'the close must append one REAL_GAIN ledger entry based on the frozen gain unit'
);

-- -------------------------------------------------------------------------
-- Authorization/RLS negative checks.
-- -------------------------------------------------------------------------

select pg_catalog.set_config(
  'request.jwt.claim.sub', '91000000-0000-0000-0000-000000000002', true
);
set local role authenticated;

select pg_temp.assert_true(
  (
    select count(*)
    from coinops.btc_redistribution_batches
    where user_id = '91000000-0000-0000-0000-000000000001'
  ) = 0,
  'RLS must hide another owner''s redistribution batches'
);
select pg_temp.expect_error(
  $$select coinops.apply_btc_external_contribution(
    '93000000-0000-0000-0000-000000000002'::uuid,
    1,
    'cross-owner attempt',
    '97000000-0000-0000-0000-000000000002'::uuid
  )$$,
  'COINOPS_BTC_SLOT_NOT_FOUND'
);
select pg_temp.expect_error(
  'delete from coinops.slot_capital_ledger where false',
  null
);

reset role;

select pg_catalog.set_config(
  'request.jwt.claim.sub', '91000000-0000-0000-0000-000000000003', true
);
set local role authenticated;

select pg_temp.assert_true(
  (select count(*) from coinops.btc_redistribution_batches) = 0,
  'an authenticated user without membership must see no financial batches'
);
select pg_temp.expect_error(
  'select coinops.get_btc_ladder_plan()',
  'COINOPS_ACTIVE_INTERNAL_MEMBERSHIP_REQUIRED'
);

reset role;

select 'btc_ladder_redistribution.sql: all local transactional assertions passed' as result;

rollback;
