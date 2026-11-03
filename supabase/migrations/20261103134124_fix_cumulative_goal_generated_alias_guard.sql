-- BEFORE triggers see generated columns before PostgreSQL recomputes them.
-- Compare all stored, writable fields; derived aliases remain database-owned.
begin;
set local lock_timeout='2s';
set local statement_timeout='15s';
do $fix$
declare v_definition text;
 v_old text:='(to_jsonb(new)-''slot_goal_policy''-''updated_at'')=(to_jsonb(old)-''slot_goal_policy''-''updated_at'')';
 v_new text:='(to_jsonb(new)-array[''slot_goal_policy'',''updated_at'']-
      array(select a.attname::text from pg_catalog.pg_attribute a where a.attrelid=tg_relid and a.attgenerated<>''''))=
     (to_jsonb(old)-array[''slot_goal_policy'',''updated_at'']-
      array(select a.attname::text from pg_catalog.pg_attribute a where a.attrelid=tg_relid and a.attgenerated<>''''))';
begin
 select pg_get_functiondef('coinops.preserve_cumulative_slot_goal_history()'::regprocedure) into v_definition;
 if position(v_old in v_definition)=0 then raise exception 'COINOPS_GOAL_START_GENERATED_SOURCE_DRIFT';end if;
 execute replace(v_definition,v_old,v_new);
end $fix$;
commit;
