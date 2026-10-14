/**
 * `/api/settings/*` 的隔离全链路测试。
 *
 * 走 `buildRouter(() => db)`，所以路由解析、zod 校验、版本校验、原子落盘与
 * `withOperation` 的幂等/操作日志都是真的，只有 HTTP 传输被省掉。数据库是一次性
 * 内存库，habits 指向 `os.tmpdir()` 下的临时目录——用户真实的 `data/work-queue.db`
 * 与 `habits/` 永不被触碰。因为 `server/config.ts` 在模块求值那一刻就把
 * `PWQ_HABITS_DIR` 读成常量，这里必须**先设环境变量、再动态 import** 服务端模块
 * （静态 import 会被提升到赋值之前）。
 *
 * 这份测试要守住的几条：
 * - 快照形状与前端 `SettingsSnapshot` 逐字对齐：四个版本号、weights 不含换算系数、
 *   换算系数在顶层 `conversion`。
 * - **版本校验不可跳过**：`expected_version` 过期 → 409，且错误体带当前快照。
 *   adopt 是双资源写，两个版本任一不符都要 409。
 * - **软删除**：停用/采纳都不删条目，历史与来源证据必须留着。
 * - **preview 只读不写**：history 长度与操作数都不许动。
 * - 旧数据兼容：一种不在 known 列表里的 constraint kind 要读得出来、改得了、不丢。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pwq-settings-'));
// 必须早于 server/config.ts 第一次求值。
process.env.PWQ_HABITS_DIR = path.join(tempRoot, 'habits');
process.env.PWQ_DB_PATH = path.join(tempRoot, 'unused.db');

const { freshDb } = await import('./helpers.ts');
const { buildRouter } = await import('../server/http/routes.ts');
const { ApiError } = await import('../server/lib/errors.ts');
const {
  ensureHabitFiles,
  readHabitFile,
  writeHabitFile,
  HABIT_SCHEMA_VERSION,
} = await import('../server/domain/habits.ts');
const { DEFAULT_DAYS_PER_MONTH, DEFAULT_HOURS_PER_DAY } = await import('../shared/duration.ts');
import type { Db } from '../server/db/connection.ts';
import type { Row } from '../server/db/connection.ts';
import type { SettingsSnapshot } from '../shared/types.ts';

type Router = ReturnType<typeof buildRouter>;

interface SnapshotEnvelope {
  snapshot: SettingsSnapshot;
}

/** 每个用例都从一套干净的习惯文件 + 一个空内存库开始。 */
function setup(): { db: Db; router: Router } {
  fs.rmSync(process.env.PWQ_HABITS_DIR!, { recursive: true, force: true });
  ensureHabitFiles();
  const db = freshDb();
  return { db, router: buildRouter(() => db) };
}

let keyCounter = 0;
const nextKey = (): string => `settings-test-${(keyCounter += 1)}`;

/** 按真实路径调用一条路由；`ctx` 只给对应 handler 实际会读的字段。 */
async function callRoute<T>(
  router: Router,
  method: 'GET' | 'POST' | 'PATCH',
  pathname: string,
  init: { body?: unknown; idempotencyKey?: string } = {},
): Promise<T> {
  const match = router.match(method, pathname);
  assert.ok(match, `route ${method} ${pathname} must exist`);
  return (await match.handler({
    url: new URL(`http://local${pathname}`),
    params: match.params,
    body: init.body,
    idempotencyKey: init.idempotencyKey ?? null,
  } as never)) as T;
}

const getSnapshot = (router: Router) =>
  callRoute<SettingsSnapshot>(router, 'GET', '/api/settings');

const post = <T = SnapshotEnvelope>(router: Router, pathname: string, body: unknown) =>
  callRoute<T>(router, 'POST', pathname, { body, idempotencyKey: nextKey() });

const patchRoute = (router: Router, pathname: string, body: unknown) =>
  callRoute<SnapshotEnvelope>(router, 'PATCH', pathname, { body, idempotencyKey: nextKey() });

