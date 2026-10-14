/**
 * Data-fetching hooks over the workspace revision counters.
 *
 * `useResource` refetches whenever one of the domains it watches is invalidated;
 * `useMutation` wraps a write so the caller gets a pending flag, a surfaced
 * error and automatic invalidation of the affected domains.
 */
import { useCallback, useContext, useEffect, useState } from 'react';
import { ApiRequestError } from '@/lib/api';
import { WorkspaceContext, type DataDomain, type WorkspaceValue } from '@/hooks/workspace-context';

export const useWorkspace = (): WorkspaceValue => useContext(WorkspaceContext);

export interface Resource<T> {
  data: T | null;
  error: string | null;
  /** True only on the very first load, so refetches don't blank the screen. */
  loading: boolean;
  refreshing: boolean;
  /** False while `data`/`error` still belong to an earlier scope or revision. */
  current: boolean;
  refetch: () => void;
}

interface Settled<T> {
  data: T | null;
  error: string | null;
  /** Which fetch key this result belongs to; null before the first result. */
  key: string | null;
}

/**
 * Fetches `load()` once per mount and again whenever any of `domains` is
 * invalidated. Keeps the previous data visible while refreshing.
 *
 * `scope` names the inputs `load` closes over (a goal id, say). It joins the
 * fetch key, so changing it refetches and `current` reports false until the
 * result for the new scope lands.
 */
export function useResource<T>(
  domains: DataDomain[],
  load: () => Promise<T>,
  scope: readonly unknown[] = [],
): Resource<T> {
  const { revisions } = useWorkspace();
  const [manual, setManual] = useState(0);
  const [settled, setSettled] = useState<Settled<T>>({ data: null, error: null, key: null });

  const key = `${domains.map((domain) => revisions[domain] ?? 0).join(':')}|${manual}|${scope.join('|')}`;

  useEffect(() => {
    let cancelled = false;

    // `load` is read from this render's closure on purpose: the effect must not
    // re-run just because the caller passed a fresh inline arrow.
    load()
      .then((result) => {
        if (!cancelled) setSettled({ data: result, error: null, key });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setSettled({
          data: null,
          error:
            cause instanceof ApiRequestError
              ? cause.message
              : `Unexpected error: ${(cause as Error).message}`,
          key,
        });
      });

    return () => {
      cancelled = true;
    };
    // `load` intentionally omitted — `key` is the only refetch trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Both flags are derived rather than stored, so the effect never has to call
  // setState synchronously to announce that a fetch is in flight.
  const inFlight = settled.key !== key;
  const everLoaded = settled.key !== null;

  return {
    data: settled.data,
    error: settled.error,
    loading: inFlight && !everLoaded,
    refreshing: inFlight && everLoaded,
    current: settled.key === key,
    refetch: useCallback(() => setManual((n) => n + 1), []),
  };
}

/**
 * Wraps a write so the UI gets a pending flag, a surfaced error message and
 * automatic invalidation of the domains the write affects.
 */
export function useMutation(domains: DataDomain[]) {
  const { invalidate } = useWorkspace();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async <T,>(label: string, action: () => Promise<T>): Promise<T | null> => {
      setPending(label);
      setError(null);
      try {
        const result = await action();
        invalidate(domains);
        return result;
      } catch (cause) {
        setError(
          cause instanceof ApiRequestError
            ? cause.message
            : `Unexpected error: ${(cause as Error).message}`,
        );
        return null;
      } finally {
        setPending(null);
      }
    },
    // `domains` is a literal array at every call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [invalidate],
  );

  return { run, pending, error, clearError: useCallback(() => setError(null), []) };
}
