/**
 * UX-19: the activity timeline.
 *
 * Covers three layers:
 *  1. pure shared helpers — display grouping (normal activity vs queue recalc),
 *     openable object resolution (the "click to open task/goal" link target), and
 *     the querystring the view sends;
 *  2. `describeOperationChange` — the audit `detail` JSON translated into the
 *     business-level "字段：修改前 → 修改后" rows behind the 「变更详情」 layer;
 *  3. `describeQueueSnapshot` — the queue snapshot `reason` (really the raw event
 *     code written by `refreshQueue`) translated into the Chinese 「排序说明」;
 *  4. the activity API — query / type / from / to filters, zod validation and the
 *     limit boundary, exercised through the real HTTP layer against a temp DB.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { OperationRecord } from '../shared/types.ts';
import {
  activityTarget,
  buildActivityQuery,
  describeOperationChange,
  describeQueueSnapshot,
  groupOperationsByDay,
  isQueueRecalcOperation,
  splitOperations,
} from '../shared/activity.ts';

// ── 1. pure helpers ──────────────────────────────────────────────────────────

const op = (overrides: Partial<OperationRecord> = {}): OperationRecord => ({
  id: 'op_test',
  idempotency_key: 'key-test',
  operation_type: 'task.create',
  target_type: 'task',
  target_id: 'task_1',
  actor_id: 'actor-human-me',
  actor_name: 'Me',
  status: 'succeeded',
  summary: 'Created task "X"',
  detail: null,
  replayed: false,
  created_at: new Date().toISOString(),
  ...overrides,
});

test('isQueueRecalcOperation flags queue-targeted and queue.recalculate rows', () => {
  assert.equal(isQueueRecalcOperation(op({ target_type: 'queue', operation_type: 'queue.recalculate' })), true);
  assert.equal(isQueueRecalcOperation(op({ target_type: 'task', operation_type: 'queue.recalculate' })), true);
  assert.equal(isQueueRecalcOperation(op({ target_type: 'task', operation_type: 'task.complete' })), false);
});

test('splitOperations puts recalculation history on its own side', () => {
  const rows = [
    op({ id: 'a', operation_type: 'task.create', target_type: 'task' }),
    op({ id: 'b', operation_type: 'queue.recalculate', target_type: 'queue' }),
    op({ id: 'c', operation_type: 'goal.create', target_type: 'goal' }),
  ];
  const { activities, recalc } = splitOperations(rows);
  assert.deepEqual(activities.map((o) => o.id), ['a', 'c']);
  assert.deepEqual(recalc.map((o) => o.id), ['b']);
});

test('activityTarget resolves task / goal links and otherwise none', () => {
  assert.deepEqual(activityTarget(op({ target_type: 'task', target_id: 'task_9' })), {
    kind: 'task',
    id: 'task_9',
  });
  assert.deepEqual(activityTarget(op({ target_type: 'goal', target_id: 'goal_9' })), {
    kind: 'goal',
    id: 'goal_9',
  });
  assert.deepEqual(activityTarget(op({ target_type: 'queue', target_id: null })), {
    kind: 'none',
    id: null,
  });
  assert.deepEqual(activityTarget(op({ target_type: 'task', target_id: null })), {
    kind: 'none',
    id: null,
  });
});

test('buildActivityQuery omits empty values and defaults', () => {
  assert.equal(buildActivityQuery({}), '');
  const params = new URLSearchParams(
    buildActivityQuery({ query: '  Alpha ', type: 'task.create', limit: 50 }),
  );
  assert.equal(params.get('query'), 'Alpha');
  assert.equal(params.get('type'), 'task.create');
  assert.equal(params.get('limit'), '50');
});

test('groupOperationsByDay buckets newest-first rows by local day', () => {
  // Build timestamps from local calendar dates so the grouping assertion does not
  // depend on the machine timezone (UTC date boundaries shift with the offset).
  const rows = [
    op({ id: 'x1', created_at: new Date(2026, 0, 3, 10, 0).toISOString() }),
    op({ id: 'x2', created_at: new Date(2026, 0, 3, 22, 0).toISOString() }),
    op({ id: 'x3', created_at: new Date(2026, 0, 5, 9, 0).toISOString() }),
  ];
  const groups = groupOperationsByDay(rows);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].items.map((o) => o.id), ['x1', 'x2']);
  assert.deepEqual(groups[1].items.map((o) => o.id), ['x3']);
});

// ── 2. describeOperationChange：detail JSON → 业务字段前后对照 ────────────────

test('describeOperationChange: 状态流转给出 before / after', () => {
  const changes = describeOperationChange(
    op({ operation_type: 'task.complete', detail: { from: 'in_progress', to: 'completed' } }),
  );
  assert.deepEqual(changes, [
    { key: 'status', label: '状态', before: '进行中', after: '已完成' },
  ]);
});

test('describeOperationChange: 象限流转走象限映射而不是状态映射', () => {
  const changes = describeOperationChange(
    op({ operation_type: 'task.quadrant.change', detail: { from: 'q3', to: 'q1' } }),
  );
  assert.deepEqual(changes, [
    { key: 'quadrant', label: '象限', before: '不重要但紧急', after: '重要且紧急' },
  ]);
});

test('describeOperationChange: detail 里带 quadrant 键时也认成象限', () => {
  // 有些写入点把当前象限一并记进 detail，operation_type 里却没有 quadrant 字样。
  const changes = describeOperationChange(
    op({ operation_type: 'task.matrix.score', detail: { from: 'q4', to: 'q2', quadrant: 'q2' } }),
  );
  assert.equal(changes[0].label, '象限');
  assert.equal(changes[0].after, '重要不紧急');
});

test('describeOperationChange: fields 数组逐个成行，没有旧值', () => {
  const changes = describeOperationChange(
    op({ operation_type: 'task.update', detail: { fields: ['title', 'deadline', 'notes'] } }),
  );
  assert.deepEqual(changes, [
    { key: 'title', label: '标题', before: null, after: null },
    { key: 'deadline', label: '截止时间', before: null, after: null },
    { key: 'notes', label: '备注', before: null, after: null },
  ]);
});

test('describeOperationChange: 认不出的字段名原样显示，不显示成空白', () => {
  const changes = describeOperationChange(
    op({ operation_type: 'goal.update', detail: { fields: ['some_new_column'] } }),
  );
  assert.deepEqual(changes, [
    { key: 'some_new_column', label: 'some_new_column', before: null, after: null },
  ]);
});

test('describeOperationChange: 原因只有「修改后」一侧', () => {
  const changes = describeOperationChange(
    op({ operation_type: 'task.block', detail: { from: 'in_progress', to: 'blocked', reason: '等供应商回邮件' } }),
  );
  assert.deepEqual(changes, [
    { key: 'status', label: '状态', before: '进行中', after: '受阻' },
    { key: 'reason', label: '原因', before: null, after: '等供应商回邮件' },
  ]);
});

test('describeOperationChange: reason 为 null / 空串时不成行', () => {
  // 服务端在没有理由时写的是 `reason: null`，不该渲染出一个空的「原因：」。
  assert.deepEqual(
    describeOperationChange(
      op({ operation_type: 'task.start', detail: { from: 'claimed', to: 'in_progress', reason: null } }),
    ),
    [{ key: 'status', label: '状态', before: '已领取', after: '进行中' }],
  );
  assert.deepEqual(
    describeOperationChange(op({ operation_type: 'task.block', detail: { reason: '   ' } })),
    [],
  );
});

test('describeOperationChange: 两轴评分各自成行', () => {
  const changes = describeOperationChange(
    op({
      operation_type: 'task.matrix.score',
      detail: { importance_score: 82, urgency_score: 15 },
    }),
  );
  assert.deepEqual(changes, [
    { key: 'importance', label: '重要度', before: null, after: '82' },
    { key: 'urgency', label: '紧急度', before: null, after: '15' },
  ]);
  // 0 分是真实评分，不能被当成「没填」丢掉。
  assert.deepEqual(
    describeOperationChange(op({ detail: { importance_score: 0 } })),
    [{ key: 'importance', label: '重要度', before: null, after: '0' }],
  );
});

test('describeOperationChange: 拆分新建的任务数', () => {
  assert.deepEqual(
    describeOperationChange(
      op({ operation_type: 'goal.decomposition.confirm', detail: { task_ids: ['t1', 't2', 't3'] } }),
    ),
    [{ key: 'task_count', label: '新建任务', before: null, after: '3' }],
  );
});

test('describeOperationChange: 习惯类操作给出写了哪个文件', () => {
  assert.deepEqual(
    describeOperationChange(
      op({ operation_type: 'habit.add', detail: { file: 'habits/explicit.json' } }),
    ),
    [{ key: 'habit_file', label: '习惯文件', before: null, after: 'habits/explicit.json' }],
  );
});

test('describeOperationChange: 空 detail 与认不出的 detail 都返回空数组', () => {
  assert.deepEqual(describeOperationChange(op({ detail: null })), []);
  assert.deepEqual(describeOperationChange(op({ detail: {} })), []);
  // 这些键留给第二层「开发者信息」里的原始 JSON，不编成业务字段。
  assert.deepEqual(
    describeOperationChange(
      op({ detail: { source: 'agent', depends_on: 'task_7', score_source: 'agent' } }),
    ),
    [],
  );
});

// ── 3. describeQueueSnapshot：快照 reason（其实是事件码）→ 中文排序说明 ────────

test('describeQueueSnapshot: 手动一侧标 manual，并给出各自的中文说明', () => {
  assert.deepEqual(describeQueueSnapshot('seed'), {
    triggerLabel: '初始化示例数据时建立排序',
    manual: true,
  });
  assert.deepEqual(describeQueueSnapshot('manual-recalculate'), {
    triggerLabel: '你手动触发了重排',
    manual: true,
  });
  // 页面上的「重算」按钮写的是 queue.recalculate，也是用户自己按的。
  assert.deepEqual(describeQueueSnapshot('queue.recalculate'), {
    triggerLabel: '你手动触发了重排',
    manual: true,
  });
});

test('describeQueueSnapshot: 写操作触发的自动重排说清是哪个动作', () => {
  assert.deepEqual(describeQueueSnapshot('task.create'), {
    triggerLabel: '「创建任务」后自动重排',
    manual: false,
  });
  assert.deepEqual(describeQueueSnapshot('task.complete'), {
    triggerLabel: '「完成任务」后自动重排',
    manual: false,
  });
  assert.deepEqual(describeQueueSnapshot('goal.update'), {
    triggerLabel: '目标变更后自动重排',
    manual: false,
  });
});

test('describeQueueSnapshot: 认不出的事件码与空值都只说「已刷新」，不猜场景', () => {
  assert.deepEqual(describeQueueSnapshot('something.unknown'), {
    triggerLabel: '队列排序已刷新',
    manual: false,
  });
  for (const empty of ['', '   ', null, undefined]) {
    assert.deepEqual(
      describeQueueSnapshot(empty),
      { triggerLabel: '队列排序已刷新', manual: false },
      `${JSON.stringify(empty)} 走空值兜底`,
    );
  }
  // 前缀认得出、具体动作认不出时，仍要说明是写操作带出来的。
  assert.deepEqual(describeQueueSnapshot('task.brandnewaction'), {
    triggerLabel: '写操作后自动重排',
    manual: false,
  });
});

test('splitOperations: task.* / goal.* 留在动态页签，只有队列侧进重算', () => {
  // 钉住页签分流：重算页签铺的是快照，动态页签不能被 task.complete 这类写操作抽走。
  const { activities, recalc } = splitOperations([
    op({ id: 'create', operation_type: 'task.create', target_type: 'task' }),
    op({ id: 'queue', operation_type: 'queue.recalculate', target_type: 'queue' }),
    op({ id: 'done', operation_type: 'task.complete', target_type: 'task' }),
  ]);
  assert.deepEqual(activities.map((o) => o.id), ['create', 'done']);
  assert.deepEqual(recalc.map((o) => o.id), ['queue']);
  assert.ok(!recalc.some((o) => o.operation_type === 'task.complete'), 'task.complete 绝不进重算侧');
});

// ── 3.5 静态接线断言：ActivityPage 用到的 @shared/activity 名字必须真的导出 ────

/**
 * 纯文本层面的接线体检，不启动 React、不求值组件。
 *
 * 由来：浏览器里出现过 `ReferenceError: describeQueueSnapshot is not defined
 * at SnapshotRow`——那次是 HMR 中间态缓存，源码本身是好的。但同一形状的真实
 * 回归（组件里调用了某个 helper，却忘了把它写进 import 清单）在 Vite 构建里
 * 不一定当场报错，只会等到用户点开 `/activity` 才炸。这里把两头对齐：
 * ActivityPage 从 '@shared/activity' 导入的每个名字，都得在 shared/activity.ts
 * 的导出清单里真实存在。
 */