/** 断言一次调用被拒成某个状态码，并把错误交回给调用方继续查。 */
async function rejects(
  run: () => Promise<unknown>,
  status: number,
  code?: string,
): Promise<InstanceType<typeof ApiError>> {
  let caught: unknown;
  await assert.rejects(run, (error: unknown) => {
    caught = error;
    assert.ok(error instanceof ApiError, `expected ApiError, got ${String(error)}`);
    assert.equal(error.status, status);
    if (code) assert.equal(error.code, code);
    return true;
  });
  return caught as InstanceType<typeof ApiError>;
}

const operationCount = (db: Db): number =>
  Number(
    (db.prepare('SELECT COUNT(*) AS n FROM operations').get() as Row).n,
  );

const historyLength = (name: 'explicit' | 'inferred' | 'constraints' | 'weights'): number =>
  readHabitFile(name).history.length;

/** 直接往 inferred 文件里塞一条观察结论——没有创建推断习惯的路由（刻意如此）。 */
function seedInferred(statement: string, confidence = 0.7): string {
  const file = readHabitFile('inferred');
  const id = `habit_seeded_${file.payload.entries.length + 1}`;
  const at = new Date(Date.now() + 1).toISOString();
  writeHabitFile('inferred', {
    ...file,
    updated_at: at,
    payload: {
      entries: [
        ...file.payload.entries,
        {
          id,
          statement,
          kind: 'scheduling',
          enabled: true,
          confidence,
          source: 'observed',
          created_at: at,
          updated_at: at,
        },
      ],
    },
    history: [{ at, actor: 'test', change: 'seeded inferred habit' }, ...file.history],
  });
  return id;
}

// ── 1. 快照形状 ──────────────────────────────────────────────────────────────

test('GET /api/settings 返回四个版本号、排序偏好、换算系数与三类条目', async () => {
  const { router } = setup();
  const snapshot = await getSnapshot(router);

  // 四个文件各自一个版本号，值就是对应 envelope 的 updated_at。
  assert.deepEqual(Object.keys(snapshot.versions).sort(), [
    'constraints',
    'explicit',
    'inferred',
    'weights',
  ]);
  for (const name of ['explicit', 'inferred', 'constraints', 'weights'] as const) {
    assert.equal(
      snapshot.versions[name],
      readHabitFile(name).updated_at,
      `versions.${name} 应等于该文件 envelope 的 updated_at`,
    );
  }

  // 六项权重 + 两项偏好，各 0..2。
  assert.deepEqual(Object.keys(snapshot.weights.weights).sort(), [
    'context_switch',
    'deadline',
    'dependency',
    'effort',
    'habit_alignment',
    'manual_priority',
  ]);
  for (const value of Object.values(snapshot.weights.weights)) {
    assert.ok(value >= 0 && value <= 2, '每项权重都应落在 0..2');
  }
  assert.ok(Array.isArray(snapshot.weights.preferred_task_types));
  assert.ok(Array.isArray(snapshot.weights.peak_hours));

  // 换算系数被提到顶层，**不**留在 weights 里——界面据此把两件事分开展示。
  assert.deepEqual(snapshot.conversion, {
    hours_per_day: DEFAULT_HOURS_PER_DAY,
    days_per_month: DEFAULT_DAYS_PER_MONTH,
  });
  assert.equal(
    'hours_per_day' in snapshot.weights,
    false,
    'weights 不该含 hours_per_day——它是换算系数，不是排序权重',
  );
  assert.equal('days_per_month' in snapshot.weights, false);

  for (const key of ['explicit', 'inferred', 'constraints'] as const) {
    assert.ok(Array.isArray(snapshot[key]), `${key} 应是数组`);
  }
});

test('GET /api/settings 是纯读：不写操作日志、不动任何文件版本', async () => {
  const { db, router } = setup();
  const before = await getSnapshot(router);
  const operations = operationCount(db);

  await getSnapshot(router);
  await getSnapshot(router);

  assert.equal(operationCount(db), operations, '读快照不该写操作日志');
  assert.deepEqual((await getSnapshot(router)).versions, before.versions, '读不该推进版本');
});

// ── 2. 版本校验 ──────────────────────────────────────────────────────────────

