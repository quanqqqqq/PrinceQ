/** Unit tests for the task lifecycle state machine. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { TASK_ACTIONS, TASK_STATUSES, type TaskStatus } from '../shared/types.ts';
import {
  assertTransition,
  availableActions,
  checkTransition,
  requiresClaim,
} from '../server/domain/transitions.ts';
import { ApiError } from '../server/lib/errors.ts';

test('the happy path runs inbox → claimed → in_progress → completed', () => {
  assert.equal(checkTransition('inbox', 'claim').to, 'claimed');
  assert.equal(checkTransition('claimed', 'start').to, 'in_progress');
  assert.equal(checkTransition('in_progress', 'complete').to, 'completed');
});

test('a task cannot be completed straight out of the inbox', () => {
  const result = checkTransition('inbox', 'complete');

  assert.equal(result.ok, false);
  assert.match(result.reason!, /Cannot complete a task in status "inbox"/);
  assert.match(result.reason!, /allowed from: claimed, in_progress/);
});

test('a task cannot be started before it is claimed', () => {
  assert.equal(checkTransition('inbox', 'start').ok, false);
});

test('an unclaimed task cannot be claimed twice', () => {
  assert.equal(checkTransition('claimed', 'claim').ok, false);
  assert.equal(checkTransition('in_progress', 'claim').ok, false);
});

test('blocking and unblocking round-trip through claimed', () => {
  assert.equal(checkTransition('in_progress', 'block').to, 'blocked');
  assert.equal(checkTransition('blocked', 'unblock').to, 'claimed');
  assert.equal(checkTransition('blocked', 'start').to, 'in_progress');
});

test('releasing returns the task to the inbox and drops the claim', () => {
  for (const from of ['claimed', 'in_progress', 'blocked'] as TaskStatus[]) {
    const result = checkTransition(from, 'release');
    assert.equal(result.to, 'inbox', `release from ${from}`);
    assert.equal(result.claim, 'release');
  }
});

test('completed tasks reopen to inbox; archived tasks restore to their previous state', () => {
  // Completed: the only way out (other than archiving a finished task) is reopen.
  const completedAllowed = new Set(['reopen', 'archive']);
  for (const action of TASK_ACTIONS) {
    const result = checkTransition('completed', action);
    assert.equal(
      result.ok,
      completedAllowed.has(action),
      `${action} from completed → ${completedAllowed.has(action) ? 'allowed' : 'rejected'}`,
    );
  }
  assert.equal(checkTransition('completed', 'reopen').to, 'inbox');

  // Archived: the only way out is restore (undo the archive). reopen no longer
  // applies to archived — that is exactly what restore is for.
  for (const action of TASK_ACTIONS) {
    const result = checkTransition('archived', action);
    const allowed = action === 'restore';
    assert.equal(result.ok, allowed, `${action} from archived → ${allowed ? 'allowed' : 'rejected'}`);
  }
  // The pure validator reports a placeholder target; the server resolves the real
  // pre-archive status from the operation history.
  assert.equal(checkTransition('archived', 'restore').to, 'inbox');
});

test('archive is reachable from every non-archived status', () => {
  for (const from of TASK_STATUSES.filter((s) => s !== 'archived')) {
    assert.equal(checkTransition(from, 'archive').to, 'archived', `archive from ${from}`);
  }
  assert.equal(checkTransition('archived', 'archive').ok, false, 'archiving twice is rejected');
});

test('claim-holder enforcement is declared for exactly the owner-only actions', () => {
  const ownerOnly = TASK_ACTIONS.filter(requiresClaim);
  assert.deepEqual([...ownerOnly].sort(), ['block', 'complete', 'release', 'start', 'unblock']);
  assert.equal(requiresClaim('claim'), false, 'claiming cannot require a prior claim');
  assert.equal(requiresClaim('archive'), false);
});

test('claim bookkeeping is declared for every transition', () => {
  assert.equal(checkTransition('inbox', 'claim').claim, 'acquire');
  assert.equal(checkTransition('in_progress', 'complete').claim, 'release');
  assert.equal(checkTransition('claimed', 'start').claim, 'keep');
  assert.equal(checkTransition('in_progress', 'block').claim, 'keep');
});

test('an unknown action is rejected rather than defaulting to something', () => {
  const result = checkTransition('inbox', 'teleport' as never);

  assert.equal(result.ok, false);
  assert.match(result.reason!, /Unknown action/);
});

test('assertTransition throws a 409 ApiError on an invalid move', () => {
  assert.throws(
    () => assertTransition('inbox', 'complete'),
    (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 409);
      assert.equal(error.code, 'conflict');
      return true;
    },
  );
  assert.deepEqual(assertTransition('inbox', 'claim'), { to: 'claimed', claim: 'acquire' });
});

test('availableActions only ever reports moves that actually validate', () => {
  for (const status of TASK_STATUSES) {
    const actions = availableActions(status);
    for (const action of actions) {
      assert.equal(checkTransition(status, action).ok, true, `${action} from ${status}`);
    }
    for (const action of TASK_ACTIONS.filter((a) => !actions.includes(a))) {
      assert.equal(checkTransition(status, action).ok, false, `${action} excluded from ${status}`);
    }
  }
});

test('every status offers at least one action, so the UI is never a dead end', () => {
  for (const status of TASK_STATUSES) {
    assert.ok(availableActions(status).length > 0, `${status} has actions`);
  }
});

test('no transition leaves a task in a status outside the declared set', () => {
  for (const status of TASK_STATUSES) {
    for (const action of availableActions(status)) {
      const { to } = checkTransition(status, action);
      assert.ok(TASK_STATUSES.includes(to!), `${status} --${action}--> ${to}`);
    }
  }
});
