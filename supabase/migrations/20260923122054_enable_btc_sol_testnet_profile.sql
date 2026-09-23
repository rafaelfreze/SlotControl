-- CoinOps Fase 4.0: extend the fictitious Testnet ledger to BTC without
-- touching Production exchange connections or rewriting SOL history.
alter table coinops.robot_v1_testnet_runs drop constraint if exists robot_v1_testnet_runs_asset_check;
alter table coinops.robot_v1_testnet_runs add constraint robot_v1_testnet_runs_asset_check
  check (asset in ('BTC', 'SOL'));
alter table coinops.robot_v1_testnet_runs drop constraint if exists robot_v1_testnet_runs_symbol_check;
alter table coinops.robot_v1_testnet_runs add constraint robot_v1_testnet_runs_symbol_check
  check ((asset = 'BTC' and symbol = 'BTCUSDC') or (asset = 'SOL' and symbol = 'SOLUSDC'));
alter table coinops.robot_v1_testnet_orders drop constraint if exists robot_v1_testnet_orders_client_order_id_check;
alter table coinops.robot_v1_testnet_orders add constraint robot_v1_testnet_orders_client_order_id_check
  check (client_order_id ~ '^COV1-(BTC|SOL)-[0-9]+(-[0-9]+)?-(BUY|SELL)-[a-f0-9]{18}$');

alter table coinops.robot_v1_testnet_runs
  add column if not exists next_capital_usdc numeric(20, 8) check (next_capital_usdc > 0 and next_capital_usdc <= 2500),
  add column if not exists next_gain_rate numeric(12, 8) check (next_gain_rate between 0.001 and 0.20),
  add column if not exists next_entry_spacing numeric(12, 8) check (next_entry_spacing between 0.001 and 0.20);

-- Keep the cycle snapshot immutable. Only pending next-cycle values may be
-- changed by the authenticated, scoped server action.
create or replace function private.coinops_guard_testnet_cycle_snapshot()
returns trigger language plpgsql set search_path = '' as $$
begin
  if (new.asset, new.symbol, new.anchor_price, new.slot_notional_usdc, new.gain_rate, new.entry_spacing)
     is distinct from
     (old.asset, old.symbol, old.anchor_price, old.slot_notional_usdc, old.gain_rate, old.entry_spacing) then
    raise exception 'COINOPS_TESTNET_CYCLE_SNAPSHOT_IMMUTABLE';
  end if;
  return new;
end;
$$;
revoke all on function private.coinops_guard_testnet_cycle_snapshot() from public, anon, authenticated;
drop trigger if exists robot_v1_testnet_cycle_snapshot_guard on coinops.robot_v1_testnet_runs;
create trigger robot_v1_testnet_cycle_snapshot_guard before update on coinops.robot_v1_testnet_runs
  for each row execute function private.coinops_guard_testnet_cycle_snapshot();

