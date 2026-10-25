#!/usr/bin/env node
import {readFileSync,mkdtempSync,writeFileSync,unlinkSync,rmdirSync} from 'node:fs';
import {join,resolve} from 'node:path';import {tmpdir} from 'node:os';import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';import {createCLI} from './certify-slot-workload.mjs';
export const VERSION='20261025204059';
const q=s=>"'"+s.replaceAll("'","''")+"'";
export function applyReviewedHandoffMigration(){
 const runner=(file,args)=>{let dir,path;try{
  if(args[0]==='db'&&args[1]==='query'&&args.at(-1).length>8000){
   dir=mkdtempSync(join(tmpdir(),'coinops-migration-'));path=join(dir,'apply.sql');
   writeFileSync(path,args.at(-1),{mode:0o600});args=[...args.slice(0,-1),'--file',path];
  }
  return execFileSync(file,args,{encoding:'utf8',timeout:70000,maxBuffer:8*1024*1024,windowsHide:true,stdio:['ignore','pipe','pipe']});
 }catch(e){const safe=String(e.stderr||e.stdout||'').match(/COINOPS_[A-Z0-9_]+|ERROR:[^\r\n]{0,200}/)?.[0];
  throw Error(safe||e.code||'MIGRATION_UNCERTAIN_READBACK_REQUIRED');
 }finally{if(path)unlinkSync(path);if(dir)rmdirSync(dir)}};
 const c=createCLI({runner});c.verifyProject();
 const prior=c.query(`BEGIN READ ONLY;SELECT jsonb_build_object('registered',EXISTS(SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='${VERSION}'),
  'exists',to_regclass('coinops.engine_handoffs') IS NOT NULL) AS evidence;COMMIT;`,'evidence');
 if(prior.registered&&prior.exists)return {status:'ALREADY_APPLIED',no_replay:true};
 if(prior.registered||prior.exists)throw Error('MIGRATION_PARTIAL_STATE_REVIEW_REQUIRED');
 const original=readFileSync(new URL('../../supabase/migrations/20261025204059_controlled_engine_handoffs.sql',import.meta.url),'utf8');
 const sql=original.replace(/commit;\s*$/i,'');
 return c.query(sql+`INSERT INTO supabase_migrations.schema_migrations(version,name,statements)
 VALUES('${VERSION}','controlled_engine_handoffs',ARRAY[${q(original)}]);
 SELECT jsonb_build_object('status','APPLIED','version','${VERSION}',
 'rls',(SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid='coinops.engine_handoffs'::regclass)) AS evidence;COMMIT;`,'evidence');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{if(process.argv.length!==3||process.argv[2]!=='--apply')throw Error('MIGRATION_EXPLICIT_APPLY_REQUIRED');console.log(JSON.stringify(applyReviewedHandoffMigration()))}
 catch(e){console.error(e.message);process.exitCode=1;}
}
