import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import type { AssetHealthDashboard, AssetHealthStatus } from "../../lib/coinops-asset-health/types.ts";

const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const source = readFileSync(new URL("./asset-health.tsx", import.meta.url), "utf8");
const integration = readFileSync(new URL("./premium-automation.tsx", import.meta.url), "utf8");
const now = Date.parse("2026-09-27T12:00:00Z");
const snapshot = {
  asset: "BTC", status: "HEALTHY", previousStatus: null, healthyIndicators: 4, totalIndicators: 5,
  summary: "A rede está funcionando normalmente.", reasons: ["Produção de blocos regular"],
  categories: [{ category: "NETWORK", status: "HEALTHY", healthy: 1, total: 1, summary: "Blocos recentes" }],
  metrics: [], sources: [], trigger: "NETWORK_CONFIRMED", evaluatedAt: "2026-09-27T11:45:00Z", validUntil: "2026-09-27T12:45:00Z", history: [],
  criticalSinceByMetric: {}, coverage: { available: 4, expected: 5, missingCategories: [], unavailableOptional: 1 },
} as NonNullable<AssetHealthDashboard["assets"]["BTC"]>;

function load(context?: unknown) {
  const loadedModule = { exports: {} as Record<string, (...args: any[]) => any> };
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  new Function("require", "module", "exports", code)((name: string) => {
    if (name.endsWith(".css")) return {};
    if (name === "./premium-primitives") return { PremiumDrawer: () => null, displayTime: (value: string) => value || "Sem leitura" };
    if (name === "react" && context) return { ...React, useContext: () => context };
    return require(name);
  }, loadedModule, loadedModule.exports);
  return loadedModule.exports;
}

test("only fresh evidence can show a healthy badge; absent and expired data cannot", () => {
  const { displayedAssetHealthStatus: status } = load();
  assert.equal(status(snapshot, now), "HEALTHY");
  assert.equal(status(undefined, now), "INSUFFICIENT_DATA");
  assert.equal(status({ ...snapshot, validUntil: "invalid" }, now), "INSUFFICIENT_DATA");
  assert.equal(status({ ...snapshot, validUntil: "2026-09-27T11:59:59Z" }, now), "INSUFFICIENT_DATA");
  for (const state of ["ATTENTION", "STRUCTURAL_RISK", "INSUFFICIENT_DATA"] as AssetHealthStatus[]) assert.equal(status({ ...snapshot, status: state }, now), state);
});

test("each existing quote card has one accessible health trigger without another market card", () => {
  let selected = "";
  const { AssetHealthBadge } = load({ dashboard: { assets: { BTC: snapshot } }, now, loading: false, open: (asset: string) => { selected = asset; } });
  const element = AssetHealthBadge({ asset: "BTC" });
  const html = renderToStaticMarkup(element);
  assert.match(html, /aria-haspopup="dialog"/);
  assert.match(html, /Saúde do ativo Bitcoin: SAUDÁVEL/);
  assert.match(html, /Atualizado há 15 min/);
  element.props.onClick();
  assert.equal(selected, "BTC");
  assert.equal(integration.match(/<AssetHealthBadge asset=\{model\.asset\}/g)?.length, 1);
  assert.match(integration, /<AssetHealthProvider>/);
  assert.match(source, /onClose=\{\(\) => setSelected\(null\)\}/);
});

test("details keep source failure distinct from structural risk and avoid stale history under a new period", () => {
  const { AssetHealthDetails } = load();
  const html = renderToStaticMarkup(React.createElement(AssetHealthDetails, {
    asset: "BTC", snapshot, now, loading: false, readError: true, days: 90, setDays: () => undefined,
  }));
  assert.match(html, /SAUDÁVEL/);
  assert.doesNotMatch(html, /RISCO ESTRUTURAL/);
  assert.match(html, /Histórico indisponível nesta consulta/);
  assert.match(html, /Ver detalhes técnicos/);
  assert.match(html, /Queda de preço, sozinha, não representa risco estrutural/);
  assert.match(html, /não envia ordens nem altera seus motores/);
  assert.match(html, /Fontes e última atualização/);
  assert.doesNotMatch(html, /<details open/);
});

