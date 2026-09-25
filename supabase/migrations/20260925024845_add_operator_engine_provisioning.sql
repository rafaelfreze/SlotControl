-- Native-quote, transactional provisioning for a newly validated Binance
-- account. Preparation never enables trading or changes an existing engine.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';

create or replace function coinops.stage_operator_engine_plan(
  p_operator_id uuid, p_account_id uuid, p_quote_asset text,
  p_authorized_capital numeric, p_engines jsonb, p_request_id uuid
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_account coinops.exchange_accounts%rowtype;
  v_operator coinops.operators%rowtype;
  v_check coinops.account_onboarding_checks%rowtype;
  v_item jsonb;
  v_asset text;
  v_symbol text;
  v_cap numeric;
  v_gain numeric;
  v_spacing numeric;
  v_post_ath numeric;
  v_engine_id uuid;
  v_total numeric := 0;
  v_assets text[] := '{}';
  v_result jsonb := '[]'::jsonb;
  v_replay coinops.account_onboarding_checks%rowtype;
begin
  if coalesce(nullif(current_setting('request.jwt.claim.role',true),''),auth.jwt()->>'role','') <> 'service_role'
    or p_operator_id is null or p_account_id is null
    or p_request_id is null or p_quote_asset not in ('BRL','USDT')
    or p_authorized_capital is null or p_authorized_capital <= 0
    or p_authorized_capital <> round(p_authorized_capital, 2)
    or jsonb_typeof(p_engines) <> 'array'
    or jsonb_array_length(p_engines) not between 1 and 2 then
    raise exception 'COINOPS_PLAN_INPUT_DENIED';
  end if;
  select * into v_account from coinops.exchange_accounts
    where id = p_account_id and operator_id = p_operator_id for update;
  select * into v_operator from coinops.operators where id = p_operator_id;
  if v_account.id is null or v_operator.id is null or v_operator.status <> 'ACTIVE'
    or v_operator.kill_switch or v_account.status <> 'INACTIVE'
    or not v_account.kill_switch or v_account.is_legacy_default
    or v_account.executor_profile <> 'coinops-fixed-ip'
    or v_account.credential_ref <> 'account_' || replace(p_account_id::text, '-', '') then
    raise exception 'COINOPS_PLAN_ACCOUNT_DENIED';
  end if;
  select * into v_check from coinops.account_onboarding_checks
    where operator_id = p_operator_id and exchange_account_id = p_account_id
      and check_key = 'BINANCE_CREDENTIAL'
    order by checked_at desc, id desc limit 1;
  if v_check.id is null or v_check.status <> 'PASS'
    or v_check.evidence->>'environment' <> 'REAL'
    or v_check.evidence->>'status' <> 'PASS'
    or v_check.evidence->>'whitelist_accepted' <> 'true'
    or v_check.evidence->'permission'->>'spotTrading' <> 'true'
    or v_check.evidence->'permission'->>'withdrawals' <> 'false' then
    raise exception 'COINOPS_PLAN_CREDENTIAL_GATE_DENIED';
  end if;
  select * into v_replay from coinops.account_onboarding_checks
    where exchange_account_id = p_account_id
      and idempotency_key = 'engine-plan:' || p_request_id::text;
  if v_replay.id is not null then
    if v_replay.evidence->'input' is distinct from jsonb_build_object(
      'quote', p_quote_asset, 'capital', p_authorized_capital, 'engines', p_engines) then
      raise exception 'COINOPS_PLAN_REPLAY_MISMATCH';
    end if;
    return v_replay.evidence->'result';
  end if;
  if exists (select 1 from coinops.trading_engines where exchange_account_id = p_account_id)
    or exists (select 1 from coinops.account_quote_caps where exchange_account_id = p_account_id)
    or exists (select 1 from coinops.robot_v1_live_runs where exchange_account_id = p_account_id) then
    raise exception 'COINOPS_PLAN_EXISTING_STATE_DENIED';
  end if;
  for v_item in select value from jsonb_array_elements(p_engines) loop
    v_asset := v_item->>'asset';
    v_symbol := v_asset || p_quote_asset;
    if v_asset not in ('BTC','SOL') or v_asset = any(v_assets)
      or (select count(*) from jsonb_object_keys(v_item)) <> 5
      or not (v_item ?& array['asset','capital','gain','spacing','postAth']) then
      raise exception 'COINOPS_PLAN_MARKET_DENIED';
    end if;
    v_assets := array_append(v_assets, v_asset);
    begin
      v_cap := (v_item->>'capital')::numeric;
      v_gain := (v_item->>'gain')::numeric;
      v_spacing := (v_item->>'spacing')::numeric;
      v_post_ath := (v_item->>'postAth')::numeric;
    exception when others then raise exception 'COINOPS_PLAN_RATE_INVALID'; end;
    if v_cap is null or v_cap <= 0 or v_cap <> round(v_cap, 2)
      or v_gain not between 0.001 and 0.2
      or v_spacing not between 0.001 and 0.2
      or v_post_ath not between 0.001 and 0.2 then
      raise exception 'COINOPS_PLAN_CAP_INVALID';
    end if;
    v_total := v_total + v_cap;
  end loop;
  if v_total <> p_authorized_capital then raise exception 'COINOPS_PLAN_CAP_SUM_MISMATCH'; end if;

  insert into coinops.account_quote_caps(operator_id, exchange_account_id, quote_asset, hard_cap_quote)
    values (p_operator_id, p_account_id, p_quote_asset, p_authorized_capital);
  for v_item in select value from jsonb_array_elements(p_engines) loop
    v_asset := v_item->>'asset';
    v_symbol := v_asset || p_quote_asset;
    v_cap := (v_item->>'capital')::numeric;
    v_gain := (v_item->>'gain')::numeric;
    v_spacing := (v_item->>'spacing')::numeric;
    v_post_ath := (v_item->>'postAth')::numeric;
    insert into coinops.trading_engines(operator_id, exchange_account_id, environment,
      symbol, base_asset, quote_asset, ath_reference_symbol, status, kill_switch,
      legacy_compatible, hard_cap_quote, config)
    values (p_operator_id, p_account_id, 'REAL', v_symbol, v_asset, p_quote_asset,
      v_symbol, 'INACTIVE', true, false, v_cap,
      jsonb_build_object('slot_count',25,'initial_slot_quote',v_cap / 25,
        'capital_quote',v_cap,'max_order_quote',v_cap,'gain_rate',v_gain,
        'normal_spacing_rate',v_spacing,'post_ath_spacing_rate',v_post_ath,
        'monthly_target',case v_asset when 'BTC' then 7 else 2 end))
    returning id into v_engine_id;
    insert into coinops.robot_v1_live_preparations(product_id,tenant_id,user_id,
      operator_id,exchange_account_id,trading_engine_id,asset,symbol,quote_asset,
      slot_count,monthly_target,configured_live_capital_brl,max_order_notional_brl,
      max_total_exposure_brl,compounding_enabled,single_active_entry,
      initial_market_enabled,local_reentry_enabled,kill_switch,live_enabled)
    values(v_operator.product_id,v_operator.tenant_id,v_operator.user_id,
      p_operator_id,p_account_id,v_engine_id,v_asset,v_symbol,p_quote_asset,
      25,case v_asset when 'BTC' then 7 else 2 end,v_cap,v_cap,v_cap,
      true,true,true,true,true,false);
    insert into coinops.robot_v1_ath_profiles(product_id,tenant_id,user_id,
      operator_id,exchange_account_id,trading_engine_id,environment,asset,quote_asset,
      config_version,gain_rate,normal_spacing_rate,post_ath_spacing_rate,regime)
    values(v_operator.product_id,v_operator.tenant_id,v_operator.user_id,
      p_operator_id,p_account_id,v_engine_id,'REAL',v_asset,p_quote_asset,
      1,v_gain,v_spacing,v_post_ath,'NORMAL');
    insert into coinops.robot_v1_live_slot_accounts(product_id,tenant_id,user_id,
      operator_id,exchange_account_id,trading_engine_id,asset,quote_asset,slot_number)
    select v_operator.product_id,v_operator.tenant_id,v_operator.user_id,
      p_operator_id,p_account_id,v_engine_id,v_asset,p_quote_asset,number
    from generate_series(1,25) as number;
    v_result := v_result || jsonb_build_array(jsonb_build_object(
      'engineId',v_engine_id,'symbol',v_symbol,'capital',v_cap,'status','INACTIVE'));
  end loop;
  insert into coinops.account_onboarding_checks(operator_id,exchange_account_id,
    check_key,status,evidence,created_by,idempotency_key)
  values(p_operator_id,p_account_id,'ENGINE_PLAN','PASS',
    jsonb_build_object('input',jsonb_build_object('quote',p_quote_asset,
      'capital',p_authorized_capital,'engines',p_engines),'result',v_result),
    v_operator.user_id,'engine-plan:' || p_request_id::text);
  return v_result;
end $$;

revoke all on function coinops.stage_operator_engine_plan(uuid,uuid,text,numeric,jsonb,uuid)
  from public, anon, authenticated;
grant execute on function coinops.stage_operator_engine_plan(uuid,uuid,text,numeric,jsonb,uuid)
  to service_role;
commit;
