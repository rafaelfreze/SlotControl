-- Explicit move of an INACTIVE account that has NEVER submitted an order.
-- Source registry retirement is performed through its existing preparation-only
-- endpoint before commit. No credential, engine, run, slot, order or fill moves.
begin;
set local lock_timeout='3s';
set local statement_timeout='60s';
create table private.coinops_staged_shard_move_capabilities(
  account_id uuid primary key, from_shard text not null, to_shard text not null,
  transaction_id bigint not null
);
revoke all on private.coinops_staged_shard_move_capabilities from public,anon,authenticated,service_role;

create or replace function private.coinops_primary_shard_immutable() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.executor_shard_id is distinct from old.executor_shard_id and not (
    old.status='INACTIVE' and old.kill_switch and not old.is_legacy_default
    and new.status=old.status and new.kill_switch=old.kill_switch
    and new.operator_id=old.operator_id and new.credential_ref is not distinct from old.credential_ref
    and exists(select 1 from private.coinops_staged_shard_move_capabilities c
      where c.account_id=old.id and c.from_shard=old.executor_shard_id
        and c.to_shard=new.executor_shard_id and c.transaction_id=pg_catalog.txid_current())) then
    raise exception 'COINOPS_SHARD_REASSIGNMENT_FORBIDDEN';
  end if;
  if old.onboarding_environment is not null
    and new.onboarding_environment is distinct from old.onboarding_environment then
    raise exception 'COINOPS_ADMIN_ENVIRONMENT_MISMATCH';
  end if;
  return new;
end $$;
revoke all on function private.coinops_primary_shard_immutable() from public,anon,authenticated;

