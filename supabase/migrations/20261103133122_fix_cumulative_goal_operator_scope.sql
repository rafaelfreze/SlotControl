-- CoinOps only. Engine scope resolves through its actual operator; engine rows
-- do not duplicate product/tenant/user. No policy or financial data is changed.
begin;
set local lock_timeout='2s';
set local statement_timeout='15s';
do $fix$
declare v_definition text;
 v_old text:='or (e.product_id,e.tenant_id,e.user_id,e.slot_count) is distinct from(r.product_id,r.tenant_id,r.user_id,r.slot_count)';
 v_new text:='or e.slot_count<>r.slot_count
  or not exists(select 1 from coinops.operators owner where owner.id=e.operator_id and owner.status=''ACTIVE'' and not owner.kill_switch
   and (owner.product_id,owner.tenant_id,owner.user_id) is not distinct from(r.product_id,r.tenant_id,r.user_id))';
begin
 select pg_get_functiondef('coinops.correct_cumulative_goal_october_start(uuid,jsonb)'::regprocedure) into v_definition;
 if position(v_old in v_definition)=0 then raise exception 'COINOPS_GOAL_START_SCOPE_SOURCE_DRIFT';end if;
 execute replace(v_definition,v_old,v_new);
end $fix$;
commit;
