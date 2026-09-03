import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const cronRoute = readFileSync(
  new URL("../../app/api/cron/market-regime/route.ts", import.meta.url),
  "utf8"
);
const marketRegimeServer = readFileSync(
  new URL("./market-regime-server.ts", import.meta.url),
  "utf8"
);

test("cron permanece silencioso quando a atualizacao conclui sem erro", () => {
  assert.doesNotMatch(cronRoute, /console\.(?:info|log)\(/);
  assert.match(cronRoute, /console\.error\("\[market-regime-cron\] failed"/);
  assert.match(cronRoute, /return NextResponse\.json\(\{ ok: true, state \}\)/);
});

test("market regime agrega somente alteracoes relevantes sem identificar usuarios", () => {
  assert.doesNotMatch(
    marketRegimeServer,
    /official_future_triggers_recalculated|future_triggers_recalculated/
  );
  assert.match(
    marketRegimeServer,
    /if \(globalModeChanged \|\| changedUsers > 0 \|\| recalculatedTriggers > 0\)/
  );
  assert.equal(
    marketRegimeServer.match(/recalculatedTriggers \+= triggerCount;/g)?.length,
    2
  );

  const aggregatedLog = marketRegimeServer.match(
    /console\.info\("\[market-regime\] relevant_changes", \{([\s\S]*?)\n    \}\);/
  );
  assert.ok(aggregatedLog, "o resumo agregado deve permanecer presente");
  assert.doesNotMatch(aggregatedLog[1], /userId|user_id|tenantId|tenant_id/);
});
