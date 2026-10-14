/**
 * Server-side task lifecycle enforcement.
 *
 * The state machine itself lives in `shared/transitions.ts` so the web UI can
 * render exactly the actions the server will accept. This module adds the piece
 * that is server-only: turning an invalid move into a 409 ApiError.
 */
import type { TaskAction, TaskStatus } from '../../shared/types.ts';
import { checkTransition, type TransitionCheck } from '../../shared/transitions.ts';
import { conflict } from '../lib/errors.ts';

export {
  TRANSITIONS,
  availableActions,
  checkTransition,
  requiresClaim,
  type TransitionCheck,
  type TransitionRule,
} from '../../shared/transitions.ts';

export function assertTransition(
  from: TaskStatus,
  action: TaskAction,
): Required<Pick<TransitionCheck, 'to' | 'claim'>> {
  const result = checkTransition(from, action);
  if (!result.ok) {
    throw conflict(result.reason!, { from, action });
  }
  return { to: result.to!, claim: result.claim! };
}