test('expected_version 过期 → 409 version_conflict，错误体带当前完整快照', async () => {
  const { router } = setup();
  const stale = (await getSnapshot(router)).versions.explicit;

  // 先用正确的版本写一次，把 stale 挤成过期的。
  await post(router, '/api/settings/explicit', {
    statement: '上午只做深度工作',
    expected_version: stale,
  });

  const error = await rejects(
    () =>
      post(router, '/api/settings/explicit', {
        statement: '第二条也想用旧版本号写',
        expected_version: stale,
      }),
    409,
    'version_conflict',
  );
  assert.equal(error.message, '设置已在别处被修改');

  // 快照挂在 `extra` 上，由 router 的 sendError 铺到响应体顶层：客户端据此直接
  // 替换本地状态，不必再发一次 GET。
  const snapshot = (error.extra as { snapshot: SettingsSnapshot }).snapshot;
  const current = await getSnapshot(router);
  assert.deepEqual(snapshot.versions, current.versions, '409 带回的应是当前版本，而非过期版本');
  assert.equal(snapshot.explicit.length, 1, '409 带回的快照应含已写入的那一条');

  // 被拒的那次写什么都没留下。
  assert.equal(current.explicit.length, 1, '版本不符的写不该落盘');
});

test('版本校验先于落盘：被拒的写不追加 history、不写操作日志', async () => {
  const { db, router } = setup();
  const operations = operationCount(db);
  const history = historyLength('constraints');

  await rejects(
    () =>
      post(router, '/api/settings/constraints', {
        statement: '不该被写进去',
        kind: 'forbidden_window',
        value: '20:00-07:00',
        expected_version: '1999-01-01T00:00:00.000Z',
      }),
    409,
    'version_conflict',
  );

  assert.equal(historyLength('constraints'), history, '被拒的写不该追加 history');
  assert.equal(operationCount(db), operations, '被拒的写不该留下成功的操作记录');
  assert.equal((await getSnapshot(router)).constraints.length, 0);
});

// ── 3. explicit / constraints / inferred 的增改启停 ───────────────────────────

test('explicit：新建默认 kind=preference、source=user，PATCH 只改给出的字段', async () => {
  const { router } = setup();
  let snapshot = await getSnapshot(router);

  const created = await post(router, '/api/settings/explicit', {
    statement: '上午只做深度工作',
    expected_version: snapshot.versions.explicit,
  });
  snapshot = created.snapshot;
  assert.equal(snapshot.explicit.length, 1);
  const entry = snapshot.explicit[0];
  assert.equal(entry.statement, '上午只做深度工作');
  assert.equal(entry.kind, 'preference', 'kind 缺省应落成 preference');
  assert.equal(entry.source, 'user');
  assert.equal(entry.confidence, null, '用户自己说的话没有置信度');
  assert.equal(entry.enabled, true);

  // 只给 kind：statement 原样保留。
  const patched = await patchRoute(router, `/api/settings/explicit/${entry.id}`, {
    kind: 'scheduling',
    expected_version: snapshot.versions.explicit,
  });
  const afterPatch = patched.snapshot.explicit[0];
  assert.equal(afterPatch.kind, 'scheduling');
  assert.equal(afterPatch.statement, '上午只做深度工作', 'PATCH 没给 statement 就该保留原值');

  // 停用是软删除：条目仍在，只是 enabled=false。
  const disabled = await post(router, `/api/settings/explicit/${entry.id}/enabled`, {
    enabled: false,
    expected_version: patched.snapshot.versions.explicit,
  });
  assert.equal(disabled.snapshot.explicit.length, 1, '停用不该删除条目');
  assert.equal(disabled.snapshot.explicit[0].enabled, false);
});

