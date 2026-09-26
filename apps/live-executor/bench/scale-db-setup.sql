-- Isolated local PostgreSQL fixture. Never run against Production/Supabase.
CREATE TABLE bench_accounts (id integer PRIMARY KEY, status text NOT NULL);
CREATE TABLE bench_engines (id integer PRIMARY KEY, account_id integer NOT NULL REFERENCES bench_accounts(id), status text NOT NULL);
CREATE TABLE bench_runs (id integer PRIMARY KEY, engine_id integer NOT NULL UNIQUE REFERENCES bench_engines(id), status text NOT NULL, last_reconciled_at timestamptz);
CREATE TABLE bench_slots (run_id integer NOT NULL REFERENCES bench_runs(id), slot_number integer NOT NULL, state text NOT NULL, quantity numeric(24,12) NOT NULL DEFAULT 0, PRIMARY KEY(run_id,slot_number));
CREATE TABLE bench_orders (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, run_id integer NOT NULL REFERENCES bench_runs(id), slot_number integer NOT NULL, status text NOT NULL, side text NOT NULL, price numeric(24,8), client_order_id text NOT NULL UNIQUE);
CREATE INDEX bench_orders_run_status ON bench_orders(run_id,status);
CREATE TABLE bench_events (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, run_id integer NOT NULL REFERENCES bench_runs(id), engine_id integer NOT NULL, account_id integer NOT NULL, event_type text NOT NULL, observed_at timestamptz NOT NULL DEFAULT clock_timestamp(), details jsonb NOT NULL DEFAULT '{}'::jsonb);
CREATE INDEX bench_events_run_time ON bench_events(run_id,observed_at DESC);
CREATE INDEX bench_events_account_time ON bench_events(account_id,observed_at DESC);
INSERT INTO bench_accounts SELECT n, 'ACTIVE' FROM generate_series(1,100) n;
INSERT INTO bench_engines SELECT n, (n+1)/2, 'ACTIVE' FROM generate_series(1,200) n;
INSERT INTO bench_runs SELECT n,n,'ACTIVE',clock_timestamp() FROM generate_series(1,200) n;
INSERT INTO bench_slots SELECT r.id,s.n,'PLANNED',0 FROM bench_runs r CROSS JOIN generate_series(1,25) s(n);
INSERT INTO bench_orders(run_id,slot_number,status,side,price,client_order_id)
  SELECT r.id,1,'NEW','SELL',100,'TP-'||r.id FROM bench_runs r;
INSERT INTO bench_orders(run_id,slot_number,status,side,price,client_order_id)
  SELECT r.id,2,'NEW','BUY',98,'BUY-'||r.id FROM bench_runs r;
-- 288,000 events at 200 engines = one reconciliation event/engine/minute/day.
INSERT INTO bench_events(run_id,engine_id,account_id,event_type,observed_at,details)
  SELECT r.id,r.id,(r.id+1)/2,'RECONCILED',clock_timestamp() - (1440-n) * interval '1 minute',
    jsonb_build_object('next','HIGHEST_PRIORITY_BUY_ALREADY_RESIDENT')
  FROM bench_runs r CROSS JOIN generate_series(1,1440) n;
ANALYZE;
