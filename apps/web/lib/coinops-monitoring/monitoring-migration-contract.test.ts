import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../../../../supabase/migrations/20260829163312_fix_official_baseline_drawdown_and_reserve_fallback.sql",
    import.meta.url
  ),
  "utf8"
);

test("baseline snapshot calculates the BTC drawdown from persisted prices", () => {
  assert.match(migration, /coalesce\(new\.metrics->>'kind',''\) <> 'BASELINE'/);
  assert.match(migration, /\{account,official_btc_ath\}/);
  assert.match(
    migration,
    /\(\(btc_price \/ nullif\(greatest\(btc_ath,btc_price\),0\)\) - 1\) \* 100/
  );
});

test("NORMAL uses reserve only while an unavailable MAIN remains below target", () => {
  assert.match(
    migration,
    /select exists\([\s\S]*?progress\.cycle_progress<progress\.target[\s\S]*?pool\.pool='MAIN'[\s\S]*?into has_unmet_main_target/
  );
  assert.match(
    migration,
    /if not has_unmet_main_target then[\s\S]*?'ALL_TARGETS_MET'[\s\S]*?pool\.pool='RESERVE' and pool\.allow_reserve/
  );

  const reserveBranches = migration.match(
    /pool\.pool='RESERVE' and pool\.allow_reserve/g
  );
  assert.equal(reserveBranches?.length, 2, "NORMAL and DEFENSIVE must each have one reserve fallback");
});