test('constraints：新建、PATCH、启停都走版本校验，未知 id → 404', async () => {
  const { router } = setup();
  let snapshot = await getSnapshot(router);

  const created = await post(router, '/api/settings/constraints', {
    statement: '20 点后不安排工作',
    kind: 'forbidden_window',
    value: '20:00-07:00',
    expected_version: snapshot.versions.constraints,
  });
  snapshot = created.snapshot;
  assert.equal(snapshot.constraints.length, 1);
  const entry = snapshot.constraints[0];
  assert.equal(entry.kind, 'forbidden_window');
  assert.equal(entry.value, '20:00-07:00');
  assert.equal(entry.enabled, true);

  const patched = await patchRoute(router, `/api/settings/constraints/${entry.id}`, {
    value: '21:00-07:00',
    expected_version: snapshot.versions.constraints,
  });
  assert.equal(patched.snapshot.constraints[0].value, '21:00-07:00');
  assert.equal(
    patched.snapshot.constraints[0].statement,
    '20 点后不安排工作',
    '只改 value 不该动 statement',
  );

  const disabled = await post(router, `/api/settings/constraints/${entry.id}/enabled`, {
    enabled: false,
    expected_version: patched.snapshot.versions.constraints,
  });
  assert.equal(disabled.snapshot.constraints.length, 1, '停用不该删除约束');
  assert.equal(disabled.snapshot.constraints[0].enabled, false);

  await rejects(
    () =>
      patchRoute(router, '/api/settings/constraints/hc_nope', {
        value: '1',
        expected_version: disabled.snapshot.versions.constraints,
      }),
    404,
    'not_found',
  );
});

test('constraints：不在 known 列表里的旧 kind 读得出来，PATCH 别的字段也不丢它', async () => {
  const { router } = setup();

  // 手写一条历史遗留数据：kind 不是三种 known kind 之一。
  const file = readHabitFile('constraints');
  const at = new Date(Date.now() + 1).toISOString();
  writeHabitFile('constraints', {
    ...file,
    updated_at: at,
    payload: {
      entries: [
        {
          id: 'hc_legacy',
          statement: '一种早年的约束',
          kind: 'legacy_custom_kind',
          enabled: true,
          value: '42',
        },
      ],
    },
    history: file.history,
  });

  // 读：整份文件不能因为一条不认识的 kind 而校验失败。
  const snapshot = await getSnapshot(router);
  assert.equal(snapshot.constraints.length, 1, '不认识的 kind 不该让整份文件读不出来');
  assert.equal(snapshot.constraints[0].kind, 'legacy_custom_kind', '旧 kind 应原样返回');

  // 改：只改 value，kind 不给 → 原值保留，不被改写也不被丢掉。
  const patched = await patchRoute(router, '/api/settings/constraints/hc_legacy', {
    value: '43',
    expected_version: snapshot.versions.constraints,
  });
  assert.equal(patched.snapshot.constraints[0].kind, 'legacy_custom_kind', 'PATCH 不该丢掉旧 kind');
  assert.equal(patched.snapshot.constraints[0].value, '43');

  // 新建仍然只接受三种 known kind——容忍是为了读旧数据，不是放开写入。
  await rejects(
    () =>
      post(router, '/api/settings/constraints', {
        statement: '新建一条自定义 kind',
        kind: 'legacy_custom_kind',
        value: '1',
        expected_version: patched.snapshot.versions.constraints,
      }),
    400,
    'validation_failed',
  );
});

test('inferred：只能启停，条目与 confidence/source 原样保留', async () => {
  const { router } = setup();
  const id = seedInferred('你通常在上午处理最难的任务');

  const snapshot = await getSnapshot(router);
  assert.equal(snapshot.inferred.length, 1);
  assert.equal(snapshot.inferred[0].confidence, 0.7, 'inferred 的置信度应原样返回');
  assert.equal(snapshot.inferred[0].source, 'observed');

  const disabled = await post(router, `/api/settings/inferred/${id}/enabled`, {
    enabled: false,
    expected_version: snapshot.versions.inferred,
  });
  assert.equal(disabled.snapshot.inferred.length, 1, '停用不该删除推断习惯');
  assert.equal(disabled.snapshot.inferred[0].enabled, false);
  assert.equal(disabled.snapshot.inferred[0].confidence, 0.7, '停用不该抹掉置信度');

  // 推断习惯没有新建/改写路由——它是观察的结论，不是用户的话。
  assert.equal(router.match('POST', '/api/settings/inferred'), null);
  assert.equal(router.match('PATCH', `/api/settings/inferred/${id}`), null);
});

