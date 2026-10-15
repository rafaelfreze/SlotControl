import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const React = require("react");
const source = readFileSync(new URL("./account-pause-home-panel.tsx", import.meta.url), "utf8");
type Engine = { engineId: string; symbol: string; executorShardId: string; runId: string; runStatus: string; entryEnabled: boolean };
type Snapshot = { accountId: string; hidden: boolean; canHide: boolean; engines: Engine[] };
type Call = { url: string; body?: Record<string, string>; headers?: Record<string, string> };
type Element = { type?: string; props?: { children?: unknown; onClick?: () => void; disabled?: boolean; role?: string } };
const accountId = "account-a";
const engine = (id: string, status = "PAUSED", shard = "executor-02"): Engine => ({
  engineId: id, symbol: "SOLBRL", executorShardId: shard, runId: `run-${id}`, runStatus: status, entryEnabled: status === "ACTIVE",
});
const baseline = (): Snapshot => ({ accountId, hidden: true, canHide: true,
  engines: [engine("A"), engine("B", "PAUSED", "executor-03"), engine("C", "ACTIVE")] });
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

function elements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== "object") return [];
  const node = value as Element;
  return [node, ...elements(node.props?.children)];
}
function text(value: unknown): string {
  if (Array.isArray(value)) return value.map(text).join("");
  if (value && typeof value === "object") return text((value as Element).props?.children);
  return value === null || value === undefined || typeof value === "boolean" ? "" : String(value);
}

function fixture(options: { confirm?: boolean; snapshot?: Snapshot;
  intercept?: (call: Call, snapshot: Snapshot, reads: number) => Promise<unknown> | unknown } = {}) {
  const snapshot = copy(options.snapshot ?? baseline());
  const calls: Call[] = [], state: unknown[] = [];
  let hook = 0, reads = 0, refreshes = 0, confirmations = 0;
  const react = { ...React,
    useRef(initial: unknown) { const at = hook++; return state[at] ??= { current: initial }; },
    useState(initial: unknown) { const at = hook++; state[at] ??= initial;
      return [state[at], (value: unknown) => { state[at] = value; }]; },
  };
  const fetcher = async (url: string, settings: { body?: string; headers?: Record<string, string>; credentials: string; signal: AbortSignal }) => {
    assert.equal(settings.credentials, "same-origin"); assert.ok(settings.signal instanceof AbortSignal);
    const call: Call = { url, body: settings.body ? JSON.parse(settings.body) : undefined, headers: settings.headers };
    calls.push(call); if (!call.body) reads++;
    const intercepted = await options.intercept?.(call, snapshot, reads);
    if (intercepted !== undefined) return intercepted;
    if (!call.body) return { ok: true, json: async () => copy(snapshot) };
    if (url === "/api/coinops-engine-control") {
      assert.equal(call.body.action, "RESUME");
      assert.equal(call.body.accountId, accountId);
      assert.equal(call.headers?.["x-coinops-admin-intent"], "engine-control");
      assert.deepEqual(Object.keys(call.body).sort(), ["accountId", "action", "engineId"]);
      const own = snapshot.engines.find((item) => item.engineId === call.body?.engineId)!;
      assert.equal(own.runStatus, "PAUSED"); own.runStatus = "ACTIVE"; own.entryEnabled = true;
      return { ok: true, json: async () => ({ status: "RESUMED", cycle_id: own.runId }) };
    }
    assert.equal(call.body.action, "SHOW"); assert.equal(call.body.accountId, accountId);
    assert.equal(call.headers?.["x-coinops-admin-intent"], "account-pause");
    snapshot.hidden = false; return { ok: true, json: async () => copy(snapshot) };
  };
  const loaded = { exports: {} as { AccountPauseHomePanel: (props: unknown) => Element } };
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  new Function("require", "module", "exports", "fetch", "window", compiled)((id: string) => {
    if (id === "react") return react;
    if (id === "next/navigation") return { useRouter: () => ({ refresh() { refreshes++; } }) };
    if (id.endsWith(".css")) return {};
    return require(id);
  }, loaded, loaded.exports, fetcher, { confirm(value: string) {
    confirmations++; assert.match(value, /operação REAL/); assert.match(value, /saldo Spot e reserva BNB/);
    return options.confirm !== false;
  } });
  const props = { selectedAccountId: accountId, accountName: "Renato", preference: { hidden: true },
    engines: baseline().engines.map((item) => ({ environment: "REAL", accountId, engineId: item.engineId,
      engineStatus: "ACTIVE", status: item.runStatus, entryPauseProtected: item.runStatus === "PAUSED" })) };
  const render = () => { hook = 0; return loaded.exports.AccountPauseHomePanel(props); };
  const button = () => elements(render()).find((node) => node.type === "button"
    && text(node.props?.children) === "Reativar operação e reexibir na tela inicial")!;
  const click = () => button().props!.onClick!();
  const done = async () => {
    for (let attempt = 0; state[1] && attempt < 100; attempt++) await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(state[1], false, "bounded command completed");
  };
  const commands = () => calls.filter((call) => call.body);
  return { calls, snapshot, click, done, button, commands, render,
    message: () => String(state[2] ?? ""), failed: () => state[3],
    refreshes: () => refreshes, confirmations: () => confirmations };
}

