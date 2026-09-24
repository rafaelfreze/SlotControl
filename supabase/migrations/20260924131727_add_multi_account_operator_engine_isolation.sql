-- CoinOps 5.6: expand/backfill identity only. No exchange call, activation,
-- monetary conversion, resident-order rewrite, or historical-ID replacement.
begin;
set local lock_timeout='3s';
set local statement_timeout='60s';

create table coinops.operators (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null, tenant_id uuid not null, user_id uuid not null,
  status text not null default 'INACTIVE' check (status in ('ACTIVE','INACTIVE','DISABLED')),
  kill_switch boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(product_id,tenant_id,user_id), unique(id,product_id,tenant_id,user_id),
  foreign key(product_id,tenant_id) references public.product_tenants(product_id,tenant_id) on delete restrict
);
create table coinops.exchange_accounts (
  id uuid primary key default gen_random_uuid(), operator_id uuid not null references coinops.operators(id) on delete restrict,
  display_name text not null check(length(btrim(display_name)) between 1 and 80),
  status text not null default 'INACTIVE' check(status in ('ACTIVE','INACTIVE','DISABLED','REVOKED')),
  credential_ref text check(credential_ref ~ '^[a-zA-Z0-9_-]{3,100}$'),
  executor_profile text check(executor_profile ~ '^[a-zA-Z0-9_-]{3,100}$'),
  is_legacy_default boolean not null default false, kill_switch boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(id,operator_id)
);
create unique index exchange_accounts_one_legacy on coinops.exchange_accounts(operator_id) where is_legacy_default;
create table coinops.trading_engines (
  id uuid primary key default gen_random_uuid(), operator_id uuid not null,
  exchange_account_id uuid not null,
  environment text not null check(environment in ('REAL','SHADOW','TESTNET')),
  symbol text not null, base_asset text not null check(base_asset ~ '^[A-Z0-9]{2,20}$'),
  quote_asset text not null check(quote_asset ~ '^[A-Z0-9]{2,20}$'),
  ath_reference_symbol text not null check(ath_reference_symbol ~ '^[A-Z0-9]{4,40}$'),
  status text not null default 'INACTIVE' check(status in ('ACTIVE','INACTIVE','PAUSED','DISABLED')),
  kill_switch boolean not null default true, legacy_compatible boolean not null default false,
  hard_cap_quote numeric(28,12) not null default 0 check(hard_cap_quote>=0 and hard_cap_quote::text not in ('NaN','Infinity','-Infinity')),
  config jsonb not null default '{}' check(jsonb_typeof(config)='object'),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check(symbol=base_asset||quote_asset and base_asset<>quote_asset),
  unique(exchange_account_id,environment,symbol), unique(id,operator_id,exchange_account_id),
  unique(id,operator_id,exchange_account_id,quote_asset),
  foreign key(exchange_account_id,operator_id) references coinops.exchange_accounts(id,operator_id) on delete restrict
);
create unique index trading_engines_legacy_asset on coinops.trading_engines(operator_id,environment,base_asset) where legacy_compatible;
create function private.coinops_default_ath_reference() returns trigger language plpgsql set search_path='' as $$begin
 if new.ath_reference_symbol is null then new.ath_reference_symbol:=case when new.legacy_compatible then new.base_asset||'USDC' else new.symbol end;end if;
 return new;end $$;
