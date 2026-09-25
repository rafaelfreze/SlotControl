import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const route = readFileSync(new URL("../../app/api/coinops-engine-control/route.ts", import.meta.url), "utf8");
const panel = readFileSync(new URL("../../app/automacao/engine-control-center.tsx", import.meta.url), "utf8");

test("engine actions accept supported Testnet quotes without allowing USDC in Production", () => {
  assert.match(route, /environment === "TESTNET" \? \["USDC", "USDT"\] : \["BRL", "USDT"\]/);
  assert.match(route, /if \(environment === "TESTNET"\) \{/);
  assert.match(route, /if \(environment === "TESTNET" \? plan\.quote === "BRL" : plan\.quote === "USDC"\)/);
});

test("Testnet activation without a persisted cycle stays blocked until panel recovery proves an empty ledger and exchange", () => {
  assert.match(route, /input\.action === "RECOVER"/);
  assert.match(route, /engine\.status !== "ACTIVE" \|\| !engine\.engine_kill_switch/);
  assert.match(route, /from\("robot_v1_testnet_runs"\)\.select\("id"\)/);
  assert.match(route, /from\("robot_v1_testnet_orders"\)\.select\("id"\)/);
  assert.match(route, /snapshot\.markets\[0\]\.open_orders\.length/);
  assert.match(route, /checkTradePermission\(engine\.symbol, slotNotional\)/);
  assert.match(route, /COINOPS_ENGINE_RECOVERY_CAP_UNSAFE/);
  assert.match(route, /\.eq\("environment", "TESTNET"\)/);
  assert.match(panel, /BLOQUEADO · SEM CICLO/);
  assert.match(panel, /Recuperar READY/);
});
