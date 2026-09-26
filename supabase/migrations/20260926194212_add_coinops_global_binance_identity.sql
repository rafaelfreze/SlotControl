-- Physical Binance ownership is global across shards, separate from ledger.
-- Hashes come only from the authenticated executor, never a browser payload.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '60s';
create table coinops.binance_account_identity_bindings (
  exchange_account_id uuid not null references coinops.exchange_accounts(id) on delete restrict,
  operator_id uuid not null references coinops.operators(id) on delete restrict,
  environment text not null check(environment in ('REAL','TESTNET')),
  identity_hash text not null check(identity_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  primary key(exchange_account_id,environment),
  foreign key(exchange_account_id,operator_id)
    references coinops.exchange_accounts(id,operator_id) on delete restrict,
  unique(environment,identity_hash)
);
alter table coinops.binance_account_identity_bindings enable row level security;
alter table coinops.binance_account_identity_bindings force row level security;
revoke all on coinops.binance_account_identity_bindings from public,anon,authenticated;
grant select,insert on coinops.binance_account_identity_bindings to service_role;

create function coinops.claim_binance_account_identity(p_operator_id uuid,p_account_id uuid,
  p_environment text,p_identity_hash text) returns text
language plpgsql security invoker set search_path='' as $$
declare
  v_account coinops.exchange_accounts%rowtype;
  v_binding coinops.binance_account_identity_bindings%rowtype;
begin
  if p_operator_id is null or p_account_id is null or p_environment is null
    or p_environment not in ('REAL','TESTNET') or p_identity_hash is null
    or p_identity_hash !~ '^[0-9a-f]{64}$' then return 'COINOPS_BINANCE_IDENTITY_REQUIRED'; end if;
  select * into v_account from coinops.exchange_accounts
    where id=p_account_id and operator_id=p_operator_id;
  if not found or v_account.onboarding_environment is not null
    and v_account.onboarding_environment<>p_environment then return 'COINOPS_ADMIN_ACCOUNT_DENIED'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'coinops-binance-identity:'||p_environment||':'||p_identity_hash,0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'coinops-binance-account:'||p_account_id::text,0));
  select * into v_binding from coinops.binance_account_identity_bindings
    where exchange_account_id=p_account_id and environment=p_environment;
  if found then
    if v_binding.operator_id=p_operator_id and v_binding.environment=p_environment
      and v_binding.identity_hash=p_identity_hash then return 'BOUND'; end if;
    return 'COINOPS_BINANCE_IDENTITY_CHANGED';
  end if;
  if exists(select 1 from coinops.binance_account_identity_bindings
    where environment=p_environment and identity_hash=p_identity_hash) then
    return 'COINOPS_BINANCE_ACCOUNT_ALREADY_BOUND';
  end if;
  insert into coinops.binance_account_identity_bindings(exchange_account_id,operator_id,environment,identity_hash)
    values(p_account_id,p_operator_id,p_environment,p_identity_hash);
  return 'BOUND';
end $$;
revoke all on function coinops.claim_binance_account_identity(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function coinops.claim_binance_account_identity(uuid,uuid,text,text) to service_role;

-- Identity is retained on credential removal; replacing keys does not transfer
-- physical account ownership. Any future migration needs an explicit procedure.
create function private.coinops_binance_identity_immutable() returns trigger
language plpgsql set search_path='' as $$
begin
  raise exception 'COINOPS_BINANCE_IDENTITY_IMMUTABLE';
end $$;
revoke all on function private.coinops_binance_identity_immutable() from public,anon,authenticated;
create trigger binance_account_identity_immutable before update or delete
  on coinops.binance_account_identity_bindings for each row
  execute function private.coinops_binance_identity_immutable();
commit;
