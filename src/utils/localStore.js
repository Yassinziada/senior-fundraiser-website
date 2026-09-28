// Tiny safe wrapper around localStorage. Used ONLY for per-device
// conveniences (the current cart, an unfinished checkout's retry key).
// Business data never lives here — the database is the source of truth.
export function readJSON(key, fallback = null) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}

export function writeJSON(key, value) {
  try {
    if (value === null || value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage blocked: the POS still works, it just won't survive a refresh */
  }
}
