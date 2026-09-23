-- CoinOps 4.4: isolated, immutable manual equity adjustments. No exchange
-- order, position, fill or historical market profit is modified here.
alter table coinops.robot_v1_slot_accounts
  add column manual_gain_usdc numeric(28,12) not null default 0,
  add column contribution_usdc numeric(28,12) not null default 0;
alter table coinops.robot_v1_slot_accounts drop constraint robot_v1_slot_accounts_balanced;
alter table coinops.robot_v1_slot_accounts add constraint robot_v1_slot_accounts_balanced
  check (balance_usdc = initial_balance_usdc + net_profit_usdc + manual_gain_usdc + contribution_usdc);

alter table coinops.robot_v1_testnet_slots
  add column manual_gain_usdc numeric(20,8) not null default 0,
  add column contribution_usdc numeric(20,8) not null default 0;

-- The existing v2 restart copies each physical balance into a new run. Carry
-- its manual monetary composition too; cycle-local gain_count still resets.
-- This fires in the same restart transaction, before the new row is written.
create function coinops.carry_robot_v1_testnet_manual_balance()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  v_previous_run_id uuid;
  v_old coinops.robot_v1_testnet_slots%rowtype;
begin
  select previous_run_id into v_previous_run_id from coinops.robot_v1_testnet_runs where id=new.run_id;
  if v_previous_run_id is null then return new; end if;
  select * into strict v_old from coinops.robot_v1_testnet_slots
    where run_id=v_previous_run_id and slot_number=new.slot_number
      and product_id=new.product_id and tenant_id=new.tenant_id and user_id=new.user_id;
  new.manual_gain_usdc := v_old.manual_gain_usdc;
  new.contribution_usdc := v_old.contribution_usdc;
  return new;
end $$;
create trigger robot_v1_testnet_carry_manual_balance before insert on coinops.robot_v1_testnet_slots
  for each row execute function coinops.carry_robot_v1_testnet_manual_balance();
revoke all on function coinops.carry_robot_v1_testnet_manual_balance() from public,anon,authenticated;

