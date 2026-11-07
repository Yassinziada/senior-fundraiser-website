-- Run in Fundraiser Test SQL Editor. Preserves all existing data.
-- Applies missing supplier confirmation and money updates; safe to rerun.
begin;

do $prerequisites$ begin if to_regclass('public.supplier_order_items') is null then raise exception 'Apply the staff roles and supplier list setup first.'; end if; end $prerequisites$;

do $upgrade$ begin if not exists(select 1 from information_schema.columns where table_schema='public' and table_name='supplier_order_items' and column_name='delivered_at') then execute $migration$
-- Run once after the supplier-orders migration. Existing stock and receipts
-- are preserved; historical receipts are not treated as supplier confirmations.

alter table public.supplier_order_items
  add column purchased int not null default 0,
  add column delivered int not null default 0,
  add column purchased_at timestamptz,
  add column purchased_by uuid references public.profiles(id),
  add column delivered_at timestamptz,
  add column delivered_by uuid references public.profiles(id);

-- Preserve the already accepted historical quantity without asserting that
-- a supplier confirmed it. Any further receipt needs explicit confirmations.
update public.supplier_order_items
  set purchased = received, delivered = received
  where received > 0;

alter table public.supplier_order_items
  add constraint supplier_item_fulfillment_quantities check (
    received <= delivered and delivered <= purchased
    and purchased <= quantity and delivered >= 0 and purchased >= 0
  ),
  add constraint supplier_item_purchase_actor check (
    (purchased_at is null) = (purchased_by is null)
  ),
  add constraint supplier_item_delivery_actor check (
    (delivered_at is null) = (delivered_by is null)
  );

-- Legacy availability data remains for history, but cannot drive the workflow.
revoke all on function public.supplier_set_available(bigint, boolean)
  from public, anon, authenticated;

create or replace function public._supplier_confirm_quantity(
  p_item bigint, p_quantity int, p_stage text
) returns void language plpgsql security definer set search_path = '' as $$
declare v_me public.profiles; v_item public.supplier_order_items; v_previous int;
begin
  v_me := public._require_roles(array['supplier']);
  select i.* into v_item from public.supplier_order_items i
    join public.supplier_orders o on o.id = i.order_id
    where i.id = p_item and o.supplier_id = v_me.id for update of i;
  if not found then
    perform public._fail('FORBIDDEN', 'Item not assigned to you.', '42501');
  end if;
  if p_quantity is null or p_quantity < 1 or p_quantity > v_item.quantity then
    perform public._fail('BAD_QUANTITY', 'Enter a positive whole total no greater than the requested quantity.');
  end if;

  if p_stage = 'purchase' then
    v_previous := v_item.purchased;
    if p_quantity < v_previous then
      perform public._fail('BAD_QUANTITY', 'Purchased total cannot decrease. Contact the manager if a correction is needed.');
    end if;
    if p_quantity = v_previous and v_item.purchased_at is not null then return; end if;
    update public.supplier_order_items
      set purchased = p_quantity, purchased_at = now(), purchased_by = v_me.id
      where id = p_item;
  elsif p_stage = 'delivery' then
    v_previous := v_item.delivered;
    if v_item.purchased_at is null then
      perform public._fail('PURCHASE_REQUIRED', 'Confirm how many items you bought before confirming delivery.');
    end if;
    if p_quantity > v_item.purchased or p_quantity < v_previous then
      perform public._fail('BAD_QUANTITY', 'Delivered total must not decrease or exceed the confirmed purchased total.');
    end if;
    if p_quantity = v_previous and v_item.delivered_at is not null then return; end if;
    update public.supplier_order_items
      set delivered = p_quantity, delivered_at = now(), delivered_by = v_me.id
      where id = p_item;
  else
    perform public._fail('BAD_REQUEST', 'Unknown supplier confirmation.');
  end if;
  perform public._audit(
    case when p_stage = 'purchase' then 'supplier_purchase_confirmed' else 'supplier_delivery_confirmed' end,
    null, 'supplier_order', v_item.order_id::text,
    jsonb_build_object('item_id', p_item, 'previous_total', v_previous, 'confirmed_total', p_quantity)
  );
end $$;

create or replace function public.supplier_confirm_purchase(p_item bigint, p_quantity int)
returns void language sql security definer set search_path = '' as $$
  select public._supplier_confirm_quantity(p_item, p_quantity, 'purchase');
$$;
create or replace function public.supplier_confirm_delivery(p_item bigint, p_quantity int)
returns void language sql security definer set search_path = '' as $$
  select public._supplier_confirm_quantity(p_item, p_quantity, 'delivery');
$$;

revoke all on function public._supplier_confirm_quantity(bigint, int, text),
  public.supplier_confirm_purchase(bigint, int), public.supplier_confirm_delivery(bigint, int)
  from public, anon, authenticated;
grant execute on function public.supplier_confirm_purchase(bigint, int),
  public.supplier_confirm_delivery(bigint, int) to authenticated;

