import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import ts from "typescript";

import { AUTOMATION_FIXTURE_NOW, automationPremiumFixture } from "./fixtures/automation-premium";

type View = "overview" | "live" | "shadow" | "testnet";
const views: View[] = ["overview", "live", "shadow", "testnet"];
const appRoot = process.cwd();
const entry = "app/automacao/premium-automation.tsx";
const styles = ["app/globals.css", "app/compact-redesign.css", "app/official-monitoring.css", "app/official-reports.css",
  "app/official-slots.css", "app/official-dashboard.css", "app/desktop-workspace.css",
  "app/desktop-modules.css", "app/automation-redesign.css", "app/automation-center.css",
  "app/automation-cockpit.css", "app/reports-center.css", "app/automacao/live-preparation.css",
  "app/automacao/manual-adjustments.css", "app/automacao/ath-profiles.css",
  "app/automacao/premium-automation.css"];

/** Bundle real client code, never server actions, credentials, or server loaders.
 * This follows the existing open-slot-growth-goal component test harness. */
function clientModules() {
  const modules = new Map<string, string>();
  function collect(file: string): string {
    const absolute = resolve(appRoot, file);
    const id = relative(appRoot, absolute).replaceAll("\\", "/");
    if (modules.has(id)) return id;
    const source = readFileSync(absolute, "utf8");
    if (/^[\s\r\n]*["']use server["']/.test(source)) return "@boundary/actions";
    modules.set(id, "");
    const { outputText } = ts.transpileModule(source, { fileName: absolute,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.React, esModuleInterop: true } });
    const code = outputText.replace(/require\(["']([^"']+)["']\)/g, (_, imported: string) => {
      if (["react", "react-dom", "next/link", "next/image", "next/navigation"].includes(imported))
        return `require(${JSON.stringify(imported)})`;
      if (imported.endsWith(".css")) return 'require("@boundary/css")';
      if (imported.endsWith("-actions") || imported.endsWith("/actions") || imported === "./actions")
        return 'require("@boundary/actions")';
      if (!imported.startsWith(".") && !imported.startsWith("@/"))
        throw new Error(`Unexpected runtime boundary ${imported} from ${id}`);
      const target = imported.startsWith("@/") ? resolve(appRoot, imported.slice(2)) : resolve(dirname(absolute), imported);
      const targetFile = [target, `${target}.tsx`, `${target}.ts`, resolve(target, "index.tsx"), resolve(target, "index.ts")]
        .find((candidate) => existsSync(candidate) && /\.[cm]?[jt]sx?$/.test(candidate));
      if (!targetFile || !isAbsolute(targetFile)) throw new Error(`Missing client dependency ${imported} from ${id}`);
      return `require(${JSON.stringify(collect(targetFile))})`;
    });
    modules.set(id, code);
    return id;
  }
  const entryId = collect(entry);
  return { entryId, code: [...modules].map(([id, code]) => `${JSON.stringify(id)}:function(require,module,exports){\n${code}\n}`).join(",\n") };
}

async function mount(page: Page, view: View, width: number, height = 960, data = automationPremiumFixture()) {
  const browserErrors: string[] = [], requests: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") browserErrors.push(message.text()); });
  await page.route("**/*", async (route) => { requests.push(route.request().url()); await route.abort(); });
  await page.setViewportSize({ width, height });
  await page.clock.setFixedTime(new Date(AUTOMATION_FIXTURE_NOW));
  const css = styles.filter((file) => existsSync(resolve(appRoot, file))).map((file) => readFileSync(resolve(appRoot, file), "utf8")).join("\n");
  await page.setContent(`<!doctype html><html lang="pt-BR"><head><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>${css}</style></head><body><div id="premium-fixture-root"></div></body></html>`);
  await page.addScriptTag({ path: resolve(appRoot, "node_modules/react/umd/react.production.min.js") });
  await page.addScriptTag({ path: resolve(appRoot, "node_modules/react-dom/umd/react-dom.production.min.js") });
  const bundle = clientModules();
  await page.addScriptTag({ content: `(() => {
    const React = window.React;
    const modules = {${bundle.code}};
    const cache = {};
    window.__fixtureActions = [];
    const disabledAction = (name) => (...args) => { window.__fixtureActions.push(name); throw new Error('Server action disabled in UI fixture: ' + name); };
    const boundaries = {
      react: React,
      'react-dom': { ...window.ReactDOM, useFormStatus: () => ({ pending: false }) },
      'next/link': { __esModule: true, default: ({ children, ...props }) => React.createElement('a', props, children) },
      'next/image': { __esModule: true, default: ({ priority, fill, unoptimized, ...props }) => React.createElement('img', props) },
      'next/navigation': { usePathname: () => '/automacao', useSearchParams: () => new URLSearchParams('view=${view}'),
        useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }) },
      '@boundary/css': {},
      '@boundary/actions': new Proxy({}, { get: (_, name) => name === '__esModule' ? false : disabledAction(String(name)) }),
    };
    function require(id) {
      if (Object.prototype.hasOwnProperty.call(boundaries,id)) return boundaries[id];
      if (cache[id]) return cache[id].exports;
      if (!modules[id]) throw new Error('Unregistered client dependency: '+id);
      const module = { exports: {} }; cache[id] = module;
      modules[id](require,module,module.exports); return module.exports;
    }
    document.documentElement.dataset.submissions = '0';
    document.addEventListener('submit', (event) => { event.preventDefault(); document.documentElement.dataset.submissions = String(Number(document.documentElement.dataset.submissions)+1); }, true);
    document.addEventListener('click', (event) => { if (event.target.closest('a[href]')) event.preventDefault(); }, true);
    const { PremiumAutomation } = require(${JSON.stringify(bundle.entryId)});
    const panel = (label) => React.createElement('section', { 'aria-label': label }, React.createElement('h2',null,label),
      React.createElement('p',null,'Painel sintético; nenhuma operação será enviada.'),
      React.createElement('label',null,'Valor de demonstração',React.createElement('input',{defaultValue:'1',type:'number'})));
    window.ReactDOM.createRoot(document.getElementById('premium-fixture-root')).render(React.createElement(PremiumAutomation,{
      view:${JSON.stringify(view)},data:${JSON.stringify(data)},userLabel:'Rafael Demo',
      strategyPanel:panel('Estratégia e parâmetros'),adjustmentsPanel:panel('Ajustes manuais')
    }));
  })();` });
  await expect(page.locator("#premium-fixture-root")).toContainText("CoinOps");
  return { browserErrors, requests };
}

async function geometry(page: Page) {
  return page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    bodyOverflow: document.body.scrollWidth - document.body.clientWidth,
    invalidSvg: [...document.querySelectorAll("svg")].some((svg) => /NaN|Infinity/.test(svg.innerHTML)),
    smallText: [...document.querySelectorAll<HTMLElement>("h1,h2,h3,button,th,td")]
      .filter((element) => element.getBoundingClientRect().width > 0 && parseFloat(getComputedStyle(element).fontSize) < 10)
      .map((element) => element.textContent?.slice(0, 50)),
  }));
}

