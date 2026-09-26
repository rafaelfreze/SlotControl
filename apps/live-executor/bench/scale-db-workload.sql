\set run_id random(1,:max_engine)
BEGIN;
SELECT count(*) FROM bench_slots WHERE run_id=:run_id;
SELECT count(*) FROM bench_orders WHERE run_id=:run_id AND status='NEW';
SELECT id,event_type FROM bench_events WHERE run_id=:run_id ORDER BY observed_at DESC LIMIT 100;
INSERT INTO bench_events(run_id,engine_id,account_id,event_type,details)
  VALUES (:run_id,:run_id,(:run_id+1)/2,'RECONCILED','{"next":"HIGHEST_PRIORITY_BUY_ALREADY_RESIDENT"}'::jsonb);
UPDATE bench_runs SET last_reconciled_at=clock_timestamp() WHERE id=:run_id;
COMMIT;
