-- CoinOps only, owner-approved exception for Thyely SOLBRL / monthly target3.
-- Reuse the released lease/CAS/audit protocol; no financial data or orders here.
begin;
set local lock_timeout='2s';
set local statement_timeout='15s';
create or replace function coinops.november_thyely_slot_goal_policy(p_policy jsonb)
returns jsonb language plpgsql immutable set search_path='' as $policy$
declare v_base jsonb;v_schedule jsonb;v_next jsonb;
begin
 if p_policy->'anchor_correction'->>'policy'='THYELY_NOVEMBER_START_V1' then return p_policy;end if;
 perform coinops.cumulative_slot_goal_target(p_policy,(p_policy->>'anchor_at')::timestamptz);
 if to_char((p_policy->>'anchor_at')::timestamptz at time zone 'America/Campo_Grande','YYYY-MM')<>'2026-10'
  or p_policy ? 'anchor_correction' or p_policy ? 'execution_anchor_at'
 then raise exception 'COINOPS_THYELY_GOAL_SCOPE_DENIED';end if;
 select value into strict v_base from jsonb_array_elements(p_policy->'schedule')
  where value->>'effective_period'<='2026-11' order by value->>'effective_period' desc limit 1;
 if (v_base->>'monthly_target')::integer<>3 then raise exception 'COINOPS_THYELY_GOAL_SCOPE_DENIED';end if;
 select coalesce(jsonb_agg(value order by value->>'effective_period'),'[]'::jsonb)into v_schedule
  from jsonb_array_elements(p_policy->'schedule')where value->>'effective_period'>'2026-11';
 v_next:=p_policy||jsonb_build_object('anchor_at','2026-11-01T04:00:00Z',
  'execution_anchor_at',p_policy->>'anchor_at',
  'schedule',jsonb_build_array(jsonb_set(v_base,'{effective_period}','"2026-11"'::jsonb))||v_schedule,
  'anchor_correction',jsonb_build_object('policy','THYELY_NOVEMBER_START_V1',
   'event_key','SLOT_GOAL_START:THYELY_NOVEMBER_2026_V1','previous_anchor_at',p_policy->>'anchor_at','start_period','2026-11'));
 perform coinops.cumulative_slot_goal_target(v_next,'2026-11-01T04:00:00Z');
 return v_next;
end $policy$;
revoke all on function coinops.november_thyely_slot_goal_policy(jsonb)from public,anon,authenticated;
grant execute on function coinops.november_thyely_slot_goal_policy(jsonb)to service_role;

do $release$
declare v_definition text;v_expected text;
begin
 -- Extend only the authorized policy choice. Stored-field comparison, generated
 -- aliases, event ownership, role, active lease and full before/after stay exact.
 select pg_get_functiondef('coinops.preserve_cumulative_slot_goal_history()'::regprocedure)into v_definition;
 v_expected:='new.slot_goal_policy=coinops.october_slot_goal_policy(old.slot_goal_policy)';
 if position(v_expected in v_definition)=0 or position('a.attgenerated' in v_definition)=0
 then raise exception 'COINOPS_THYELY_GOAL_TRIGGER_DRIFT';end if;
 v_definition:=replace(v_definition,v_expected,
  'new.slot_goal_policy=(case when new.trading_engine_id=''fa551904-15da-4e17-8259-b0a76e206fac''::uuid
    and new.exchange_account_id=''5580c011-6ff1-44bd-b568-85932b424ceb''::uuid
    and new.slot_goal_policy->''anchor_correction''->>''policy''=''THYELY_NOVEMBER_START_V1''
   then coinops.november_thyely_slot_goal_policy(old.slot_goal_policy)
   else coinops.october_slot_goal_policy(old.slot_goal_policy)end)');
 v_expected:='ev.event_key=''SLOT_GOAL_START:OCTOBER_2026_V1''';
 if position(v_expected in v_definition)=0 then raise exception 'COINOPS_THYELY_GOAL_TRIGGER_DRIFT';end if;
 v_definition:=replace(v_definition,v_expected,'ev.event_key=new.slot_goal_policy->''anchor_correction''->>''event_key''');
 v_expected:='ev.details->>''authorization''=''OWNER_20261103_EXCLUDE_SEPTEMBER_TEST''';
 if position(v_expected in v_definition)=0 then raise exception 'COINOPS_THYELY_GOAL_TRIGGER_DRIFT';end if;
 v_definition:=replace(v_definition,v_expected,
  'ev.details->>''authorization''=(case when new.slot_goal_policy->''anchor_correction''->>''policy''=''THYELY_NOVEMBER_START_V1''
   then ''OWNER_20261103_THYELY_NOVEMBER_START'' else ''OWNER_20261103_EXCLUDE_SEPTEMBER_TEST''end)');
 execute v_definition;

 -- Clone the verified released control flow, adding an exact engine/account/par
 -- and configured-target fence before it can claim a lease or write any event.
 select pg_get_functiondef('coinops.correct_cumulative_goal_october_start(uuid,jsonb)'::regprocedure)into v_definition;
 if position('from coinops.operators owner' in v_definition)=0
  or position('or e.environment<>''REAL'''in v_definition)=0
 then raise exception 'COINOPS_THYELY_GOAL_RPC_DRIFT';end if;
 v_definition:=replace(v_definition,'coinops.correct_cumulative_goal_october_start(','coinops.correct_thyely_goal_november_start(');
 v_definition:=replace(v_definition,'coinops.october_slot_goal_policy(','coinops.november_thyely_slot_goal_policy(');
 v_definition:=replace(v_definition,'EXCLUDE_SEPTEMBER_TEST_V1','THYELY_NOVEMBER_START_V1');
 v_definition:=replace(v_definition,'SLOT_GOAL_START:OCTOBER_2026_V1','SLOT_GOAL_START:THYELY_NOVEMBER_2026_V1');
 v_definition:=replace(v_definition,'OWNER_20261103_EXCLUDE_SEPTEMBER_TEST','OWNER_20261103_THYELY_NOVEMBER_START');
 v_definition:=replace(v_definition,'or e.environment<>''REAL''',
  'or e.id<>''fa551904-15da-4e17-8259-b0a76e206fac''::uuid
   or e.exchange_account_id<>''5580c011-6ff1-44bd-b568-85932b424ceb''::uuid or e.symbol<>''SOLBRL'' or p.monthly_target<>3
   or e.environment<>''REAL''');
 execute v_definition;
end $release$;
revoke all on function coinops.correct_thyely_goal_november_start(uuid,jsonb)from public,anon,authenticated;
grant execute on function coinops.correct_thyely_goal_november_start(uuid,jsonb)to service_role;
commit;
