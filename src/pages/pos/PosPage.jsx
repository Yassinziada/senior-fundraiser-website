import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../../context/AuthContext.jsx';
import { useSettings } from '../../context/SettingsContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { useRealtime } from '../../hooks/useRealtime.js';
import { useOnlineStatus } from '../../hooks/useOnlineStatus.js';
import { fetchPosCategories, fetchPosProducts, checkout, checkoutStatus } from '../../services/pos.js';
import {
  addToCart, setQuantity, removeFromCart, cartTotalCents, cartUnits, cartQuantityOf, reconcileCart, cartSignature, toCheckoutItems,
} from '../../utils/cart.js';
import { centsToAmount } from '../../utils/money.js';
import { readJSON, writeJSON } from '../../utils/localStore.js';
import { attemptFor, clearPendingAttempt, loadPendingAttempt, savePendingAttempt } from '../../utils/checkoutAttempt.js';
import { ErrorNotice, Spinner } from '../../components/ui.jsx';
import ReceiptModal from '../../components/ReceiptModal.jsx';
import ProductGrid from './ProductGrid.jsx';
import CartPanel from './CartPanel.jsx';
import CheckoutModal from './CheckoutModal.jsx';

// Hints for which a failed checkout is DEFINITELY not saved (the database
// rolled everything back), so the pending attempt can be discarded.
const RELOAD_HINTS = new Set(['INSUFFICIENT_STOCK', 'PRICE_CHANGED', 'PRODUCT_INACTIVE', 'PRODUCT_NOT_FOUND', 'WRONG_SECTION']);

/**
 * The selling screen. Used by cashiers (section = their own) and by admins
 * (section chosen in the admin "Sell" page).
 */
