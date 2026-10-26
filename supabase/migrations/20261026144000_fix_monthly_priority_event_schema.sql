-- CoinOps / OnPlay Platform otdfpmsegjxpqrzisfmi / coinops.
-- Correct the event INSERT: asset belongs to the run, not live_events.
-- Original migration is immutable. The failed transaction committed no allocation.
begin;
set local lock_timeout='3s';
set local statement_timeout='20s';
create or replace function coinops.allocate_live_monthly_entry_levels(
 p_run_id uuid, p_lease_owner uuid, p_plan_id text, p_period text,
 p_expected jsonb, p_assignments jsonb, p_context jsonb
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare
 r coinops.robot_v1_live_runs%rowtype; e coinops.trading_engines%rowtype;
 prep coinops.robot_v1_live_preparations%rowtype;
 actual jsonb; checkpoint jsonb; a jsonb; n integer; sources jsonb; source_origin text;
begin
 if coalesce(nullif(current_setting('request.jwt.claim.role',true),''),auth.jwt()->>'role','') <> 'service_role'
  or p_plan_id is null or p_plan_id !~ '^[a-f0-9]{64}$' then
  raise exception 'COINOPS_ENTRY_PRIORITY_SCOPE_DENIED';
 end if;
 select * into r from coinops.robot_v1_live_runs where id=p_run_id for update;
 if not found or p_lease_owner is null or r.lease_owner is distinct from p_lease_owner
  or r.lease_until is null or r.lease_until<=clock_timestamp() then
  raise exception 'COINOPS_ENTRY_PRIORITY_LEASE_DENIED'; end if;
 select * into e from coinops.trading_engines where id=r.trading_engine_id for share;
 if not found or e.environment is distinct from 'REAL' or e.status is distinct from 'ACTIVE'
  or r.status is distinct from 'ACTIVE' or e.operator_id is distinct from r.operator_id
  or e.exchange_account_id is distinct from r.exchange_account_id or e.symbol is distinct from r.symbol
  or e.slot_count is distinct from r.slot_count or e.slot_count not between 2 and 100
  or e.kill_switch is distinct from false or e.strategy_config_pending is distinct from false
  or r.last_error is not null or not exists(select 1 from coinops.executor_shards sh
   where sh.id=e.executor_shard_id and sh.enabled)
  or not exists(select 1 from coinops.operators op where op.id=r.operator_id
   and op.product_id=r.product_id and op.tenant_id=r.tenant_id and op.user_id=r.user_id
   and op.status='ACTIVE' and not op.kill_switch)
  or not exists(select 1 from coinops.exchange_accounts ac where ac.id=r.exchange_account_id
   and ac.operator_id=r.operator_id and ac.status='ACTIVE' and not ac.kill_switch)
  or not exists(select 1 from coinops.robot_v1_live_preparations p where p.trading_engine_id=e.id
   and p.live_enabled and not p.kill_switch and p.slot_count=e.slot_count)
  or exists(select 1 from coinops.robot_v1_live_alerts al where al.trading_engine_id=e.id
   and al.severity='CRITICAL' and al.resolved_at is null)
 then raise exception 'COINOPS_ENTRY_PRIORITY_SCOPE_DENIED'; end if;
 select * into prep from coinops.robot_v1_live_preparations where trading_engine_id=e.id for share;
 if not found or p_context is distinct from jsonb_build_object('regime',r.entry_regime,
  'config_version',r.config_version,'monthly_target',prep.monthly_target,'shard',e.executor_shard_id)
 then raise exception 'COINOPS_ENTRY_PRIORITY_SNAPSHOT_CHANGED'; end if;
 n:=e.slot_count;
 if p_period is distinct from to_char(clock_timestamp() at time zone 'America/Campo_Grande','YYYY-MM')
  or jsonb_typeof(p_expected) is distinct from 'array' or jsonb_array_length(p_expected)<>n
  or jsonb_typeof(p_assignments) is distinct from 'array' or jsonb_array_length(p_assignments) not between 0 and n
 then raise exception 'COINOPS_ENTRY_PRIORITY_INPUT_INVALID'; end if;
 -- All current physical rows and monthly facts are CAS evidence. Unknown is
 -- never zero: the account counter must agree with the complete gain view.
 perform 1 from coinops.robot_v1_live_slots s where s.run_id=r.id order by s.slot_number for update;
 if (select count(*) from coinops.robot_v1_live_slots s where s.run_id=r.id)<>n
  or (select count(distinct s.slot_number) from coinops.robot_v1_live_slots s where s.run_id=r.id)<>n
  or exists(select 1 from coinops.robot_v1_live_slots s where s.run_id=r.id and
   (s.slot_number not between 1 and n or s.trading_engine_id is distinct from e.id
    or s.operator_id is distinct from r.operator_id or s.exchange_account_id is distinct from r.exchange_account_id
    or s.tenant_id is distinct from r.tenant_id or s.product_id is distinct from r.product_id or s.user_id is distinct from r.user_id))
  or (select count(*) from coinops.robot_v1_live_slot_accounts ac where ac.trading_engine_id=e.id)<>n
 then raise exception 'COINOPS_ENTRY_PRIORITY_INCOMPLETE'; end if;
 if exists(select 1 from coinops.robot_v1_live_slot_accounts ac left join coinops.robot_v1_slot_gain_totals g
   on g.trading_engine_id=e.id and g.slot_number=ac.slot_number and g.environment='REAL' and g.asset=r.asset
   and g.operator_id=r.operator_id and g.exchange_account_id=r.exchange_account_id
   and g.product_id=r.product_id and g.tenant_id=r.tenant_id and g.user_id=r.user_id
   where ac.trading_engine_id=e.id and (ac.gain_count>coalesce(g.lifetime_gain_count,0)
    or g.period_key is not null and g.period_key<>p_period))
 then raise exception 'COINOPS_ENTRY_PRIORITY_GAIN_EVIDENCE_INVALID'; end if;
 select jsonb_agg(jsonb_build_object('id',s.id,'n',s.slot_number,'state',s.entry_state,
  'sequence',s.operation_sequence,'price',s.target_buy_price,'reference',s.entry_reference_price,
  'position',s.position_quantity,'monthly',coalesce(g.monthly_gain_count,0),'lifetime',coalesce(g.lifetime_gain_count,0))
  order by s.slot_number) into actual from coinops.robot_v1_live_slots s
 left join coinops.robot_v1_slot_gain_totals g on g.trading_engine_id=e.id and g.slot_number=s.slot_number
  and g.environment='REAL' and g.asset=r.asset and g.operator_id=r.operator_id
  and g.exchange_account_id=r.exchange_account_id and g.product_id=r.product_id
  and g.tenant_id=r.tenant_id and g.user_id=r.user_id where s.run_id=r.id;
 checkpoint:=jsonb_build_object('policy','MONTHLY_GAINS_V1','plan_id',p_plan_id,'period',p_period,
  'symbol',r.symbol,'quote_asset',r.quote_asset,'assignments',p_assignments);
 if r.config_snapshot->'entry_priority_checkpoint' @> checkpoint then
  -- A replay cannot refresh timestamps or overwrite a later allocation.
  return (r.config_snapshot->'entry_priority_checkpoint')||jsonb_build_object('price_sources',r.config_snapshot->'entry_price_sources'); end if;
 if actual is distinct from p_expected then raise exception 'COINOPS_ENTRY_PRIORITY_SNAPSHOT_CHANGED'; end if;
 if (select count(distinct x->>'id') from jsonb_array_elements(p_assignments) x)<>jsonb_array_length(p_assignments)
  or (select count(distinct x->>'sourceId') from jsonb_array_elements(p_assignments) x)<>jsonb_array_length(p_assignments)
  or (select jsonb_agg((x->>'previousPrice')::numeric order by (x->>'previousPrice')::numeric) from jsonb_array_elements(p_assignments) x)
   is distinct from (select jsonb_agg((x->>'price')::numeric order by (x->>'price')::numeric) from jsonb_array_elements(p_assignments) x)
 then raise exception 'COINOPS_ENTRY_PRIORITY_NOT_A_PERMUTATION'; end if;
 sources:=coalesce(r.config_snapshot->'entry_price_sources','{}'::jsonb);
 for a in select value from jsonb_array_elements(p_assignments) loop
  if not exists(select 1 from coinops.robot_v1_live_slots s where s.id=(a->>'id')::uuid and s.run_id=r.id
   and s.slot_number=(a->>'slotNumber')::integer and s.entry_state='PLANNED' and s.position_quantity=0
   and s.missed_at is null and s.target_buy_price=(a->>'previousPrice')::numeric
   and (a->>'price')::numeric>0 and (a->>'price')::numeric::text not in ('NaN','Infinity','-Infinity')
   and (a->>'rank')::integer between 1 and n
   and not exists(select 1 from coinops.robot_v1_live_orders o where o.run_id=r.id and o.slot_id=s.id
    and o.operation_sequence=s.operation_sequence and (o.status in ('PREPARED','NEW','PARTIALLY_FILLED')
      or o.executed_quantity>0 or o.cumulative_quote>0 or o.trades_reconciled is distinct from true)))
  then raise exception 'COINOPS_ENTRY_PRIORITY_COMMITTED_SLOT'; end if;
  select case when (sources->s.id::text->>'price')::numeric=s.target_buy_price
   then sources->s.id::text->>'source_origin' else s.entry_origin end into source_origin
   from coinops.robot_v1_live_slots s where s.id=(a->>'sourceId')::uuid and s.run_id=r.id
    and s.target_buy_price=(a->>'price')::numeric and s.entry_reference_price=s.target_buy_price
    and exists(select 1 from jsonb_array_elements(p_assignments) src where src->>'id'=s.id::text);
  if source_origin is null or source_origin not in ('GRID','REENTRY') or source_origin is distinct from a->>'sourceOrigin'
   then raise exception 'COINOPS_ENTRY_PRIORITY_LEVEL_SOURCE_INVALID'; end if;
 end loop;
 -- Build from the BEFORE map, never from another assignment in this permutation.
 for a in select value from jsonb_array_elements(p_assignments) loop
  sources:=sources||jsonb_build_object(a->>'id',jsonb_build_object('run_id',r.id,'engine_id',e.id,
   'slot_id',a->>'id','price',(a->>'price')::numeric,'source_origin',a->>'sourceOrigin','plan_id',p_plan_id));
 end loop;
 update coinops.robot_v1_live_slots s set target_buy_price=(a.value->>'price')::numeric,
  entry_reference_price=(a.value->>'price')::numeric,operational_rank=(a.value->>'rank')::integer
 from jsonb_array_elements(p_assignments) a where s.id=(a.value->>'id')::uuid and s.run_id=r.id;
 checkpoint:=checkpoint||jsonb_build_object('committed_at',clock_timestamp());
 update coinops.robot_v1_live_runs set config_snapshot=config_snapshot||jsonb_build_object(
  'entry_priority_policy','MONTHLY_GAINS_V1','entry_priority_checkpoint',checkpoint,'entry_price_sources',sources) where id=r.id;
 insert into coinops.robot_v1_live_events(run_id,product_id,tenant_id,user_id,operator_id,exchange_account_id,
  trading_engine_id,quote_asset,event_key,event_type,slot_number,details)
 values(r.id,r.product_id,r.tenant_id,r.user_id,r.operator_id,r.exchange_account_id,e.id,r.quote_asset,
  'ENTRY_PRIORITY:'||p_plan_id,'ENTRY_PRIORITY_ALLOCATED',null,checkpoint)
 on conflict(run_id,event_key) do nothing;
 return checkpoint||jsonb_build_object('price_sources',sources);
end $$;
revoke all on function coinops.allocate_live_monthly_entry_levels(uuid,uuid,text,text,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function coinops.allocate_live_monthly_entry_levels(uuid,uuid,text,text,jsonb,jsonb,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
