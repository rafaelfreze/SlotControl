import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const globalCss = readFileSync(resolve(process.cwd(), "app/globals.css"), "utf8");
const compactCss = readFileSync(resolve(process.cwd(), "app/compact-redesign.css"), "utf8");
const mobileWidths = [375, 390, 393, 414, 430];

type Asset = "BTC" | "SOL";
type Editor = "goal" | "reference" | null;

function metric(label: string, value: string, helper = "") {
  return `<div><span data-geometry-label>${label}</span><strong>${value}</strong>${helper ? `<small>${helper}</small>` : ""}</div>`;
}

function settingRow(asset: Asset, kind: "goal" | "reference", editor: Editor) {
  const isGoal = kind === "goal";
  const editing = editor === kind;
  const value = isGoal ? (asset === "BTC" ? "7 gains" : "1 gain") : (asset === "BTC" ? "21 gains" : "3 gains");
  const inputValue = isGoal ? (asset === "BTC" ? "7" : "1") : (asset === "BTC" ? "21" : "3");
  return `
    <div class="plan-setting-row${editing ? " editing" : ""}" data-testid="plan-setting-${kind}">
      <div class="plan-setting-row-summary">
        <span><small>${isGoal ? "Meta mensal" : "Referência da escada"}</small><strong>${value}</strong></span>
        <button type="button" aria-expanded="${editing}">${editing ? "Fechar" : "Editar"}</button>
      </div>
      ${editing ? `<div class="plan-setting-editor">
        <form class="plan-setting-form" data-testid="plan-setting-${kind}-editor">
          <label><span data-geometry-label>${isGoal ? "Nova meta mensal" : "Nova referência"}</span><input value="${inputValue}" /></label>
          <button class="plan-setting-cancel" type="button">Cancelar</button>
          <button class="btc-ladder-button gold" type="submit">Salvar</button>
        </form>
      </div>` : ""}
    </div>`;
}

function rankingRows(asset: Asset) {
  return Array.from({ length: asset === "BTC" ? 8 : 6 }, (_, index) => `
    <details class="btc-ladder-row" role="listitem">
      <summary>
        <strong>#${index + 1}</strong>
        <span>Slot ${index + 4}</span>
        <b>${Math.max(1, (asset === "BTC" ? 21 : 3) - index)} gains</b>
        <em class="${index === 1 ? "open" : "free"}">${index === 1 ? "OPEN" : "LIVRE"}</em>
      </summary>
    </details>`).join("");
}

function planMarkup(asset: Asset, editor: Editor) {
  const reference = asset === "BTC" ? 21 : 3;
  return `<!doctype html>
  <html lang="pt-BR">
    <head>
      <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
      <style>${globalCss}\n${compactCss}</style>
    </head>
    <body>
      <div class="app-frame">
        <main class="mobile-dashboard-shell app-screen">
          <header class="minimal-page-header"><a class="minimal-page-header-back">‹</a><h1>Plano de Crescimento</h1><div></div></header>
          <section class="market-ticker online"><div><span>BTCUSDT</span><strong>77.670,00</strong></div><div><span>SOLUSDT</span><strong>95,59</strong></div><div class="online"><span>ONLINE</span><strong>19:41:20</strong></div></section>
          <section class="section-card neutral growth-start-card">
            <div class="section-card-heading"><div><p>Início da operação</p><h2>Ciclo atual</h2></div></div>
            <div class="growth-cycle-summary"><span>Iniciado em<strong>31/05, 20:00</strong></span><span>Ciclo atual<strong>83 dias</strong></span></div>
            <details class="growth-start-editor"><summary>Editar data inicial</summary></details>
          </section>
          <div class="filter-chips"><button class="${asset === "BTC" ? "active" : ""}">BTC <strong>25</strong></button><button class="${asset === "SOL" ? "active" : ""}">SOL <strong>10</strong></button></div>
          <div class="btc-plan-workspace">
            <div class="plan-mode-tabs"><button class="active">Escada ${asset}</button><button>Adicionar gains</button><button>Aportes</button></div>
            <section class="section-card ${asset === "BTC" ? "gold" : "purple"} btc-ladder-main">
              <div class="section-card-heading"><div><p>Ciclo iniciado em 31/07/2026</p><h2>Escada ${asset}</h2></div></div>
              <div class="btc-ladder-summary ladder-summary-compact" data-testid="ladder-summary">
                ${metric("Reais", asset === "BTC" ? "25" : "9", "estimado (histórico legado)")}
                ${metric("Referência", `${reference} gains`)}
                ${metric("Excedente", "0 gains")}
                ${metric("Elegível", "0,00 USDT")}
              </div>
              <div class="plan-settings" data-testid="plan-settings">
                ${settingRow(asset, "goal", editor)}
                ${settingRow(asset, "reference", editor)}
                <form class="redistribution-cta" data-testid="prepare-redistribution"><button class="btc-ladder-button gold">Preparar redistribuição</button></form>
              </div>
              <details class="btc-ladder-guide"><summary>Como funciona?</summary></details>
              <div class="btc-ladder-table" role="list" data-testid="ladder-ranking">
                <div class="btc-ladder-table-head"><span>Ranking</span><span>Slot</span><span>Nível</span><span>Status</span></div>
                ${rankingRows(asset)}
              </div>
            </section>
          </div>
        </main>
        <nav class="bottom-navigation"><a>◈<small>Resumo</small></a><a>▦<small>Slots</small></a><a class="active">↗<small>Plano</small></a><a>◷<small>Histórico</small></a><a>⚙<small>Config</small></a></nav>
      </div>
    </body>
  </html>`;
}

