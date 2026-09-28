import { describe, it, expect } from 'vitest';
import {
  addToCart, setQuantity, removeFromCart, cartTotalCents, cartUnits, reconcileCart, cartSignature, toCheckoutItems,
} from '../../src/utils/cart.js';

const p = (over = {}) => ({ id: 1, name: 'Keychains', price: 40, stock: 3, min_stock: 1, track_stock: true, active: true, ...over });

describe('cart', () => {
  it('adds and increments lines', () => {
    let { cart } = addToCart([], p());
    ({ cart } = addToCart(cart, p()));
    expect(cart).toHaveLength(1);
    expect(cart[0].quantity).toBe(2);
    expect(cartUnits(cart)).toBe(2);
    expect(cartTotalCents(cart)).toBe(8000);
  });

  it('never adds beyond available stock', () => {
    let cart = [];
    for (let i = 0; i < 3; i++) cart = addToCart(cart, p()).cart;
    const r = addToCart(cart, p());
    expect(r.error).toMatch(/Only 3/);
    expect(r.cart[0].quantity).toBe(3);
    expect(addToCart([], p({ stock: 0 })).error).toMatch(/out of stock/);
    expect(addToCart([], p({ active: false })).error).toMatch(/not available/);
  });

  it('services have no stock limit', () => {
    const svc = p({ id: 9, name: 'Face painting', track_stock: false, stock: 0, price: 30 });
    let cart = [];
    for (let i = 0; i < 20; i++) cart = addToCart(cart, svc).cart;
    expect(cart[0].quantity).toBe(20);
  });

  it('sets, caps and removes quantities', () => {
    let { cart } = addToCart([], p());
    expect(setQuantity(cart, 1, 2).cart[0].quantity).toBe(2);
    const capped = setQuantity(cart, 1, 10);
    expect(capped.cart[0].quantity).toBe(3);
    expect(capped.error).toMatch(/Only 3/);
    expect(setQuantity(cart, 1, 0).cart).toEqual([]);
    expect(removeFromCart(cart, 1)).toEqual([]);
  });

  it('computes totals with decimal prices exactly', () => {
    let cart = [];
    for (let i = 0; i < 3; i++) cart = addToCart(cart, p({ price: 12.35, stock: 10 })).cart;
    expect(cartTotalCents(cart)).toBe(3705);
  });

  it('reconciles with fresh product data', () => {
    let cart = addToCart([], p({ stock: 5 })).cart;
    cart = setQuantity(cart, 1, 4).cart;
    cart = addToCart(cart, p({ id: 2, name: 'Caps', price: 130 })).cart;
    const { cart: next, changes } = reconcileCart(cart, [p({ stock: 2, price: 45 })]);
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ quantity: 2, price: 45 });
    expect(changes.join(' ')).toMatch(/Caps.*removed/);
    expect(changes.join(' ')).toMatch(/price/);
    expect(changes.join(' ')).toMatch(/only 2 left/);
  });

  it('signature changes when anything that affects the sale changes', () => {
    const a = addToCart([], p()).cart;
    const b = setQuantity(a, 1, 2).cart;
    expect(cartSignature(a)).not.toBe(cartSignature(b));
    expect(cartSignature(a)).toBe(cartSignature([...a]));
    expect(toCheckoutItems(b)).toEqual([{ product_id: 1, quantity: 2 }]);
  });
});
