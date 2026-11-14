import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as topology from "./engine-slot-topology.ts";
import * as unsentTp from "./live-unsent-tp-recovery.ts";
import { AccountOrderNotSubmitted } from "./account-order-unsent-proof.ts";

test("real reconciler fences a dispatched TP, consumes exact proof under lease, and submits its original identity once", async () => {
  for (const denied of [false, true]) {
    const calls: string[] = [], now = Date.now();
    const scope = { product_id: "p", tenant_id: "t", user_id: "u", operator_id: "op", exchange_account_id: "account", trading_engine_id: "engine", quote_asset: "BRL" };
    const run = { ...scope, id: "run", symbol: "SOLBRL", asset: "SOL", lease_owner: "lease", engine: { slot_count: 25 } };
    const order = { ...scope, id: "tp", run_id: "run", slot_id: "slot17", slot_number: 17, operation_sequence: 1,
      side: "SELL", purpose: "TP", status: "PREPARED", client_order_id: "original-tp", exchange_order_id: null,
      executed_quantity: 0, cumulative_quote: 0, submission_guarded_at: new Date(now - 180_000).toISOString(),
      strategy_decision_id: "decision", requested_quantity: .027, requested_quote: null, price: 425.2,
      reserved_notional_brl: 0, trades_reconciled: false, config_snapshot: {}, account_order_unsent_receipt: null };
    const decision = { decision_id: "decision", cycle_id: "run", slot_id: "slot17", operation_sequence: 1,
      action_type: "CREATE_TP", result: "DISPATCHED", dispatched_at: new Date(now - 179_000).toISOString(), exchange_ack_at: null, completed_at: null };
    const receipt = { ...scope, executor_shard_id: "executor-01", environment: "REAL", symbol: "SOLBRL", clientOrderId: "original-tp",
      decision_id: "decision", request_nonce: "verified-native-nonce", protocol: 1 as const, outcome: "NOT_SUBMITTED" as const,
      bodyHash: "a".repeat(64), observedAt: now };
    const observed = { clientOrderId: "original-tp", orderId: "42", symbol: "SOLBRL", side: "SELL", status: "NEW", executedQuantity: 0, cumulativeQuoteQuantity: 0 };
    const ledger = { slots: [], accounts: [], orders: [order, { slot_id: "slot17", operation_sequence: 1, side: "BUY", id: "buy",
      client_order_id: "original-buy", exchange_order_id: "41", executed_quantity: .027 }] };
    const service = { from(table: string) {
      const chain = { select: () => chain, eq: () => chain,
        maybeSingle: async () => ({ error: null, data: decision }),
        single: async () => ({ error: null, data: table === "robot_v1_live_preparations"
          ? { live_enabled: true, kill_switch: true, max_total_exposure_brl: 275 } : decision }) };
      return chain;
    }, rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push(name); assert.equal(args.p_lease_owner, "lease");
      if (name === "release_proven_unsent_account_order") {
        assert.equal(args.p_client_order_id, "original-tp"); assert.deepEqual(args.p_proof, receipt);
        decision.result = "PENDING"; return { error: null, data: true };
      }
      if (name === "claim_proven_unsent_account_order") { assert.equal(args.p_proof_nonce, receipt.request_nonce); return { error: null, data: new Date().toISOString() }; }
      assert.equal(name, "sync_robot_v1_live_order"); assert.equal(args.p_order_id, "tp"); assert.equal(args.p_exchange_order_id, "42");
      return { error: null, data: { ...order, status: "NEW", exchange_order_id: "42" } };
    } };
    const deps: Record<string, unknown> = {
      "./engine-slot-topology": topology, "./live-unsent-tp-recovery": unsentTp,
      "./live-unsent-entry-recovery": { mayAttestUnsentEntry: () => false },
      "./account-order-unsent-proof": { AccountOrderNotSubmitted },
      "./robot-v1-live-cycle": { LIVE_TERMINAL_ORDER_STATUSES: new Set(["FILLED"]), LIVE_ACTIVE_ORDER_STATUSES: new Set(["PREPARED", "NEW"]) },
      "./live-reconciliation-shortcut": { unchangedUnfilledResidentOrder: () => false },
      "./partial-entry-recovery": { partialEntryRecoveryIntent: () => null },
      "./market-entry-policy": { marketEntryIntent: () => null },
      "./live-executor-health": { loadLiveEngineExecutorStatus: async () => ({ gate: "LIVE_EXECUTOR_PROTECTED", health: { unsent_tp_recovery_protocol: 1 } }) },
      "./live-executor-transport": { readLiveExecutorOrder: async () => ({ order: null }),
        proveLiveExecutorUnsentOrder: async (...args: unknown[]) => { calls.push("proof"); assert.equal(args[1], "original-tp"); assert.equal(args[6], "SELL");
          if (denied) throw Error("CLAIM_UNPROVEN"); throw new AccountOrderNotSubmitted(receipt); },
        readLiveExecutorState: async () => ({ filters: { priceTick: .1 }, bnb_brl_price: null }),
        createLiveExecutorOrder: async (input: Record<string, unknown>) => { calls.push("POST"); assert.equal(input.clientOrderId, "original-tp");
          assert.equal(input.sourceBuyClientOrderId, "original-buy"); assert.equal(input.price, "425.2"); assert.equal(input.quantity, "0.027"); return { order: observed }; },
        readLiveExecutorTrades: async () => ({ order: observed, trades: [] }) },
      "./account-order-budget-server": { accountExecutionPolicyRequired: async () => false, reserveAccountOrderDispatch: async () => null, acknowledgeAccountOrderDispatch: async () => {} },
      "./strategy-decision-server": { completeStrategyDecision: async () => calls.push("COMPLETED") },
    };
    const compiled = ts.transpileModule(readFileSync(new URL("./robot-v1-live-server.ts", import.meta.url), "utf8"),
      { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const exports: Record<string, unknown> = {};
    new Function("require", "exports", "ledger", compiled + `
      validateRunEngine=async()=>{}; renewLease=async()=>{}; runRows=async()=>ledger;
      assertLiveOrderPrice=()=>{}; assertExchangeMatchesLedger=async()=>[]; quoteCap=async()=>275;
      exposure=async()=>({SOL:100,global:100}); exports.reconcile=reconcileOrder;
    `)((name: string) => deps[name] ?? {}, exports, ledger);
    const reconcile = exports.reconcile as (service: unknown, run: unknown, order: unknown) => Promise<unknown>;
    if (denied) { await assert.rejects(reconcile(service, run, order), /SUBMISSION_OUTCOME_UNKNOWN/); assert.deepEqual(calls, ["proof"]); }
    else { await reconcile(service, run, order); assert.deepEqual(calls, ["proof", "release_proven_unsent_account_order", "claim_proven_unsent_account_order", "POST", "sync_robot_v1_live_order", "COMPLETED"]); }
  }
});