create table coinops.robot_v1_real_prepared_slot_accounts (
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  asset text not null check (asset in ('BTC','SOL')),
  slot_number integer not null check (slot_number between 1 and 25),
  balance_usdc numeric(20,8) not null default 0 check (balance_usdc >= 0),
  manual_gain_usdc numeric(20,8) not null default 0,
  contribution_usdc numeric(20,8) not null default 0,
  gain_count integer not null default 0 check (gain_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (product_id, tenant_id, user_id, asset, slot_number),
  foreign key (product_id, tenant_id) references public.product_tenants(product_id, tenant_id) on delete restrict,
  constraint robot_v1_real_prepared_balance_check check (balance_usdc = manual_gain_usdc + contribution_usdc)
);
create trigger robot_v1_real_prepared_touch before update on coinops.robot_v1_real_prepared_slot_accounts
  for each row execute function private.coinops_touch_updated_at();
alter table coinops.robot_v1_real_prepared_slot_accounts enable row level security;
alter table coinops.robot_v1_real_prepared_slot_accounts force row level security;
create policy robot_v1_real_prepared_owner_read on coinops.robot_v1_real_prepared_slot_accounts
  for select to authenticated using (private.coinops_can_access_row(product_id, tenant_id, user_id));
revoke all on coinops.robot_v1_real_prepared_slot_accounts from public, anon, authenticated;
grant select on coinops.robot_v1_real_prepared_slot_accounts to authenticated, service_role;

alter table coinops.robot_v1_monthly_slot_gains
  add column gain_units integer not null default 1 check (gain_units <> 0);
alter table coinops.robot_v1_monthly_slot_gains drop constraint robot_v1_monthly_slot_gains_environment_check;
alter table coinops.robot_v1_monthly_slot_gains add constraint robot_v1_monthly_slot_gains_environment_check
  check (environment in ('SHADOW','TESTNET','REAL'));
alter table coinops.robot_v1_monthly_slot_gains drop constraint robot_v1_monthly_slot_gains_evidence_basis_check;
alter table coinops.robot_v1_monthly_slot_gains add constraint robot_v1_monthly_slot_gains_evidence_basis_check
  check (evidence_basis in ('SHADOW_CONFIRMED_TP_CLOSE','TESTNET_EXCHANGE_FILL',
    'TESTNET_CREDIT_FALLBACK','MANUAL_TARGET_GAIN','MANUAL_GAIN_REVERSAL'));

create table coinops.robot_v1_manual_adjustments (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  created_by uuid not null,
  environment text not null check (environment in ('SHADOW','TESTNET','REAL')),
  asset text not null check (asset in ('BTC','SOL')),
  slot_number integer not null check (slot_number between 1 and 25),
  physical_slot_id text not null,
  kind text not null check (kind in ('MANUAL_TARGET_GAIN','MANUAL_CONTRIBUTION','REVERSAL')),
  gain_units integer not null,
  currency text not null check (currency in ('USD','BRL')),
  original_amount numeric(20,8) not null,
  fx_rate numeric(20,8),
  fx_source text,
  fx_observed_at timestamptz,
  converted_amount_usdc numeric(20,8) not null check (converted_amount_usdc <> 0),
  balance_before_usdc numeric(28,12) not null,
  balance_after_usdc numeric(28,12) not null,
  monthly_before integer not null,
  monthly_after integer not null,
  lifetime_before integer not null,
  lifetime_after integer not null,
  period_key text not null check (period_key ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  open_position_at_time boolean not null,
  position_committed_notional_usdc numeric(20,8),
  effective_for_next_operation boolean not null default true check (effective_for_next_operation),
  reason text not null check (length(btrim(reason)) between 3 and 160),
  note text check (note is null or length(note) <= 500),
  reversal_of uuid unique references coinops.robot_v1_manual_adjustments(id) on delete restrict,
  idempotency_key text not null check (length(idempotency_key) between 16 and 100),
  request_fingerprint text not null,
  strategy_version text not null,
  config_version integer,
  created_at timestamptz not null default now(),
  foreign key (product_id, tenant_id) references public.product_tenants(product_id, tenant_id) on delete restrict,
  unique (product_id, tenant_id, user_id, idempotency_key),
  constraint robot_v1_manual_adjustment_balance_check check (balance_after_usdc = balance_before_usdc + converted_amount_usdc),
  constraint robot_v1_manual_adjustment_gain_check check (monthly_after = monthly_before + gain_units
    and lifetime_after = lifetime_before + gain_units and monthly_after >= 0 and lifetime_after >= 0),
  constraint robot_v1_manual_adjustment_kind_check check (
    (kind = 'MANUAL_TARGET_GAIN' and gain_units > 0 and currency = 'USD' and original_amount > 0 and converted_amount_usdc > 0 and reversal_of is null)
    or (kind = 'MANUAL_CONTRIBUTION' and gain_units = 0 and original_amount > 0 and converted_amount_usdc > 0 and reversal_of is null)
    or (kind = 'REVERSAL' and original_amount < 0 and converted_amount_usdc < 0 and reversal_of is not null)),
  constraint robot_v1_manual_adjustment_fx_check check (
    (currency = 'USD' and fx_rate is null and fx_source is null and fx_observed_at is null and original_amount = converted_amount_usdc)
    or (currency = 'BRL' and fx_rate > 0 and fx_source = 'BINANCE_SPOT_USDCBRL_ASK'
      and fx_observed_at is not null and converted_amount_usdc = round(original_amount / fx_rate, 8)))
);
create index robot_v1_manual_adjustments_scope_slot_idx on coinops.robot_v1_manual_adjustments
  (product_id, tenant_id, user_id, environment, asset, slot_number, created_at desc);
alter table coinops.robot_v1_manual_adjustments enable row level security;
alter table coinops.robot_v1_manual_adjustments force row level security;
create policy robot_v1_manual_adjustments_owner_read on coinops.robot_v1_manual_adjustments
  for select to authenticated using (private.coinops_can_access_row(product_id, tenant_id, user_id));
revoke all on coinops.robot_v1_manual_adjustments from public, anon, authenticated;
grant select on coinops.robot_v1_manual_adjustments to authenticated, service_role;

create function coinops.reject_robot_v1_manual_adjustment_mutation()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  raise exception 'COINOPS_ADJUSTMENT_IMMUTABLE';
end $$;
create trigger robot_v1_manual_adjustments_immutable before update or delete
  on coinops.robot_v1_manual_adjustments for each row
  execute function coinops.reject_robot_v1_manual_adjustment_mutation();
revoke all on function coinops.reject_robot_v1_manual_adjustment_mutation() from public, anon, authenticated;

-- Existing consumers keep the same first columns; the new columns expose the
-- market/manual split while signed reversal facts restore historical totals.
create or replace view coinops.robot_v1_slot_gain_totals with (security_invoker = true) as
select product_id, tenant_id, user_id, environment, asset, slot_number, physical_slot_id,
  coalesce(sum(gain_units),0)::integer as lifetime_gain_count,
  coalesce(sum(gain_units) filter (where period_key = to_char(now() at time zone 'America/Campo_Grande', 'YYYY-MM')),0)::integer as monthly_gain_count,
  to_char(now() at time zone 'America/Campo_Grande', 'YYYY-MM') as period_key,
  'America/Campo_Grande'::text as timezone,
  count(*) filter (where evidence_basis in ('SHADOW_CONFIRMED_TP_CLOSE','TESTNET_EXCHANGE_FILL','TESTNET_CREDIT_FALLBACK'))::integer as market_gain_count,
  coalesce(sum(gain_units) filter (where evidence_basis in ('MANUAL_TARGET_GAIN','MANUAL_GAIN_REVERSAL')),0)::integer as manual_gain_count,
  count(*) filter (where period_key = to_char(now() at time zone 'America/Campo_Grande', 'YYYY-MM')
    and evidence_basis in ('SHADOW_CONFIRMED_TP_CLOSE','TESTNET_EXCHANGE_FILL','TESTNET_CREDIT_FALLBACK'))::integer as monthly_market_gain_count,
  coalesce(sum(gain_units) filter (where period_key = to_char(now() at time zone 'America/Campo_Grande', 'YYYY-MM')
    and evidence_basis in ('MANUAL_TARGET_GAIN','MANUAL_GAIN_REVERSAL')),0)::integer as monthly_manual_gain_count
from coinops.robot_v1_monthly_slot_gains
group by product_id, tenant_id, user_id, environment, asset, slot_number, physical_slot_id;

-- Fresh Testnet cycles use the same total rank as the live Strategy Engine.
create or replace function coinops.rank_robot_v1_testnet_fresh_cycle(p_run_id uuid, p_price_tick numeric)
returns void language plpgsql security definer set search_path = '' as $$
declare v_run coinops.robot_v1_testnet_runs%rowtype;
begin
  if coalesce(nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(auth.jwt() ->> 'role', ''), '') <> 'service_role' then
    raise exception 'COINOPS_TESTNET_SERVICE_ROLE_REQUIRED';
  end if;
  if p_price_tick <= 0 then raise exception 'COINOPS_TESTNET_PRICE_TICK_INVALID'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_run_id::text, 0));
  select * into strict v_run from coinops.robot_v1_testnet_runs where id = p_run_id for update;
  if v_run.status <> 'ACTIVE'
    or (select count(*) from coinops.robot_v1_testnet_slots where run_id = p_run_id) <> 25
    or exists (select 1 from coinops.robot_v1_testnet_orders where run_id = p_run_id)
    or exists (select 1 from coinops.robot_v1_testnet_slots where run_id = p_run_id
      and (entry_state <> 'PLANNED' or operation_sequence <> 1
        or target_buy_price <= 0 or target_buy_price / p_price_tick <> trunc(target_buy_price / p_price_tick))) then
    raise exception 'COINOPS_TESTNET_FRESH_CYCLE_REQUIRED';
  end if;
  with scored as (
    select slot.id, slot.slot_number,
      coalesce(sum(gain.gain_units),0)::integer as lifetime_gains,
      coalesce(sum(gain.gain_units) filter (where gain.period_key =
        to_char(now() at time zone 'America/Campo_Grande', 'YYYY-MM')),0)::integer as monthly_gains
    from coinops.robot_v1_testnet_slots slot
    left join coinops.robot_v1_monthly_slot_gains gain
      on gain.product_id = slot.product_id and gain.tenant_id = slot.tenant_id
      and gain.user_id = slot.user_id and gain.environment = 'TESTNET'
      and gain.asset = v_run.asset and gain.slot_number = slot.slot_number
    where slot.run_id = p_run_id
    group by slot.id, slot.slot_number
  ), ranked as (
    select id, row_number() over (order by
      (monthly_gains >= case when v_run.asset = 'BTC' then 7 else 2 end),
      lifetime_gains desc, slot_number)::integer as operational_rank from scored
  ), priced as (
    select ranked.id, grid.target_buy_price as price from ranked
    join coinops.robot_v1_testnet_slots grid on grid.run_id = p_run_id
      and grid.slot_number = ranked.operational_rank
  )
  update coinops.robot_v1_testnet_slots slot set
    target_buy_price = priced.price, entry_reference_price = priced.price
  from priced where slot.id = priced.id;
