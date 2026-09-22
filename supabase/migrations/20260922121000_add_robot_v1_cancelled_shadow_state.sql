-- A cancelled state preserves invalidated virtual entries when a completed
-- Shadow cycle is automatically rebuilt. It never represents an exchange order.

alter table coinops.robot_v1_slots
  drop constraint robot_v1_slots_status_check,
  add constraint robot_v1_slots_status_check check (status in ('PENDING','PARTIALLY_FILLED','OPEN','TP_ACTIVE','CLOSED','CANCELLED'));

comment on column coinops.robot_v1_slots.status is 'Shadow slot lifecycle. CANCELLED records an unfilled virtual entry invalidated during an automatic cycle reset; it is never an exchange cancellation.';
