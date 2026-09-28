import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const React = require("react");
const source = readFileSync(new URL("./market-panels.tsx", import.meta.url), "utf8");
const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

type Element = { type: unknown; props: Record<string, any> };
function all(node: any, predicate: (element: Element) => boolean): Element[] {
  return React.Children.toArray(node).flatMap((element: Element) => typeof element !== "object" ? []
    : [...(predicate(element) ? [element] : []), ...all(element.props.children, predicate)]);
}

function component(useRealReact = false) {
  const instances = new Map<string, unknown>();
  let currentId = "BTCUSDT";
  const hooks = { ...React, useId: () => currentId, useState: (initial: unknown) => {
    const id = currentId;
    if (!instances.has(id)) instances.set(id, initial);
    return [instances.get(id), (action: (current: unknown) => unknown) => instances.set(id, action(instances.get(id)))];
  } };
  const loadedModule = { exports: {} as { ViewerMarketPanels?: (props: unknown) => Element } };
  const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  new Function("require", "module", "exports", code)((name: string) => name === "react" && !useRealReact ? hooks : require(name), loadedModule, loadedModule.exports);
  return { Component: loadedModule.exports.ViewerMarketPanels!, render: (market = "BTCUSDT") => {
    currentId = market;
    return loadedModule.exports.ViewerMarketPanels!({ market, details: `details-${market}`, ranking: `ranking-${market}` });
  } };
}

test("market panels render two accessible controls and both regions collapsed initially", () => {
  const { Component } = component(true);
  const { renderToStaticMarkup } = require("react-dom/server");
  const html = renderToStaticMarkup(React.createElement(Component, { market: "BTC/USDT", details: "DETAILS", ranking: "RANKING" }));
  assert.equal((html.match(/aria-expanded="false"/g) ?? []).length, 2);
  assert.equal((html.match(/hidden=""/g) ?? []).length, 2);
  assert.match(html, /Ver detalhes/);
  assert.match(html, /Ver ranking/);
  assert.equal((html.match(/role="region"/g) ?? []).length, 2);
  assert.doesNotMatch(source, /fetch\(|useEffect|supabase|localStorage|sessionStorage/);
});

test("ranking toggles open, details replaces it, and a second click collapses", () => {
  const { render } = component();
  const buttons = (element: Element) => all(element, (node) => node.type === "button");
  const states = (element: Element) => all(element, (node) => node.props.role === "region").map((node) => node.props.hidden);
  assert.deepEqual(states(render()), [true, true]);
  buttons(render())[1].props.onClick();
  assert.deepEqual(states(render()), [true, false]);
  buttons(render())[0].props.onClick();
  assert.deepEqual(states(render()), [false, true]);
  buttons(render())[0].props.onClick();
  assert.deepEqual(states(render()), [true, true]);
});

test("opening BTC ranking never opens another market and ARIA targets remain scoped", () => {
  const { render } = component();
  all(render("BTCUSDT"), (node) => node.type === "button")[1].props.onClick();
  for (const market of ["BTCUSDT", "SOLUSDT"]) {
    const result = render(market);
    const buttons = all(result, (node) => node.type === "button");
    const regions = all(result, (node) => node.props.role === "region");
    assert.deepEqual(regions.map((node) => node.props.hidden), market === "BTCUSDT" ? [true, false] : [true, true]);
    buttons.forEach((button, index) => {
      assert.equal(button.props["aria-controls"], regions[index].props.id);
      assert.equal(button.props.id, regions[index].props["aria-labelledby"]);
    });
  }
});

test("viewer ranking is inside each market, preserves fifteen slots and all remaining slots", () => {
  assert.doesNotMatch(page, /viewer-panel viewer-gain-ranking/);
  assert.match(page, /const ranking = gainRanking\.get\(market\.symbol\)/);
  assert.ok(page.indexOf("<ViewerMarketPanels") > page.indexOf('className="viewer-market-grid"'));
  assert.match(page, /rankedSlots\.slice\(0, 15\)/);
  assert.match(page, /rankedSlots\.slice\(15\)/);
  assert.match(page, /Ver mais \{ranking\.rankedSlots\.length - 15\} slots/);
  assert.match(page, /slot\.market_pnl_quote\) - asNumber\(slot\.fees_quote/);
  assert.match(page, /contribution_quote/);
  assert.match(page, /robot_v1_live_selective_contribution_allocations/);
  assert.match(page, /O valor atual já inclui aportes aplicados/);
  assert.match(page, /Aportado/);
  assert.match(page, /aporte pendente/);
  assert.match(page, /coinops_role !== "VIEWER"/);
  assert.match(page, /\.eq\("exchange_account_id", accountId\)/);
});
