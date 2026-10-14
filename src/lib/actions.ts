/**
 * UI-side view of the lifecycle state machine.
 *
 * Re-exported from `shared/transitions.ts` so the buttons a card renders are
 * derived from the same table the server validates against. Queue entries and
 * goal task lists arrive without an `available_actions` field, so views compute
 * it from the status rather than guessing.
 */
import type { TaskAction, TaskStatus } from '@shared/types';
import { availableActions } from '@shared/transitions';

export const availableActionsFor = (status: TaskStatus): TaskAction[] => availableActions(status);
