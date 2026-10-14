/**
 * 任务耗时「数值 + 单位（分钟/天/月）」与个人换算配置的隔离测试。
 *
 * 数据库是一次性内存库，habits 指向 `os.tmpdir()` 下的临时目录——用户真实的
 * `data/work-queue.db` 与 `habits/` 永不被触碰。因为 `server/config.ts` 在模块
 * 求值那一刻就把 `PWQ_HABITS_DIR` 读成常量，这里必须**先设环境变量、再动态
 * import** 服务端模块（静态 import 会被提升到赋值之前）。
 *
 * 这份测试要守住的几条：
 * - `estimated_minutes` 始终是唯一的耗时**事实**，排序只看它；`duration_value`
 *   / `duration_unit` 只是原始输入，供按原单位回显。
 * - 折算一律用**最新** habits 配置，不缓存：改完配置，下一个任务立刻按新数算。
 * - 旧数据（两列为 NULL）不回填、不批改；迁移只加列。
 * - `expected_version` 乐观并发、Idempotency-Key 幂等不因这轮改动退化。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pwq-duration-'));
// 必须早于 server/config.ts 第一次求值。
process.env.PWQ_HABITS_DIR = path.join(tempRoot, 'habits');
process.env.PWQ_DB_PATH = path.join(tempRoot, 'unused.db');

const { freshDb, emptyHabits, makeTask } = await import('./helpers.ts');
const { openDatabase } = await import('../server/db/connection.ts');
const { migrateTaskDurationColumns } = await import('../server/db/migrations.ts');
const { buildRouter } = await import('../server/http/routes.ts');
const { ApiError } = await import('../server/lib/errors.ts');
const { loadDurationConfig } = await import('../server/domain/habits.ts');
const { buildScoringContext, scoreTask } = await import('../server/domain/queue.ts');
const {
  DEFAULT_DURATION_CONFIG,
  durationToMinutes,
  formatDurationSummary,
} = await import('../shared/duration.ts');
import type { OperationRecord, Task } from '../shared/types.ts';
import type { Db } from '../server/db/connection.ts';

test.after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

type Router = ReturnType<typeof buildRouter>;

function setup(): { db: Db; router: Router } {
  const db = freshDb();
  return { db, router: buildRouter(() => db) };
}

let keyCounter = 0;
const nextKey = (): string => `duration-test-${(keyCounter += 1)}`;

/** 按真实路径调用一条路由；`ctx` 只给对应 handler 实际会读的字段。 */
async function callRoute<T>(
  router: Router,
  method: 'GET' | 'POST' | 'PATCH',
  pathname: string,
  init: { body?: unknown; idempotencyKey?: string } = {},
): Promise<T> {
  const match = router.match(method, pathname);
  assert.ok(match, `route ${method} ${pathname} must exist`);
  const url = new URL(`http://local${pathname}`);
  return (await match.handler({
    url,
    params: match.params,
    body: init.body,
    idempotencyKey: init.idempotencyKey ?? nextKey(),
  } as never)) as T;
}

/** 断言一次调用以指定 HTTP 状态失败，并把错误交回给调用方细查。 */
async function expectApiError(
  run: () => Promise<unknown>,
  status: number,
): Promise<InstanceType<typeof ApiError>> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof ApiError, `expected ApiError, got ${String(error)}`);
    assert.equal(error.status, status, `message was: ${error.message}`);
    return error;
  }
  return assert.fail(`expected the call to fail with ${status}`);
}

const createTask = (router: Router, body: Record<string, unknown>) =>
  callRoute<{ task: Task }>(router, 'POST', '/api/tasks', { body, idempotencyKey: nextKey() });

const patchTask = (router: Router, id: string, body: Record<string, unknown>) =>
  callRoute<{ task: Task }>(router, 'PATCH', `/api/tasks/${id}`, {
    body,
    idempotencyKey: nextKey(),
  });