const activityPageSource = fs.readFileSync(
  new URL('../src/pages/ActivityPage/ActivityPage.tsx', import.meta.url),
  'utf8',
);
const sharedActivitySource = fs.readFileSync(
  new URL('../shared/activity.ts', import.meta.url),
  'utf8',
);

/** ActivityPage 里 `import { ... } from '@shared/activity'` 的具名清单（去掉 `type ` 前缀与别名）。 */
function importedFromSharedActivity(source: string): string[] {
  const block = /import\s*\{([^}]*)\}\s*from\s*['"]@shared\/activity['"]/.exec(source);
  assert.ok(block, "ActivityPage 必须有一条 `import { ... } from '@shared/activity'`");
  return block[1]
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim());
}

/** shared/activity.ts 的导出名清单（function / interface / type）。 */
function exportedFromSharedActivity(source: string): Set<string> {
  const names = new Set<string>();
  for (const match of source.matchAll(
    /^export\s+(?:function|interface|type)\s+([A-Za-z_$][\w$]*)/gm,
  )) {
    names.add(match[1]);
  }
  return names;
}

test('接线体检：ActivityPage 从 @shared/activity 导入的名字都真的被导出', () => {
  const imported = importedFromSharedActivity(activityPageSource);
  const exported = exportedFromSharedActivity(sharedActivitySource);

  assert.ok(imported.length > 0, '至少应导入一个名字，正则没有空转');
  assert.ok(exported.size > 0, 'shared/activity.ts 应收集到导出名，正则没有空转');

  const missing = imported.filter((name) => !exported.has(name));
  assert.deepEqual(
    missing,
    [],
    `ActivityPage 导入了 shared/activity.ts 并未导出的名字：${missing.join(', ')}`,
  );
});