create function coinops.reassign_staged_executor_shard(p_operator_id uuid,p_account_id uuid,
  p_from_shard text,p_to_shard text,p_request_id uuid,p_preview boolean,p_origin_retired boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_account coinops.exchange_accounts%rowtype;
  v_operator coinops.operators%rowtype;
  v_shard coinops.executor_shards%rowtype;
  v_sample coinops.executor_capacity_samples%rowtype;
  v_count integer; v_reserved numeric; v_weight numeric;
begin
  if p_operator_id is null or p_account_id is null or p_request_id is null
    or p_preview is null or p_origin_retired is null or p_from_shard is null or p_to_shard is null
    or p_from_shard=p_to_shard then raise exception 'COINOPS_STAGED_REASSIGNMENT_INVALID'; end if;
  select * into v_operator from coinops.operators where id=p_operator_id and status='ACTIVE';
  if not found then raise exception 'COINOPS_ADMIN_OPERATOR_DENIED'; end if;
  select * into v_account from coinops.exchange_accounts where id=p_account_id for update;
  if not found or v_account.operator_id<>p_operator_id or v_account.is_legacy_default then
    raise exception 'COINOPS_ADMIN_ACCOUNT_DENIED'; end if;
  if v_account.executor_shard_id=p_to_shard and exists(
    select 1 from coinops.account_onboarding_checks where exchange_account_id=p_account_id
      and check_key='EXECUTOR_REASSIGNMENT' and status='PASS'
      and evidence->>'from_shard'=p_from_shard and evidence->>'to_shard'=p_to_shard) then
    return jsonb_build_object('code','REASSIGNED','shardId',p_to_shard,'replayed',true);
  end if;
  if v_account.executor_shard_id<>p_from_shard or v_account.status<>'INACTIVE'
    or not v_account.kill_switch then raise exception 'COINOPS_STAGED_REASSIGNMENT_DENIED'; end if;
  perform id from coinops.trading_engines where exchange_account_id=p_account_id order by id for update;
  if exists(select 1 from coinops.trading_engines where exchange_account_id=p_account_id
    and (status<>'INACTIVE' or not kill_switch or environment<>'REAL')) then
    raise exception 'COINOPS_STAGED_REASSIGNMENT_DENIED'; end if;
  perform id from coinops.robot_v1_live_runs where exchange_account_id=p_account_id order by id for update;
  if exists(select 1 from coinops.robot_v1_live_runs where exchange_account_id=p_account_id
    and (status<>'PREPARING' or lease_until>now()))
    or exists(select 1 from coinops.robot_v1_testnet_runs where exchange_account_id=p_account_id)
    or exists(select 1 from coinops.robot_v1_live_orders where exchange_account_id=p_account_id)
    or exists(select 1 from coinops.robot_v1_live_fills where exchange_account_id=p_account_id)
    or exists(select 1 from coinops.robot_v1_live_slots where exchange_account_id=p_account_id
      and (entry_state<>'PLANNED' or position_quantity<>0 or position_committed_brl<>0
        or last_credited_sell_client_order_id is not null or operation_sequence<>1
        or last_take_profit_price is not null))
    or exists(select 1 from coinops.executor_capacity_admissions c join coinops.trading_engines e on e.id=c.engine_id
      where e.exchange_account_id=p_account_id and c.expires_at>now()) then
    raise exception 'COINOPS_STAGED_REASSIGNMENT_TRADING_HISTORY'; end if;
  select * into v_shard from coinops.executor_shards where id=p_to_shard and enabled for update;
  if not found then raise exception 'COINOPS_CAPACITY_UNKNOWN'; end if;
  select * into v_sample from coinops.executor_capacity_samples where shard_id=p_to_shard;
  if not found or v_sample.observed_at not between now()-interval '120 seconds' and now()+interval '10 seconds'
    or v_sample.heartbeat_at not between now()-interval '120 seconds' and now()+interval '10 seconds'
    or v_sample.weight_observed_at is null
    or v_sample.weight_observed_at not between now()-interval '120 seconds' and now()+interval '10 seconds'
    or not v_sample.registry_match or v_sample.binance_weight_samples<2
    or v_sample.cpu_percent is null or v_sample.cpu_percent<0 or v_sample.cpu_percent>100
    or v_sample.ram_used_mb is null or v_sample.ram_used_mb<0 or v_sample.ram_limit_mb is null or v_sample.ram_limit_mb<=0
    or v_sample.binance_weight_current is null or v_sample.binance_weight_average is null or v_sample.binance_weight_peak is null
    or least(v_sample.binance_weight_current,v_sample.binance_weight_average,v_sample.binance_weight_peak)<0 then
    raise exception 'COINOPS_CAPACITY_UNKNOWN'; end if;
  select greatest(count(*),1) into v_count from coinops.trading_engines where exchange_account_id=p_account_id;
  select coalesce(sum(c.reserved_weight),0) into v_reserved from coinops.executor_capacity_admissions c
    join coinops.trading_engines e on e.id=c.engine_id
    where c.shard_id=p_to_shard and c.expires_at>now() and e.environment='REAL';
  v_weight:=greatest(v_sample.binance_weight_current,v_sample.binance_weight_average,v_sample.binance_weight_peak);
  if v_weight>=v_shard.binance_limit_per_min*.50 or v_sample.cpu_percent>=70
    or v_sample.ram_used_mb/v_sample.ram_limit_mb>=.75 or v_sample.scheduler_backlog>0
    or v_sample.reconciliation_p95_ms>=120000
    or v_weight+v_reserved+v_count*v_shard.incremental_engine_weight>v_shard.binance_limit_per_min*v_shard.admission_ratio
    then raise exception 'COINOPS_CAPACITY_REQUIRED'; end if;
  if p_preview then return jsonb_build_object('code','READY_TO_REASSIGN','shardId',p_to_shard,
    'executorIp',host(v_shard.egress_ipv4),'engineCount',v_count); end if;
  if not p_origin_retired then raise exception 'COINOPS_SOURCE_REGISTRY_RETIREMENT_REQUIRED'; end if;
  insert into private.coinops_staged_shard_move_capabilities values(p_account_id,p_from_shard,p_to_shard,pg_catalog.txid_current());
  update coinops.exchange_accounts set executor_shard_id=p_to_shard,onboarding_environment='REAL' where id=p_account_id;
  delete from private.coinops_staged_shard_move_capabilities where account_id=p_account_id;
  insert into coinops.account_onboarding_checks(operator_id,exchange_account_id,check_key,status,evidence,created_by,idempotency_key)
    values(p_operator_id,p_account_id,'EXECUTOR_REASSIGNMENT','PASS',
      jsonb_build_object('from_shard',p_from_shard,'to_shard',p_to_shard,'source_registry_retired',true,'never_traded',true),
      v_operator.user_id,'shard-reassignment:'||p_request_id::text),
    (p_operator_id,p_account_id,'BINANCE_CREDENTIAL','PENDING',
      jsonb_build_object('status','CREDENTIAL_REQUIRED','environment','REAL','executor_shard_id',p_to_shard,
        'executor_ip',host(v_shard.egress_ipv4),'reason','EXPLICIT_STAGED_REASSIGNMENT'),
      v_operator.user_id,'shard-credential-required:'||p_request_id::text);
  return jsonb_build_object('code','REASSIGNED','shardId',p_to_shard,'executorIp',host(v_shard.egress_ipv4),
    'credentialRequired',true,'replayed',false);
end $$;
revoke all on function coinops.reassign_staged_executor_shard(uuid,uuid,text,text,uuid,boolean,boolean)
  from public,anon,authenticated;
grant execute on function coinops.reassign_staged_executor_shard(uuid,uuid,text,text,uuid,boolean,boolean) to service_role;
commit;