create or replace function public.receive_supplier_item(p_key uuid, p_item bigint, p_quantity int)
returns void language plpgsql security definer set search_path = '' as $$
declare v_me public.profiles; v_item public.supplier_order_items; v_prev public.supplier_receipts;
begin
  v_me := public._require_roles(array['admin', 'product_manager']);
  if p_key is null or p_quantity is null or p_quantity < 1 then
    perform public._fail('BAD_REQUEST', 'Enter a positive whole received quantity.');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('supplier-receipt:' || p_key::text, 0));
  select * into v_prev from public.supplier_receipts where id = p_key;
  if found then
    if v_prev.item_id <> p_item or v_prev.quantity <> p_quantity or v_prev.recorded_by <> v_me.id then
      perform public._fail('BAD_REQUEST', 'Receipt key already used for a different receipt.');
    end if;
    return;
  end if;
  select * into v_item from public.supplier_order_items where id = p_item for update;
  if not found then perform public._fail('NOT_FOUND', 'List item not found.'); end if;
  if v_item.purchased_at is null or v_item.delivered_at is null then
    perform public._fail('DELIVERY_REQUIRED', 'The supplier must confirm purchase and delivery before stock can be received.');
  end if;
  if p_quantity > v_item.delivered - v_item.received then
    perform public._fail('BAD_QUANTITY', 'Quantity exceeds supplier-confirmed delivery awaiting receipt.');
  end if;
  perform public.admin_adjust_stock(v_item.product_id, 'add', p_quantity,
    'Supplier receipt ' || p_key::text || ' for list ' || v_item.order_id::text);
  insert into public.supplier_receipts(id, item_id, quantity, recorded_by)
    values(p_key, p_item, p_quantity, v_me.id);
  update public.supplier_order_items set received = received + p_quantity where id = p_item;
  perform public._audit('supplier_goods_received', null, 'supplier_order', v_item.order_id::text,
    jsonb_build_object('receipt_id', p_key, 'item_id', p_item, 'quantity', p_quantity));
end $$;

insert into public.audit_logs(actor_name, actor_role, action, entity_type, details)
  select 'Supplier workflow migration', 'system', 'supplier_workflow_upgraded', 'supplier_order',
    jsonb_build_object('historical_received_items', count(*), 'historical_received_quantity', coalesce(sum(received), 0))
  from public.supplier_order_items where received > 0;

notify pgrst, 'reload schema';
$migration$; end if; end $upgrade$;

do $upgrade$ begin if to_regclass('public.money_start') is null then execute $migration$
-- Money tracking begins only when Admin records current opening balances.
-- Existing stock and transactions are preserved, never backcharged.
create table public.money_start (
 id int primary key check(id = 1), started_at timestamptz not null default clock_timestamp(),
 created_by uuid not null references public.profiles(id), request_key uuid not null unique,
 balances jsonb not null
);
create table public.money_actions (
 id uuid primary key, created_by uuid not null references public.profiles(id),
 payload jsonb not null, result jsonb, created_at timestamptz not null default clock_timestamp()
);
create table public.money_ledger (
 id bigint generated always as identity primary key,
 action_id uuid references public.money_actions(id),
 transaction_id uuid references public.transactions(id),
 account public.payment_method not null,
 amount numeric(16,2) not null, cogs numeric(16,2) not null default 0,
 kind text not null check(kind in ('opening','purchase','sale','refund','legacy_refund','expense','transfer','stock_loss')),
 note text not null, created_by uuid references public.profiles(id),
 created_at timestamptz not null default clock_timestamp()
);
create unique index money_sale_once on public.money_ledger(transaction_id,kind) where transaction_id is not null;
create index money_ledger_action on public.money_ledger(action_id);
create index money_ledger_account on public.money_ledger(account);
create trigger money_ledger_immutable before update or delete on public.money_ledger
 for each row execute function public.forbid_change();
create trigger money_start_immutable before update or delete on public.money_start
 for each row execute function public.forbid_change();
alter table public.money_start enable row level security;
alter table public.money_actions enable row level security;
alter table public.money_ledger enable row level security;
revoke all on public.money_start,public.money_actions,public.money_ledger from anon,authenticated;
grant select on public.money_start,public.money_ledger to authenticated;
create policy money_start_read on public.money_start for select to authenticated using (public.has_role(array['admin','finance','product_manager']));
create policy money_ledger_read on public.money_ledger for select to authenticated using (public.has_role(array['admin','finance']));

create function public._money_lock() returns void language sql security definer set search_path='' as $$
 select pg_advisory_xact_lock(719204051);
$$;
create function public._money_ready() returns void language plpgsql security definer set search_path='' as $$
begin
 perform public._money_lock();
 if not exists(select 1 from public.money_start) then
  perform public._fail('MONEY_SETUP_REQUIRED','Ask Admin to enter starting money on the Money page first.');
 end if;
end $$;
create function public._money_amount(p numeric, allow_zero boolean default false) returns void
language plpgsql security definer set search_path='' as $$
begin
 if p is null or p::text in ('NaN','Infinity','-Infinity') or p < 0 or (not allow_zero and p = 0) or p > 9999999999.99 or p <> round(p,2) then
  perform public._fail('BAD_AMOUNT','Enter a valid amount with at most two decimal places.');
 end if;
end $$;
create function public._money_funds(p_account public.payment_method,p_amount numeric) returns void
language plpgsql security definer set search_path='' as $$
begin
 perform public._money_ready();
 if p_account is null then perform public._fail('BAD_ACCOUNT','Choose the payment account.'); end if;
 if (select coalesce(sum(amount),0) from public.money_ledger where account=p_account) < p_amount then
  perform public._fail('INSUFFICIENT_FUNDS','Not enough money in the selected account. Check its balance or record a transfer first.');
 end if;
