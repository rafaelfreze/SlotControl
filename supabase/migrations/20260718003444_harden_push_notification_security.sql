create index if not exists notification_deliveries_subscription_idx
  on public.notification_deliveries (subscription_id);
create index if not exists notification_outbox_slot_idx
  on public.notification_outbox (slot_id);
create index if not exists notification_outbox_operation_idx
  on public.notification_outbox (operation_id);

drop policy if exists "No direct client access to notification outbox" on public.notification_outbox;
create policy "No direct client access to notification outbox"
  on public.notification_outbox for all to authenticated
  using (false)
  with check (false);

drop policy if exists "No direct client access to notification deliveries" on public.notification_deliveries;
create policy "No direct client access to notification deliveries"
  on public.notification_deliveries for all to authenticated
  using (false)
  with check (false);

revoke all on function public.enqueue_slot_notification_from_history() from anon, authenticated;
revoke all on function public.claim_notification_outbox(integer) from anon, authenticated;
grant execute on function public.claim_notification_outbox(integer) to service_role;

drop function if exists public.queue_push_test_notification();
