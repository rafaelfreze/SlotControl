import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

import type { AssetLadderPlanResponse } from "../../app/plano-crescimento/btc-ladder-section";

const globalCss = readFileSync(resolve(process.cwd(), "app/globals.css"), "utf8");
const compactCss = readFileSync(resolve(process.cwd(), "app/compact-redesign.css"), "utf8");
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

async function mountPlan(page: Page, asset: "BTC" | "SOL", leaderGains = 25) {
  await page.setContent(`<!doctype html>
    <html lang="pt-BR"><head>
      <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
      <style>${globalCss}\n${compactCss}</style>
    </head><body><main class="mobile-dashboard-shell app-screen" id="growth-test-root"></main></body></html>`);
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
        plan: ${JSON.stringify(fixture(asset, leaderGains))},
        initialView: "gains",
        actionKeys: {
          prepare: "test-prepare", confirm: "test-confirm", contribution: "test-contribution",
          balanceContribution: "test-balance", prepareManualGains: "test-bulk-prepare", confirmManualGains: "test-bulk-confirm"
        }
      })
    );
  })();` });
  await expect(page.getByRole("heading", { name: `Adicionar gains ${asset}` })).toBeVisible();
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
  }
}