end $$;
create function public._money_claim(p_key uuid,p_payload jsonb) returns boolean
language plpgsql security definer set search_path='' as $$
declare v public.money_actions;
begin
 if p_key is null then perform public._fail('BAD_REQUEST','A retry key is required.'); end if;
 perform pg_advisory_xact_lock(hashtextextended('money:'||p_key::text,0));
 select * into v from public.money_actions where id=p_key;
 if found then
  if v.created_by <> auth.uid() or v.payload <> p_payload then
   perform public._fail('KEY_REUSED','This retry key belongs to a different action.');
  end if;
  return false;
 end if;
 insert into public.money_actions(id,created_by,payload) values(p_key,auth.uid(),p_payload);
 return true;
end $$;

create function public.money_open(p_key uuid,p_cash numeric,p_telda numeric,p_instapay numeric) returns void
language plpgsql security definer set search_path='' as $$
begin
 perform public._require_admin();
 perform public._money_amount(p_cash,true); perform public._money_amount(p_telda,true); perform public._money_amount(p_instapay,true);
 if not public._money_claim(p_key,jsonb_build_object('kind','opening','cash',p_cash,'telda',p_telda,'instapay',p_instapay)) then return; end if;
 perform public._money_lock();
 if exists(select 1 from public.money_start) then perform public._fail('ALREADY_STARTED','Starting money has already been recorded.'); end if;
 insert into public.money_start(id,created_by,request_key,balances) values(1,auth.uid(),p_key,jsonb_build_object('CASH',p_cash,'TELDA',p_telda,'INSTAPAY',p_instapay));
 insert into public.money_ledger(action_id,account,amount,kind,note,created_by) values
 (p_key,'CASH',p_cash,'opening','Starting cash',auth.uid()),(p_key,'TELDA',p_telda,'opening','Starting Telda',auth.uid()),(p_key,'INSTAPAY',p_instapay,'opening','Starting InstaPay',auth.uid());
 perform public._audit('money_started',null,'money',p_key::text,jsonb_build_object('cash',p_cash,'telda',p_telda,'instapay',p_instapay));
end $$;

-- Sales use the net amount kept (total, after change), never tendered cash.
-- Trigger serialization makes opening/checkout races deterministic.
create function public._money_sale() returns trigger language plpgsql security definer set search_path='' as $$
begin
 perform public._money_lock();
 if not exists(select 1 from public.money_start) then return new; end if;
 if TG_OP='INSERT' then
  insert into public.money_ledger(transaction_id,account,amount,cogs,kind,note,created_by)
   values(new.id,new.payment_method,new.total,new.total_cost,'sale','Sale '||new.txn_no,new.cashier_id);
 elsif old.status='completed' and new.status='voided' then
  -- A void means the full payment is returned via the original account.
  insert into public.money_ledger(transaction_id,account,amount,cogs,kind,note,created_by)
   values(new.id,new.payment_method,-new.total,
    case when exists(select 1 from public.money_ledger where transaction_id=new.id and kind='sale') then -new.total_cost else 0 end,
    case when exists(select 1 from public.money_ledger where transaction_id=new.id and kind='sale') then 'refund' else 'legacy_refund' end,
    'Refund '||new.txn_no,new.voided_by);
 end if;
 return new;
end $$;
create trigger money_sale after insert or update of status on public.transactions for each row execute function public._money_sale();

create function public.money_record(p_key uuid,p_kind text,p_account public.payment_method,p_amount numeric,p_note text,p_to public.payment_method default null)
returns void language plpgsql security definer set search_path='' as $$
begin
 perform public._require_roles(array['admin','finance']);
 perform public._money_amount(p_amount);
 if length(trim(coalesce(p_note,''))) < 3 or length(p_note)>500 then perform public._fail('REASON_REQUIRED','Enter a description (3–500 characters).'); end if;
 if p_kind is null or p_kind not in ('expense','transfer') then perform public._fail('BAD_REQUEST','Choose expense or transfer.'); end if;
 if p_kind='transfer' and (p_to is null or p_to=p_account) then perform public._fail('BAD_ACCOUNT','Choose a different destination account.'); end if;
 if p_kind='expense' and p_to is not null then perform public._fail('BAD_ACCOUNT','Expenses have no destination account.'); end if;
 if not public._money_claim(p_key,jsonb_build_object('kind',p_kind,'account',p_account,'amount',p_amount,'note',p_note,'to',p_to)) then return; end if;
 perform public._money_funds(p_account,p_amount);
 insert into public.money_ledger(action_id,account,amount,kind,note,created_by) values(p_key,p_account,-p_amount,p_kind,trim(p_note),auth.uid());
 if p_kind='transfer' then
  insert into public.money_ledger(action_id,account,amount,kind,note,created_by) values(p_key,p_to,p_amount,p_kind,trim(p_note),auth.uid());
 end if;
 perform public._audit('money_'||p_kind,null,'money',p_key::text,jsonb_build_object('amount',p_amount,'account',p_account,'to',p_to,'note',p_note));
end $$;

