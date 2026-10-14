/**
 * Minimal data layer: a per-domain revision counter plus a fetch hook.
 *
 * The agent panel can mutate tasks, goals, the queue, activity and habits in a
 * single command, so it reports which domains it touched and every mounted view
 * of those domains refetches. No external state library needed.
 *
 * This file exports only the provider component; the hooks that read it live in
 * `use-resource.ts` and the context itself in `workspace-context.ts`.
 */
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import {
  WorkspaceContext,
  zeroedRevisions,
  type DataDomain,
  type Revisions,
} from '@/hooks/workspace-context';

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [revisions, setRevisions] = useState<Revisions>(zeroedRevisions);

  const invalidate = useCallback((domains: DataDomain[]) => {
    setRevisions((previous) => {
      const next = { ...previous };
      for (const domain of domains) next[domain] = (next[domain] ?? 0) + 1;
      return next;
    });
  }, []);

  const value = useMemo(() => ({ revisions, invalidate }), [revisions, invalidate]);
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}