end $$;

-- This is the only write entrypoint. Parent-row locks serialize against the
-- engine's lease acquisition; a running engine forces a retry, never a race.
create function coinops.apply_robot_v1_manual_adjustment(
  p_product_id uuid, p_tenant_id uuid, p_user_id uuid, p_created_by uuid,
  p_environment text, p_asset text, p_slot_number integer, p_kind text,
  p_gain_units integer, p_currency text, p_original_amount numeric,
  p_fx_rate numeric, p_fx_source text, p_fx_observed_at timestamptz,
  p_reason text, p_note text, p_reversal_of uuid, p_idempotency_key text,
  p_expected_balance numeric, p_expected_lifetime integer, p_expected_monthly integer
) returns coinops.robot_v1_manual_adjustments
language plpgsql security definer set search_path = '' as $$
declare
  v_existing coinops.robot_v1_manual_adjustments%rowtype;
  v_original coinops.robot_v1_manual_adjustments%rowtype;
  v_config coinops.robot_v1_configs%rowtype;
  v_run coinops.robot_v1_testnet_runs%rowtype;
  v_profile coinops.robot_v1_ath_profiles%rowtype;
  v_account coinops.robot_v1_slot_accounts%rowtype;
  v_test_slot coinops.robot_v1_testnet_slots%rowtype;
  v_real coinops.robot_v1_real_prepared_slot_accounts%rowtype;
  v_physical text;
  v_balance numeric(28,12);
  v_delta numeric(20,8);
  v_original_amount numeric(20,8);
  v_gain_units integer;
  v_currency text;
  v_fx_rate numeric(20,8);
  v_fx_source text;
  v_fx_at timestamptz;
  v_period text;
  v_current_period text;
  v_monthly integer;
  v_lifetime integer;
  v_open boolean := false;
  v_committed numeric(20,8);
  v_fingerprint text;
  v_at timestamptz := now();
