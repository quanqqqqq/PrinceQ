/**
 * 复评五条路由的隔离全链路测试：创建 → 列表 → 建议 → 确认。
 *
 * 走 `buildRouter(() => db)`，所以路由解析、zod 校验、service 与幂等都是真的，
 * 只有 HTTP 传输被省掉。数据库是一次性内存库，habits 指向临时目录——用户真实的
 * `data/work-queue.db` 与 `habits/` 永不被触碰。
 *
 * `rescoring_requests` 这张表在每个用例里由 `migrateRescoringSchema(db)` 显式建出。
 * 运行时主库不建表（见 `server/repo/rescoring-service.ts` 文件头），这也正是本文件
 * 必须自己建表的原因。
 *
 * 这里最该守住的一条：**只有 confirm 会改 `tasks` 的分数。** 建议提交之后、用户确认
 * 之前，任务行必须纹丝不动。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, withTempHabits } from './helpers.ts';
import type { Db } from '../server/db/connection.ts';
import { buildRouter } from '../server/http/routes.ts';
import { migrateRescoringSchema } from '../server/repo/rescoring-service.ts';
import { ApiError } from '../server/lib/errors.ts';
import type {
  OperationRecord,
  Quadrant,
  RescoringAxis,
  RescoringRequestWithContext,
  Task,
} from '../shared/types.ts';

withTempHabits();

type Router = ReturnType<typeof buildRouter>;

function setup(): { db: Db; router: Router } {
  const db = freshDb();
  // 本轮不碰主库的启动迁移，表只在这里按需建出来。
  migrateRescoringSchema(db);
  return { db, router: buildRouter(() => db) };
}

let keyCounter = 0;
const nextKey = (): string => `resc-http-${(keyCounter += 1)}`;

/** 按真实路径调用一条路由；`ctx` 只给对应 handler 实际会读的字段。 */
async function callRoute<T>(
  router: Router,
  method: 'GET' | 'POST',
  pathname: string,
  init: { body?: unknown; idempotencyKey?: string; search?: string } = {},
): Promise<T> {
  const match = router.match(method, pathname);
  assert.ok(match, `route ${method} ${pathname} must exist`);
  const url = new URL(`http://local${pathname}${init.search ?? ''}`);
  return (await match.handler({
    url,
    params: match.params,
    body: init.body,
    idempotencyKey: init.idempotencyKey ?? null,
  } as never)) as T;
}

/** 一个有真实两轴分数的任务：重要 80 / 紧急 30 → q2。 */
const createScoredTask = (router: Router, title: string) =>
  callRoute<{ task: Task }>(router, 'POST', '/api/tasks', {
    body: {
      title,
      matrix_score: {
        importance_score: 80,
        urgency_score: 30,
        reason: '影响季度目标，但没有近期截止时间。',
        source: 'agent',
        confidence: 0.7,
      },
    },
    idempotencyKey: nextKey(),
  });

const createRequest = (router: Router, taskId: string, body: Record<string, unknown>) =>
  callRoute<{ request: RescoringRequestWithContext; operation: OperationRecord; replayed: boolean }>(
    router,
    'POST',
    `/api/tasks/${taskId}/rescoring-request`,
    { body, idempotencyKey: nextKey() },
  );

const listRequests = (router: Router, search = '') =>
  callRoute<{ requests: RescoringRequestWithContext[] }>(
    router,
    'GET',
    '/api/rescoring-requests',
    { search },
  );

const submit = (router: Router, requestId: string, body: Record<string, unknown>) =>
  callRoute<{ request: RescoringRequestWithContext }>(
    router,
    'POST',
    `/api/rescoring-requests/${requestId}/submit`,
    { body, idempotencyKey: nextKey() },
  );