test("drawer labels proxy-only category as OBSERVAR and exposes the evidence class", () => {
  const { AssetHealthDetails } = load();
  const proxySnapshot = { ...snapshot,
    categories: [{ category: "SECURITY", status: "OBSERVE", healthy: 2, total: 3, summary: "Proxy em observação" }],
    metrics: [{ asset: "SOL", key: "vote_account_superminority_proxy", label: "Concentração por contas de voto (proxy)", category: "SECURITY",
      cadence: "STRUCTURAL", status: "WARNING", indicatorClass: "COMPLEMENTARY_PROXY", value: 18, unit: "contas de voto",
      reason: "Proxy sem agrupamento por operador; não é coeficiente Nakamoto oficial.", confidence: "MEDIUM",
      source: { id: "solana-mainnet-rpc", name: "Solana Mainnet RPC", url: "https://solana.com/docs/rpc" },
      fetchedAt: "2026-09-27T11:45:00Z", observedAt: "2026-09-27T11:45:00Z", metricAt: "2026-09-27T11:45:00Z", ttlSeconds: 43_200 }],
  } as NonNullable<AssetHealthDashboard["assets"]["SOL"]>;
  const html = renderToStaticMarkup(React.createElement(AssetHealthDetails, {
    asset: "SOL", snapshot: proxySnapshot, now, loading: false, readError: false, days: 30, setDays: () => undefined,
  }));
  assert.match(html, /OBSERVAR/); assert.match(html, /Complementar \/ proxy/);
  assert.match(html, /não é coeficiente Nakamoto oficial/);
});

test("history shows status transitions, not repeated collector snapshots, in reverse date order", () => {
  const { assetHealthChanges, assetHealthAge } = load();
  const rows = [
    { status: "HEALTHY", evaluatedAt: "2026-09-27T11:00:00Z", reasons: [] },
    { status: "ATTENTION", evaluatedAt: "2026-09-27T10:00:00Z", reasons: [] },
    { status: "HEALTHY", evaluatedAt: "2026-09-27T08:00:00Z", reasons: [] },
    { status: "HEALTHY", evaluatedAt: "2026-09-27T09:00:00Z", reasons: [] },
  ];
  assert.deepEqual(assetHealthChanges(rows).map((row: { evaluatedAt: string }) => row.evaluatedAt), [rows[0].evaluatedAt, rows[1].evaluatedAt, rows[2].evaluatedAt]);
  assert.equal(assetHealthAge("2026-09-27T10:00:00Z", now), "Atualizado há 2 h");
  assert.equal(assetHealthAge(undefined, now), "Aguardando leitura");
});

test("frontend reads only cached internal snapshots and never imports trading or external collectors", () => {
  assert.match(source, /fetch\(`\/api\/coinops-asset-health\?days=/);
  assert.equal(source.match(/fetch\(/g)?.length, 1);
  assert.doesNotMatch(source, /from ["'][^"']*(?:execution|strategy-engine|sources|server|supabase)/);
  assert.doesNotMatch(source, /method:\s*["'](?:POST|PUT|PATCH|DELETE)/);
  assert.match(source, /pending\.get\(days\)/);
  assert.match(source, /document\.visibilityState === "hidden"/);
});

test("push deep links open only allowlisted BTC or SOL and never accept arbitrary assets or URLs", () => {
  const { assetHealthDeepLink } = load();
  assert.equal(assetHealthDeepLink("?view=live&account=ALL&assetHealth=BTC"), "BTC");
  assert.equal(assetHealthDeepLink("?assetHealth=SOL"), "SOL");
  for (const value of ["", "?assetHealth=ETH", "?assetHealth=btc", "?assetHealth=https%3A%2F%2Fevil.example", "?assetHealth=BTC%3Balert(1)"]) {
    assert.equal(assetHealthDeepLink(value), null);
  }
});
