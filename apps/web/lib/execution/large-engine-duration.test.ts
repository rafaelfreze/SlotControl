import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("LIVE execution duration agrees across route and deployment configuration", () => {
  const config = JSON.parse(readFileSync(new URL("../../vercel.json", import.meta.url), "utf8"));
  const route = readFileSync(new URL("../../app/api/cron/live-execution/route.ts", import.meta.url), "utf8");
  assert.match(route, /export const maxDuration = 300;/);
  assert.equal(config.functions["app/api/cron/live-execution/route.ts"].maxDuration, 300);
  assert.equal(config.crons.find((cron: { path: string }) => cron.path === "/api/cron/live-execution").schedule, "* * * * *");
  const server = readFileSync(new URL("./robot-v1-live-server.ts", import.meta.url), "utf8");
  assert.match(server, /LARGE_ENGINE_RECONCILIATION_SLICE_MS = 120_000/);
  // This is consistency, not proof that every possible invocation fits 300s.
  assert.equal(config.functions["app/api/cron/coinops-watchdog/route.ts"].maxDuration, 60);
});
