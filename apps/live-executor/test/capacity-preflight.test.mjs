import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { certificateForFleet, capacityPreflight } from "../deploy/capacity-preflight.mjs";
import { readManifest } from "../deploy/fleet-parity.mjs";
const manifest=readManifest();
function fleet(ids=["executor-01","executor-02","executor-03"]) {
  return {status:"FLEET_PARITY_PASS",target_sha:manifest.target_sha,
    shards:ids.map((id)=>({shard_id:id,status:"PASS",ip:"192.0.2."+Number(id.slice(-2)),
      actual_sha:manifest.target_sha,runtime_sha256:manifest.runtime_sha256,observed_at:new Date().toISOString()})),
    evidence:ids.map((id)=>({shard_id:id,node_version:manifest.node_version,runtime_sha256:manifest.runtime_sha256,
      process_identity_verified:true,code_loaded_evidence:"DISK_UNCHANGED_SINCE_PROCESS_START",
      service:{active_state:"active"},health:{healthy:true}}))};
}
test("future shard automatically participates in parity certificate; mismatched bytes never pass",()=>{
  const result=fleet(); const cert=certificateForFleet(result,manifest,{version:"policy"});
  assert.equal(cert.p_evidence.length,3);
  result.evidence[2].runtime_sha256="f".repeat(64);
  assert.throws(()=>certificateForFleet(result,manifest,{version:"policy"}),/CONFIG_UNVERIFIED/);
  assert.throws(()=>certificateForFleet({...fleet(),status:"FLEET_PARITY_NOT_CONFIRMED"},manifest,{version:"policy"}),/FLEET_UNVERIFIED/);
});
test("verify is read-only; record only writes certification after full parity and then checks SQL gate",async()=>{
  const calls=[]; const result=fleet();
  const env={SUPABASE_URL:"https://otdfpmsegjxpqrzisfmi.supabase.co",SUPABASE_DATA_SCHEMA:"coinops",SUPABASE_SERVICE_ROLE_KEY:"fixture"};
  const fetcher=async(url)=>{const method=url.split("/").at(-1);calls.push(method);
    return Response.json(method==="executor_capacity_policy"?{version:"policy"}:method==="certify_executor_admission"
      ?"ADMISSION_PREFLIGHT_PASS":result.shards.map(s=>({shard_id:s.shard_id,plus_one:{ready:{ready:true},code:"CAPACITY_REQUIRED"}})));};
  await capacityPreflight({env,fetcher,fleetVerifier:async()=>result});
  assert.deepEqual(calls,["executor_capacity_policy"]);calls.length=0;
  assert.equal((await capacityPreflight({record:true,env,fetcher,fleetVerifier:async()=>result})).status,"ADMISSION_PREFLIGHT_PASS");
  assert.deepEqual(calls,["executor_capacity_policy","certify_executor_admission","executor_capacity_decisions"]);
});
test("bootstrap inherits Node from shared manifest and keeps admission pending",()=>{
  const source=readFileSync(new URL("../deploy/bootstrap-new-shard.sh",import.meta.url),"utf8");
  assert.ok(source.includes('fleet-release.json'));
  assert.ok(source.includes('ADMISSION_BLOCKED_UNTIL_CERTIFIED'));
  assert.ok(!source.includes('node_version=24.21.0'));
});
