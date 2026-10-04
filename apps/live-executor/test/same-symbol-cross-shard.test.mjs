import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateExecutorRegistry, resolveExecutorContext, assertEngineOrder, durableIntent,
  appendInactiveRegistryEngines, loadCombinedRegistry, promoteRegistryEngine, increaseRegistryAccountCap, changeRegistryCapital } from "../src/account-registry.mjs";
import { BinanceLiveTransport } from "../src/binance-live.mjs";
import { liveClientOrderId } from "../../web/lib/execution/robot-v1-live-cycle.ts";
import { ACCOUNT_A, ACCOUNT_B, engineFixture, intentContext, registryFixture, credentialEnvironment } from "./registry-fixture.mjs";
import { durableOrderOwnership } from "../src/order-identity.mjs";
import { withWriteIdempotency } from "../src/security.mjs";

const row = (id, shard) => ({ ...engineFixture("SOLBRL", ACCOUNT_B, id, false),
  executor_shard_id: shard, credential_ref: `account_${ACCOUNT_B.replaceAll("-", "")}`,
  execution_allowed: true, account_cap_quote: 1000 });
const A = row(101, "executor-02"), B = row(102, "executor-03");
const registry = (shard, rows) => ({ version: 1, executor_shard_id: shard, engines: rows,
  credentials: rows.length ? { [A.credential_ref]: { vault: true } } : {} });
const id = (engine, side) => liveClientOrderId(engine.trading_engine_id, "SOL", 1, 1, side, 1,
  { exchange_account_id: engine.exchange_account_id,
    trading_engine_id: engine.trading_engine_id, base_asset: "SOL", legacy_compatible: false });

test("same SOLBRL/account engines on distinct shards reject foreign ownership before exchange I/O", async () => {
  for (const [own, foreign] of [[A, B], [B, A]]) {
    const installed = validateExecutorRegistry(registry(own.executor_shard_id, [own]));
    const input = { ...intentContext(own), executor_shard_id: own.executor_shard_id };
    assert.equal(resolveExecutorContext(installed, input, input.idempotency_key).engine.trading_engine_id, own.trading_engine_id);
    assert.throws(() => resolveExecutorContext(installed, { ...input, trading_engine_id: foreign.trading_engine_id }, input.idempotency_key), /SCOPE_DENIED/);
    assert.throws(() => resolveExecutorContext(installed, { ...input, executor_shard_id: foreign.executor_shard_id }, input.idempotency_key), /SHARD_SCOPE_DENIED/);
    let calls = 0;
    const transport = new BinanceLiveTransport({ engine: own, apiKey: "synthetic", apiSecret: "synthetic",
      fetcher: async () => { calls++; throw new Error("exchange must not be called"); } });
    for (const side of ["BUY", "SELL"]) {
      const ownId = id(own, side), foreignId = id(foreign, side);
      assert.notEqual(ownId, foreignId);
      assert.doesNotThrow(() => assertEngineOrder(own, "SOLBRL", ownId, side));
      assert.throws(() => assertEngineOrder(own, "SOLBRL", foreignId, side), /ORDER_NOT_OWNED/);
      await assert.rejects(transport.queryOrder("SOLBRL", foreignId), /ORDER_NOT_OWNED/);
      if (side === "BUY") await assert.rejects(transport.cancelOwnedBuy({ symbol: "SOLBRL", clientOrderId: foreignId, orderId: "123" },
        { tradingEnabled: true, killSwitch: false }), /ORDER_NOT_OWNED/);
      await assert.rejects(transport.ownedTrades("SOLBRL", foreignId, "123"), /ORDER_NOT_OWNED/);
    }
    assert.equal(calls, 0);
  }
  assert.notEqual(durableIntent(A, "same-request"), durableIntent(B, "same-request"));
});