async function noSideEffects(page: Page, audit: Awaited<ReturnType<typeof mount>>) {
  expect(audit.browserErrors).toEqual([]);
  expect(audit.requests).toEqual([]);
  await expect(page.locator("html")).toHaveAttribute("data-submissions", "0");
  expect(await page.evaluate(() => (window as unknown as { __fixtureActions: string[] }).__fixtureActions)).toEqual([]);
}

async function screenshot(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true, animations: "disabled" });
  await testInfo.attach(name, { path, contentType: "image/png" });
  const viewportPath = testInfo.outputPath(`${name}-viewport.png`);
  await page.screenshot({ path: viewportPath, fullPage: false, animations: "disabled" });
  await testInfo.attach(`${name}-viewport`, { path: viewportPath, contentType: "image/png" });
  const layout = await page.evaluate(() => {
    const selectors = [".px-asset", ".px-asset-facts", ".px-asset-facts span", ".px-asset-facts strong", ".px-asset-facts small",
      ".px-position-table tbody tr", ".px-position-table td", ".px-position-table button", ".px-metric", ".px-metric small",
      ".px-bottom-nav", ".px-toolbar", ".px-toolbar button"];
    return Object.fromEntries(selectors.map((selector) => [selector, [...document.querySelectorAll<HTMLElement>(selector)].slice(0, 8).map((element) => {
      const { width, height, top, bottom } = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return { text: element.textContent?.slice(0, 50), width, height, top, bottom,
        fontSize: style.fontSize, lineHeight: style.lineHeight, padding: style.padding,
        minHeight: style.minHeight, display: style.display, whiteSpace: style.whiteSpace };
    })]));
  });
  await testInfo.attach(`${name}-geometry`, { body: JSON.stringify(layout, null, 2), contentType: "application/json" });
  if (process.env.PREMIUM_GEOMETRY === "1") console.log(name, JSON.stringify(Object.fromEntries(
    Object.entries(layout).map(([selector, elements]) => [selector, elements.slice(0, selector.endsWith("td") ? 8 : 1)])
  )));
}