const setPrefs = (router: Router, body: Record<string, unknown>) =>
  callRoute<{ prefs: { hours_per_day: number; days_per_month: number }; operation: OperationRecord }>(
    router,
    'POST',
    '/api/habits/duration-prefs',
    { body, idempotencyKey: nextKey() },
  );

/** 把换算配置恢复成默认值，避免用例之间互相污染（habits 目录是整个文件共享的）。 */
const resetPrefs = (router: Router) =>
  setPrefs(router, { hours_per_day: 8, days_per_month: 20 });

// ── 纯换算 ───────────────────────────────────────────────────────────────────

test('durationToMinutes：默认配置下 1 天 = 480 分钟、1 月 = 9600 分钟', () => {
  assert.equal(DEFAULT_DURATION_CONFIG.hours_per_day, 8);
  assert.equal(DEFAULT_DURATION_CONFIG.days_per_month, 20);

  assert.equal(durationToMinutes(45, 'minute'), 45);
  assert.equal(durationToMinutes(1, 'day'), 480);
  assert.equal(durationToMinutes(2, 'day'), 960);
  assert.equal(durationToMinutes(1, 'month'), 9600);
  assert.equal(durationToMinutes(0.5, 'day'), 240);
});

test('durationToMinutes：按自定义配置折算，结果取整到分钟', () => {
  const config = { hours_per_day: 6, days_per_month: 22 };
  assert.equal(durationToMinutes(1, 'day', config), 360);
  assert.equal(durationToMinutes(1, 'month', config), 7920);

  // 0.26 天 × 8 小时 × 60 = 124.8 → 125，分钟数永远是整数。
  assert.equal(durationToMinutes(0.26, 'day'), 125);
  assert.ok(Number.isInteger(durationToMinutes(1.37, 'month')));
});

test('durationToMinutes：非正数或非有限值一律抛错，不让它进库', () => {
  assert.throws(() => durationToMinutes(0, 'day'), /必须是正数/);
  assert.throws(() => durationToMinutes(-1, 'minute'), /必须是正数/);
  assert.throws(() => durationToMinutes(Number.NaN, 'day'), /必须是正数/);
});

test('formatDurationSummary：分钟不出摘要，天/月带上换算依据', () => {
  assert.equal(formatDurationSummary(45, 'minute'), '');
  const summary = formatDurationSummary(2, 'day');
  assert.match(summary, /2 天/);
  assert.match(summary, /960 分钟/);
  assert.match(summary, /8 小时\/天/);
  assert.match(summary, /20 天\/月/);
});

// ── 创建 ─────────────────────────────────────────────────────────────────────

test('创建：给了 duration_value + duration_unit 就落库换算后的分钟数，并留档原单位', async () => {
  const { router } = setup();
  await resetPrefs(router);

  const { task } = await createTask(router, {
    title: '写季度复盘',
    duration_value: 2,
    duration_unit: 'day',
  });

  assert.equal(task.estimated_minutes, 960, '2 天 × 8 小时 × 60 = 960 分钟');
  assert.equal(task.duration_value, 2);
  assert.equal(task.duration_unit, 'day');

  // 读回来两列都还在，前端才能按原单位回显。
  const read = await callRoute<{ task: Task }>(router, 'GET', `/api/tasks/${task.id}`);
  assert.equal(read.task.estimated_minutes, 960);
  assert.equal(read.task.duration_value, 2);
  assert.equal(read.task.duration_unit, 'day');
});

test('创建：只给旧字段 estimated_minutes 时，耗时两列保持 NULL', async () => {
  const { router } = setup();

  const { task } = await createTask(router, { title: '回封邮件', estimated_minutes: 45 });

  assert.equal(task.estimated_minutes, 45);
  assert.equal(task.duration_value, null, '旧字段不该凭空编出一个原单位');
  assert.equal(task.duration_unit, null);
});

