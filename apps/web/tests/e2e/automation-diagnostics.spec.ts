import { expect, test } from "@playwright/test";

test.describe("automacao de slots", () => {
  test("a aplicacao responde em desktop e mobile", async ({ page }) => {
    const response = await page.goto("/", { waitUntil: "domcontentloaded" });

    expect(response?.status()).toBeLessThan(500);
    await expect(page.locator("body")).toBeVisible();
  });
});