begin
  if coalesce(nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(auth.jwt() ->> 'role', ''), '') <> 'service_role' then
    raise exception 'COINOPS_ADJUSTMENT_SERVICE_ROLE_REQUIRED';
  end if;
  if p_environment is null or p_environment not in ('SHADOW','TESTNET','REAL')
    or p_asset is null or p_asset not in ('BTC','SOL')
    or p_slot_number is null or p_slot_number not between 1 and 25
    or p_created_by is null or p_created_by <> p_user_id
    or p_kind is null or p_kind not in ('MANUAL_TARGET_GAIN','MANUAL_CONTRIBUTION','REVERSAL')
    or p_idempotency_key is null or length(p_idempotency_key) not between 16 and 100
    or p_reason is null or length(btrim(p_reason)) not between 3 and 160
    or length(coalesce(p_note,'')) > 500 then
    raise exception 'COINOPS_ADJUSTMENT_INPUT_INVALID';
  end if;
  v_fingerprint := md5(pg_catalog.jsonb_build_object('environment',p_environment,'asset',p_asset,
    'slot',p_slot_number,'kind',p_kind,'gain_units',p_gain_units,'currency',p_currency,
    'amount',p_original_amount,'fx_rate',p_fx_rate,'fx_source',p_fx_source,
    'fx_at',p_fx_observed_at,'reason',btrim(p_reason),'note',nullif(btrim(coalesce(p_note,'')),''),
    'reversal_of',p_reversal_of)::text);
  select * into v_existing from coinops.robot_v1_manual_adjustments
    where product_id=p_product_id and tenant_id=p_tenant_id and user_id=p_user_id
      and idempotency_key=p_idempotency_key;
  if found then
    if v_existing.request_fingerprint <> v_fingerprint then raise exception 'COINOPS_ADJUSTMENT_IDEMPOTENCY_CONFLICT'; end if;
    return v_existing;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_product_id::text || ':' || p_tenant_id::text || ':' || p_user_id::text || ':' || p_environment || ':' || p_asset || ':' || p_slot_number, 0));
  select * into v_existing from coinops.robot_v1_manual_adjustments
    where product_id=p_product_id and tenant_id=p_tenant_id and user_id=p_user_id
      and idempotency_key=p_idempotency_key;
  if found then
    if v_existing.request_fingerprint <> v_fingerprint then raise exception 'COINOPS_ADJUSTMENT_IDEMPOTENCY_CONFLICT'; end if;
    return v_existing;
  end if;
  if p_environment = 'SHADOW' then
    select * into strict v_config from coinops.robot_v1_configs
      where product_id=p_product_id and tenant_id=p_tenant_id and user_id=p_user_id
        and asset=p_asset and execution_mode='SHADOW' for update;
    if v_config.strategy_lease_until > v_at then raise exception 'COINOPS_ADJUSTMENT_ENGINE_BUSY'; end if;
    select * into strict v_account from coinops.robot_v1_slot_accounts
      where config_id=v_config.id and slot_number=p_slot_number
        and product_id=p_product_id and tenant_id=p_tenant_id and user_id=p_user_id for update;
    v_balance := v_account.balance_usdc;
    v_physical := 'SHADOW:' || v_config.id::text || ':' || p_slot_number;
    select s.status in ('OPEN','TP_ACTIVE'), round(s.buy_price * s.executed_quantity,8)
      into v_open,v_committed from coinops.robot_v1_slots s
      join coinops.robot_v1_cycles cy on cy.id=s.cycle_id and cy.config_id=v_config.id
      where s.slot_number=p_slot_number and cy.status in ('STARTING','GRID_ACTIVE','POSITIONS_ACTIVE','RESETTING')
      order by cy.started_at desc limit 1;
  elsif p_environment = 'TESTNET' then
    select * into strict v_run from coinops.robot_v1_testnet_runs
      where product_id=p_product_id and tenant_id=p_tenant_id and user_id=p_user_id
        and asset=p_asset and status='ACTIVE' for update;
    if v_run.lease_until > v_at then raise exception 'COINOPS_ADJUSTMENT_ENGINE_BUSY'; end if;
    select * into strict v_test_slot from coinops.robot_v1_testnet_slots
      where run_id=v_run.id and slot_number=p_slot_number
        and product_id=p_product_id and tenant_id=p_tenant_id and user_id=p_user_id for update;
    v_balance := v_test_slot.balance_usdc;
    v_physical := 'TESTNET:' || p_product_id::text || ':' || p_tenant_id::text || ':' || p_user_id::text || ':' || p_asset || ':' || p_slot_number;
    v_open := v_test_slot.entry_state='OPEN';
    if v_open then select round(coalesce(sum(o.cumulative_quote),0),8) into v_committed
      from coinops.robot_v1_testnet_orders o where o.run_id=v_run.id and o.slot_id=v_test_slot.id
        and o.operation_sequence=v_test_slot.operation_sequence and o.side='BUY' and o.status='FILLED'; end if;
  else
    select * into strict v_profile from coinops.robot_v1_ath_profiles
      where product_id=p_product_id and tenant_id=p_tenant_id and user_id=p_user_id
        and asset=p_asset and environment='REAL' for update;
    insert into coinops.robot_v1_real_prepared_slot_accounts
      (product_id,tenant_id,user_id,asset,slot_number)
      values (p_product_id,p_tenant_id,p_user_id,p_asset,p_slot_number)
      on conflict (product_id,tenant_id,user_id,asset,slot_number) do nothing;
    select * into strict v_real from coinops.robot_v1_real_prepared_slot_accounts
      where product_id=p_product_id and tenant_id=p_tenant_id and user_id=p_user_id
        and asset=p_asset and slot_number=p_slot_number for update;
    v_balance := v_real.balance_usdc;
    v_physical := 'REAL:' || p_product_id::text || ':' || p_tenant_id::text || ':' || p_user_id::text || ':' || p_asset || ':' || p_slot_number;
  end if;
  -- Persist the effective ATH/profile version for every environment. A
  -- concurrent profile edit must not produce ambiguous adjustment metadata.
  select * into strict v_profile from coinops.robot_v1_ath_profiles
    where product_id=p_product_id and tenant_id=p_tenant_id and user_id=p_user_id
      and asset=p_asset and environment=p_environment for share;
  v_current_period := to_char(v_at at time zone 'America/Campo_Grande','YYYY-MM');
  select coalesce(sum(gain_units),0)::integer,
    coalesce(sum(gain_units) filter (where period_key=v_current_period),0)::integer
    into v_lifetime,v_monthly from coinops.robot_v1_monthly_slot_gains
    where product_id=p_product_id and tenant_id=p_tenant_id and user_id=p_user_id
      and environment=p_environment and asset=p_asset and slot_number=p_slot_number;
  if v_balance is distinct from p_expected_balance or v_lifetime is distinct from p_expected_lifetime
    or v_monthly is distinct from p_expected_monthly then
    raise exception 'COINOPS_ADJUSTMENT_PREVIEW_STALE';
  end if;
  if p_kind='REVERSAL' then
    select * into strict v_original from coinops.robot_v1_manual_adjustments
      where id=p_reversal_of and product_id=p_product_id and tenant_id=p_tenant_id and user_id=p_user_id
        and environment=p_environment and asset=p_asset and slot_number=p_slot_number
        and kind in ('MANUAL_TARGET_GAIN','MANUAL_CONTRIBUTION');
    if exists (select 1 from coinops.robot_v1_manual_adjustments where reversal_of=v_original.id) then
      raise exception 'COINOPS_ADJUSTMENT_ALREADY_REVERSED';
    end if;
    v_delta := -v_original.converted_amount_usdc;
    v_original_amount := -v_original.original_amount;
    v_gain_units := -v_original.gain_units;
    v_currency := v_original.currency;
    v_fx_rate := v_original.fx_rate;
    v_fx_source := v_original.fx_source;
    v_fx_at := v_original.fx_observed_at;
    v_period := v_original.period_key;
    if v_period<>v_current_period then
      select coalesce(sum(gain_units),0)::integer into v_monthly
        from coinops.robot_v1_monthly_slot_gains
        where product_id=p_product_id and tenant_id=p_tenant_id and user_id=p_user_id
          and environment=p_environment and asset=p_asset and slot_number=p_slot_number
          and period_key=v_period;
    end if;
  else
    if p_reversal_of is not null or p_gain_units is null or p_currency not in ('USD','BRL')
      or p_original_amount is null or p_original_amount <= 0 or p_original_amount > 1000000
      or p_original_amount <> round(p_original_amount,8)
      or (p_kind='MANUAL_TARGET_GAIN' and (p_gain_units not between 1 and 25 or p_currency<>'USD'))
      or (p_kind='MANUAL_CONTRIBUTION' and p_gain_units<>0) then
      raise exception 'COINOPS_ADJUSTMENT_INPUT_INVALID';
    end if;
    v_original_amount := p_original_amount;
    v_gain_units := p_gain_units;
    v_currency := p_currency;
    v_fx_rate := p_fx_rate;
    v_fx_source := p_fx_source;
    v_fx_at := p_fx_observed_at;
    v_period := v_current_period;
    if v_currency='BRL' then
      if p_kind<>'MANUAL_CONTRIBUTION' or v_fx_source<>'BINANCE_SPOT_USDCBRL_ASK'
        or v_fx_rate is null or v_fx_rate<=0 or v_fx_at is null
        or v_fx_at>v_at+interval '10 seconds' or v_fx_at<v_at-interval '120 seconds' then
        raise exception 'COINOPS_ADJUSTMENT_FX_STALE_OR_INVALID';
      end if;
      v_delta := round(v_original_amount/v_fx_rate,8);
    else
      if v_fx_rate is not null or v_fx_source is not null or v_fx_at is not null then
        raise exception 'COINOPS_ADJUSTMENT_FX_INVALID';
      end if;
      v_delta := v_original_amount;
    end if;
  end if;
  if v_delta=0 or (p_environment='REAL' and v_balance+v_delta<0)
    or (p_environment<>'REAL' and v_balance+v_delta<=0)
    or v_lifetime+v_gain_units<0 or v_monthly+v_gain_units<0 then
    raise exception 'COINOPS_ADJUSTMENT_BALANCE_INVALID';
  end if;
  insert into coinops.robot_v1_manual_adjustments
    (product_id,tenant_id,user_id,created_by,environment,asset,slot_number,physical_slot_id,
      kind,gain_units,currency,original_amount,fx_rate,fx_source,fx_observed_at,converted_amount_usdc,
      balance_before_usdc,balance_after_usdc,monthly_before,monthly_after,lifetime_before,lifetime_after,
      period_key,open_position_at_time,position_committed_notional_usdc,reason,note,reversal_of,
      idempotency_key,request_fingerprint,strategy_version,config_version)
  values (p_product_id,p_tenant_id,p_user_id,p_created_by,p_environment,p_asset,p_slot_number,v_physical,
    p_kind,v_gain_units,v_currency,v_original_amount,v_fx_rate,v_fx_source,v_fx_at,v_delta,
    v_balance,v_balance+v_delta,v_monthly,v_monthly+v_gain_units,
    v_lifetime,v_lifetime+v_gain_units,v_period,coalesce(v_open,false),v_committed,
    btrim(p_reason),nullif(btrim(coalesce(p_note,'')),''),p_reversal_of,
    p_idempotency_key,v_fingerprint,'4.3',v_profile.config_version)
  returning * into v_existing;
  if p_environment='SHADOW' then
    update coinops.robot_v1_slot_accounts set balance_usdc=v_balance+v_delta,
      manual_gain_usdc=manual_gain_usdc+case when p_kind='MANUAL_TARGET_GAIN' then v_delta
        when p_kind='REVERSAL' and v_original.kind='MANUAL_TARGET_GAIN' then v_delta else 0 end,
      contribution_usdc=contribution_usdc+case when p_kind='MANUAL_CONTRIBUTION' then v_delta
        when p_kind='REVERSAL' and v_original.kind='MANUAL_CONTRIBUTION' then v_delta else 0 end,
      gain_count=gain_count+v_gain_units,updated_at=v_at
      where config_id=v_config.id and slot_number=p_slot_number;
  elsif p_environment='TESTNET' then
    update coinops.robot_v1_testnet_slots set balance_usdc=v_balance+v_delta,
      manual_gain_usdc=manual_gain_usdc+case when p_kind='MANUAL_TARGET_GAIN' then v_delta
        when p_kind='REVERSAL' and v_original.kind='MANUAL_TARGET_GAIN' then v_delta else 0 end,
      contribution_usdc=contribution_usdc+case when p_kind='MANUAL_CONTRIBUTION' then v_delta
        when p_kind='REVERSAL' and v_original.kind='MANUAL_CONTRIBUTION' then v_delta else 0 end,
      gain_count=gain_count+case when p_kind='REVERSAL' and v_original.created_at<v_run.created_at
        then 0 else v_gain_units end where id=v_test_slot.id;
  else
    update coinops.robot_v1_real_prepared_slot_accounts set balance_usdc=v_balance+v_delta,
      manual_gain_usdc=manual_gain_usdc+case when p_kind='MANUAL_TARGET_GAIN' then v_delta
        when p_kind='REVERSAL' and v_original.kind='MANUAL_TARGET_GAIN' then v_delta else 0 end,
      contribution_usdc=contribution_usdc+case when p_kind='MANUAL_CONTRIBUTION' then v_delta
        when p_kind='REVERSAL' and v_original.kind='MANUAL_CONTRIBUTION' then v_delta else 0 end,
      gain_count=gain_count+v_gain_units
      where product_id=p_product_id and tenant_id=p_tenant_id and user_id=p_user_id
        and asset=p_asset and slot_number=p_slot_number;
  end if;
  if v_gain_units<>0 then
    insert into coinops.robot_v1_monthly_slot_gains
      (environment,source_id,product_id,tenant_id,user_id,asset,slot_number,physical_slot_id,
        credited_at,effective_gain_at,evidence_basis,period_key,gain_units)
    values (p_environment,v_existing.id,p_product_id,p_tenant_id,p_user_id,p_asset,p_slot_number,v_physical,
      v_at,v_at,case when p_kind='REVERSAL' then 'MANUAL_GAIN_REVERSAL' else 'MANUAL_TARGET_GAIN' end,
      v_period,v_gain_units);
  end if;
  return v_existing;
end $$;
revoke all on function coinops.apply_robot_v1_manual_adjustment(uuid,uuid,uuid,uuid,text,text,integer,text,
  integer,text,numeric,numeric,text,timestamptz,text,text,uuid,text,numeric,integer,integer)
  from public,anon,authenticated;
grant execute on function coinops.apply_robot_v1_manual_adjustment(uuid,uuid,uuid,uuid,text,text,integer,text,
  integer,text,numeric,numeric,text,timestamptz,text,text,uuid,text,numeric,integer,integer)
  to service_role;

comment on table coinops.robot_v1_manual_adjustments is
  'Immutable CoinOps 4.4 slot-equity adjustments; reversal is a second signed row. OPEN positions and exchange orders remain untouched.';