const confirm = (router: Router, requestId: string, key = nextKey()) =>
  callRoute<{
    task: Task;
    request: RescoringRequestWithContext;
    operation: OperationRecord | null;
    replayed: boolean;
  }>(router, 'POST', `/api/rescoring-requests/${requestId}/confirm`, {
    body: {},
    idempotencyKey: key,
  });

const getTask = (router: Router, taskId: string) =>
  callRoute<{ task: Task }>(router, 'GET', `/api/tasks/${taskId}`, {});

// ── 1. 发起：服务端派生 changed_axes，任务分数不动 ─────────────────────────────

test('POST /api/tasks/:id/rescoring-request 按目标象限派生要重评的轴，标 pending', async () => {
  const { router } = setup();
  const { task } = await createScoredTask(router, 'Draft the migration plan');

  // 80/30 是 q2（重要不紧急）。拖到 q3（不重要但紧急）要求两根轴都跨线。
  const { request } = await createRequest(router, task.id, { target_quadrant: 'q3' as Quadrant });

  assert.equal(request.status, 'pending');
  assert.equal(request.task_id, task.id);
  assert.equal(request.target_quadrant, 'q3');
  assert.deepEqual(
    request.changed_axes,
    ['importance', 'urgency'] as RescoringAxis[],
    'changed_axes 应由服务端从快照与目标象限派生，而不是客户端指定',
  );
  // 快照是请求创建那一刻的原值；此刻还没有任何建议。
  assert.equal(request.before_importance, 80);
  assert.equal(request.before_urgency, 30);
  assert.equal(request.after_importance, null, 'pending 阶段不该有任何建议分数');
  assert.equal(request.after_urgency, null);
  assert.equal(request.reason, null);
  assert.equal(request.agent_name, null);
  assert.equal(request.expected_version, task.version);

  // 发起请求绝不改任务。
  const after = await getTask(router, task.id);
  assert.equal(after.task.matrix_importance_score, 80);
  assert.equal(after.task.matrix_urgency_score, 30);
  assert.equal(after.task.version, task.version);
});

test('发起请求附带上下文：任务、目标、依赖、习惯摘要', async () => {
  const { router } = setup();
  const { task } = await createScoredTask(router, 'Review the vendor contract');

  const { request } = await createRequest(router, task.id, {
    changed_axes: ['urgency'] as RescoringAxis[],
  });

  assert.ok(request.context, '面板发起后要立刻渲染上下文，响应应顺手带上');
  assert.equal(request.context?.task.id, task.id);
  assert.deepEqual(request.context?.depends_on, []);
  assert.match(request.context?.habits_summary ?? '', /习惯/);
});

test('目标象限与轴都不给时返回 400', async () => {
  const { router } = setup();
  const { task } = await createScoredTask(router, 'Nothing to rescore');

  await assert.rejects(
    () => createRequest(router, task.id, {}),
    (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 400);
      return true;
    },
  );
});

// ── 2. 列表 ─────────────────────────────────────────────────────────────────

test('GET /api/rescoring-requests?status=pending 返回该请求', async () => {
  const { router } = setup();
  const { task } = await createScoredTask(router, 'Prepare the quarterly review');
  const { request } = await createRequest(router, task.id, { target_quadrant: 'q3' as Quadrant });

  const pending = await listRequests(router, '?status=pending');
  assert.ok(
    pending.requests.some((item) => item.id === request.id),
    'pending 过滤应包含刚创建的请求',
  );

  // 状态过滤是真的在过滤，而不是忽略参数后返回全部。
  const done = await listRequests(router, '?status=done');
  assert.equal(
    done.requests.some((item) => item.id === request.id),
    false,
    '刚创建的请求不该出现在 done 列表里',
  );

  // 不带过滤时同样能看到。
  const everything = await listRequests(router);
  assert.ok(everything.requests.some((item) => item.id === request.id));
});

test('未知的 status 值被 zod 拒绝为 400', async () => {
  const { router } = setup();
  await assert.rejects(
    () => listRequests(router, '?status=not-a-status'),
    (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 400);
      return true;
    },
  );
});

