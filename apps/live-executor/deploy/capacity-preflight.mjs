// Control-plane certification only; no orders, restarts or credential changes.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readManifest, verifyFleet } from "./fleet-parity.mjs";

const PROJECT = "https://otdfpmsegjxpqrzisfmi.supabase.co";
export function certificateForFleet(fleet, manifest, policy) {
  if (fleet?.status !== "FLEET_PARITY_PASS" || !fleet.shards?.length
    || fleet.target_sha !== manifest.target_sha || typeof policy?.version !== "string")
    throw new Error("CAPACITY_FLEET_UNVERIFIED");
  return { p_target_sha: manifest.target_sha, p_runtime_sha256: manifest.runtime_sha256,
    p_node_version: manifest.node_version, p_policy_version: policy.version,
    p_evidence: fleet.shards.map((shard) => {
      const proof = fleet.evidence?.find((item) => item.shard_id === shard.shard_id);
      if (shard.status !== "PASS" || proof?.node_version !== manifest.node_version
        || proof.runtime_sha256 !== manifest.runtime_sha256 || proof.service?.active_state !== "active"
        || proof.health?.healthy !== true || proof.process_identity_verified !== true
        || proof.code_loaded_evidence !== "DISK_UNCHANGED_SINCE_PROCESS_START")
        throw new Error("CAPACITY_CONFIG_UNVERIFIED");
      return { ...shard, node_version: proof.node_version, config_status: "PASS" };
    }) };
}
export async function capacityPreflight({ record = false, env = process.env,
  fleetVerifier = verifyFleet, fetcher = fetch } = {}) {
  const url = env.SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL;
  if (url !== PROJECT || env.SUPABASE_DATA_SCHEMA !== "coinops" || !env.SUPABASE_SERVICE_ROLE_KEY)
    throw new Error("CAPACITY_SUPABASE_SCOPE_INVALID");
  const rpc = async (name, body = {}) => {
    const response = await fetcher(`${url}/rest/v1/rpc/${name}`, { method: "POST", redirect: "error",
      signal: AbortSignal.timeout(10000), headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, "content-type": "application/json",
        "Content-Profile": "coinops", "Accept-Profile": "coinops" }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error("CAPACITY_PREFLIGHT_RPC_FAILED");
    return response.json();
  };
  const manifest = readManifest(), policy = await rpc("executor_capacity_policy");
  const fleet = await fleetVerifier({ manifest, env });
  const certificate = certificateForFleet(fleet, manifest, policy);
  if (!record) return { status: "CAPACITY_PREFLIGHT_VERIFIED_NOT_RECORDED", certificate };
  const recorded = await rpc("certify_executor_admission", certificate);
  if (recorded !== "ADMISSION_PREFLIGHT_PASS") throw new Error("CAPACITY_CERTIFICATION_FAILED");
  const decisions = await rpc("executor_capacity_decisions");
  if (!Array.isArray(decisions) || fleet.shards.some((s) => {
    const own=decisions.filter((d)=>d.shard_id===s.shard_id);
    return own.length!==1 || own[0].plus_one?.ready?.ready!==true;
  })) throw new Error("CAPACITY_READINESS_NOT_CONFIRMED");
  return { status: recorded, policy_version: policy.version, target_sha: manifest.target_sha,
    shards: decisions.map((d) => ({ shard_id: d.shard_id, readiness: d.plus_one.ready,
      admission: d.plus_one.code, reason: d.plus_one.reason })) };
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !["--verify", "--record"].includes(args[0])) {
    process.stderr.write("Usage: capacity-preflight.mjs --verify|--record\n"); process.exitCode = 1;
  } else capacityPreflight({ record: args[0] === "--record" }).then((result) => console.log(JSON.stringify(result)))
    .catch((error) => { console.error(/^CAPACITY_[A-Z_]+$/.test(error?.message ?? "")
      ? error.message : "CAPACITY_PREFLIGHT_FAILED"); process.exitCode = 1; });
}
