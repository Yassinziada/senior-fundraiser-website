-- =============================================================================
-- CLEAR TEST SALES — run ONLY BEFORE THE REAL EVENT STARTS.
--
-- Supabase Dashboard -> SQL Editor -> paste this file -> Run.
--
-- What it does (all-or-nothing):
--   * deletes ALL transactions, sale lines, void requests and cash handovers
--   * deletes the 'sale' and 'void_restore' stock movements and puts that
--     stock back on the products (manual adjustments and starting stock stay)
--   * restarts transaction numbers at 1
--   * KEEPS products, prices, costs, categories, users, settings and the
--     complete audit log (a 'test_data_cleared' entry is added)
--
-- This is the ONLY place where ledger rows are deleted; the append-only
-- triggers are switched off for the duration of this transaction only.
-- Take a backup / CSV export first if you are unsure.
-- =============================================================================
begin;

alter table public.transactions      disable trigger transactions_guard;
alter table public.transaction_items disable trigger transaction_items_no_update;
alter table public.stock_movements   disable trigger stock_movements_no_update;
alter table public.void_requests     disable trigger void_requests_guard;
alter table public.cash_handovers    disable trigger cash_handovers_guard;

-- undo the stock effect of sales and voids
update public.products p
   set stock = p.stock - m.net
  from (select product_id, sum(quantity_change) as net
          from public.stock_movements
         where movement_type in ('sale', 'void_restore')
         group by product_id) m
 where m.product_id = p.id;

do $$
declare n_tx int;
begin
  select count(*) into n_tx from public.transactions;
  delete from public.stock_movements where movement_type in ('sale', 'void_restore');
  delete from public.cash_handovers;
  delete from public.void_requests;
  delete from public.transaction_items;
  delete from public.transactions;
  insert into public.audit_logs (actor_name, actor_role, action, entity_type, details)
  values ('SQL editor', 'system', 'test_data_cleared', 'transaction',
          jsonb_build_object('transactions_removed', n_tx));
end $$;

alter sequence public.transaction_no_seq restart with 1;

alter table public.transactions      enable trigger transactions_guard;
alter table public.transaction_items enable trigger transaction_items_no_update;
alter table public.stock_movements   enable trigger stock_movements_no_update;
alter table public.void_requests     enable trigger void_requests_guard;
alter table public.cash_handovers    enable trigger cash_handovers_guard;

commit;