create function public.money_summary() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v jsonb;
begin
 perform public._require_roles(array['admin','finance']);
 select jsonb_build_object('started_at',(select started_at from public.money_start),
 'cash',coalesce(sum(amount) filter(where account='CASH'),0),
 'telda',coalesce(sum(amount) filter(where account='TELDA'),0),
 'instapay',coalesce(sum(amount) filter(where account='INSTAPAY'),0),
 'total',coalesce(sum(amount),0),
 'starting',coalesce(sum(amount) filter(where kind='opening'),0),
 'sales',coalesce(sum(amount) filter(where kind in ('sale','refund')),0),
 'cogs',coalesce(sum(cogs) filter(where kind in ('sale','refund')),0),
 'purchases',-coalesce(sum(amount) filter(where kind='purchase'),0),
 'expenses',-coalesce(sum(amount) filter(where kind='expense'),0),
 'stock_losses',coalesce(sum(cogs) filter(where kind='stock_loss'),0),
 'legacy_refunds',-coalesce(sum(amount) filter(where kind='legacy_refund'),0),
 'gross_profit',coalesce(sum(amount-cogs) filter(where kind in ('sale','refund')),0),
 'net_profit',coalesce(sum(amount-cogs) filter(where kind in ('sale','refund')),0)
  +coalesce(sum(amount) filter(where kind='expense'),0)-coalesce(sum(cogs) filter(where kind='stock_loss'),0)
 ) into v from public.money_ledger;
 return v;
end $$;

create or replace function public._stock_adjust_original(p_product_id bigint, p_mode text, p_quantity int, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_me    public.profiles;
  v     public.products;
  v_delta int;
  v_after int;
begin
  v_me := public._require_roles(array['admin', 'product_manager']);
  if length(trim(coalesce(p_reason, ''))) < 3 then
    perform public._fail('REASON_REQUIRED', 'A reason is required for every stock adjustment (at least 3 characters).');
  end if;
  if p_quantity is null or p_quantity < 0 then
    perform public._fail('BAD_QUANTITY', 'Quantity must be 0 or more.');
  end if;
  select * into v from public.products where id = p_product_id for update;
  if not found then perform public._fail('NOT_FOUND', 'Product not found.'); end if;
  if not v.track_stock then
    perform public._fail('BAD_REQUEST', 'This product does not track stock (service).');
  end if;

  v_delta := case p_mode
    when 'add' then p_quantity
    when 'remove' then -p_quantity
    when 'set' then p_quantity - v.stock
  end;
  if v_delta is null then perform public._fail('BAD_REQUEST', 'Mode must be add, remove or set.'); end if;
  if v_delta = 0 then perform public._fail('NO_CHANGE', 'Nothing to change: the stock is already at that level.'); end if;
  if v.stock + v_delta < 0 then
    perform public._fail('INSUFFICIENT_STOCK', format('Cannot remove %s: only %s in stock.', -v_delta, v.stock));
  end if;

  update public.products set stock = stock + v_delta where id = v.id returning stock into v_after;
  insert into public.stock_movements (product_id, section_code, movement_type, quantity_change, stock_before,
    stock_after, created_by, reason)
  values (v.id, v.section_code, case when v_delta > 0 then 'adjust_add' else 'adjust_remove' end::public.stock_movement_type,
    v_delta, v.stock, v_after, v_me.id, trim(p_reason));
  perform public._audit('stock_adjusted', v.section_code, 'product', v.id::text,
    jsonb_build_object('name', v.name, 'mode', p_mode, 'change', v_delta, 'from', v.stock, 'to', v_after, 'reason', trim(p_reason)));
  return jsonb_build_object('product_id', v.id, 'stock', v_after, 'change', v_delta);
end $$;

create or replace function public._receive_supplier_original(p_key uuid, p_item bigint, p_quantity int)
returns void language plpgsql security definer set search_path = '' as $$
declare v_me public.profiles; v_item public.supplier_order_items; v_prev public.supplier_receipts;
begin
  v_me := public._require_roles(array['admin', 'product_manager']);
  if p_key is null or p_quantity is null or p_quantity < 1 then
    perform public._fail('BAD_REQUEST', 'Enter a positive whole received quantity.');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('supplier-receipt:' || p_key::text, 0));
  select * into v_prev from public.supplier_receipts where id = p_key;
  if found then
    if v_prev.item_id <> p_item or v_prev.quantity <> p_quantity or v_prev.recorded_by <> v_me.id then
      perform public._fail('BAD_REQUEST', 'Receipt key already used for a different receipt.');
    end if;
    return;
  end if;
  select * into v_item from public.supplier_order_items where id = p_item for update;
  if not found then perform public._fail('NOT_FOUND', 'List item not found.'); end if;
  if v_item.purchased_at is null or v_item.delivered_at is null then
    perform public._fail('DELIVERY_REQUIRED', 'The supplier must confirm purchase and delivery before stock can be received.');
  end if;
  if p_quantity > v_item.delivered - v_item.received then
    perform public._fail('BAD_QUANTITY', 'Quantity exceeds supplier-confirmed delivery awaiting receipt.');
  end if;
  perform public._stock_adjust_original(v_item.product_id, 'add', p_quantity,
    'Supplier receipt ' || p_key::text || ' for list ' || v_item.order_id::text);
  insert into public.supplier_receipts(id, item_id, quantity, recorded_by)
    values(p_key, p_item, p_quantity, v_me.id);
  update public.supplier_order_items set received = received + p_quantity where id = p_item;
  perform public._audit('supplier_goods_received', null, 'supplier_order', v_item.order_id::text,
    jsonb_build_object('receipt_id', p_key, 'item_id', p_item, 'quantity', p_quantity));
end $$;

