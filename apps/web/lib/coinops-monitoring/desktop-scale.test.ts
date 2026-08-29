import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const desktopCss = readFileSync(new URL("../../app/desktop-workspace.css", import.meta.url), "utf8");

test("desktop workspace keeps KPI values at or above 20px", () => {
  assert.match(desktopCss, /@media\s*\(min-width:\s*1024px\)/);

  const match = desktopCss.match(/--desktop-font-value:\s*([\d.]+)rem/);
  assert.ok(match, "desktop KPI token must be declared");

  const remValue = Number(match[1]);
  assert.ok(Number.isFinite(remValue));
  assert.ok(remValue * 16 >= 20, `expected KPI token >= 20px, received ${remValue * 16}px`);
});
