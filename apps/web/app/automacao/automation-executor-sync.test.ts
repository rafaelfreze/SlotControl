import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import * as executorSync from "./automation-executor-sync.ts";
import type { ExecutorObservation, ExecutorSnapshot } from "./automation-executor-sync.ts";

const now = Date.parse("2026-09-28T12:00:00.000Z");
const currentTime = new Date(now - 1_000).toISOString();
const current: ExecutorObservation = { id: "executor-fixture", egressIp: "192.0.2.2/32",
  state: "HEALTHY", executorVersion: "reviewed-new", observedAt: currentTime, heartbeatAt: currentTime };
const active: ExecutorSnapshot = { ip: "192.0.2.2", version: "reviewed-new", gate: "LIVE_EXECUTOR_ACTIVE" };
const observe = executorSync.observeExecutorSnapshots;

test("initial version mismatch refreshes once; repeated polls and RSC renders do not loop", () => {
  const seen = new Map<string, string>();
  const snapshot = { ...active, version: "reviewed-old" };
  assert.equal(observe(seen, [current], [snapshot], now), true);
  assert.equal(observe(seen, [current], [snapshot], now), false);
  assert.equal(observe(seen, [current], [active], now), false);
  assert.equal(observe(seen, [{ ...current, executorVersion: "reviewed-next" }], [active], now), true);
});

test("missing health snapshot requests authoritative refresh but never invents healthy status", () => {
  const seen = new Map<string, string>();
  const snapshot = { ...active, version: null, gate: "ATTENTION" };
  const before = structuredClone(snapshot);
  assert.equal(observe(seen, [current], [snapshot], now), true);
  assert.equal(observe(seen, [current], [snapshot], now), false);
  assert.deepEqual(snapshot, before);
  assert.equal(snapshot.gate, "ATTENTION");
});

test("same version with previous ATTENTION gets one verification, not false green or retry loop", () => {
  const seen = new Map<string, string>();
  const snapshot = { ...active, gate: "ATTENTION" };
  assert.equal(observe(seen, [current], [snapshot], now), true);
  assert.equal(observe(seen, [current], [snapshot], now), false);
  assert.equal(snapshot.gate, "ATTENTION");
});

test("fresh OFFLINE then recovery each request one refresh without waiting for a new version", () => {
  const seen = new Map<string, string>();
  assert.equal(observe(seen, [current], [active], now), false);
  assert.equal(observe(seen, [{ ...current, state: "OFFLINE" }], [active], now), true);
  assert.equal(observe(seen, [{ ...current, state: "OFFLINE" }], [active], now), false);
  assert.equal(observe(seen, [current], [active], now), true);
  assert.equal(observe(seen, [current], [active], now), false);
});

test("capacity WARNING/OBSERVE/LIMIT and changing timestamps are not operational transitions", () => {
  const seen = new Map<string, string>();
  for (const state of ["HEALTHY", "WARNING", "OBSERVE", "CAPACITY_LIMIT", "HEALTHY"]) {
    assert.equal(observe(seen, [{ ...current, state,
      observedAt: new Date(now).toISOString() }], [active], now), false);
  }
});

test("other IP/shard and an empty scope do not request refresh or consume its fingerprint", () => {
  const seen = new Map<string, string>();
  assert.equal(observe(seen, [current], [{ ...active, ip: "192.0.2.1" }], now), false);
  assert.equal(observe(seen, [current], [], now), false);
  assert.equal(seen.size, 0);
  assert.equal(observe(seen, [current], [{ ...active, version: "old" }], now), true);
});

test("stale, unavailable, malformed and future observations cannot promote health or trigger refresh", () => {
  const seen = new Map<string, string>();
  const snapshot = { ...active, gate: "ATTENTION", version: null };
  const stale = new Date(now - 120_001).toISOString();
  const invalid = [
    { ...current, observedAt: stale }, { ...current, heartbeatAt: stale },
    { ...current, observedAt: null }, { ...current, heartbeatAt: "invalid" },
    { ...current, observedAt: new Date(now + 1).toISOString() },
    { ...current, executorVersion: null }, { ...current, executorVersion: " " },
    { ...current, state: "UNKNOWN" }, { ...current, egressIp: "" },
  ];
  for (const observation of invalid) assert.equal(observe(seen, [observation], [snapshot], now), false);
  assert.equal(observe(seen, [null as unknown as ExecutorObservation], [snapshot], now), false);
  assert.equal(seen.size, 0);
  assert.equal(observe(seen, [current], [snapshot], now), true);
  assert.equal(snapshot.gate, "ATTENTION");
});

test("multiple engines on same IP create one shard observation without crossing selected scope", () => {
  const seen = new Map<string, string>();
  assert.equal(observe(seen, [current], [active, { ...active, gate: "ATTENTION" }], now), true);
  assert.equal(seen.size, 1);
  assert.equal(observe(seen, [current], [active, { ...active, gate: "ATTENTION" }], now), false);
});

