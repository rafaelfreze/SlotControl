-- Um slot fechado que recebeu gains para cumprir a meta pode iniciar uma nova
-- operação sem perder valor operacional, total de gains ou histórico. Ao abrir,
-- os gains adicionados são reclassificados para o ciclo operacional do slot.

create or replace function public.enforce_slot_gain_breakdown()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $gain_breakdown$
begin
  if new.gains <> new.real_gains + new.added_gains then
    raise exception 'A soma de gains reais e adicionados deve ser igual ao total de gains.';
  end if;

  if tg_op = 'UPDATE' then
    if new.status = 'zerado'
      and new.gains = 0
      and new.real_gains = 0
      and new.added_gains = 0 then
      return new;
    end if;

    -- Abertura de um slot fechado com ajuste manual de meta: mantém o total
    -- financeiro e de gains, mas impede que um slot ativo carregue esse ajuste.
    if old.status = 'gain'
      and old.added_gains > 0
      and new.status = 'aberto'
      and new.gains = old.gains
      and new.real_gains = new.gains
      and new.added_gains = 0 then
      return new;
    end if;

    if new.status in ('aberto', 'hold')
      and new.added_gains <> 0 then
      raise exception 'Slots abertos ou em espera nao podem ter gains adicionados.';
    end if;

    if new.real_gains <> old.real_gains
      and not (
        old.status = 'aberto'
        and new.status = 'gain'
        and new.real_gains = old.real_gains + 1
        and new.added_gains = old.added_gains
        and new.gains = old.gains + 1
      ) then
      raise exception 'Gains reais so podem ser registrados ao fechar um slot aberto.';
    end if;

    if new.added_gains < old.added_gains then
      raise exception 'Gains adicionados nao podem ser reduzidos sem zerar o slot.';
    end if;

    if new.added_gains <> old.added_gains
      and old.status not in ('gain', 'zerado') then
      raise exception 'Gains adicionados so podem ser aplicados em slots fechados.';
    end if;
  end if;

  return new;
end;
$gain_breakdown$;
