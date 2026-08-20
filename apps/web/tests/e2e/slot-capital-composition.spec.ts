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
          <em data-audit>+24 ap.</em>
        </span>
        <span class="compact-slot-metric value">
          <small data-audit>Saldo atual</small>
          <strong data-audit>13,17 USDT</strong>
          <em class="positive" data-audit>extra +1,69</em>
        </span>
        <span class="compact-slot-metric pnl"><small>PnL</small><strong>+1,49 USDT</strong></span>
        <span class="compact-slot-chevron">⌄</span>
      </button>
    </article>
  </div>
`;

test("composição do saldo permanece legível sem overflow", async ({ page }) => {
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
  }
});
