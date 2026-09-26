-- Retire only the abandoned self-service Testnet account. Keep all onboarding
-- evidence and credentials for audit; never touch Thyely Production or Rafael.
do $$
declare
  v_account constant uuid := 'b8807ec1-dd07-49ad-9e29-46de55be65ce';
  v_operator uuid;
  v_user uuid;
begin
  select a.operator_id, o.user_id into v_operator, v_user
  from coinops.exchange_accounts a
  join coinops.operators o on o.id = a.operator_id
  where a.id = v_account and a.display_name = 'Thyely-TestNet'
    and a.is_legacy_default = false and a.status in ('ACTIVE', 'DISABLED')
  for update of a;
  if v_operator is null then
    raise exception 'COINOPS_TESTNET_RETIRE_ACCOUNT_MISMATCH';
  end if;
  if not exists (select 1 from coinops.trading_engines where exchange_account_id = v_account)
    or exists (select 1 from coinops.trading_engines
      where exchange_account_id = v_account and (environment <> 'TESTNET' or not kill_switch))
    or exists (select 1 from coinops.robot_v1_testnet_runs where exchange_account_id = v_account)
    or exists (select 1 from coinops.robot_v1_testnet_orders where exchange_account_id = v_account)
    or exists (select 1 from coinops.robot_v1_live_runs where exchange_account_id = v_account) then
    raise exception 'COINOPS_TESTNET_RETIRE_REVIEW_REQUIRED';
  end if;

  -- Closing the account gate first is fail-closed; both updates are atomic in
  -- this migration transaction. No Binance order or executor action occurs.
  update coinops.exchange_accounts set status = 'DISABLED', kill_switch = true
  where id = v_account and operator_id = v_operator;
  update coinops.trading_engines set status = 'DISABLED', kill_switch = true
  where exchange_account_id = v_account and operator_id = v_operator;
  insert into coinops.account_onboarding_checks
    (operator_id, exchange_account_id, check_key, status, evidence, created_by, idempotency_key)
  values
    (v_operator, v_account, 'TESTNET_RETIRED', 'PASS',
      jsonb_build_object('reason', 'operator_requested_panel_retirement',
        'history_preserved', true, 'orders_cancelled', false),
      v_user, 'testnet-retired-b8807ec1-dd07-49ad-9e29-46de55be65ce')
  on conflict (exchange_account_id, idempotency_key) do nothing;
end $$;
