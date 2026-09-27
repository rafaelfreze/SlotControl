import { expect, test } from "@playwright/test";
import { viewerPortalFixtureHtml } from "../fixtures/viewer-portal";

for (const width of [320, 360, 375, 390, 430, 1280]) {
  test(`portal viewer visual fixture ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: width < 500 ? 844 : 900 });
    await page.setContent(viewerPortalFixtureHtml);
    await expect(page.getByRole("heading", { name: "Bom dia, Cliente!" })).toBeVisible();
    await expect(page.locator(".viewer-market-actions button")).toHaveCount(4);
    expect(await page.locator(".viewer-market").count()).toBe(2);
    await expect(page.locator(".viewer-market-panel:visible")).toHaveCount(0);
    await expect(page.locator(".viewer-balances .viewer-gain-ranking")).toHaveCount(0);
    const btc = page.locator(".viewer-market--btc");
    const sol = page.locator(".viewer-market--sol");
    await btc.getByRole("button", { name: "Ver ranking" }).click();
    await expect(btc.locator(".viewer-gain-ranking")).toBeVisible();
    await expect(sol.locator(".viewer-gain-ranking")).toBeHidden();
    await expect(btc.locator(".viewer-gain-slots > .viewer-gain-slot")).toHaveCount(16);
    await expect(btc.locator(".viewer-gain-rest .viewer-gain-slot").first()).toBeHidden();
    await btc.getByText("Ver mais 10 slots", { exact: true }).click();
    await expect(btc.locator(".viewer-gain-rest .viewer-gain-slot")).toHaveCount(10);
    await expect(btc.locator(".viewer-gain-rest .viewer-gain-slot").first()).toBeVisible();
    await btc.getByRole("button", { name: "Ver detalhes" }).click();
    await expect(btc.locator(".viewer-gain-ranking")).toBeHidden();
    await expect(btc.locator(".viewer-slot")).toHaveCount(25);
    await btc.getByRole("button", { name: "Ver detalhes" }).click();
    await expect(page.locator(".viewer-market-panel:visible")).toHaveCount(0);
    const controls = await btc.locator(".viewer-market-actions button").evaluateAll((buttons) => buttons.map((button) => {
      const box = button.getBoundingClientRect(); return { top: box.top, height: box.height };
    }));
    expect(controls[0].top).toBe(controls[1].top);
    expect(controls.every((control) => control.height >= 44)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    await page.screenshot({ path: testInfo.outputPath(`viewer-${width}.png`), fullPage: true });
  });
}