test("same-symbol registry append preserves active engine and double-click converges", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coinops-engine-append-"));
  const installed = registry("executor-03", []);
  const scope = { operator_id: B.operator_id, exchange_account_id: B.exchange_account_id,
    credential_ref: B.credential_ref, environment: "REAL", executor_shard_id: "executor-03" };
  const inactive = { ...B, status: "INACTIVE", kill_switch: true, account_kill_switch: true,
    global_kill_switch: true, execution_allowed: false };
  try {
    await appendInactiveRegistryEngines(installed, directory, scope, [inactive]);
    await promoteRegistryEngine(installed, directory, { ...scope, trading_engine_id: B.trading_engine_id,
      symbol: B.symbol, hard_cap_quote: B.hard_cap_quote, account_cap_quote: B.account_cap_quote, max_order_quote: B.max_order_quote });
    const before = structuredClone((await loadCombinedRegistry(installed, directory)).engines[0]);
    const newRow = { ...inactive, trading_engine_id: row(103, "executor-03").trading_engine_id };
    await appendInactiveRegistryEngines(installed, directory, scope, [newRow]);
    assert.equal((await appendInactiveRegistryEngines(installed, directory, scope, [newRow])).replayed, true);
    const after = await loadCombinedRegistry(installed, directory);
    assert.equal(after.engines.length, 2);
    assert.deepEqual(after.engines[0], before);
    assert.equal(after.engines[1].execution_allowed, false);
    await assert.rejects(appendInactiveRegistryEngines(installed, directory, scope, [{ ...newRow, hard_cap_quote: 276 }]), /REPLAY_MISMATCH/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("CANCELED is never proof of ownership; a changed cancel ID requires an exact durable receipt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coinops-order-identity-"));
  const ownId = id(A, "BUY"), foreignId = id(B, "BUY");
  let responseId = foreignId;
  const order = { symbol: "SOLBRL", orderId: 123, side: "BUY", status: "CANCELED",
    executedQty: "0", cummulativeQuoteQty: "0", price: "100" };
  const fetcher = async (url) => new URL(url).pathname === "/api/v3/time"
    ? Response.json({ serverTime: Date.now() }) : Response.json({ ...order, clientOrderId: responseId });
  const transport = (engine) => new BinanceLiveTransport({ apiKey: "synthetic", apiSecret: "synthetic",
    engine, fetcher, ownershipEvidence: durableOrderOwnership(directory, engine) });
  try {
    await assert.rejects(transport(A).queryOrder("SOLBRL", ownId, "123"), /IDENTITY_MISMATCH/);
    await assert.rejects(transport(A).ownedTrades("SOLBRL", ownId, "123"), /IDENTITY_MISMATCH/);
    const proof = { orderId: "123", clientOrderId: ownId, symbol: "SOLBRL", side: "BUY" };
    // Exact previous CREATE receipt survives upgrade without changing its key.
    const claim = durableIntent(A, {}, ownId, "original-body", "CREATE_ORDER");
    await withWriteIdempotency({ directory: join(directory, "orders"), ...claim,
      recover: async () => null, execute: async () => proof });
    responseId = "binance-generated-cancel-id";
    assert.equal((await transport(A).queryOrder("SOLBRL", ownId, "123")).clientOrderId, ownId);
    assert.equal((await transport(A).queryOrder("SOLBRL", ownId, "123")).orderId, "123");
    await assert.rejects(transport(B).queryOrder("SOLBRL", foreignId, "123"), /IDENTITY_MISMATCH/);
    await assert.rejects(transport(A).queryOrder("SOLBRL", ownId, "124"), /IDENTITY_MISMATCH/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("shared account cap synchronization never changes installed engine caps, strategy or status", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coinops-shared-cap-"));
  const installed = registry("executor-03", []);
  const scope = { operator_id: B.operator_id, exchange_account_id: B.exchange_account_id,
    credential_ref: B.credential_ref, environment: "REAL", executor_shard_id: "executor-03" };
  const inactive = { ...B, account_cap_quote: 275, status: "INACTIVE", kill_switch: true,
    account_kill_switch: true, global_kill_switch: true, execution_allowed: false };
  try {
    await appendInactiveRegistryEngines(installed, directory, scope, [inactive]);
    await promoteRegistryEngine(installed, directory, { ...scope, trading_engine_id: B.trading_engine_id,
      symbol: B.symbol, hard_cap_quote: 275, account_cap_quote: 275, max_order_quote: B.max_order_quote });
    const before = (await loadCombinedRegistry(installed, directory)).engines[0];
    await increaseRegistryAccountCap(installed, directory, { ...scope, quote_asset: "BRL", account_cap_quote: 550 });
    const staged = { ...inactive, trading_engine_id: row(103, "executor-03").trading_engine_id, account_cap_quote: 550 };
    await appendInactiveRegistryEngines(installed, directory, scope, [staged]);
    const after = await loadCombinedRegistry(installed, directory);
    assert.deepEqual(after.engines[0], { ...before, account_cap_quote: 550 });
    assert.equal(after.engines[1].status, "INACTIVE");
    assert.equal((await increaseRegistryAccountCap(installed, directory,
      { ...scope, quote_asset: "BRL", account_cap_quote: 550 })).replayed, true);
    await assert.rejects(increaseRegistryAccountCap(installed, directory,
      { ...scope, quote_asset: "BRL", account_cap_quote: 549 }), /CAP_DENIED/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("new C2 engines reuse only their own installed legacy credential without copying or changing COR1 engines", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coinops-installed-credential-"));
  const historical = [engineFixture("BTCBRL", ACCOUNT_A, 1), engineFixture("SOLBRL", ACCOUNT_A, 2)];
  const installed = validateExecutorRegistry({ ...registryFixture(historical), legacy_account_id: ACCOUNT_A });
  const scope = { operator_id: historical[0].operator_id, exchange_account_id: ACCOUNT_A,
    credential_ref: "legacy-binance-production", environment: "REAL" };
  const staged = ["SOLBRL", "SOLUSDT"].map((symbol, index) => ({
    ...engineFixture(symbol, ACCOUNT_A, 200 + index, false), is_legacy_default: false,
    status: "INACTIVE", execution_allowed: false, kill_switch: true, account_kill_switch: true,
    global_kill_switch: true, account_cap_quote: 1000 }));
  try {
    await increaseRegistryAccountCap(installed, directory, { ...scope, quote_asset: "BRL", account_cap_quote: 1000 });
    const before = (await loadCombinedRegistry(installed, directory)).engines.slice(0, 2);
    await appendInactiveRegistryEngines(installed, directory, scope, staged);
    const combined = await loadCombinedRegistry(installed, directory);
    assert.deepEqual(combined.engines.slice(0, 2), before);
    for (const engine of combined.engines.slice(2)) {
      const input = intentContext(engine);
      const resolved = resolveExecutorContext(combined, input, input.idempotency_key, credentialEnvironment, { path: "/v1/state" });
      assert.equal(resolved.apiKey, credentialEnvironment.FIXTURE_A_KEY);
      assert.equal(resolved.vault, false);
      const ownId = liveClientOrderId(engine.trading_engine_id, "SOL", 1, 1, "BUY", 1,
        { exchange_account_id: ACCOUNT_A, trading_engine_id: engine.trading_engine_id,
          base_asset: "SOL", legacy_compatible: false });
      assert.match(ownId, /^C2/);
      assert.doesNotThrow(() => assertEngineOrder(engine, engine.symbol, ownId, "BUY"));
    }
    await promoteRegistryEngine(installed, directory, { ...scope, trading_engine_id: staged[0].trading_engine_id,
      symbol: staged[0].symbol, hard_cap_quote: staged[0].hard_cap_quote,
      account_cap_quote: staged[0].account_cap_quote, max_order_quote: staged[0].max_order_quote });
    assert.deepEqual((await loadCombinedRegistry(installed, directory)).engines.slice(0, 2), before);
    await assert.rejects(appendInactiveRegistryEngines(installed, directory, { ...scope, exchange_account_id: ACCOUNT_B },
      [{ ...staged[0], exchange_account_id: ACCOUNT_B }]), /APPEND_DENIED/);
    const { readFile, readdir } = await import("node:fs/promises");
    const dynamic = JSON.parse(await readFile(join(directory, "dynamic-registry.json"), "utf8"));
    assert.deepEqual(dynamic.credentials, {});
    assert.equal((await readdir(directory)).includes("credentials"), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("N same-symbol engines update only their own capital partition; global cap and replay remain coherent", async () => {
  const directories = await Promise.all([2, 3].map(() => mkdtemp(join(tmpdir(), "coinops-cap-partition-"))));
  const globalRows = [A, B, row(104, "executor-03"), row(105, "executor-03")]
    .map((engine) => ({ ...engine, hard_cap_quote: 100, max_order_quote: 100, account_cap_quote: 400 }));
  const inventory = globalRows.map((engine, index) => ({ trading_engine_id: engine.trading_engine_id,
    executor_shard_id: engine.executor_shard_id, symbol: engine.symbol,
    expected_hard_cap_quote: 100, target_hard_cap_quote: index === 1 ? 125 : 100 }));
  try {
    for (const [index, shard] of ["executor-02", "executor-03"].entries()) {
      const installed = registry(shard, []), directory = directories[index];
      const scope = { operator_id: A.operator_id, exchange_account_id: ACCOUNT_B, credential_ref: A.credential_ref,
        executor_shard_id: shard, environment: "REAL", quote_asset: "BRL" };
      const local = globalRows.filter((engine) => engine.executor_shard_id === shard);
      await appendInactiveRegistryEngines(installed, directory, scope, local.map((engine) => ({ ...engine,
        status: "INACTIVE", execution_allowed: false, kill_switch: true, account_kill_switch: true, global_kill_switch: true })));
      for (const engine of local) await promoteRegistryEngine(installed, directory, { ...scope,
        trading_engine_id: engine.trading_engine_id, symbol: engine.symbol, hard_cap_quote: 100, max_order_quote: 100, account_cap_quote: 400 });
      const before = (await loadCombinedRegistry(installed, directory)).engines;
      const changed = { ...scope, engines: inventory, expected_account_cap_quote: 400, target_account_cap_quote: 425 };
      assert.equal((await changeRegistryCapital(installed, directory, changed)).replayed, false);
      const after = (await loadCombinedRegistry(installed, directory)).engines;
      assert.equal(after.length, local.length);
      for (const engine of after) {
        assert.equal(engine.account_cap_quote, 425);
        assert.equal(engine.hard_cap_quote, engine.trading_engine_id === B.trading_engine_id ? 125 : 100);
        const old = before.find((item) => item.trading_engine_id === engine.trading_engine_id);
        assert.deepEqual(engine, { ...old, account_cap_quote: 425,
          hard_cap_quote: engine.trading_engine_id === B.trading_engine_id ? 125 : 100,
          max_order_quote: engine.trading_engine_id === B.trading_engine_id ? 125 : 100 });
      }
      assert.equal((await changeRegistryCapital(installed, directory, changed)).replayed, true);
      await assert.rejects(changeRegistryCapital(installed, directory, { ...changed, engines: inventory.map((engine) =>
        ({ ...engine, executor_shard_id: "executor-02" })) }), /CAP_CHANGE_DENIED/);
      await changeRegistryCapital(installed, directory, { ...scope, engines: inventory.map((engine) => ({ ...engine,
        expected_hard_cap_quote: engine.target_hard_cap_quote, target_hard_cap_quote: 100 })),
        expected_account_cap_quote: 425, target_account_cap_quote: 400 });
      assert.deepEqual((await loadCombinedRegistry(installed, directory)).engines, before);
    }
  } finally { await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true }))); }
});
