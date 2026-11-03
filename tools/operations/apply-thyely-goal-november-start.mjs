#!/usr/bin/env node
// Exact owner-approved exception only. Schema release has no engine data write.
import{readFileSync}from'node:fs';
import{resolve}from'node:path';
import{pathToFileURL}from'node:url';
import{goalCorrectionCLI}from'./apply-goal-october-start.mjs';
const VERSION='20261103140130',q=s=>"'"+String(s).replaceAll("'","''")+"'";
export function migrateThyelyGoalStart(apply=false){
 const c=goalCorrectionCLI();
 const state=c.query(`BEGIN READ ONLY;SELECT jsonb_build_object(
 'registered',exists(select 1 from supabase_migrations.schema_migrations where version='${VERSION}'),
 'base_registered',exists(select 1 from supabase_migrations.schema_migrations where version='20261103134124'),
 'rls',(select relrowsecurity and relforcerowsecurity from pg_class where oid='coinops.robot_v1_live_preparations'::regclass),
 'functions',(select jsonb_object_agg(p.proname,encode(sha256(convert_to(replace(pg_get_functiondef(p.oid),chr(13),''),'UTF8')),'hex'))
 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='coinops'
 and p.proname in('preserve_cumulative_slot_goal_history','correct_cumulative_goal_october_start','november_thyely_slot_goal_policy','correct_thyely_goal_november_start')),
 'grants',case when to_regprocedure('coinops.correct_thyely_goal_november_start(uuid,jsonb)')is not null
 then not has_function_privilege('anon','coinops.correct_thyely_goal_november_start(uuid,jsonb)','execute')
 and not has_function_privilege('authenticated','coinops.correct_thyely_goal_november_start(uuid,jsonb)','execute')
 and has_function_privilege('service_role','coinops.correct_thyely_goal_november_start(uuid,jsonb)','execute')end)AS evidence;COMMIT;`,'evidence');
 if(!state.base_registered||!state.rls
  ||state.functions?.correct_cumulative_goal_october_start!=='2d162521914a4ec14aca42c146170d9f7dc6284407bf4cd85e9582c49c69de38')
  throw Error('COINOPS_THYELY_GOAL_BASELINE_UNPROVEN');
 if(state.registered){
  if(!state.grants||!state.functions?.november_thyely_slot_goal_policy||!state.functions?.correct_thyely_goal_november_start)
   throw Error('COINOPS_THYELY_GOAL_MIGRATION_PARTIAL');
  return{status:'ALREADY_APPLIED',version:VERSION,no_replay:true};
 }
 if(state.functions?.preserve_cumulative_slot_goal_history!=='24eed57bb95af8e79f4e0ec6eff346524506e251da0fb6176f6900aa5c5b1a4a'
  ||state.functions?.november_thyely_slot_goal_policy||state.functions?.correct_thyely_goal_november_start)
  throw Error('COINOPS_THYELY_GOAL_SOURCE_DRIFT');
 if(!apply)return{status:'VERIFIED_NOT_APPLIED',version:VERSION,product:'CoinOps',project_ref:'otdfpmsegjxpqrzisfmi',schema:'coinops',environment:'REAL'};
 const sql=readFileSync(new URL('../../supabase/migrations/20261103140130_thyely_goal_november_start.sql',import.meta.url),'utf8');
 return c.query(sql.replace(/commit;\s*$/i,'')+`INSERT INTO supabase_migrations.schema_migrations(version,name,statements)
 VALUES('${VERSION}','thyely_goal_november_start',ARRAY[${q(sql)}]);SELECT jsonb_build_object('status','APPLIED','version','${VERSION}')AS evidence;COMMIT;`,'evidence');
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 try{if(process.argv.length!==3||!['--verify','--apply'].includes(process.argv[2]))throw Error('MIGRATION_MODE_REQUIRED');
 console.log(JSON.stringify(migrateThyelyGoalStart(process.argv[2]==='--apply')));}
 catch(error){console.error(error.message);process.exitCode=1;}
}