export default function PosPage({ section }) {
  const { profile } = useAuth();
  const { money } = useSettings();
  const toast = useToast();
  const online = useOnlineStatus();
  const uid = profile.id;
  const cartKey = `pos.cart.${uid}.${section}`;

  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [cat, setCat] = useState('all');
  const [q, setQ] = useState('');
  const [cart, setCart] = useState(() => readJSON(cartKey, []));
  const [pending, setPendingState] = useState(() => loadPendingAttempt(uid));
  // Refs are updated synchronously, so even several clicks in the same
  // instant (before React re-renders) see the same attempt and the in-flight
  // flag. State alone would let each click mint a new idempotency key.
  const attemptRef = useRef(pending);
  const inFlightRef = useRef(false);
  const setPending = useCallback((a) => {
    attemptRef.current = a;
    setPendingState(a);
  }, []);
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [phase, setPhase] = useState('form'); // form | sending | uncertain
  const [payError, setPayError] = useState(null);
  const [receipt, setReceipt] = useState(null);
  const [mobileCart, setMobileCart] = useState(false);

  // persist cart per device/user/section (convenience only)
  useEffect(() => writeJSON(cartKey, cart), [cartKey, cart]);

  const load = useCallback(
    async ({ silent = false } = {}) => {
      if (!silent) setLoading(true);
      try {
        const [p, c] = await Promise.all([fetchPosProducts(section), fetchPosCategories(section)]);
        setProducts(p);
        setCategories(c);
        setLoadError(null);
        setCart((current) => {
          const { cart: next, changes } = reconcileCart(current, p);
          changes.forEach((m) => toast.info(m));
          return next;
        });
        return p;
      } catch (e) {
        setLoadError(e);
        return null;
      } finally {
        setLoading(false);
      }
    },
    [section, toast],
  );

  useEffect(() => {
    load();
  }, [load]);

  // live stock/price updates (RLS limits a cashier to their own section)
  useRealtime(['products'], () => load({ silent: true }), { filter: `section_code=eq.${section}` });

  // ------------------------------------------------------------------ checkout
  const totalCents = cartTotalCents(cart);
  const units = cartUnits(cart);
  const locked = !!pending; // an unresolved attempt freezes the cart

  const finishSuccess = useCallback(
    (result) => {
      clearPendingAttempt(uid);
      setPending(null);
      setCart([]);
      setCheckoutOpen(false);
      setPhase('form');
      setPayError(null);
      setMobileCart(false);
      setReceipt(result);
      load({ silent: true });
    },
    [uid, load],
  );

  const send = useCallback(
    async (attempt) => {
      if (inFlightRef.current) return; // a request for this sale is already on its way
      inFlightRef.current = true;
      setPhase('sending');
      setPayError(null);
      try {
        const result = await checkout({
          idempotencyKey: attempt.key,
          items: attempt.items,
          paymentMethod: attempt.method,
          amountReceived: attempt.received,
          expectedTotal: attempt.expectedTotal,
          section: attempt.section,
        });
        finishSuccess(result);
      } catch (e) {
        if (e.network) {
          // Result unknown: keep the attempt (same key) so a retry is safe.
          setPhase('uncertain');
          return;
        }
        // Definite refusal from the database: nothing was saved.
        clearPendingAttempt(uid);
        setPending(null);
        setPhase('form');
        setPayError(e.message);
        if (RELOAD_HINTS.has(e.code)) {
          await load({ silent: true });
        }
      } finally {
        inFlightRef.current = false;
      }
    },
    [uid, finishSuccess, load, setPending],
  );

  const submitPayment = ({ method, received, receivedText }) => {
    if (inFlightRef.current) return;
    const signature = `${section}|${cartSignature(cart)}|${method}|${received ?? ''}`;
    const base = attemptFor(attemptRef.current, signature);
    const attempt = {
      ...base,
      section,
      method,
      received,
      receivedText,
      items: toCheckoutItems(cart),
      expectedTotal: centsToAmount(totalCents),
    };
    // saved BEFORE sending, so a refresh mid-request can still be resolved
    savePendingAttempt(uid, attempt);
    setPending(attempt);
    send(attempt);
  };

  const checkStatus = useCallback(
    async (attempt = pending, { quiet = false } = {}) => {
      if (!attempt) return;
      try {
        const found = await checkoutStatus(attempt.key);
        if (found) {
          toast.ok(`Sale ${found.txn_no} WAS completed.`);
          finishSuccess(found);
        } else {
          clearPendingAttempt(uid);
          setPending(null);
          setPhase('form');
          if (!quiet) toast.info('That sale was NOT recorded. You can complete it again.');
          setPayError('The previous attempt was not recorded. Check the payment and press Complete Sale again.');
        }
      } catch (e) {
        if (!quiet) toast.error(e.network ? 'Still offline — try again when connected.' : e.message);
      }
    },
    [pending, uid, toast, finishSuccess, setPending],
  );

  // After a refresh with an unresolved attempt: ask the server what happened.
  useEffect(() => {
    if (pending && online && phase === 'form' && !checkoutOpen) {
      setCheckoutOpen(true);
      setPhase('uncertain');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openCheckout = () => {
    if (!cart.length) return;
    setPayError(null);
    setPhase(pending ? 'uncertain' : 'form');
    setCheckoutOpen(true);
  };

  // ------------------------------------------------------------------ cart ops
  const productById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const guard = () => {
    if (locked) {
      toast.error('Finish or check the unconfirmed sale first.');
      return false;
    }
    return true;
  };
  const onAdd = (p) => {
    if (!guard()) return;
    const r = addToCart(cart, p);
    if (r.error) toast.error(r.error);
    setCart(r.cart);
  };
  const onInc = (id) => {
    if (!guard()) return;
    const p = productById.get(id);
    if (p) onAdd(p);
  };
  const onDec = (id) => {
    if (!guard()) return;
    setCart(setQuantity(cart, id, cartQuantityOf(cart, id) - 1).cart);
  };
  const onRemove = (id) => guard() && setCart(removeFromCart(cart, id));
  const onClear = () => guard() && setCart([]);

  // ------------------------------------------------------------------ filters
  const usedCats = useMemo(() => new Set(products.map((p) => p.category_id)), [products]);
  const visibleCats = categories.filter((c) => usedCats.has(c.id));
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return products.filter((p) => (cat === 'all' || p.category_id === cat) && (!needle || p.name.toLowerCase().includes(needle)));
  }, [products, cat, q]);

  if (loading && !products.length) return <Spinner label="Loading products…" />;

  return (
    <div className="pos">
      <section className="catalog">
        {loadError && <ErrorNotice error={loadError} onRetry={() => load()} />}
        <div className="cat-bar">
          <div className="chips">
            <button type="button" className={`chip ${cat === 'all' ? 'on' : ''}`} onClick={() => setCat('all')}>
              All
            </button>
            {visibleCats.map((c) => (
              <button type="button" key={c.id} className={`chip ${cat === c.id ? 'on' : ''}`} onClick={() => setCat(c.id)}>
                {c.name}
              </button>
            ))}
          </div>
          <div className="search">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <input placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search products" autoComplete="off" />
          </div>
        </div>
        {!products.length && !loadError ? (
          <div className="empty">
            No products are available in this section yet.
            <br />
            Ask the admin to add products (Admin → Products) and make sure they are active.
          </div>
        ) : (
          <div className="pgrid">
            <ProductGrid products={list} cartQty={(id) => cartQuantityOf(cart, id)} onAdd={onAdd} />
          </div>
        )}
      </section>

      <button type="button" className="cart-bar mobile-only" onClick={() => setMobileCart(true)} disabled={!units}>
        <span>
          🛒 {units} item{units === 1 ? '' : 's'}
        </span>
        <b>{money(centsToAmount(totalCents))}</b>
        <span>View order ›</span>
      </button>

      <CartPanel
        cart={cart}
        totalCents={totalCents}
        units={units}
        locked={locked}
        onInc={onInc}
        onDec={onDec}
        onRemove={onRemove}
        onClear={onClear}
        onPay={openCheckout}
        canPay={units > 0}
        payHint={
          locked ? 'An earlier sale is unconfirmed — open Checkout to resolve it.' : !online ? 'Internet connection required to complete sale.' : null
        }
        mobileOpen={mobileCart}
        onCloseMobile={() => setMobileCart(false)}
      />

      {checkoutOpen && (
        <CheckoutModal
          totalCents={pending ? Math.round(pending.expectedTotal * 100) : totalCents}
          units={units}
          phase={phase}
          error={payError}
          initialMethod={pending?.method ?? 'CASH'}
          initialReceived={pending?.receivedText ?? ''}
          onSubmit={submitPayment}
          onRetry={() => attemptRef.current && send(attemptRef.current)}
          onCheckStatus={() => checkStatus()}
          onClose={() => {
            if (phase === 'form') setCheckoutOpen(false);
          }}
        />
      )}

      {receipt && (
        <ReceiptModal
          receipt={receipt}
          title={receipt.duplicate ? 'Sale already saved' : 'Sale completed'}
          onClose={() => setReceipt(null)}
          headline={
            <div className="done">
              <div className="tick">✓</div>
              <h2 style={{ margin: 0 }}>Sale {receipt.txn_no} saved</h2>
              {receipt.payment_method === 'CASH' && (
                <>
                  <div className="muted" style={{ marginTop: 12, fontWeight: 700, letterSpacing: '.06em' }}>
                    CHANGE TO GIVE
                  </div>
                  <div className="big-change">{money(receipt.change_given)}</div>
                </>
              )}
            </div>
          }
        />
      )}
    </div>
  );
}
