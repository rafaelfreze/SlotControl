revoke all on table public.notification_outbox from anon, authenticated;
revoke all on table public.notification_deliveries from anon, authenticated;

grant select, insert, update, delete on table public.notification_outbox to service_role;
grant select, insert, update, delete on table public.notification_deliveries to service_role;
