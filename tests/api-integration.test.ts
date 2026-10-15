/**
 * Integration tests: idempotent create and claim conflict, exercised through
 * the real HTTP layer against a temporary SQLite file.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pwq-itest-'));
// Must be set before the config module is first evaluated.
process.env.PWQ_DB_PATH = path.join(tempRoot, 'test.db');
process.env.PWQ_HABITS_DIR = path.join(tempRoot, 'habits');
process.env.PWQ_AGENT_RUNTIME_CONFIG = path.join(process.env.PWQ_HABITS_DIR!, '..', 'runtime.json');
process.env.PWQ_API_PORT = '0';

const { applySchema, getDb, closeDb } = await import('../server/db/connection.ts');
const { seedActors } = await import('../server/db/seed.ts');
const { ensureHabitFiles } = await import('../server/domain/habits.ts');
const { createServer } = await import('../server/index.ts');

let server: Server;
let base: string;

test.before(async () => {
  ensureHabitFiles();
  const db = getDb();
  applySchema(db);
  seedActors(db);

  server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

interface Call {
  status: number;
  body: any;
}

async function call(
  method: string,
  pathname: string,
  body?: unknown,
  idempotencyKey?: string,
): Promise<Call> {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const createTask = (title: string, key: string, extra: Record<string, unknown> = {}) =>
  call('POST', '/api/tasks', { title, ...extra }, key);

test('DELETE goal removes all linked tasks and their records, preserves unrelated tasks, and replays once', async () => {
  const goal = (await call('POST', '/api/goals', { title: '删除测试目标' }, 'delete-goal-create')).body.goal;
  const otherGoal = (await call('POST', '/api/goals', { title: '保留目标' }, 'delete-other-goal')).body.goal;
  const task = (await createTask('领取中的关联任务', 'delete-goal-task-create', { goal_id: goal.id })).body.task;
  const archived = (await createTask('归档的关联任务', 'delete-goal-archived', { goal_id: goal.id })).body.task;
  const completed = (await createTask('已完成的关联任务', 'delete-goal-completed', { goal_id: goal.id })).body.task;
  const other = (await createTask('其他目标的任务', 'delete-goal-other', { goal_id: otherGoal.id })).body.task;
  const independent = (await createTask('独立任务', 'delete-goal-independent')).body.task;
  await call('POST', `/api/tasks/${task.id}/actions`, { action: 'claim' }, 'delete-goal-claim');
  assert.equal((await call('POST', `/api/tasks/${archived.id}/actions`, { action: 'archive' }, 'delete-goal-archive')).status, 200);
  await call('POST', `/api/tasks/${completed.id}/actions`, { action: 'claim' }, 'delete-goal-completed-claim');
  await call('POST', `/api/tasks/${completed.id}/actions`, { action: 'start' }, 'delete-goal-completed-start');
  assert.equal((await call('POST', `/api/tasks/${completed.id}/actions`, { action: 'complete' }, 'delete-goal-complete')).status, 200);
  await call('POST', `/api/tasks/${other.id}/dependencies`, { depends_on_id: task.id }, 'delete-goal-dep');
  assert.equal((await call('POST', `/api/tasks/${task.id}/rescoring-request`, { changed_axes: ['importance'] }, 'delete-goal-rescoring')).status, 200);
  for (const table of ['task_assignments', 'rescoring_requests', 'queue_entries']) {
    assert.ok(Number(getDb().prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE task_id = ?`).get(task.id)!.count) > 0);
  }
  const before = (await call('GET', `/api/tasks/${other.id}`)).body.task;
  const deleted = await call('DELETE', `/api/goals/${goal.id}`, { expected_version: goal.version }, 'delete-goal');
  assert.equal(deleted.status, 200);
  const deletedIds = [task.id, archived.id, completed.id].sort();
  assert.deepEqual(deleted.body.deleted_task_ids, deletedIds);
  assert.equal((await call('GET', `/api/goals/${goal.id}`)).status, 404);
  for (const id of deletedIds) {
    assert.equal((await call('GET', `/api/tasks/${id}`)).status, 404);
    for (const table of ['task_assignments', 'rescoring_requests', 'queue_entries']) {
      assert.equal(getDb().prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE task_id = ?`).get(id)!.count, 0);
    }
    assert.equal(getDb().prepare('SELECT COUNT(*) AS count FROM task_dependencies WHERE task_id = ? OR depends_on_id = ?').get(id, id)!.count, 0);
  }
  const after = (await call('GET', `/api/tasks/${other.id}`)).body.task;
  assert.equal(after.goal_id, otherGoal.id);
  assert.equal(after.title, before.title);
  assert.deepEqual(after.depends_on, []);
  assert.equal(after.version, before.version + 1);
  assert.equal((await call('GET', `/api/tasks/${independent.id}`)).status, 200);
  const queue = (await call('GET', '/api/queue')).body;
  assert.ok(queue.entries.every((entry: { task: { id: string } }) => !deletedIds.includes(entry.task.id)));
  const replay = await call('DELETE', `/api/goals/${goal.id}`, { expected_version: goal.version }, 'delete-goal');
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  assert.deepEqual(replay.body.deleted_task_ids, deletedIds);
  assert.equal((await call('GET', `/api/tasks/${other.id}`)).body.task.version, after.version);
});

test('DELETE empty goal returns no deleted task IDs', async () => {
  const goal = (await call('POST', '/api/goals', { title: '空目标' }, 'delete-empty-goal-create')).body.goal;
  const deleted = await call('DELETE', `/api/goals/${goal.id}`, { expected_version: goal.version }, 'delete-empty-goal');
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.body.deleted_task_ids, []);
});

test('DELETE task removes dependencies and queue entry, preserves neighbours, and replays', async () => {
  const first = (await createTask('删除的前置任务', 'delete-task-first')).body.task;
  const second = (await createTask('保留的后续任务', 'delete-task-second')).body.task;
  await call('POST', `/api/tasks/${second.id}/dependencies`, { depends_on_id: first.id }, 'delete-task-dep');
  const before = (await call('GET', `/api/tasks/${second.id}`)).body.task;
  const target = (await call('GET', `/api/tasks/${first.id}`)).body.task;
  assert.equal(before.dependency_ready, false);
  const deleted = await call('DELETE', `/api/tasks/${first.id}`, { expected_version: target.version }, 'delete-task');
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.body.removed_dependency_task_ids, [second.id]);
  assert.equal((await call('GET', `/api/tasks/${first.id}`)).status, 404);
  const after = (await call('GET', `/api/tasks/${second.id}`)).body.task;
  assert.equal(after.title, before.title);
  assert.deepEqual(after.depends_on, []);
  assert.equal(after.dependency_ready, true);
  assert.equal(after.version, before.version + 1);
  const queue = (await call('GET', '/api/queue')).body;
  assert.ok(!queue.entries.some((entry: { task: { id: string } }) => entry.task.id === first.id));
  assert.ok(queue.entries.some((entry: { task: { id: string } }) => entry.task.id === second.id));
  const replay = await call('DELETE', `/api/tasks/${first.id}`, { expected_version: target.version }, 'delete-task');
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  assert.equal((await call('GET', `/api/tasks/${second.id}`)).body.task.version, after.version);
});

test('DELETE refuses stale versions and keeps both goals and tasks intact', async () => {
  const goal = (await call('POST', '/api/goals', { title: '版本冲突目标' }, 'delete-conflict-goal')).body.goal;
  const task = (await createTask('版本冲突任务', 'delete-conflict-task', { goal_id: goal.id })).body.task;
  await call('PATCH', `/api/goals/${goal.id}`, { title: '已更新目标', expected_version: goal.version }, 'delete-conflict-goal-edit');
  await call('PATCH', `/api/tasks/${task.id}`, { title: '已更新任务', expected_version: task.version }, 'delete-conflict-task-edit');
  assert.equal((await call('DELETE', `/api/goals/${goal.id}`, { expected_version: goal.version }, 'delete-conflict-goal-attempt')).status, 409);
  assert.equal((await call('DELETE', `/api/tasks/${task.id}`, { expected_version: task.version }, 'delete-conflict-task-attempt')).status, 409);
  assert.equal((await call('GET', `/api/goals/${goal.id}`)).body.goal.title, '已更新目标');
  const kept = (await call('GET', `/api/tasks/${task.id}`)).body.task;
  assert.equal(kept.title, '已更新任务');
  assert.equal(kept.goal_id, goal.id);
});

test('health reports deterministic-local mode and a reachable database', async () => {
  const { status, body } = await call('GET', '/api/health');

  assert.equal(status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.mode, 'deterministic-local');
  assert.ok(body.algorithm_version.startsWith('pwq-queue-'));
});

test('repeating a create with the same idempotency key creates exactly one task', async () => {
  const key = 'itest-create-once';
  const title = 'Idempotent create probe';

  const first = await createTask(title, key);
  const second = await createTask(title, key);
  const third = await createTask(title, key);

  assert.equal(first.status, 200);
  assert.equal(first.body.replayed, false);
  assert.equal(second.body.replayed, true, 'the second call is reported as a replay');
  assert.equal(third.body.replayed, true);

  // Same task identity returned each time.
  assert.equal(second.body.task.id, first.body.task.id);
  assert.equal(third.body.task.id, first.body.task.id);

  const { body } = await call('GET', '/api/tasks');
  const matching = body.tasks.filter((t: { title: string }) => t.title === title);
  assert.equal(matching.length, 1, 'only one row exists in the database');
});

test('concurrent creates sharing one idempotency key still yield a single task', async () => {
  const key = 'itest-create-concurrent';
  const title = 'Concurrent idempotent probe';

  const results = await Promise.all([
    createTask(title, key),
    createTask(title, key),
    createTask(title, key),
    createTask(title, key),
  ]);

  const succeeded = results.filter((r) => r.status === 200);
  assert.ok(succeeded.length >= 1, 'at least one request succeeds');
  for (const result of results) {
    assert.ok([200, 409].includes(result.status), `status ${result.status} is success or conflict`);
  }

  const { body } = await call('GET', '/api/tasks');
  const matching = body.tasks.filter((t: { title: string }) => t.title === title);
  assert.equal(matching.length, 1, 'the unique idempotency key prevented duplicates');
});

test('different idempotency keys create distinct tasks', async () => {
  const a = await createTask('Distinct key probe', 'itest-distinct-a');
  const b = await createTask('Distinct key probe', 'itest-distinct-b');

  assert.notEqual(a.body.task.id, b.body.task.id);
  assert.equal(b.body.replayed, false);
});

test('a create records an operation and refreshes the queue in one transaction', async () => {
  const { body } = await createTask('Transactional create probe', 'itest-txn-create');

  assert.ok(body.operation.id, 'operation was logged');
  assert.equal(body.operation.status, 'succeeded');
  assert.ok(body.queue_snapshot?.id, 'a queue snapshot was written');
  assert.ok(body.task.queue_position >= 1, 'the task received a queue position');
  assert.equal(typeof body.task.queue_score, 'number');

  const activity = await call('GET', '/api/activity');
  assert.ok(
    activity.body.operations.some((o: { id: string }) => o.id === body.operation.id),
    'the operation shows up in the activity log',
  );
  assert.ok(
    activity.body.snapshots.some((s: { id: string }) => s.id === body.queue_snapshot.id),
    'the recalculation shows up in the activity log',
  );
});

test('a created task carries an unconfirmed quadrant suggestion with reasoning', async () => {
  const { body } = await createTask(
    'Urgent production incident probe affecting customers',
    'itest-quadrant-probe',
    { deadline: new Date(Date.now() + 3 * 36e5).toISOString() },
  );

  assert.equal(body.task.quadrant, 'q1');
  // The local keyword rules are not a model — they must report themselves as
  // 'rule', and the continuous axes must agree with the quadrant they produced.
  assert.equal(body.task.quadrant_source, 'rule');
  assert.equal(body.task.matrix_score_source, 'rule');
  assert.ok(body.task.matrix_importance_score >= 50);
  assert.ok(body.task.matrix_urgency_score >= 50);
  assert.equal(body.task.quadrant_confirmed, false, 'awaiting user confirmation');
  assert.ok(body.task.quadrant_confidence > 0);
  assert.match(body.task.quadrant_reason, /awaiting your confirmation/i);
});

test('POST /matrix-score persists an agent judgement and logs the operation', async () => {
  const created = await createTask('Matrix score probe', 'itest-score-create');
  const taskId = created.body.task.id;

  const scored = await call(
    'POST',
    `/api/tasks/${taskId}/matrix-score`,
    {
      importance_score: 77.5,
      urgency_score: 88,
      reason: '直接影响本季度交付，且下游已在等待。',
      source: 'agent',
      confidence: 0.75,
    },
    'itest-score-apply',
  );

  assert.equal(scored.status, 200);
  assert.equal(scored.body.task.matrix_importance_score, 77.5, 'decimals survive the round trip');
  assert.equal(scored.body.task.matrix_urgency_score, 88);
  assert.equal(scored.body.task.matrix_score_source, 'agent');
  assert.equal(scored.body.task.quadrant, 'q1');
  assert.equal(scored.body.task.quadrant_confirmed, false, 'agent scores await confirmation');
  assert.equal(scored.body.operation.operation_type, 'task.matrix.score');

  // Re-sending the identical call replays rather than scoring twice.
  const replay = await call(
    'POST',
    `/api/tasks/${taskId}/matrix-score`,
    {
      importance_score: 77.5,
      urgency_score: 88,
      reason: '直接影响本季度交付，且下游已在等待。',
      source: 'agent',
      confidence: 0.75,
    },
    'itest-score-apply',
  );
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.task.matrix_score_version, 1, 'the replay did not re-score');
});

test('POST /matrix-score rejects an out-of-range score and a missing reason', async () => {
  const created = await createTask('Matrix score validation probe', 'itest-score-invalid');
  const taskId = created.body.task.id;

  const outOfRange = await call(
    'POST',
    `/api/tasks/${taskId}/matrix-score`,
    { importance_score: 140, urgency_score: 10, reason: '超出范围的测试输入' },
    'itest-score-range',
  );
  assert.equal(outOfRange.status, 400);
  assert.equal(outOfRange.body.error.code, 'validation_failed');

  const noReason = await call(
    'POST',
    `/api/tasks/${taskId}/matrix-score`,
    { importance_score: 60, urgency_score: 60 },
    'itest-score-noreason',
  );
  assert.equal(noReason.status, 400);

  const unchanged = await call('GET', `/api/tasks/${taskId}`);
  assert.equal(unchanged.body.task.matrix_score_source, 'rule', 'rejected scores never land');
});

test('a second claim on an already-claimed task is rejected with 409', async () => {  const created = await createTask('Claim conflict probe', 'itest-claim-create');
  const taskId = created.body.task.id;

  const first = await call(
    'POST',
    `/api/tasks/${taskId}/actions`,
    { action: 'claim', actor_id: 'actor-human-me' },
    'itest-claim-first',
  );
  assert.equal(first.status, 200);
  assert.equal(first.body.task.status, 'claimed');
  assert.equal(first.body.task.active_assignment.actor_id, 'actor-human-me');

  const second = await call(
    'POST',
    `/api/tasks/${taskId}/actions`,
    { action: 'claim', actor_id: 'actor-automation-cron' },
    'itest-claim-second',
  );

  assert.equal(second.status, 409, 'the competing claim is a conflict');
  assert.equal(second.body.error.code, 'conflict');

  // The original claim survives untouched.
  const after = await call('GET', `/api/tasks/${taskId}`);
  assert.equal(after.body.task.status, 'claimed');
  assert.equal(after.body.task.active_assignment.actor_id, 'actor-human-me');
  assert.equal(
    after.body.assignments.filter((a: { released_at: string | null }) => a.released_at === null).length,
    1,
    'exactly one active assignment exists',
  );
});

test('concurrent claims on one task let exactly one actor win', async () => {
  const created = await createTask('Concurrent claim probe', 'itest-race-create');
  const taskId = created.body.task.id;

  const results = await Promise.all([
    call('POST', `/api/tasks/${taskId}/actions`, { action: 'claim', actor_id: 'actor-human-me' }, 'race-1'),
    call('POST', `/api/tasks/${taskId}/actions`, { action: 'claim', actor_id: 'actor-agent-local' }, 'race-2'),
    call('POST', `/api/tasks/${taskId}/actions`, { action: 'claim', actor_id: 'actor-automation-cron' }, 'race-3'),
  ]);

  const winners = results.filter((r) => r.status === 200);
  assert.equal(winners.length, 1, 'one active claim per task is enforced');
  for (const loser of results.filter((r) => r.status !== 200)) {
    assert.equal(loser.status, 409);
  }

  const after = await call('GET', `/api/tasks/${taskId}`);
  assert.equal(
    after.body.assignments.filter((a: { released_at: string | null }) => a.released_at === null).length,
    1,
  );
});

test('a non-holder cannot start, block or complete someone else’s claim', async () => {
  const created = await createTask('Claim ownership probe', 'itest-owner-create');
  const taskId = created.body.task.id;

  await call(
    'POST',
    `/api/tasks/${taskId}/actions`,
    { action: 'claim', actor_id: 'actor-human-me' },
    'itest-owner-claim',
  );

  for (const action of ['start', 'block', 'complete', 'release'] as const) {
    const result = await call(
      'POST',
      `/api/tasks/${taskId}/actions`,
      { action, actor_id: 'actor-automation-cron' },
      `itest-owner-${action}`,
    );
    assert.equal(result.status, 409, `${action} by a non-holder is rejected`);
    assert.match(result.body.error.message, /claimed by/i);
  }
});

test('releasing a claim lets a different actor claim it afterwards', async () => {
  const created = await createTask('Claim handoff probe', 'itest-handoff-create');
  const taskId = created.body.task.id;

  await call('POST', `/api/tasks/${taskId}/actions`, { action: 'claim', actor_id: 'actor-human-me' }, 'ho-1');
  const released = await call(
    'POST',
    `/api/tasks/${taskId}/actions`,
    { action: 'release', actor_id: 'actor-human-me' },
    'ho-2',
  );
  assert.equal(released.body.task.status, 'inbox');
  assert.equal(released.body.task.active_assignment, null);

  const reclaimed = await call(
    'POST',
    `/api/tasks/${taskId}/actions`,
    { action: 'claim', actor_id: 'actor-agent-local' },
    'ho-3',
  );
  assert.equal(reclaimed.status, 200);
  assert.equal(reclaimed.body.task.active_assignment.actor_id, 'actor-agent-local');
});

test('replaying a claim with the same key does not create a second assignment', async () => {
  const created = await createTask('Claim replay probe', 'itest-replay-create');
  const taskId = created.body.task.id;
  const key = 'itest-replay-claim';

  const first = await call('POST', `/api/tasks/${taskId}/actions`, { action: 'claim', actor_id: 'actor-human-me' }, key);
  const second = await call('POST', `/api/tasks/${taskId}/actions`, { action: 'claim', actor_id: 'actor-human-me' }, key);

  assert.equal(first.status, 200);
  assert.equal(second.status, 200, 'the replay is not an error');
  assert.equal(second.body.replayed, true);

  const after = await call('GET', `/api/tasks/${taskId}`);
  assert.equal(after.body.assignments.length, 1, 'only one assignment row was ever written');
});

test('an invalid lifecycle transition is rejected and leaves the task untouched', async () => {
  const created = await createTask('Invalid transition probe', 'itest-invalid-create');
  const taskId = created.body.task.id;

  const result = await call(
    'POST',
    `/api/tasks/${taskId}/actions`,
    { action: 'complete', actor_id: 'actor-human-me' },
    'itest-invalid-complete',
  );

  assert.equal(result.status, 409);
  assert.match(result.body.error.message, /Cannot complete a task in status "inbox"/);

  const after = await call('GET', `/api/tasks/${taskId}`);
  assert.equal(after.body.task.status, 'inbox', 'the task did not move');
  assert.equal(after.body.task.version, created.body.task.version, 'version was not bumped');
});

test('an unfinished dependency keeps the dependent task below its blocker', async () => {
  const blocker = await createTask('Dependency blocker probe', 'itest-dep-blocker');
  const dependent = await createTask('Dependency dependent probe', 'itest-dep-dependent');

  const linked = await call(
    'POST',
    `/api/tasks/${dependent.body.task.id}/dependencies`,
    { depends_on_id: blocker.body.task.id },
    'itest-dep-link',
  );

  assert.equal(linked.status, 200);
  assert.deepEqual(linked.body.task.depends_on, [blocker.body.task.id]);
  assert.equal(linked.body.task.dependency_ready, false);

  const explained = await call('GET', `/api/queue/explain/${dependent.body.task.id}`);
  assert.ok(
    explained.body.breakdown.notes.some((n: string) => /dependency is unfinished/i.test(n)),
    'the breakdown explains the block',
  );
});

test('a rejected write still returns a structured error body', async () => {
  const bad = await call('POST', '/api/tasks', { title: '' }, 'itest-validation');

  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'validation_failed');
  assert.ok(Array.isArray(bad.body.error.details), 'zod issues are included');
});

test('unknown routes and methods return distinguishable errors', async () => {
  const missing = await call('GET', '/api/does-not-exist');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'not_found');

  const wrongMethod = await call('POST', '/api/health');
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.body.error.code, 'method_not_allowed');
});
