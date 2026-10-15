import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

// Optional read-only historical source proves the same harness detects the
// pre-fix race without ever replacing the working application's source file.
const historical = process.env.COINOPS_FUNDING_EFFECT_REVISION;
if (historical && !/^[0-9a-f]{7,40}$/i.test(historical)) throw new Error("INVALID_TEST_SOURCE_REVISION");
const source = historical
  ? execFileSync("git", ["show", `${historical}:apps/web/app/automacao/premium-automation.tsx`], { encoding: "utf8" })
  : readFileSync(new URL("./premium-automation.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("premium-automation.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const effects: ts.ArrowFunction[] = [];
function collect(node: ts.Node) {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === "useEffect"
    && node.arguments[0] && ts.isArrowFunction(node.arguments[0])) effects.push(node.arguments[0]);
  ts.forEachChild(node, collect);
}
collect(ast);
const readEffect = effects.find((effect) => effect.body.getText(ast).includes("setQuoteBalances(null)"));
assert.ok(readEffect, "the production funding read effect must exist");
const unmountEffect = effects.find((effect) => effect !== readEffect
  && effect.body.getText(ast).includes("balanceRequest.current") && effect.body.getText(ast).includes("abort"));

type Cleanup = void | (() => void);
function evaluate(effect: ts.ArrowFunction, bindings: Record<string, unknown>): () => Cleanup {
  const javascript = ts.transpileModule(`const callback = ${effect.getText(ast)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function(...Object.keys(bindings), `${javascript}\nreturn callback;`)(...Object.values(bindings));
}

type PendingRead = { url: string; signal: AbortSignal; options: RequestInit;
  resolve: (result: { ok: boolean; json: () => Promise<unknown> }) => void; reject: (error: unknown) => void };

function harness() {
  let clock = Date.parse("2026-10-15T22:00:00Z");
  let cleanup: Cleanup, unmountCleanup: Cleanup;
  const calls: PendingRead[] = [], timeouts: AbortController[] = [];
  const state: Record<string, unknown> = {};
  const refs = { fundingAttempts: { current: new Map<string, number>() },
    fundingResults: { current: new Map<string, unknown[]>() },
    fundingAlertSignatures: { current: new Map<string, string>() },
    lastFundingRefresh: { current: 0 }, fundingAccount: { current: null as string | null },
    balanceRequest: { current: null as unknown } };
  let props = { accountId: "A", view: "live", fundingRefresh: 0, fundingAlertSignature: "" };
  const bindings = () => ({ ...refs, selection: { accountId: props.accountId }, view: props.view,
    fundingRefresh: props.fundingRefresh, fundingAlertSignature: props.fundingAlertSignature,
    Date: { now: () => clock }, AbortController,
    AbortSignal: { any: (signals: AbortSignal[]) => AbortSignal.any(signals), timeout: () => {
      const controller = new AbortController(); timeouts.push(controller); return controller.signal;
    } },
    fetch: (url: string, options: RequestInit) => new Promise((resolve, reject) => {
      calls.push({ url, options, signal: options.signal!, resolve, reject });
    }),
    setQuoteBalances: (value: unknown) => { state.quoteBalances = value; },
    setFundingLoading: (value: unknown) => { state.loading = value; },
    setFundingError: (value: unknown) => { state.error = value; },
    setFundingRefreshAvailableAt: (value: unknown) => { state.availableAt = value; },
    setFunding: (value: unknown) => { state.funding = value; },
  });
  if (unmountEffect) unmountCleanup = evaluate(unmountEffect, bindings())();
  const render = (changes: Partial<typeof props> = {}) => {
    props = { ...props, ...changes }; cleanup?.(); cleanup = evaluate(readEffect!, bindings())();
  };
  const respond = async (index: number, accountId: string, extra: Record<string, unknown> = {}) => {
    calls[index].resolve({ ok: true, json: async () => ({ balances: [{ accountId, free: 200 }],
      funding: [{ accountId, currency: "BRL", marker: `read-${index}` }], ...extra }) });
    await flush();
  };
  return { calls, state, refs, timeouts, render, respond,
    advance: (milliseconds: number) => { clock += milliseconds; },
    unmount: () => { cleanup?.(); unmountCleanup?.(); } };
}

const flush = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };

test("same-account health snapshot rerenders preserve the pending bounded full funding GET", async () => {
  const h = harness(); h.render();
  assert.match(h.calls[0].url, /account=A&funding=1$/);
  const originalBudget = h.state.availableAt;
  h.advance(1_000); h.render(); h.advance(1_000); h.render();
  assert.equal(h.calls.length, 1, "health snapshots must not abort and replace the expensive read");
  assert.equal(h.calls[0].signal.aborted, false);
  assert.equal(h.state.loading, true);
  assert.equal(h.state.availableAt, originalBudget);
  await h.respond(0, "A");
  assert.deepEqual(h.state.funding, { accountId: "A", summaries: [{ accountId: "A", currency: "BRL", marker: "read-0" }] });
  assert.equal(h.state.loading, false); assert.equal(h.state.error, false);
  h.unmount();
});

test("an explicit refresh survives snapshot rerenders without consuming another cooldown", async () => {
  const h = harness(); h.render(); await h.respond(0, "A");
  h.advance(60_001); h.render({ fundingRefresh: 1 });
  assert.match(h.calls[1].url, /account=A&funding=1$/);
  const budget = h.state.availableAt;
  h.advance(500); h.render(); h.advance(500); h.render({ fundingAlertSignature: "new-warning" });
  assert.equal(h.calls.length, 2); assert.equal(h.calls[1].signal.aborted, false);
  assert.equal(h.state.availableAt, budget); assert.equal(h.state.loading, true);
  await h.respond(1, "A");
  assert.deepEqual(h.state.funding, { accountId: "A", summaries: [{ accountId: "A", currency: "BRL", marker: "read-1" }] });
  h.unmount();
});

test("account changes abort the old request and ignore late results from its financial scope", async () => {
  const h = harness(); h.render(); h.render({ accountId: "B" });
  assert.equal(h.calls[0].signal.aborted, true);
  assert.match(h.calls[1].url, /account=B&funding=1$/);
  await h.respond(1, "B"); const before = structuredClone(h.state);
  await h.respond(0, "A"); assert.deepEqual(h.state, before);
  assert.deepEqual(h.state.funding, { accountId: "B", summaries: [{ accountId: "B", currency: "BRL", marker: "read-1" }] });
  h.unmount();
});

test("the old account's finally cannot clear the new account's still-pending request", async () => {
  const h = harness(); h.render(); h.render({ accountId: "B" });
  const pendingB = h.refs.balanceRequest.current, before = structuredClone(h.state);
  await h.respond(0, "A");
  assert.deepEqual(h.state, before); assert.equal(h.refs.balanceRequest.current, pendingB);
  assert.equal(h.state.loading, true); assert.equal(h.calls[1].signal.aborted, false);
  h.render(); assert.equal(h.calls.length, 2); assert.equal(h.refs.balanceRequest.current, pendingB);
  await h.respond(1, "B");
  assert.deepEqual(h.state.funding, { accountId: "B", summaries: [{ accountId: "B", currency: "BRL", marker: "read-1" }] });
  assert.equal(h.refs.balanceRequest.current, null); h.unmount();
});

test("ALL and non-live views abort account reads without issuing a broad funding query", async () => {
  for (const changes of [{ accountId: "ALL" }, { view: "shadow" }, { view: "testnet" }]) {
    const h = harness(); h.render(); h.render(changes);
    assert.equal(h.calls.length, 1); assert.equal(h.calls[0].signal.aborted, true);
    const before = structuredClone(h.state);
    await h.respond(0, "A"); assert.deepEqual(h.state, before);
    assert.equal(h.state.loading, false); h.unmount();
  }
});

test("changing live view invalidates the old scope rather than attaching its stale completion", async () => {
  const h = harness(); h.render(); h.render({ view: "overview" });
  assert.equal(h.calls[0].signal.aborted, true);
  assert.equal(h.calls.length, 2);
  await h.respond(1, "A", { funding: undefined }); const before = structuredClone(h.state);
  await h.respond(0, "A"); assert.deepEqual(h.state, before);
  h.unmount();
});

test("unmount aborts the actual still-pending read even after snapshot-only rerenders", async () => {
  const h = harness(); h.render(); h.render(); h.unmount();
  assert.equal(h.calls[0].signal.aborted, true);
  const before = structuredClone(h.state);
  await h.respond(0, "A"); assert.deepEqual(h.state, before);
});

test("timeout or read errors remain visible and do not trigger hidden retries or trading writes", async () => {
  for (const timedOut of [false, true]) {
    const h = harness(); h.render();
    if (timedOut) h.timeouts[0].abort(new DOMException("Timeout", "TimeoutError"));
    h.calls[0].reject(new Error(timedOut ? "TimeoutError" : "READ_UNAVAILABLE")); await flush();
    assert.equal(h.state.loading, false); assert.equal(h.state.error, true);
    assert.equal(h.calls.length, 1); assert.equal(h.refs.balanceRequest.current, null);
    assert.deepEqual(h.state.quoteBalances, []);
    assert.ok(h.calls.every((call) => call.options.cache === "no-store"
      && (!call.options.method || call.options.method === "GET")
      && call.url.startsWith("/api/coinops-live-balances?account=")));
    h.unmount();
  }
});