async function renderPlan(page: Page, width: number, asset: Asset, editor: Editor = null) {
  await page.setViewportSize({ width, height: 844 });
  await page.setContent(planMarkup(asset, editor));
  await page.locator("[data-testid='plan-settings']").scrollIntoViewIfNeeded();
}

async function geometry(page: Page) {
  return page.evaluate(() => {
    const rect = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height };
    };
    const intersects = (first: ReturnType<typeof rect>, second: ReturnType<typeof rect>) => Boolean(first && second
      && first.left < second.right - 0.5 && first.right > second.left + 0.5
      && first.top < second.bottom - 0.5 && first.bottom > second.top + 0.5);
    const formOverlap = [...document.querySelectorAll<HTMLElement>(".plan-setting-form")].flatMap((form) => {
      const items = [...form.querySelectorAll<HTMLElement>("input, button, [data-geometry-label]")];
      return items.flatMap((item, index) => items.slice(index + 1).filter((other) => intersects(
        (() => { const box = item.getBoundingClientRect(); return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height }; })(),
        (() => { const box = other.getBoundingClientRect(); return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height }; })()
      )).map((other) => `${item.tagName}:${other.tagName}`));
    });
    const rankingOverlap = [...document.querySelectorAll<HTMLElement>(".btc-ladder-row > summary")].flatMap((row) => {
      const items = [...row.children] as HTMLElement[];
      return items.flatMap((item, index) => items.slice(index + 1).filter((other) => intersects(
        (() => { const box = item.getBoundingClientRect(); return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height }; })(),
        (() => { const box = other.getBoundingClientRect(); return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height }; })()
      )).map((other) => `${item.textContent}:${other.textContent}`));
    });
    const goal = rect("[data-testid='plan-setting-goal']");
    const reference = rect("[data-testid='plan-setting-reference']");
    const prepare = rect("[data-testid='prepare-redistribution']");
    const ranking = rect("[data-testid='ladder-ranking']");
    return {
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      mainOverflow: document.querySelector<HTMLElement>(".mobile-dashboard-shell")!.scrollWidth - document.querySelector<HTMLElement>(".mobile-dashboard-shell")!.clientWidth,
      goalReferenceOverlap: intersects(goal, reference),
      referencePrepareOverlap: intersects(reference, prepare),
      prepareRankingOverlap: intersects(prepare, ranking),
      clippedLabels: [...document.querySelectorAll<HTMLElement>("[data-geometry-label]")]
        .filter((element) => element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1)
        .map((element) => element.textContent),
      formOverlap,
      rankingOverlap,
      rowHeights: [...document.querySelectorAll<HTMLElement>(".btc-ladder-row > summary")].map((row) => row.getBoundingClientRect().height)
    };
  });
}

test("Plano BTC e SOL não possuem overlap ou scroll horizontal nas larguras mobile", async ({ page }) => {
  for (const width of mobileWidths) {
    for (const asset of ["BTC", "SOL"] as const) {
      for (const editor of [null, "goal", "reference"] as const) {
        await renderPlan(page, width, asset, editor);
        const result = await geometry(page);
        expect(result, `${asset} ${width}px editor ${editor || "fechado"}`).toMatchObject({
          documentOverflow: 0,
          mainOverflow: 0,
          goalReferenceOverlap: false,
          referencePrepareOverlap: false,
          prepareRankingOverlap: false,
          clippedLabels: [],
          formOverlap: [],
          rankingOverlap: []
        });
        expect(result.rowHeights.every((height) => height >= 52 && height <= 64), `${asset} ${width}px`).toBe(true);

        if (editor === null) {
          const main = page.locator(".mobile-dashboard-shell");
          await main.evaluate((element) => { element.scrollTop = element.scrollHeight; });
          const lastRow = await page.locator(".btc-ladder-row").last().boundingBox();
          const navigation = await page.locator(".bottom-navigation").boundingBox();
          expect(lastRow, `${asset} ${width}px último item`).not.toBeNull();
          expect(navigation, `${asset} ${width}px navegação`).not.toBeNull();
          expect(lastRow!.y + lastRow!.height, `${asset} ${width}px último item acima da navegação`).toBeLessThanOrEqual(navigation!.y + 0.5);
        }
      }
    }
  }
});

test("captura os seis estados móveis finais do Plano", async ({ page }, testInfo: TestInfo) => {
  const captures: Array<{ asset: Asset; width: 375 | 393; editor: Editor; name: string }> = [
    { asset: "BTC", width: 375, editor: null, name: "plano-btc-375.png" },
    { asset: "BTC", width: 393, editor: null, name: "plano-btc-393.png" },
    { asset: "SOL", width: 375, editor: null, name: "plano-sol-375.png" },
    { asset: "SOL", width: 393, editor: null, name: "plano-sol-393.png" },
    { asset: "BTC", width: 375, editor: "goal", name: "plano-btc-meta-aberta.png" },
    { asset: "SOL", width: 393, editor: "reference", name: "plano-sol-referencia-aberta.png" }
  ];

  for (const capture of captures) {
    await renderPlan(page, capture.width, capture.asset, capture.editor);
    const path = testInfo.outputPath(capture.name);
    const screenshot = await page.screenshot({ path, fullPage: false });
    await testInfo.attach(capture.name, { body: screenshot, contentType: "image/png" });
  }
});
