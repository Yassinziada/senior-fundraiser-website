import { useCallback, useEffect, useRef, useState } from 'react';

/** Load data with loading/error state and a reload() function.
 *  Ignores responses from stale requests. */
export function useAsync(fn, deps = [], { immediate = true } = {}) {
  const [state, setState] = useState({ data: null, error: null, loading: immediate });
  const reqId = useRef(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const cb = useCallback(fn, deps);

  const reload = useCallback(
    async ({ silent = false } = {}) => {
      const id = ++reqId.current;
      if (!silent) setState((s) => ({ ...s, loading: true, error: null }));
      try {
        const data = await cb();
        if (id === reqId.current) setState({ data, error: null, loading: false });
        return data;
      } catch (error) {
        if (id === reqId.current) setState((s) => ({ ...s, error, loading: false }));
        return undefined;
      }
    },
    [cb],
  );

  useEffect(() => {
    if (immediate) reload();
  }, [reload, immediate]);

  return { ...state, reload, setData: (data) => setState((s) => ({ ...s, data })) };
}
