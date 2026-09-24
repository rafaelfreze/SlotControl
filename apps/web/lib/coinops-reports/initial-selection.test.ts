import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { resolveReportInitialSelection, type ReportInitialSelection } from "./initial-selection.ts";
import type { DomainRegistry } from "../execution/operator-context.ts";
import { CANDLE_EXPORT_MAX_DAYS, partitionCandleExports } from "./candle-export-parts.ts";
import { reportExportSelectionReason } from "./export-selection.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const registry: DomainRegistry = {
  operator: { id: id(1), product_id: id(2), tenant_id: id(3), user_id: id(4), status: "ACTIVE", kill_switch: false },
  accounts: [5, 6].map((n) => ({ id: id(n), operator_id: id(1), display_name: `Fixture ${n}`, status: "ACTIVE", is_legacy_default: n === 5, kill_switch: false })),
  engines: [5, 6].flatMap((account, i) => (["REAL", "SHADOW", "TESTNET"] as const).map((environment, n) => ({
    id: id(10 + i * 3 + n), operator_id: id(1), exchange_account_id: id(account), environment,
    symbol: environment === "REAL" ? "BTCBRL" : "BTCUSDC", base_asset: "BTC", quote_asset: environment === "REAL" ? "BRL" : "USDC",
    status: "ACTIVE", kill_switch: false, hard_cap_quote: 100, legacy_compatible: i === 0
  })))
};

test("report link preserves account/engine and infers its exact environment and asset", () => {
  assert.deepEqual(resolveReportInitialSelection(registry, { account: id(5), engine: id(10), environment: "REAL" }),
    { account: id(5), engine: id(10), environment: "REAL", asset: "BTC" });
  assert.deepEqual(resolveReportInitialSelection(registry, { account: id(6), engine: id(15) }),
    { account: id(6), engine: id(15), environment: "TESTNET", asset: "BTC" });
});

test("unscoped entry and explicit ALL retain the existing all-engines default", () => {
  const all = { account: "ALL", engine: "ALL", environment: "ALL", asset: "ALL" } as const;
  assert.deepEqual(resolveReportInitialSelection(registry), all);
  assert.deepEqual(resolveReportInitialSelection(registry, all), all);
  assert.deepEqual(resolveReportInitialSelection(registry, { account: id(5), environment: "SHADOW" }),
    { ...all, account: id(5), environment: "SHADOW" });
});

test("invalid, foreign or contradictory explicit selectors never widen to ALL", () => {
  for (const selection of [
    { account: "invalid" }, { account: id(99) }, { engine: id(10) },
    { account: id(5), engine: id(13) }, { account: id(5), engine: id(99) },
    { account: id(5), engine: id(10), environment: "TESTNET" },
    { account: id(5), engine: id(10), asset: "SOL" },
    { environment: "PRODUCTION" }, { asset: "ETH" }, { account: "" },
    { account: [id(5), id(6)] }
  ]) assert.throws(() => resolveReportInitialSelection(registry, selection), /INVALID|DENIED/);
  const revoked = structuredClone(registry);
  revoked.accounts[0].status = "REVOKED";
  assert.throws(() => resolveReportInitialSelection(revoked, { account: id(5) }), /DENIED/);
});

type Element = { type: unknown; props: Record<string, unknown>; key?: string };
const jsx = (type: unknown, props: Record<string, unknown>, key?: string): Element => ({ type, props, key });

function compile(relative: string, dependencies: Record<string, unknown>, fetcher?: unknown) {
  const source = readFileSync(new URL(relative, import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX
  } }).outputText;
  const evaluated: Record<string, unknown> = {};
  new Function("require", "exports", "fetch", code)((name: string) => {
    assert.ok(name in dependencies, `Unexpected report dependency: ${name}`);
    return dependencies[name];
  }, evaluated, fetcher);
  return evaluated;
}

