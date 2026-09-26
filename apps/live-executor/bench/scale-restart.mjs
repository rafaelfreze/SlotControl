/** Process-level, fixture-only restart benchmark. No Binance credentials or writes. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

import { sha256, withWriteIdempotency } from "../src/security.mjs";

const script = resolve(fileURLToPath(import.meta.url));
const purposes = ["MARKET", "TP", "NEXT_BUY"];
const readJson = (path) => existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};

async function child(base, accounts, mode) {
  const exchangePath = join(base, "fictional-exchange.json");
  const attemptsPath = join(base, "fictional-attempts.json");
  const exchange = readJson(exchangePath), attempts = readJson(attemptsPath);
  const started = performance.now(), latencies = [];
  let recovered = 0;
  for (let engine = 0; engine < accounts * 2; engine++) {
    const began = performance.now();
    for (const purpose of purposes) {
      const key = `SYNTHETIC:${engine}:${purpose}:CYCLE:1`;
      const args = { directory: join(base, "claims", String(engine)), key,
        bodyHash: sha256(key), recover: async () => exchange[key] ?? null,
        execute: async () => {
          attempts[key] = (attempts[key] ?? 0) + 1;
          writeFileSync(attemptsPath, JSON.stringify(attempts));
          const order = { clientOrderId: key, exchangeOrderId: `FICTITIOUS-${engine}-${purpose}` };
          exchange[key] = order;
          writeFileSync(exchangePath, JSON.stringify(exchange));
          // Kill the entire process after fictitious exchange acceptance, before ACK.
          if (mode === "CRASH" && engine === 37 && purpose === "TP") process.exit(86);
          return order;
        } };
      const result = await withWriteIdempotency(args);
      assert.deepEqual(result.result, exchange[key]);
      if (mode === "RECOVER" && engine === 37 && purpose === "TP") {
        assert.equal(result.replayed, true);
        recovered++;
      }
    }
    latencies.push(performance.now() - began);
  }
  assert.equal(Object.keys(exchange).length, accounts * 2 * purposes.length);
  assert.equal(Object.values(attempts).every((count) => count === 1), true);
  const ordered = latencies.sort((a, b) => a - b);
  const percentile = (p) => Number(ordered[Math.ceil(ordered.length * p / 100) - 1].toFixed(2));
  console.log(JSON.stringify({ accounts, engines: accounts * 2, fixtureSlots: accounts * 50,
    phase: mode, uniqueOrders: Object.keys(exchange).length, duplicateOrders: 0,
    recoveredAfterCrash: recovered, wallMs: Number((performance.now() - started).toFixed(2)),
    latencyMs: { p50: percentile(50), p95: percentile(95), p99: percentile(99) },
    rssMb: Number((process.memoryUsage().rss / 1048576).toFixed(2)) }));
}

function runChild(base, accounts, mode) {
  const result = spawnSync(process.execPath, [script, "--child", base, String(accounts), mode],
    { cwd: dirname(script), encoding: "utf8", timeout: 120_000 });
  if (result.error) throw result.error;
  if (mode === "CRASH") assert.equal(result.status, 86, result.stderr);
  else assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

if (process.argv[2] === "--child") {
  const base = resolve(process.argv[3] ?? "");
  const accounts = Number(process.argv[4]);
  if (!Number.isInteger(accounts) || ![50, 100].includes(accounts)
    || !base.startsWith(resolve(tmpdir()) + sep)) throw new Error("SYNTHETIC_SCOPE_INVALID");
  await child(base, accounts, process.argv[5]);
} else {
  for (const accounts of [50, 100]) {
    const base = await mkdtemp(join(tmpdir(), "coinops-scale-restart-"));
    try {
      runChild(base, accounts, "CRASH");
      console.log(runChild(base, accounts, "RECOVER"));
      console.log(runChild(base, accounts, "REPLAY"));
    } finally {
      if (realpathSync(base).startsWith(realpathSync(tmpdir()) + sep))
        await rm(base, { recursive: true, force: true });
    }
  }
}
