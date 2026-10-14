/**
 * Semantic tests for the goal-detail fixes (UX-01/UX-02/UX-09).
 *
 * Runs entirely against a throwaway in-memory SQLite database — never the real
 * data/work-queue.db. Habits are pointed at a temp dir so nothing on disk is
 * touched.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, withTempHabits } from './helpers.ts';
import { createGoal, previewDecomposition, confirmDecomposition } from '../server/repo/goal-service.ts';
import { createTask } from '../server/repo/task-service.ts';
import { findGoal } from '../server/repo/tasks.ts';
import { run } from '../server/db/connection.ts';
import { buildRouter } from '../server/http/routes.ts';

withTempHabits();

function setup() {
  const db = freshDb();
  const goal = createGoal(db, { title: 'Rewrite the billing pipeline', description: 'build and ship' });
  const router = buildRouter(() => db);
  return { db, goal, router };
}

async function getGoalDetail(router: ReturnType<typeof buildRouter>, id: string) {
  const match = router.match('GET', `/api/goals/${id}`);
  assert.ok(match, `route GET /api/goals/:id must exist`);
  return (await match.handler({ params: { id } } as never)) as {
    goal: ReturnType<typeof findGoal>;
    tasks: { status: string; title: string }[];
  };
}

// ── UX-02: linked-task universe excludes archived, totals agree with progress ─

test('UX-02: GET /goals/:id excludes archived tasks and matches progress.total', async () => {
  const { db, goal, router } = setup();

  createTask(db, { title: 'Active task A', goal_id: goal.id });
  createTask(db, { title: 'Active task B', goal_id: goal.id });
  createTask(db, { title: 'Retired task C', goal_id: goal.id });
  // Archive the third task directly: archived must leave both the list and the total.
  run(db, `UPDATE tasks SET status = 'archived' WHERE title = 'Retired task C'`);

  const afterProgress = findGoal(db, goal.id)!.progress;
  const detail = await getGoalDetail(router, goal.id);

  // The route hands back only the non-archived universe.
  assert.equal(detail.tasks.length, 2);
  assert.ok(detail.tasks.every((t) => t.status !== 'archived'), 'no archived task may be returned');
  // The panel header "关联任务（N）" and the progress denominator must agree.
  assert.equal(detail.tasks.length, afterProgress.total);
});

test('UX-02: progress denominator never counts archived even when other statuses mix', () => {
  const { db, goal } = setup();
  createTask(db, { title: 't1', goal_id: goal.id });
  createTask(db, { title: 't2', goal_id: goal.id });
  createTask(db, { title: 't3', goal_id: goal.id });
  run(db, `UPDATE tasks SET status = 'completed' WHERE title = 't1'`);
  run(db, `UPDATE tasks SET status = 'archived' WHERE title = 't3'`);

  const p = findGoal(db, goal.id)!.progress;
  assert.equal(p.total, 2, 'archived excluded; completed counts toward the active universe');
  assert.equal(p.completed, 1);
  assert.ok(p.ratio >= 0 && p.ratio <= 1);
});

// ── UX-09: editable preview object is the verbatim source of what gets saved ─

test('UX-09: acceptedDrafts override title/description verbatim and create only selected indexes', () => {
  const { db, goal } = setup();
  const preview = previewDecomposition(db, goal.id);
  assert.ok(preview.drafts.length >= 2);

  // The user keeps draft #0 and #2, editing both title and description.
  const overrides = [
    { index: 0, title: '【我改的】第一步：定范围', description: '自定义描述甲' },
    { index: 2, title: '【我改的】第三步：收尾', description: '自定义描述乙' },
  ];
  const { tasks } = confirmDecomposition(db, preview.preview_token, { acceptedDrafts: overrides });

  assert.equal(tasks.length, 2, 'only the selected indexes are created');
  assert.equal(tasks[0].title, '【我改的】第一步：定范围');
  assert.equal(tasks[0].description, '自定义描述甲');
  assert.equal(tasks[1].title, '【我改的】第三步：收尾');
  assert.equal(tasks[1].description, '自定义描述乙');
});

test('UX-09: a blank override description falls back to the stored draft description', () => {
  const { db, goal } = setup();
  const preview = previewDecomposition(db, goal.id);
  const original = preview.drafts[1];

  const { tasks } = confirmDecomposition(db, preview.preview_token, {
    acceptedDrafts: [{ index: 1, title: 'Renamed step', description: null }],
  });

  assert.equal(tasks[0].title, 'Renamed step');
  assert.equal(tasks[0].description, original.description, 'null override keeps the stored description');
});

test('UX-09: legacy acceptedTitles still selects by original title (agent surface)', () => {
  const { db, goal } = setup();
  const preview = previewDecomposition(db, goal.id);
  const keep = preview.drafts[0].title;

  const { tasks } = confirmDecomposition(db, preview.preview_token, { acceptedTitles: [keep] });
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].title, keep);
});

test('UX-09: no options at all creates every draft (agent confirm path)', () => {
  const { db, goal } = setup();
  const preview = previewDecomposition(db, goal.id);
  const { tasks } = confirmDecomposition(db, preview.preview_token);
  assert.equal(tasks.length, preview.drafts.length);
});

test('UX-09: an out-of-range override index is rejected before anything is written', () => {
  const { db, goal } = setup();
  const preview = previewDecomposition(db, goal.id);
  assert.throws(() =>
    confirmDecomposition(db, preview.preview_token, {
      acceptedDrafts: [{ index: 99, title: 'nope', description: null }],
    }),
  );
  // Token must still be fresh (nothing was consumed), so the failure rolled back.
  const { tasks } = confirmDecomposition(db, preview.preview_token);
  assert.equal(tasks.length, preview.drafts.length);
});

test('UX-09: a consumed token cannot be confirmed twice', () => {
  const { db, goal } = setup();
  const preview = previewDecomposition(db, goal.id);
  confirmDecomposition(db, preview.preview_token);
  assert.throws(() => confirmDecomposition(db, preview.preview_token));
});
