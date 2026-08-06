-- Recupera a classificação manual de metas feita pela migration anterior.
-- Gains reais registrados depois da abertura permanecem reais.

drop trigger if exists slots_enforce_gain_breakdown on public.slots;

with affected_openings as (
  select distinct on (history.slot_id)
    history.slot_id,
    ((regexp_match(history.detail, '([0-9]+) gains adicionados foram incorporados ao ciclo operacional'))[1])::integer as restored_added_gains
  from public.history_events history
  where history.action = 'Abertura'
    and history.detail like '%gains adicionados foram incorporados ao ciclo operacional%'
    and history.slot_id is not null
  order by history.slot_id, history.event_at desc
)
update public.slots slot
set
  real_gains = slot.real_gains - affected.restored_added_gains,
  added_gains = affected.restored_added_gains
from affected_openings affected
where slot.id = affected.slot_id
  and slot.status in ('aberto', 'gain', 'hold')
  and slot.gains = slot.real_gains
  and slot.added_gains = 0
  and affected.restored_added_gains > 0
  and affected.restored_added_gains <= slot.real_gains;

create trigger slots_enforce_gain_breakdown
before update of gains, real_gains, added_gains, status on public.slots
for each row
execute function public.enforce_slot_gain_breakdown();
