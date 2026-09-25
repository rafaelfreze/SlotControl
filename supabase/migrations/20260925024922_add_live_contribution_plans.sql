-- A monthly plan is an audited intention only. It never creates a contribution,
-- changes a cap, schedules an exchange write, or touches an open position.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';

create table coinops.robot_v1_live_contribution_plans (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  operator_id uuid not null references coinops.operators(id),
  exchange_account_id uuid not null references coinops.exchange_accounts(id),
  quote_asset text not null check (quote_asset in ('BRL','USDT')),
  revision integer not null check (revision > 0),
  request_id uuid not null,
  status text not null check (status in ('ACTIVE','DISABLED')),
  origin_currency text not null check (origin_currency in ('BRL','USDT')),
  monthly_amount_origin numeric(20,2) not null check (monthly_amount_origin > 0),
  btc_percent integer not null check (btc_percent between 0 and 100),
  sol_percent integer generated always as (100-btc_percent) stored,
  start_month date not null check (extract(day from start_month)=1),
  horizon_months integer not null check (horizon_months between 1 and 120),
  reason text not null check (length(btrim(reason)) between 3 and 160),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  unique (exchange_account_id,quote_asset,revision),
  unique (exchange_account_id,request_id)
);
create index robot_v1_live_contribution_plans_latest_idx
  on coinops.robot_v1_live_contribution_plans(exchange_account_id,quote_asset,created_at desc);
create trigger robot_v1_live_contribution_plans_immutable
  before update or delete on coinops.robot_v1_live_contribution_plans
  for each row execute function coinops.reject_live_adjustment_mutation();
alter table coinops.robot_v1_live_contribution_plans enable row level security;
alter table coinops.robot_v1_live_contribution_plans force row level security;
create policy live_contribution_plans_owner_read on coinops.robot_v1_live_contribution_plans
  for select to authenticated using (private.coinops_can_access_row(product_id,tenant_id,user_id));
revoke all on coinops.robot_v1_live_contribution_plans from public,anon,authenticated;
grant select on coinops.robot_v1_live_contribution_plans to authenticated;
grant all on coinops.robot_v1_live_contribution_plans to service_role;

create function coinops.save_live_contribution_plan(
  p_operator_id uuid,p_account_id uuid,p_created_by uuid,p_quote_asset text,
  p_action text,p_origin_currency text,p_monthly_amount_origin numeric,
  p_btc_percent integer,p_start_month date,p_horizon_months integer,
  p_reason text,p_request_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_operator coinops.operators%rowtype;
  v_account coinops.exchange_accounts%rowtype;
  v_existing coinops.robot_v1_live_contribution_plans%rowtype;
  v_latest coinops.robot_v1_live_contribution_plans%rowtype;
  v_saved coinops.robot_v1_live_contribution_plans%rowtype;
begin
  if coalesce(nullif(current_setting('request.jwt.claim.role',true),''),auth.jwt()->>'role','') <> 'service_role'
    or p_action not in ('ACTIVE','DISABLED') or p_quote_asset not in ('BRL','USDT')
    or p_origin_currency not in ('BRL','USDT') or p_monthly_amount_origin<=0
    or p_monthly_amount_origin<>round(p_monthly_amount_origin,2)
    or p_btc_percent not between 0 and 100 or p_horizon_months not between 1 and 120
    or extract(day from p_start_month)<>1
    or length(btrim(coalesce(p_reason,''))) not between 3 and 160
    or p_request_id is null or p_created_by is null then
    raise exception 'COINOPS_CONTRIBUTION_PLAN_INPUT_DENIED';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_account_id::text||':'||p_quote_asset,0));
  select * into v_existing from coinops.robot_v1_live_contribution_plans
    where exchange_account_id=p_account_id and request_id=p_request_id;
  if v_existing.id is not null then
    if v_existing.operator_id<>p_operator_id or v_existing.status<>p_action
      or v_existing.origin_currency<>p_origin_currency
      or v_existing.monthly_amount_origin<>p_monthly_amount_origin
      or v_existing.btc_percent<>p_btc_percent
      or v_existing.start_month<>p_start_month
      or v_existing.horizon_months<>p_horizon_months
      or v_existing.reason<>btrim(p_reason) then
      raise exception 'COINOPS_CONTRIBUTION_PLAN_REPLAY_CONFLICT';
    end if;
    return jsonb_build_object('id',v_existing.id,'status','REPLAYED');
  end if;
  select * into v_operator from coinops.operators where id=p_operator_id and status='ACTIVE' for share;
  select * into v_account from coinops.exchange_accounts
    where id=p_account_id and operator_id=p_operator_id and status='ACTIVE' for share;
  if v_operator.id is null or v_operator.user_id<>p_created_by or v_account.id is null then
    raise exception 'COINOPS_CONTRIBUTION_PLAN_SCOPE_DENIED';
  end if;
  if not exists(select 1 from coinops.trading_engines
    where operator_id=p_operator_id and exchange_account_id=p_account_id
      and environment='REAL' and quote_asset=p_quote_asset and base_asset='BTC'
      and status='ACTIVE') and p_btc_percent>0
    or not exists(select 1 from coinops.trading_engines
    where operator_id=p_operator_id and exchange_account_id=p_account_id
      and environment='REAL' and quote_asset=p_quote_asset and base_asset='SOL'
      and status='ACTIVE') and p_btc_percent<100 then
    raise exception 'COINOPS_CONTRIBUTION_PLAN_ENGINE_DENIED';
  end if;
  select * into v_latest from coinops.robot_v1_live_contribution_plans
    where exchange_account_id=p_account_id and quote_asset=p_quote_asset
    order by revision desc limit 1;
  if p_action='DISABLED' and (v_latest.id is null or v_latest.status='DISABLED') then
    raise exception 'COINOPS_CONTRIBUTION_PLAN_NOT_ACTIVE';
  end if;
  insert into coinops.robot_v1_live_contribution_plans
    (product_id,tenant_id,user_id,operator_id,exchange_account_id,quote_asset,revision,
      request_id,status,origin_currency,monthly_amount_origin,btc_percent,start_month,
      horizon_months,reason,created_by)
  values(v_operator.product_id,v_operator.tenant_id,v_operator.user_id,p_operator_id,p_account_id,
    p_quote_asset,coalesce(v_latest.revision,0)+1,p_request_id,p_action,p_origin_currency,
    p_monthly_amount_origin,p_btc_percent,p_start_month,p_horizon_months,btrim(p_reason),p_created_by)
  returning * into v_saved;
  return jsonb_build_object('id',v_saved.id,'status',v_saved.status,'revision',v_saved.revision);
end $$;
revoke all on function coinops.save_live_contribution_plan(uuid,uuid,uuid,text,text,text,numeric,integer,date,integer,text,uuid)
  from public,anon,authenticated;
grant execute on function coinops.save_live_contribution_plan(uuid,uuid,uuid,text,text,text,numeric,integer,date,integer,text,uuid)
  to service_role;
commit;