-- Old clients cannot bypass money tracking once opening balances are recorded.
create or replace function public.admin_adjust_stock(p_product_id bigint,p_mode text,p_quantity int,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform public._require_roles(array['admin','product_manager']);
 perform 1 from public.products where id=p_product_id for update;
 perform public._money_lock();
 if exists(select 1 from public.money_start) then perform public._fail('UPGRADE_REQUIRED','Refresh the website and use the stock form with payment details.'); end if;
 return public._stock_adjust_original(p_product_id,p_mode,p_quantity,p_reason);
end $$;
create or replace function public.receive_supplier_item(p_key uuid,p_item bigint,p_quantity int)
returns void language plpgsql security definer set search_path='' as $$
begin
 perform public._require_roles(array['admin','product_manager']);
 perform 1 from public.supplier_order_items where id=p_item for update;
 perform 1 from public.products where id=(select product_id from public.supplier_order_items where id=p_item) for update;
 perform public._money_lock();
 if exists(select 1 from public.money_start) then perform public._fail('UPGRADE_REQUIRED','Refresh the website and enter the receipt payment details.'); end if;
 perform public._receive_supplier_original(p_key,p_item,p_quantity);
end $$;

-- One atomic action updates stock, average cost, receipt history and money.
create function public.money_stock(p_key uuid,p_product bigint,p_mode text,p_quantity int,p_reason text,
 p_unit_cost numeric,p_account public.payment_method,p_no_spend boolean,p_item bigint default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v public.products; v_cost numeric; v_delta int; v_total numeric; v_result jsonb; v_item public.supplier_order_items;
begin
 perform public._require_roles(array['admin','product_manager']);
 if length(trim(coalesce(p_reason,'')))<3 or length(p_reason)>500 then perform public._fail('REASON_REQUIRED','Enter a reason (3–500 characters).'); end if;
 if p_no_spend is null then perform public._fail('BAD_REQUEST','Choose purchased stock or no money spent.'); end if;
 if not public._money_claim(p_key,jsonb_build_object('kind','stock','product',p_product,'mode',p_mode,'quantity',p_quantity,
  'reason',p_reason,'unit_cost',p_unit_cost,'account',p_account,'no_spend',p_no_spend,'item',p_item)) then
  return (select result from public.money_actions where id=p_key);
 end if;
 if p_item is not null then
  select * into v_item from public.supplier_order_items where id=p_item for update;
  if not found or v_item.product_id is distinct from p_product or p_mode is distinct from 'add' or p_no_spend then
   perform public._fail('BAD_REQUEST','Supplier receipts must record a paid stock purchase.');
  end if;
  -- Never charge a receipt that was recorded by the old workflow.
  if exists(select 1 from public.supplier_receipts where id=p_key) then perform public._fail('KEY_REUSED','This receipt was already recorded before money tracking.'); end if;
 end if;
 select * into v from public.products where id=p_product for update;
 if not found then perform public._fail('NOT_FOUND','Product not found.'); end if;
 select cost into v_cost from public.product_costs where product_id=p_product;
 v_cost:=coalesce(v_cost,0);
 perform public._money_ready();
 if p_quantity is null or p_quantity<0 or (p_mode <> 'set' and p_quantity=0) then perform public._fail('BAD_QUANTITY','Enter a valid whole quantity.'); end if;
 v_delta:=case p_mode when 'add' then p_quantity when 'remove' then -p_quantity when 'set' then p_quantity-v.stock end;
 if not p_no_spend then
  if p_mode is distinct from 'add' then perform public._fail('BAD_REQUEST','Use Add stock to record a purchase.'); end if;
  perform public._money_amount(p_unit_cost,true);
  v_total:=p_quantity*p_unit_cost;
  perform public._money_funds(p_account,v_total);
 else
  if p_account is not null or p_unit_cost is not null then perform public._fail('BAD_REQUEST','No-money adjustments must not include a payment.'); end if;
 end if;
 if p_item is null then
  v_result:=public._stock_adjust_original(p_product,p_mode,p_quantity,p_reason);
 else
  perform public._receive_supplier_original(p_key,p_item,p_quantity);
  v_result:=jsonb_build_object('product_id',p_product,'stock',v.stock+p_quantity,'change',p_quantity);
 end if;
 if not p_no_spend then
  insert into public.money_ledger(action_id,account,amount,kind,note,created_by)
   values(p_key,p_account,-v_total,'purchase',v.name||' × '||p_quantity||' @ '||p_unit_cost||' — '||p_reason,auth.uid());
  update public.product_costs set cost=round((v.stock*v_cost+v_total)/(v.stock+p_quantity),2) where product_id=p_product;
 elsif v_delta < 0 then
  -- A stock loss affects profit, but no money leaves an account.
  insert into public.money_ledger(action_id,account,amount,cogs,kind,note,created_by)
   values(p_key,'CASH',0,-v_delta*v_cost,'stock_loss',v.name||' — '||p_reason,auth.uid());
 elsif p_mode='add' then
  -- Free/donated additions carry zero purchase cost.
  update public.product_costs set cost=round(v.stock*v_cost/(v.stock+v_delta),2) where product_id=p_product;
 end if;
 update public.money_actions set result=v_result where id=p_key;
 perform public._audit('money_stock_received',v.section_code,'money',p_key::text,jsonb_build_object('product_id',p_product,'change',v_delta,'amount',coalesce(v_total,0),'account',p_account,'item_id',p_item,'no_spend',p_no_spend));
 return v_result;
end $$;

create or replace function public._save_product_original(p jsonb)
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  v_me       public.profiles;
  v_old      public.products;
  v_old_cost numeric(12,2);
  v_id       bigint := nullif(p ->> 'id', '')::bigint;
  v_section  text := p ->> 'section_code';
  v_cat      bigint := nullif(p ->> 'category_id', '')::bigint;
  v_name     text := trim(coalesce(p ->> 'name', ''));
  v_sku      text := nullif(trim(coalesce(p ->> 'sku', '')), '');
  v_price    numeric(12,2) := (p ->> 'price')::numeric;
  v_cost     numeric(12,2) := coalesce(nullif(p ->> 'cost', '')::numeric, 0);
  v_image    text := nullif(trim(coalesce(p ->> 'image_url', '')), '');
  v_track    boolean := coalesce((p ->> 'track_stock')::boolean, true);
  v_start    int := coalesce(nullif(p ->> 'starting_stock', '')::int, 0);
  v_min      int := nullif(p ->> 'min_stock', '')::int;
  v_active   boolean := coalesce((p ->> 'active')::boolean, true);
  v_changes  jsonb := '{}'::jsonb;
begin
  v_me := public._require_roles(array['admin', 'product_manager']);
  if v_name = '' then perform public._fail('BAD_REQUEST', 'Product name is required.'); end if;
  if v_price is null or v_price < 0 then perform public._fail('BAD_REQUEST', 'Selling price must be 0 or more.'); end if;
  if v_cost < 0 then perform public._fail('BAD_REQUEST', 'Cost must be 0 or more.'); end if;
  if v_start < 0 then perform public._fail('BAD_REQUEST', 'Starting stock must be 0 or more.'); end if;
  if v_min is null then
    select low_stock_default into v_min from public.app_settings where id = 1;
  end if;
  if v_min < 0 then perform public._fail('BAD_REQUEST', 'Minimum stock must be 0 or more.'); end if;
  if not exists (select 1 from public.sections where code = v_section) then
    perform public._fail('BAD_REQUEST', 'Choose a valid section.');
  end if;
  if v_cat is not null and not exists (select 1 from public.categories where id = v_cat and section_code = v_section) then
    perform public._fail('BAD_REQUEST', 'That category belongs to a different section.');
  end if;
  if not v_track then v_start := 0; v_min := 0; end if;
  if v_sku is not null and exists (select 1 from public.products where sku = v_sku and id is distinct from v_id) then
    perform public._fail('DUPLICATE', format('The code "%s" is already used by another product.', v_sku));
  end if;

  if v_id is null then
    if exists (select 1 from public.products where section_code = v_section and lower(name) = lower(v_name)) then
      perform public._fail('DUPLICATE', format('A product called "%s" already exists in this section.', v_name));
    end if;
    insert into public.products (sku, section_code, category_id, name, price, image_url, track_stock,
      starting_stock, stock, min_stock, active)
    values (v_sku, v_section, v_cat, v_name, v_price, v_image, v_track, v_start, v_start, v_min, v_active)
    returning id into v_id;
    insert into public.product_costs (product_id, cost) values (v_id, v_cost);
    if v_start > 0 then
      insert into public.stock_movements (product_id, section_code, movement_type, quantity_change,
        stock_before, stock_after, created_by, reason)
      values (v_id, v_section, 'initial', v_start, 0, v_start, v_me.id, 'Starting stock');
    end if;
    perform public._audit('product_created', v_section, 'product', v_id::text,
      jsonb_build_object('name', v_name, 'price', v_price, 'cost', v_cost, 'starting_stock', v_start,
        'min_stock', v_min, 'category_id', v_cat, 'track_stock', v_track, 'active', v_active));
    return v_id;
  end if;

  -- update
  select * into v_old from public.products where id = v_id for update;
  if not found then perform public._fail('NOT_FOUND', 'Product not found.'); end if;
  select cost into v_old_cost from public.product_costs where product_id = v_id;
  if v_track <> v_old.track_stock and v_old.stock <> 0 then
    perform public._fail('BAD_REQUEST', 'Remove all stock (set it to 0 with a stock adjustment) before changing stock tracking.');
  end if;
  if exists (select 1 from public.products where section_code = v_section and lower(name) = lower(v_name) and id <> v_id) then
    perform public._fail('DUPLICATE', format('A product called "%s" already exists in this section.', v_name));
  end if;

  if v_old.name is distinct from v_name then v_changes := v_changes || jsonb_build_object('name', jsonb_build_array(v_old.name, v_name)); end if;
  if v_old.sku is distinct from v_sku then v_changes := v_changes || jsonb_build_object('sku', jsonb_build_array(v_old.sku, v_sku)); end if;
  if v_old.section_code is distinct from v_section then v_changes := v_changes || jsonb_build_object('section_code', jsonb_build_array(v_old.section_code, v_section)); end if;
  if v_old.category_id is distinct from v_cat then v_changes := v_changes || jsonb_build_object('category_id', jsonb_build_array(v_old.category_id, v_cat)); end if;
  if v_old.image_url is distinct from v_image then v_changes := v_changes || jsonb_build_object('image_url', jsonb_build_array(v_old.image_url, v_image)); end if;
  if v_old.track_stock is distinct from v_track then v_changes := v_changes || jsonb_build_object('track_stock', jsonb_build_array(v_old.track_stock, v_track)); end if;
  if v_old.min_stock is distinct from v_min then v_changes := v_changes || jsonb_build_object('min_stock', jsonb_build_array(v_old.min_stock, v_min)); end if;
  if v_old.active is distinct from v_active then v_changes := v_changes || jsonb_build_object('active', jsonb_build_array(v_old.active, v_active)); end if;

  -- starting_stock / stock are NOT editable here: stock changes only through
  -- sales, voids and admin_adjust_stock (which require a reason).
  update public.products
     set sku = v_sku, section_code = v_section, category_id = v_cat, name = v_name, price = v_price,
         image_url = v_image, track_stock = v_track, min_stock = v_min, active = v_active
   where id = v_id;
  update public.product_costs set cost = v_cost where product_id = v_id;

  if v_old.price <> v_price then
    perform public._audit('price_changed', v_section, 'product', v_id::text,
      jsonb_build_object('name', v_name, 'from', v_old.price, 'to', v_price));
  end if;
  if v_old_cost is distinct from v_cost then
    perform public._audit('cost_changed', v_section, 'product', v_id::text,
      jsonb_build_object('name', v_name, 'from', v_old_cost, 'to', v_cost));
  end if;
  if v_changes <> '{}'::jsonb then
    perform public._audit(case when v_changes ? 'active' and (select count(*) from jsonb_object_keys(v_changes)) = 1
                               then case when v_active then 'product_activated' else 'product_deactivated' end
                               else 'product_updated' end,
      v_section, 'product', v_id::text, jsonb_build_object('name', v_name, 'changes', v_changes));
  end if;
  return v_id;
end $$;

create or replace function public.admin_save_product(p jsonb) returns bigint
language plpgsql security definer set search_path='' as $$
declare v_id bigint; v_stock int; v_old public.products; v_cost numeric; v_p jsonb;
begin
 perform public._require_roles(array['admin','product_manager']);
 if not exists(select 1 from public.money_start) then
  if nullif(p->>'funding_key','') is not null and coalesce((p->>'starting_stock')::int,0)>0 then perform public._money_ready(); end if;
  return public._save_product_original(p);
 end if;
 if nullif(p->>'id','') is not null then
  select * into v_old from public.products where id=(p->>'id')::bigint for update;
  select cost into v_cost from public.product_costs where product_id=v_old.id;
  if v_old.stock>0 and coalesce((p->>'cost')::numeric,0) is distinct from v_cost then
   perform public._fail('COST_MANAGED','Cost is averaged from stock purchases. Receive new stock with its actual buying price.');
  end if;
  return public._save_product_original(p);
 end if;
 v_stock:=case when coalesce((p->>'track_stock')::boolean,true) then coalesce((p->>'starting_stock')::int,0) else 0 end;
 if v_stock<0 then perform public._fail('BAD_QUANTITY','Starting stock cannot be negative.'); end if;
 if v_stock=0 then return public._save_product_original(p); end if;
 if not (p ? 'funding_key') or not (p ? 'no_spend') then
  perform public._fail('PAYMENT_REQUIRED','Choose a payment account or no money spent for the starting stock.');
 end if;
 -- Guard creation retries, including a lost response after the product exists.
 if not public._money_claim((p->>'funding_key')::uuid,jsonb_build_object('kind','new_product','product',p)) then
  return (select (result->>'product_id')::bigint from public.money_actions where id=(p->>'funding_key')::uuid);
 end if;
 v_p:=p||jsonb_build_object('starting_stock',0);
 v_id:=public._save_product_original(v_p);
 perform public.money_stock(gen_random_uuid(),v_id,'add',v_stock,'Initial stock purchase',
  case when (p->>'no_spend')::boolean then null else coalesce((p->>'cost')::numeric,0) end,
  (p->>'payment_account')::public.payment_method,(p->>'no_spend')::boolean,null);
 update public.money_actions set result=jsonb_build_object('product_id',v_id) where id=(p->>'funding_key')::uuid;
 return v_id;
end $$;

create or replace function public.admin_import_products(p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_row jsonb; v_cat bigint; v_created int := 0; v_cats int := 0; v_skipped jsonb := '[]'::jsonb;
  v_section text; v_catname text;
begin
  perform public._require_roles(array['admin', 'product_manager']);
  if jsonb_typeof(p_rows) is distinct from 'array' then perform public._fail('BAD_REQUEST', 'Expected a list of products.'); end if;
  for v_row in select * from jsonb_array_elements(p_rows) loop
    v_section := v_row ->> 'section_code';
    v_catname := nullif(trim(coalesce(v_row ->> 'category', '')), '');
    if exists (select 1 from public.products where section_code = v_section and lower(name) = lower(trim(v_row ->> 'name'))) then
      v_skipped := v_skipped || to_jsonb(v_row ->> 'name');
      continue;
    end if;
    v_cat := null;
    if v_catname is not null then
      select id into v_cat from public.categories where section_code = v_section and lower(name) = lower(v_catname);
      if v_cat is null then
        v_cat := public.admin_save_category(null, v_section, v_catname, 0, true);
        v_cats := v_cats + 1;
      end if;
    end if;
    perform public.admin_save_product(jsonb_build_object(
      'section_code', v_section, 'category_id', v_cat, 'name', v_row ->> 'name',
      -- keep the old code unless another product already uses it
      'sku', case when exists (select 1 from public.products where sku = v_row ->> 'sku') then null else v_row ->> 'sku' end,
      'price', v_row -> 'price', 'cost', coalesce(v_row -> 'cost', '0'::jsonb), 'image_url', v_row ->> 'image_url',
      'track_stock', coalesce(v_row -> 'track_stock', 'true'::jsonb),
      'starting_stock', coalesce(v_row -> 'stock', '0'::jsonb), 'min_stock', v_row -> 'min_stock',
      'funding_key',v_row->'funding_key','no_spend',v_row->'no_spend','payment_account',v_row->'payment_account',
      'active', coalesce(v_row -> 'active', 'true'::jsonb)));
    v_created := v_created + 1;
  end loop;
  perform public._audit('products_imported', null, 'product', null,
    jsonb_build_object('created', v_created, 'categories_created', v_cats, 'skipped', v_skipped));
  return jsonb_build_object('created', v_created, 'categories_created', v_cats, 'skipped', v_skipped);
end $$;

revoke all on function public._money_lock(),public._money_ready(),public._money_amount(numeric,boolean),
 public._money_funds(public.payment_method,numeric),public._money_claim(uuid,jsonb),public._money_sale(),
 public._stock_adjust_original(bigint,text,int,text),public._receive_supplier_original(uuid,bigint,int),public._save_product_original(jsonb),
 public.money_open(uuid,numeric,numeric,numeric),public.money_record(uuid,text,public.payment_method,numeric,text,public.payment_method),
 public.money_summary(),public.money_stock(uuid,bigint,text,int,text,numeric,public.payment_method,boolean,bigint)
 from public,anon,authenticated;
grant execute on function public.money_open(uuid,numeric,numeric,numeric),
 public.money_record(uuid,text,public.payment_method,numeric,text,public.payment_method),public.money_summary(),
 public.money_stock(uuid,bigint,text,int,text,numeric,public.payment_method,boolean,bigint) to authenticated;
create or replace function public.admin_decide_void(p_request_id bigint, p_approve boolean, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_me  public.profiles;
  v_req public.void_requests;
  v_txn public.transactions;
  r     record;
  v_after int;
  v_note text := nullif(trim(coalesce(p_note, '')), '');
begin
  v_me := public._require_admin();

  select * into v_req from public.void_requests where id = p_request_id for update;
  if not found then
    perform public._fail('NOT_FOUND', 'Void request not found.');
  end if;
  if v_req.status <> 'pending' then
    perform public._fail('ALREADY_DECIDED', format('This request was already %s.', v_req.status));
  end if;

  if not p_approve then
    update public.void_requests
       set status = 'rejected', decided_by = v_me.id, decided_at = now(), decision_note = v_note
     where id = v_req.id;
    perform public._audit('void_rejected', v_req.section_code, 'transaction', v_req.transaction_id::text,
      jsonb_build_object('void_request_id', v_req.id, 'note', v_note));
    return jsonb_build_object('void_request_id', v_req.id, 'status', 'rejected');
  end if;

  select * into v_txn from public.transactions where id = v_req.transaction_id for update;
  if v_txn.status <> 'completed' then
    perform public._fail('ALREADY_VOIDED', 'This transaction is already voided.');
  end if;

  perform 1 from public.products where id in (
    select product_id from public.stock_movements where transaction_id=v_txn.id and movement_type='sale'
  ) order by id for update;
  update public.transactions
     set status = 'voided', voided_at = now(), voided_by = v_me.id, void_reason = v_req.reason
   where id = v_txn.id;

  -- restore exactly what the sale deducted (only products that had a 'sale' movement)
  for r in
    select m.product_id, -m.quantity_change as qty
    from public.stock_movements m
    where m.transaction_id = v_txn.id and m.movement_type = 'sale'
    order by m.product_id
  loop
    update public.products set stock = stock + r.qty where id = r.product_id returning stock into v_after;
    insert into public.stock_movements (product_id, section_code, movement_type, quantity_change, stock_before,
      stock_after, transaction_id, void_request_id, created_by, reason)
    values (r.product_id, v_txn.section_code, 'void_restore', r.qty, v_after - r.qty, v_after, v_txn.id, v_req.id,
      v_me.id, 'Void of ' || v_txn.txn_no);
  end loop;

  update public.void_requests
     set status = 'approved', decided_by = v_me.id, decided_at = now(), decision_note = v_note
   where id = v_req.id;

  perform public._audit('void_approved', v_txn.section_code, 'transaction', v_txn.id::text,
    jsonb_build_object('txn_no', v_txn.txn_no, 'void_request_id', v_req.id, 'refund_amount', v_txn.total,
      'payment_method', v_txn.payment_method, 'note', v_note));
  return jsonb_build_object('void_request_id', v_req.id, 'status', 'approved', 'refund_amount', v_txn.total);
end $$;

-- Returned units recover their original sale-time cost in the inventory average.
create function public._money_restore_cost() returns trigger language plpgsql security definer set search_path='' as $$
declare v_unit numeric;
begin
 if new.movement_type='void_restore' and exists(select 1 from public.money_start) then
  select unit_cost into v_unit from public.transaction_items where transaction_id=new.transaction_id and product_id=new.product_id;
  update public.product_costs set cost=round((new.stock_before*cost+new.quantity_change*v_unit)/new.stock_after,2) where product_id=new.product_id;
 end if;
 return new;
end $$;
create trigger money_restore_cost after insert on public.stock_movements for each row execute function public._money_restore_cost();
revoke all on function public._money_restore_cost() from public,anon,authenticated;
create trigger money_ledger_no_truncate before truncate on public.money_ledger for each statement execute function public.forbid_change();
create trigger money_start_no_truncate before truncate on public.money_start for each statement execute function public.forbid_change();

notify pgrst,'reload schema';
$migration$; end if; end $upgrade$;

notify pgrst,'reload schema';
commit;
