import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import * as validation from "../execution/live-adjustment-validation.ts";
import * as plans from "../execution/live-adjustment-plans.ts";
import { isIdentity } from "../execution/operator-context.ts";

const { getLiveAdjustmentReasonError, liveAdjustmentErrorMessage } = validation;
const required = "COINOPS_ADJUSTMENT_REASON_REQUIRED";
const invalid = "COINOPS_ADJUSTMENT_REASON_INVALID";
const accountId = "11111111-1111-4111-8111-111111111111";
const otherAccountId = "22222222-2222-4222-8222-222222222222";
const engineId = "33333333-3333-4333-8333-333333333333";
const requestId = "44444444-4444-4444-8444-444444444444";
const routeSource = readFileSync(new URL("../../app/api/coinops-live-adjustments/route.ts", import.meta.url), "utf8");
const uiSource = readFileSync(new URL("../../app/automacao/live-adjustments-center.tsx", import.meta.url), "utf8");

test("empty, whitespace, null and missing reasons are explicitly required", () => {
  for (const reason of ["", " ", "\n\t\r ", "\u00a0", null, undefined]) {
    assert.equal(getLiveAdjustmentReasonError(reason), required);
  }
});

test("non-string and trimmed lengths outside 3..160 are invalid without throwing", () => {
  for (const reason of [1, 0, false, true, {}, [], ["aporte"], new String("aporte"),
    "a", "ab", "  ab  ", "x".repeat(161), `  ${"x".repeat(161)}  `]) {
    assert.equal(getLiveAdjustmentReasonError(reason), invalid);
  }
});

test("valid reason boundaries ignore surrounding whitespace and preserve audit input", () => {
  for (const reason of ["abc", "  abc\n", "Aporte adicional", "x".repeat(160), `\t${"x".repeat(160)}  `]) {
    const before = reason;
    assert.equal(getLiveAdjustmentReasonError(reason), null);
    assert.equal(reason, before);
  }
});

test("known input errors are actionable Portuguese; unrelated errors retain their evidence code", () => {
  for (const code of [required, invalid]) {
    const message = liveAdjustmentErrorMessage(code);
    assert.match(message, /motivo/i);
    assert.match(message, /3.*160/);
    assert.doesNotMatch(message, /COINOPS_/);
  }
  assert.match(liveAdjustmentErrorMessage("COINOPS_ADJUSTMENT_INPUT_INVALID"), /conta.*moeda/i);
  for (const code of ["COINOPS_ADJUSTMENT_CAP_SYNC_PENDING", "COINOPS_ADJUSTMENT_REPLAY_CONFLICT",
    "COINOPS_ADJUSTMENT_ORDER_UNCERTAIN", "EXECUTOR_UNAVAILABLE"]) {
    assert.equal(liveAdjustmentErrorMessage(code), code);
  }
});