test('创建：同时给新旧字段时以「数值 + 单位」的换算结果为准', async () => {
  const { router } = setup();
  await resetPrefs(router);

  const { task } = await createTask(router, {
    title: '两种写法一起来',
    estimated_minutes: 30,
    duration_value: 1,
    duration_unit: 'day',
  });

  assert.equal(task.estimated_minutes, 480);
  assert.equal(task.duration_value, 1);
  assert.equal(task.duration_unit, 'day');
});

test('创建：缺一半的耗时输入是 400，不是悄悄补一个默认单位', async () => {
  const { router } = setup();

  await expectApiError(() => createTask(router, { title: '只有数值', duration_value: 2 }), 400);
  await expectApiError(
    () => createTask(router, { title: '只有单位', duration_unit: 'day' }),
    400,
  );
  await expectApiError(
    () => createTask(router, { title: '非法单位', duration_value: 2, duration_unit: 'week' }),
    400,
  );
  await expectApiError(
    () => createTask(router, { title: '非正数值', duration_value: 0, duration_unit: 'day' }),
    400,
  );
});

// ── 更新 ─────────────────────────────────────────────────────────────────────

test('更新：改单位会按最新配置重算 estimated_minutes', async () => {
  const { router } = setup();
  await resetPrefs(router);

  const { task } = await createTask(router, {
    title: '搬迁文档',
    duration_value: 2,
    duration_unit: 'day',
  });
  assert.equal(task.estimated_minutes, 960);

  const updated = await patchTask(router, task.id, {
    duration_value: 1,
    duration_unit: 'month',
    expected_version: task.version,
  });

  assert.equal(updated.task.estimated_minutes, 9600, '1 月 × 20 天 × 8 小时 × 60');
  assert.equal(updated.task.duration_value, 1);
  assert.equal(updated.task.duration_unit, 'month');
  assert.equal(updated.task.version, task.version + 1);
});

test('更新：耗时写入不绕过 expected_version 乐观并发', async () => {
  const { router } = setup();
  await resetPrefs(router);

  const { task } = await createTask(router, {
    title: '并发检查',
    duration_value: 1,
    duration_unit: 'day',
  });
  const first = await patchTask(router, task.id, {
    duration_value: 3,
    duration_unit: 'day',
    expected_version: task.version,
  });
  assert.equal(first.task.estimated_minutes, 1440);

  // 拿着过期版本号再写一次：409，且任务一字未改。
  const error = await expectApiError(
    () =>
      patchTask(router, task.id, {
        duration_value: 99,
        duration_unit: 'day',
        expected_version: task.version,
      }),
    409,
  );
  assert.match(error.message, /modified by someone else/);

  const read = await callRoute<{ task: Task }>(router, 'GET', `/api/tasks/${task.id}`);
  assert.equal(read.task.estimated_minutes, 1440);
  assert.equal(read.task.duration_value, 3);
  assert.equal(read.task.version, first.task.version);
});

test('更新：duration_value 置空会把三列一起清掉', async () => {
  const { router } = setup();
  await resetPrefs(router);

  const { task } = await createTask(router, {
    title: '先填后清',
    duration_value: 2,
    duration_unit: 'day',
  });
  const cleared = await patchTask(router, task.id, {
    duration_value: null,
    duration_unit: null,
    expected_version: task.version,
  });

  assert.equal(cleared.task.estimated_minutes, null);
  assert.equal(cleared.task.duration_value, null);
  assert.equal(cleared.task.duration_unit, null);
});

test('更新：清空时还指定单位是 400，避免「有单位没数值」的半截状态', async () => {
  const { router } = setup();
  await resetPrefs(router);

  const { task } = await createTask(router, {
    title: '半截输入',
    duration_value: 2,
    duration_unit: 'day',
  });

  await expectApiError(
    () => patchTask(router, task.id, { duration_value: null, duration_unit: 'day' }),
    400,
  );
  await expectApiError(() => patchTask(router, task.id, { duration_value: 5 }), 400);
});