test("ReportCenter's FIRST preview uses the validated scope, with matching draft and active tab", () => {
  const states: unknown[] = [], effects: Array<() => () => void> = [], urls: string[] = [];
  const { ReportCenter } = compile("../../app/relatorios/report-center.tsx", {
    "react/jsx-runtime": { jsx, jsxs: jsx }, "next/link": {},
    "react": {
      useState: (initial: unknown) => { const value = typeof initial === "function" ? initial() : initial; states.push(value); return [value, () => {}]; },
      useEffect: (effect: () => () => void) => effects.push(effect)
    },
    "@/components/app/desktop-workspace": {}, "@/components/app/mobile-ui": {},
    "@/lib/coinops-reports/missed-level-temporal": { STRATEGY_4_1_EFFECTIVE_AT: "2026-09-23T00:00:00Z" },
    "@/lib/coinops-reports/filters": { REPORT_VERSION: 10 },
    "@/lib/coinops-reports/candle-export-parts": { CANDLE_EXPORT_MAX_DAYS, partitionCandleExports },
    "@/lib/coinops-reports/export-selection": { reportExportSelectionReason }
  }, (url: string) => {
    urls.push(url);
    return Promise.resolve(Response.json({ summaries: [], checks: [] }));
  }) as { ReportCenter: (props: unknown) => unknown };
  const selection = resolveReportInitialSelection(registry, { account: id(5), engine: id(10), environment: "REAL" });
  ReportCenter({ today: "2026-09-24", userLabel: "Fixture", registry, initialSelection: selection });
  assert.equal(effects.length, 1);
  const cleanup = effects[0]();
  assert.equal(urls.length, 1);
  const params = new URL(urls[0], "https://fixture.invalid").searchParams;
  for (const [key, value] of Object.entries(selection)) assert.equal(params.get(key), value);
  assert.equal(params.get("format"), "preview");
  assert.equal(params.get("start"), "2026-08-26");
  assert.deepEqual(states[0], states[1]);
  assert.equal(states[2], "real");
  cleanup();
});

test("ReportsPage forwards validated searchParams and blocks a foreign engine before rendering the report", async () => {
  const reportMarker = Symbol("ReportCenter");
  const query = { select: () => query, eq: () => query,
    single: async () => ({ error: null, data: { product_id: id(2), tenant_id: id(3), user_id: id(4) } }) };
  const { default: page } = compile("../../app/relatorios/page.tsx", {
    "react/jsx-runtime": { jsx, jsxs: jsx }, "next/link": {},
    "next/navigation": { redirect: () => { throw new Error("AUTH_REQUIRED"); } },
    "@/lib/supabase/server": { createClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: id(4), email: "fixture@example.invalid" } } }) }, from: () => query }) },
    "./report-center": { ReportCenter: reportMarker },
    "@/lib/execution/operator-context-server": { loadOperatorRegistry: async () => registry },
    "@/lib/supabase/env": { getCoinOpsServiceTenantId: () => id(3) },
    "@/lib/coinops-reports/initial-selection": { resolveReportInitialSelection }
  }) as { default: (props: unknown) => Promise<Element> };
  const selection: ReportInitialSelection = { account: id(5), engine: id(10), environment: "REAL", asset: "BTC" };
  const result = await page({ searchParams: selection });
  assert.equal(result.type, reportMarker);
  assert.deepEqual(result.props.initialSelection, selection);
  assert.equal(result.key, `${id(5)}:${id(10)}:REAL:BTC`, "new URL scope remounts the report instead of retaining old filters");
  const denied = await page({ searchParams: { ...selection, engine: id(13) } });
  assert.equal(denied.type, "section");
  assert.equal(denied.props.role, "alert");
});

