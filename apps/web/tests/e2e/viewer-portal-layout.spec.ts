import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Visual-only fixture: no Auth, service-role client, executor or exchange request.
const css = ["app/meu-coinops/viewer.css", "app/meu-coinops/viewer-redesign.css"]
  .map((path) => readFileSync(resolve(process.cwd(), path), "utf8")).join("\n");
const markup = `<main class="viewer-app"><div class="viewer-shell">
  <header class="viewer-header"><div class="viewer-brand"><span class="viewer-mark"><i></i></span><span><strong>CoinOps</strong><small>Meu CoinOps · Conta</small></span></div><div class="viewer-account"><span class="viewer-initial">C</span><span>Conta</span><button class="viewer-signout">Sair</button></div></header>
  <section class="viewer-hero"><div><h1>Bom dia, Cliente!</h1><p>Seu robô está operando normalmente.</p></div><div class="viewer-health-group"><span class="viewer-health is-ok">● OPERANDO</span><small>Atualizado agora</small></div></section>
  <section class="viewer-balances"><article class="viewer-panel viewer-balance"><div class="viewer-balance-main"><span class="viewer-wallet">▱</span><div><span>Saldo na Binance · USDT</span><strong>838,00 USDT</strong></div><button>↻</button></div><div class="viewer-balance-facts"><div><small>Em posições</small><b>32,80 USDT</b></div><div><small>Disponível na Binance</small><b>805,20 USDT</b></div><div><small>P&amp;L total estimado</small><b class="viewer-up">+0,33 USDT</b></div></div><small class="viewer-balance-source">Leitura direta da Binance · observado agora</small></article></section>
  <section class="viewer-market-grid">${["BTC", "SOL"].map((base) => `<article class="viewer-panel viewer-market viewer-market--${base.toLowerCase()}"><div class="viewer-section-title"><div class="viewer-market-name"><span class="viewer-coin">${base === "BTC" ? "₿" : "◎"}</span><h2>${base}/USDT</h2></div><span class="viewer-ok">OPERANDO</span></div><div class="viewer-market-price"><strong>${base === "BTC" ? "84.719,81" : "118,90"}</strong><span>USDT</span><small class="viewer-up">▲ 1,24% (24h)</small></div><svg class="viewer-chart" viewBox="0 0 100 48" preserveAspectRatio="none"><polyline points="0,43 10,35 20,38 30,25 40,30 50,22 60,29 70,14 80,18 90,9 100,6"/></svg><div class="viewer-market-summary"><div><small>Posições</small><strong>1 / 25</strong></div><div><small>Gains</small><strong>0</strong></div><div><small>P&amp;L aberto estimado</small><strong class="viewer-up">+0,18 USDT</strong></div></div><details class="viewer-details"><summary>Ver detalhes →</summary></details></article>`).join("")}</section>
  <section class="viewer-panel viewer-simulator"><header><h2>Simulador de ganhos</h2><span>Veja um cenário com sua estratégia atual</span></header><div class="viewer-simulator-grid">${["BTC", "SOL"].map((base) => `<div class="viewer-sim-market"><h3><span class="viewer-coin viewer-coin--${base.toLowerCase()}">${base === "BTC" ? "₿" : "◎"}</span>${base}/USDT</h3><div class="viewer-sim-row"><label>Nº de gains<input type="number" value="10"/></label><div><small>Ganho estimado</small><strong>+2,01 USDT</strong></div></div><small>Capital por slot · ganho configurado</small></div>`).join("")}</div><p class="viewer-sim-note">ⓘ Estimativa linear; resultados reais podem diferir.</p></section>
  <footer>Dados da sua conta no ledger CoinOps.</footer>
</div></main>`;

for (const width of [360, 390, 430, 1280]) {
  test(`portal viewer visual fixture ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: width < 500 ? 844 : 900 });
    await page.setContent(`<html lang="pt-BR"><head><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>${css}</style></head><body style="margin:0">${markup}</body></html>`);
    await expect(page.getByRole("heading", { name: "Bom dia, Cliente!" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    expect(await page.locator(".viewer-market").count()).toBe(2);
    await page.screenshot({ path: testInfo.outputPath(`viewer-${width}.png`), fullPage: true });
  });
}
