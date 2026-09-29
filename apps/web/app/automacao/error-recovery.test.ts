import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./error.tsx", import.meta.url), "utf8");

test("automation error boundary performs one bounded recovery without an infinite retry", () => {
  assert.match(source, /sessionStorage\.getItem\(key\) === "1"/);
  assert.match(source, /sessionStorage\.setItem\(key, "1"\)/);
  assert.match(source, /setTimeout\(retry, 600\)/);
  assert.doesNotMatch(source, /setInterval|location\.reload/);
});
