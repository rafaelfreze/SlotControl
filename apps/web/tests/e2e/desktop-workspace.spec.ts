import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const compactCss = readFileSync(resolve(process.cwd(), "app/compact-redesign.css"), "utf8");
const desktopCss = readFileSync(resolve(process.cwd(), "app/desktop-workspace.css"), "utf8");
const desktopModulesCss = readFileSync(resolve(process.cwd(), "app/desktop-modules.css"), "utf8");
const viewports = [
  [1280, 720], [1366, 768], [1440, 900],
  [1600, 900], [1920, 1080], [2560, 1440]
] as const;

function markup() {
  const nav = ["Resumo", "Slots", "Plano", "Histórico", "Relatórios", "Ciclos", "Alertas", "Configurações"];
  const kpis = ["Patrimônio", "Lucro", "PnL", "BTC", "SOL", "Slots", "Modo"];
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width">
  <style>*{box-sizing:border-box}html,body{margin:0}${compactCss}\n${desktopCss}\n${desktopModulesCss}</style></head><body>
  <div class="desktop-workspace-root">
    <aside class="desktop-workspace-sidebar">
      <a class="desktop-sidebar-brand">COINOPS</a>
      <nav class="desktop-sidebar-nav">${nav.map((item, i) => `<a class="desktop-sidebar-link" data-active="${i === 0}">${item}</a>`).join("")}</nav>
      <footer class="desktop-sidebar-footer">Feed conectado</footer>
    </aside>
    <div class="desktop-workspace-main">
      <header class="desktop-workspace-topbar"><strong>Resumo geral</strong><button type="button">Atualizar</button></header>
      <main class="desktop-workspace-content">
        <section class="desktop-kpi-grid">${kpis.map((item) => `<article class="desktop-kpi desktop-kpi-card"><small>${item}</small><strong>123,45 USDT</strong><span>Contexto</span></article>`).join("")}</section>
        <section class="desktop-dashboard-grid">
          <article class="desktop-panel desktop-performance-panel">Desempenho do patrimônio</article>
          <article class="desktop-panel">Distribuição</article>
          <article class="desktop-panel">Alertas</article>
        </section>
        <section class="desktop-panel desktop-table-panel">
          <h2>Próximos slots</h2><div class="desktop-table-wrap"><table class="desktop-data-table"><thead><tr><th>Prioridade</th><th>Ativo</th><th>Slot</th><th>Gains</th><th>Saldo</th><th>Status</th></tr></thead><tbody>
          ${Array.from({ length: 6 }, (_, i) => `<tr><td>${i + 1}</td><td>BTC</td><td>#${i + 2}</td><td>7</td><td>12,34 USDT</td><td>Abaixo da meta</td></tr>`).join("")}</tbody></table></div>
        </section>
      </main>
    </div>
  </div>
  <nav class="bottom-navigation"><a>Resumo</a><a>Slots</a><a>Plano</a><a>Histórico</a><a>Config</a></nav>
  </body></html>`;
}

async function render(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await page.setContent(markup());
}
test("breakpoint desktop inicia em 1024px sem expor a navegação mobile", async ({ page }) => {
  await render(page, 1023, 768);
  await expect(page.locator(".desktop-workspace-root")).toBeHidden();
  await expect(page.locator(".bottom-navigation")).toBeVisible();

  await render(page, 1024, 768);
  await expect(page.locator(".desktop-workspace-root")).toBeVisible();
  await expect(page.locator(".bottom-navigation")).toBeHidden();
});

test("shell ocupa a largura real com densidade consistente na matriz desktop", async ({ page }) => {
  for (const [width, height] of viewports) {
    await render(page, width, height);
    const result = await page.evaluate(() => {
      const box = (selector: string) => {
        const element = document.querySelector<HTMLElement>(selector);
        if (!element) throw new Error(`Elemento ausente: ${selector}`);
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, width: rect.width, height: rect.height };
      };
      const cards = [...document.querySelectorAll<HTMLElement>(".desktop-kpi-card")]
        .map((element) => element.getBoundingClientRect());
      const rows = [...document.querySelectorAll<HTMLTableRowElement>(".desktop-data-table tbody tr")]
        .map((element) => element.getBoundingClientRect());
      const firstTop = cards[0]?.top ?? 0;
      return {
        documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        bodyOverflow: document.body.scrollWidth - document.body.clientWidth,
        root: box(".desktop-workspace-root"),
        sidebar: box(".desktop-workspace-sidebar"),
        main: box(".desktop-workspace-main"),
        topbar: box(".desktop-workspace-topbar"),
        table: box(".desktop-table-panel"),
        cardHeights: cards.map((card) => card.height),
        firstRowCards: cards.filter((card) => Math.abs(card.top - firstTop) < 1).length,
        cardRows: new Set(cards.map((card) => Math.round(card.top))).size,
        rowHeights: rows.map((row) => row.height),
        clippedSidebar: [...document.querySelectorAll<HTMLElement>(".desktop-sidebar-link")]
          .filter((element) => element.scrollWidth > element.clientWidth + 1)
          .map((element) => element.textContent),
        bottomNav: getComputedStyle(document.querySelector<HTMLElement>(".bottom-navigation")!).display
      };
    });

    expect(result.documentOverflow, `${width}x${height} document overflow`).toBe(0);
    expect(result.bodyOverflow, `${width}x${height} body overflow`).toBe(0);
    expect(result.root.width, `${width}px largura do workspace`).toBeCloseTo(width, 0);
    expect(result.sidebar.width, `${width}px sidebar`).toBeGreaterThanOrEqual(220);
    expect(result.sidebar.width, `${width}px sidebar`).toBeLessThanOrEqual(250);
    expect(result.main.left, `${width}px offset do conteúdo`).toBeCloseTo(result.sidebar.right, 0);
    expect(result.main.right, `${width}px limite do conteúdo`).toBeLessThanOrEqual(width + 0.5);
    expect(result.topbar.height, `${width}px topbar compacta`).toBeLessThanOrEqual(80);
    expect(result.cardHeights.every((value) => value >= 90 && value <= 125), `${width}px KPIs compactos`).toBe(true);
    expect(result.firstRowCards, `${width}px densidade dos KPIs`).toBeGreaterThanOrEqual(4);
    expect(result.cardRows, `${width}px linhas de KPIs`).toBeLessThanOrEqual(2);
    expect(result.rowHeights.every((value) => value >= 44 && value <= 58), `${width}px densidade da tabela`).toBe(true);
    expect(result.clippedSidebar, `${width}px labels da sidebar`).toEqual([]);
    expect(result.bottomNav, `${width}px bottom navigation`).toBe("none");

    if (width === 1366) {
      expect(result.table.top, "1366x768 tabela operacional acima da dobra").toBeLessThan(height);
    }
  }
});
