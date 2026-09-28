// Idempotency strategy for checkout (see README "Duplicate-sale protection").
//
// * Each sale attempt gets a random UUID "idempotency key" that is saved on the
//   device BEFORE the request is sent.
// * Retrying the same sale (double click, slow network, refresh, "Retry"
//   button) re-sends the SAME key; the database returns the already-created
//   sale instead of making a second one (unique index + advisory lock).
// * While an attempt's result is unknown (network failure), the cart is
//   frozen, so the cashier cannot accidentally start a different sale that
//   would get a new key. They either Retry (same key) or Check status.
import { readJSON, writeJSON } from './localStore.js';

const keyFor = (userId) => `pos.pendingCheckout.${userId}`;

export function loadPendingAttempt(userId) {
  return readJSON(keyFor(userId));
}

export function savePendingAttempt(userId, attempt) {
  writeJSON(keyFor(userId), attempt);
}

export function clearPendingAttempt(userId) {
  writeJSON(keyFor(userId), null);
}

function uuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  // fallback for very old browsers
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (crypto.getRandomValues(new Uint8Array(1))[0] & 15) >>> 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/**
 * Reuse the pending attempt's key when it is for exactly the same sale,
 * otherwise start a new attempt.
 */
export function attemptFor(pending, signature) {
  if (pending && pending.signature === signature) return pending;
  return { key: uuid(), signature, startedAt: new Date().toISOString() };
}
