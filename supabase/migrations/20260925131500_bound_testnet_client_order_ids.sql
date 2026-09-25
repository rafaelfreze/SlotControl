-- CoinOps Testnet only. The SOL slot 10 TP was prepared with a 37-character
-- clientOrderId, which Binance Spot rejects before an order can be created.
-- No exchange order or dispatch guard exists for this row. Preserve its
-- original value in the immutable TP_PREPARED event for audit.
alter table coinops.robot_v1_testnet_orders
  drop constraint robot_v1_testnet_orders_client_order_id_check;

alter table coinops.robot_v1_testnet_orders
  add constraint robot_v1_testnet_orders_client_order_id_check
  check (client_order_id ~ '^COV1-(BTC|SOL)-[0-9]+-[0-9]+-(BUY|SELL)-[a-f0-9]{12,18}$');

do $$
declare
  affected integer;
begin
  update coinops.robot_v1_testnet_orders
  set client_order_id = left(client_order_id, 36),
      updated_at = now()
  where status = 'PREPARED'
    and purpose = 'TP'
    and exchange_order_id is null
    and submission_guarded_at is null
    and length(client_order_id) = 37
    and client_order_id ~ '^COV1-(BTC|SOL)-[0-9]+-[0-9]+-SELL-[a-f0-9]{18}$';
  get diagnostics affected = row_count;

  if affected > 1 then
    raise exception 'Unexpected number of Testnet TPs changed';
  end if;

  if exists (select 1 from coinops.robot_v1_testnet_orders where length(client_order_id) > 36) then
    raise exception 'Other Testnet client IDs exceed Binance Spot limit';
  end if;
end $$;

alter table coinops.robot_v1_testnet_orders
  add constraint robot_v1_testnet_client_order_id_max_36
  check (length(client_order_id) <= 36);