test('接线体检：describeQueueSnapshot 既被导入，也在 SnapshotRow 中被调用', () => {
  assert.ok(
    importedFromSharedActivity(activityPageSource).includes('describeQueueSnapshot'),
    'describeQueueSnapshot 必须出现在 ActivityPage 的 @shared/activity 导入清单里',
  );

  // 只看 SnapshotRow 函数体，避免被注释或别处的同名字符串蒙过去。
  const bodyStart = activityPageSource.indexOf('function SnapshotRow');
  assert.ok(bodyStart >= 0, 'ActivityPage 里应有 SnapshotRow 组件');
  const nextComponent = activityPageSource.indexOf('\nfunction ', bodyStart + 1);
  const snapshotRowBody = activityPageSource.slice(
    bodyStart,
    nextComponent >= 0 ? nextComponent : undefined,
  );
  assert.match(
    snapshotRowBody,
    /describeQueueSnapshot\s*\(/,
    'SnapshotRow 应调用 describeQueueSnapshot(...)',
  );
});

// ── 4. HTTP-level filter behaviour ───────────────────────────────────────────

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pwq-ux19-'));
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

async function call(pathname: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${pathname}`);
  return { status: res.status, body: await res.json() };
}

async function createTask(title: string, key: string) {
  const res = await fetch(`${base}/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify({ title }),
  });
  return res.json();
}