test("ready/protected engines are not changed merely because the shard is online", () => {
  for (const gate of ["LIVE_EXECUTOR_READY", "LIVE_EXECUTOR_PROTECTED"]) {
    assert.equal(observe(new Map(), [current], [{ ...active, gate }], now), false);
  }
});

test("capacity hint uses the existing hook refresh debounce/gap, not a parallel poll or hard reload", () => {
  let clock = now;
  let refreshes = 0;
  const effects: Array<() => void | (() => void)> = [];
  const timers = new Map<number, { callback: () => void; at: number; interval?: number }>();
  let timerId = 0;
  const timeout = (callback: () => void, delay: number) => {
    const id = ++timerId; timers.set(id, { callback, at: clock + delay }); return id;
  };
  const interval = (callback: () => void, delay: number) => {
    const id = timeout(callback, delay); timers.get(id)!.interval = delay; return id;
  };
  const advance = (milliseconds: number) => {
    clock += milliseconds;
    for (const [id, timer] of [...timers]) if (timer.at <= clock) {
      if (timer.interval) timer.at = clock + timer.interval;
      else timers.delete(id);
      timer.callback();
    }
  };
  const document = { visibilityState: "visible", addEventListener() {}, removeEventListener() {} };
  const channel = { on() { return channel; }, subscribe(callback: (state: string) => void) { callback("SUBSCRIBED"); } };
  const react = { useMemo: (callback: () => unknown) => callback(), useCallback: (callback: unknown) => callback,
    useRef: (value: unknown) => ({ current: value }),
    useState: (value: unknown) => [typeof value === "function" ? value() : value, () => {}],
    useEffect: (callback: () => void | (() => void)) => { effects.push(callback); } };
  const source = readFileSync(new URL("./use-automation-live-sync.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022 } }).outputText;
  const modules: Record<string, unknown> = { react, "next/navigation": { useRouter: () => ({ refresh: () => { refreshes++; } }) },
    "@/lib/supabase/browser": { createClient: () => ({ channel: () => channel, removeChannel() {} }) },
    "./automation-live-scope": { automationSignalScopes: () => [{ trading_engine_id: "selected-engine" }], automationSignalFilter() {} },
    "./automation-executor-sync": executorSync };
  const exports: { useAutomationLiveSync?: (...args: unknown[]) => { observeExecutors: (rows: ExecutorObservation[]) => void } } = {};
  new Function("require", "exports", "Date", "document", "window", "setTimeout", "clearTimeout", "setInterval", "clearInterval", compiled)(
    (id: string) => { assert.ok(id in modules, `Unexpected dependency ${id}`); return modules[id]; }, exports,
    { now: () => clock, parse: Date.parse }, document, document, timeout, (id: number) => timers.delete(id),
    interval, (id: number) => timers.delete(id));
  const sync = exports.useAutomationLiveSync!("live", [], { accountId: "ALL", symbol: "ALL" },
    new Date(now).toISOString(), [{ ...active, version: "old", gate: "ATTENTION" }]);
  const cleanup = effects.map((effect) => effect());
  sync.observeExecutors([current]); sync.observeExecutors([current]);
  advance(0); assert.equal(refreshes, 1);
  sync.observeExecutors([{ ...current, executorVersion: "newer" }]);
  advance(14_999); assert.equal(refreshes, 1);
  advance(1); assert.equal(refreshes, 2);
  document.visibilityState = "hidden";
  sync.observeExecutors([{ ...current, executorVersion: "latest" }]);
  advance(15_000); assert.equal(refreshes, 2);
  document.visibilityState = "visible";
  sync.observeExecutors([{ ...current, executorVersion: "latest" }]);
  advance(0); assert.equal(refreshes, 3);
  for (const dispose of cleanup) dispose?.();
  assert.equal(timers.size, 0);
  assert.match(source, /ONLINE_REFRESH_MS = 120_000/);
  assert.doesNotMatch(source, /location\.reload|fetch\(/);
});

test("existing capacity poll publishes hints and premium selection scopes the authoritative snapshots", () => {
  const capacity = readFileSync(new URL("./capacity-card.tsx", import.meta.url), "utf8");
  const premium = readFileSync(new URL("./premium-automation.tsx", import.meta.url), "utf8");
  assert.match(capacity, /observationCallback\.current\?\.\(observed\)/);
  assert.match(capacity, /document\.visibilityState === "visible"\) void refresh\(\); \}, 30_000/);
  assert.match(premium, /selectPremiumEngines\(engines, "REAL", selection\)\.map/);
  assert.match(premium, /<CapacityCard onExecutorObservation=\{sync\.observeExecutors\}/);
});
