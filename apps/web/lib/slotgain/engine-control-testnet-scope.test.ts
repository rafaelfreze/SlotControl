import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const route = readFileSync(new URL("../../app/api/coinops-engine-control/route.ts", import.meta.url), "utf8");

test("engine actions accept supported Testnet quotes without allowing USDC in Production", () => {
  assert.match(route, /environment === "TESTNET" \? \["USDC", "USDT"\] : \["BRL", "USDT"\]/);
  assert.match(route, /if \(environment === "TESTNET"\) \{/);
  assert.match(route, /if \(environment === "TESTNET" \? plan\.quote === "BRL" : plan\.quote === "USDC"\)/);
});
