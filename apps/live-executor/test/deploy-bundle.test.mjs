import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

test("deployment archive has every runtime import without web node_modules or files outside execution", async () => {
  const stage = await mkdtemp(join(tmpdir(), "coinops-deploy-bundle-"));
  try {
    await cp(join(root, "apps/live-executor/src"), join(stage, "apps/live-executor/src"), { recursive: true });
    await cp(join(root, "apps/live-executor/package.json"), join(stage, "apps/live-executor/package.json"));
    await cp(join(root, "apps/web/lib/execution"), join(stage, "apps/web/lib/execution"), { recursive: true });
    const entry = pathToFileURL(join(stage, "apps/live-executor/src/server.mjs")).href;
    const result = await execute(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e",
      `const runtime = await import(${JSON.stringify(entry)}); if (typeof runtime.createExecutorHandler !== 'function') process.exit(1);`],
    { cwd: stage, timeout: 20_000, env: { ...process.env, NODE_PATH: "" } });
    assert.equal(result.stdout, "");
  } finally { await rm(stage, { recursive: true, force: true }); }
});

test("new-shard deployment assets reject executor01 and preserve secrets, state and first deployment", async () => {
  const folder = join(root, "apps/live-executor/deploy");
  const bootstrap = await readFile(join(folder, "bootstrap-new-shard.sh"), "utf8");
  const deploy = await readFile(join(folder, "deploy-shard.sh"), "utf8");
  const service = await readFile(join(folder, "coinops-shard-executor.service"), "utf8");
  assert.ok(bootstrap.indexOf("$ipv4 != 46.101.104.48") < bootstrap.indexOf("apt-get update"));
  assert.ok(bootstrap.indexOf("$shard != executor-01") < bootstrap.indexOf("apt-get update"));
  assert.match(bootstrap, /node_version=24\.21\.0/);
  assert.match(bootstrap, /'certbot==5\.8\.0'/);
  assert.match(bootstrap, /if \[\[ ! -e \$env_file \]\]; then/);
  assert.match(bootstrap, /randomBytes\(48\)/);
  assert.match(deploy, /\^\[a-f0-9\]\{40\}\$/);
  assert.match(deploy, /merge-base --is-ancestor/);
  assert.match(deploy, /if \[\[ -L \/opt\/coinops\/current \]\]; then\s+previous=\$\(readlink -f/);
  assert.match(deploy, /switch_release "\$previous"; set_version "\$old_version"/);
  assert.ok(!deploy.includes("rm -rf") && !bootstrap.includes("rm -rf"));
  assert.match(service, /ReadWritePaths=\/var\/lib\/coinops-live-executor/);
  assert.match(service, /ProtectSystem=strict/);
});