// ── 3. 建议：标 awaiting_confirm，但 tasks 一个字节都不动 ──────────────────────

test('POST /submit 记录建议并标 awaiting_confirm，此时任务分数仍未变', async () => {
  const { router } = setup();
  const { task } = await createScoredTask(router, 'Reply to the renewal email');
  // 只请求重要轴：紧急轴应逐位保留 30。
  const { request } = await createRequest(router, task.id, {
    changed_axes: ['importance'] as RescoringAxis[],
  });

  const submitted = await submit(router, request.id, {
    importance_score: 72,
    reason: '季度目标影响重估',
    agent_name: '外部Agent',
  });

  assert.equal(submitted.request.status, 'awaiting_confirm');
  assert.equal(submitted.request.after_importance, 72);
  assert.equal(submitted.request.after_urgency, 30, '未被请求的轴应原样保留');
  assert.equal(submitted.request.reason, '季度目标影响重估');
  assert.equal(submitted.request.agent_name, '外部Agent');
  assert.ok(submitted.request.submitted_at, 'submitted_at 应被写上');

  // 红线：用户确认之前，库里的分数纹丝不动。
  const after = await getTask(router, task.id);
  assert.equal(after.task.matrix_importance_score, 80, '确认前任务的重要分不该改变');
  assert.equal(after.task.matrix_urgency_score, 30);
  assert.equal(after.task.quadrant, 'q2');
  assert.equal(after.task.version, task.version, '确认前任务版本不该提升');
});

// ── 4. 确认：唯一写分数的一步，且幂等 ────────────────────────────────────────

test('POST /confirm 落库分数、派生象限、标记已确认；重复确认幂等', async () => {
  const { router } = setup();
  const { task } = await createScoredTask(router, 'Ship the billing fix');
  const { request } = await createRequest(router, task.id, {
    changed_axes: ['importance'] as RescoringAxis[],
  });
  await submit(router, request.id, {
    importance_score: 20,
    reason: '目标已调整，这件事不再关键',
    confidence: 0.8,
    agent_name: '外部Agent',
  });

  const key = nextKey();
  const confirmed = await confirm(router, request.id, key);

  assert.equal(confirmed.request.status, 'done');
  assert.equal(confirmed.task.matrix_importance_score, 20);
  assert.equal(confirmed.task.matrix_urgency_score, 30, '未被请求的轴保留原值');
  // 象限由两轴分数派生：20/30 两边都低 → q4。
  assert.equal(confirmed.task.quadrant, 'q4');
  assert.equal(confirmed.task.quadrant_confirmed, true);
  assert.equal(confirmed.task.matrix_score_source, 'agent');
  assert.equal(confirmed.task.matrix_score_confidence, 0.8);
  assert.ok(confirmed.operation, 'confirm 应回传它自己那条操作记录');
  assert.equal(confirmed.operation?.operation_type, 'task.matrix.rescore.confirm');
  assert.equal(confirmed.replayed, false);

  const versionAfterConfirm = confirmed.task.version;
  const scoreVersionAfterConfirm = confirmed.task.matrix_score_version;

  // 同一个幂等键重放：返回上次结果，不再加分、不再提版本号。
  const replay = await confirm(router, request.id, key);
  assert.equal(replay.replayed, true, '同一幂等键应被识别为重放');
  assert.equal(replay.task.matrix_importance_score, 20);
  assert.equal(replay.task.version, versionAfterConfirm, '重放不该再提升任务版本');
  assert.equal(
    replay.task.matrix_score_version,
    scoreVersionAfterConfirm,
    '重放不该再提升评分版本',
  );

  const reread = await getTask(router, task.id);
  assert.equal(reread.task.matrix_importance_score, 20);
  assert.equal(reread.task.version, versionAfterConfirm);
});

