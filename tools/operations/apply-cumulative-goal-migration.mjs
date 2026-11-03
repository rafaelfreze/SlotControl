#!/usr/bin/env node
// Explicit CoinOps schema release only. Default --verify is read-only.
import {readFileSync,mkdtempSync,writeFileSync,unlinkSync,rmdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {createCLI} from './certify-slot-workload.mjs';
const VERSION='20261103110000';
const expected={
 prepare_robot_v1_live_order:'c5ee369ddffb1f0bf7a502ef226fe75e024256c8502a744f40df15725c114764',
 allocate_live_monthly_entry_levels:'30b502aac7cb73c347a93a452ae3eaf9c3cd2c1198056cd3c80d7cd445465d6e',
 dashboard_live_engine_reads:'2e02cc32441c74afd92227590a987b6d28de02d88398e07325cb25dd5f53b9dd',
};
const q=s=>"'"+s.replaceAll("'","''")+"'";
function runner(file,args){let directory,path;
 try{
  if(args[0]==='db'&&args[1]==='query'&&args.at(-1).length>7000){
   directory=mkdtempSync(join(tmpdir(),'coinops-goal-'));path=join(directory,'migration.sql');
   writeFileSync(path,args.at(-1),{mode:0o600});args=[...args.slice(0,-1),'--file',path];
  }
  return execFileSync(file,args,{encoding:'utf8',windowsHide:true,timeout:70000,maxBuffer:8e6,stdio:['ignore','pipe','pipe']});
 }catch(e){throw Error(String(e.stderr??'').match(/COINOPS_[A-Z0-9_]+|ERROR:[^\r\n]{0,180}/)?.[0]??'MIGRATION_UNCERTAIN_READBACK_REQUIRED');}
 finally{if(path)unlinkSync(path);if(directory)rmdirSync(directory);}
}
export function migrateCumulativeGoals(apply=false){
 const c=createCLI({runner});c.verifyProject();
 const state=c.query(`BEGIN READ ONLY;SELECT jsonb_build_object(
 'registered',exists(select 1 from supabase_migrations.schema_migrations where version='${VERSION}'),
 'column',exists(select 1 from information_schema.columns where table_schema='coinops' and table_name='robot_v1_live_preparations' and column_name='slot_goal_policy'),
 'rls',(select relrowsecurity and relforcerowsecurity from pg_class where oid='coinops.robot_v1_live_preparations'::regclass),
 'functions',(select jsonb_object_agg(p.proname,encode(sha256(convert_to(replace(pg_get_functiondef(p.oid),chr(13),''),'UTF8')),'hex'))
 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='coinops' and p.proname in(${Object.keys(expected).map(q).join(',')}))) AS evidence;COMMIT;`,'evidence');
 if(!state.rls)throw Error('COINOPS_SLOT_GOAL_RLS_UNPROVEN');
 if(state.registered&&state.column)return{status:'ALREADY_APPLIED',version:VERSION,no_replay:true};
 if(state.registered||state.column)throw Error('COINOPS_SLOT_GOAL_MIGRATION_PARTIAL');
 if(Object.keys(expected).some(key=>state.functions?.[key]!==expected[key]))throw Error('COINOPS_SLOT_GOAL_REMOTE_FUNCTION_DRIFT');
 if(!apply)return{status:'MIGRATION_VERIFIED_NOT_APPLIED',project_ref:'otdfpmsegjxpqrzisfmi',schema:'coinops',version:VERSION,rls:true};
 const sql=readFileSync(new URL('../../supabase/migrations/20261103110000_cumulative_slot_goals.sql',import.meta.url),'utf8');
 return c.query(sql.replace(/commit;\s*$/i,'')+`INSERT INTO supabase_migrations.schema_migrations(version,name,statements)
 VALUES('${VERSION}','cumulative_slot_goals',ARRAY[${q(sql)}]);SELECT jsonb_build_object('status','APPLIED','version','${VERSION}') AS evidence;COMMIT;`,'evidence');
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 try{if(process.argv.length!==3||!['--verify','--apply'].includes(process.argv[2]))throw Error('MIGRATION_MODE_REQUIRED');
 console.log(JSON.stringify(migrateCumulativeGoals(process.argv[2]==='--apply')));}
 catch(e){console.error(e.message);process.exitCode=1;}
}