test('更新：只改旧字段 estimated_minutes 时不动原单位两列', async () => {
  const { router } = setup();
  await resetPrefs(router);

  const { task } = await createTask(router, {
    title: '旧客户端只会发分钟',
    duration_value: 2,
    duration_unit: 'day',
  });
  const updated = await patchTask(router, task.id, {
    estimated_minutes: 30,
    expected_version: task.version,
  });

  assert.equal(updated.task.estimated_minutes, 30, '旧字段照旧直接写分钟');
  assert.equal(updated.task.duration_value, 2, '没人让它清，就不该被悄悄抹掉');
  assert.equal(updated.task.duration_unit, 'day');
});

// ── 换算配置 ─────────────────────────────────────────────────────────────────

test('换算配置：改完立刻生效，折算不缓存', async () => {
  const { router } = setup();
  await resetPrefs(router);

  const before = await createTask(router, {
    title: '改配置之前',
    duration_value: 1,
    duration_unit: 'day',
  });
  assert.equal(before.task.estimated_minutes, 480);

  const { prefs } = await setPrefs(router, { hours_per_day: 4, days_per_month: 22 });
  assert.deepEqual(prefs, { hours_per_day: 4, days_per_month: 22 });
  assert.deepEqual(loadDurationConfig(), { hours_per_day: 4, days_per_month: 22 });

  const afterDay = await createTask(router, {
    title: '改配置之后（天）',
    duration_value: 1,
    duration_unit: 'day',
  });
  assert.equal(afterDay.task.estimated_minutes, 240, '1 天 × 4 小时 × 60');

  const afterMonth = await createTask(router, {
    title: '改配置之后（月）',
    duration_value: 1,
    duration_unit: 'month',
  });
  assert.equal(afterMonth.task.estimated_minutes, 5280, '1 月 × 22 天 × 4 小时 × 60');

  // 已落库的分钟数是写入当时的事实：不回算、不批改。
  const read = await callRoute<{ task: Task }>(router, 'GET', `/api/tasks/${before.task.id}`);
  assert.equal(read.task.estimated_minutes, 480);
  assert.equal(read.task.version, before.task.version);

  await resetPrefs(router);
});

test('换算配置：超出合理区间一律 400', async () => {
  const { router } = setup();
  await resetPrefs(router);

  await expectApiError(() => setPrefs(router, { hours_per_day: 0.1 }), 400);
  await expectApiError(() => setPrefs(router, { hours_per_day: 30 }), 400);
  await expectApiError(() => setPrefs(router, { days_per_month: 0 }), 400);
  await expectApiError(() => setPrefs(router, { days_per_month: 40 }), 400);
  await expectApiError(() => setPrefs(router, {}), 400);

  // 一次都没写进去：配置还是默认值。
  assert.deepEqual(loadDurationConfig(), { hours_per_day: 8, days_per_month: 20 });
});

test('换算配置：边界值可用，单改一个键不动另一个', async () => {
  const { router } = setup();
  await resetPrefs(router);

  const low = await setPrefs(router, { hours_per_day: 0.5 });
  assert.deepEqual(low.prefs, { hours_per_day: 0.5, days_per_month: 20 });

  const high = await setPrefs(router, { days_per_month: 31 });
  assert.deepEqual(high.prefs, { hours_per_day: 0.5, days_per_month: 31 });

  await resetPrefs(router);
});

test('换算配置：走 withOperation，留下一条操作日志', async () => {
  const { router } = setup();
  const { operation } = await setPrefs(router, { hours_per_day: 7 });

  assert.equal(operation.operation_type, 'habit.duration_prefs.update');
  assert.equal(operation.target_type, 'habit');
  assert.equal(operation.target_id, 'weights');
  assert.match(operation.summary, /7 小时\/天/);

  await resetPrefs(router);
});

