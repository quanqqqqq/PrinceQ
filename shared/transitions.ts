/**
 * Task lifecycle state machine — pure declarations, no I/O.
 *
 * Lives in `shared/` because both sides need it: the server enforces it on every
 * write (see `server/domain/transitions.ts`, which wraps these checks in HTTP
 * errors), and the web UI uses it to render only buttons that will actually
 * succeed. One table, so the two can never disagree.
 */
import type { TaskAction, TaskStatus } from './types.ts';

export interface TransitionRule {
  from: TaskStatus[];
  to: TaskStatus;
  /** Claim bookkeeping the caller must perform alongside the status change. */
  claim: 'acquire' | 'release' | 'keep';
  /** Requires an existing active claim held by the acting actor. */
  requiresClaim: boolean;
  label: string;
}

export const TRANSITIONS: Record<TaskAction, TransitionRule> = {
  claim: {
    from: ['inbox'],
    to: 'claimed',
    claim: 'acquire',
    requiresClaim: false,
    label: 'claim an unclaimed task',
  },
  release: {
    from: ['claimed', 'in_progress', 'blocked'],
    to: 'inbox',
    claim: 'release',
    requiresClaim: true,
    label: 'release a claimed task back to the inbox',
  },
  start: {
    from: ['claimed', 'blocked'],
    to: 'in_progress',
    claim: 'keep',
    requiresClaim: true,
    label: 'start work on a claimed task',
  },
  block: {
    from: ['claimed', 'in_progress'],
    to: 'blocked',
    claim: 'keep',
    requiresClaim: true,
    label: 'mark a claimed task as blocked',
  },
  unblock: {
    from: ['blocked'],
    to: 'claimed',
    claim: 'keep',
    requiresClaim: true,
    label: 'clear the blocked state',
  },
  complete: {
    from: ['claimed', 'in_progress'],
    to: 'completed',
    claim: 'release',
    requiresClaim: true,
    label: 'complete a task in progress',
  },
  archive: {
    from: ['inbox', 'claimed', 'in_progress', 'blocked', 'completed'],
    to: 'archived',
    claim: 'release',
    requiresClaim: false,
    label: 'archive a task',
  },
  /**
   * Undo an archive. The real target status is *not* the static `to` below — it
   * is the status recorded on the task's most recent `task.archive` operation.
   * The placeholder `to: 'inbox'` only lets the pure validator accept the move;
   * the server computes and applies the real target (and re-activates the claim
   * the archive had released). `claim: 'keep'` means the generic claim bookkeeping
   * path stays out of the way — restore handles the assignment row itself.
   */
  restore: {
    from: ['archived'],
    to: 'inbox',
    claim: 'keep',
    requiresClaim: false,
    label: 'restore an archived task to its previous state',
  },
  reopen: {
    from: ['completed'],
    to: 'inbox',
    claim: 'release',
    requiresClaim: false,
    label: 'reopen a finished task into the inbox',
  },
};

export interface TransitionCheck {
  ok: boolean;
  to?: TaskStatus;
  claim?: TransitionRule['claim'];
  reason?: string;
}

/** Pure validity check — no database access, so it is directly unit-testable. */
export function checkTransition(from: TaskStatus, action: TaskAction): TransitionCheck {
  const rule = TRANSITIONS[action];
  if (!rule) {
    return { ok: false, reason: `Unknown action "${action}".` };
  }
  if (from === rule.to && rule.claim !== 'release') {
    return { ok: false, reason: `Task is already ${from}.` };
  }
  if (!rule.from.includes(from)) {
    return {
      ok: false,
      reason: `Cannot ${action} a task in status "${from}" — allowed from: ${rule.from.join(', ')}.`,
    };
  }
  return { ok: true, to: rule.to, claim: rule.claim };
}

export const requiresClaim = (action: TaskAction): boolean => TRANSITIONS[action].requiresClaim;

/** Actions offered for a status, used by the UI to render only working buttons. */
export function availableActions(status: TaskStatus): TaskAction[] {
  return (Object.keys(TRANSITIONS) as TaskAction[]).filter(
    (action) => checkTransition(status, action).ok,
  );
}
