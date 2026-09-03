import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const globalCss = readFileSync(resolve(process.cwd(), "app/globals.css"), "utf8");
const compactCss = readFileSync(resolve(process.cwd(), "app/compact-redesign.css"), "utf8");
const mobileWidths = [375, 390, 393, 414, 430];

function batchMarkup(width: number) {
  return `<!doctype html>
    <html lang="pt-BR"><head><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><style>${globalCss}\n${compactCss}</style></head>
    <body><main class="mobile-dashboard-shell app-screen"><section class="section-card neutral">
      <div class="section-card-heading"><div><p>Complete o líder ou ajuste qualquer slot</p><h2>Adicionar gains BTC</h2></div></div>
      <div class="contribution-scope-toggle" role="group"><button type="button">Um slot</button><button class="active" type="button">Em massa</button></div>
      <div class="manual-gain-batch-preview" data-testid="manual-gain-batch-preview">
        <div class="bulk-contribution-summary"><span>4 slots abaixo de 3 gains · 2 OPEN · 2 LIVRES</span><strong>Depositar 4,81234567 USDT para adicionar +2 gains em cada slot</strong></div>
        <details class="manual-gain-batch-items" open><summary>Conferir 4 slots e valores</summary><div>
          <p><strong>#1 · OPEN</strong><span>0 → 2 gains</span><em>1,20 USDT</em></p>
          <p><strong>#2 · LIVRE</strong><span>1 → 3 gains</span><em>1,21 USDT</em></p>
          <p><strong>#3 · OPEN</strong><span>2 → 4 gains</span><em>1,20 USDT</em></p>
          <p><strong>#4 · LIVRE</strong><span>0 → 2 gains</span><em>1,20 USDT</em></p>
        </div></details>
        <form class="bulk-contribution-confirmation"><p>Esta prévia foi calculada no servidor. Se algum slot mudar, o lote inteiro será bloqueado.</p><label class="bulk-contribution-checkbox"><input type="checkbox">Confirmo o aporte total.</label><button class="btc-ladder-button green" type="submit">Confirmar gains em massa</button></form>
        <form class="manual-gain-batch-cancel"><button class="btc-ladder-button neutral" type="submit">Cancelar prévia</button></form>
      </div>
    </section></main></body></html>`;
}

async function renderBatch(page: Page, width: number) {
  await page.setViewportSize({ width, height: 844 });
  await page.setContent(batchMarkup(width));
}

test("prévia de gains em massa mantém controles e valores acessíveis em todos os iPhones alvo", async ({ page }) => {
  for (const width of mobileWidths) {
    await renderBatch(page, width);
    const geometry = await page.evaluate(() => {
      const preview = document.querySelector<HTMLElement>("[data-testid='manual-gain-batch-preview']")!;
      const previewBox = preview.getBoundingClientRect();
      const controls = [...preview.querySelectorAll<HTMLElement>("button, input")];
      return {
        documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        previewOverflow: preview.scrollWidth - preview.clientWidth,
        controlsOutsidePreview: controls.filter((control) => {
          const box = control.getBoundingClientRect();
          return box.left < previewBox.left - 0.5 || box.right > previewBox.right + 0.5;
        }).length,
        shortActionTargets: controls.filter((control) => control.tagName === "BUTTON" && control.getBoundingClientRect().height < 36).length
      };
    });
    expect(geometry, `${width}px`).toEqual({
      documentOverflow: 0,
      previewOverflow: 0,
      controlsOutsidePreview: 0,
      shortActionTargets: 0
    });
    await expect(page.getByText("Confirmar gains em massa")).toBeVisible();
    await expect(page.getByText(/Depositar 4,81234567 USDT/)).toBeVisible();
  }
});
