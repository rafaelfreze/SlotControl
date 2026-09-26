import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const executorRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("stdin importer has no filesystem entrypoint and does not accidentally start the server", () => {
  const entry = pathToFileURL(join(executorRoot, "src/server.mjs")).href;
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-"], {
    input: `const runtime = await import(${JSON.stringify(entry)}); console.log(typeof runtime.startExecutor);`,
    encoding: "utf8", timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "function");
});

// Linux startup requires a root-owned registry. Do not weaken that production
// guard for a fixture: run this case as root on Linux or on Windows.
test("CLI through current symlink actually listens without a Binance request", {
  skip: process.platform !== "win32" && process.getuid?.() !== 0
    ? "Requires root for the production-enforced Linux registry ownership" : false,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "coinops-cli-symlink-"));
  let child;
  try {
    const current = join(directory, "current");
    await symlink(executorRoot, current, process.platform === "win32" ? "junction" : "dir");
    const registry = join(directory, "registry.json");
    await writeFile(registry, JSON.stringify({ version: 1, executor_shard_id: "executor-02",
      engines: [], credentials: {} }), { mode: 0o600 });
    const reserved = createServer();
    await new Promise((done) => reserved.listen(0, "127.0.0.1", done));
    const port = reserved.address().port;
    await new Promise((done) => reserved.close(done));
    child = spawn(process.execPath, ["--experimental-strip-types", join(current, "src/server.mjs")], {
      cwd: directory, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env,
        PORT: String(port), COINOPS_EXECUTOR_SHARD_ID: "executor-02",
        COINOPS_EXECUTOR_HMAC_SECRET: "fictional-symlink-cli-test-secret-never-production",
        COINOPS_EXECUTOR_STATE_DIR: join(directory, "state"), COINOPS_EXECUTOR_REGISTRY_PATH: registry,
        COINOPS_EXECUTOR_LEGACY_COMPAT: "false", COINOPS_EXECUTOR_VERSION: "fixture-cli",
        LIVE_EXECUTOR_EGRESS_IP: "203.0.113.22", BINANCE_API_KEY: "", BINANCE_API_SECRET: "",
        TRADING_ENABLED: "false", KILL_SWITCH: "ON" },
    });
    let errors = "", listening = false;
    child.stderr.on("data", (chunk) => { errors += String(chunk).slice(0, 2000); });
    for (let attempt = 0; attempt < 40; attempt++) {
      if (child.exitCode !== null) break;
      try {
        // Unlike /health, an unsupported route cannot read Binance/credentials.
        const response = await fetch(`http://127.0.0.1:${port}/fixture-read-only-no-route`, {
          signal: AbortSignal.timeout(200),
        });
        if (response.status === 404 && (await response.json()).error === "EXECUTOR_ROUTE_DENIED") {
          listening = true; break;
        }
      } catch { /* Wait only for this synthetic child to finish startup. */ }
      await delay(50);
    }
    assert.equal(listening, true, `CLI failed to listen; exit=${child.exitCode}; stderr=${errors}`);
    assert.equal(child.exitCode, null);
  } finally {
    if (child && child.exitCode === null) {
      const stopped = new Promise((done) => child.once("exit", done));
      child.kill(); await stopped;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
