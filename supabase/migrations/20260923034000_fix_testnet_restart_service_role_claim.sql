-- Repair the service-role guard for PostgREST calls where request.jwt.claim.role is blank.
-- EXECUTE remains restricted to service_role; Production exchange tables stay outside this RPC.
create or replace function coinops.restart_robot_v1_testnet_cycle(
  p_old_run_id uuid,
  p_terminal_fill_client_order_id text,
  p_anchor_price numeric,
  p_price_tick numeric,
  p_reset_idempotency_key text,
  p_recovery_source text,
  p_reset_started_at timestamptz
) returns table(new_run_id uuid, created boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old coinops.robot_v1_testnet_runs%rowtype;
  v_new_id uuid;
  v_existing uuid;
begin
  if coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(auth.jwt() ->> 'role', ''),
    ''
  ) <> 'service_role' then
    raise exception 'COINOPS_TESTNET_SERVICE_ROLE_REQUIRED';
  end if;
  if p_anchor_price <= 0 or p_price_tick <= 0
    or p_reset_idempotency_key !~ '^[a-f0-9]{64}$'
    or p_recovery_source !~ '^[A-Z0-9_]{3,64}$' then
    raise exception 'COINOPS_TESTNET_RESET_INPUT_INVALID';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_old_run_id::text, 0));
  select id into v_existing from coinops.robot_v1_testnet_runs
    where reset_idempotency_key = p_reset_idempotency_key;
  if v_existing is not null then
    return query select v_existing, false;
    return;
  end if;

  select * into v_old from coinops.robot_v1_testnet_runs where id = p_old_run_id for update;
  if not found or v_old.status <> 'ACTIVE' or v_old.asset <> 'SOL' or v_old.symbol <> 'SOLUSDC' then
    raise exception 'COINOPS_TESTNET_RESET_RUN_INVALID';
  end if;
  if not exists (
    select 1 from coinops.robot_v1_testnet_orders
    where run_id = v_old.id and client_order_id = p_terminal_fill_client_order_id
      and side = 'SELL' and purpose = 'TP' and status = 'FILLED'
  ) then raise exception 'COINOPS_TESTNET_TERMINAL_FILL_REQUIRED'; end if;
  if exists (
    select 1 from coinops.robot_v1_testnet_orders
    where run_id = v_old.id and status in ('PREPARED', 'NEW', 'PARTIALLY_FILLED')
  ) then raise exception 'COINOPS_TESTNET_ACTIVE_OLD_ORDER'; end if;
  if exists (
    select 1 from coinops.robot_v1_testnet_slots
    where run_id = v_old.id and entry_state in ('OPEN', 'ARMED')
  ) then raise exception 'COINOPS_TESTNET_OLD_POSITION_ACTIVE'; end if;
  if (select count(*) from coinops.robot_v1_testnet_slots where run_id = v_old.id) <> 25 then
    raise exception 'COINOPS_TESTNET_PLAN_INCOMPLETE';
  end if;

  update coinops.robot_v1_testnet_runs set
    status = 'COMPLETED', completed_at = timezone('utc', now()),
    completion_reason = 'LAST_OPEN_TP_FILLED', terminal_fill_client_order_id = p_terminal_fill_client_order_id,
    reset_started_at = p_reset_started_at, recovery_source = p_recovery_source
  where id = v_old.id;

  insert into coinops.robot_v1_testnet_runs (
    product_id, tenant_id, user_id, asset, symbol, anchor_price, slot_notional_usdc,
    gain_rate, entry_spacing, previous_run_id, terminal_fill_client_order_id,
    reset_idempotency_key, reset_started_at, recovery_source
  ) values (
    v_old.product_id, v_old.tenant_id, v_old.user_id, v_old.asset, v_old.symbol,
    p_anchor_price, v_old.slot_notional_usdc, v_old.gain_rate, v_old.entry_spacing,
    v_old.id, p_terminal_fill_client_order_id, p_reset_idempotency_key,
    p_reset_started_at, p_recovery_source
  ) returning id into v_new_id;

  insert into coinops.robot_v1_testnet_slots (
    run_id, product_id, tenant_id, user_id, slot_number, entry_state,
    target_buy_price, balance_usdc, gain_count, net_profit_usdc,
    operation_sequence, entry_origin, entry_reference_price
  )
  select v_new_id, s.product_id, s.tenant_id, s.user_id, s.slot_number, 'PLANNED',
    floor((p_anchor_price * power((1 - v_old.entry_spacing)::numeric, (s.slot_number - 1)::numeric)) / p_price_tick) * p_price_tick,
    s.balance_usdc, 0, 0, 1, 'GRID',
    floor((p_anchor_price * power((1 - v_old.entry_spacing)::numeric, (s.slot_number - 1)::numeric)) / p_price_tick) * p_price_tick
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
        'new_cycle_started', true, 'recovery_source', p_recovery_source));

  return query select v_new_id, true;
end;
$$;

revoke all on function coinops.restart_robot_v1_testnet_cycle(uuid, text, numeric, numeric, text, text, timestamptz) from public, anon, authenticated;
grant execute on function coinops.restart_robot_v1_testnet_cycle(uuid, text, numeric, numeric, text, text, timestamptz) to service_role;
