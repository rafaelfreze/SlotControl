import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { engineCatalogAccount, type EngineCatalogAccount } from "../execution/engine-account-catalog.ts";

const account = (id: string, shard: string, environment: "REAL" | "TESTNET" = "REAL"):
  EngineCatalogAccount => ({ id, display_name: id, status: "INACTIVE", kill_switch: true,
    is_legacy_default: false, onboarding_environment: environment, executor_shard_id: shard });
const passed = (environment: "REAL" | "TESTNET" = "REAL") => ({ status: "PASS",
  evidence: { status: "PASS", environment } });

test("new account on shard N appears in its environment before credential validation, without permitting configuration", () => {
  const elizelena = engineCatalogAccount(account("Elizelena", "executor-02"), null);
  assert.equal(elizelena.environment, "REAL");
  assert.equal(elizelena.executor_shard_id, "executor-02");
  assert.equal(elizelena.credentialValidated, false);
  assert.equal(engineCatalogAccount(account("future-1000", "executor-123"), passed()).credentialValidated, true);
});

test("executor 01 → 02 → 01 selection never reuses account credential or environment", () => {
  const accounts = [account("Rafael", "executor-01"), account("Elizelena", "executor-02")];
  const lookup = (id: string) => accounts.map((item) =>
    engineCatalogAccount(item, item.id === id ? passed() : null)).find((item) => item.id === id);
  assert.deepEqual([lookup("Rafael")?.executor_shard_id, lookup("Elizelena")?.executor_shard_id,
    lookup("Rafael")?.executor_shard_id], ["executor-01", "executor-02", "executor-01"]);
  assert.equal(engineCatalogAccount(accounts[1], passed("TESTNET")).credentialValidated, false);
  assert.equal(engineCatalogAccount(accounts[1], null).credentialValidated, false);
});

test("admin route pages accounts and scopes engine, credential and run reads to the selected account", () => {
  const route = readFileSync(new URL("../../app/api/coinops-engine-control/route.ts", import.meta.url), "utf8");
  const panel = readFileSync(new URL("../../app/automacao/engine-control-center.tsx", import.meta.url), "utf8");
  assert.match(route, /range\(offset, offset \+ 499\)/);
  assert.match(route, /!item\.onboarding_environment \|\| item\.id === accountId/);
  assert.match(route, /request\.nextUrl\.searchParams\.get\("accountId"\)/);
  assert.match(route, /if \(accountId && !accountRows\.some/);
  assert.match(route, /\.eq\("exchange_account_id", accountId\)\.eq\("check_key", "BINANCE_CREDENTIAL"\)/);
  assert.match(route, /\.eq\("operator_id", operator\.id\)\.eq\("exchange_account_id", accountId\)/);
  assert.match(panel, /url\.searchParams\.set\("accountId", accountId\)/);
  assert.match(panel, /item\.exchange_account_id === accountId/);
  assert.match(panel, /refreshSequence\.current/);
});

test("duplicate Binance key remains rejected and the UI explains how to use an account-specific key", () => {
  const executor = readFileSync(new URL("../../../live-executor/src/server.mjs", import.meta.url), "utf8");
  const panel = readFileSync(new URL("../../app/automacao/binance-accounts-panel.tsx", import.meta.url), "utf8");
  assert.match(executor, /EXECUTOR_CREDENTIAL_ALREADY_BOUND/);
  assert.match(panel, /code === "EXECUTOR_CREDENTIAL_ALREADY_BOUND"/);
  assert.match(panel, /API exclusiva na Binance da conta selecionada/);
});
