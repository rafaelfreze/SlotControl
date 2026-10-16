-- CoinOps / OnPlay Platform. READ ONLY review, not migration or certificate.
-- Execute only through authenticated CLI with explicit project-ref
-- otdfpmsegjxpqrzisfmi. SQL cannot independently prove Management API routing.
-- Baseline GitHub/main: 6ec2339f9d051c34cb75317b9b9dfdedb3cd0e07.
BEGIN READ ONLY;
SET LOCAL statement_timeout='15s';
WITH expected(signature,expected_main_body_sha256) AS (VALUES
 ('private.coinops_slot_workload_profile(text,text,integer)','d0323e986d50a74bb2cf796e2e352aa54104905170567b95fad6e71356c533ae'),
 ('coinops.record_live_reconciliation_checkpoint(uuid,uuid,text,numeric)','422e3e87071fcb7c0ffc6132b0bfa0afc026e8adbe74ed711d7fc9b56b4685a4')),
proofs AS (SELECT e.signature,e.expected_main_body_sha256,p.oid is not null AS function_exists,
 encode(sha256(convert_to(replace(p.prosrc,E'\r\n',E'\n'),'UTF8')),'hex') AS actual_body_sha256,
 p.prosecdef AS security_definer,p.provolatile AS volatility,p.proconfig AS settings,
 has_function_privilege('anon',p.oid,'EXECUTE') AS anon_execute,
 has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated_execute,
 has_function_privilege('service_role',p.oid,'EXECUTE') AS service_role_execute,
 exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
   where a.grantee=0 and a.privilege_type='EXECUTE') AS public_execute
 FROM expected e LEFT JOIN pg_proc p ON p.oid=to_regprocedure(e.signature))
SELECT jsonb_build_object('product','CoinOps','expected_project_ref','otdfpmsegjxpqrzisfmi','schema','coinops',
 'schema_exists',to_regnamespace('coinops') is not null,'read_only',current_setting('transaction_read_only'),
 'observed_at',clock_timestamp(),'baseline_main','6ec2339f9d051c34cb75317b9b9dfdedb3cd0e07',
 'functions',(select jsonb_agg(to_jsonb(f) order by signature) from proofs f),
 'preexisting_bodies_match_main',(select bool_and(function_exists and actual_body_sha256=expected_main_body_sha256) from proofs),
 'new_partial_helper_absent',to_regprocedure('private.coinops_partial_tp_fills_accounted(uuid)') is null,
 'new_batch_proof_absent',to_regprocedure('coinops.prove_partial_tp_checkpoint_fills(uuid,jsonb)') is null,
 'pending_migrations',(select coalesce(jsonb_agg(jsonb_build_object('version',version,'name',name)),'[]'::jsonb)
   from supabase_migrations.schema_migrations where version in ('20261016192533','20261016193756')),
 'latest_history',(select jsonb_agg(to_jsonb(h)) from (select version,name from supabase_migrations.schema_migrations order by version desc limit 8) h),
 'legacy25',private.coinops_slot_workload_profile('executor-03','REAL',25),
 'policy',coinops.executor_capacity_policy(),
 'executor03_sample',(select jsonb_build_object('shard_id',m.shard_id,'observed_at',m.observed_at,'heartbeat_at',m.heartbeat_at,
   'sustained',m.binance_weight_average,'current',m.binance_weight_current,'peak',m.binance_weight_peak,
   'samples',m.binance_weight_samples,'executor_version',m.executor_version) from coinops.executor_capacity_samples m where shard_id='executor-03'),
 'executor03_preview4',coinops.preview_executor_admission('executor-03','REAL',4),
 'executor03_slot50',coinops.preview_engine_slot_admission('executor-03','REAL',array[50])) AS release_review;
COMMIT;