for (const view of views) for (const width of [1440, 390]) {
  test(`${view}: screenshot ${width >= 1024 ? "desktop" : "mobile"} e render sem efeitos colaterais`, async ({ page }, testInfo) => {
    const audit = await mount(page, view, width, width < 1024 ? 844 : 1000);
    await expect(page.getByText(view === "live" || view === "overview" ? "BTC/BRL" : "BTC/USDC", { exact: true }).first()).toBeVisible();
    if (view === "overview") {
      await expect(page.locator(".px-overview-card")).toHaveCount(3);
      await expect(page.locator(".px-kpis")).toHaveCount(0);
      await expect(page.locator(".px-position-table")).toHaveCount(0);
    } else {
      await expect(page.getByRole("tab", { name: "Próximas BUYs (2)", exact: true })).toBeVisible();
      await expect(page.locator(".px-asset-facts > div:last-child").first()).toContainText("Slot #3");
    }
    expect(await geometry(page)).toEqual({ overflow: 0, bodyOverflow: 0, invalidSvg: false, smallText: [] });
    await screenshot(page, testInfo, `automation-${view}-${width}`);
    await noSideEffects(page, audit);
  });
}

test("quatro ambientes sem overflow na matriz mobile e desktop", async ({ page }) => {
  test.setTimeout(120_000);
  for (const view of views) {
    const audit = await mount(page, view, 360);
    for (const width of [360, 390, 430, 1024, 1280, 1440, 1920]) {
      await page.setViewportSize({ width, height: 960 });
      expect(await geometry(page), `${view} em ${width}px`).toEqual({ overflow: 0, bodyOverflow: 0, invalidSvg: false, smallText: [] });
    }
    await noSideEffects(page, audit);
  }
});

