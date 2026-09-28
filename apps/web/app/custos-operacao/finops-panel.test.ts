import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import type { FinopsDashboard } from "../../lib/coinops-finops/types.ts";

const source = readFileSync(new URL("./finops-panel.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;

function fixture(capital = 11000): FinopsDashboard {
  return { capturedAt: "2026-09-28T12:00:00Z", externalCapturedAt: "2026-09-28T06:00:00Z",
    operationalCapturedAt: "2026-09-28T12:00:00Z", period: "2026-09", syncStatus: "OK",
    summary: { accounts: 8, engines: 11, executors: 2, capitalBrl: capital, capitalByCurrency: { BRL: capital },
      actualBrl: null, projectedBrl: 100, knownActualBrl: 0, knownProjectedBrl: 100,
      costPerAccountBrl: 12.5, costPerEngineBrl: 9.09, unavailableServices: 0, capitalComplete: true },
    capital: { accounts: [], markets: [], notes: [] }, executors: [], services: [], fx: [],
    history: [], alerts: [], sources: [], growth: [] };
}

type Reply = { ok: boolean; status: number; json: () => Promise<unknown> };
const reply = (body: unknown, status = 200): Reply => ({ ok: status >= 200 && status < 300,
  status, json: async () => body });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function nodes(node: React.ReactNode): React.ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!React.isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...nodes(node.props.children as React.ReactNode)];
}

function harness(initialData = fixture()) {
  type Cell = { value?: unknown; deps?: readonly unknown[] };
  const cells: Cell[] = [];
  let cursor = 0;
  let effects: Array<() => void> = [];
  const writes: Array<{ index: number; value: unknown }> = [];
  const requests: Array<{ url: string; method: string; init: RequestInit }> = [];
  const responses: Array<Reply | Promise<Reply>> = [];
  let routerRefreshes = 0;
  const sameDeps = (before: readonly unknown[] | undefined, after: readonly unknown[]) =>
    Boolean(before && before.length === after.length && before.every((value, index) => Object.is(value, after[index])));
  const react = { ...React,
    useState(initial: unknown) {
      const index = cursor++;
      if (!cells[index]) cells[index] = { value: typeof initial === "function" ? initial() : initial };
      return [cells[index].value, (next: unknown) => {
        const value = typeof next === "function" ? next(cells[index].value) : next;
        cells[index].value = value; writes.push({ index, value });
      }];
    },
    useRef(initial: unknown) {
      const index = cursor++;
      if (!cells[index]) cells[index] = { value: { current: initial } };
      return cells[index].value;
    },
    useMemo(compute: () => unknown, deps: readonly unknown[]) {
      const index = cursor++;
      if (!sameDeps(cells[index]?.deps, deps)) cells[index] = { value: compute(), deps };
      return cells[index].value;
    },
    useEffect(effect: () => void, deps: readonly unknown[]) {
      const index = cursor++;
      if (!sameDeps(cells[index]?.deps, deps)) { cells[index] = { deps }; effects.push(effect); }
    },
  };
  const modules: Record<string, unknown> = { react, "react/jsx-runtime": jsxRuntime,
    "next/navigation": { useRouter: () => ({ refresh: () => { routerRefreshes++; } }) },
    "../automacao/premium-primitives": { PremiumBrand: () => React.createElement("span", {}, "CoinOps"),
      PremiumIcon: () => React.createElement("svg", { "aria-hidden": true }) } };
  const exports: { FinopsPanel?: (props: { data: FinopsDashboard; homeHref: string }) => React.ReactElement } = {};
  new Function("require", "exports", "fetch", compiled)(
    (id: string) => { assert.ok(id in modules, `Unexpected module ${id}`); return modules[id]; }, exports,
    (url: string, init: RequestInit = {}) => {
      requests.push({ url, method: init.method ?? "GET", init });
      assert.equal(url, "/api/coinops-finops", "no exchange/trading request is allowed");
      const response = responses.shift();
      assert.ok(response, "Unexpected extra request");
      return Promise.resolve(response);
    });
  const homeHref = "/automacao?view=live&account=8f16c84e-17cf-41d6-af0f-b3fa7a64ab89&market=SOLBRL";
  const render = () => {
    cursor = 0; effects = [];
    const tree = exports.FinopsPanel!({ data: initialData, homeHref });
    for (const effect of effects) effect();
    return tree;
  };
  render(); writes.length = 0;
  return { requests, responses, writes, homeHref, render,
    data: () => cells[0].value as FinopsDashboard,
    html: () => renderToStaticMarkup(render()),
    message: () => {
      const result = nodes(render()).find((node) => String(node.props.className).includes("fo-sync-result"));
      return result ? { role: result.props.role, text: result.props.children as string } : null;
    },
    button: () => {
      const button = nodes(render()).find((node) => node.type === "button"
        && ["Atualizar dados", "Atualizando…"].includes(String(node.props.children)));
      assert.ok(button); return button.props as { disabled: boolean; onClick: () => void };
    },
    routerRefreshes: () => routerRefreshes,
  };
}

