import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./premium-automation.tsx", import.meta.url), "utf8");
const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const watchdog = readFileSync(new URL("./watchdog-card.tsx", import.meta.url), "utf8");

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

test("shared quotes render once above infrastructure with only two USDT markets and no heading copy", () => {
  const dashboard = source.indexOf('<main className="px-dashboard">');
  const quotes = source.indexOf('className="px-market-overview"');
  const capacity = source.indexOf('<CapacityCard />');
  assert.ok(dashboard >= 0 && quotes > dashboard && capacity > quotes);
  assert.equal(source.match(/className="px-market-overview"/g)?.length, 1);
  assert.match(source, /const usdtMarketOrder = \["BTCUSDT", "SOLUSDT"\]/);
  assert.match(source, /\.filter\(\(item\) => usdtMarketOrder\.includes\(item\.symbol\)\)/);
  assert.doesNotMatch(source, /Cotações por moeda/);
  assert.doesNotMatch(source, /Até 4 mercados/);
  assert.match(source, /\{allAccounts \? <section className="px-market-overview"/);
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
