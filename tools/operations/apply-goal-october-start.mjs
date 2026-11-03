#!/usr/bin/env node
// Explicit CoinOps metadata release; default VERIFY is read-only. No order I/O.
import {readFileSync,mkdtempSync,writeFileSync,unlinkSync,rmdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createCLI} from './certify-slot-workload.mjs';
const VERSION='20261103131530';
const BASELINE='64411cfd8c06e5ab616329ece3461474bf3dbfd116ce284ff5c23dc5d72e2179';
const TARGET='a182df3577051dee6e4c282418d650207366f24c0d9aac5d6120773e3baa193b';
const q=s=>"'"+String(s).replaceAll("'","''")+"'";
export function goalCorrectionCLI(){
 const runner=(file,args)=>{let directory,path;try{
  if(args[0]==='db'&&args[1]==='query'&&args.at(-1).length>7000){
   directory=mkdtempSync(join(tmpdir(),'coinops-october-'));path=join(directory,'migration.sql');
   writeFileSync(path,args.at(-1),{mode:0o600});args=[...args.slice(0,-1),'--file',path];
  }
  return execFileSync(file,args,{encoding:'utf8',timeout:70000,maxBuffer:8e6,windowsHide:true,stdio:['ignore','pipe','pipe']});
 }catch(e){throw Error(String(e.stderr??'').match(/COINOPS_[A-Z0-9_]+|ERROR:[^\r\n]{0,180}/)?.[0]??'CORRECTION_OUTCOME_UNKNOWN_READBACK_REQUIRED');}
 finally{if(path)unlinkSync(path);if(directory)rmdirSync(directory);}};
 const cli=createCLI({runner});cli.verifyProject();return cli;
}
export function migrateOctoberGoalStart(apply=false){
 const c=goalCorrectionCLI();
 const state=c.query(`BEGIN READ ONLY;SELECT jsonb_build_object(
 'registered',exists(select 1 from supabase_migrations.schema_migrations where version='${VERSION}'),
 'base_registered',exists(select 1 from supabase_migrations.schema_migrations where version='20261103110000'),
 'rls',(select relrowsecurity and relforcerowsecurity from pg_class where oid='coinops.robot_v1_live_preparations'::regclass),
 'event_rls',(select relrowsecurity and relforcerowsecurity from pg_class where oid='coinops.robot_v1_live_events'::regclass),
 'privileges',has_table_privilege('service_role','coinops.trading_engines','SELECT,UPDATE')
  and has_table_privilege('service_role','coinops.robot_v1_live_preparations','SELECT,UPDATE')
  and has_table_privilege('service_role','coinops.robot_v1_live_events','SELECT,INSERT'),
 'functions',(select jsonb_object_agg(p.proname,encode(sha256(convert_to(replace(pg_get_functiondef(p.oid),chr(13),''),'UTF8')),'hex'))
 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='coinops'
 and p.proname in('preserve_cumulative_slot_goal_history','cumulative_slot_goal_target','october_slot_goal_policy','correct_cumulative_goal_october_start')),
 'grants',case when to_regprocedure('coinops.correct_cumulative_goal_october_start(uuid,jsonb)')is not null
 then not has_function_privilege('anon','coinops.correct_cumulative_goal_october_start(uuid,jsonb)','execute')
 and not has_function_privilege('authenticated','coinops.correct_cumulative_goal_october_start(uuid,jsonb)','execute')
 and has_function_privilege('service_role','coinops.correct_cumulative_goal_october_start(uuid,jsonb)','execute')end)AS evidence;COMMIT;`,'evidence');
 if(!state.base_registered||!state.rls||!state.event_rls||!state.privileges||state.functions?.cumulative_slot_goal_target!==TARGET)
  throw Error('COINOPS_GOAL_START_BASELINE_UNPROVEN');
 if(state.registered){
  if(!state.grants||!state.functions?.october_slot_goal_policy||!state.functions?.correct_cumulative_goal_october_start)
   throw Error('COINOPS_GOAL_START_MIGRATION_PARTIAL');
  return{status:'ALREADY_APPLIED',version:VERSION,no_replay:true};
 }
 if(state.functions?.preserve_cumulative_slot_goal_history!==BASELINE
  ||state.functions?.october_slot_goal_policy||state.functions?.correct_cumulative_goal_october_start)
  throw Error('COINOPS_GOAL_START_REMOTE_DRIFT');
 if(!apply)return{status:'VERIFIED_NOT_APPLIED',product:'CoinOps',project_ref:'otdfpmsegjxpqrzisfmi',schema:'coinops',environment:'REAL',version:VERSION,rls:true};
 const sql=readFileSync(new URL('../../supabase/migrations/20261103131530_cumulative_goal_october_start.sql',import.meta.url),'utf8');
 return c.query(sql.replace(/commit;\s*$/i,'')+`INSERT INTO supabase_migrations.schema_migrations(version,name,statements)
 VALUES('${VERSION}','cumulative_goal_october_start',ARRAY[${q(sql)}]);
 SELECT jsonb_build_object('status','APPLIED','version','${VERSION}')AS evidence;COMMIT;`,'evidence');
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 try{if(process.argv.length!==3||!['--verify','--apply'].includes(process.argv[2]))throw Error('MIGRATION_MODE_REQUIRED');
 console.log(JSON.stringify(migrateOctoberGoalStart(process.argv[2]==='--apply')));}
 catch(error){console.error(error.message);process.exitCode=1;}
}