function renderExportControls(selection: ReportInitialSelection, singleCandlePart = false) {
  const requests: string[] = [];
  let stateIndex = 0;
  const { ReportCenter } = compile("../../app/relatorios/report-center.tsx", {
    "react/jsx-runtime": { jsx, jsxs: jsx }, "next/link": {},
    "react": {
      useState: (initial: unknown) => {
        const index = stateIndex++;
        let value = typeof initial === "function" ? initial() : initial;
        if (index < 2 && singleCandlePart) value = { ...value as object, start: "2026-09-24", preset: "today" };
        if (index === 2) value = "exports";
        if (index === 3) value = { summaries: [], checks: [], warnings: [], incompleteSources: [], rowCounts: {}, files: [] };
        if (index === 4) value = false;
        return [value, () => {}];
      }, useEffect: () => {}
    },
    "@/components/app/desktop-workspace": {}, "@/components/app/mobile-ui": {},
    "@/lib/coinops-reports/missed-level-temporal": { STRATEGY_4_1_EFFECTIVE_AT: "2026-09-23T00:00:00Z" },
    "@/lib/coinops-reports/filters": { REPORT_VERSION: 10 },
    "@/lib/coinops-reports/candle-export-parts": { CANDLE_EXPORT_MAX_DAYS, partitionCandleExports },
    "@/lib/coinops-reports/export-selection": { reportExportSelectionReason }
  }, async (url: string) => {
    requests.push(url);
    return Response.json({}, { status: 503 }); // No browser download, network or operational data.
  }) as { ReportCenter: (props: unknown) => Element };
  const tree = ReportCenter({ today: "2026-09-24", userLabel: "Fixture", registry, initialSelection: selection });
  const elements: Element[] = [], visited = new Set<Element>();
  const walk = (value: unknown) => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (!value || typeof value !== "object" || !("props" in value)) return;
    const element = value as Element;
    if (visited.has(element)) return;
    visited.add(element); elements.push(element); walk(element.props.children);
  };
  walk(tree);
  const label = (value: unknown): string => Array.isArray(value) ? value.map(label).join("")
    : value && typeof value === "object" && "props" in value ? label((value as Element).props.children)
      : typeof value === "string" || typeof value === "number" ? String(value) : "";
  const buttons = elements.filter((element) => element.type === "button");
  return { requests, elements, buttons, text: (element: Element) => label(element),
    button: (text: string) => buttons.find((element) => label(element) === text)! };
}

test("concrete REAL export controls disable other environments and every candle part before any fetch", async () => {
  for (const singlePart of [false, true]) {
    const rendered = renderExportControls({ account: id(5), engine: id(10), environment: "REAL", asset: "BTC" }, singlePart);
    const incompatible = [rendered.button("Shadow ⇩"), rendered.button("Testnet · fictício ⇩"),
      ...rendered.buttons.filter((button) => String(button.props["aria-label"] || "").startsWith("Baixar candles:")
        || rendered.text(button) === "Exportar candles completos ⇩")];
    assert.ok(incompatible.length >= 3);
    for (const button of incompatible) {
      assert.equal(button.props.disabled, true);
      assert.match(String(button.props.title), /escolha explicitamente/);
      await (button.props.onClick as () => void)(); // Handler is guarded even if called without a disabled button.
    }
    assert.deepEqual(rendered.requests, []);
    assert.ok(rendered.elements.some((element) => element.props.className === "reports-format-note"
      && rendered.text(element).includes("Nenhuma conta ou motor é trocado automaticamente")));
    const compatible = rendered.button("Real · somente leitura ⇩");
    assert.equal(compatible.props.disabled, false);
    await (compatible.props.onClick as () => void)();
    const params = new URL(rendered.requests[0], "https://fixture.invalid").searchParams;
    assert.equal(params.get("account"), id(5)); assert.equal(params.get("engine"), id(10));
    assert.equal(params.get("environment"), "REAL"); assert.equal(params.get("format"), "zip");
  }
});

test("Shadow candles and unfiltered environment exports remain available with unchanged selection", async () => {
  const shadow = renderExportControls({ account: id(5), engine: id(11), environment: "SHADOW", asset: "BTC" }, true);
  const candles = shadow.button("Exportar candles completos ⇩");
  assert.equal(candles.props.disabled, false);
  await (candles.props.onClick as () => void)();
  const params = new URL(shadow.requests[0], "https://fixture.invalid").searchParams;
  assert.equal(params.get("account"), id(5)); assert.equal(params.get("engine"), id(11));
  assert.equal(params.get("environment"), "SHADOW"); assert.equal(params.get("format"), "candles");
  const all = renderExportControls({ account: "ALL", engine: "ALL", environment: "ALL", asset: "ALL" }, true);
  for (const label of ["Shadow ⇩", "Testnet · fictício ⇩", "Real · somente leitura ⇩", "Exportar candles completos ⇩"])
    assert.equal(all.button(label).props.disabled, false);
});
