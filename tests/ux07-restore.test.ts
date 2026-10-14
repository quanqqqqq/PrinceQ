/**
 * UX-07：归档可恢复。
 *
 * 覆盖：
 *  - 「全部任务 / 已归档」可访问视图能找回无目标、已完成、已归档任务；
 *  - 归档成功后可在合理时限内即时撤销（restore），把任务恢复到归档前状态；
 *  - 刷新后也能从已归档列表执行恢复；
 *  - 已归档详情复用统一抽屉并提供恢复；已完成任务可查看并重开；
 *  - API 支持显式 restore/reopen，带 expected_version 与幂等；
 *  - 归档/恢复保留同一 task id、目标关联、领取历史与操作记录。
 *
 * 全部跑在一次性内存 SQLite 上，habits 指向临时目录——绝不触碰真实 data/work-queue.db。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, withTempHabits } from './helpers.ts';
import { createGoal } from '../server/repo/goal-service.ts';
import { applyAction, createTask } from '../server/repo/task-service.ts';
import { findTask, listAssignments } from '../server/repo/tasks.ts';
import { listOperations } from '../server/repo/operations.ts';
import type { Db } from '../server/db/connection.ts';
import { buildRouter } from '../server/http/routes.ts';
import type { Task } from '../shared/types.ts';

withTempHabits();

function setup() {
  const db = freshDb();
  const goal = createGoal(db, { title: 'Ship the billing rewrite', description: 'q4' });
  const router = buildRouter(() => db);
  return { db, goal, router };
}

type Router = ReturnType<typeof buildRouter>;

async function taskAction(
  router: Router,
  id: string,
  body: Record<string, unknown>,
  idempotencyKey?: string,
) {
  const match = router.match('POST', `/api/tasks/${id}/actions`);
  assert.ok(match, `route POST /api/tasks/:id/actions must exist`);
  return (await match.handler({ params: { id }, body, idempotencyKey } as never)) as {
    task: Task;
    replayed: boolean;
    operation: { id: string; operation_type: string; target_id: string; detail: unknown };
  };
}

async function listTasks(router: Router, search = '') {
  const match = router.match('GET', '/api/tasks');
  assert.ok(match, `route GET /api/tasks must exist`);
  const url = new URL(`http://local/api/tasks${search}`);
  return (await match.handler({ url, params: {} } as never)) as { tasks: Task[] };
}

/** 一个任务的归档/恢复操作记录，按时间正序。 */
function opsFor(db: Db, taskId: string) {
  return listOperations(db, { limit: 200 })
    .filter((o) => o.target_id === taskId && /^task\.(archive|restore|complete|reopen)$/.test(o.operation_type))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/** 把任务推到「进行中且已被我领取」，再归档它。 */
async function claimStartAndArchive(router: Router, taskId: string, archiveKey: string) {
  await taskAction(router, taskId, { action: 'claim', actor_id: 'actor-human-me' }, 'ux07-claim');
  await taskAction(router, taskId, { action: 'start', actor_id: 'actor-human-me' }, 'ux07-start');
  return taskAction(router, taskId, { action: 'archive' }, archiveKey);
}

// ── 可访问视图：能找回无目标、已完成、已归档任务 ──────────────────────────────

test('UX-07: 不按状态过滤的列表返回全部任务（含无目标、已完成、已归档）', async () => {
  const { db, goal, router } = setup();
  createTask(db, { title: 'No-goal task' });
  createTask(db, { title: 'Linked active', goal_id: goal.id });
  const done = createTask(db, { title: 'Finished', goal_id: goal.id });
  const retired = createTask(db, { title: 'Retired', goal_id: goal.id });

  await taskAction(router, done.id, { action: 'claim', actor_id: 'actor-human-me' }, 'ux07-done-claim');
  await taskAction(router, done.id, { action: 'start', actor_id: 'actor-human-me' }, 'ux07-done-start');
  await taskAction(router, done.id, { action: 'complete', actor_id: 'actor-human-me' }, 'ux07-done-complete');
  await taskAction(router, retired.id, { action: 'archive' }, 'ux07-retired-archive');

  const all = await listTasks(router);
  const titles = all.tasks.map((t) => t.title);
  assert.ok(titles.includes('No-goal task'), '无目标任务在「全部」视图可见');
  assert.ok(titles.includes('Linked active'));
  assert.ok(titles.includes('Finished'), '已完成任务在「全部」视图可见');
  assert.ok(titles.includes('Retired'), '已归档任务在「全部」视图可见');
  assert.equal(all.tasks.length, 4);

  // 「已归档」筛选只返回归档任务。
  const archived = await listTasks(router, '?status=archived');
  assert.equal(archived.tasks.length, 1);
  assert.equal(archived.tasks[0].title, 'Retired');
  assert.equal(archived.tasks[0].status, 'archived');
});

// ── 即时撤销：归档后 restore 回到归档前状态，保留 id/目标/领取历史/操作记录 ─────

test('UX-07: restore 把「进行中且已领取」的任务恢复到进行中并重新激活领取', async () => {
  const { db, goal, router } = setup();
  const task = createTask(db, { title: 'Work in flight', goal_id: goal.id });
  const archived = await claimStartAndArchive(router, task.id, 'ux07-archive-flight');
  assert.equal(archived.task.status, 'archived');
  assert.equal(archived.task.active_assignment, null, '归档释放了领取');

  const restored = await taskAction(
    router,
    task.id,
    { action: 'restore', expected_version: archived.task.version },
    'ux07-restore-flight',
  );

  // 回到归档前状态：进行中，且原领取人重新持有领取。
  assert.equal(restored.task.status, 'in_progress');
  assert.ok(restored.task.started_at, '进行中保留 started_at');
  assert.equal(restored.task.active_assignment?.actor_id, 'actor-human-me', '原领取被重新激活');
  // 同一 task id、同一目标关联。
  assert.equal(restored.task.id, task.id);
  assert.equal(restored.task.goal_id, goal.id);

  // 领取历史行没有被删除：归档释放过一次，恢复又把它置为活跃，记录仍在。
  const assignments = listAssignments(db, task.id);
  assert.equal(assignments.length, 1, '领取历史行保留，未删除重建');
  assert.equal(assignments[0].released_at, null, '恢复后该领取重新活跃');
  assert.equal(assignments[0].actor_id, 'actor-human-me');

  // 操作记录里同时留下了归档与恢复两条。
  const ops = opsFor(db, task.id).map((o) => o.operation_type);
  assert.ok(ops.includes('task.archive'), '归档操作已记录');
  assert.ok(ops.includes('task.restore'), '恢复操作已记录');
});

test('UX-07: 归档一个已完成任务后 restore 回到「已完成」而不是掉回待处理', async () => {
  const { db, router } = setup();
  const task = createTask(db, { title: 'Done then filed' });
  await taskAction(router, task.id, { action: 'claim', actor_id: 'actor-human-me' }, 'ux07-df-claim');
  await taskAction(router, task.id, { action: 'start', actor_id: 'actor-human-me' }, 'ux07-df-start');
  const done = await taskAction(router, task.id, { action: 'complete', actor_id: 'actor-human-me' }, 'ux07-df-complete');
  assert.equal(done.task.status, 'completed');

  const filed = await taskAction(router, task.id, { action: 'archive' }, 'ux07-df-archive');
  assert.equal(filed.task.status, 'archived');

  const restored = await taskAction(router, task.id, { action: 'restore' }, 'ux07-df-restore');
  assert.equal(restored.task.status, 'completed', '归档前是已完成，恢复后仍是已完成');
  assert.ok(restored.task.completed_at, 'completed_at 保留');
  assert.ok(restored.task.started_at, 'started_at 在恢复到已完成时保留');

  // 直接用 applyAction 路径也跑通一次，覆盖 service 层直接调用。
  const direct = applyAction(db, task.id, { action: 'archive', actor_id: 'actor-human-me' });
  assert.equal(direct.status, 'archived');
  const restored2 = applyAction(db, task.id, { action: 'restore', actor_id: 'actor-human-me' });
  assert.equal(restored2.status, 'completed');
});

// ── expected_version 与幂等 ──────────────────────────────────────────────────

test('UX-07: 过期的 expected_version 被拒绝且不改变任务', async () => {
  const { db, router } = setup();
  const task = createTask(db, { title: 'Stale restore' });
  await taskAction(router, task.id, { action: 'archive' }, 'ux07-stale-archive');

  await assert.rejects(
    () => taskAction(router, task.id, { action: 'restore', expected_version: 9999 }, 'ux07-stale-restore'),
    /期望版本|其他写入修改|expected version|conflict/i,
  );

  const after = findTask(db, task.id)!;
  assert.equal(after.status, 'archived', '过期版本的恢复没有落地');
});

test('UX-07: 同一幂等键重复 restore 只生效一次', async () => {
  const { db, router } = setup();
  const task = createTask(db, { title: 'Idempotent restore' });
  await taskAction(router, task.id, { action: 'archive' }, 'ux07-idem-archive');

  const first = await taskAction(router, task.id, { action: 'restore' }, 'ux07-idem-key');
  assert.equal(first.replayed, false);
  const versionAfterFirst = first.task.version;

  const second = await taskAction(router, task.id, { action: 'restore' }, 'ux07-idem-key');
  assert.equal(second.replayed, true, '第二次命中幂等键缓存');
  assert.equal(second.task.version, versionAfterFirst, '版本没有再被推进');

  // 任务已经不在 archived，重复恢复也没有把它再次改写。
  assert.notEqual(findTask(db, task.id)!.status, 'archived');
});

// ── reopen：已完成任务可重开 ──────────────────────────────────────────────────

test('UX-07: completed 任务 reopen 回到 inbox，且 archived 不能再用 reopen', async () => {
  const { db, router } = setup();
  const task = createTask(db, { title: 'Reopen me' });
  await taskAction(router, task.id, { action: 'claim', actor_id: 'actor-human-me' }, 'ux07-ro-claim');
  await taskAction(router, task.id, { action: 'start', actor_id: 'actor-human-me' }, 'ux07-ro-start');
  await taskAction(router, task.id, { action: 'complete', actor_id: 'actor-human-me' }, 'ux07-ro-complete');

  const reopened = await taskAction(router, task.id, { action: 'reopen' }, 'ux07-ro-reopen');
  assert.equal(reopened.task.status, 'inbox');
  assert.equal(reopened.task.completed_at, null, '重开清空 completed_at');

  // archived 必须走 restore，而不是 reopen。
  const archived = await taskAction(router, task.id, { action: 'archive' }, 'ux07-ro-archive');
  assert.equal(archived.task.status, 'archived');
  await assert.rejects(
    () => taskAction(router, task.id, { action: 'reopen' }, 'ux07-ro-badreopen'),
    /reopen a task in status "archived"|Cannot reopen/i,
  );
});

// ── 守卫：非归档任务不能 restore；归档两次被拒绝 ───────────────────────────────

test('UX-07: 只有 archived 任务能 restore；归档两次被拒绝', async () => {
  const { db, router } = setup();
  const task = createTask(db, { title: 'Guarded' });

  await assert.rejects(
    () => taskAction(router, task.id, { action: 'restore' }, 'ux07-guard-restore'),
    /already inbox|Cannot restore/i,
  );

  const archived = await taskAction(router, task.id, { action: 'archive' }, 'ux07-guard-archive');
  await assert.rejects(
    () => taskAction(router, task.id, { action: 'archive' }, 'ux07-guard-archive2'),
    /Cannot archive a task in status "archived"/,
  );
  assert.equal(archived.task.status, 'archived');
});
