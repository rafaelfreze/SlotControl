import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    const helper = await readFile(join(root, "apps/live-executor/deploy/runtime-preflight.sh"), "utf8");
    const probe = helper.match(/--input-type=module -e '([\s\S]+)' "\$code_root"/)?.[1];
    assert.ok(probe, "test the exact no-secrets probe run as service user by the deploy scripts");
    const checked = await execute(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", probe, stage],
      { cwd: stage, timeout: 20_000, env: { ...process.env, NODE_PATH: "" } });
    assert.equal(checked.stdout.trim(), "SERVICE_USER_RUNTIME_READ_IMPORT_PASS");
    await rm(join(stage, "apps/live-executor/package.json"));
    await assert.rejects(execute(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", probe, stage],
      { cwd: stage, timeout: 20_000 }), /ENOENT/);
  } finally { await rm(stage, { recursive: true, force: true }); }
});

test("all deployment paths prove runtime access as the real non-root service user before restart and rollback", async () => {
  const folder = join(root, "apps/live-executor/deploy");
  const helper = await readFile(join(folder, "runtime-preflight.sh"), "utf8");
  const modern = await readFile(join(folder, "deploy-shard.sh"), "utf8");
  const legacy = await readFile(join(folder, "deploy-legacy.sh"), "utf8");
  assert.match(helper, /systemctl show coinops-live-executor\.service --property=User --value/);
  assert.match(helper, /systemctl show coinops-live-executor\.service --property=Group --value/);
  assert.match(helper, /\$service_uid != 0/);
  assert.match(helper, /runuser -u "\$service_user" -g "\$service_group" -- \/usr\/bin\/env -i/);
  assert.match(helper, /constants\.R_OK.*constants\.X_OK/);
  assert.match(helper, /await import\(pathToFileURL/);
  assert.ok(!helper.includes("startExecutor()"), "import cannot start a listener or financial flow");
  for (const script of [modern, legacy]) {
    assert.match(script, /source "\$script_directory\/runtime-preflight\.sh"/);
    assert.ok(script.indexOf('runtime_preflight "$staging"') < script.lastIndexOf("systemctl restart"));
    assert.match(script, /umask 022/);
    assert.match(script, /PRIVATE_ROOT_ENV_REQUIRED/);
    assert.match(script, /chmod 600 "\$temporary"/);
    assert.ok(!script.includes("reset --hard") && !script.includes("rm -rf"));
  }
  assert.ok(modern.indexOf('chmod -R u=rwX,go=rX "$release"') < modern.indexOf('runtime_preflight "$release"'));
  assert.ok(modern.indexOf('runtime_preflight "$release"') < modern.indexOf('switch_release "$release"'));
  const modernRollback = modern.slice(modern.indexOf('if [[ $healthy != true ]]'));
  assert.ok(modernRollback.indexOf('runtime_preflight "$previous"') < modernRollback.indexOf('switch_release "$previous"'));
  assert.ok(modernRollback.indexOf('runtime_preflight "$previous"') < modernRollback.indexOf("systemctl restart"));
  const legacyRollback = legacy.slice(legacy.indexOf("rollback()"), legacy.indexOf("# Validate the exact candidate"));
  assert.match(legacyRollback, /umask 022; git -C "\$repo" switch --detach "\$previous"/);
  assert.ok(legacyRollback.indexOf('runtime_preflight "$repo"') < legacyRollback.indexOf("systemctl restart"));
  assert.match(legacy, /\$shard == executor-01/);
  assert.match(legacy, /\$ipv4 == 46\.101\.104\.48/);
  assert.match(legacy, /CLEAN_WORKTREE_REQUIRED/);
  assert.match(legacy, /merge-base --is-ancestor "\$revision" refs\/remotes\/origin\/main/);
  assert.match(legacy, /merge-base --is-ancestor "\$previous" "\$revision"/);
  assert.match(legacy, /umask 022; git -C "\$repo" merge --ff-only "\$revision"/);
  assert.ok(legacy.indexOf('runtime_preflight "$staging"') < legacy.indexOf('merge --ff-only'));
  assert.match(legacy, /PROTECTED_ENV_CHANGED/);
  assert.match(legacy, /git -C "\$repo" ls-files -z -- apps\/live-executor\/src apps\/live-executor\/package.json apps\/web\/lib\/execution/);
  assert.ok(!legacy.includes("chmod -R") || legacy.match(/chmod -R[^\n]+/g).every((line) => line.includes('"$staging"')),
    "no recursive permissions changes to legacy checkout, env or state");
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

test("modern already-deployed and rollback reports require exact observed shard release and IP health", async () => {
  const deploy = await readFile(join(root, "apps/live-executor/deploy/deploy-shard.sh"), "utf8");
  assert.match(deploy, /\$previous == "\$release" && \$old_version == "\$revision"/);
  assert.match(deploy, /systemctl is-active --quiet coinops-live-executor && health_matches "\$revision"; then/);
  assert.match(deploy, /\$restart_ok == true.*health_matches "\$revision"; then healthy=true/);
  const rollback = deploy.slice(deploy.indexOf('if [[ $healthy != true ]]'));
  assert.match(rollback, /health_matches "\$old_version" \|\| fail 'ROLLBACK_HEALTH_FAILED'/);
  assert.ok(rollback.indexOf('health_matches "$old_version"') < rollback.indexOf("DEPLOY_FAILED_ROLLED_BACK"));
  assert.ok(!deploy.includes("validate previous health"));
  const probe = deploy.match(/--input-type=module -e '([^']+)' "\$health_file" "\$shard" "\$expected" "\$ipv4"/)?.[1];
  assert.ok(probe);
  const stage = await mkdtemp(join(tmpdir(), "coinops-deploy-health-"));
  try {
    const file = join(stage, "health.json");
    const healthy = { healthy: true, executor_shard_id: "executor-02", actual_executor_version: "reviewed-sha",
      egress_ipv4_verified: true, egress_ipv4: "203.0.113.22" };
    await writeFile(file, JSON.stringify(healthy));
    const args = ["--input-type=module", "-e", probe, file, "executor-02", "reviewed-sha", "203.0.113.22"];
    await execute(process.execPath, args, { timeout: 5_000 });
    for (const patch of [{ healthy: false }, { healthy: "true" }, { executor_shard_id: "executor-03" },
      { actual_executor_version: "other-sha" }, { egress_ipv4_verified: false }, { egress_ipv4_verified: "true" },
      { egress_ipv4: "203.0.113.23" }]) {
      await writeFile(file, JSON.stringify({ ...healthy, ...patch }));
      await assert.rejects(execute(process.execPath, args, { timeout: 5_000 }));
    }
  } finally { await rm(stage, { recursive: true, force: true }); }
});

test("deploy fetch updates main repeatedly and preserves prior SHA rollback ancestry", async () => {
  const stage = await mkdtemp(join(tmpdir(), "coinops-deploy-fetch-"));
  const source = join(stage, "source"), mirror = join(stage, "repository.git");
  const git = (...args) => execute("git", args, { cwd: stage, timeout: 15_000,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" } });
  try {
    await git("init", "--initial-branch=main", source);
    await git("-C", source, "config", "user.name", "CoinOps deploy fixture");
    await git("-C", source, "config", "user.email", "fixture@example.invalid");
    await writeFile(join(source, "fixture.txt"), "revision one\n");
    await git("-C", source, "add", "fixture.txt");
    await git("-C", source, "-c", "core.hooksPath=/dev/null", "commit", "-m", "fixture one");
    const first = (await git("-C", source, "rev-parse", "HEAD")).stdout.trim();
    await git("init", "--bare", mirror);
    await git("--git-dir", mirror, "remote", "add", "origin", source);
    const deploy = await readFile(join(root, "apps/live-executor/deploy/deploy-shard.sh"), "utf8");
    const fetchArgs = deploy.match(/git --git-dir="\$repo" (fetch [^\r\n]+)/)?.[1].split(" ");
    assert.ok(fetchArgs, "the deployment must explicitly fetch reviewed main");
    await git("--git-dir", mirror, ...fetchArgs);
    await git("--git-dir", mirror, ...fetchArgs);
    await writeFile(join(source, "fixture.txt"), "revision two\n");
    await git("-C", source, "add", "fixture.txt");
    await git("-C", source, "-c", "core.hooksPath=/dev/null", "commit", "-m", "fixture two");
    const second = (await git("-C", source, "rev-parse", "HEAD")).stdout.trim();
    await git("--git-dir", mirror, ...fetchArgs);
    assert.equal((await git("--git-dir", mirror, "rev-parse", "refs/remotes/origin/main")).stdout.trim(), second);
    await git("--git-dir", mirror, "merge-base", "--is-ancestor", first, "refs/remotes/origin/main");
    await git("--git-dir", mirror, ...fetchArgs);
    assert.equal((await git("--git-dir", mirror, "rev-parse", first + "^{commit}")).stdout.trim(), first);
    assert.ok(fetchArgs.includes("refs/heads/main:refs/remotes/origin/main"));
  } finally { await rm(stage, { recursive: true, force: true }); }
});