-- New RPC leaves the existing SOL-only rollover callable for in-flight code
-- until the application deploy switches to v2. Each run has its own lock,
-- idempotency key and 25 physical balances.
create function coinops.restart_robot_v1_testnet_cycle_v2(
  p_old_run_id uuid,
  p_terminal_fill_client_order_id text,
  p_anchor_price numeric,
  p_price_tick numeric,
  p_reset_idempotency_key text,
  p_recovery_source text,
  p_reset_started_at timestamptz
) returns table(new_run_id uuid, created boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_old coinops.robot_v1_testnet_runs%rowtype;
  v_new_id uuid;
  v_existing uuid;
  v_new_capital numeric;
  v_new_gain numeric;
  v_new_spacing numeric;
  v_delta_per_slot numeric;
begin
  if coalesce(nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(auth.jwt() ->> 'role', ''), '') <> 'service_role' then
    raise exception 'COINOPS_TESTNET_SERVICE_ROLE_REQUIRED';
  end if;
  if p_anchor_price <= 0 or p_price_tick <= 0
    or p_reset_idempotency_key !~ '^[a-f0-9]{64}$'
    or p_recovery_source !~ '^[A-Z0-9_]{3,64}$' then
    raise exception 'COINOPS_TESTNET_RESET_INPUT_INVALID';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_old_run_id::text, 0));
  select id into v_existing from coinops.robot_v1_testnet_runs where reset_idempotency_key = p_reset_idempotency_key;
  if v_existing is not null then
    return query select v_existing, false;
    return;
  end if;
  select * into v_old from coinops.robot_v1_testnet_runs where id = p_old_run_id for update;
  if not found or v_old.status <> 'ACTIVE'
    or not ((v_old.asset = 'BTC' and v_old.symbol = 'BTCUSDC') or (v_old.asset = 'SOL' and v_old.symbol = 'SOLUSDC')) then
    raise exception 'COINOPS_TESTNET_RESET_RUN_INVALID';
  end if;
  if not exists (select 1 from coinops.robot_v1_testnet_orders
    where run_id = v_old.id and client_order_id = p_terminal_fill_client_order_id
      and side = 'SELL' and purpose = 'TP' and status = 'FILLED') then
    raise exception 'COINOPS_TESTNET_TERMINAL_FILL_REQUIRED';
  end if;
  if exists (select 1 from coinops.robot_v1_testnet_orders where run_id = v_old.id
    and status in ('PREPARED', 'NEW', 'PARTIALLY_FILLED'))
    or exists (select 1 from coinops.robot_v1_testnet_slots where run_id = v_old.id
      and entry_state in ('OPEN', 'ARMED')) then
    raise exception 'COINOPS_TESTNET_ACTIVE_OLD_ORDER';
  end if;
  if (select count(*) from coinops.robot_v1_testnet_slots where run_id = v_old.id) <> 25 then
    raise exception 'COINOPS_TESTNET_PLAN_INCOMPLETE';
  end if;
  v_new_capital := coalesce(v_old.next_capital_usdc, v_old.slot_notional_usdc * 25);
  v_new_gain := coalesce(v_old.next_gain_rate, v_old.gain_rate);
  v_new_spacing := coalesce(v_old.next_entry_spacing, v_old.entry_spacing);
  v_delta_per_slot := v_new_capital / 25 - v_old.slot_notional_usdc;
  if v_new_capital <= 0 or v_new_gain not between 0.001 and 0.20
    or v_new_spacing not between 0.001 and 0.20
    or exists (select 1 from coinops.robot_v1_testnet_slots
      where run_id = v_old.id and balance_usdc + v_delta_per_slot <= 0) then
    raise exception 'COINOPS_TESTNET_NEXT_PROFILE_INVALID';
  end if;

  update coinops.robot_v1_testnet_runs set status = 'COMPLETED', completed_at = timezone('utc', now()),
    completion_reason = 'LAST_OPEN_TP_FILLED', terminal_fill_client_order_id = p_terminal_fill_client_order_id,
    reset_started_at = p_reset_started_at, recovery_source = p_recovery_source where id = v_old.id;
  insert into coinops.robot_v1_testnet_runs
    (product_id, tenant_id, user_id, asset, symbol, anchor_price, slot_notional_usdc,
     gain_rate, entry_spacing, previous_run_id, terminal_fill_client_order_id,
     reset_idempotency_key, reset_started_at, recovery_source)
  values (v_old.product_id, v_old.tenant_id, v_old.user_id, v_old.asset, v_old.symbol,
    p_anchor_price, v_new_capital / 25, v_new_gain, v_new_spacing,
    v_old.id, p_terminal_fill_client_order_id, p_reset_idempotency_key,
    p_reset_started_at, p_recovery_source) returning id into v_new_id;
  insert into coinops.robot_v1_testnet_slots
    (run_id, product_id, tenant_id, user_id, slot_number, entry_state,
     target_buy_price, balance_usdc, gain_count, net_profit_usdc,
     operation_sequence, entry_origin, entry_reference_price)
  select v_new_id, s.product_id, s.tenant_id, s.user_id, s.slot_number, 'PLANNED',
    floor((p_anchor_price * power((1 - v_new_spacing)::numeric, (s.slot_number - 1)::numeric)) / p_price_tick) * p_price_tick,
    s.balance_usdc + v_delta_per_slot, 0, 0, 1, 'GRID',
    floor((p_anchor_price * power((1 - v_new_spacing)::numeric, (s.slot_number - 1)::numeric)) / p_price_tick) * p_price_tick
  from coinops.robot_v1_testnet_slots s where s.run_id = v_old.id order by s.slot_number;
  insert into coinops.robot_v1_testnet_events
    (run_id, product_id, tenant_id, user_id, event_key, event_type, details)
  values
    (v_old.id, v_old.product_id, v_old.tenant_id, v_old.user_id,
     'CYCLE_COMPLETED:' || p_reset_idempotency_key, 'CYCLE_COMPLETED',
     jsonb_build_object('reason', 'LAST_OPEN_TP_FILLED', 'terminalFillClientOrderId', p_terminal_fill_client_order_id,
       'nextRunId', v_new_id, 'reset_after_last_tp', true, 'recovery_source', p_recovery_source)),
    (v_new_id, v_old.product_id, v_old.tenant_id, v_old.user_id,
     'NEW_CYCLE_STARTED:' || p_reset_idempotency_key, 'NEW_CYCLE_STARTED',
     jsonb_build_object('previousRunId', v_old.id, 'anchorPrice', p_anchor_price,
       'new_cycle_started', true, 'recovery_source', p_recovery_source,
       'profile', case when v_new_gain = 0.005 and v_new_spacing = 0.01 then 'TEST_PROFILE' else 'CUSTOM_TEST' end));
  return query select v_new_id, true;
