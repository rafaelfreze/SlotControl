import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const globalCss = readFileSync(resolve(process.cwd(), "app/globals.css"), "utf8");
const compactCss = readFileSync(resolve(process.cwd(), "app/compact-redesign.css"), "utf8");
const mobileWidths = [375, 390, 393, 414, 430];

type Asset = "BTC" | "SOL";

function contributionMarkup(asset: Asset, amount: number, reviewed: boolean) {
  const openCount = asset === "BTC" ? 4 : 5;
  const total = amount * 25;
  return `<!doctype html>
    <html lang="pt-BR">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
        <style>${globalCss}\n${compactCss}</style>
      </head>
      <body>
        <main class="mobile-dashboard-shell app-screen">
          <section class="section-card neutral">
            <div class="section-card-heading"><div><p>Saldo externo separado de gains reais</p><h2>Aportes ${asset}</h2></div></div>
            <form class="btc-contribution-form" data-testid="bulk-form">
              <div class="contribution-scope-toggle" role="group" aria-label="Slots que receberão o aporte">
                <button type="button">Um slot</button>
                <button type="button" class="active" aria-pressed="true">Todos os 25</button>
              </div>
              <label>Valor por slot<input type="number" value="${amount}" /></label>
              <label class="btc-contribution-reason">Motivo opcional<input type="text" value="Aporte coletivo" /></label>
              <div class="bulk-contribution-action">
                <div class="bulk-contribution-summary">
                  <span>25 slots · ${openCount} OPEN · ${25 - openCount} LIVRES</span>
                  <strong>25 × ${amount.toFixed(2)} USDT = ${total.toFixed(2)} USDT</strong>
                </div>
                ${reviewed ? `<div class="bulk-contribution-confirmation">
                  <p>O aporte será aplicado em todos os 25 slots ${asset}, inclusive os ${openCount} OPEN. Qualquer falha reverte o lote inteiro.</p>
                  <label class="bulk-contribution-checkbox"><input type="checkbox" checked />Confirmo o total de ${total.toFixed(2)} USDT</label>
                  <button class="btc-ladder-button green" type="submit">Confirmar aporte em todos</button>
                </div>` : `<button class="btc-ladder-button green" type="button">Revisar aporte</button>`}
              </div>
            </form>
            <p class="btc-ladder-help">Você pode usar qualquer valor positivo por slot. O saldo entra integralmente em BTC ou SOL, inclusive nos OPEN, sem criar gain nem alterar a posição atual.</p>
          </section>
        </main>
      </body>
    </html>`;
}

async function renderContribution(page: Page, width: number, asset: Asset, amount: number, reviewed: boolean) {
  await page.setViewportSize({ width, height: 844 });
  await page.setContent(contributionMarkup(asset, amount, reviewed));
}

test("aporte coletivo aceita valores livres sem overlap em BTC e SOL", async ({ page }) => {
  for (const width of mobileWidths) {
    for (const asset of ["BTC", "SOL"] as const) {
      for (const amount of [3, 5, 10, 20]) {
        await renderContribution(page, width, asset, amount, true);
        const geometry = await page.evaluate(() => {
          const form = document.querySelector<HTMLElement>("[data-testid='bulk-form']")!;
          const formBox = form.getBoundingClientRect();
          const controls = [...form.querySelectorAll<HTMLElement>(
            ".contribution-scope-toggle button, label > input, .bulk-contribution-action > button, .bulk-contribution-confirmation > button"
          )];
          return {
            documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            formOverflow: form.scrollWidth - form.clientWidth,
            controlsOutsideForm: controls.filter((control) => {
              const box = control.getBoundingClientRect();
              return box.left < formBox.left - 0.5 || box.right > formBox.right + 0.5;
            }).length,
            shortActionTargets: [...form.querySelectorAll<HTMLElement>(
              ".contribution-scope-toggle button, .bulk-contribution-action > button, .bulk-contribution-confirmation > button"
            )].filter((button) => button.getBoundingClientRect().height < 40).length
          };
        });
        expect(geometry, `${asset} ${width}px / ${amount} USDT`).toEqual({
          documentOverflow: 0,
          formOverflow: 0,
          controlsOutsideForm: 0,
          shortActionTargets: 0
        });
        await expect(page.getByText(`= ${(amount * 25).toFixed(2)} USDT`)).toBeVisible();
        await expect(page.getByText(/inclusive os \d+ OPEN/)).toBeVisible();
      }
    }
  }
});

test("captura a revisão final do aporte coletivo mobile", async ({ page }, testInfo: TestInfo) => {
  for (const capture of [
    { asset: "BTC" as const, width: 375, amount: 5 },
    { asset: "SOL" as const, width: 430, amount: 20 }
  ]) {
    await renderContribution(page, capture.width, capture.asset, capture.amount, true);
    const screenshot = await page.screenshot({ fullPage: true });
    await testInfo.attach(`aporte-${capture.asset.toLowerCase()}-${capture.width}.png`, {
      body: screenshot,
      contentType: "image/png"
    });
  }
});