test('换一个幂等键再确认已 done 的请求会被拒绝，分数不再变动', async () => {
  const { router } = setup();
  const { task } = await createScoredTask(router, 'Write the postmortem');
  const { request } = await createRequest(router, task.id, {
    changed_axes: ['importance'] as RescoringAxis[],
  });
  await submit(router, request.id, {
    importance_score: 35,
    reason: '降级为普通跟进事项',
    agent_name: '外部Agent',
  });
  const confirmed = await confirm(router, request.id);

  // 不同的键绕不过状态校验——这是防并发双写的那一层。
  await assert.rejects(
    () => confirm(router, request.id),
    (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 409);
      return true;
    },
  );

  const reread = await getTask(router, task.id);
  assert.equal(reread.task.matrix_importance_score, 35);
  assert.equal(reread.task.version, confirmed.task.version, '被拒的确认不该改动任务');
});

// ── 5. 越界轴：未请求的轴给了不同值 → 400 ────────────────────────────────────

test('POST /submit 给未请求的轴提交不同值时返回 400，请求仍停在 pending', async () => {
  const { router } = setup();
  const { task } = await createScoredTask(router, 'Fix the flaky test');
  // 只请求重要轴。
  const { request } = await createRequest(router, task.id, {
    changed_axes: ['importance'] as RescoringAxis[],
  });

  await assert.rejects(
    () =>
      submit(router, request.id, {
        importance_score: 60,
        // 越界：紧急轴没被请求，却给了与快照（30）不同的值。
        urgency_score: 90,
        reason: '顺手把紧急度也改了',
        agent_name: '外部Agent',
      }),
    (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 400);
      assert.match(error.message, /未请求修改的轴/);
      return true;
    },
  );

  // 整次提交被拒：请求没前进，任务也没动。
  const [still] = (await listRequests(router, '?status=pending')).requests.filter(
    (item) => item.id === request.id,
  );
  assert.ok(still, '被拒的提交不该改变请求状态');
  assert.equal(still.status, 'pending');
  assert.equal(still.after_importance, null, '被拒的提交不该写入任何建议分数');

  const after = await getTask(router, task.id);
  assert.equal(after.task.matrix_importance_score, 80);
  assert.equal(after.task.matrix_urgency_score, 30);
});

test('被请求的轴漏给分数时返回 400', async () => {
  const { router } = setup();
  const { task } = await createScoredTask(router, 'Plan the offsite');
  const { request } = await createRequest(router, task.id, {
    changed_axes: ['importance'] as RescoringAxis[],
  });

  await assert.rejects(
    () => submit(router, request.id, { reason: '忘了给分', agent_name: '外部Agent' }),
    (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 400);
      return true;
    },
  );
});

// ── 6. 取消：只标状态 ───────────────────────────────────────────────────────

test('POST /cancel 标 cancelled，tasks 不动，且不能再提交建议', async () => {
  const { router } = setup();
  const { task } = await createScoredTask(router, 'Archive the old docs');
  const { request } = await createRequest(router, task.id, {
    changed_axes: ['urgency'] as RescoringAxis[],
  });

  const cancelled = await callRoute<{ request: RescoringRequestWithContext }>(
    router,
    'POST',
    `/api/rescoring-requests/${request.id}/cancel`,
    { body: {}, idempotencyKey: nextKey() },
  );
  assert.equal(cancelled.request.status, 'cancelled');
  assert.ok(cancelled.request.decided_at);

  const after = await getTask(router, task.id);
  assert.equal(after.task.matrix_importance_score, 80);
  assert.equal(after.task.matrix_urgency_score, 30);
  assert.equal(after.task.version, task.version);

  // 取消之后这条请求就终结了。
  await assert.rejects(
    () =>
      submit(router, request.id, {
        urgency_score: 70,
        reason: '取消之后又想改',
        agent_name: '外部Agent',
      }),
    (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 409);
      return true;
    },
  );
});
