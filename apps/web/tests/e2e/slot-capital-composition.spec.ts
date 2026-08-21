import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const compactCss = readFileSync(resolve(process.cwd(), "app/compact-redesign.css"), "utf8");

const markup = `
  <div class="compact-slot-list">
    <article class="compact-slot-row btc">
      <div class="compact-slot-operational-row">
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
        </button>
        <form class="slot-quick-action"><button class="slot-quick-button open" type="submit">+ Abrir</button></form>
        <button class="compact-slot-menu" type="button" aria-label="Mais ações">⋯</button>
      </div>
    </article>
  </div>
`;

test("saldo total consolidado permanece legível sem subtotais e sem overflow", async ({ page }) => {
  for (const width of [320, 360, 375, 390, 393, 414, 430, 1365]) {
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
      row: document.querySelector(".compact-slot-operational-row")!.scrollWidth
        - document.querySelector(".compact-slot-operational-row")!.clientWidth,
      clippedLabels: [...document.querySelectorAll<HTMLElement>("[data-audit]")]
        .filter((element) => element.scrollWidth > element.clientWidth + 1)
        .map((element) => element.textContent)
    }));

    expect(overflow, `viewport ${width}px`).toEqual({ page: 0, row: 0, clippedLabels: [] });
    await expect(page.locator(".compact-slot-trigger")).not.toContainText("ap.");
    await expect(page.locator(".compact-slot-trigger")).not.toContainText("extra");
    await expect(page.locator(".compact-slot-trigger")).not.toContainText("PnL");
    await expect(page.locator(".slot-quick-button")).toHaveText("+ Abrir");
  }
});

test("navegação inferior permanece presa ao viewport durante o scroll mobile", async ({ page }) => {
  for (const width of [320, 360, 375, 390, 393, 414, 430]) {
    await page.setViewportSize({ width, height: 844 });
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
    const frame = page.locator(".app-frame");
    const navigation = page.locator(".bottom-navigation");
    const frameBefore = await frame.boundingBox();
    const before = await navigation.boundingBox();

    expect(frameBefore, `viewport ${width}px`).not.toBeNull();
    expect(before, `viewport ${width}px`).not.toBeNull();
    await shell.evaluate((element) => { element.scrollTop = 900; });
    await expect.poll(() => shell.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

    const after = await navigation.boundingBox();
    const frameAfter = await frame.boundingBox();
    const scrollState = await page.evaluate(() => ({
      pageScroll: window.scrollY,
      viewportHeight: window.innerHeight,
      navigationPosition: getComputedStyle(document.querySelector<HTMLElement>(".bottom-navigation")!).position,
      horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
    }));

    expect(after, `viewport ${width}px`).not.toBeNull();
    expect(frameAfter, `viewport ${width}px`).not.toBeNull();
    expect(Math.round(frameBefore!.y + frameBefore!.height), `viewport ${width}px`).toBe(scrollState.viewportHeight);
    expect(Math.round(frameAfter!.y + frameAfter!.height), `viewport ${width}px`).toBe(scrollState.viewportHeight);
    expect(Math.round(after!.height), `viewport ${width}px`).toBe(62);
    expect(Math.round(after!.y), `viewport ${width}px`).toBe(Math.round(before!.y));
    expect(Math.round(after!.y + after!.height), `viewport ${width}px`).toBe(scrollState.viewportHeight);
    expect(scrollState.navigationPosition).toBe("fixed");
    expect(scrollState.pageScroll).toBe(0);
    expect(scrollState.horizontalOverflow).toBe(0);
  }
});

test("controles superiores não são comprimidos por listas longas", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.setContent(`
    <style>
      :root {
        --co-bg: #050a11;
        --co-surface: #0d1722;
        --co-text: #f7f8fa;
        --co-muted: #8994a3;
        --co-line: #233140;
        --co-green: #28d991;
        --co-gold: #d6a936;
        --co-gold-soft: rgba(214, 169, 54, .1);
      }
      * { box-sizing: border-box; }
      html, body { margin: 0; }
      ${compactCss}
    </style>
    <div class="app-frame">
      <main class="mobile-dashboard-shell app-screen">
        <header class="app-brand-header">COINOPS</header>
        <div class="filter-chips">
          <button type="button" class="active">Todos <strong>35</strong></button>
          <button type="button">BTC <strong>25</strong></button>
          <button type="button">SOL <strong>10</strong></button>
        </div>
        <details class="slot-overview-drawer">
          <summary>Saldo operacional total <span>538,30 USDT</span></summary>
        </details>
        <div class="compact-slot-list">${markup.repeat(35)}</div>
      </main>
      <nav class="bottom-navigation" aria-label="Navegação principal"></nav>
    </div>
  `);

  const measurements = await page.evaluate(() => ({
    filters: document.querySelector(".filter-chips")!.getBoundingClientRect().height,
    overview: document.querySelector(".slot-overview-drawer")!.getBoundingClientRect().height,
    firstRow: document.querySelector(".compact-slot-row")!.getBoundingClientRect().height,
    pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
  }));

  expect(measurements.filters).toBeGreaterThanOrEqual(33.9);
  expect(measurements.overview).toBeGreaterThanOrEqual(33.9);
  expect(measurements.firstRow).toBeGreaterThanOrEqual(55);
  expect(measurements.pageOverflow).toBe(0);
});

test("ação rápida ocupa o primeiro nível e bloqueia reenvio enquanto processa", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.setContent(`
    <style>
      :root { --co-bg:#050a11; --co-surface:#0d1722; --co-text:#f7f8fa; --co-muted:#8994a3; --co-line:#233140; --co-green:#28d991; --co-gold:#d6a936; --co-gold-soft:rgba(214,169,54,.1); }
      * { box-sizing: border-box; }
      body { margin: 0; padding: 9px; background: var(--co-bg); color: var(--co-text); }
      ${compactCss}
    </style>
    ${markup}
    <script>
      window.submissions = 0;
      document.querySelector('.slot-quick-action').addEventListener('submit', (event) => {
        event.preventDefault();
        const button = event.currentTarget.querySelector('button');
        if (button.disabled) return;
        button.disabled = true;
        button.textContent = 'Abrindo...';
        window.submissions += 1;
      });
    </script>
  `);

  const quickAction = page.locator(".slot-quick-button");
  await quickAction.dblclick();

  await expect(quickAction).toBeDisabled();
  await expect(quickAction).toHaveText("Abrindo...");
  await expect.poll(() => page.evaluate(() => (window as typeof window & { submissions: number }).submissions)).toBe(1);
  await expect(page.locator(".compact-slot-menu")).toHaveAccessibleName("Mais ações");
});
