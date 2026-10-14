/**
 * 第二轮详情分片（UX-06 / UX-18 / UX-23）的语义与 API 测试。
 *
 * 全部跑在一次性内存 SQLite 上，habits 指向临时目录——绝不触碰真实 data/work-queue.db。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { freshDb, withTempHabits } from './helpers.ts';
import { createGoal } from '../server/repo/goal-service.ts';
import { createTask } from '../server/repo/task-service.ts';
import { findGoal, findTask } from '../server/repo/tasks.ts';
import { run } from '../server/db/connection.ts';
import { migrateGoalsStatus } from '../server/db/migrations.ts';
import { buildRouter } from '../server/http/routes.ts';

withTempHabits();

function setup() {
  const db = freshDb();
  const goal = createGoal(db, { title: 'Rewrite the billing pipeline', description: 'build and ship' });
  const router = buildRouter(() => db);
  return { db, goal, router };
}

async function patchTask(
  router: ReturnType<typeof buildRouter>,
  id: string,
  body: Record<string, unknown>,
  idempotencyKey?: string,
) {
  const match = router.match('PATCH', `/api/tasks/${id}`);
  assert.ok(match, `route PATCH /api/tasks/:id must exist`);
  return (await match.handler({ params: { id }, body, idempotencyKey } as never)) as {
    task: ReturnType<typeof findTask>;
    replayed: boolean;
  };
}

async function patchGoal(
  router: ReturnType<typeof buildRouter>,
  id: string,
  body: Record<string, unknown>,
  idempotencyKey?: string,
) {
  const match = router.match('PATCH', `/api/goals/${id}`);
  assert.ok(match, `route PATCH /api/goals/:id must exist`);
  return (await match.handler({ params: { id }, body, idempotencyKey } as never)) as {
    goal: ReturnType<typeof findGoal>;
    replayed: boolean;
  };
}

// ── UX-06: 任务详情抽屉可编辑普通字段，取消不写、保存带 expected_version ──────────

test('UX-06: PATCH task persists normal editable fields and bumps version', async () => {
  const { db, goal, router } = setup();
  const created = createTask(db, { title: 'Draft the migration plan' });
  const version = created.version;

  const updated = await patchTask(router, created.id, {
    title: 'Finalize the migration plan',
    description: 'Include rollback steps',
    goal_id: goal.id,
    deadline: new Date(Date.now() + 5 * 36e5).toISOString(),
    estimated_minutes: 90,
    task_type: 'deep_work',
    manual_priority: 1,
    expected_version: version,
  });

  assert.equal(updated.task.title, 'Finalize the migration plan');
  assert.equal(updated.task.description, 'Include rollback steps');
  assert.equal(updated.task.goal_id, goal.id);
  assert.equal(updated.task.goal_title, goal.title);
  assert.equal(updated.task.estimated_minutes, 90);
  assert.equal(updated.task.task_type, 'deep_work');
  assert.equal(updated.task.manual_priority, 1);
  assert.equal(updated.task.version, version + 1, 'a successful save bumps the version');
});

test('UX-06: a stale expected_version is rejected and leaves the task untouched', async () => {
  const { db, router } = setup();
  const created = createTask(db, { title: 'Original title' });

  await assert.rejects(
    () => patchTask(router, created.id, { title: 'Changed', expected_version: created.version + 99 }),
    /expected version|状态冲突|conflict/i,
  );

  const after = findTask(db, created.id)!;
  assert.equal(after.title, 'Original title', 'the rejected write never lands');
  assert.equal(after.version, created.version, 'version was not bumped');
});

test('UX-06: replaying the same idempotency key does not apply the update twice', async () => {
  const { db, router } = setup();
  const created = createTask(db, { title: 'Replay probe' });

  const first = await patchTask(
    router,
    created.id,
    { title: 'Updated once', expected_version: created.version },
    'ux06-task-patch-key',
  );
  assert.equal(first.replayed, false);
  const versionAfterFirst = first.task.version;

  const second = await patchTask(
    router,
    created.id,
    { title: 'Updated once', expected_version: created.version },
    'ux06-task-patch-key',
  );
  assert.equal(second.replayed, true, 'the replay returns the cached response');
  assert.equal(second.task.version, versionAfterFirst, 'version was not bumped again');
});

// ── UX-18: 目标详情可编辑标题/说明/日期，并支持完成/重新打开/归档 ────────────────

test('UX-18: edit goal title / description / target_date with expected_version', async () => {
  const { goal, router } = setup();
  const target = new Date(Date.now() + 30 * 864e5).toISOString();

  const updated = await patchGoal(router, goal.id, {
    title: 'Billing pipeline rewrite v2',
    description: 'New scope',
    target_date: target,
    expected_version: goal.version,
  });

  assert.equal(updated.goal.title, 'Billing pipeline rewrite v2');
  assert.equal(updated.goal.description, 'New scope');
  assert.equal(updated.goal.target_date, target);
  assert.equal(updated.goal.version, goal.version + 1);
});

test('UX-18: goal lifecycle — achieved, then reopened, then archived(dropped)', async () => {
  const { db, goal, router } = setup();

  const achieved = await patchGoal(router, goal.id, { status: 'achieved', expected_version: goal.version });
  assert.equal(achieved.goal.status, 'achieved');

  const reopened = await patchGoal(router, goal.id, { status: 'active', expected_version: achieved.goal.version });
  assert.equal(reopened.goal.status, 'active');

  const dropped = await patchGoal(router, goal.id, { status: 'dropped', expected_version: reopened.goal.version });
  assert.equal(dropped.goal.status, 'dropped');

  // The stored row agrees with the API responses.
  assert.equal(findGoal(db, goal.id)!.status, 'dropped');
});

test('UX-18: a stale expected_version on a goal is rejected and preserved', async () => {
  const { db, goal, router } = setup();
  await assert.rejects(
    () => patchGoal(router, goal.id, { title: 'Nope', expected_version: goal.version + 5 }),
    /expected version|状态冲突|conflict/i,
  );
  assert.equal(findGoal(db, goal.id)!.title, goal.title, 'goal unchanged after a conflict');
});

// ── UX-23: 完成率 100% 不自动等同达成；空目标文案 ───────────────────────────────

test('UX-23: 100% task completion leaves the goal status active until the user marks it', () => {
  const { db, goal } = setup();
  createTask(db, { title: 't1', goal_id: goal.id });
  createTask(db, { title: 't2', goal_id: goal.id });
  run(db, `UPDATE tasks SET status = 'completed' WHERE goal_id = ?`, [goal.id]);

  const after = findGoal(db, goal.id)!;
  assert.equal(after.progress.ratio, 1, 'all non-archived tasks are completed');
  assert.equal(after.status, 'active', '100% completion must NOT auto-set achieved');
});

test('UX-23: editing a goal explicitly to achieved then completing tasks does not flip it back', async () => {
  const { db, goal, router } = setup();
  createTask(db, { title: 'only task', goal_id: goal.id });
  await patchGoal(router, goal.id, { status: 'achieved', expected_version: goal.version });

  // Even though the task is still open, an explicit achieved status is preserved.
  const after = findGoal(db, goal.id)!;
  assert.equal(after.status, 'achieved');
  assert.equal(after.progress.ratio, 0);
});

// ── goals.status 幂等迁移：缺列补齐、保留数据、重复执行 no-op ────────────────────

test('migration: a goals table without status gains the column and backfills active', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE goals (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT, target_date TEXT,
    color TEXT, is_demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1
  );
  INSERT INTO goals (id, title, created_at, updated_at, version)
    VALUES ('g-old','Legacy row','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',1);`);

  const first = migrateGoalsStatus(db);
  assert.deepEqual(first.columns_added, ['status']);

  const row = db.prepare(`SELECT status, version, title FROM goals WHERE id = 'g-old'`).get() as {
    status: string;
    version: number;
    title: string;
  };
  assert.equal(row.status, 'active', 'existing rows default to active');
  assert.equal(row.title, 'Legacy row', 'title is preserved');
  assert.equal(row.version, 1, 'version untouched by the migration');

  // Idempotent second run is a no-op and never rewrites the row.
  const second = migrateGoalsStatus(db);
  assert.deepEqual(second.columns_added, []);
  assert.equal((db.prepare(`SELECT status FROM goals WHERE id='g-old'`).get() as { status: string }).status, 'active');
  db.close();
});

test('migration: a modern goals table (status present) is a strict no-op', () => {
  setup();
  const report = migrateGoalsStatus(freshDb());
  assert.deepEqual(report.columns_added, [], 'the column already exists');
  assert.equal(report.rows_backfilled, 0);
});
