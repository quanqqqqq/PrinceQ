/**
 * Workspace context definition.
 *
 * Kept apart from the provider component and the hooks so that each module
 * exports only one kind of thing — Vite's fast refresh requires a file that
 * exports a component to export nothing else.
 */
import { createContext } from 'react';

export type DataDomain = 'tasks' | 'goals' | 'queue' | 'activity' | 'habits';

export const DATA_DOMAINS: DataDomain[] = ['tasks', 'goals', 'queue', 'activity', 'habits'];

export type Revisions = Record<DataDomain, number>;

export interface WorkspaceValue {
  revisions: Revisions;
  invalidate: (domains: DataDomain[]) => void;
}

export const zeroedRevisions = (): Revisions =>
  DATA_DOMAINS.reduce((acc, domain) => ({ ...acc, [domain]: 0 }), {} as Revisions);

export const WorkspaceContext = createContext<WorkspaceValue>({
  revisions: zeroedRevisions(),
  invalidate: () => {},
});