// ── 4. adopt：双资源写，两个版本都要对 ───────────────────────────────────────

test('adopt：两版本都对 → 生成带 source_relation 的 explicit，原 inferred 保留', async () => {
  const { router } = setup();
  const id = seedInferred('你更愿意把同类沟通攒到一起处理', 0.82);
  const snapshot = await getSnapshot(router);

  const adopted = await post(router, `/api/settings/inferred/${id}/adopt`, {
    expected_version: snapshot.versions.inferred,
    expected_explicit_version: snapshot.versions.explicit,
  });

  // 新的 explicit 条目：内容照搬，来源改成用户，置信度清空。
  assert.equal(adopted.snapshot.explicit.length, 1);
  const entry = adopted.snapshot.explicit[0];
  assert.equal(entry.statement, '你更愿意把同类沟通攒到一起处理');
  assert.equal(entry.source, 'user', '采纳之后它就是用户自己说的话');
  assert.equal(entry.confidence, null, '采纳后置信度（观察的不确定性）不再适用');
  assert.equal(entry.enabled, true);
  assert.deepEqual(
    entry.source_relation,
    { type: 'adopted_from_inferred', inferred_id: id },
    'source_relation 应指回原推断条目，供界面溯源',
  );

  // 原推断条目保留（历史证据），只是被停用。
  assert.equal(adopted.snapshot.inferred.length, 1, '采纳不该删除原推断条目');
  assert.equal(adopted.snapshot.inferred[0].id, id);
  assert.equal(adopted.snapshot.inferred[0].enabled, false);

  // 两个文件的版本都推进了。
  assert.notEqual(adopted.snapshot.versions.explicit, snapshot.versions.explicit);
  assert.notEqual(adopted.snapshot.versions.inferred, snapshot.versions.inferred);
});

test('adopt：任一版本不符都 → 409，且两个文件都没动', async () => {
  const { router } = setup();
  const id = seedInferred('你倾向于在周五收尾杂事');
  const snapshot = await getSnapshot(router);
  const STALE = '1999-01-01T00:00:00.000Z';

  // 只有 inferred 版本错。
  const wrongInferred = await rejects(
    () =>
      post(router, `/api/settings/inferred/${id}/adopt`, {
        expected_version: STALE,
        expected_explicit_version: snapshot.versions.explicit,
      }),
    409,
    'version_conflict',
  );
  assert.ok((wrongInferred.extra as { snapshot: SettingsSnapshot }).snapshot.versions);

  // 只有 explicit 版本错——另一个文件的版本对也救不了它。
  await rejects(
    () =>
      post(router, `/api/settings/inferred/${id}/adopt`, {
        expected_version: snapshot.versions.inferred,
        expected_explicit_version: STALE,
      }),
    409,
    'version_conflict',
  );

  // 两次被拒之后，两个文件都还是原样：没有半截写入。
  const after = await getSnapshot(router);
  assert.equal(after.explicit.length, 0, '被拒的 adopt 不该插入 explicit');
  assert.equal(after.inferred[0].enabled, true, '被拒的 adopt 不该停用原推断条目');
  assert.deepEqual(after.versions, snapshot.versions, '被拒的 adopt 不该推进任何版本');

  // 少给一个版本号是用法错误，不是冲突。
  await rejects(
    () =>
      post(router, `/api/settings/inferred/${id}/adopt`, {
        expected_version: snapshot.versions.inferred,
      }),
    400,
    'validation_failed',
  );
});

// ── 5. conversion ───────────────────────────────────────────────────────────

