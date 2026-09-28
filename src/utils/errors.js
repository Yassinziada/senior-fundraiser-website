// Turn Supabase / network errors into something a cashier can act on.
// Database functions raise a readable message plus a HINT code
// (e.g. INSUFFICIENT_STOCK). A network failure is flagged separately because
// for a checkout it means "result unknown", not "failed".

export class AppError extends Error {
  constructor(message, { code = null, network = false, status = null, cause = null } = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.network = network;
    this.status = status;
    this.cause = cause;
  }
}

const NETWORK_PATTERNS = [/failed to fetch/i, /networkerror/i, /network request failed/i, /load failed/i, /aborted/i, /timeout/i, /fetch failed/i];

export function isNetworkMessage(msg) {
  return NETWORK_PATTERNS.some((re) => re.test(String(msg ?? '')));
}

/** Normalise a supabase-js { error } object or thrown exception. */
export function toAppError(err) {
  if (!err) return new AppError('Unknown error');
  if (err instanceof AppError) return err;
  const message = err.message ?? String(err);
  const network = err.name === 'AbortError' || err.name === 'TypeError' || (!err.code && isNetworkMessage(message)) || isNetworkMessage(err.details);
  if (network) {
    return new AppError('No connection to the server. Internet connection required.', { network: true, cause: err });
  }
  if (err.code === '42501' || err.code === 'PGRST301' || err.status === 401 || err.status === 403) {
    return new AppError(err.hint && err.hint !== 'FORBIDDEN' ? message : message || 'You do not have permission to do this.', {
      code: err.hint || 'FORBIDDEN',
      status: err.status,
      cause: err,
    });
  }
  return new AppError(message, { code: err.hint || err.code || null, status: err.status, cause: err });
}
