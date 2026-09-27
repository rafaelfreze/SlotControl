import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

// Synthetic, network-free fixture. The interactive component is the real production source.
const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const css = ["app/meu-coinops/viewer.css", "app/meu-coinops/viewer-redesign.css"].map(read).join("\n");
const component = ts.transpileModule(read("app/meu-coinops/market-panels.tsx"), { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React,
} }).outputText;
const slotRows = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) =>
  `<div class="viewer-gain-slot"><strong>#${from + index}</strong><span>${Math.max(0, 15 - index)}</span><span>0</span><strong>0 USDT</strong></div>`).join("");
const ranking = (base: string) => `<section class="viewer-gain-ranking" aria-label="Ranking de ganhos de ${base}/USDT"><div class="viewer-ranking-summary"><div><strong>#1 · ${base}/USDT</strong><small>12 gains · 2 no mês</small></div><div><small>P&amp;L realizado</small><strong class="viewer-up">1,20 USDT</strong></div></div><p class="viewer-footnote">15 slots por ganhos · P&amp;L líquido de taxas</p><div class="viewer-gain-slots"><div class="viewer-gain-slot viewer-gain-slot--heading"><span>Slot físico</span><span>Gains</span><span>No mês</span><span>P&amp;L líquido</span></div>${slotRows(1, 15)}<details class="viewer-gain-rest"><summary>Ver mais 10 slots</summary>${slotRows(16, 25)}</details></div></section>`;
const details = `<div class="viewer-slots"><p class="viewer-footnote">25 slots · 1 posição aberta</p>${Array.from({ length: 25 }, (_, index) => `<div class="viewer-slot"><strong>Slot #${index + 1}<span>${index === 0 ? "ABERTO" : "EM ESPERA"}</span></strong><small>Saldo 16,00 USDT · 0 gains · 0 no mês</small></div>`).join("")}</div><details class="viewer-details"><summary>Histórico de ganhos</summary><div class="viewer-slots"><p>Sem gain realizado neste período.</p></div></details>`;
const markets = ["BTC", "SOL"];
const markup = `<main class="viewer-app"><div class="viewer-shell">
  <header class="viewer-header"><div class="viewer-brand"><span class="viewer-mark"><i></i></span><span><strong>CoinOps</strong><small>Meu CoinOps · Conta</small></span></div><div class="viewer-account"><span class="viewer-initial">C</span><span>Conta</span><button class="viewer-signout">Sair</button></div></header>
  <section class="viewer-hero"><div><h1>Bom dia, Cliente!</h1><p>Seu robô está operando normalmente.</p></div><div class="viewer-health-group"><span class="viewer-health is-ok">● OPERANDO</span><small>Atualizado agora</small></div></section>
  <section class="viewer-balances"><article class="viewer-panel viewer-balance"><div class="viewer-balance-main"><span class="viewer-wallet">▱</span><div><span>Saldo na Binance · USDT</span><strong>838,00 USDT</strong></div><button>↻</button></div><div class="viewer-balance-facts"><div><small>Em posições</small><b>32,80 USDT</b></div><div><small>Disponível na Binance</small><b>805,20 USDT</b></div><div><small>P&amp;L total estimado</small><b class="viewer-up">+0,33 USDT</b></div></div><small class="viewer-balance-source">Fixture sintética · sem conexão Binance</small></article><details class="viewer-extra-balances"><summary>Outros ativos na Binance</summary></details></section>
  <section class="viewer-market-grid">${markets.map((base) => `<article class="viewer-panel viewer-market viewer-market--${base.toLowerCase()}"><div class="viewer-section-title"><div class="viewer-market-name"><span class="viewer-coin">${base === "BTC" ? "₿" : "◎"}</span><h2>${base}/USDT</h2></div><span class="viewer-ok">OPERANDO</span></div><div class="viewer-market-price"><strong>${base === "BTC" ? "84.719,81" : "118,90"}</strong><span>USDT</span><small class="viewer-up">▲ 1,24% (24h)</small></div><svg class="viewer-chart" viewBox="0 0 100 48" preserveAspectRatio="none"><polyline points="0,43 10,35 20,38 30,25 40,30 50,22 60,29 70,14 80,18 90,9 100,6"/></svg><div class="viewer-market-summary"><div><small>Posições</small><strong>1 / 25</strong></div><div><small>Gains</small><strong>0</strong></div><div><small>P&amp;L aberto estimado</small><strong class="viewer-up">+0,18 USDT</strong></div></div><div id="panels-${base}"></div></article>`).join("")}</section>
  <footer>Fixture visual de dados sintéticos; sem Auth, executor ou exchange.</footer>
</div></main>`;

export const viewerPortalFixtureHtml = `<!doctype html><html lang="pt-BR"><head><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>CoinOps · Viewer fixture</title><style>${css}</style></head><body style="margin:0">${markup}
<script>${read("node_modules/react/umd/react.development.js")}</script>
<script>${read("node_modules/react-dom/umd/react-dom.development.js")}</script>
<script>const module = { exports: {} }; const exports = module.exports; const require = () => React;
${component}
const panels = ${JSON.stringify(markets.map((base) => ({ base, ranking: ranking(base), details })))};
panels.forEach(row => ReactDOM.createRoot(document.getElementById('panels-' + row.base)).render(React.createElement(exports.ViewerMarketPanels, {
market: row.base + '/USDT', details: React.createElement('div', {dangerouslySetInnerHTML:{__html:row.details}}), ranking:React.createElement('div',{dangerouslySetInnerHTML:{__html:row.ranking}})
})));</script></body></html>`;
