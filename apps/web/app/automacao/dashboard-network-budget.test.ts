import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { createClient } from "@supabase/supabase-js";

const id = "00000000-0000-4000-8000-000000000001";
const historicalTables = ["robot_v1_configs", "robot_v1_cycles", "robot_v1_slots", "robot_v1_slot_operations",
  "robot_v1_slot_accounts", "robot_v1_audit_events", "robot_v1_market_candles"];

function fixture() {
  const reads: Array<{ table: string; url: URL }> = [];
  const db = createClient("https://fixture.invalid", "fixture-public-key", {
    db: { schema: "coinops" }, auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (input, init) => {
      const url = new URL(String(input));
      assert.equal(init?.method, "GET", "dashboard observations cannot mutate trading state");
      assert.equal(new Headers(init?.headers).get("accept-profile"), "coinops");
      reads.push({ table: url.pathname.split("/").at(-1)!, url });
      return Response.json([]);
    } },
  });
  return { db, reads };
}

function evaluate(body: string, names: string[], values: unknown[]) {
  const compiled = ts.transpileModule(body, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  return new Function(...names, compiled)(...values);
}

test("actual Home base reads send five LIVE requests instead of seven empty historical requests", async () => {
  const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
  const start = page.indexOf("  const [connectionResponse, runsResponse,");
  const end = page.indexOf("  const shadowReadError", start);
  assert.ok(start > 0 && end > start);
  for (const historical of [false, true]) {
    const { db, reads } = fixture();
    await evaluate(`return (async () => { ${page.slice(start, end)} })();`,
      ["supabase", "loadHistoricalEnvironments", "productId", "tenantId", "user", "legacyAccount", "legacyEngineIds", "registry"],
      [db, historical, id, id, { id }, { id }, [id], { engines: [{ id }] }]);
    assert.equal(reads.length, historical ? 12 : 5);
    assert.deepEqual(reads.filter((read) => historicalTables.includes(read.table)).map((read) => read.table).sort(),
      historical ? historicalTables.toSorted() : []);
    for (const { table, url } of reads.filter((read) => historicalTables.includes(read.table))) {
      assert.equal(url.searchParams.get("exchange_account_id"), `eq.${id}`, table);
      assert.equal(url.searchParams.get("trading_engine_id"), `in.(${id})`, table);
      assert.notEqual(url.searchParams.get("limit"), "0");
    }
  }
});

test("independent metadata reads begin before their later consumer awaits them", async () => {
  for (const [file, variable, tables] of [
    ["./page.tsx", "manualAdjustmentsPromise", ["robot_v1_manual_adjustments"]],
    ["./operator-presentation-server.ts", "capsPromise", ["account_quote_caps"]],
    ["./page.tsx", "legacyPreparationPromise", ["robot_v1_live_preparations", "robot_v1_live_global_caps",
      "robot_v1_live_slot_accounts", "robot_v1_manual_adjustments"]],
  ] as const) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let declaration = "";
    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && node.name.getText(tree) === variable) declaration = node.getText(tree);
      ts.forEachChild(node, visit);
    };
    visit(tree);
    assert.ok(declaration, variable);
    const { db, reads } = fixture();
    const result = evaluate(`const ${declaration}; return { request: ${variable} };`,
      ["supabase", "client", "productId", "tenantId", "user", "registry", "legacyAccount", "legacyEngineIds", "productionPromise", "executorPromise"],
      [db, db, id, id, { id }, { operator: { id }, engines: [{ id }] }, { id }, [id], Promise.resolve(null), Promise.resolve(null)]) as { request: PromiseLike<unknown> };
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(reads.length, tables.length, "a lazy builder must not add a serial round trip");
    assert.deepEqual(reads.map((read) => read.table).sort(), tables.toSorted());
    await result.request;
    assert.equal(reads.length, tables.length, "later await must not execute the query a second time");
  }
});
