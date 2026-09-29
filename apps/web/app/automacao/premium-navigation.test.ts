import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./premium-automation.tsx", import.meta.url), "utf8");
const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const watchdog = readFileSync(new URL("./watchdog-card.tsx", import.meta.url), "utf8");
const capacity = readFileSync(new URL("./capacity-card.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("./premium-automation.css", import.meta.url), "utf8");

test("product environment navigation is only Testnet and Real; default stays Live", () => {
  assert.match(source, /const visibleEnvironments = \["testnet", "live"\] as const/);
  const nav = source.slice(source.indexOf('<nav className="px-environments"'), source.indexOf('<div className="px-scope-filters"'));
  assert.match(nav, /visibleEnvironments\.map/);
  assert.doesNotMatch(nav, /Object\.keys\(labels\)/);
  assert.match(page, /searchParams\?\.testnet === "check" \? "testnet" : "live"/);
});

test("product toolbar hides internal operations, reports and simulators without deleting tools", () => {
  const toolbar = source.slice(source.indexOf('<nav className="px-toolbar"'), source.indexOf('aria-label="Saúde da operação Live"'));
  for (const name of ["Início", "Estratégia", "Ajustes", "Configurações", "Custos &amp; Operação"]) assert.ok(toolbar.includes(name), name);
  for (const name of ['"Operações"', '"Relatórios"', '"Simulador"']) assert.ok(!toolbar.includes(name), name);
  const menu = source.slice(source.indexOf('{panel === "menu" ?'));
  assert.ok(!menu.includes("Relatórios da Automação"));
  for (const route of ["../relatorios/page.tsx", "./simulador-ath/page.tsx", "./simulador-ajustes/page.tsx"]) {
    assert.ok(existsSync(new URL(route, import.meta.url)), `Internal route retained: ${route}`);
  }
  assert.ok(source.includes('id="premium-operations"'), "positions, next orders and alert evidence remain available");
});

test("desktop navigation shares the top context row while mobile order stays explicit", () => {
  const context = source.slice(source.indexOf('<div className="px-context-bar">'), source.indexOf('aria-label="Saúde da operação Live"'));
  assert.ok(context.indexOf('className="px-environments"') < context.indexOf('className="px-toolbar"'));
  assert.ok(context.indexOf('className="px-toolbar"') < context.indexOf('className="px-scope-filters"'));
  assert.match(styles, /\.px-mobile-sticky-header \.px-toolbar\{flex:none;min-height:44px;margin:0;border:0/);
  assert.match(styles, /\.px-mobile-sticky-header \.px-toolbar\{order:3;/);
});

test("mobile account search does not trigger iOS zoom and both scope controls stay aligned", () => {
  assert.match(styles, /\.px-mobile-sticky-header \.px-scope-filters\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(styles, /\.px-account-selector-trigger,\.px-scope-filters select\{width:100%;height:44px;min-height:44px;max-width:100%\}/);
  assert.match(styles, /\.px-account-selector-popover input\{font-size:16px\}/);
});

test("shared quotes render once above infrastructure with only two USDT markets and no heading copy", () => {
  const dashboard = source.indexOf('<main className="px-dashboard">');
  const quotes = source.indexOf('className="px-market-overview"');
  const capacity = source.indexOf('<CapacityCard ');
  assert.ok(dashboard >= 0 && quotes > dashboard && capacity > quotes);
  assert.equal(source.match(/className="px-market-overview"/g)?.length, 1);
  assert.match(source, /const usdtMarketOrder = \["BTCUSDT", "SOLUSDT"\]/);
  assert.match(source, /\.filter\(\(item\) => usdtMarketOrder\.includes\(item\.symbol\)\)/);
  assert.doesNotMatch(source, /Cotações por moeda/);
  assert.doesNotMatch(source, /Até 4 mercados/);
  assert.match(source, /\{allAccounts \? <section className="px-market-overview"/);
  assert.match(styles, /\.px-market-overview\{width:min\(100%,940px\);justify-self:center\}/);
  assert.match(styles, /\.px-market-chart-grid\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
});

test("home stays compact with no greeting and account pagination ranked by operated exposure", () => {
  assert.doesNotMatch(source, /Olá, \{userLabel/);
  assert.doesNotMatch(source, /Seu robô está operando no servidor/);
  assert.match(source, /rankPremiumAccountsByOperatedBalance\(accounts, assets\)/);
  assert.match(source, /rankedAccounts\.slice\(0, accountLimit\)/);
  assert.match(source, /setAccountLimit\(accountLimit \+ 10\)/);
});

test("watchdog starts collapsed and reveals operational evidence on demand", () => {
  assert.match(watchdog, /<details>/);
  assert.doesNotMatch(watchdog, /<details open/);
  assert.match(watchdog, /Ver detalhes/);
  assert.match(watchdog, /Executores: \{status\.executors\.healthy\}\/\{status\.executors\.total\} saudáveis/);
});

test("infrastructure area shows only compact executor cards", () => {
  assert.doesNotMatch(capacity, /<h2>Infraestrutura<\/h2>/);
  assert.doesNotMatch(capacity, /className="px-panel px-capacity"/);
  assert.match(capacity, /className="px-panel px-capacity-shard"/);
  assert.match(capacity, /expandedShard === shard\.id \? "Ocultar detalhes" : "Ver detalhes"/);
  assert.match(styles, /\.px-capacity-expand\{display:block/);
  assert.match(styles, /\.px-capacity-details\{display:none/);
  assert.match(styles, /\.px-capacity-details\.is-expanded\{display:flex\}/);
});

test("all-accounts home hides account-detail operation, engine, capital, limit and activity cards", () => {
  assert.match(source, /\{!allAccounts \? <section className="px-operations px-panel"/);
  assert.match(source, /\{!allAccounts \? <div className="px-lower-grid"><section className="px-panel px-capital"/);
  assert.match(source, /\{!allAccounts \? <section className="px-assets"/);
  assert.doesNotMatch(source, /Motores por conta/);
  assert.match(source, /<section className="px-panel px-activity">/);
});