test("toolbar e detalhes preservam navegação sem submeter ações", async ({ page }, testInfo) => {
  const audit = await mount(page, "live", 390, 844);
  const initialOverflow = await page.evaluate(() => document.documentElement.style.overflow);
  const assertDrawerFrame = async () => {
    const frame = await page.getByRole("dialog").evaluate((dialog) => {
      const rect = dialog.getBoundingClientRect();
      return { left: rect.left, right: rect.right, viewport: document.documentElement.clientWidth,
        overflow: document.documentElement.style.overflow };
    });
    expect(frame.left).toBeGreaterThanOrEqual(0);
    expect(frame.right).toBeLessThanOrEqual(frame.viewport);
    expect(frame.overflow).toBe("hidden");
  };
  const assertScrollRestored = async () => {
    await expect.poll(() => page.evaluate(() => document.documentElement.style.overflow)).toBe(initialOverflow);
  };
  for (const label of [/^Estratégia$/, /^Ajustes$/, /^Configurações$/, /^Simulador$/]) {
    await page.getByRole("button", { name: label }).first().click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await assertDrawerFrame();
    expect((await geometry(page)).overflow).toBe(0);
    await page.getByRole("dialog").getByRole("button", { name: /fechar/i }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await assertScrollRestored();
  }
  await page.getByRole("button", { name: /Ver BTC/i }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await screenshot(page, testInfo, "automation-mobile-asset-details");
  await page.getByRole("button", { name: "Ver todos os 25 slots", exact: true }).click();
  await expect(page.getByTestId("premium-slot-row")).toHaveCount(25);
  await page.getByRole("button", { name: "Detalhes do slot 1", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("BTC · Slot físico #1");
  await expect(page.getByRole("dialog")).toContainText("synthetic-live-tp-BTC-1");
  await assertDrawerFrame();
  expect((await geometry(page)).overflow).toBe(0);
  await screenshot(page, testInfo, "automation-mobile-slot-details");
  await page.getByRole("dialog").getByRole("button", { name: /fechar/i }).click();
  await assertScrollRestored();
  for (const label of [/Próximas BUYs/i, /Histórico de operações/i, /^Alertas/]) {
    await page.getByRole("tab", { name: label }).first().click();
    expect((await geometry(page)).overflow).toBe(0);
  }
  await noSideEffects(page, audit);
});

test("rascunhos de estratégia e ajustes sobrevivem ao fechamento e à troca de drawer", async ({ page }) => {
  const audit = await mount(page, "live", 390, 844);
  for (const [buttonLabel, panelLabel, draft] of [
    ["Estratégia", "Estratégia e parâmetros", "12"],
    ["Ajustes", "Ajustes manuais", "35"],
  ]) {
    const trigger = page.getByRole("button", { name: buttonLabel, exact: true });
    await trigger.click();
    const input = page.getByRole("dialog").getByRole("spinbutton", { name: "Valor de demonstração" });
    await input.fill(draft);
    await expect(page.locator(`section[aria-label="${panelLabel}"] input`)).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await page.getByRole("button", { name: "Simulador", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText("Simuladores isolados");
    await page.keyboard.press("Escape");
    await trigger.click();
    await expect(input).toHaveValue(draft);
    await expect(page.locator(`section[aria-label="${panelLabel}"] input`)).toHaveCount(1);
    await page.getByRole("dialog").getByRole("button", { name: "Fechar", exact: true }).click();
    await expect(trigger).toBeFocused();
  }
  await noSideEffects(page, audit);
});

test("tabs operacionais seguem Arrow Home End com foco e painel acessíveis", async ({ page }) => {
  const audit = await mount(page, "live", 1440, 1000);
  const tabs = page.getByRole("tablist", { name: "Operações", exact: true }).getByRole("tab");
  const panel = page.getByRole("tabpanel");
  const expectSelected = async (index: number) => {
    await expect(tabs.nth(index)).toBeFocused();
    await expect(tabs.nth(index)).toHaveAttribute("aria-selected", "true");
    await expect(tabs.nth(index)).toHaveAttribute("tabindex", "0");
    await expect(tabs.nth(index)).toHaveAttribute("aria-controls", "px-operations-content");
    await expect(panel).toHaveAttribute("aria-labelledby", (await tabs.nth(index).getAttribute("id"))!);
    await expect(page.getByRole("tab", { selected: true })).toHaveCount(1);
    expect(await tabs.evaluateAll((elements) => elements.filter((element) => element.getAttribute("tabindex") === "0").length)).toBe(1);
  };
  await tabs.first().focus();
  await expectSelected(0);
  await page.keyboard.press("ArrowRight");
  await expectSelected(1);
  await expect(panel).toContainText("RESIDENTE NA BINANCE");
  await page.keyboard.press("End");
  await expectSelected(3);
  await page.keyboard.press("ArrowRight");
  await expectSelected(0);
  await page.keyboard.press("ArrowLeft");
  await expectSelected(3);
  await page.keyboard.press("Home");
  await expectSelected(0);
  await noSideEffects(page, audit);
});

test("ciclo ACTIVE não apresenta LIVE verde quando o executor está sem saúde", async ({ page }) => {
  for (const view of ["live", "overview"] as const) {
    const data = automationPremiumFixture();
    data.livePreparation!.executor.health!.healthy = false;
    data.livePreparation!.executor.gate = "ATTENTION";
    const audit = await mount(page, view, 390, 844, data);
    await expect(page.locator(".px-live")).toHaveText("LIVE · ATENÇÃO");
    await expect(page.locator(".px-live")).not.toHaveClass(/is-live/);
    await expect(page.locator(".px-alert-banner")).toBeVisible();
    await noSideEffects(page, audit);
  }
});