function routeHarness() {
  const forbiddenCalls: string[] = [];
  const deny = (name: string) => { forbiddenCalls.push(name); throw new Error(`UNEXPECTED_${name}`); };
  const operatorQuery = { select() { return this; }, eq() { return this; },
    async single() { return { data: { id: "operator-fixture", user_id: "admin-fixture",
      product_id: "product-fixture", tenant_id: "tenant-fixture", kill_switch: false }, error: null }; } };
  const modules: Record<string, unknown> = {
    "node:crypto": { createHash },
    "next/server": { NextResponse: { json: (body: unknown, init: { status: number }) => ({ body, status: init.status }) } },
    "next/cache": { revalidatePath: () => deny("REVALIDATION") },
    "@/lib/execution/live-adjustment-plans": plans,
    "@/lib/execution/selective-contribution-presets": { resolveSelectiveContributionPresetRegion: () => deny("PRESET_RESOLUTION") },
    "@/lib/execution/operator-executor-admin": { operatorAccountSnapshot: () => deny("EXCHANGE_READ"),
      operatorExecutorAdmin: () => deny("EXECUTOR_CALL") },
    "@/lib/execution/operator-context": { isIdentity },
    "@/lib/execution/live-adjustment-validation": validation,
    "@/lib/supabase/env": { getCoinOpsServiceTenantId: () => "tenant-fixture", getSupabaseDataSchema: () => "coinops" },
    "@/lib/supabase/service-role": { createServiceRoleClient: () => ({
      from: () => deny("LEDGER_READ"), rpc: () => deny("LEDGER_WRITE") }) },
    "@/lib/supabase/server": { createClient: () => ({
      auth: { getUser: async () => ({ data: { user: { id: "admin-fixture" } } }) },
      from: (table: string) => { assert.equal(table, "operators"); return operatorQuery; } }) },
  };
  const compiled = ts.transpileModule(routeSource, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  const exports: { POST?: (request: unknown) => Promise<{ body: { error: string }; status: number }>;
    __testInputGuard?: (draft: unknown) => void } = {};
  new Function("require", "exports", "process", "Buffer", "fetch", `${compiled}\nexports.__testInputGuard = inputGuard;`)(
    (id: string) => { assert.ok(id in modules, `Unexpected dependency ${id}`); return modules[id]; },
    exports, { env: { VERCEL_ENV: "production" } }, Buffer, () => deny("NETWORK"));
  return { forbiddenCalls, guard: exports.__testInputGuard!,
    post: (input: Record<string, unknown>) => exports.POST!({
      nextUrl: new URL("https://cripto-flax.vercel.app/api/coinops-live-adjustments"),
      headers: new Headers({ origin: "https://cripto-flax.vercel.app", "sec-fetch-site": "same-origin",
        "content-type": "application/json", "x-coinops-admin-intent": "live-adjustment" }),
      text: async () => JSON.stringify(input),
    }) };
}

test("shared real endpoint rejects invalid reasons before ledger, preview and executor for any account/currency", async () => {
  const runtime = routeHarness();
  for (const id of [accountId, otherAccountId]) for (const quote of ["BRL", "USDT"]) {
    for (const action of ["PREVIEW", "CONFIRM", "REVERSE_PREVIEW", "REVERSE_CONFIRM", "PLAN_SAVE", "PLAN_DISABLE"]) {
      for (const reason of [undefined, null, " ", "ab", {}, "x".repeat(161)]) {
        const response = await runtime.post({ action, accountId: id, quote, engineId, requestId,
          kind: "SELECTIVE_CAPITAL", amount: 5000, selectedSlots: [1, 2, 3, 4, 5], reason });
        assert.equal(response.body.error, getLiveAdjustmentReasonError(reason));
        assert.ok(response.status >= 400 && response.status < 500);
      }
    }
  }
  assert.deepEqual(runtime.forbiddenCalls, []);
});

test("valid reason leaves canonical account/currency and request-id guards unchanged", () => {
  const runtime = routeHarness();
  const draft = { accountId, requestId, quote: "BRL", reason: " Aporte adicional " };
  const before = structuredClone(draft);
  assert.doesNotThrow(() => runtime.guard(draft));
  assert.deepEqual(draft, before);
  for (const overrides of [{ accountId: "invalid" }, { requestId: "invalid" }, { quote: "USDC" }]) {
    assert.throws(() => runtime.guard({ ...draft, ...overrides }), /COINOPS_ADJUSTMENT_INPUT_INVALID/);
  }
  assert.deepEqual(runtime.forbiddenCalls, []);
});

test("5000 into slots 1..5 preserves 2 OPEN positions, exactly 2000 PENDING and 3000 APPLIED", () => {
  for (const asset of ["BTC", "SOL"]) for (const currency of ["BRL", "USDT"]) {
    assert.equal(getLiveAdjustmentReasonError("Aporte nos cinco slots selecionados"), null);
    const slots = Array.from({ length: 25 }, (_, index) => ({ asset, currency, slotNumber: index + 1,
      balanceBefore: 20, committed: index < 2 ? 20 : 0, open: index < 2,
      quantity: index < 2 ? 0.01 : 0, entryPrice: 100, tpPrice: 105,
      monthlyBefore: index < 2 ? 1 : 0, lifetimeBefore: index < 2 ? 3 : 0 }));
    const before = structuredClone(slots);
    const allocations = plans.allocateSelectedSlots(5000, engineId, [1, 2, 3, 4, 5]);
    assert.deepEqual(allocations.map((item) => item.amount), [1000, 1000, 1000, 1000, 1000]);
    const projected = allocations.map((item) => plans.projectSelectiveSlotContribution({
      ...slots[item.slotNumber - 1], amount: item.amount, gainUnits: 0,
    }));
    assert.deepEqual(projected.map((item) => item.allocationStatus), ["PENDING", "PENDING", "APPLIED", "APPLIED", "APPLIED"]);
    assert.deepEqual(projected.map((item) => item.balanceAfter), [20, 20, 1020, 1020, 1020]);
    assert.equal(projected.reduce((sum, item) => sum + item.pendingForNextOperation, 0), 2000);
    assert.equal(projected.reduce((sum, item) => sum + item.balanceAfter - item.balanceBefore, 0), 3000);
    for (const item of projected) {
      const previous = before[item.slotNumber - 1];
      assert.equal(item.committedAfter, previous.committed);
      assert.equal(item.quantity, previous.quantity);
      assert.equal(item.entryPrice, previous.entryPrice);
      assert.equal(item.tpPrice, previous.tpPrice);
      assert.equal(item.monthlyAfter, previous.monthlyBefore);
      assert.equal(item.lifetimeAfter, previous.lifetimeBefore);
    }
    assert.deepEqual(slots, before, "preview cannot mutate any of the 25 slots");
    assert.deepEqual(plans.allocateSelectedSlots(5000, engineId, [5, 4, 3, 2, 1]), allocations,
      "reason validation does not change deterministic retry distribution");
  }
});

test("UI focuses invalid reason before preview, exposes accessible guidance and preserves confirmation identity", () => {
  const preview = uiSource.slice(uiSource.indexOf("async function makePreview()"), uiSource.indexOf("async function confirm()"));
  assert.ok(preview.indexOf("getLiveAdjustmentReasonError(reason)") < preview.indexOf("const next = draft()"));
  assert.ok(preview.indexOf("reasonInput.current?.focus()") < preview.indexOf("await control(next)"));
  assert.match(preview, /setPreview\(null\); setPreviewDraft\(null\)/);
  assert.match(uiSource, /ref=\{reasonInput\}[^\n]+required minLength=\{3\} maxLength=\{160\}/);
  assert.match(uiSource, /aria-invalid=\{Boolean\(reasonError\)\} aria-describedby=\{reasonHelpId\}/);
  assert.match(uiSource, /liveAdjustmentErrorMessage\(result\.error/);
  const confirmation = uiSource.slice(uiSource.indexOf("async function confirm()"), uiSource.indexOf("async function previewReversal"));
  assert.match(confirmation, /control\(\{ \.\.\.previewDraft, action: "CONFIRM", previewHash: preview\.previewHash \}\)/);
  assert.match(routeSource, /p_request_id: input\.requestId/);
  assert.match(routeSource, /p_request_fingerprint: result\.previewHash/);
  const guard = routeSource.slice(routeSource.indexOf("function inputGuard("), routeSource.indexOf("async function loadAccount("));
  assert.doesNotMatch(guard, /executor-0[12]|Rafael|Thyely|is_legacy_default|BTC|SOL/i);
});
