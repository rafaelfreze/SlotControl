#!/usr/bin/env node
/** Emit a single READ ONLY verification query. This helper executes nothing
 * remotely and cannot prove connection identity: use the authenticated CLI with
 * explicit --project-ref otdfpmsegjxpqrzisfmi, never a legacy dotenv fallback. */
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
const migrations = [
  ["20261016192533", "bind_slot_workload_web_fingerprint"],
  ["20261016193756", "prove_partial_tp_reconciliation_checkpoint"],
];
const functions = [
  ["private.coinops_slot_workload_profile(text,text,integer)", 0, "s"],
  ["private.coinops_partial_tp_fills_accounted(uuid)", 1, "s"],
  ["coinops.record_live_reconciliation_checkpoint(uuid,uuid,text,numeric)", 1, "v"],
  ["coinops.prove_partial_tp_checkpoint_fills(uuid,jsonb)", 1, "s"],
];
function expectedBodyHash(signature, migrationIndex) {
  const [version,name] = migrations[migrationIndex];
  const sql = readFileSync(new URL(`../../supabase/migrations/${version}_${name}.sql`, import.meta.url), "utf8").replace(/\r\n/g,"\n");
  const start=sql.indexOf(`create or replace function ${signature.split("(")[0]}(`), bodyStart=sql.indexOf("$$",start)+2;
  const bodyEnd=sql.indexOf("$$;",bodyStart);
  if(start<0||bodyStart<2||bodyEnd<bodyStart) throw new Error("SLOT_WORKLOAD_VERIFIER_SOURCE_INVALID");
  return createHash("sha256").update(sql.slice(bodyStart,bodyEnd)).digest("hex");
}
export function postMigrationVerificationSQL() {
  const functionRows=functions.map(([signature,index,volatility])=>`('${signature}','${expectedBodyHash(signature,index)}','${volatility}')`).join(",\n");
  const migrationRows=migrations.map(([version,name])=>`('${version}','${name}')`).join(",");
  return `BEGIN READ ONLY;
SET LOCAL statement_timeout='15s';
WITH expected_functions(signature,expected_body_sha256,expected_volatility) AS (VALUES ${functionRows}),
function_proofs AS (SELECT e.signature,e.expected_body_sha256,e.expected_volatility,p.oid is not null AS function_exists,
 p.prosecdef AS security_definer,p.provolatile AS volatility,p.proconfig AS settings,
 encode(sha256(convert_to(replace(p.prosrc,E'\\r\\n',E'\\n'),'UTF8')),'hex') AS actual_body_sha256,
 has_function_privilege('anon',p.oid,'EXECUTE') AS anon_execute,
 has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated_execute,
 has_function_privilege('service_role',p.oid,'EXECUTE') AS service_role_execute,
 exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
   where a.grantee=0 and a.privilege_type='EXECUTE') AS public_execute
 FROM expected_functions e LEFT JOIN pg_proc p ON p.oid=to_regprocedure(e.signature)),
expected_migrations(version,name) AS (VALUES ${migrationRows}),
migration_proofs AS (SELECT e.version,e.name AS expected_name,count(m.version)::int AS history_rows,
 bool_and(m.name=e.name) AS exact_name FROM expected_migrations e
 LEFT JOIN supabase_migrations.schema_migrations m ON m.version=e.version GROUP BY e.version,e.name)
SELECT jsonb_build_object('product','CoinOps','expected_project_ref','otdfpmsegjxpqrzisfmi',
 'connection_identity','REQUIRES_EXPLICIT_AUTHENTICATED_CLI_PROJECT_REF',
 'database',current_database(),'schema','coinops','schema_exists',to_regnamespace('coinops') is not null,
 'transaction_read_only',current_setting('transaction_read_only'),
 'functions',(select jsonb_agg(to_jsonb(f) order by signature) from function_proofs f),
 'functions_pass',(select bool_and(function_exists and actual_body_sha256=expected_body_sha256 and not security_definer
   and volatility=expected_volatility and not anon_execute and not authenticated_execute and not public_execute
   and service_role_execute and settings @> array['search_path=""']) from function_proofs),
 'legacy25',private.coinops_slot_workload_profile('executor-03','REAL',25),
 'migrations',(select jsonb_agg(to_jsonb(m) order by version) from migration_proofs m),
 'migrations_pass',(select bool_and(history_rows=1 and exact_name) from migration_proofs),
 'latest_history',(select jsonb_agg(to_jsonb(h)) from (select version,name from supabase_migrations.schema_migrations order by version desc limit 6) h)) AS verification;
COMMIT;`;
}
if(process.argv[1]&&realpathSync(process.argv[1])===realpathSync(fileURLToPath(import.meta.url)))
  process.stdout.write(postMigrationVerificationSQL()+"\n");