test("sync awaits POST then GET; the new numbers are committed before the success message", async () => {
  const ui = harness();
  const pendingPost = deferred<Reply>(), pendingGet = deferred<Reply>();
  const latest = fixture(99000);
  ui.responses.push(pendingPost.promise, pendingGet.promise);
  ui.button().onClick();
  assert.equal(ui.button().disabled, true);
  assert.deepEqual(ui.requests.map((request) => request.method), ["POST"]);
  assert.equal(ui.message(), null);
  pendingPost.resolve(reply({ status: "OPERATIONAL_UPDATED" })); await settle();
  assert.deepEqual(ui.requests.map((request) => request.method), ["POST", "GET"]);
  assert.equal(ui.requests[1].init.cache, "no-store");
  assert.equal(ui.requests[1].init.credentials, "same-origin");
  assert.equal(ui.data().summary.capitalBrl, 11000);
  assert.equal(ui.message(), null);
  pendingGet.resolve(reply(latest)); await settle();
  assert.strictEqual(ui.data(), latest);
  assert.equal(ui.button().disabled, false);
  assert.match(ui.message()!.text, /Capital e infraestrutura consultados agora/);
  const dataIndex = ui.writes.findIndex((write) => write.value === latest);
  const messageIndex = ui.writes.findIndex((write) => write.value && typeof write.value === "object"
    && "message" in write.value);
  assert.ok(dataIndex >= 0 && messageIndex > dataIndex);
  assert.match(ui.html(), /99\.000/);
  assert.equal(ui.routerRefreshes(), 0, "non-awaitable RSC refresh is not a sync completion signal");
});

test("double click before any rerender issues only one POST/GET and allows a later update", async () => {
  const ui = harness();
  const pending = deferred<Reply>();
  ui.responses.push(pending.promise, reply(fixture(22000)));
  const initialClick = ui.button().onClick;
  initialClick(); initialClick();
  assert.equal(ui.requests.length, 1);
  pending.resolve(reply({ status: "OPERATIONAL_UPDATED" })); await settle();
  assert.deepEqual(ui.requests.map((request) => request.method), ["POST", "GET"]);
  ui.responses.push(reply({ status: "FRESH" }), reply(fixture(23000)));
  ui.button().onClick(); await settle();
  assert.deepEqual(ui.requests.map((request) => request.method), ["POST", "GET", "POST", "GET"]);
  assert.equal(ui.data().summary.capitalBrl, 23000);
});

test("GET failure preserves old numbers and shows an error instead of collection success", async () => {
  const previous = fixture(); const ui = harness(previous);
  ui.responses.push(reply({ status: "OPERATIONAL_UPDATED" }), reply({}, 503));
  ui.button().onClick(); await settle();
  assert.strictEqual(ui.data(), previous);
  assert.equal(ui.message()!.role, "alert");
  assert.match(ui.message()!.text, /valores exibidos ainda são os anteriores/);
  assert.equal(ui.button().disabled, false);
  assert.doesNotThrow(() => ui.html());
});

test("incomplete GET data preserves the complete prior dashboard instead of crashing on render", async () => {
  for (const incomplete of [null, { summary: {}, services: [] }, { ...fixture(), capital: null },
    { ...fixture(), history: undefined }, { ...fixture(), executors: undefined }]) {
    const previous = fixture(); const ui = harness(previous);
    ui.responses.push(reply({ status: "OPERATIONAL_UPDATED" }), reply(incomplete));
    ui.button().onClick(); await settle();
    assert.strictEqual(ui.data(), previous);
    assert.equal(ui.message()!.role, "alert");
    assert.doesNotThrow(() => ui.html());
  }
});

test("IN_PROGRESS and FRESH never claim a new completed collection", async () => {
  for (const status of ["IN_PROGRESS", "FRESH"]) {
    const ui = harness();
    ui.responses.push(reply({ status, nextOperationalSyncAt: "2026-09-28T12:01:00Z" }), reply(fixture()));
    ui.button().onClick(); await settle();
    const text = ui.message()!.text;
    assert.doesNotMatch(text, /Dados atualizados e snapshot registrado|Capital e infraestrutura consultados agora/);
    assert.match(text, status === "IN_PROGRESS" ? /em andamento.*Aguarde/ : /snapshot recarregado.*60 segundos/);
  }
});

test("PARTIAL remains explicit and POST auth failure never starts the follow-up GET", async () => {
  const partial = harness();
  partial.responses.push(reply({ status: "PARTIAL" }), reply({ ...fixture(), syncStatus: "PARTIAL" }));
  partial.button().onClick(); await settle();
  assert.match(partial.message()!.text, /parcialmente.*avisos/);
  const denied = harness(); denied.responses.push(reply({}, 403));
  denied.button().onClick(); await settle();
  assert.equal(denied.requests.length, 1);
  assert.equal(denied.message()!.role, "alert");
  assert.match(denied.message()!.text, /Acesso administrativo/);
});

test("rendered panel exposes a contextual Início link and separate operational/provider timestamps", () => {
  const ui = harness();
  const html = ui.html();
  assert.match(html, /aria-label="Voltar ao Início mantendo conta e mercado"/);
  assert.ok(html.includes(ui.homeHref.replaceAll("&", "&amp;")));
  assert.match(html, /Coleta de capital e infraestrutura/);
  assert.match(html, /Coleta de fornecedores/);
  assert.match(html, /08:00/); assert.match(html, /02:00/);
  const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
  assert.match(page, /homeHref=\{buildFinopsNavigation\(searchParams\)\.automationHref\}/);
  assert.ok(page.indexOf("await requireFinopsAdmin()") < page.indexOf("await loadFinopsDashboard(scope)"));
  const css = readFileSync(new URL("./finops.css", import.meta.url), "utf8");
  assert.match(css, /\.fo-topbar \.fo-back\{[^}]*min-height:44px/);
  assert.match(css, /@media\(max-width:700px\)\{[^\n]*\.fo-period\{grid-template-columns:minmax\(0,1fr\) auto/);
  assert.match(css, /safe-area-inset-top/);
});
