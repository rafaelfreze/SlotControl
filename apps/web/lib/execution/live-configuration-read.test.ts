import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as reads from "./live-ledger-read.ts";
import * as errors from "./live-read-error.ts";

/** Exercise the real configuration GETs/catch path. No network or exchange
 * write is available; any database mutation at this boundary fails the test. */
function fixture(options: { engine?: string; resource?: string; status?: number; code?: string;
  persistent?: boolean; pending?: boolean; missing?: boolean; malformed?: boolean; queued?: boolean } = {}) {
  const engine = options.engine ?? "a";
  const scope = { product_id: "product", tenant_id: "tenant", user_id: "user", operator_id: "op",
    exchange_account_id: "same-account", trading_engine_id: engine, quote_asset: "BRL", symbol: "SOLBRL" };
  const run = { ...scope, id: `run-${engine}`, asset: "SOL", strategy_version: "fixture", engine: scope };
  const counts: Record<string, number> = {};
  const effects: Array<{ kind: string; evidence?: unknown }> = [];
  const service = { from(table: string) {
    const filters: Record<string, unknown> = {};
    let deadline: AbortSignal | undefined;
    const result = () => {
      assert.ok(deadline instanceof AbortSignal);
      counts[table] = (counts[table] ?? 0) + 1;
      if (table === "strategy_bulk_engine_updates") {
        assert.equal(filters.trading_engine_id, engine); assert.equal(filters.run_id, run.id);
        assert.deepEqual(filters.status, ["PENDING", "APPLYING"]);
      } else if (table === "trading_engines") {
        assert.equal(filters.id, engine); assert.equal(filters.operator_id, "op");
        assert.equal(filters.exchange_account_id, "same-account");
      } else if (table === "robot_v1_live_preparations") {
        assert.equal(filters.trading_engine_id, engine); assert.equal(filters.user_id, "user");
      } else if (table === "account_quote_caps") {
        assert.equal(filters.exchange_account_id, "same-account"); assert.equal(filters.quote_asset, "BRL");
      } else assert.equal(table, "operators");
      if (table === options.resource && (counts[table] === 1 || options.persistent))
        return { data: null, error: { code: options.code ?? "", message: "TypeError: fetch failed PRIVATE", details: "PRIVATE" },
          status: options.status ?? 503 };
      const data = table === "strategy_bulk_engine_updates" ? options.queued ? [{ ...scope, run_id: "other-run" }] : []
        : options.missing ? null : table === "trading_engines"
          ? { strategy_config_pending: options.malformed ? undefined : options.pending ?? false }
        : table === "account_quote_caps" ? { hard_cap_quote: options.malformed ? -1 : 500 }
        : table === "operators" ? scope : { ...scope, id: "prep" };
      return { data, error: null, status: 200 };
    };
    const chain = {
      select: () => chain, eq: (k: string, v: unknown) => { filters[k] = v; return chain; },
      in: (k: string, v: unknown) => { filters[k] = v; return chain; }, order: () => chain, limit: () => chain,
      abortSignal: (signal: AbortSignal) => { deadline = signal; return chain; },
      single: async () => result(), then: (resolve: (r: unknown) => unknown) => Promise.resolve(result()).then(resolve),
      update: () => assert.fail("GET retry cannot mutate"), upsert: () => assert.fail("GET retry cannot mutate"),
    };
    return chain;
  } };
  const compiled = ts.transpileModule(readFileSync(new URL("./robot-v1-live-server.ts", import.meta.url), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const deps: Record<string, unknown> = { "./live-ledger-read": reads, "./live-read-error": errors,
    "./strategy-engine": { STRATEGY_VERSION: "fixture" },
    "./strategy-parameter-registry": { strategyParameter: () => ({ applyPolicy: "CURRENT_LADDER", requiresOrderReconciliation: true }) },
    "./account-order-budget-server": { AccountOrderBudgetHold: class extends Error {} },
    "../supabase/env": { getSupabaseDataSchema: () => "coinops", getCoinOpsServiceTenantId: () => "tenant" },
    "../supabase/service-role": { createServiceRoleClient: () => service },
    "./operator-context-server": { resolveOperatorEngine: async () => scope },
    "./operator-context": { assertRowEngine: (row: typeof scope) => assert.equal(row.trading_engine_id, engine) } };
  const exported: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  // Stub unrelated trading stages only. The original CONFIG_UPDATE GET, gate
  // and error handler remain real; mutations are observed, not executed.
  const harness = `
    exports.checkpoint=()=>applyPendingStrategyUpdate(service,run,{},{});
    exports.gate=()=>configUpdatePending(service,run);
    exports.cap=()=>quoteCap(service,run);
    exports.preparation=()=>scopedPreparation(service,'user','SOL',{trading_engine_id:run.trading_engine_id});
    claim=async()=>run; validateRunEngine=async()=>{}; runRows=async()=>({orders:[],slots:[],accounts:[]});
    readLiveExecutorState=async()=>({}); assertLiveResidentPrices=()=>{}; ensureTakeProfits=async()=>{};
    creditClosedSlots=async()=>{}; recycleClosedSlots=async()=>{}; assertAllPositionsProtected=async()=>{};
    holdTransientExecutorRead=async(_s,_r,evidence)=>{effects.push({kind:'checkpoint',evidence});return true;};
    markBulkUpdateBlocked=async()=>effects.push({kind:'blocked-edit'});
    preventNewBuys=async()=>effects.push({kind:'kill'}); release=async()=>{};
    exports.advance=()=>advanceLiveRunOnce(run.id,'LIVE_CRON');
  `;
  // readLiveExecutorState is an imported binding in the compiled module.
  const executableHarness = harness.replace("readLiveExecutorState=async()=>({});", "live_executor_transport_1.readLiveExecutorState=async()=>({});");
  new Function("require", "exports", "service", "run", "effects", compiled + executableHarness)
    ((name: string) => deps[name] ?? {}, exported, service, run, effects);
  const api = exported as Record<"checkpoint" | "gate" | "cap" | "preparation" | "advance", () => Promise<unknown>>;
  return { ...api, counts, effects };
}

test("checkpoint 503 then authoritative empty result stays NONE, isolated by engine/run across shards", async () => {
  for (const engine of ["a", "b"]) {
    const f = fixture({ engine, resource: "strategy_bulk_engine_updates" });
    assert.equal(await f.checkpoint(), "NONE");
    assert.equal(f.counts.strategy_bulk_engine_updates, 2); assert.deepEqual(f.effects, []);
  }
});

test("required config gate/cap/preparation GETs share bounded read policy, no missing-data fallback", async () => {
  for (const [method, resource] of [["gate", "trading_engines"], ["cap", "account_quote_caps"],
    ["preparation", "robot_v1_live_preparations"], ["preparation", "operators"]] as const) {
    const f = fixture({ resource });
    await f[method](); assert.equal(f.counts[resource], 2);
    for (const failure of [{ missing: true }, { status: 403, code: "42501", persistent: true }]) {
      const denied = fixture({ resource, ...failure });
      await assert.rejects(denied[method](), /UNAVAILABLE|LEDGER_READ_FAILED/);
    }
  }
  await assert.rejects(fixture({ malformed: true }).gate(), /GATE_UNAVAILABLE/);
  await assert.rejects(fixture({ malformed: true }).cap(), /CAP_UNAVAILABLE/);
  assert.equal(await fixture({ pending: true }).gate(), true);
  await assert.rejects(fixture({ queued: true }).checkpoint(), /SCOPE_OR_GATE_INVALID/);
});

test("exhausted checkpoint outage stays normal reconciling, with diagnostics, never marks a real edit blocked", async () => {
  const f = fixture({ resource: "strategy_bulk_engine_updates", persistent: true });
  assert.deepEqual(await f.advance(), { status: "RETRY", code: "COINOPS_LIVE_TRANSIENT_LEDGER_READ" });
  assert.equal(f.counts.strategy_bulk_engine_updates, 2);
  assert.equal(f.effects.length, 1); assert.equal(f.effects[0].kind, "checkpoint");
  assert.deepEqual(f.effects[0].evidence, { stage: "CONFIG_UPDATE", source: "ENGINE",
    root_code: "COINOPS_LIVE_LEDGER_READ_UNAVAILABLE", read_path: "ledger/bulk_checkpoint", read_attempts: 2, http_status: 503 });
  assert.ok(!JSON.stringify(f.effects).includes("PRIVATE"));
});

test("permission/schema failure is never retried or silently healed", async () => {
  for (const code of ["42501", "PGRST204", "42P01"]) {
    const f = fixture({ resource: "strategy_bulk_engine_updates", persistent: true, status: 503, code });
    await assert.rejects(f.checkpoint(), errors.LiveLedgerReadFailed);
    assert.equal(f.counts.strategy_bulk_engine_updates, 1); assert.deepEqual(f.effects, []);
  }
});
