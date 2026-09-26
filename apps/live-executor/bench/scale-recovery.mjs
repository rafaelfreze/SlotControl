import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { withWriteIdempotency, sha256 } from "../src/security.mjs";
import { runFairPool } from "../../web/lib/execution/live-cron-scheduler.ts";

const CONCURRENCY = 12;
const percentile = (samples, n) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return Number((sorted[Math.ceil(sorted.length * n / 100) - 1] ?? 0).toFixed(2));
};

async function scenario(accountCount, fault) {
  const engines = Array.from({ length: accountCount * 2 }, (_, index) => ({
    account: Math.floor(index / 2), engine: index,
    slots: Array.from({ length: 25 }, (_, slot) => slot + 1),
  }));
  const affected = new Set(fault === "ONE_ENGINE" ? [0]
    : fault === "FIVE_ENGINES" ? [0, 1, 2, 3, 4]
      : fault === "ONE_CREDENTIAL" ? [0, 1] : []);
  const base = await mkdtemp(join(tmpdir(), "coinops-scale-recovery-"));
  const exchange = new Map();
  const writes = new Map();
  const durations = [];
  const cpuStart = process.cpuUsage();
  const rssStart = process.memoryUsage().rss;
  const started = performance.now();
  try {
    const results = await runFairPool(engines, CONCURRENCY, 3, async ({ account, engine, slots }) => {
      const began = performance.now();
      const directory = join(base, `account-${account}`, `engine-${engine}`);
      const orders = ["MARKET", "TP", "NEXT_BUY"];
      let recovered = 0;
      for (const [sequence, purpose] of orders.entries()) {
        const key = `SYNTHETIC:${account}:${engine}:${purpose}:CYCLE:1`;
        const bodyHash = sha256(`${key}:${slots[sequence]}`);
        const args = { directory, key, bodyHash,
          recover: async () => exchange.get(key) ?? null,
          execute: async () => {
            writes.set(key, (writes.get(key) ?? 0) + 1);
            const order = { clientOrderId: key, purpose, account, engine };
            exchange.set(key, order);
            if (affected.has(engine) && purpose === "MARKET") throw new Error("SYNTHETIC_LOST_ACK");
            return order;
          } };
        if (affected.has(engine) && purpose === "MARKET") {
          await assert.rejects(withWriteIdempotency(args), /SYNTHETIC_LOST_ACK/);
          await assert.rejects(withWriteIdempotency({ ...args,
            recover: async () => null }), /WRITE_OUTCOME_UNKNOWN/);
        } else await withWriteIdempotency(args);
        // A fresh invocation resumes from durable claim and exact exchange evidence.
        const replay = await withWriteIdempotency({ ...args,
          execute: async () => { throw new Error("DUPLICATE_ORDER"); } });
        assert.equal(replay.replayed, true);
        assert.deepEqual(replay.result, exchange.get(key));
        if (affected.has(engine) && purpose === "MARKET") recovered++;
      }
      durations.push(performance.now() - began);
      return { engine, account, recovered };
    });
    assert.equal(results.length, engines.length);
    assert.equal(exchange.size, engines.length * 3);
    assert.equal([...writes.values()].every((count) => count === 1), true);
    assert.equal(results.reduce((sum, item) => sum + item.recovered, 0), affected.size);
    const cpu = process.cpuUsage(cpuStart);
    return { accounts: accountCount, engines: engines.length,
      fixtureSlots: engines.reduce((sum, engine) => sum + engine.slots.length, 0),
      fault, recoveredEngines: affected.size, healthyEngines: engines.length - affected.size,
      uniqueOrders: exchange.size, duplicateOrders: 0, wallMs: Number((performance.now() - started).toFixed(2)),
      engineLatencyMs: { p50: percentile(durations, 50), p95: percentile(durations, 95),
        p99: percentile(durations, 99) },
      cpuMs: Number(((cpu.user + cpu.system) / 1000).toFixed(2)),
      rssBeforeMb: Number((rssStart / 1048576).toFixed(2)),
      rssAfterMb: Number((process.memoryUsage().rss / 1048576).toFixed(2)) };
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

for (const accountCount of [50, 100]) console.log(JSON.stringify(await scenario(accountCount, "NONE")));
for (const fault of ["ONE_ENGINE", "FIVE_ENGINES", "ONE_CREDENTIAL"])
  console.log(JSON.stringify(await scenario(50, fault)));