test("reactivates exact paused same-symbol engines sequentially across shards, preserves active sibling, then verifies before SHOW", async () => {
  const f = fixture(); f.click(); await f.done();
  assert.deepEqual(f.commands().map((call) => call.body?.action), ["RESUME", "RESUME", "SHOW"]);
  assert.deepEqual(f.commands().slice(0, 2).map((call) => call.body?.engineId), ["A", "B"]);
  assert.deepEqual(f.calls.map((call) => call.body?.action ?? "GET"), ["GET", "RESUME", "RESUME", "GET", "SHOW"]);
  assert.equal(f.snapshot.hidden, false); assert.equal(f.failed(), false);
  assert.match(f.message(), /Operação reativada/); assert.equal(f.refreshes(), 1);
});

test("canceled confirmation performs no network requests or trading action", async () => {
  const f = fixture({ confirm: false }); f.click();
  assert.equal(f.calls.length, 0); assert.equal(f.confirmations(), 1); assert.equal(f.refreshes(), 0);
});

test("inFlight blocks double click even before the next React render", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const f = fixture({ intercept: async (call, _snapshot, reads) => {
    if (!call.body && reads === 1) await gate;
  } });
  f.click(); f.click(); assert.equal(f.confirmations(), 1); assert.equal(f.button().props?.disabled, true);
  release(); await f.done(); assert.equal(f.commands().filter((call) => call.body?.action === "RESUME").length, 2);
});

test("invalid account, duplicate engine, missing run and preparing inventory fail before RESUME or SHOW", async () => {
  const invalid = [
    { ...baseline(), accountId: "foreign-account" },
    { ...baseline(), engines: [engine("A"), engine("A")] },
    { ...baseline(), engines: [{ ...engine("A"), runId: "" }] },
    { ...baseline(), engines: [engine("A", "PREPARING")] },
  ];
  for (const snapshot of invalid) {
    const f = fixture({ snapshot }); f.click(); await f.done();
    assert.equal(f.commands().length, 0); assert.equal(f.failed(), true);
  }
});

test("partial success stops on the failed engine, reads state back, does not roll back siblings or SHOW", async () => {
  const f = fixture({ intercept: (call) => call.body?.engineId === "B"
    ? { ok: false, json: async () => ({ error: "COINOPS_LIVE_RESUME_LEASE_BUSY" }) } : undefined });
  f.click(); await f.done();
  assert.equal(f.snapshot.engines[0].runStatus, "ACTIVE"); assert.equal(f.snapshot.engines[1].runStatus, "PAUSED");
  assert.deepEqual(f.commands().map((call) => call.body?.action), ["RESUME", "RESUME"]);
  assert.equal(f.snapshot.hidden, true); assert.match(f.message(), /1\/2 retomadas confirmadas/);
  assert.match(f.message(), /2 motor\(es\) ACTIVE e 1 PAUSED/); assert.match(f.message(), /Nenhum comando foi reenviado/);
});