test('conversion：改 4 小时/22 天后快照生效，reset 回到 8/20', async () => {
  const { router } = setup();
  let snapshot = await getSnapshot(router);

  const saved = await post(router, '/api/settings/conversion', {
    hours_per_day: 4,
    days_per_month: 22,
    expected_version: snapshot.versions.weights,
  });
  assert.deepEqual(saved.snapshot.conversion, { hours_per_day: 4, days_per_month: 22 });
  // 换算系数与排序权重同住一个文件，但改前者不该动后者。
  assert.deepEqual(saved.snapshot.weights.weights, snapshot.weights.weights);

  snapshot = saved.snapshot;
  const reset = await post(router, '/api/settings/conversion/reset', {
    expected_version: snapshot.versions.weights,
  });
  assert.deepEqual(reset.snapshot.conversion, {
    hours_per_day: DEFAULT_HOURS_PER_DAY,
    days_per_month: DEFAULT_DAYS_PER_MONTH,
  });
});

test('conversion：只改一个键时另一个保留；越界与非整数天数 → 400', async () => {
  const { router } = setup();
  const snapshot = await getSnapshot(router);

  const onlyHours = await post(router, '/api/settings/conversion', {
    hours_per_day: 6,
    expected_version: snapshot.versions.weights,
  });
  assert.deepEqual(onlyHours.snapshot.conversion, {
    hours_per_day: 6,
    days_per_month: DEFAULT_DAYS_PER_MONTH,
  });

  const version = onlyHours.snapshot.versions.weights;
  for (const body of [
    { hours_per_day: 0.1 }, // < 0.5
    { hours_per_day: 25 }, // > 24
    { days_per_month: 0 }, // < 1
    { days_per_month: 32 }, // > 31
    { days_per_month: 20.5 }, // 半个工作日没有意义
    {}, // 两个键都不给
  ]) {
    await rejects(
      () => post(router, '/api/settings/conversion', { ...body, expected_version: version }),
      400,
      'validation_failed',
    );
  }

  // 被拒之后值没变。
  assert.equal((await getSnapshot(router)).conversion.hours_per_day, 6);
});

// ── 6. weights：preview 只读，save 才写 ──────────────────────────────────────

test('weights/preview 只读不写：history 长度、操作数与文件版本都不动', async () => {
  const { db, router } = setup();
  const snapshot = await getSnapshot(router);
  const history = historyLength('weights');
  const operations = operationCount(db);

  const draft = {
    weights: {
      deadline: 2,
      manual_priority: 1,
      dependency: 1,
      effort: 0,
      habit_alignment: 1,
      context_switch: 1,
    },
  };
  const preview = await post<{ weights: Record<string, number>; message: string }>(
    router,
    '/api/settings/weights/preview',
    draft,
  );

  assert.deepEqual(preview.weights, draft.weights, '预览应回传试算用的那份权重');
  assert.ok(preview.message && preview.message.length > 0, '预览应带一句中文试算说明');

  // 这三条一起证明它真的什么都没写。
  assert.equal(historyLength('weights'), history, 'preview 不该追加 history');
  assert.equal(operationCount(db), operations, 'preview 不该写操作日志');
  assert.deepEqual(
    (await getSnapshot(router)).versions,
    snapshot.versions,
    'preview 不该推进任何文件版本',
  );
  assert.deepEqual(
    (await getSnapshot(router)).weights.weights,
    snapshot.weights.weights,
    'preview 不该改动已存的权重',
  );
});

test('weights/preview 不收 expected_version：连点预览不会把本地版本号搞过期', async () => {
  const { router } = setup();
  const before = await getSnapshot(router);
  const draft = { weights: { ...before.weights.weights, deadline: 2 } };

  await post(router, '/api/settings/weights/preview', draft);
  await post(router, '/api/settings/weights/preview', draft);

  // 预览之后，预览前拿到的版本号仍然能用来保存。
  const saved = await post(router, '/api/settings/weights', {
    ...draft,
    expected_version: before.versions.weights,
  });
  assert.equal(saved.snapshot.weights.weights.deadline, 2);
});

