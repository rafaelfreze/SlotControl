import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

import type { AssetLadderPlanResponse } from "../../app/plano-crescimento/btc-ladder-section";

const globalCss = readFileSync(resolve(process.cwd(), "app/globals.css"), "utf8");
const compactCss = readFileSync(resolve(process.cwd(), "app/compact-redesign.css"), "utf8");
const desktopWorkspaceCss = readFileSync(resolve(process.cwd(), "app/desktop-workspace.css"), "utf8");
const desktopModulesCss = readFileSync(resolve(process.cwd(), "app/desktop-modules.css"), "utf8");
const sourceModules: Record<string, string> = {
  "@test/AssetLadderSection": "app/plano-crescimento/btc-ladder-section.tsx",
  "@/components/app/mobile-ui": "components/app/mobile-ui.tsx",
  "@/lib/slotgain/format": "lib/slotgain/format.ts",
  "@/lib/slotgain/financial-tone": "lib/slotgain/financial-tone.ts",
  "@/lib/slotgain/capital-contributions": "lib/slotgain/capital-contributions.ts",
  "@/lib/slotgain/growth-target": "lib/slotgain/growth-target.ts"
};

// Exercise the actual client component and helpers without starting Next, loading
// credentials or importing server actions. Only framework boundaries are stubbed.
const componentModules = Object.entries(sourceModules).map(([id, file]) => {
  const { outputText } = ts.transpileModule(readFileSync(resolve(process.cwd(), file), "utf8"), {
    fileName: file,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.React,
      esModuleInterop: true
    }
  });
  return `${JSON.stringify(id)}: function(require, module, exports) {\n${outputText}\n}`;
}).join(",\n");

function fixture(asset: "BTC" | "SOL", leaderGains = 25): AssetLadderPlanResponse {
  return {
    ok: true,
    asset,
    monthly_goal: 7,
    cycle_number: 4,
    ladder: [
      { rank: 1, slot_id: "open-leader", slot_number: 1, status: "aberto", real_gains: 0, operational_gains: leaderGains, operational_value_usdt: 20 },
      { rank: 2, slot_id: "open-second", slot_number: 2, status: "aberto", real_gains: 0, operational_gains: 24, operational_value_usdt: 19 },
      { rank: 3, slot_id: "closed", slot_number: 3, status: "gain", real_gains: 5, operational_gains: 5, operational_value_usdt: 11 }
    ]
  };
}

async function mountPlan(page: Page, asset: "BTC" | "SOL", leaderGains = 25, options: {
  initialView?: "ladder" | "gains" | "balance";
  plan?: Partial<AssetLadderPlanResponse>;
} = {}) {
  const testRoot = (page.viewportSize()?.width || 0) >= 1024
    ? '<div class="desktop-workspace-root"><aside class="desktop-workspace-sidebar" aria-hidden="true"></aside><div class="desktop-workspace-main"><header class="desktop-workspace-topbar" aria-hidden="true"></header><main class="desktop-workspace-content"><section class="desktop-plan-layout"><div class="desktop-plan-main" id="growth-test-root"></div><aside class="desktop-plan-aside" aria-hidden="true"></aside></section></main></div></div>'
    : '<main class="mobile-dashboard-shell app-screen" id="growth-test-root"></main>';
  await page.setContent(`<!doctype html>
    <html lang="pt-BR"><head>
      <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
      <style>${globalCss}\n${compactCss}\n${desktopWorkspaceCss}\n${desktopModulesCss}</style>
    </head><body>${testRoot}</body></html>`);
  await page.addScriptTag({ path: resolve(process.cwd(), "node_modules/react/umd/react.production.min.js") });
  await page.addScriptTag({ path: resolve(process.cwd(), "node_modules/react-dom/umd/react-dom.production.min.js") });
  await page.addScriptTag({ content: `(() => {
    const React = window.React;
    const modules = { ${componentModules} };
    const cache = {};
    const boundaryModules = {
      react: React,
      "react-dom": { ...window.ReactDOM, useFormStatus: () => ({ pending: false }) },
      "next/link": { __esModule: true, default: (props) => React.createElement("a", props) },
      "next/image": { __esModule: true, default: (props) => React.createElement("img", props) },
      "next/navigation": { usePathname: () => "/plano-crescimento" },
      "./actions": new Proxy({}, { get: () => "#synthetic-action-disabled" })
    };
    function require(id) {
      if (Object.prototype.hasOwnProperty.call(boundaryModules, id)) return boundaryModules[id];
      if (cache[id]) return cache[id].exports;
      if (!modules[id]) throw new Error("Unexpected component dependency: " + id);
      const module = { exports: {} };
      cache[id] = module;
      modules[id](require, module, module.exports);
      return module.exports;
    }
    document.documentElement.dataset.submissions = "0";
    document.addEventListener("submit", (event) => {
      event.preventDefault();
      document.documentElement.dataset.submissions = String(Number(document.documentElement.dataset.submissions) + 1);
    }, true);
    const { AssetLadderSection } = require("@test/AssetLadderSection");
    window.ReactDOM.createRoot(document.getElementById("growth-test-root")).render(
      React.createElement(AssetLadderSection, {
        asset: ${JSON.stringify(asset)},
        plan: ${JSON.stringify({ ...fixture(asset, leaderGains), ...options.plan })},
        initialView: ${JSON.stringify(options.initialView)},
        actionKeys: {
          prepare: "test-prepare", confirm: "test-confirm", contribution: "test-contribution",
          balanceContribution: "test-balance", prepareManualGains: "test-bulk-prepare", confirmManualGains: "test-bulk-confirm"
        }
      })
    );
  })();` });
  await expect(page.getByRole("heading", { name: `${options.initialView === "balance" ? "Aportes" : "Adicionar gains"} ${asset}` })).toBeVisible();
}