revoke all on function private.coinops_default_ath_reference() from public,anon,authenticated;
create trigger trading_engines_ath_reference before insert on coinops.trading_engines for each row execute function private.coinops_default_ath_reference();
create table coinops.account_quote_caps (
  operator_id uuid not null, exchange_account_id uuid not null,
  quote_asset text not null check(quote_asset ~ '^[A-Z0-9]{2,20}$'),
  hard_cap_quote numeric(28,12) not null default 0 check(hard_cap_quote>=0 and hard_cap_quote::text not in ('NaN','Infinity','-Infinity')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  primary key(exchange_account_id,quote_asset),
  foreign key(exchange_account_id,operator_id) references coinops.exchange_accounts(id,operator_id) on delete restrict
);

-- Only existing operational scopes become legacy bindings. Never choose the
-- first account and never use an operator's other account as a fallback.
insert into coinops.operators(product_id,tenant_id,user_id,status,kill_switch)
select product_id,tenant_id,user_id,'ACTIVE',false from (
 select product_id,tenant_id,user_id from coinops.robot_v1_configs
 union select product_id,tenant_id,user_id from coinops.robot_v1_testnet_runs
 union select product_id,tenant_id,user_id from coinops.robot_v1_live_preparations
 union select product_id,tenant_id,user_id from coinops.robot_v1_ath_profiles
) s;
insert into coinops.exchange_accounts(operator_id,display_name,status,credential_ref,executor_profile,is_legacy_default,kill_switch)
select id,'Rafael','ACTIVE','legacy-binance-production','coinops-fixed-ip',true,false from coinops.operators;
insert into coinops.trading_engines(operator_id,exchange_account_id,environment,symbol,base_asset,quote_asset,
 status,kill_switch,legacy_compatible,hard_cap_quote,config)
select o.id,a.id,s.environment,s.symbol,s.asset,s.quote_asset,'ACTIVE',false,true,
 coalesce(p.max_total_exposure_brl,case when s.environment='SHADOW' then
  (select c.capital_usdc from coinops.robot_v1_configs c where c.product_id=s.product_id and c.tenant_id=s.tenant_id and c.user_id=s.user_id and c.asset=s.asset)
  when s.environment='TESTNET' then (select r.slot_notional_usdc*25 from coinops.robot_v1_testnet_runs r
   where r.product_id=s.product_id and r.tenant_id=s.tenant_id and r.user_id=s.user_id and r.asset=s.asset order by r.created_at desc limit 1) end,0),
 jsonb_build_object('legacy_binding',true)
from (
 select product_id,tenant_id,user_id,'SHADOW'::text environment,asset,symbol,'USDC'::text quote_asset from coinops.robot_v1_configs
 union select product_id,tenant_id,user_id,'TESTNET',asset,symbol,'USDC' from coinops.robot_v1_testnet_runs
 union select product_id,tenant_id,user_id,'REAL',asset,symbol,'BRL' from coinops.robot_v1_live_preparations
 union select product_id,tenant_id,user_id,environment,asset,asset||case when environment='REAL' then 'BRL' else 'USDC' end,
   case when environment='REAL' then 'BRL' else 'USDC' end from coinops.robot_v1_ath_profiles
) s join coinops.operators o using(product_id,tenant_id,user_id)
join coinops.exchange_accounts a on a.operator_id=o.id and a.is_legacy_default
left join coinops.robot_v1_live_preparations p on p.product_id=s.product_id and p.tenant_id=s.tenant_id
 and p.user_id=s.user_id and p.asset=s.asset and s.environment='REAL';
-- Retired 4.4 REAL/USDC preparation evidence is not a BRL balance. Keep a
-- disabled archival engine only where such historical rows actually exist.
insert into coinops.trading_engines(operator_id,exchange_account_id,environment,symbol,base_asset,quote_asset,config)
select distinct o.id,a.id,'REAL',s.asset||'USDC',s.asset,'USDC','{"historical_preparation_only":true}'::jsonb
from (select product_id,tenant_id,user_id,asset from coinops.robot_v1_real_prepared_slot_accounts
 union select product_id,tenant_id,user_id,asset from coinops.robot_v1_manual_adjustments where environment='REAL') s
join coinops.operators o using(product_id,tenant_id,user_id)
join coinops.exchange_accounts a on a.operator_id=o.id and a.is_legacy_default
on conflict(exchange_account_id,environment,symbol) do nothing;
insert into coinops.account_quote_caps(operator_id,exchange_account_id,quote_asset,hard_cap_quote)
select o.id,a.id,'BRL',g.max_total_live_exposure_brl from coinops.robot_v1_live_global_caps g
join coinops.operators o using(product_id,tenant_id,user_id)
join coinops.exchange_accounts a on a.operator_id=o.id and a.is_legacy_default;

create function private.coinops_operator_owned(p_operator uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from coinops.operators o where o.id=p_operator and o.status<>'DISABLED'
   and private.coinops_can_access_row(o.product_id,o.tenant_id,o.user_id))
$$;
revoke all on function private.coinops_operator_owned(uuid) from public,anon;
grant execute on function private.coinops_operator_owned(uuid) to authenticated,service_role;
do $$declare t text; begin
 foreach t in array array['operators','exchange_accounts','trading_engines','account_quote_caps'] loop
  execute format('alter table coinops.%I enable row level security',t);
  execute format('alter table coinops.%I force row level security',t);
  execute format('revoke all on coinops.%I from public,anon,authenticated',t);
  execute format('grant select on coinops.%I to authenticated',t);
  execute format('grant all on coinops.%I to service_role',t);
  if t='operators' then
   execute 'create policy operator_owned on coinops.operators for select to authenticated using(status<>''DISABLED'' and private.coinops_can_access_row(product_id,tenant_id,user_id))';
  else
   execute format('create policy operator_owned on coinops.%I for select to authenticated using(private.coinops_operator_owned(operator_id))',t);
  end if;
 end loop;
end $$;
-- Credential references are server-side routing metadata, not browser fields.
revoke select on coinops.exchange_accounts from authenticated;
grant select(id,operator_id,display_name,status,is_legacy_default,kill_switch,created_at,updated_at)
 on coinops.exchange_accounts to authenticated;

create function private.coinops_resolve_engine(p_product uuid,p_tenant uuid,p_user uuid,
 p_environment text,p_asset text,p_engine uuid default null,p_account uuid default null)
returns coinops.trading_engines language plpgsql stable security definer set search_path='' as $$
declare e coinops.trading_engines%rowtype; begin
 select x.* into strict e from coinops.trading_engines x
 join coinops.operators o on o.id=x.operator_id
 join coinops.exchange_accounts a on a.id=x.exchange_account_id and a.operator_id=o.id
 where o.product_id=p_product and o.tenant_id=p_tenant and o.user_id=p_user
  and x.environment=p_environment and x.base_asset=p_asset
  and (p_account is null or x.exchange_account_id=p_account)
  and ((p_engine is not null and x.id=p_engine)
    or (p_engine is null and p_account is null and a.is_legacy_default and x.legacy_compatible));
 return e;
exception when no_data_found or too_many_rows then raise exception 'COINOPS_ENGINE_SCOPE_DENIED';
end $$;
revoke all on function private.coinops_resolve_engine(uuid,uuid,uuid,text,text,uuid,uuid) from public,anon,authenticated;
grant execute on function private.coinops_resolve_engine(uuid,uuid,uuid,text,text,uuid,uuid) to service_role;

-- The manifest is ordered by parent dependency; all row identities are linked
-- through parents where available, including immutable financial evidence.
create temporary table coinops_engine_manifest(ord integer,name text,environment text,parent_table text,parent_column text,account_only boolean default false) on commit drop;
insert into coinops_engine_manifest values
(1,'robot_v1_configs','SHADOW',null,null,false),
(2,'robot_v1_cycles','SHADOW','robot_v1_configs','config_id',false),
(3,'robot_v1_slots','SHADOW','robot_v1_cycles','cycle_id',false),
(4,'robot_v1_slot_operations','SHADOW','robot_v1_slots','slot_id',false),
(5,'robot_v1_slot_accounts','SHADOW','robot_v1_configs','config_id',false),
(6,'robot_v1_slot_profit_credits','SHADOW','robot_v1_slot_operations','operation_id',false),
(7,'robot_v1_audit_events','SHADOW','robot_v1_configs','config_id',false),
(8,'robot_v1_market_candles','SHADOW','robot_v1_configs','config_id',false),
(9,'robot_v1_testnet_runs','TESTNET',null,null,false),
(10,'robot_v1_testnet_slots','TESTNET','robot_v1_testnet_runs','run_id',false),
(11,'robot_v1_testnet_orders','TESTNET','robot_v1_testnet_runs','run_id',false),
(12,'robot_v1_testnet_events','TESTNET','robot_v1_testnet_runs','run_id',false),
(13,'robot_v1_live_preparations','REAL',null,null,false),
(14,'robot_v1_live_slot_accounts','REAL',null,null,false),
(15,'robot_v1_live_runs','REAL',null,null,false),
(16,'robot_v1_live_slots','REAL','robot_v1_live_runs','run_id',false),
(17,'robot_v1_live_orders','REAL','robot_v1_live_runs','run_id',false),
(18,'robot_v1_live_fills','REAL','robot_v1_live_orders','order_id',false),
(19,'robot_v1_live_events','REAL','robot_v1_live_runs','run_id',false),
(20,'robot_v1_ath_profiles',null,null,null,false),
(21,'robot_v1_ath_events',null,'robot_v1_ath_profiles','profile_id',false),
(22,'robot_v1_real_prepared_slot_accounts','REAL',null,null,false),
(23,'robot_v1_manual_adjustments',null,null,null,false),
(24,'robot_v1_monthly_slot_gains',null,null,null,false),
(25,'robot_v1_strategy_decisions',null,null,null,false),
(26,'robot_v1_live_alerts','REAL',null,null,true),
(27,'robot_v1_live_preparation_events','REAL',null,null,true),
(28,'report_runtime_observations',null,null,null,true),
(29,'robot_v1_live_global_caps','REAL',null,null,true);
do $$declare r record; begin
 for r in select * from coinops_engine_manifest order by ord loop
  execute format('alter table coinops.%I add column operator_id uuid, add column exchange_account_id uuid, add column trading_engine_id uuid',r.name);
  if not exists(select 1 from information_schema.columns where table_schema='coinops' and table_name=r.name and column_name='quote_asset') then
   execute format('alter table coinops.%I add column quote_asset text',r.name);
  end if;
 end loop;
end $$;

create function private.coinops_parent_engine(p_table text,p_id uuid) returns uuid
language plpgsql stable security definer set search_path='' as $$declare result uuid; begin
 if p_table not in ('robot_v1_configs','robot_v1_cycles','robot_v1_slots','robot_v1_slot_operations',
  'robot_v1_testnet_runs','robot_v1_testnet_slots','robot_v1_testnet_orders','robot_v1_testnet_events',
  'robot_v1_live_runs','robot_v1_live_slots','robot_v1_live_orders','robot_v1_live_events',
  'robot_v1_ath_profiles','robot_v1_manual_adjustments') then raise exception 'COINOPS_ENGINE_PARENT_INVALID'; end if;
 execute format('select trading_engine_id from coinops.%I where id=$1',p_table) into strict result using p_id;
 if result is null then raise exception 'COINOPS_ENGINE_PARENT_UNBOUND'; end if;
 return result;
exception when no_data_found then raise exception 'COINOPS_ENGINE_PARENT_MISSING'; end $$;
revoke all on function private.coinops_parent_engine(text,uuid) from public,anon,authenticated;
grant execute on function private.coinops_parent_engine(text,uuid) to service_role;

create function private.coinops_row_engine_context(j jsonb,p_table text,p_environment text,
 p_parent text,p_parent_column text,p_account_only boolean default false) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare e coinops.trading_engines%rowtype; parent_id uuid; wanted uuid;
 env text:=coalesce(j->>'environment',p_environment); asset text:=j->>'asset';
 o coinops.operators%rowtype; a coinops.exchange_accounts%rowtype; parent_table text; begin
 wanted:=nullif(j->>'trading_engine_id','')::uuid;
 if wanted is null and (p_table='robot_v1_real_prepared_slot_accounts'
  or (p_table='robot_v1_manual_adjustments' and env='REAL')) then
  select x.id into strict wanted from coinops.trading_engines x join coinops.operators op on op.id=x.operator_id
   join coinops.exchange_accounts ac on ac.id=x.exchange_account_id
   where op.product_id=(j->>'product_id')::uuid and op.tenant_id=(j->>'tenant_id')::uuid
    and op.user_id=(j->>'user_id')::uuid and x.environment='REAL' and x.symbol=asset||'USDC'
    and ac.is_legacy_default and x.config->>'historical_preparation_only'='true';
 end if;
 if p_parent is not null and j->>p_parent_column is not null then
  parent_id:=private.coinops_parent_engine(p_parent,(j->>p_parent_column)::uuid);
 elsif p_table='robot_v1_strategy_decisions' and j->>'cycle_id' is not null then
  parent_id:=private.coinops_parent_engine(case env when 'REAL' then 'robot_v1_live_runs' when 'TESTNET' then 'robot_v1_testnet_runs' else 'robot_v1_cycles' end,(j->>'cycle_id')::uuid);
 elsif p_table='robot_v1_monthly_slot_gains' then
  parent_table:=case when j->>'evidence_basis' in ('MANUAL_TARGET_GAIN','MANUAL_GAIN_REVERSAL') then 'robot_v1_manual_adjustments'
   when env='REAL' then 'robot_v1_live_orders' when env='TESTNET' then 'robot_v1_testnet_events' else 'robot_v1_slot_operations' end;
  parent_id:=private.coinops_parent_engine(parent_table,(j->>'source_id')::uuid);
 elsif p_table='robot_v1_manual_adjustments' and j->>'reversal_of' is not null then
  parent_id:=private.coinops_parent_engine('robot_v1_manual_adjustments',(j->>'reversal_of')::uuid);
 end if;
 if parent_id is not null then
  if wanted is not null and wanted<>parent_id then raise exception 'COINOPS_ENGINE_PARENT_MISMATCH'; end if;
  wanted:=parent_id;
 end if;
 if wanted is not null then
  select * into strict e from coinops.trading_engines where id=wanted;
  asset:=coalesce(asset,e.base_asset); env:=coalesce(env,e.environment);
 elsif asset is null and j->>'symbol' is not null then
  select x.* into strict e from coinops.trading_engines x join coinops.operators op on op.id=x.operator_id
   join coinops.exchange_accounts ac on ac.id=x.exchange_account_id
   where op.product_id=(j->>'product_id')::uuid and op.tenant_id=(j->>'tenant_id')::uuid
    and op.user_id=(j->>'user_id')::uuid and x.symbol=j->>'symbol' and x.environment=env
    and ac.is_legacy_default and x.legacy_compatible;
  wanted:=e.id; asset:=e.base_asset;
 end if;
 if wanted is null and asset is null and p_account_only then
  select * into strict o from coinops.operators where product_id=(j->>'product_id')::uuid
   and tenant_id=(j->>'tenant_id')::uuid and user_id=(j->>'user_id')::uuid;
  select * into strict a from coinops.exchange_accounts where operator_id=o.id
   and ((j->>'exchange_account_id' is not null and id=(j->>'exchange_account_id')::uuid)
    or (j->>'exchange_account_id' is null and is_legacy_default));
  if j->>'operator_id' is not null and (j->>'operator_id')::uuid<>o.id then raise exception 'COINOPS_OPERATOR_SCOPE_DENIED'; end if;
  return jsonb_build_object('operator_id',o.id,'exchange_account_id',a.id,'trading_engine_id',null,'quote_asset',coalesce(j->>'quote_asset',case when env='REAL' then 'BRL' end));
 end if;
 e:=private.coinops_resolve_engine((j->>'product_id')::uuid,(j->>'tenant_id')::uuid,(j->>'user_id')::uuid,
  env,asset,wanted,nullif(j->>'exchange_account_id','')::uuid);
 if (j->>'operator_id' is not null and (j->>'operator_id')::uuid<>e.operator_id)
  or (j->>'symbol' is not null and j->>'symbol'<>e.symbol)
  or (j->>'quote_asset' is not null and j->>'quote_asset'<>e.quote_asset
    and p_table<>'robot_v1_real_prepared_slot_accounts') then raise exception 'COINOPS_ENGINE_IDENTITY_MISMATCH'; end if;
 return jsonb_build_object('operator_id',e.operator_id,'exchange_account_id',e.exchange_account_id,
   'trading_engine_id',e.id,'quote_asset',e.quote_asset);
exception when no_data_found or too_many_rows then raise exception 'COINOPS_ENGINE_SCOPE_DENIED'; end $$;
revoke all on function private.coinops_row_engine_context(jsonb,text,text,text,text,boolean) from public,anon,authenticated;
grant execute on function private.coinops_row_engine_context(jsonb,text,text,text,text,boolean) to service_role;

-- Suppress ONLY existing user triggers during metadata backfill, restoring each
-- original enabled mode. This avoids timestamps/audits/credits being replayed.
create temporary table coinops_engine_trigger_state on commit drop as
select n.nspname,c.relname,t.tgname,t.tgenabled from pg_trigger t join pg_class c on c.oid=t.tgrelid
join pg_namespace n on n.oid=c.relnamespace join coinops_engine_manifest m on m.name=c.relname
where n.nspname='coinops' and not t.tgisinternal;
do $$declare r record; begin
 for r in select * from coinops_engine_trigger_state where tgenabled<>'D' loop
  execute format('alter table %I.%I disable trigger %I',r.nspname,r.relname,r.tgname);
 end loop;
 for r in select * from coinops_engine_manifest order by ord loop
  execute format('update coinops.%I x set (operator_id,exchange_account_id,trading_engine_id,quote_asset) =
   (select (c->>''operator_id'')::uuid,(c->>''exchange_account_id'')::uuid,(c->>''trading_engine_id'')::uuid,c->>''quote_asset''
    from (select private.coinops_row_engine_context(to_jsonb(x),%L,%L,%L,%L,%L) c) q)',
    r.name,r.name,r.environment,r.parent_table,r.parent_column,r.account_only);
 end loop;
 for r in select * from coinops_engine_trigger_state where tgenabled<>'D' loop
  execute format('alter table %I.%I %s trigger %I',r.nspname,r.relname,
   case r.tgenabled when 'A' then 'enable always' when 'R' then 'enable replica' else 'enable' end,r.tgname);
 end loop;
end $$;

create function private.coinops_bind_engine_context() returns trigger
language plpgsql security definer set search_path='' as $$
declare j jsonb:=to_jsonb(new); c jsonb; parent uuid; e coinops.trading_engines%rowtype; begin
 c:=private.coinops_row_engine_context(j,tg_table_name,nullif(tg_argv[0],''),nullif(tg_argv[1],''),nullif(tg_argv[2],''),tg_argv[3]::boolean);
 if tg_op='UPDATE' and (old.operator_id,old.exchange_account_id,old.trading_engine_id,old.quote_asset)
  is distinct from ((c->>'operator_id')::uuid,(c->>'exchange_account_id')::uuid,(c->>'trading_engine_id')::uuid,c->>'quote_asset') then
  raise exception 'COINOPS_ENGINE_IDENTITY_IMMUTABLE';
 end if;
 -- A slot/run pair must agree even when old schemas only constrain its user.
 if j->>'slot_id' is not null and tg_table_name in ('robot_v1_testnet_orders','robot_v1_live_orders','robot_v1_slot_operations','robot_v1_audit_events') then
  parent:=private.coinops_parent_engine(case when tg_table_name='robot_v1_live_orders' then 'robot_v1_live_slots'
    when tg_table_name='robot_v1_testnet_orders' then 'robot_v1_testnet_slots' else 'robot_v1_slots' end,(j->>'slot_id')::uuid);
  if parent<>(c->>'trading_engine_id')::uuid then raise exception 'COINOPS_ENGINE_SLOT_MISMATCH'; end if;
 end if;
 if tg_op='INSERT' and j ? 'physical_slot_id' and c->>'trading_engine_id' is not null then
  select * into strict e from coinops.trading_engines where id=(c->>'trading_engine_id')::uuid;
  if not e.legacy_compatible then c:=c||jsonb_build_object('physical_slot_id',e.environment||':'||e.id||':'||(j->>'slot_number')); end if;
 end if;
 if j->>'previous_run_id' is not null and tg_table_name in ('robot_v1_testnet_runs','robot_v1_live_runs') then
  parent:=private.coinops_parent_engine(tg_table_name,(j->>'previous_run_id')::uuid);
  if parent<>(c->>'trading_engine_id')::uuid then raise exception 'COINOPS_ENGINE_PREVIOUS_RUN_MISMATCH'; end if;
 end if;
 new:=jsonb_populate_record(new,c); return new;
end $$;
revoke all on function private.coinops_bind_engine_context() from public,anon,authenticated;
grant execute on function private.coinops_bind_engine_context() to service_role;
do $$declare r record; begin
 for r in select * from coinops_engine_manifest order by ord loop
  execute format('alter table coinops.%I alter column operator_id set not null, alter column exchange_account_id set not null',r.name);
  if not r.account_only then execute format('alter table coinops.%I alter column trading_engine_id set not null, alter column quote_asset set not null',r.name); end if;
  execute format('alter table coinops.%I add constraint %I foreign key(operator_id,product_id,tenant_id,user_id) references coinops.operators(id,product_id,tenant_id,user_id) on delete restrict',r.name,r.name||'_operator_fk');
  execute format('alter table coinops.%I add constraint %I foreign key(exchange_account_id,operator_id) references coinops.exchange_accounts(id,operator_id) on delete restrict',r.name,r.name||'_account_fk');
  execute format('alter table coinops.%I add constraint %I foreign key(trading_engine_id,operator_id,exchange_account_id,quote_asset) references coinops.trading_engines(id,operator_id,exchange_account_id,quote_asset) on delete restrict',r.name,r.name||'_engine_fk');
  execute format('create index %I on coinops.%I(trading_engine_id)',r.name||'_engine_idx',r.name);
  execute format('create policy operator_context_visible on coinops.%I as restrictive for select to authenticated using(private.coinops_operator_owned(operator_id))',r.name);
  execute format('create trigger aa_coinops_engine_context before insert or update on coinops.%I for each row execute function private.coinops_bind_engine_context(%L,%L,%L,%L)',r.name,coalesce(r.environment,''),coalesce(r.parent_table,''),coalesce(r.parent_column,''),r.account_only::text);
 end loop;
end $$;

-- Composite parent FKs prohibit same-user cross-engine forged relationships.
do $$declare r record; begin
 for r in select * from coinops_engine_manifest where parent_table is not null order by ord loop
  if not exists(select 1 from pg_constraint where conrelid=('coinops.'||r.parent_table)::regclass and conname=r.parent_table||'_id_engine_unique') then
   execute format('alter table coinops.%I add constraint %I unique(id,trading_engine_id)',r.parent_table,r.parent_table||'_id_engine_unique');
  end if;
  execute format('alter table coinops.%I add constraint %I foreign key(%I,trading_engine_id) references coinops.%I(id,trading_engine_id) on delete restrict',r.name,r.name||'_parent_engine_fk',r.parent_column,r.parent_table);
 end loop;
end $$;

-- Replace precisely the asset-only unique keys (and the one dependent FK).
do $$declare r record; begin
 for r in select conname from pg_constraint where conrelid='coinops.robot_v1_live_runs'::regclass
   and contype='f' and confrelid='coinops.robot_v1_live_preparations'::regclass loop
  execute format('alter table coinops.robot_v1_live_runs drop constraint %I',r.conname);
 end loop;
 for r in select c.conname,t.relname from pg_constraint c join pg_class t on t.oid=c.conrelid
 join pg_namespace n on n.oid=t.relnamespace where n.nspname='coinops' and c.contype in ('p','u')
 and t.relname in ('robot_v1_configs','robot_v1_live_preparations','robot_v1_live_slot_accounts',
   'robot_v1_real_prepared_slot_accounts','robot_v1_ath_profiles','robot_v1_manual_adjustments','robot_v1_live_fills')
 and (pg_get_constraintdef(c.oid) like '%product_id, tenant_id, user_id, asset%'
   or pg_get_constraintdef(c.oid) like '%product_id, tenant_id, user_id, environment%'
   or (t.relname='robot_v1_manual_adjustments' and pg_get_constraintdef(c.oid) like '%idempotency_key%')
   or (t.relname='robot_v1_live_fills' and pg_get_constraintdef(c.oid)='UNIQUE (symbol, exchange_trade_id)')) loop
  execute format('alter table coinops.%I drop constraint %I',r.relname,r.conname);
 end loop;
end $$;
alter table coinops.robot_v1_configs add unique(trading_engine_id);
alter table coinops.robot_v1_live_preparations add unique(trading_engine_id);
alter table coinops.robot_v1_live_runs add foreign key(trading_engine_id) references coinops.robot_v1_live_preparations(trading_engine_id) on delete restrict;
alter table coinops.robot_v1_live_slot_accounts add primary key(trading_engine_id,slot_number);
alter table coinops.robot_v1_real_prepared_slot_accounts add primary key(trading_engine_id,slot_number);
alter table coinops.robot_v1_ath_profiles add unique(trading_engine_id);
alter table coinops.robot_v1_manual_adjustments add unique(exchange_account_id,trading_engine_id,idempotency_key),add unique(id,trading_engine_id),
 add foreign key(reversal_of,trading_engine_id) references coinops.robot_v1_manual_adjustments(id,trading_engine_id) on delete restrict;
alter table coinops.robot_v1_strategy_decisions add unique(trading_engine_id,decision_id);
-- Expand first: both legacy and engine-aware ON CONFLICT writers remain valid.
-- The separately deployed contract migration removes only the old keys.
alter table coinops.robot_v1_audit_events add unique(trading_engine_id,idempotency_key);
alter table coinops.robot_v1_slots add unique(trading_engine_id,idempotency_key);
alter table coinops.robot_v1_live_alerts add unique(trading_engine_id,alert_key);
alter table coinops.robot_v1_live_runs add unique(trading_engine_id,reset_idempotency_key);
alter table coinops.robot_v1_testnet_runs add unique(trading_engine_id,reset_idempotency_key);
alter table coinops.robot_v1_live_fills add unique(exchange_account_id,symbol,exchange_trade_id);
drop index coinops.robot_v1_one_active_cycle_per_asset_idx;
create unique index robot_v1_one_active_cycle_per_asset_idx on coinops.robot_v1_cycles(trading_engine_id)
 where status in ('STARTING','GRID_ACTIVE','POSITIONS_ACTIVE','RESETTING');
drop index coinops.robot_v1_testnet_one_active_run;
create unique index robot_v1_testnet_one_active_run on coinops.robot_v1_testnet_runs(trading_engine_id) where status in ('ACTIVE','PAUSED');
drop index coinops.robot_v1_live_one_running_cycle;
create unique index robot_v1_live_one_running_cycle on coinops.robot_v1_live_runs(trading_engine_id) where status in ('PREPARING','ACTIVE','PAUSED');

-- The immutable engine relation validates symbol/quote; remove only old
-- single-market CHECK predicates, not ownership, client-ID or money guards.
do $$declare r record; begin
 for r in select c.conname,t.relname from pg_constraint c join pg_class t on t.oid=c.conrelid
 join pg_namespace n on n.oid=t.relnamespace join coinops_engine_manifest m on m.name=t.relname
 where n.nspname='coinops' and c.contype='c'
  and (pg_get_constraintdef(c.oid) like '%symbol%' or pg_get_constraintdef(c.oid) like '%quote_asset%') loop
  execute format('alter table coinops.%I drop constraint %I',r.relname,r.conname);
 end loop;
end $$;

-- Native quote aliases retain a single exact numeric source during rolling
-- deployment. Historical *_brl/*_usdc storage names remain compatibility APIs;
-- their denomination is now ALWAYS the row's immutable quote_asset.
do $$declare r record; new_name text; begin
 for r in select c.table_name,c.column_name,c.data_type from information_schema.columns c
 join coinops_engine_manifest m on m.name=c.table_name
 where c.table_schema='coinops' and c.data_type='numeric'
 and (c.column_name like '%\_brl' escape '\' or c.column_name like '%\_usdc' escape '\') loop
  new_name:=regexp_replace(r.column_name,'_(brl|usdc)$','_quote');
  if not exists(select 1 from information_schema.columns where table_schema='coinops' and table_name=r.table_name and column_name=new_name) then
   execute format('alter table coinops.%I add column %I numeric generated always as (%I) stored',r.table_name,new_name,r.column_name);
  end if;
 end loop;
end $$;

create or replace view coinops.robot_v1_slot_gain_totals with(security_invoker=true) as
select product_id,tenant_id,user_id,environment,asset,slot_number,physical_slot_id,
 coalesce(sum(gain_units),0)::integer lifetime_gain_count,
 coalesce(sum(gain_units) filter(where period_key=to_char(now() at time zone 'America/Campo_Grande','YYYY-MM')),0)::integer monthly_gain_count,
 to_char(now() at time zone 'America/Campo_Grande','YYYY-MM') period_key,'America/Campo_Grande'::text timezone,
 count(*) filter(where evidence_basis in ('SHADOW_CONFIRMED_TP_CLOSE','TESTNET_EXCHANGE_FILL','TESTNET_CREDIT_FALLBACK','REAL_EXCHANGE_FILL'))::integer market_gain_count,
 coalesce(sum(gain_units) filter(where evidence_basis in ('MANUAL_TARGET_GAIN','MANUAL_GAIN_REVERSAL')),0)::integer manual_gain_count,
 count(*) filter(where period_key=to_char(now() at time zone 'America/Campo_Grande','YYYY-MM') and evidence_basis in ('SHADOW_CONFIRMED_TP_CLOSE','TESTNET_EXCHANGE_FILL','TESTNET_CREDIT_FALLBACK','REAL_EXCHANGE_FILL'))::integer monthly_market_gain_count,
 coalesce(sum(gain_units) filter(where period_key=to_char(now() at time zone 'America/Campo_Grande','YYYY-MM') and evidence_basis in ('MANUAL_TARGET_GAIN','MANUAL_GAIN_REVERSAL')),0)::integer monthly_manual_gain_count,
 operator_id,exchange_account_id,trading_engine_id,quote_asset
from coinops.robot_v1_monthly_slot_gains
group by product_id,tenant_id,user_id,environment,asset,slot_number,physical_slot_id,operator_id,exchange_account_id,trading_engine_id,quote_asset;

create function private.coinops_domain_identity_immutable() returns trigger
language plpgsql set search_path='' as $$begin
 if tg_table_name='trading_engines' then
  if (new.id,new.operator_id,new.exchange_account_id,new.environment,new.symbol,new.base_asset,new.quote_asset,new.legacy_compatible,new.ath_reference_symbol)
   is distinct from (old.id,old.operator_id,old.exchange_account_id,old.environment,old.symbol,old.base_asset,old.quote_asset,old.legacy_compatible,old.ath_reference_symbol)
   then raise exception 'COINOPS_ENGINE_IDENTITY_IMMUTABLE'; end if;
 elsif tg_table_name='exchange_accounts' then
  if (new.id,new.operator_id,new.is_legacy_default) is distinct from (old.id,old.operator_id,old.is_legacy_default)
   then raise exception 'COINOPS_ACCOUNT_IDENTITY_IMMUTABLE'; end if;
 else
  if (new.id,new.product_id,new.tenant_id,new.user_id) is distinct from (old.id,old.product_id,old.tenant_id,old.user_id)
   then raise exception 'COINOPS_OPERATOR_IDENTITY_IMMUTABLE'; end if;
 end if;return new;end $$;
revoke all on function private.coinops_domain_identity_immutable() from public,anon,authenticated;
create trigger domain_identity_immutable before update on coinops.operators for each row execute function private.coinops_domain_identity_immutable();
create trigger domain_identity_immutable before update on coinops.exchange_accounts for each row execute function private.coinops_domain_identity_immutable();
create trigger domain_identity_immutable before update on coinops.trading_engines for each row execute function private.coinops_domain_identity_immutable();

create function coinops.sync_legacy_live_quote_cap() returns trigger
language plpgsql set search_path='' as $$begin
 if new.quote_asset<>'BRL' or not exists(select 1 from coinops.exchange_accounts a where a.id=new.exchange_account_id and a.is_legacy_default)
  then raise exception 'COINOPS_LEGACY_CAP_SCOPE_DENIED';end if;
 insert into coinops.account_quote_caps(operator_id,exchange_account_id,quote_asset,hard_cap_quote)
 values(new.operator_id,new.exchange_account_id,'BRL',new.max_total_live_exposure_brl)
 on conflict(exchange_account_id,quote_asset) do update set hard_cap_quote=excluded.hard_cap_quote,updated_at=now();
 return new;end $$;
revoke all on function coinops.sync_legacy_live_quote_cap() from public,anon,authenticated;
grant execute on function coinops.sync_legacy_live_quote_cap() to service_role;
create trigger live_quote_cap_compat after insert or update on coinops.robot_v1_live_global_caps
 for each row execute function coinops.sync_legacy_live_quote_cap();

alter table coinops.robot_v1_live_preparations add constraint robot_v1_live_monthly_target
 check(monthly_target=case asset when 'BTC' then 7 when 'SOL' then 2 end);
alter table coinops.robot_v1_live_orders drop constraint robot_v1_live_orders_client_order_id_check;
alter table coinops.robot_v1_live_orders add constraint robot_v1_live_orders_client_order_id_check
 check(length(client_order_id)<=36 and (client_order_id ~ '^COR1-(BTC|SOL)-[0-9]+-[0-9]+-(BUY|SELL)-[a-f0-9]{14}$'
  or client_order_id ~ '^C2-[a-f0-9]{10}-[0-9]+-(B|S)-[a-f0-9]{14}$'));

-- Administrative onboarding is evidence only. It cannot enable trading and
-- cannot store credentials; application writers must supply sanitized facts.
create table coinops.operator_admin_events(
 id uuid primary key default gen_random_uuid(),operator_id uuid not null,
 exchange_account_id uuid not null,trading_engine_id uuid,
 event_type text not null check(event_type ~ '^[A-Z][A-Z0-9_]{2,79}$'),
 details jsonb not null default '{}' check(jsonb_typeof(details)='object'),
 created_at timestamptz not null default now(),
 foreign key(exchange_account_id,operator_id) references coinops.exchange_accounts(id,operator_id) on delete restrict,
 foreign key(trading_engine_id,operator_id,exchange_account_id) references coinops.trading_engines(id,operator_id,exchange_account_id) on delete restrict
);
create table coinops.account_onboarding_checks(
 id uuid primary key default gen_random_uuid(),operator_id uuid not null,
 exchange_account_id uuid not null,trading_engine_id uuid,
 check_key text not null check(check_key ~ '^[A-Z][A-Z0-9_]{2,79}$'),
 status text not null default 'PENDING' check(status in ('PENDING','PASS','FAIL')),
 evidence jsonb not null default '{}' check(jsonb_typeof(evidence)='object'),
 checked_at timestamptz not null default now(),created_by uuid not null,
 idempotency_key text not null check(length(idempotency_key) between 16 and 150),
 unique(exchange_account_id,idempotency_key),
 foreign key(exchange_account_id,operator_id) references coinops.exchange_accounts(id,operator_id) on delete restrict,
 foreign key(trading_engine_id,operator_id,exchange_account_id) references coinops.trading_engines(id,operator_id,exchange_account_id) on delete restrict
);
create index operator_admin_events_account_created on coinops.operator_admin_events(exchange_account_id,created_at desc);
create index account_onboarding_checks_latest on coinops.account_onboarding_checks(exchange_account_id,trading_engine_id,check_key,checked_at desc);
create function private.coinops_onboarding_append_only() returns trigger language plpgsql set search_path='' as $$begin
 raise exception 'COINOPS_ONBOARDING_AUDIT_IMMUTABLE';end $$;
revoke all on function private.coinops_onboarding_append_only() from public,anon,authenticated;
do $$declare t text;begin
 foreach t in array array['operator_admin_events','account_onboarding_checks'] loop
  execute format('alter table coinops.%I enable row level security',t);
  execute format('alter table coinops.%I force row level security',t);
  execute format('revoke all on coinops.%I from public,anon,authenticated,service_role',t);
  execute format('grant select on coinops.%I to authenticated',t);
  execute format('grant select,insert on coinops.%I to service_role',t);
  execute format('create policy operator_owned on coinops.%I for select to authenticated using(private.coinops_operator_owned(operator_id))',t);
  execute format('create trigger onboarding_append_only before update or delete on coinops.%I for each row execute function private.coinops_onboarding_append_only()',t);
 end loop;
end $$;
create function private.coinops_onboarding_actor() returns trigger language plpgsql set search_path='' as $$begin
 if not exists(select 1 from coinops.operators o where o.id=new.operator_id and o.user_id=new.created_by) then
  raise exception 'COINOPS_ONBOARDING_ACTOR_DENIED';end if;return new;end $$;
revoke all on function private.coinops_onboarding_actor() from public,anon,authenticated;
create trigger onboarding_actor before insert on coinops.account_onboarding_checks for each row execute function private.coinops_onboarding_actor();
create function private.coinops_audit_numeric_engine_config(p_config jsonb) returns jsonb
language sql immutable set search_path='' as $$
 select coalesce(jsonb_object_agg(key,value),'{}'::jsonb)
 from jsonb_each(case when jsonb_typeof(p_config)='object' then p_config else '{}'::jsonb end)
 where key in ('slot_count','initial_capital_quote','gain_rate','normal_spacing_rate','post_ath_spacing_rate','monthly_target')
  and jsonb_typeof(value)='number'
$$;
revoke all on function private.coinops_audit_numeric_engine_config(jsonb) from public,anon,authenticated;
create function private.coinops_audit_operator_settings() returns trigger language plpgsql security definer set search_path='' as $$
declare j jsonb;before_j jsonb;account_id uuid;engine_id uuid;begin
 j:=jsonb_build_object('status',to_jsonb(new)->'status','kill_switch',to_jsonb(new)->'kill_switch',
  'display_name',to_jsonb(new)->'display_name','quote_asset',to_jsonb(new)->'quote_asset',
  'symbol',to_jsonb(new)->'symbol','environment',to_jsonb(new)->'environment',
  'hard_cap_quote',to_jsonb(new)->'hard_cap_quote','ath_reference_symbol',to_jsonb(new)->'ath_reference_symbol',
  'config',private.coinops_audit_numeric_engine_config(to_jsonb(new)->'config'));
 if tg_op='UPDATE' then
  before_j:=jsonb_build_object('status',to_jsonb(old)->'status','kill_switch',to_jsonb(old)->'kill_switch',
   'display_name',to_jsonb(old)->'display_name','quote_asset',to_jsonb(old)->'quote_asset',
   'symbol',to_jsonb(old)->'symbol','environment',to_jsonb(old)->'environment',
   'hard_cap_quote',to_jsonb(old)->'hard_cap_quote','ath_reference_symbol',to_jsonb(old)->'ath_reference_symbol',
   'config',private.coinops_audit_numeric_engine_config(to_jsonb(old)->'config'));
  if before_j=j and (to_jsonb(new)->'config') is not distinct from (to_jsonb(old)->'config')
    and (to_jsonb(new)->'credential_ref') is not distinct from (to_jsonb(old)->'credential_ref')
    and (to_jsonb(new)->'executor_profile') is not distinct from (to_jsonb(old)->'executor_profile') then return new;end if;
 end if;
 account_id:=case when tg_table_name='exchange_accounts' then (to_jsonb(new)->>'id')::uuid else (to_jsonb(new)->>'exchange_account_id')::uuid end;
 engine_id:=case when tg_table_name='trading_engines' then (to_jsonb(new)->>'id')::uuid else null end;
 insert into coinops.operator_admin_events(operator_id,exchange_account_id,trading_engine_id,event_type,details)
 values(new.operator_id,account_id,engine_id,upper(tg_table_name)||'_'||tg_op,
 jsonb_build_object('before',before_j,'after',j,'config_changed',tg_op='UPDATE' and (to_jsonb(new)->'config') is distinct from (to_jsonb(old)->'config'),
  'credential_binding_changed',tg_op='UPDATE' and (to_jsonb(new)->'credential_ref') is distinct from (to_jsonb(old)->'credential_ref'),
  'executor_binding_changed',tg_op='UPDATE' and (to_jsonb(new)->'executor_profile') is distinct from (to_jsonb(old)->'executor_profile')));
 return new;end $$;
revoke all on function private.coinops_audit_operator_settings() from public,anon,authenticated;
create trigger operator_settings_audit after insert or update on coinops.exchange_accounts for each row execute function private.coinops_audit_operator_settings();
create trigger operator_settings_audit after insert or update on coinops.trading_engines for each row execute function private.coinops_audit_operator_settings();
create trigger operator_settings_audit after insert or update on coinops.account_quote_caps for each row execute function private.coinops_audit_operator_settings();

-- RPC DEFINITIONS APPENDED BELOW BEFORE COMMIT.

create or replace function coinops.prepare_robot_v1_live_order(
  p_run_id uuid, p_slot_id uuid, p_side text, p_purpose text,
  p_revision integer, p_client_order_id text, p_quantity numeric,
  p_quote numeric, p_price numeric, p_decision_id text, p_lease_owner uuid
) returns coinops.robot_v1_live_orders language plpgsql
security definer set search_path='' as $$
declare
  v_run coinops.robot_v1_live_runs%rowtype;
  v_slot coinops.robot_v1_live_slots%rowtype;
  v_config coinops.robot_v1_live_preparations%rowtype;
  v_global coinops.account_quote_caps%rowtype;
  v_engine coinops.trading_engines%rowtype;
  v_existing coinops.robot_v1_live_orders%rowtype;
  v_order coinops.robot_v1_live_orders%rowtype;
  v_notional numeric;
  v_asset_exposure numeric;
  v_global_exposure numeric;
  v_accounts integer;
  v_account_balance numeric;
begin
  select * into strict v_run from coinops.robot_v1_live_runs where id=p_run_id for update;
  if (v_run.status <> 'ACTIVE' and not (p_side='SELL' and v_run.status='PAUSED'))
    or p_lease_owner is null
    or v_run.lease_owner is distinct from p_lease_owner
    or v_run.lease_until is null or v_run.lease_until <= now()
    or (v_run.last_error is not null and p_side='BUY') then
    raise exception 'COINOPS_LIVE_LEASE_OR_RUN_BLOCKED';
  end if;
  select * into strict v_engine from coinops.trading_engines where id=v_run.trading_engine_id for share;
  select * into strict v_global from coinops.account_quote_caps
    where exchange_account_id=v_run.exchange_account_id and quote_asset=v_run.quote_asset for update;
  select * into strict v_config from coinops.robot_v1_live_preparations
    where product_id=v_run.product_id and tenant_id=v_run.tenant_id
      and user_id=v_run.user_id and trading_engine_id=v_run.trading_engine_id and asset=v_run.asset for update;
  select * into strict v_slot from coinops.robot_v1_live_slots
    where id=p_slot_id and run_id=p_run_id and product_id=v_run.product_id
      and tenant_id=v_run.tenant_id and user_id=v_run.user_id for update;
  if v_config.symbol<>v_run.symbol or v_config.slot_count<>25
    or v_config.configured_live_capital_brl > least(v_engine.hard_cap_quote,case when v_engine.legacy_compatible then case v_run.asset when 'BTC' then 450 else 275 end else v_engine.hard_cap_quote end)
    or v_config.max_order_notional_brl > (case when v_engine.legacy_compatible then case v_run.asset when 'BTC' then 18 else 11 end else v_engine.hard_cap_quote end)
    or v_config.max_total_exposure_brl > least(v_engine.hard_cap_quote,case when v_engine.legacy_compatible then case v_run.asset when 'BTC' then 450 else 275 end else v_engine.hard_cap_quote end)
    or (v_engine.legacy_compatible and v_global.hard_cap_quote > 725) then
    raise exception 'COINOPS_LIVE_HARD_CAP_INVALID';
  end if;
  select * into v_existing from coinops.robot_v1_live_orders where client_order_id=p_client_order_id;
  if found then
    if (v_existing.run_id,v_existing.slot_id,v_existing.side,v_existing.purpose,
      v_existing.revision,v_existing.requested_quantity,v_existing.requested_quote,
      v_existing.price,v_existing.strategy_decision_id)
      is distinct from (p_run_id,p_slot_id,p_side,p_purpose,p_revision,p_quantity,
        p_quote,p_price,p_decision_id) then
      raise exception 'COINOPS_LIVE_ORDER_IDENTITY_COLLISION';
    end if;
    return v_existing;
  end if;
  if p_revision < 1 or (case when v_engine.legacy_compatible then p_client_order_id !~ ('^COR1-'||v_run.asset||'-'||v_slot.slot_number||'-'||p_revision||'-'||p_side||'-[a-f0-9]{14}$') else p_client_order_id !~ ('^C2-'||substr(encode(sha256(convert_to(v_run.exchange_account_id::text||'|'||v_run.trading_engine_id::text,'UTF8')),'hex'),1,10)||'-'||v_slot.slot_number||'-'||substr(p_side,1,1)||'-[a-f0-9]{14}$') end)
    or p_decision_id !~ '^[a-f0-9]{64}$' or not exists
      (select 1 from coinops.robot_v1_strategy_decisions d where d.environment='REAL'
        and d.cycle_id=p_run_id and d.slot_id=p_slot_id and d.decision_id=p_decision_id
        and d.product_id=v_run.product_id and d.tenant_id=v_run.tenant_id and d.user_id=v_run.user_id)
    or (p_side,p_purpose) not in (('BUY','INITIAL'),('BUY','ENTRY'),('SELL','TP')) then
    raise exception 'COINOPS_LIVE_ORDER_INTENT_INVALID';
  end if;
  if p_purpose='INITIAL' then
    if p_quote is null or p_quote<=0 or p_quantity is not null or p_price is not null
      or v_slot.operation_sequence<>1 or v_slot.operational_rank<>1 then
      raise exception 'COINOPS_LIVE_INITIAL_INTENT_INVALID';
    end if;
    v_notional:=p_quote;
  else
    if p_quantity is null or p_quantity<=0 or p_quote is not null or p_price is null or p_price<=0 then
      raise exception 'COINOPS_LIVE_LIMIT_INTENT_INVALID';
    end if;
    v_notional:=round(p_quantity*p_price,8);
  end if;
  if p_side='BUY' then
    if v_engine.status<>'ACTIVE' or v_engine.kill_switch
      or exists(select 1 from coinops.exchange_accounts a where a.id=v_run.exchange_account_id and (a.status<>'ACTIVE' or a.kill_switch))
      or exists(select 1 from coinops.operators o where o.id=v_run.operator_id and (o.status<>'ACTIVE' or o.kill_switch)) then
      raise exception 'COINOPS_ENGINE_NEW_WRITES_BLOCKED'; end if;
    if not v_config.live_enabled or v_config.kill_switch or v_slot.entry_state<>'PLANNED'
      or v_notional > v_config.max_order_notional_brl
      or exists (select 1 from coinops.robot_v1_live_orders o where o.run_id=p_run_id
        and o.side='BUY' and o.status in ('PREPARED','NEW','PARTIALLY_FILLED')) then
      raise exception 'COINOPS_LIVE_NEW_BUY_BLOCKED';
    end if;
    select count(*),coalesce(sum(contribution_brl),0) into v_accounts,v_account_balance
      from coinops.robot_v1_live_slot_accounts a where a.product_id=v_run.product_id
        and a.tenant_id=v_run.tenant_id and a.user_id=v_run.user_id and a.trading_engine_id=v_run.trading_engine_id and a.asset=v_run.asset;
    if v_accounts<>25 or v_account_balance>v_config.configured_live_capital_brl
      or v_account_balance<=0 or v_notional>
        (select balance_brl from coinops.robot_v1_live_slot_accounts a
          where a.product_id=v_run.product_id and a.tenant_id=v_run.tenant_id
            and a.user_id=v_run.user_id and a.trading_engine_id=v_run.trading_engine_id and a.asset=v_run.asset and a.slot_number=v_slot.slot_number)
      then raise exception 'COINOPS_LIVE_SLOT_CAPITAL_INVALID';
    end if;
    select coalesce(sum(s.position_committed_brl),0) into v_asset_exposure
      from coinops.robot_v1_live_slots s join coinops.robot_v1_live_runs r on r.id=s.run_id
      where r.product_id=v_run.product_id and r.tenant_id=v_run.tenant_id
        and r.user_id=v_run.user_id and r.trading_engine_id=v_run.trading_engine_id and r.asset=v_run.asset and r.status in ('ACTIVE','PAUSED');
    select v_asset_exposure+coalesce(sum(greatest(o.reserved_notional_brl-o.cumulative_quote,0)),0)
      into v_asset_exposure from coinops.robot_v1_live_orders o
      join coinops.robot_v1_live_runs r on r.id=o.run_id
      where r.product_id=v_run.product_id and r.tenant_id=v_run.tenant_id
        and r.user_id=v_run.user_id and r.trading_engine_id=v_run.trading_engine_id and r.asset=v_run.asset and r.status in ('ACTIVE','PAUSED')
        and o.side='BUY' and o.status in ('PREPARED','NEW','PARTIALLY_FILLED');
    select coalesce(sum(s.position_committed_brl),0) into v_global_exposure
      from coinops.robot_v1_live_slots s join coinops.robot_v1_live_runs r on r.id=s.run_id
      where r.product_id=v_run.product_id and r.tenant_id=v_run.tenant_id
        and r.user_id=v_run.user_id and r.exchange_account_id=v_run.exchange_account_id and r.quote_asset=v_run.quote_asset and r.status in ('ACTIVE','PAUSED');
    select v_global_exposure+coalesce(sum(greatest(o.reserved_notional_brl-o.cumulative_quote,0)),0)
      into v_global_exposure from coinops.robot_v1_live_orders o
      join coinops.robot_v1_live_runs r on r.id=o.run_id
      where r.product_id=v_run.product_id and r.tenant_id=v_run.tenant_id
        and r.user_id=v_run.user_id and r.exchange_account_id=v_run.exchange_account_id and r.quote_asset=v_run.quote_asset and r.status in ('ACTIVE','PAUSED')
        and o.side='BUY' and o.status in ('PREPARED','NEW','PARTIALLY_FILLED');
    if v_asset_exposure+v_notional>v_config.max_total_exposure_brl
      or v_global_exposure+v_notional>v_global.hard_cap_quote then
      raise exception 'COINOPS_LIVE_EXPOSURE_CAP_DENIED';
    end if;
  elsif v_slot.position_quantity<=0 or p_quantity>v_slot.position_quantity
    or v_slot.entry_state<>'OPEN' then
    raise exception 'COINOPS_LIVE_TP_POSITION_UNVERIFIED';
  end if;
  insert into coinops.robot_v1_live_orders
    (run_id,slot_id,product_id,tenant_id,user_id,slot_number,operation_sequence,
      side,purpose,revision,client_order_id,requested_quantity,requested_quote,price,
      reserved_notional_brl,strategy_decision_id,config_version,config_snapshot)
  values (v_run.id,v_slot.id,v_run.product_id,v_run.tenant_id,v_run.user_id,v_slot.slot_number,
    v_slot.operation_sequence,p_side,p_purpose,p_revision,p_client_order_id,p_quantity,p_quote,p_price,
    case when p_side='BUY' then v_notional else 0 end,p_decision_id,
    v_run.config_version,v_run.config_snapshot) returning * into v_order;
  return v_order;
end $$;

create or replace function coinops.activate_robot_v1_live_cycle(p_run_id uuid)
returns coinops.robot_v1_live_runs language plpgsql
security definer set search_path='' as $$
declare
  v_run coinops.robot_v1_live_runs%rowtype;
  v_config coinops.robot_v1_live_preparations%rowtype;
  v_global coinops.account_quote_caps%rowtype;
  v_engine coinops.trading_engines%rowtype;
  v_count integer;
  v_contribution numeric;
begin
  select * into strict v_run from coinops.robot_v1_live_runs where id=p_run_id for update;
  select * into strict v_engine from coinops.trading_engines where id=v_run.trading_engine_id for share;
  select * into strict v_global from coinops.account_quote_caps
    where exchange_account_id=v_run.exchange_account_id and quote_asset=v_run.quote_asset for update;
  select * into strict v_config from coinops.robot_v1_live_preparations
    where product_id=v_run.product_id and tenant_id=v_run.tenant_id
      and user_id=v_run.user_id and trading_engine_id=v_run.trading_engine_id and asset=v_run.asset for update;
  if v_engine.status<>'ACTIVE' or v_engine.kill_switch
      or exists(select 1 from coinops.exchange_accounts a where a.id=v_run.exchange_account_id and (a.status<>'ACTIVE' or a.kill_switch))
      or exists(select 1 from coinops.operators o where o.id=v_run.operator_id and (o.status<>'ACTIVE' or o.kill_switch)) then
      raise exception 'COINOPS_ENGINE_NEW_WRITES_BLOCKED'; end if;
  if v_run.status='ACTIVE' and v_config.live_enabled and not v_config.kill_switch then return v_run; end if;
  if v_run.status<>'PREPARING' or v_config.live_enabled or not v_config.kill_switch
    or v_config.slot_count<>25 or v_config.configured_live_capital_brl > least(v_engine.hard_cap_quote,case when v_engine.legacy_compatible then case v_run.asset when 'BTC' then 450 else 275 end else v_engine.hard_cap_quote end)
    or v_config.max_order_notional_brl > (case when v_engine.legacy_compatible then case v_run.asset when 'BTC' then 18 else 11 end else v_engine.hard_cap_quote end)
    or v_config.max_total_exposure_brl > least(v_engine.hard_cap_quote,case when v_engine.legacy_compatible then case v_run.asset when 'BTC' then 450 else 275 end else v_engine.hard_cap_quote end)
    or (v_engine.legacy_compatible and v_global.hard_cap_quote > 725)
    or exists (select 1 from coinops.robot_v1_live_orders where run_id=v_run.id) then
    raise exception 'COINOPS_LIVE_ACTIVATION_GATE_FAILED';
  end if;
  select count(*) into v_count from coinops.robot_v1_live_slots where run_id=v_run.id;
  if v_count<>25 then raise exception 'COINOPS_LIVE_SLOT_COUNT_INVALID'; end if;
  select count(*),coalesce(sum(contribution_brl),0) into v_count,v_contribution
    from coinops.robot_v1_live_slot_accounts where product_id=v_run.product_id
      and tenant_id=v_run.tenant_id and user_id=v_run.user_id and trading_engine_id=v_run.trading_engine_id and asset=v_run.asset
      and balance_brl=contribution_brl and manual_gain_brl=0 and market_pnl_brl=0 and fees_brl=0;
  if v_count<>25 or v_contribution<>v_config.configured_live_capital_brl then
    raise exception 'COINOPS_LIVE_PRINCIPAL_NOT_PROVEN';
  end if;
  update coinops.robot_v1_live_preparations set live_enabled=true,kill_switch=false,
    config_version=config_version+1 where id=v_config.id;
  update coinops.robot_v1_live_runs set status='ACTIVE' where id=v_run.id returning * into v_run;
  insert into coinops.robot_v1_live_events
    (run_id,product_id,tenant_id,user_id,event_key,event_type,details)
  values (v_run.id,v_run.product_id,v_run.tenant_id,v_run.user_id,
    'RUN_ACTIVATED','RUN_ACTIVATED',jsonb_build_object('asset',v_run.asset,
      'capital_brl',v_contribution,'strategy_version',v_run.strategy_version));
  return v_run;
end $$;

create or replace function coinops.sync_robot_v1_live_order(
  p_order_id uuid, p_exchange_order_id text, p_status text,
  p_executed_quantity numeric, p_cumulative_quote numeric, p_trades jsonb,
  p_bnb_brl_price numeric, p_bnb_brl_observed_at timestamptz, p_lease_owner uuid
) returns coinops.robot_v1_live_orders language plpgsql
security definer set search_path='' as $$
declare
  v_order coinops.robot_v1_live_orders%rowtype;
  v_run coinops.robot_v1_live_runs%rowtype;
  v_slot coinops.robot_v1_live_slots%rowtype;
  v_trade jsonb;
  v_previous coinops.robot_v1_live_fills%rowtype;
  v_trade_id text;
  v_qty numeric;
  v_quote numeric;
  v_fee numeric;
  v_fee_asset text;
  v_fee_brl numeric;
  v_filled_at timestamptz;
  v_sum_qty numeric;
  v_sum_quote numeric;
  v_fee_base numeric;
  v_fee_quote numeric;
  v_other_fee numeric;
  v_old_other_fee numeric;
  v_delta_qty numeric;
  v_delta_quote numeric;
  v_delta_base_fee numeric;
  v_delta_other_fee numeric;
begin
  select * into strict v_order from coinops.robot_v1_live_orders where id=p_order_id for update;
  select * into strict v_run from coinops.robot_v1_live_runs where id=v_order.run_id for update;
  select * into strict v_slot from coinops.robot_v1_live_slots where id=v_order.slot_id for update;
  if p_lease_owner is null or v_run.lease_owner is distinct from p_lease_owner
    or v_run.lease_until is null or v_run.lease_until<=now()
    or v_run.status not in ('ACTIVE','PAUSED') then
    raise exception 'COINOPS_LIVE_LEASE_BLOCKED';
  end if;
  if p_exchange_order_id is null or p_exchange_order_id !~ '^[0-9]+$'
    or p_status not in ('NEW','PARTIALLY_FILLED','FILLED','CANCELED','EXPIRED','EXPIRED_IN_MATCH','REJECTED')
    or p_executed_quantity is null or p_cumulative_quote is null
    or p_executed_quantity<0 or p_cumulative_quote<0
    or (p_executed_quantity>0 and p_cumulative_quote<=0)
    or v_order.exchange_order_id is not null and v_order.exchange_order_id<>p_exchange_order_id
    or p_executed_quantity<v_order.executed_quantity
    or p_cumulative_quote<v_order.cumulative_quote
    or v_order.status in ('FILLED','CANCELED','EXPIRED','EXPIRED_IN_MATCH','REJECTED')
      and v_order.status<>p_status
    or jsonb_typeof(p_trades)<>'array' or jsonb_array_length(p_trades)>1000 then
    raise exception 'COINOPS_LIVE_ORDER_SNAPSHOT_INVALID';
  end if;
  select coalesce(sum(commission_brl),0) into v_old_other_fee
    from coinops.robot_v1_live_fills where order_id=v_order.id and commission_asset in ('BNB',v_run.quote_asset);
  for v_trade in select value from jsonb_array_elements(p_trades) as item(value) loop
    v_trade_id:=v_trade->>'id';
    v_qty:=(v_trade->>'quantity')::numeric;
    v_quote:=(v_trade->>'quoteQuantity')::numeric;
    v_fee:=(v_trade->>'commission')::numeric;
    v_fee_asset:=v_trade->>'commissionAsset';
    v_filled_at:=(v_trade->>'filledAt')::timestamptz;
    if v_trade_id !~ '^[0-9]+$' or v_qty<=0 or v_quote<=0 or v_fee<0
      or v_filled_at is null or v_filled_at>now()+interval '10 seconds'
      or v_fee_asset not in (v_run.asset,v_run.quote_asset,'BNB')
      or (v_trade->>'isBuyer')::boolean is distinct from (v_order.side='BUY') then
      raise exception 'COINOPS_LIVE_FILL_INVALID';
    end if;
    if v_fee_asset='BNB' then
      if p_bnb_brl_price is null or p_bnb_brl_price<=0 or p_bnb_brl_observed_at is null
        or abs(extract(epoch from now()-p_bnb_brl_observed_at))>600 then
        raise exception 'COINOPS_LIVE_BNB_FEE_PRICE_STALE';
      end if;
      v_fee_brl:=round(v_fee*p_bnb_brl_price,8);
    elsif v_fee_asset=v_run.quote_asset then v_fee_brl:=round(v_fee,8);
    else v_fee_brl:=round(v_fee*v_quote/v_qty,8);
    end if;
    insert into coinops.robot_v1_live_fills
      (order_id,product_id,tenant_id,user_id,symbol,exchange_trade_id,quantity,
        quote_quantity,commission,commission_asset,commission_brl,fee_fx_source,
        fee_fx_observed_at,filled_at)
    values (v_order.id,v_order.product_id,v_order.tenant_id,v_order.user_id,v_run.symbol,
      v_trade_id,v_qty,v_quote,v_fee,v_fee_asset,v_fee_brl,
      case when v_fee_asset='BNB' then 'BINANCE_SPOT_BNB'||v_run.quote_asset||'_TICKER' else null end,
      case when v_fee_asset='BNB' then p_bnb_brl_observed_at else null end,v_filled_at)
    on conflict (exchange_account_id,symbol,exchange_trade_id) do nothing;
    select * into strict v_previous from coinops.robot_v1_live_fills
      where exchange_account_id=v_run.exchange_account_id and symbol=v_run.symbol and exchange_trade_id=v_trade_id;
    if (v_previous.order_id,v_previous.quantity,v_previous.quote_quantity,
      v_previous.commission,v_previous.commission_asset,v_previous.filled_at)
      is distinct from (v_order.id,v_qty,v_quote,v_fee,v_fee_asset,v_filled_at) then
      raise exception 'COINOPS_LIVE_FILL_IDENTITY_COLLISION';
    end if;
  end loop;
  select coalesce(sum(quantity),0),coalesce(sum(quote_quantity),0),
    coalesce(sum(commission) filter (where commission_asset=v_run.asset),0),
    coalesce(sum(commission) filter (where commission_asset=v_run.quote_asset),0),
    coalesce(sum(commission_brl) filter (where commission_asset in ('BNB',v_run.quote_asset)),0)
    into v_sum_qty,v_sum_quote,v_fee_base,v_fee_quote,v_other_fee
    from coinops.robot_v1_live_fills where order_id=v_order.id;
  if abs(v_sum_qty-p_executed_quantity)>0.000000000001
    or abs(v_sum_quote-p_cumulative_quote)>0.00000001
    or p_status='FILLED' and v_sum_qty<=0 then
    raise exception 'COINOPS_LIVE_TRADE_SNAPSHOT_INCOMPLETE';
  end if;
  v_delta_qty:=v_sum_qty-v_order.executed_quantity;
  v_delta_quote:=v_sum_quote-v_order.cumulative_quote;
  v_delta_base_fee:=v_fee_base-v_order.fee_base;
  v_delta_other_fee:=v_other_fee-v_old_other_fee;
  if v_delta_qty<0 or v_delta_quote<0 or v_delta_base_fee<0 or v_delta_other_fee<0 then
    raise exception 'COINOPS_LIVE_FILL_REGRESSION';
  end if;
  if v_order.side='BUY' then
    update coinops.robot_v1_live_slots set
      position_quantity=position_quantity+v_delta_qty-v_delta_base_fee,
      position_committed_brl=position_committed_brl+v_delta_quote+v_delta_other_fee,
      entry_state=case when v_sum_qty>0 then 'OPEN' else entry_state end
    where id=v_slot.id;
  else
    if v_slot.position_quantity+0.000000000001<v_delta_qty+v_delta_base_fee then
      raise exception 'COINOPS_LIVE_POSITION_OVERSOLD';
    end if;
    update coinops.robot_v1_live_slots set
      position_quantity=greatest(0,position_quantity-v_delta_qty-v_delta_base_fee)
    where id=v_slot.id;
  end if;
  update coinops.robot_v1_live_orders set exchange_order_id=p_exchange_order_id,
    status=p_status,executed_quantity=v_sum_qty,cumulative_quote=v_sum_quote,
    fee_base=v_fee_base,fee_quote=v_fee_quote,
    fee_other=case when v_other_fee>0 then jsonb_build_array(jsonb_build_object('asset','BNB',
      'amount',(select coalesce(sum(commission),0) from coinops.robot_v1_live_fills
        where order_id=v_order.id and commission_asset='BNB')))
      else '[]'::jsonb end,
    trades_reconciled=p_status in ('FILLED','CANCELED','EXPIRED','EXPIRED_IN_MATCH','REJECTED')
  where id=v_order.id returning * into v_order;
  insert into coinops.robot_v1_live_events
    (run_id,product_id,tenant_id,user_id,event_key,event_type,slot_number,details)
  values (v_run.id,v_run.product_id,v_run.tenant_id,v_run.user_id,
    v_order.client_order_id||':'||p_status||':'||v_sum_qty::text,
    'ORDER_OBSERVED',v_order.slot_number,
    jsonb_build_object('client_order_id',v_order.client_order_id,
      'exchange_order_id',p_exchange_order_id,'status',p_status,
      'executed_quantity',v_sum_qty,'cumulative_quote',v_sum_quote))
  on conflict (run_id,event_key) do nothing;
  return v_order;
end $$;

create or replace function coinops.credit_robot_v1_live_closed_slot(
  p_run_id uuid,p_slot_id uuid,p_operation_sequence integer,
  p_tp_client_order_id text,p_quantity_step numeric,p_lease_owner uuid
) returns coinops.robot_v1_live_slot_accounts language plpgsql
security definer set search_path='' as $$
declare
  v_run coinops.robot_v1_live_runs%rowtype;
  v_slot coinops.robot_v1_live_slots%rowtype;
  v_account coinops.robot_v1_live_slot_accounts%rowtype;
  v_tp coinops.robot_v1_live_orders%rowtype;
  v_buy_quantity numeric;
  v_sold_quantity numeric;
  v_buy_quote numeric;
  v_sell_quote numeric;
  v_fee_brl numeric;
  v_dust numeric;
  v_dust_basis numeric;
  v_gross_pnl numeric;
  v_net_pnl numeric;
  v_fill_at timestamptz;
begin
  select * into strict v_run from coinops.robot_v1_live_runs where id=p_run_id for update;
  select * into strict v_slot from coinops.robot_v1_live_slots
    where id=p_slot_id and run_id=p_run_id for update;
  select * into strict v_account from coinops.robot_v1_live_slot_accounts
    where product_id=v_run.product_id and tenant_id=v_run.tenant_id
      and user_id=v_run.user_id and trading_engine_id=v_run.trading_engine_id and asset=v_run.asset and slot_number=v_slot.slot_number for update;
  if v_run.lease_owner is distinct from p_lease_owner or p_lease_owner is null
    or v_run.lease_until is null or v_run.lease_until<=now()
    or p_quantity_step<=0 or p_operation_sequence<>v_slot.operation_sequence then
    raise exception 'COINOPS_LIVE_CREDIT_LEASE_OR_SEQUENCE_INVALID';
  end if;
  if v_slot.last_credited_sell_client_order_id=p_tp_client_order_id then return v_account; end if;
  select * into strict v_tp from coinops.robot_v1_live_orders where run_id=p_run_id
    and slot_id=p_slot_id and operation_sequence=p_operation_sequence
    and client_order_id=p_tp_client_order_id and side='SELL' and purpose='TP';
  if v_tp.status<>'FILLED' or not v_tp.trades_reconciled
    or v_slot.entry_state<>'OPEN' or v_slot.position_quantity>=p_quantity_step
    or exists (select 1 from coinops.robot_v1_live_orders o where o.run_id=p_run_id
      and o.slot_id=p_slot_id and o.operation_sequence=p_operation_sequence
      and (o.status not in ('FILLED','CANCELED','EXPIRED','EXPIRED_IN_MATCH','REJECTED')
        or o.executed_quantity>0 and not o.trades_reconciled)) then
    raise exception 'COINOPS_LIVE_TP_CLOSURE_NOT_PROVEN';
  end if;
  select coalesce(sum(o.executed_quantity-o.fee_base),0),
    coalesce(sum(o.cumulative_quote),0) into v_buy_quantity,v_buy_quote
    from coinops.robot_v1_live_orders o where o.run_id=p_run_id and o.slot_id=p_slot_id
      and o.operation_sequence=p_operation_sequence and o.side='BUY';
  select coalesce(sum(o.executed_quantity+o.fee_base),0),
    coalesce(sum(o.cumulative_quote),0) into v_sold_quantity,v_sell_quote
    from coinops.robot_v1_live_orders o where o.run_id=p_run_id and o.slot_id=p_slot_id
      and o.operation_sequence=p_operation_sequence and o.side='SELL';
  select coalesce(sum(f.commission_brl),0) into v_fee_brl
    from coinops.robot_v1_live_fills f join coinops.robot_v1_live_orders o on o.id=f.order_id
    where o.run_id=p_run_id and o.slot_id=p_slot_id and o.operation_sequence=p_operation_sequence
      and f.commission_asset in ('BNB',v_run.quote_asset);
  select max(f.filled_at) into v_fill_at from coinops.robot_v1_live_fills f where f.order_id=v_tp.id;
  v_dust:=v_buy_quantity-v_sold_quantity;
  if v_buy_quantity<=0 or v_sold_quantity<=0 or v_dust< -0.000000000001
    or v_dust>=p_quantity_step or abs(v_dust-v_slot.position_quantity)>0.000000000001
    or v_fill_at is null then
    raise exception 'COINOPS_LIVE_POSITION_CLOSURE_MISMATCH';
  end if;
  v_dust_basis:=round(v_buy_quote*greatest(v_dust,0)/v_buy_quantity,8);
  v_gross_pnl:=round(v_sell_quote-v_buy_quote+v_dust_basis,8);
  v_net_pnl:=v_gross_pnl-v_fee_brl;
  update coinops.robot_v1_live_slot_accounts set
    balance_brl=balance_brl+v_sell_quote-v_buy_quote-v_fee_brl,
    market_pnl_brl=market_pnl_brl+v_gross_pnl,
    fees_brl=fees_brl+v_fee_brl,
    dust_quantity=dust_quantity+greatest(v_dust,0),
    dust_cost_brl=dust_cost_brl+v_dust_basis,
    gain_count=gain_count+case when v_net_pnl>0 then 1 else 0 end
  where product_id=v_run.product_id and tenant_id=v_run.tenant_id and user_id=v_run.user_id
    and trading_engine_id=v_run.trading_engine_id and asset=v_run.asset and slot_number=v_slot.slot_number returning * into v_account;
  update coinops.robot_v1_live_slots set entry_state='CLOSED',position_quantity=0,
    position_committed_brl=0,last_take_profit_price=v_tp.price,
    last_credited_sell_client_order_id=p_tp_client_order_id where id=v_slot.id;
  insert into coinops.robot_v1_live_events
    (run_id,product_id,tenant_id,user_id,event_key,event_type,slot_number,details)
  values (v_run.id,v_run.product_id,v_run.tenant_id,v_run.user_id,
    p_tp_client_order_id||':CREDITED','SLOT_PROFIT_CREDITED',v_slot.slot_number,
    jsonb_build_object('tp_client_order_id',p_tp_client_order_id,'buy_quote_brl',v_buy_quote,
      'sell_quote_brl',v_sell_quote,'fees_brl',v_fee_brl,'dust_quantity',greatest(v_dust,0),
      'dust_basis_brl',v_dust_basis,'gross_pnl_brl',v_gross_pnl,'net_pnl_brl',v_net_pnl,
      'balance_after_brl',v_account.balance_brl,'gain_count_after',v_account.gain_count));
  if v_net_pnl>0 then
    insert into coinops.robot_v1_monthly_slot_gains
      (environment,source_id,product_id,tenant_id,user_id,asset,slot_number,
        physical_slot_id,credited_at,effective_gain_at,evidence_basis,period_key)
    values ('REAL',v_tp.id,v_run.product_id,v_run.tenant_id,v_run.user_id,v_run.asset,
      v_slot.slot_number,'REAL:'||v_run.product_id||':'||v_run.tenant_id||':'||v_run.user_id
        ||':'||v_run.asset||':'||v_slot.slot_number,now(),v_fill_at,'REAL_EXCHANGE_FILL',
      to_char(v_fill_at at time zone 'America/Campo_Grande','YYYY-MM'));
  end if;
  return v_account;
end $$;

create or replace function coinops.restart_robot_v1_live_cycle(
  p_old_run_id uuid,p_reset_key text,p_anchor_price numeric,p_gain_rate numeric,
  p_entry_spacing numeric,p_regime text,p_config_version integer,p_config_snapshot jsonb,
  p_transition_key text,p_period_key text,p_plans jsonb,p_lease_owner uuid
) returns coinops.robot_v1_live_runs language plpgsql
security definer set search_path='' as $$
declare
  v_old coinops.robot_v1_live_runs%rowtype;
  v_new coinops.robot_v1_live_runs%rowtype;
  v_config coinops.robot_v1_live_preparations%rowtype;
  v_count integer;
  v_total numeric;
  v_number integer;
  v_plan jsonb;
  v_rank integer;
  v_price numeric;
  v_group text;
  v_group_rank integer;
  v_ranks integer[]:='{}';
begin
  select * into strict v_old from coinops.robot_v1_live_runs
    where id=p_old_run_id for update;
  select * into v_new from coinops.robot_v1_live_runs
    where previous_run_id=p_old_run_id and reset_idempotency_key=p_reset_key;
  if found then return v_new; end if;
  select * into strict v_config from coinops.robot_v1_live_preparations
    where product_id=v_old.product_id and tenant_id=v_old.tenant_id
      and user_id=v_old.user_id and trading_engine_id=v_old.trading_engine_id and asset=v_old.asset for update;
  if v_old.status<>'ACTIVE' or v_old.last_error is not null
    or p_lease_owner is null or v_old.lease_owner is distinct from p_lease_owner
    or v_old.lease_until is null or v_old.lease_until<=now()
    or not v_config.live_enabled or v_config.kill_switch
    or p_reset_key is null or length(p_reset_key)<16
    or p_anchor_price is null or p_anchor_price<=0
    or p_gain_rate is null or p_gain_rate<0.001 or p_gain_rate>0.2
    or p_entry_spacing is null or p_entry_spacing<0.001 or p_entry_spacing>0.2
    or p_regime not in ('NORMAL','POST_ATH')
    or p_config_version is null or p_config_version<1
    or jsonb_typeof(p_config_snapshot)<>'object'
    or jsonb_typeof(p_plans)<>'array' or jsonb_array_length(p_plans)<>25
    or p_period_key !~ '^[0-9]{4}-[0-9]{2}$'
    or exists (select 1 from coinops.robot_v1_live_slots
      where run_id=v_old.id and position_quantity>0)
    or exists (select 1 from coinops.robot_v1_live_orders
      where run_id=v_old.id and status in ('PREPARED','NEW','PARTIALLY_FILLED')) then
    raise exception 'COINOPS_LIVE_RESET_GATE_FAILED';
  end if;
  select count(*),coalesce(sum(balance_brl),0) into v_count,v_total
    from coinops.robot_v1_live_slot_accounts
    where product_id=v_old.product_id and tenant_id=v_old.tenant_id
      and user_id=v_old.user_id and trading_engine_id=v_old.trading_engine_id and asset=v_old.asset and balance_brl>0;
  if v_count<>25 or v_total<=0 then raise exception 'COINOPS_LIVE_RESET_BALANCE_INVALID'; end if;
  for v_number in 1..25 loop
    v_plan:=p_plans->(v_number-1);
    if (v_plan->>'slot_number')::integer is distinct from v_number then
      raise exception 'COINOPS_LIVE_RESET_PHYSICAL_SLOT_INVALID';
    end if;
    v_rank:=(v_plan->>'operational_rank')::integer;
    v_price:=(v_plan->>'target_buy_price')::numeric;
    v_group:=v_plan->>'post_ath_group';
    v_group_rank:=(v_plan->>'post_ath_group_rank')::integer;
    if v_price is null or v_price<=0 or v_rank is not null and
      (v_rank<1 or v_rank>25 or v_rank=any(v_ranks))
      or v_group is not null and v_group not in ('PRIMARY','RESERVE')
      or v_group_rank is not null and (v_group is null or v_group_rank<1 or v_group_rank>25) then
      raise exception 'COINOPS_LIVE_RESET_PLAN_INVALID';
    end if;
    if v_rank is not null then v_ranks:=array_append(v_ranks,v_rank); end if;
  end loop;
  update coinops.robot_v1_live_runs set status='COMPLETED',completed_at=now()
    where id=v_old.id;
  insert into coinops.robot_v1_live_runs
    (operator_id,exchange_account_id,trading_engine_id,quote_asset,product_id,tenant_id,user_id,asset,symbol,status,anchor_price,slot_notional_brl,
      gain_rate,entry_spacing,entry_regime,config_version,config_snapshot,strategy_version,
      ath_transition_key,ath_period_key,previous_run_id,reset_idempotency_key)
  values (v_old.operator_id,v_old.exchange_account_id,v_old.trading_engine_id,v_old.quote_asset,v_old.product_id,v_old.tenant_id,v_old.user_id,v_old.asset,v_old.symbol,'ACTIVE',
    p_anchor_price,round(v_total/25,8),p_gain_rate,p_entry_spacing,p_regime,
    p_config_version,p_config_snapshot,v_old.strategy_version,
    p_transition_key,p_period_key,v_old.id,p_reset_key) returning * into v_new;
  for v_number in 1..25 loop
    v_plan:=p_plans->(v_number-1);
    insert into coinops.robot_v1_live_slots
      (run_id,product_id,tenant_id,user_id,slot_number,target_buy_price,
        entry_reference_price,operational_rank,post_ath_group,post_ath_group_rank)
    values (v_new.id,v_new.product_id,v_new.tenant_id,v_new.user_id,v_number,
      (v_plan->>'target_buy_price')::numeric,(v_plan->>'target_buy_price')::numeric,
      (v_plan->>'operational_rank')::integer,v_plan->>'post_ath_group',
      (v_plan->>'post_ath_group_rank')::integer);
  end loop;
  insert into coinops.robot_v1_live_events
    (run_id,product_id,tenant_id,user_id,event_key,event_type,details)
  values (v_new.id,v_new.product_id,v_new.tenant_id,v_new.user_id,
    'RUN_REANCHORED','RUN_REANCHORED',jsonb_build_object('previous_run_id',v_old.id,
      'anchor_price',p_anchor_price,'reset_key',p_reset_key));
  return v_new;
end $$;

create or replace function coinops.restart_robot_v1_testnet_cycle_v2(
  p_old_run_id uuid,p_terminal_fill_client_order_id text,p_anchor_price numeric,p_price_tick numeric,
  p_reset_idempotency_key text,p_recovery_source text,p_reset_started_at timestamptz
) returns table(new_run_id uuid,created boolean)
language plpgsql security definer set search_path='' as $$
declare
  v_old coinops.robot_v1_testnet_runs%rowtype; v_existing coinops.robot_v1_testnet_runs%rowtype;
  v_terminal coinops.robot_v1_testnet_orders%rowtype; v_close coinops.robot_v1_testnet_events%rowtype;
  v_proof jsonb; v_new_id uuid; v_new_capital numeric; v_new_gain numeric; v_new_spacing numeric; v_delta_per_slot numeric;
begin
  if coalesce(nullif(current_setting('request.jwt.claim.role',true),''),nullif(auth.jwt()->>'role',''),'')<>'service_role' then
    raise exception 'COINOPS_TESTNET_SERVICE_ROLE_REQUIRED';
  end if;
  if p_old_run_id is null or p_terminal_fill_client_order_id is null or p_terminal_fill_client_order_id=''
    or p_anchor_price is null or p_price_tick is null or p_anchor_price::text in ('NaN','Infinity','-Infinity')
    or p_price_tick::text in ('NaN','Infinity','-Infinity') or p_anchor_price<=0 or p_price_tick<=0
    or p_reset_idempotency_key is null or p_reset_idempotency_key !~ '^[a-f0-9]{64}$'
    or p_recovery_source is null or p_recovery_source !~ '^[A-Z0-9_]{3,64}$'
    or p_reset_started_at is null or not isfinite(p_reset_started_at) then
    raise exception 'COINOPS_TESTNET_RESET_INPUT_INVALID';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_old_run_id::text,0));
  select * into v_old from coinops.robot_v1_testnet_runs where id=p_old_run_id for update;
  if v_old.id is null then raise exception 'COINOPS_TESTNET_RESET_RUN_INVALID'; end if;
  select * into v_existing from coinops.robot_v1_testnet_runs where previous_run_id=p_old_run_id and reset_idempotency_key=p_reset_idempotency_key;
  if v_existing.id is not null then
    if v_existing.previous_run_id is distinct from p_old_run_id
      or v_existing.terminal_fill_client_order_id is distinct from p_terminal_fill_client_order_id
      or v_existing.anchor_price is distinct from p_anchor_price
      or (v_existing.product_id,v_existing.tenant_id,v_existing.user_id,v_existing.asset)
        is distinct from (v_old.product_id,v_old.tenant_id,v_old.user_id,v_old.asset) then
      raise exception 'COINOPS_TESTNET_RESET_IDEMPOTENCY_CONFLICT';
    end if;
    return query select v_existing.id,false; return;
  end if;
  if v_old.status<>'ACTIVE' or not exists(select 1 from coinops.trading_engines e where e.id=v_old.trading_engine_id and e.environment='TESTNET' and e.symbol=v_old.symbol and e.base_asset=v_old.asset) then
    raise exception 'COINOPS_TESTNET_RESET_RUN_INVALID';
  end if;
  select * into v_terminal from coinops.robot_v1_testnet_orders where run_id=v_old.id
    and client_order_id=p_terminal_fill_client_order_id and side='SELL' and purpose='TP';
  if v_terminal.id is null or v_terminal.status not in ('FILLED','CANCELED','EXPIRED','EXPIRED_IN_MATCH')
    or v_terminal.executed_quantity<=0 then raise exception 'COINOPS_TESTNET_TERMINAL_FILL_REQUIRED'; end if;
  if v_terminal.status<>'FILLED' then
    select * into v_close from coinops.robot_v1_testnet_events where run_id=v_old.id
      and slot_number=v_terminal.slot_number and event_type='SLOT_CLOSED'
      and details->>'operationSequence'=v_terminal.operation_sequence::text
      and details#>>'{execution,closingSellClientOrderId}'=v_terminal.client_order_id
      order by observed_at desc limit 1;
    v_proof:=private.coinops_testnet_operation_closure(v_old.id,v_terminal.slot_id,v_terminal.operation_sequence,
      (v_close.details#>>'{execution,quantityStep}')::numeric);
    if v_close.id is null or (v_proof->>'eligible')::boolean is distinct from true
      or v_proof->>'closing_sell_client_order_id' is distinct from p_terminal_fill_client_order_id then
      raise exception 'COINOPS_TESTNET_TERMINAL_FILL_REQUIRED';
    end if;
  end if;
  if exists(select 1 from coinops.robot_v1_testnet_orders where run_id=v_old.id and status in ('PREPARED','NEW','PARTIALLY_FILLED'))
    or exists(select 1 from coinops.robot_v1_testnet_slots where run_id=v_old.id and entry_state in ('OPEN','ARMED')) then
    raise exception 'COINOPS_TESTNET_ACTIVE_OLD_ORDER';
  end if;
  if (select count(*) from coinops.robot_v1_testnet_slots where run_id=v_old.id)<>25 then
    raise exception 'COINOPS_TESTNET_PLAN_INCOMPLETE';
  end if;
  if not exists(select 1 from coinops.robot_v1_testnet_slots s left join coinops.robot_v1_slot_gain_totals g
    on g.environment='TESTNET' and g.product_id=v_old.product_id and g.tenant_id=v_old.tenant_id
      and g.user_id=v_old.user_id and g.trading_engine_id=v_old.trading_engine_id and g.asset=v_old.asset and g.slot_number=s.slot_number
    where s.run_id=v_old.id and coalesce(g.monthly_gain_count,0)<case when v_old.asset='BTC' then 7 else 2 end) then
    raise exception 'COINOPS_TESTNET_ALL_MONTHLY_TARGETS_REACHED';
  end if;
  v_new_capital:=coalesce(v_old.next_capital_usdc,v_old.slot_notional_usdc*25);
  v_new_gain:=coalesce(v_old.next_gain_rate,v_old.gain_rate);
  v_new_spacing:=coalesce(v_old.next_entry_spacing,v_old.entry_spacing);
  v_delta_per_slot:=v_new_capital/25-v_old.slot_notional_usdc;
  if v_new_capital is null or v_new_capital::text in ('NaN','Infinity','-Infinity') or v_new_capital<=0 or v_new_capital>2500
    or v_new_gain is null or v_new_gain::text in ('NaN','Infinity','-Infinity') or v_new_gain not between 0.001 and 0.20
    or v_new_spacing is null or v_new_spacing::text in ('NaN','Infinity','-Infinity') or v_new_spacing not between 0.001 and 0.20
    or exists(select 1 from coinops.robot_v1_testnet_slots where run_id=v_old.id and (balance_usdc::text in ('NaN','Infinity','-Infinity')
      or balance_usdc+v_delta_per_slot<=0 or balance_usdc+v_delta_per_slot>100
      or floor((p_anchor_price*power((1-v_new_spacing)::numeric,(slot_number-1)::numeric))/p_price_tick)*p_price_tick<=0)) then
    raise exception 'COINOPS_TESTNET_NEXT_PROFILE_INVALID';
  end if;
  update coinops.robot_v1_testnet_runs set status='COMPLETED',completed_at=now(),completion_reason='LAST_OPEN_TP_FILLED',
    terminal_fill_client_order_id=p_terminal_fill_client_order_id,reset_started_at=p_reset_started_at,recovery_source=p_recovery_source where id=v_old.id;
  insert into coinops.robot_v1_testnet_runs(operator_id,exchange_account_id,trading_engine_id,quote_asset,product_id,tenant_id,user_id,asset,symbol,anchor_price,slot_notional_usdc,
    gain_rate,entry_spacing,previous_run_id,terminal_fill_client_order_id,reset_idempotency_key,reset_started_at,recovery_source)
  values(v_old.operator_id,v_old.exchange_account_id,v_old.trading_engine_id,v_old.quote_asset,v_old.product_id,v_old.tenant_id,v_old.user_id,v_old.asset,v_old.symbol,p_anchor_price,v_new_capital/25,v_new_gain,v_new_spacing,
    v_old.id,p_terminal_fill_client_order_id,p_reset_idempotency_key,p_reset_started_at,p_recovery_source) returning id into v_new_id;
  insert into coinops.robot_v1_testnet_slots(run_id,product_id,tenant_id,user_id,slot_number,entry_state,
    target_buy_price,balance_usdc,gain_count,net_profit_usdc,operation_sequence,entry_origin,entry_reference_price)
  select v_new_id,s.product_id,s.tenant_id,s.user_id,s.slot_number,'PLANNED',
    floor((p_anchor_price*power((1-v_new_spacing)::numeric,(s.slot_number-1)::numeric))/p_price_tick)*p_price_tick,
    s.balance_usdc+v_delta_per_slot,0,0,1,'GRID',
    floor((p_anchor_price*power((1-v_new_spacing)::numeric,(s.slot_number-1)::numeric))/p_price_tick)*p_price_tick
  from coinops.robot_v1_testnet_slots s where s.run_id=v_old.id order by s.slot_number;
  insert into coinops.robot_v1_testnet_events(run_id,product_id,tenant_id,user_id,event_key,event_type,details) values
    (v_old.id,v_old.product_id,v_old.tenant_id,v_old.user_id,'CYCLE_COMPLETED:'||p_reset_idempotency_key,'CYCLE_COMPLETED',
      jsonb_build_object('reason','LAST_OPEN_TP_FILLED','terminalFillClientOrderId',p_terminal_fill_client_order_id,
        'nextRunId',v_new_id,'reset_after_last_tp',true,'recovery_source',p_recovery_source)),
    (v_new_id,v_old.product_id,v_old.tenant_id,v_old.user_id,'NEW_CYCLE_STARTED:'||p_reset_idempotency_key,'NEW_CYCLE_STARTED',
      jsonb_build_object('previousRunId',v_old.id,'anchorPrice',p_anchor_price,'new_cycle_started',true,
        'recovery_source',p_recovery_source,'profile',case when v_new_gain=0.005 and v_new_spacing=0.01 then 'TEST_PROFILE' else 'CUSTOM_TEST' end));
  return query select v_new_id,true;
end $$;

create or replace function coinops.restart_robot_v1_testnet_cycle(
 p_old_run_id uuid,p_terminal_fill_client_order_id text,p_anchor_price numeric,p_price_tick numeric,
 p_reset_idempotency_key text,p_recovery_source text,p_reset_started_at timestamptz
) returns table(new_run_id uuid,created boolean) language plpgsql security definer set search_path='' as $$begin
 if not exists(select 1 from coinops.robot_v1_testnet_runs r
   join coinops.trading_engines e on e.id=r.trading_engine_id
   join coinops.exchange_accounts a on a.id=e.exchange_account_id
   where r.id=p_old_run_id and e.legacy_compatible and a.is_legacy_default) then
   raise exception 'COINOPS_LEGACY_ENGINE_REQUIRED';end if;
 return query select * from coinops.restart_robot_v1_testnet_cycle_v2(p_old_run_id,p_terminal_fill_client_order_id,
   p_anchor_price,p_price_tick,p_reset_idempotency_key,p_recovery_source,p_reset_started_at);
end $$;

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
      and gain.trading_engine_id = v_run.trading_engine_id and gain.asset = v_run.asset and gain.slot_number = slot.slot_number
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

create or replace function coinops.apply_robot_v1_manual_adjustment(
  p_product_id uuid, p_tenant_id uuid, p_user_id uuid, p_created_by uuid,
  p_environment text, p_asset text, p_slot_number integer, p_kind text,
  p_gain_units integer, p_currency text, p_original_amount numeric,
  p_fx_rate numeric, p_fx_source text, p_fx_observed_at timestamptz,
  p_reason text, p_note text, p_reversal_of uuid, p_idempotency_key text,
  p_expected_balance numeric, p_expected_lifetime integer, p_expected_monthly integer, p_trading_engine_id uuid
) returns coinops.robot_v1_manual_adjustments
language plpgsql security definer set search_path = '' as $$
declare
  v_engine coinops.trading_engines%rowtype;
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
  v_remaining_quantity numeric(28,12);
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
  if p_trading_engine_id is null then raise exception 'COINOPS_ENGINE_SCOPE_DENIED'; end if;
  v_engine:=private.coinops_resolve_engine(p_product_id,p_tenant_id,p_user_id,p_environment,p_asset,p_trading_engine_id,null);
  if p_environment='REAL' or v_engine.quote_asset not in ('USDC','USDT') then raise exception 'COINOPS_REAL_BRL_ADJUSTMENT_NOT_ENABLED'; end if;
  v_fingerprint := md5(pg_catalog.jsonb_build_object('environment',p_environment,'asset',p_asset,
    'slot',p_slot_number,'kind',p_kind,'gain_units',p_gain_units,'currency',p_currency,
    'amount',p_original_amount,'fx_rate',p_fx_rate,'fx_source',p_fx_source,
    'fx_at',p_fx_observed_at,'reason',btrim(p_reason),'note',nullif(btrim(coalesce(p_note,'')),''),
    'reversal_of',p_reversal_of)::text);
  if not v_engine.legacy_compatible then v_fingerprint:=md5(v_engine.id::text||':'||v_fingerprint); end if;
  select * into v_existing from coinops.robot_v1_manual_adjustments
    where product_id=p_product_id and tenant_id=p_tenant_id and user_id=p_user_id and trading_engine_id=v_engine.id
      and idempotency_key=p_idempotency_key;
  if found then
    if v_existing.request_fingerprint <> v_fingerprint then raise exception 'COINOPS_ADJUSTMENT_IDEMPOTENCY_CONFLICT'; end if;
    return v_existing;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_product_id::text || ':' || p_tenant_id::text || ':' || p_user_id::text || ':' || v_engine.id::text || ':' || p_slot_number, 0));
  select * into v_existing from coinops.robot_v1_manual_adjustments
    where product_id=p_product_id and tenant_id=p_tenant_id and user_id=p_user_id and trading_engine_id=v_engine.id
      and idempotency_key=p_idempotency_key;
  if found then
    if v_existing.request_fingerprint <> v_fingerprint then raise exception 'COINOPS_ADJUSTMENT_IDEMPOTENCY_CONFLICT'; end if;
    return v_existing;
  end if;
  if p_environment = 'SHADOW' then
    select * into strict v_config from coinops.robot_v1_configs
      where product_id=p_product_id and tenant_id=p_tenant_id and user_id=p_user_id and trading_engine_id=v_engine.id
        and asset=p_asset and execution_mode='SHADOW' for update;
    if v_config.strategy_lease_until > v_at then raise exception 'COINOPS_ADJUSTMENT_ENGINE_BUSY'; end if;
    select * into strict v_account from coinops.robot_v1_slot_accounts
      where config_id=v_config.id and slot_number=p_slot_number
        and product_id=p_product_id and tenant_id=p_tenant_id and user_id=p_user_id and trading_engine_id=v_engine.id for update;
    v_balance := v_account.balance_usdc;
    v_physical := 'SHADOW:' || v_config.id::text || ':' || p_slot_number;
    select s.status in ('OPEN','TP_ACTIVE','PARTIALLY_FILLED') and s.executed_quantity>0, round(s.buy_price * s.executed_quantity,8)
      into v_open,v_committed from coinops.robot_v1_slots s
      join coinops.robot_v1_cycles cy on cy.id=s.cycle_id and cy.config_id=v_config.id
      where s.slot_number=p_slot_number and cy.status in ('STARTING','GRID_ACTIVE','POSITIONS_ACTIVE','RESETTING')
      order by cy.started_at desc limit 1;
  elsif p_environment = 'TESTNET' then
    select * into strict v_run from coinops.robot_v1_testnet_runs
      where product_id=p_product_id and tenant_id=p_tenant_id and user_id=p_user_id and trading_engine_id=v_engine.id
        and asset=p_asset and status='ACTIVE' for update;
    if v_run.lease_until > v_at then raise exception 'COINOPS_ADJUSTMENT_ENGINE_BUSY'; end if;
    select * into strict v_test_slot from coinops.robot_v1_testnet_slots
      where run_id=v_run.id and slot_number=p_slot_number
        and product_id=p_product_id and tenant_id=p_tenant_id and user_id=p_user_id and trading_engine_id=v_engine.id for update;
    v_balance := v_test_slot.balance_usdc;
    v_physical := 'TESTNET:' || p_product_id::text || ':' || p_tenant_id::text || ':' || p_user_id::text || ':' || p_asset || ':' || p_slot_number;
    select round(coalesce(sum(o.cumulative_quote) filter(where o.side='BUY'),0),8),
      coalesce(sum(case when o.side='BUY' then o.executed_quantity else -o.executed_quantity end-o.fee_base),0)
      into v_committed,v_remaining_quantity from coinops.robot_v1_testnet_orders o
      where o.run_id=v_run.id and o.slot_id=v_test_slot.id and o.operation_sequence=v_test_slot.operation_sequence;
    if v_remaining_quantity::text in ('NaN','Infinity','-Infinity') or v_remaining_quantity < -0.0000000001 then
      raise exception 'COINOPS_ADJUSTMENT_POSITION_UNAVAILABLE';
    end if;
    v_open := v_remaining_quantity > 0.0000000001;
    if not v_open then v_committed:=null; end if;
  else
    select * into strict v_profile from coinops.robot_v1_ath_profiles
      where product_id=p_product_id and tenant_id=p_tenant_id and user_id=p_user_id and trading_engine_id=v_engine.id
        and asset=p_asset and environment='REAL' for update;
    insert into coinops.robot_v1_real_prepared_slot_accounts
      (product_id,tenant_id,user_id,asset,slot_number)
      values (p_product_id,p_tenant_id,p_user_id,p_asset,p_slot_number)
      on conflict (trading_engine_id,slot_number) do nothing;
    select * into strict v_real from coinops.robot_v1_real_prepared_slot_accounts
      where product_id=p_product_id and tenant_id=p_tenant_id and user_id=p_user_id and trading_engine_id=v_engine.id
        and asset=p_asset and slot_number=p_slot_number for update;
    v_balance := v_real.balance_usdc;
    v_physical := 'REAL:' || p_product_id::text || ':' || p_tenant_id::text || ':' || p_user_id::text || ':' || p_asset || ':' || p_slot_number;
  end if;
  if v_balance::text in ('NaN','Infinity','-Infinity') then
    raise exception 'COINOPS_ADJUSTMENT_BALANCE_INVALID';
  end if;
  if v_open and (v_committed is null or v_committed<=0
    or v_committed::text in ('NaN','Infinity','-Infinity')) then
    raise exception 'COINOPS_ADJUSTMENT_POSITION_UNAVAILABLE';
  end if;
  -- Persist the effective ATH/profile version for every environment. A
  -- concurrent profile edit must not produce ambiguous adjustment metadata.
  select * into strict v_profile from coinops.robot_v1_ath_profiles
    where product_id=p_product_id and tenant_id=p_tenant_id and user_id=p_user_id and trading_engine_id=v_engine.id
      and asset=p_asset and environment=p_environment for share;
  v_current_period := to_char(v_at at time zone 'America/Campo_Grande','YYYY-MM');
  select coalesce(sum(gain_units),0)::integer,
    coalesce(sum(gain_units) filter (where period_key=v_current_period),0)::integer
    into v_lifetime,v_monthly from coinops.robot_v1_monthly_slot_gains
    where product_id=p_product_id and tenant_id=p_tenant_id and user_id=p_user_id and trading_engine_id=v_engine.id
      and environment=p_environment and asset=p_asset and slot_number=p_slot_number;
  if v_balance is distinct from p_expected_balance or v_lifetime is distinct from p_expected_lifetime
    or v_monthly is distinct from p_expected_monthly then
    raise exception 'COINOPS_ADJUSTMENT_PREVIEW_STALE';
  end if;
  if p_kind='REVERSAL' then
    select * into strict v_original from coinops.robot_v1_manual_adjustments
      where id=p_reversal_of and product_id=p_product_id and tenant_id=p_tenant_id and user_id=p_user_id and trading_engine_id=v_engine.id
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
        where product_id=p_product_id and tenant_id=p_tenant_id and user_id=p_user_id and trading_engine_id=v_engine.id
          and environment=p_environment and asset=p_asset and slot_number=p_slot_number
          and period_key=v_period;
    end if;
  else
    if p_reversal_of is not null or p_gain_units is null or p_currency is null or p_currency not in ('USD','BRL')
      or p_original_amount is null or p_original_amount::text in ('NaN','Infinity','-Infinity') or p_original_amount <= 0 or p_original_amount > 1000000
      or p_original_amount <> round(p_original_amount,8)
      or (p_kind='MANUAL_TARGET_GAIN' and (p_gain_units not between 1 and 25 or p_currency<>'USD' or p_original_amount>100000))
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
      if p_kind<>'MANUAL_CONTRIBUTION' or v_fx_source is distinct from ('BINANCE_SPOT_'||v_engine.quote_asset||'BRL_ASK')
        or v_fx_rate is null or v_fx_rate::text in ('NaN','Infinity','-Infinity') or v_fx_rate<=0 or v_fx_at is null
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
    (operator_id,exchange_account_id,trading_engine_id,quote_asset,product_id,tenant_id,user_id,created_by,environment,asset,slot_number,physical_slot_id,
      kind,gain_units,currency,original_amount,fx_rate,fx_source,fx_observed_at,converted_amount_usdc,
      balance_before_usdc,balance_after_usdc,monthly_before,monthly_after,lifetime_before,lifetime_after,
      period_key,open_position_at_time,position_committed_notional_usdc,reason,note,reversal_of,
      idempotency_key,request_fingerprint,strategy_version,config_version)
  values (v_engine.operator_id,v_engine.exchange_account_id,v_engine.id,v_engine.quote_asset,p_product_id,p_tenant_id,p_user_id,p_created_by,p_environment,p_asset,p_slot_number,v_physical,
    p_kind,v_gain_units,v_currency,v_original_amount,v_fx_rate,v_fx_source,v_fx_at,v_delta,
    v_balance,v_balance+v_delta,v_monthly,v_monthly+v_gain_units,
    v_lifetime,v_lifetime+v_gain_units,v_period,coalesce(v_open,false),v_committed,
    btrim(p_reason),nullif(btrim(coalesce(p_note,'')),''),p_reversal_of,
    p_idempotency_key,v_fingerprint,
    case when p_environment='SHADOW' then coalesce(v_config.strategy_version,'4.3.1')
      when p_environment='TESTNET' then coalesce(v_run.strategy_version,'4.3.1')
      else '4.3.1' end,v_profile.config_version)
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
      where product_id=p_product_id and tenant_id=p_tenant_id and user_id=p_user_id and trading_engine_id=v_engine.id
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

revoke all on function coinops.apply_robot_v1_manual_adjustment(uuid,uuid,uuid,uuid,text,text,integer,text,integer,text,numeric,numeric,text,timestamptz,text,text,uuid,text,numeric,integer,integer,uuid) from public,anon,authenticated;
grant execute on function coinops.apply_robot_v1_manual_adjustment(uuid,uuid,uuid,uuid,text,text,integer,text,integer,text,numeric,numeric,text,timestamptz,text,text,uuid,text,numeric,integer,integer,uuid) to service_role;

create or replace function coinops.apply_robot_v1_manual_adjustment(
  p_product_id uuid, p_tenant_id uuid, p_user_id uuid, p_created_by uuid,
  p_environment text, p_asset text, p_slot_number integer, p_kind text,
  p_gain_units integer, p_currency text, p_original_amount numeric,
  p_fx_rate numeric, p_fx_source text, p_fx_observed_at timestamptz,
  p_reason text, p_note text, p_reversal_of uuid, p_idempotency_key text,
  p_expected_balance numeric, p_expected_lifetime integer, p_expected_monthly integer
) returns coinops.robot_v1_manual_adjustments
language plpgsql security definer set search_path = '' as $$
declare e coinops.trading_engines%rowtype; begin
 e:=private.coinops_resolve_engine(p_product_id,p_tenant_id,p_user_id,p_environment,p_asset,null,null);
 return coinops.apply_robot_v1_manual_adjustment(p_product_id,p_tenant_id,p_user_id,p_created_by,
  p_environment,p_asset,p_slot_number,p_kind,p_gain_units,p_currency,p_original_amount,
  p_fx_rate,p_fx_source,p_fx_observed_at,p_reason,p_note,p_reversal_of,p_idempotency_key,
  p_expected_balance,p_expected_lifetime,p_expected_monthly,e.id);
end $$;

create or replace function coinops.audit_robot_v1_live_preparation() returns trigger language plpgsql
security invoker set search_path = '' as $$
begin
  insert into coinops.robot_v1_live_preparation_events
    (operator_id,exchange_account_id,trading_engine_id,quote_asset,product_id,tenant_id,user_id,asset,config_version,event_type,snapshot)
  values (new.operator_id,new.exchange_account_id,new.trading_engine_id,new.quote_asset,new.product_id,new.tenant_id,new.user_id,
    case when tg_table_name = 'robot_v1_live_preparations' then new.asset else null end,
    new.config_version,case when tg_op = 'INSERT' then 'SEEDED' else 'UPDATED' end,
    to_jsonb(new) - 'created_at' - 'updated_at');
  return new;
end $$;

commit;
