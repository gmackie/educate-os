import { useCallback, useEffect, useState } from 'react';

export type LoadState<T> =
  | { status: 'loading' }
  | { status: 'ready'; value: T }
  | { status: 'error'; message: string };

/** A keyed, cancellable request. A previous school/class may never overwrite a newer screen. */
export function useLoad<T>(key: string, get: () => Promise<T>): [LoadState<T>, () => void] {
  const [refreshKey, refresh] = useState(0);
  const [state, setState] = useState<{ key: string; result: LoadState<T> }>();
  const reload = useCallback(() => refresh((n) => n + 1), []);
  useEffect(() => {
    let alive = true;
    const current = key + '/' + refreshKey;
    Promise.resolve().then(get).then(
      (value) => { if (alive) setState({ key: current, result: { status: 'ready', value } }); },
      (error: unknown) => { if (alive) setState({ key: current, result: { status: 'error',
        message: error instanceof Error ? error.message : 'Unable to load information.' } }); },
    );
    return () => { alive = false; };
  // get closure intentionally keyed by caller-supplied 'key'; refreshKey forces retry.
  }, [key, refreshKey]);
  return state?.key === key + '/' + refreshKey ? [state.result, reload] : [{ status: 'loading' }, reload];
}
