-- Phase 5.7: stage Thyely only. All switches remain fail-closed and no run or
-- exchange order is activated by this migration. Legacy Rafael is untouched.
do $$
declare
  v_account coinops.exchange_accounts%rowtype;
  v_operator coinops.operators%rowtype;
  v_engine_id uuid;
  v_asset text;
  v_symbol text;
begin
  select * into strict v_account from coinops.exchange_accounts
    where id = '5580c011-6ff1-44bd-b568-85932b424ceb'::uuid for update;
  select * into strict v_operator from coinops.operators
    where id = v_account.operator_id for share;
  if v_account.display_name <> 'Thyely'
    or v_account.status <> 'INACTIVE' or not v_account.kill_switch
    or v_account.credential_ref <> 'account_5580c0116ff144bdb56885932b424ceb'
    or v_account.executor_profile <> 'coinops-fixed-ip'
    or v_account.is_legacy_default or v_operator.status <> 'ACTIVE'
    or v_operator.kill_switch
    or exists (select 1 from coinops.trading_engines where exchange_account_id = v_account.id)
    or exists (select 1 from coinops.robot_v1_live_runs where exchange_account_id = v_account.id)
  then
    raise exception 'COINOPS_THYELY_STAGING_SCOPE_DENIED';
  end if;

  insert into coinops.account_quote_caps
    (operator_id, exchange_account_id, quote_asset, hard_cap_quote)
  values (v_operator.id, v_account.id, 'USDT', 838);

  foreach v_asset in array array['BTC', 'SOL'] loop
    v_symbol := v_asset || 'USDT';
    insert into coinops.trading_engines
      (operator_id, exchange_account_id, environment, symbol, base_asset,
       quote_asset, ath_reference_symbol, status, kill_switch,
       legacy_compatible, hard_cap_quote, config)
    values (v_operator.id, v_account.id, 'REAL', v_symbol, v_asset,
      'USDT', v_symbol, 'INACTIVE', true, false, 419,
      jsonb_build_object('slot_count', 25, 'initial_slot_quote', 16.76,
        'capital_quote', 419, 'max_order_quote', 419, 'phase', '5.7'))
    returning id into v_engine_id;

    insert into coinops.robot_v1_live_preparations
      (product_id, tenant_id, user_id, operator_id, exchange_account_id,
       trading_engine_id, asset, symbol, quote_asset, slot_count,
       monthly_target, configured_live_capital_brl, max_order_notional_brl,
       max_total_exposure_brl, compounding_enabled, single_active_entry,
       initial_market_enabled, local_reentry_enabled, kill_switch, live_enabled)
    values (v_operator.product_id, v_operator.tenant_id, v_operator.user_id,
      v_operator.id, v_account.id, v_engine_id, v_asset, v_symbol, 'USDT', 25,
      case v_asset when 'BTC' then 7 else 2 end, 419, 419, 419,
      true, true, true, true, true, false);

    insert into coinops.robot_v1_ath_profiles
      (product_id, tenant_id, user_id, operator_id, exchange_account_id,
       trading_engine_id, environment, asset, quote_asset, config_version,
       gain_rate, normal_spacing_rate, post_ath_spacing_rate, regime)
    values (v_operator.product_id, v_operator.tenant_id, v_operator.user_id,
      v_operator.id, v_account.id, v_engine_id, 'REAL', v_asset, 'USDT', 1,
      case v_asset when 'BTC' then 0.012 else 0.055 end,
      case v_asset when 'BTC' then 0.02 else 0.03 end,
      case v_asset when 'BTC' then 0.05 else 0.08 end, 'NORMAL');

    insert into coinops.robot_v1_live_slot_accounts
      (product_id, tenant_id, user_id, operator_id, exchange_account_id,
       trading_engine_id, asset, quote_asset, slot_number)
    select v_operator.product_id, v_operator.tenant_id, v_operator.user_id,
      v_operator.id, v_account.id, v_engine_id, v_asset, 'USDT', number
    from generate_series(1, 25) as number;
  end loop;
end $$;
