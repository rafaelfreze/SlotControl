import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const compactCss = readFileSync(resolve(process.cwd(), "app/compact-redesign.css"), "utf8");

const markup = `
  <div class="compact-slot-list">
    <article class="compact-slot-row btc">
      <button class="compact-slot-trigger" type="button">
        <span class="compact-asset-icon btc">₿</span>
        <span class="compact-slot-identity">
          <strong>#12 BTC</strong>
          <span class="compact-slot-status-line"><span class="status-badge free">LIVRE</span><small>rank 1</small></span>
        </span>
        <span class="compact-slot-metric">
          <small data-audit>Gains op.</small>
          <strong data-audit>22</strong>
        </span>
        <span class="compact-slot-metric value">
          <small data-audit>Saldo atual</small>
          <strong data-audit>13,17 USDT</strong>
        </span>
        <span class="compact-slot-metric pnl"><small>PnL</small><strong>+1,49 USDT</strong></span>
        <span class="compact-slot-chevron">⌄</span>
      </button>
    </article>
  </div>
`;

test("saldo total consolidado permanece legível sem subtotais e sem overflow", async ({ page }) => {
  for (const width of [320, 360, 390, 430, 1365]) {
    await page.setViewportSize({ width, height: 800 });
    await page.setContent(`
      <style>
        :root {
          --co-bg: #050a11;
          --co-surface: #0d1722;
          --co-text: #f7f8fa;
          --co-muted: #8994a3;
          --co-line: #233140;
          --co-line-strong: #34485b;
          --co-btc: #f5a623;
          --co-sol: #9b62e8;
          --co-green: #28d991;
          --co-red: #ff5a70;
          --co-gold: #d6a936;
          --co-gold-soft: rgba(214, 169, 54, .1);
        }
        * { box-sizing: border-box; }
        body { width: 100%; margin: 0; padding: 9px; background: var(--co-bg); color: var(--co-text); font-family: Arial, sans-serif; }
        ${compactCss}
      </style>
      ${markup}
    `);

    const overflow = await page.evaluate(() => ({
      page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      row: document.querySelector(".compact-slot-trigger")!.scrollWidth
        - document.querySelector(".compact-slot-trigger")!.clientWidth,
      clippedLabels: [...document.querySelectorAll<HTMLElement>("[data-audit]")]
        .filter((element) => element.scrollWidth > element.clientWidth + 1)
        .map((element) => element.textContent)
    }));

    expect(overflow, `viewport ${width}px`).toEqual({ page: 0, row: 0, clippedLabels: [] });
    await expect(page.locator(".compact-slot-trigger")).not.toContainText("ap.");
    await expect(page.locator(".compact-slot-trigger")).not.toContainText("extra");
  }
});

test("navegação inferior permanece presa ao viewport durante o scroll mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.setContent(`
    <!doctype html>
    <html lang="pt-BR">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
        <style>
          :root {
            --co-bg: #050a11;
            --co-surface: #0d1722;
            --co-text: #f7f8fa;
            --co-muted: #8994a3;
            --co-line: #233140;
            --co-gold: #d6a936;
          }
          * { box-sizing: border-box; }
          html, body { margin: 0; }
          ${compactCss}
        </style>
      </head>
      <body>
        <div class="app-frame">
          <main class="mobile-dashboard-shell app-screen">
            <div style="height: 1800px">Conteúdo longo</div>
          </main>
          <nav class="bottom-navigation" aria-label="Navegação principal">
            <a href="#"><span>◈</span><small>Resumo</small></a>
            <a href="#"><span>▦</span><small>Slots</small></a>
            <a href="#"><span>↗</span><small>Plano</small></a>
            <a href="#"><span>◷</span><small>Histórico</small></a>
            <a href="#"><span>⚙</span><small>Config</small></a>
          </nav>
        </div>
      </body>
    </html>
  `);

  const shell = page.locator(".mobile-dashboard-shell");
  const navigation = page.locator(".bottom-navigation");
  const before = await navigation.boundingBox();

  expect(before).not.toBeNull();
  await shell.evaluate((element) => {
    element.scrollTop = 900;
  });
  await expect.poll(() => shell.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

  const after = await navigation.boundingBox();
  const scrollState = await page.evaluate(() => ({
    pageScroll: window.scrollY,
    viewportHeight: window.innerHeight
  }));

  expect(after).not.toBeNull();
  expect(Math.round(after!.y)).toBe(Math.round(before!.y));
  expect(Math.round(after!.y + after!.height)).toBe(scrollState.viewportHeight);
  expect(scrollState.pageScroll).toBe(0);
});
