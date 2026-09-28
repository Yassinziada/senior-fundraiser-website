// Pure cart logic for the POS (no React, fully unit-tested).
// A cart line: { product_id, name, price (amount), quantity, track_stock, stock }
// The browser checks stock only for convenience; the database re-checks
// everything atomically at checkout.
import { toCents } from './money.js';

export const MAX_QTY_PER_LINE = 999;

function availableFor(product) {
  return product.track_stock ? Math.max(0, product.stock) : MAX_QTY_PER_LINE;
}

/** Add one unit of product. Returns { cart, error } — error is a message when refused. */
export function addToCart(cart, product) {
  if (!product.active) return { cart, error: `${product.name} is not available.` };
  const line = cart.find((l) => l.product_id === product.id);
  const current = line ? line.quantity : 0;
  const available = availableFor(product);
  if (product.track_stock && available <= 0) return { cart, error: `${product.name} is out of stock.` };
  if (current + 1 > available) {
    return { cart, error: product.track_stock ? `Only ${available} × ${product.name} in stock.` : 'Maximum quantity reached.' };
  }
  if (line) {
    return { cart: cart.map((l) => (l === line ? { ...l, quantity: l.quantity + 1 } : l)), error: null };
  }
  return {
    cart: [
      ...cart,
      {
        product_id: product.id,
        name: product.name,
        price: Number(product.price),
        quantity: 1,
        track_stock: product.track_stock,
        stock: product.stock,
      },
    ],
    error: null,
  };
}

/** Set a line's quantity (0 removes it). Caps at available stock. */
export function setQuantity(cart, productId, quantity) {
  const line = cart.find((l) => l.product_id === productId);
  if (!line) return { cart, error: null };
  const q = Math.floor(Number(quantity));
  if (!Number.isFinite(q) || q <= 0) return { cart: cart.filter((l) => l !== line), error: null };
  const available = line.track_stock ? line.stock : MAX_QTY_PER_LINE;
  if (q > available) {
    return {
      cart: cart.map((l) => (l === line ? { ...l, quantity: available } : l)).filter((l) => l.quantity > 0),
      error: line.track_stock ? `Only ${available} × ${line.name} in stock.` : 'Maximum quantity reached.',
    };
  }
  return { cart: cart.map((l) => (l === line ? { ...l, quantity: q } : l)), error: null };
}

export function removeFromCart(cart, productId) {
  return cart.filter((l) => l.product_id !== productId);
}

export function cartTotalCents(cart) {
  return cart.reduce((acc, l) => acc + toCents(l.price) * l.quantity, 0);
}

export function cartUnits(cart) {
  return cart.reduce((acc, l) => acc + l.quantity, 0);
}

export function cartQuantityOf(cart, productId) {
  return cart.find((l) => l.product_id === productId)?.quantity ?? 0;
}

/**
 * Bring the cart in line with fresh product data (after realtime updates or a
 * failed checkout): updates prices/stock, drops unavailable products and caps
 * quantities. Returns { cart, changes: [human readable messages] }.
 */
export function reconcileCart(cart, products) {
  const byId = new Map(products.map((p) => [p.id, p]));
  const changes = [];
  const next = [];
  for (const line of cart) {
    const p = byId.get(line.product_id);
    if (!p || !p.active) {
      changes.push(`${line.name} is no longer available and was removed.`);
      continue;
    }
    const updated = { ...line, name: p.name, price: Number(p.price), track_stock: p.track_stock, stock: p.stock };
    if (toCents(line.price) !== toCents(p.price)) changes.push(`${p.name}: price is now ${Number(p.price)}.`);
    if (p.track_stock && updated.quantity > p.stock) {
      if (p.stock <= 0) {
        changes.push(`${p.name} is now out of stock and was removed.`);
        continue;
      }
      changes.push(`${p.name}: only ${p.stock} left, quantity reduced.`);
      updated.quantity = p.stock;
    }
    next.push(updated);
  }
  return { cart: next, changes };
}

/** Stable text fingerprint of what is being bought (used to decide whether a
 *  retry may reuse the previous idempotency key). */
export function cartSignature(cart) {
  return [...cart]
    .sort((a, b) => a.product_id - b.product_id)
    .map((l) => `${l.product_id}x${l.quantity}@${toCents(l.price)}`)
    .join('|');
}

export function toCheckoutItems(cart) {
  return cart.map((l) => ({ product_id: l.product_id, quantity: l.quantity }));
}
