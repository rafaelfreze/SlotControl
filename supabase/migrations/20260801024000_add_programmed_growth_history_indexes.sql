-- Indexes for the audit history foreign keys used by support and slot lookups.
create index if not exists programmed_growth_contributions_slot_id_idx
  on public.programmed_growth_contributions (slot_id);

create index if not exists programmed_growth_contributions_applied_by_idx
  on public.programmed_growth_contributions (applied_by);
