-- Hotfix: compute the authorized operator set once per SELECT rather than
-- repeating the platform membership check for every candle/event. operators'
-- own RLS remains the authority (scope + admin + disabled-state checks).
-- No financial rows, grants, permissive legacy policies or write paths change.
begin;
set local lock_timeout='3s';
set local statement_timeout='30s';
do $$declare p record;begin
 for p in select tablename,policyname from pg_policies
  where schemaname='coinops' and tablename<>'operators'
   and policyname in ('operator_owned','operator_context_visible')
   and qual='private.coinops_operator_owned(operator_id)' loop
  execute format('alter policy %I on coinops.%I using (operator_id in (select id from coinops.operators))',p.policyname,p.tablename);
 end loop;
end $$;
commit;