async function createGoal(title: string, key: string) {
  const res = await fetch(`${base}/api/goals`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify({ title }),
  });
  return res.json();
}

test('setup creates distinguishable tasks and a goal', async () => {
  await createTask('Ux19 Alpha Pricing Engine', 'ux19-a');
  await createTask('Ux19 Beta Launch Checklist', 'ux19-b');
  await createGoal('Ux19 Gamma North Star', 'ux19-g');
  const { body } = await call('/api/activity?limit=500');
  assert.ok(body.operations.length >= 3);
});

test('query filters by task title via the joined row', async () => {
  const { body } = await call('/api/activity?query=Alpha');
  const summaries: string[] = body.operations.map((o: OperationRecord) => o.summary);
  assert.ok(
    summaries.some((s) => /Ux19 Alpha Pricing Engine/.test(s)),
    'the Alpha task operation matches',
  );
  assert.ok(
    !summaries.some((s) => /Ux19 Beta Launch Checklist/.test(s)),
    'the Beta task operation is excluded',
  );
});

test('query filters by goal title via the joined row', async () => {
  const { body } = await call('/api/activity?query=Gamma');
  const summaries: string[] = body.operations.map((o: OperationRecord) => o.summary);
  assert.ok(summaries.some((s) => /Ux19 Gamma North Star/.test(s)));
});

