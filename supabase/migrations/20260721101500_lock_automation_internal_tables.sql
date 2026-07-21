begin;

create index if not exists automation_market_cursors_locked_by_idx
  on public.automation_market_cursors (locked_by);
create index if not exists automation_price_windows_worker_run_idx
  on public.automation_price_windows (worker_run_id);
create index if not exists automation_decisions_worker_run_idx
  on public.automation_decisions (worker_run_id);

create policy "automation_worker_runs_no_client_access"
  on public.automation_worker_runs
  for all to anon, authenticated
  using (false)
  with check (false);

create policy "automation_market_cursors_no_client_access"
  on public.automation_market_cursors
  for all to anon, authenticated
  using (false)
  with check (false);

create policy "automation_price_windows_no_client_access"
  on public.automation_price_windows
  for all to anon, authenticated
  using (false)
  with check (false);

commit;