test("unknown transport outcome reads back but never retries RESUME or assumes an active run proves successful gate opening", async () => {
  const f = fixture({ intercept: (call, snapshot) => {
    if (call.body?.engineId !== "A") return;
    snapshot.engines[0].runStatus = "ACTIVE"; throw new Error("synthetic timeout");
  } });
  f.click(); await f.done();
  assert.deepEqual(f.commands().map((call) => call.body?.engineId), ["A"]);
  assert.equal(f.failed(), true); assert.equal(f.snapshot.hidden, true);
  assert.match(f.message(), /0\/2 retomadas confirmadas/); assert.match(f.message(), /Leitura atual/);
});

test("response with a different run is not confirmation and cannot resume a sibling or SHOW", async () => {
  const f = fixture({ intercept: (call) => call.body?.action === "RESUME"
    ? { ok: true, json: async () => ({ status: "RESUMED", cycle_id: "foreign-run" }) } : undefined });
  f.click(); await f.done(); assert.equal(f.commands().length, 1);
  assert.equal(f.failed(), true); assert.equal(f.snapshot.hidden, true);
});

test("SHOW requires exact unchanged inventory, run IDs and ACTIVE readback after all responses", async () => {
  for (const change of [
    (snapshot: Snapshot) => { snapshot.engines[0].runStatus = "PAUSED"; },
    (snapshot: Snapshot) => { snapshot.engines[0].runId = "changed-run"; },
    (snapshot: Snapshot) => { snapshot.engines.push(engine("new-engine")); },
    (snapshot: Snapshot) => { snapshot.engines[0].entryEnabled = false; },
  ]) {
    const f = fixture({ intercept: (call, snapshot, reads) => {
      if (!call.body && reads === 2) change(snapshot);
    } });
    f.click(); await f.done(); assert.equal(f.commands().some((call) => call.body?.action === "SHOW"), false);
    assert.equal(f.failed(), true); assert.match(f.message(), /READBACK_UNCONFIRMED/);
  }
});

test("SHOW failure distinguishes resumed operation from visibility failure without a mutation retry", async () => {
  const f = fixture({ intercept: (call) => call.body?.action === "SHOW"
    ? { ok: false, json: async () => ({ error: "COINOPS_ACCOUNT_PAUSE_PREFERENCE_UNAVAILABLE" }) } : undefined });
  f.click(); await f.done(); assert.match(f.message(), /Retomada confirmada, mas a reexibição não foi confirmada/);
  assert.equal(f.commands().filter((call) => call.body?.action === "SHOW").length, 1);
  assert.equal(f.commands().filter((call) => call.body?.action === "RESUME").length, 2);
});

test("fresh already ACTIVE inventory does not resend a stale rendered resume command", async () => {
  const snapshot = baseline(); snapshot.engines.forEach((item) => { item.runStatus = "ACTIVE"; item.entryEnabled = true; });
  const f = fixture({ snapshot }); f.click(); await f.done();
  assert.deepEqual(f.commands().map((call) => call.body?.action), ["SHOW"]);
  assert.equal(f.failed(), false);
});

test("ACTIVE sibling with a closed or unknown gate is not auto-resumed and prevents false account-wide success", async () => {
  for (const enabled of [false, undefined]) {
    const snapshot = baseline();
    snapshot.engines[2].entryEnabled = enabled as boolean;
    const f = fixture({ snapshot }); f.click(); await f.done();
    assert.deepEqual(f.commands().map((call) => call.body?.engineId), ["A", "B"]);
    assert.equal(f.commands().some((call) => call.body?.action === "SHOW"), false);
    assert.equal(f.failed(), true); assert.match(f.message(), /READBACK_UNCONFIRMED/);
    assert.doesNotMatch(f.message(), /Operação reativada e conta reexibida/);
  }
});