function metric(page: Page, label: string) {
  return page.getByText(label, { exact: true }).locator("..").locator("strong");
}

for (const asset of ["BTC", "SOL"] as const) {
  for (const width of [1280, 390]) {
    test(`${asset}: líder aberto e sugestão por slot em ${width}px`, async ({ page }) => {
      const browserErrors: string[] = [];
      const requests: string[] = [];
      page.on("pageerror", (error) => browserErrors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") browserErrors.push(message.text());
      });
      await page.route("**/*", async (route) => {
        requests.push(route.request().url());
        await route.abort();
      });
      await page.setViewportSize({ width, height: 844 });
      await mountPlan(page, asset);

      const slot = page.getByRole("combobox", { name: "Slot", exact: true });
      const gains = page.getByRole("spinbutton", { name: "Gains a adicionar", exact: true });
      await expect(metric(page, "Meta atual do líder")).toHaveText("28 gains");
      await expect(metric(page, "Líder atual")).toHaveText("Slot #1 · 25");
      await expect(metric(page, "Faltam no líder")).toHaveText("3 gains");
      await expect(slot).toHaveValue("open-leader");
      await expect(slot.locator("option:checked")).toContainText("OPEN");
      await expect(gains).toHaveValue("3");
      await expect(page.getByRole("button", { name: "Adicionar gains", exact: true })).toBeEnabled();

      await slot.selectOption("open-second");
      await expect(gains).toHaveValue("4");
      await gains.fill("9");
      await page.getByRole("textbox", { name: "Observação opcional", exact: true }).fill("Exemplo sintético sem envio");
      await expect(gains).toHaveValue("9");
      await expect(metric(page, "Faltam no líder")).toHaveText("3 gains");
      await slot.selectOption("closed");
      await expect(gains).toHaveValue("23");
      await slot.selectOption("open-leader");
      await expect(gains).toHaveValue("3");

      await mountPlan(page, asset, 28);
      await expect(metric(page, "Faltam no líder")).toHaveText("0 gains");
      await expect(slot).toHaveValue("open-leader");
      await expect(gains).toHaveValue("1");
      await expect(page.getByRole("button", { name: "Adicionar gains", exact: true })).toBeEnabled();
      await expect(page.locator("html")).toHaveAttribute("data-submissions", "0");
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
      expect(browserErrors).toEqual([]);
      expect(requests).toEqual([]);
    });

    test(`${asset}: painel sem redistribuição preserva gains, aportes, meta e histórico em ${width}px`, async ({ page }, testInfo) => {
      const browserErrors: string[] = [];
      const requests: string[] = [];
      page.on("pageerror", (error) => browserErrors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") browserErrors.push(message.text());
      });
      await page.route("**/*", async (route) => {
        requests.push(route.request().url());
        await route.abort();
      });
      await page.setViewportSize({ width, height: 844 });

      const preparedPreview = {
        batch_id: "synthetic-prepared-redistribution",
        status: "PREPARED",
        snapshot_hash: "synthetic-snapshot",
        reference_level: 21,
        equity_before_usdt: 50,
        equity_after_usdt: 50,
        equity_difference_usdt: 0,
        total_transferred_usdt: 1,
        transfer_count: 1,
        ranking_before: fixture(asset).ladder!,
        ranking_after: fixture(asset).ladder!,
        transfers: [{ donor_slot_number: 1, receiver_slot_number: 3, donor_status: "aberto", receiver_status: "gain", donor_gain_equivalent: 1, receiver_gain_equivalent: 1, amount_usdt: 1 }]
      };
      const historicalPlan: Partial<AssetLadderPlanResponse> = {
        reference_level: 21,
        preview: preparedPreview,
        history: [{
          batch_id: "synthetic-completed-history",
          status: "COMPLETED",
          month_reference: "2026-09-01",
          reference_level: 21,
          total_transferred_usdt: 1,
          transfer_count: 1,
          created_at: "2026-09-01T12:00:00Z",
          transfers: preparedPreview.transfers
        }],
        contributions: [{
          id: "synthetic-contribution-history",
          slot_id: "closed",
          slot_number: 3,
          amount_usdt: 2,
          gain_equivalent: 0,
          input_mode: "USDT",
          reason: "Aporte sintético preservado",
          created_at: "2026-09-02T12:00:00Z"
        }]
      };
      await mountPlan(page, asset, 25, { plan: historicalPlan });

      const tabs = page.getByRole("tablist", { name: `Funções do plano ${asset}` });
      await expect(tabs.getByRole("tab")).toHaveText(["Adicionar gains", "Aportes"]);
      await expect(tabs.getByRole("tab", { name: "Adicionar gains", exact: true })).toHaveAttribute("aria-selected", "true");
      await expect(page.getByRole("tab", { name: /Escada/ })).toHaveCount(0);
      await expect(page.getByTestId("prepare-redistribution")).toHaveCount(0);
      await expect(page.getByRole("button", { name: /redistribui/i })).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "Prévia da redistribuição" })).toHaveCount(0);
      await expect(page.locator(".btc-preview-card")).toHaveCount(0);

      const goal = page.getByTestId("plan-setting-goal");
      await expect(goal).toContainText("Meta mensal");
      await goal.getByRole("button", { name: "Editar", exact: true }).click();
      const goalForm = page.getByTestId("plan-setting-goal-editor");
      await expect(goalForm.locator('input[name="asset"]')).toHaveValue(asset);
      await expect(goalForm.locator('input[name="referenceLevel"]')).toHaveValue("21");
      await expect(goalForm.getByRole("spinbutton", { name: "Nova meta mensal" })).toHaveValue("7");
      await goalForm.getByRole("spinbutton", { name: "Nova meta mensal" }).fill("8");
      await expect(goalForm.locator('input[name="referenceLevel"]')).toHaveValue("21");
      await expect(goalForm.getByRole("button", { name: "Salvar", exact: true })).toBeEnabled();
      await goalForm.getByRole("button", { name: "Cancelar", exact: true }).click();
      await expect(goalForm).toHaveCount(0);
      await expect(page.getByRole("spinbutton", { name: "Gains a adicionar", exact: true })).toHaveValue("3");
      if (width >= 1024) {
        const dimensions = await page.locator(".btc-manual-gain-form").evaluate((form) => {
          const style = getComputedStyle(form);
          return {
            innerWidth: form.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
            helpWidth: form.querySelector(".btc-ladder-help")!.getBoundingClientRect().width,
            slotWidth: form.querySelector("select")!.getBoundingClientRect().width
          };
        });
        expect(Math.abs(dimensions.helpWidth - dimensions.innerWidth)).toBeLessThanOrEqual(1);
        expect(dimensions.slotWidth).toBeGreaterThanOrEqual(130);
      }
      await page.screenshot({ path: testInfo.outputPath(`gains-${asset}-${width}.png`), fullPage: true });

      await tabs.getByRole("tab", { name: "Aportes", exact: true }).click();
      await expect(page.getByRole("heading", { name: `Aportes ${asset}` })).toBeVisible();
      await expect(page.getByRole("spinbutton", { name: "Valor USDT", exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: `Adicionar gains ${asset}` })).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath(`aportes-${asset}-${width}.png`), fullPage: true });

      const history = page.locator("details.plan-history-drawer");
      await expect(history.locator(":scope > summary")).toHaveText(`Histórico financeiro ${asset}`);
      await expect(history).toHaveJSProperty("open", false);
      await history.locator(":scope > summary").click();
      await expect(history).toContainText("Concluída · 1 transferências");
      await expect(history).toContainText("Aporte sintético preservado");
      await expect(history.locator("form, button, input, select")).toHaveCount(0);
      await history.locator(":scope > summary").click();
      await tabs.getByRole("tab", { name: "Adicionar gains", exact: true }).click();
      await expect(page.getByRole("heading", { name: `Adicionar gains ${asset}` })).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("data-submissions", "0");

      // A stale bookmark and a prepared server response cannot restore the retired UI.
      await mountPlan(page, asset, 25, { initialView: "ladder", plan: historicalPlan });
      await expect(tabs.getByRole("tab")).toHaveText(["Adicionar gains", "Aportes"]);
      await expect(tabs.getByRole("tab", { name: "Adicionar gains", exact: true })).toHaveAttribute("aria-selected", "true");
      await expect(page.locator(".btc-preview-card")).toHaveCount(0);
      await expect(page.getByTestId("prepare-redistribution")).toHaveCount(0);
      await expect(page.getByRole("button", { name: /redistribui/i })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Cancelar", exact: true })).toHaveCount(0);
      await expect(history).toHaveJSProperty("open", false);
      await expect(page.locator("html")).toHaveAttribute("data-submissions", "0");
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
      expect(browserErrors).toEqual([]);
      expect(requests).toEqual([]);
    });
  }
}