test('type whitelist returns only the requested operation types', async () => {
  const { body } = await call('/api/activity?type=task.create&limit=500');
  assert.ok(body.operations.length >= 2);
  for (const opRow of body.operations) {
    assert.equal(opRow.operation_type, 'task.create');
  }
});

test('from / to bounds select a time window', async () => {
  const future = new Date(Date.now() + 36e5).toISOString();
  const empty = await call(`/api/activity?from=${encodeURIComponent(future)}`);
  assert.equal(empty.body.operations.length, 0, 'a future from bound excludes everything');

  const past = new Date(Date.now() - 36e5).toISOString();
  const all = await call(`/api/activity?from=${encodeURIComponent(past)}&limit=500`);
  assert.ok(all.body.operations.length >= 3, 'a past from bound keeps recent operations');
});

test('an unparseable from date is rejected with 400', async () => {
  const res = await call('/api/activity?from=not-a-date');
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'validation_failed');
});

test('limit is clamped to a positive page size', async () => {
  const zero = await call('/api/activity?limit=0');
  assert.ok(zero.body.operations.length >= 1, 'limit=0 clamps to at least one row');
  const huge = await call('/api/activity?limit=99999');
  assert.ok(huge.body.operations.length <= 500, 'limit is capped at 500');
});

// ── 5. searching the displayed Chinese alias ─────────────────────────────────

// Loaded lazily like the modules above: a static import would pull in
// `server/config.ts` before the PWQ_* env vars are set, and the cached module
// would then point at the repository database instead of the temp one.
const { freshDb } = await import('./helpers.ts');
const { listOperations } = await import('../server/repo/operations.ts');
const { run: runSql } = await import('../server/db/connection.ts');
const { displayDemoText } = await import('../shared/demo-text.ts');

test('query matches the Chinese display alias as well as the stored English title', () => {
  const db = freshDb();
  runSql(
    db,
    `INSERT INTO tasks (id, title, is_demo, created_at, updated_at)
     VALUES ('task_vendor_1', 'Demo: Reply to the vendor renewal email today', 1, '2026-10-12T10:00:00.000Z', '2026-10-12T10:00:00.000Z')`,
  );
  runSql(
    db,
    `INSERT INTO operations
       (id, idempotency_key, operation_type, target_type, target_id, actor_id, status, summary, created_at)
     VALUES ('op_vendor_1', 'key-vendor-1', 'task.quadrant.confirm', 'task', 'task_vendor_1', 'actor-human-me', 'succeeded', 'Confirmed q1 for "Demo: Reply to the vendor renewal email today"', '2026-10-12T10:01:00.000Z')`,
  );

  assert.ok(
    listOperations(db, { query: '供应商' }).some((o) => o.id === 'op_vendor_1'),
    'the Chinese alias shown in the UI finds the operation',
  );
  assert.ok(
    listOperations(db, { query: 'vendor' }).some((o) => o.id === 'op_vendor_1'),
    'the stored English title still matches',
  );
  assert.ok(
    !listOperations(db, { query: '不存在的词xyz' }).some((o) => o.id === 'op_vendor_1'),
    'an unrelated term matches nothing',
  );
});

test('displayDemoText maps demo seed text and leaves user content alone', () => {
  assert.equal(
    displayDemoText('Demo: Reply to the vendor renewal email today', true),
    '示例：今天回复供应商续约邮件',
  );
  assert.equal(displayDemoText('我的自定义任务', false), '我的自定义任务');
});
