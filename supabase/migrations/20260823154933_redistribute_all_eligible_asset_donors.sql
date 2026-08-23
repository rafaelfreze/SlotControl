-- Consume the whole-gain excess from every eligible BTC/SOL donor.
--
-- V3 only proposed a transfer when the same USDT amount converted to whole
-- gains on both sides. A donor with a different gain unit (for example after
-- a manual contribution) was silently skipped. V4 keeps both operational
-- counters whole, debits the donor's whole-gain excess and credits the exact
-- same USDT amount to the receiver. Any sub-gain financial residual remains
-- in the receiver's operational balance instead of becoming a fractional
-- gain or disappearing.

do $migration$
declare
  preview_function oid;
  function_definition text;
  old_allocation_block text := $old$
        donor_capacity_usdt := round(donor_excess * donor_gain_unit, 8);

        candidate_receiver_gains := least(
          receiver_deficit::integer,
          trunc(donor_capacity_usdt / receiver_gain_unit)::integer
        );
        amount_usdt := 0;
        donor_gain_equivalent := 0;
        receiver_gain_equivalent := 0;

        while candidate_receiver_gains > 0 loop
          candidate_amount := round(candidate_receiver_gains * receiver_gain_unit, 8);
          candidate_donor_gains := round(candidate_amount / donor_gain_unit, 8);
          if candidate_donor_gains = trunc(candidate_donor_gains)
            and candidate_donor_gains > 0
            and candidate_donor_gains <= donor_excess then
            amount_usdt := candidate_amount;
            donor_gain_equivalent := candidate_donor_gains;
            receiver_gain_equivalent := candidate_receiver_gains;
            exit;
          end if;
          candidate_receiver_gains := candidate_receiver_gains - 1;
        end loop;
$old$;
  new_allocation_block text := $new$
        donor_capacity_usdt := round(donor_excess * donor_gain_unit, 8);

        -- Spend as many whole donor gains as the current receiver can absorb
        -- without crossing the reference. The exact USDT debit is credited;
        -- only complete receiver gains advance its operational counter.
        candidate_donor_gains := least(
          donor_excess::integer,
          trunc((receiver_deficit * receiver_gain_unit) / donor_gain_unit)::integer
        );
        amount_usdt := 0;
        donor_gain_equivalent := 0;
        receiver_gain_equivalent := 0;

        while candidate_donor_gains > 0 loop
          candidate_amount := round(candidate_donor_gains * donor_gain_unit, 8);
          candidate_receiver_gains := least(
            receiver_deficit::integer,
            trunc(candidate_amount / receiver_gain_unit)::integer
          );
          if candidate_receiver_gains > 0 then
            amount_usdt := candidate_amount;
            donor_gain_equivalent := candidate_donor_gains;
            receiver_gain_equivalent := candidate_receiver_gains;
            exit;
          end if;
          candidate_donor_gains := candidate_donor_gains - 1;
        end loop;
$new$;
begin
  preview_function := to_regprocedure(
    'private.coinops_build_asset_ladder_preview(uuid,uuid,uuid,text,numeric)'
  );
  if preview_function is null then
    raise exception 'COINOPS_GROWTH_PREVIEW_FUNCTION_NOT_FOUND';
  end if;

  function_definition := pg_get_functiondef(preview_function);

  if position('''_LADDER_WHOLE_GAINS_V3''' in function_definition) = 0 then
    raise exception 'COINOPS_GROWTH_PREVIEW_VERSION_UNEXPECTED';
  end if;
  if position(old_allocation_block in function_definition) = 0 then
    raise exception 'COINOPS_GROWTH_PREVIEW_ALLOCATION_BLOCK_NOT_FOUND';
  end if;

  function_definition := replace(
    function_definition,
    '''_LADDER_WHOLE_GAINS_V3''',
    '''_LADDER_ALL_DONORS_WHOLE_GAINS_V4'''
  );
  function_definition := replace(
    function_definition,
    old_allocation_block,
    new_allocation_block
  );

  execute function_definition;
end;
$migration$;

-- A V3 preview must never be confirmed after the allocation algorithm changes.
-- Completed history is untouched; preparing again creates a V4 snapshot.
update coinops.btc_redistribution_batches batch
set
  status = 'STALE',
  result = batch.result || jsonb_build_object(
    'status', 'STALE',
    'can_confirm', false,
    'stale_reason', 'ALGORITHM_UPDATED'
  ),
  updated_at = timezone('utc', now())
where batch.status = 'PREPARED';

revoke all on function private.coinops_build_asset_ladder_preview(uuid, uuid, uuid, text, numeric)
  from public, anon, authenticated, service_role;