test('weights：保存写库、history +1，未给的偏好项保持原值', async () => {
  const { db, router } = setup();
  const snapshot = await getSnapshot(router);
  const history = historyLength('weights');
  const operations = operationCount(db);

  const weights = {
    deadline: 2,
    manual_priority: 1,
    dependency: 1,
    effort: 0,
    habit_alignment: 1,
    context_switch: 1,
  };
  const saved = await post(router, '/api/settings/weights', {
    weights,
    expected_version: snapshot.versions.weights,
  });

  assert.deepEqual(saved.snapshot.weights.weights, weights);
  assert.deepEqual(
    saved.snapshot.weights.preferred_task_types,
    snapshot.weights.preferred_task_types,
    '没给 preferred_task_types 就该保持原值',
  );
  assert.deepEqual(saved.snapshot.weights.peak_hours, snapshot.weights.peak_hours);
  assert.deepEqual(saved.snapshot.conversion, snapshot.conversion, '保存权重不该动换算系数');

  assert.equal(historyLength('weights'), history + 1, '保存应追加恰好一条 history');
  assert.equal(operationCount(db), operations + 1, '保存应写一条操作日志');
});

test('weights：三项都给时整份覆盖；权重越界 → 400', async () => {
  const { router } = setup();
  const snapshot = await getSnapshot(router);

  const saved = await post(router, '/api/settings/weights', {
    weights: { ...snapshot.weights.weights, effort: 2 },
    preferred_task_types: ['deep_work', 'review'],
    peak_hours: [9, 10, 14],
    expected_version: snapshot.versions.weights,
  });
  assert.deepEqual(saved.snapshot.weights.preferred_task_types, ['deep_work', 'review']);
  assert.deepEqual(saved.snapshot.weights.peak_hours, [9, 10, 14]);

  const version = saved.snapshot.versions.weights;
  for (const body of [
    { weights: { ...snapshot.weights.weights, effort: 3 } }, // > 2
    { weights: { ...snapshot.weights.weights, effort: -1 } }, // < 0
    { weights: { deadline: 1 } }, // 六项必须给全
    { weights: snapshot.weights.weights, peak_hours: [24] }, // 小时只到 23
    { weights: snapshot.weights.weights, preferred_task_types: ['not_a_type'] },
  ]) {
    await rejects(
      () => post(router, '/api/settings/weights', { ...body, expected_version: version }),
      400,
      'validation_failed',
    );
  }
});

// ── 7. 每次成功写都推进对应版本，且走幂等 ────────────────────────────────────

test('每个写端点返回的快照里，对应文件的版本号都已推进', async () => {
  const { router } = setup();
  const inferredId = seedInferred('你习惯把评审放在下午');

  /** 一步：跑一次写，断言它推进了 `file` 的版本、没动其他文件的。 */
  const step = async (
    label: string,
    file: 'explicit' | 'constraints' | 'inferred' | 'weights',
    run: (snapshot: SettingsSnapshot) => Promise<SnapshotEnvelope>,
  ): Promise<void> => {
    const before = await getSnapshot(router);
    const after = (await run(before)).snapshot;
    assert.notEqual(
      after.versions[file],
      before.versions[file],
      `${label} 之后 versions.${file} 应已推进`,
    );
    for (const other of ['explicit', 'constraints', 'inferred', 'weights'] as const) {
      if (other === file) continue;
      // adopt 是双资源写，它那一步单独验证，这里只跑单资源写。
      assert.equal(
        after.versions[other],
        before.versions[other],
        `${label} 不该推进 versions.${other}`,
      );
    }
  };

  await step('新建明确习惯', 'explicit', (s) =>
    post(router, '/api/settings/explicit', {
      statement: '上午只做深度工作',
      expected_version: s.versions.explicit,
    }),
  );
  await step('修改明确习惯', 'explicit', async (s) =>
    patchRoute(router, `/api/settings/explicit/${s.explicit[0].id}`, {
      statement: '上午只做深度工作（已修订）',
      expected_version: s.versions.explicit,
    }),
  );
  await step('停用明确习惯', 'explicit', async (s) =>
    post(router, `/api/settings/explicit/${s.explicit[0].id}/enabled`, {
      enabled: false,
      expected_version: s.versions.explicit,
    }),
  );
  await step('新建硬性约束', 'constraints', (s) =>
    post(router, '/api/settings/constraints', {
      statement: '20 点后不安排工作',
      kind: 'forbidden_window',
      value: '20:00-07:00',
      expected_version: s.versions.constraints,
    }),
  );
  await step('修改硬性约束', 'constraints', async (s) =>
    patchRoute(router, `/api/settings/constraints/${s.constraints[0].id}`, {
      value: '21:00-07:00',
      expected_version: s.versions.constraints,
    }),
  );
  await step('停用硬性约束', 'constraints', async (s) =>
    post(router, `/api/settings/constraints/${s.constraints[0].id}/enabled`, {
      enabled: false,
      expected_version: s.versions.constraints,
    }),
  );
  await step('停用推断习惯', 'inferred', (s) =>
    post(router, `/api/settings/inferred/${inferredId}/enabled`, {
      enabled: false,
      expected_version: s.versions.inferred,
    }),
  );
  await step('改换算系数', 'weights', (s) =>
    post(router, '/api/settings/conversion', {
      hours_per_day: 7,
      expected_version: s.versions.weights,
    }),
  );
  await step('恢复默认换算', 'weights', (s) =>
    post(router, '/api/settings/conversion/reset', {
      expected_version: s.versions.weights,
    }),
  );
  await step('保存排序权重', 'weights', (s) =>
    post(router, '/api/settings/weights', {
      weights: { ...s.weights.weights, dependency: 2 },
      expected_version: s.versions.weights,
    }),
  );
});