test('换算配置：同一个 Idempotency-Key 重放不会写第二遍', async () => {
  const { router } = setup();
  await resetPrefs(router);
  const key = nextKey();

  const first = await callRoute<{ prefs: { hours_per_day: number }; operation: OperationRecord }>(
    router,
    'POST',
    '/api/habits/duration-prefs',
    { body: { hours_per_day: 6 }, idempotencyKey: key },
  );
  assert.equal(first.prefs.hours_per_day, 6);

  // 同键重放：返回首次结果，并且在这中间手动改掉的配置不会被覆盖回去。
  await setPrefs(router, { hours_per_day: 9 });
  const replay = await callRoute<{ prefs: { hours_per_day: number }; operation: OperationRecord }>(
    router,
    'POST',
    '/api/habits/duration-prefs',
    { body: { hours_per_day: 6 }, idempotencyKey: key },
  );
  assert.equal(replay.operation.replayed, true);
  assert.equal(loadDurationConfig().hours_per_day, 9, '重放不该再写一次文件');

  await resetPrefs(router);
});

// ── 排序：事实不变，只有说明文案带上原单位 ───────────────────────────────────

test('排序：原单位只影响 effort 的说明文案，分值逐字不变', () => {
  const minutesOnly = makeTask({ estimated_minutes: 960 });
  const withUnit = makeTask({ estimated_minutes: 960, duration_value: 2, duration_unit: 'day' });
  const habits = emptyHabits();
  const at = new Date('2026-03-01T09:00:00.000Z');

  const ctx = buildScoringContext([minutesOnly, withUnit], habits, at);
  const a = scoreTask(minutesOnly, ctx);
  const b = scoreTask(withUnit, ctx);

  assert.equal(a.score, b.score, '耗时事实相同，分值必须相同');

  const effortA = a.factors.find((f) => f.key === 'effort')!;
  const effortB = b.factors.find((f) => f.key === 'effort')!;
  assert.equal(effortA.value, effortB.value);
  assert.equal(effortA.contribution, effortB.contribution);
  assert.match(effortA.detail, /^960m —/);
  assert.match(effortB.detail, /^2 天 ≈ 960 分钟 —/);
});

// ── 迁移：只加列，绝不回填 ───────────────────────────────────────────────────

test('迁移：给旧库补齐两列，既不回填也不改任何行', () => {
  const legacy = openDatabase(':memory:');
  legacy.exec(
    `CREATE TABLE tasks (
       id TEXT PRIMARY KEY,
       title TEXT NOT NULL,
       estimated_minutes INTEGER
     )`,
  );
  legacy
    .prepare('INSERT INTO tasks (id, title, estimated_minutes) VALUES (?, ?, ?)')
    .run('task_legacy', '迁移前就存在的任务', 45);

  const report = migrateTaskDurationColumns(legacy);
  assert.deepEqual(report.columns_added, ['duration_value', 'duration_unit']);
  assert.equal(report.rows_backfilled, 0);

  const row = legacy.prepare('SELECT * FROM tasks WHERE id = ?').get('task_legacy') as {
    estimated_minutes: number;
    duration_value: number | null;
    duration_unit: string | null;
  };
  assert.equal(row.estimated_minutes, 45, '原有的分钟事实一字未动');
  assert.equal(row.duration_value, null, '旧任务的原单位就是「没有」，不许编一个');
  assert.equal(row.duration_unit, null);

  // 再跑一遍：幂等，什么都不加。
  const again = migrateTaskDurationColumns(legacy);
  assert.deepEqual(again.columns_added, []);
  assert.equal(again.rows_backfilled, 0);
  legacy.close();
});

test('迁移：schema.sql 建出来的新库已经有两列，迁移是空操作', () => {
  const { db } = setup();
  const report = migrateTaskDurationColumns(db);
  assert.deepEqual(report.columns_added, []);

  const columns = (db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map(
    (c) => c.name,
  );
  assert.ok(columns.includes('duration_value'));
  assert.ok(columns.includes('duration_unit'));
});