end;
$$;
revoke all on function coinops.restart_robot_v1_testnet_cycle_v2(uuid, text, numeric, numeric, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function coinops.restart_robot_v1_testnet_cycle_v2(uuid, text, numeric, numeric, text, text, timestamptz)
  to service_role;

-- Shadow capital changes are virtual, but still must preserve the accounting
-- invariant initial balance + historical net profit = current slot balance.
-- Apply only between cycles and keep every previous operation immutable.
create function coinops.apply_robot_v1_shadow_next_profile(p_config_id uuid)
returns table(applied boolean, capital_usdc numeric, gain_rate numeric, entry_spacing numeric)
language plpgsql security definer set search_path = '' as $$
declare
  v_config coinops.robot_v1_configs%rowtype;
  v_next_capital numeric;
  v_delta numeric;
begin
  if coalesce(nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(auth.jwt() ->> 'role', ''), '') <> 'service_role' then
    raise exception 'COINOPS_V1_SERVICE_ROLE_REQUIRED';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_config_id::text, 0));
  select * into v_config from coinops.robot_v1_configs where id = p_config_id and execution_mode = 'SHADOW' for update;
  if not found then raise exception 'COINOPS_V1_CONFIG_REQUIRED'; end if;
  if exists (select 1 from coinops.robot_v1_cycles where config_id = p_config_id
    and status in ('STARTING', 'GRID_ACTIVE', 'POSITIONS_ACTIVE', 'RESETTING')) then
    raise exception 'COINOPS_V1_ACTIVE_CYCLE_PROFILE_BLOCKED';
  end if;
  if v_config.next_capital_usdc is null and v_config.next_gain_rate is null and v_config.next_entry_spacing is null then
    return query select false, v_config.capital_usdc, v_config.gain_rate, v_config.entry_spacing;
    return;
  end if;
  v_next_capital := coalesce(v_config.next_capital_usdc, v_config.capital_usdc);
  v_delta := (v_next_capital - v_config.capital_usdc) / 25;
  if v_next_capital <= 0 or v_next_capital > 2500
    or coalesce(v_config.next_gain_rate, v_config.gain_rate) not between 0.001 and 0.20
    or coalesce(v_config.next_entry_spacing, v_config.entry_spacing) not between 0.001 and 0.20
    or (select count(*) from coinops.robot_v1_slot_accounts where config_id = p_config_id) <> 25
    or exists (select 1 from coinops.robot_v1_slot_accounts where config_id = p_config_id
      and (initial_balance_usdc + v_delta <= 0 or balance_usdc + v_delta <= 0 or balance_usdc + v_delta > 100)) then
    raise exception 'COINOPS_V1_NEXT_PROFILE_INVALID';
  end if;
  update coinops.robot_v1_slot_accounts set
    initial_balance_usdc = initial_balance_usdc + v_delta,
    balance_usdc = balance_usdc + v_delta
  where config_id = p_config_id;
  update coinops.robot_v1_configs c set capital_usdc = v_next_capital,
    gain_rate = coalesce(c.next_gain_rate, c.gain_rate),
    entry_spacing = coalesce(c.next_entry_spacing, c.entry_spacing),
    next_capital_usdc = null, next_gain_rate = null, next_entry_spacing = null,
    last_candle_open_at = null
  where id = p_config_id;
  return query select true, v_next_capital,
    coalesce(v_config.next_gain_rate, v_config.gain_rate),
    coalesce(v_config.next_entry_spacing, v_config.entry_spacing);
end;
$$;
revoke all on function coinops.apply_robot_v1_shadow_next_profile(uuid) from public, anon, authenticated;
grant execute on function coinops.apply_robot_v1_shadow_next_profile(uuid) to service_role;