test('同一个 Idempotency-Key 重放：返回上次快照，不二次写入', async () => {
  const { db, router } = setup();
  const snapshot = await getSnapshot(router);
  const key = nextKey();
  const body = {
    statement: '上午只做深度工作',
    expected_version: snapshot.versions.explicit,
  };

  const first = await callRoute<SnapshotEnvelope>(router, 'POST', '/api/settings/explicit', {
    body,
    idempotencyKey: key,
  });
  const operations = operationCount(db);
  const history = historyLength('explicit');

  // 重放：同一个键第二次来，不该再插一条习惯（否则重试就等于复制）。
  const replay = await callRoute<SnapshotEnvelope>(router, 'POST', '/api/settings/explicit', {
    body,
    idempotencyKey: key,
  });

  assert.deepEqual(replay.snapshot, first.snapshot, '重放应原样返回上次的快照');
  assert.equal(operationCount(db), operations, '重放不该写第二条操作日志');
  assert.equal(historyLength('explicit'), history, '重放不该追加第二条 history');
  assert.equal((await getSnapshot(router)).explicit.length, 1, '重放不该插入第二条习惯');
});

test('写操作留下的操作日志带 settings.* 的 operation_type 与中文摘要', async () => {
  const { db, router } = setup();
  const snapshot = await getSnapshot(router);

  await post(router, '/api/settings/explicit', {
    statement: '上午只做深度工作',
    expected_version: snapshot.versions.explicit,
  });

  const row = db
    .prepare('SELECT operation_type, target_type, summary FROM operations ORDER BY rowid DESC')
    .get() as Row;
  assert.equal(row.operation_type, 'settings.explicit.create');
  assert.equal(row.target_type, 'habit');
  assert.match(String(row.summary), /明确习惯/);
});

// ── 8. 既有的 /api/habits 读面没有被这轮改动动过 ──────────────────────────────

test('GET /api/habits 仍返回四个文件信封（Agent runtime 与 queue scorer 依赖它）', async () => {
  const { router } = setup();
  const habits = await callRoute<Record<string, Record<string, unknown>>>(
    router,
    'GET',
    '/api/habits',
  );

  for (const name of ['explicit', 'inferred', 'constraints', 'weights'] as const) {
    assert.deepEqual(
      Object.keys(habits[name]).sort(),
      ['history', 'payload', 'schema_version', 'updated_at'],
      `/api/habits 的 ${name} 应仍是完整信封`,
    );
    assert.equal(habits[name].schema_version, HABIT_SCHEMA_VERSION);
  }
  // 换算系数在这里仍住在 weights.payload 里——摊平只发生在 /api/settings。
  const weights = habits.weights.payload as Record<string, unknown>;
  assert.equal(weights.hours_per_day, DEFAULT_HOURS_PER_DAY);
  assert.equal(weights.days_per_month, DEFAULT_DAYS_PER_MONTH);
});

test.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
