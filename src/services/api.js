// Thin wrappers around Supabase calls: consistent error handling + timeouts.
import { supabase } from '../lib/supabase.js';
import { AppError, toAppError } from '../utils/errors.js';

const DEFAULT_TIMEOUT_MS = 20_000;

function withTimeout(builder, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { query: builder.abortSignal(controller.signal), done: () => clearTimeout(timer) };
}

/** Call a database function (RPC). Throws AppError. */
export async function rpc(fn, args = {}, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new AppError('No internet connection. Internet connection required.', { network: true });
  }
  const { query, done } = withTimeout(supabase.rpc(fn, args), timeoutMs);
  try {
    const { data, error } = await query;
    if (error) throw toAppError(error);
    return data;
  } catch (e) {
    throw toAppError(e);
  } finally {
    done();
  }
}

/** Run a PostgREST query builder (supabase.from(...)...). Throws AppError. */
export async function run(builder, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const { query, done } = withTimeout(builder, timeoutMs);
  try {
    const { data, error, count } = await query;
    if (error) throw toAppError(error);
    return count === undefined || count === null ? data : { data, count };
  } catch (e) {
    throw toAppError(e);
  } finally {
    done();
  }
}

/** Call the admin-users Edge Function (creating users, resetting PINs). */
export async function adminUsersFunction(body) {
  const { data, error } = await supabase.functions.invoke('admin-users', { body });
  if (error) {
    let message = error.message;
    try {
      const j = await error.context?.json?.();
      if (j?.error) message = j.error;
    } catch {
      /* ignore */
    }
    if (/Failed to send a request|FunctionsFetchError/i.test(message) || error.name === 'FunctionsFetchError') {
      message =
        'Could not reach the "admin-users" Edge Function. Is it deployed? (README → "Deploy the admin-users function")';
    }
    throw new AppError(message, { code: 'FUNCTION_ERROR' });
  }
  if (data?.error) throw new AppError(data.error, { code: 'FUNCTION_ERROR' });
  return data;
}
