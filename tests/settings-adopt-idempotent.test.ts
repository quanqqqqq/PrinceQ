/**
 * `POST /api/settings/inferred/:id/adopt` 的幂等性测试。
 *
 * 采纳是「一条 inferred → 一条 explicit」的一次性动作，但现实里这个按钮会被重复
 * 点、客户端会重试，而 `withOperation` 的幂等只认 Idempotency-Key——换一个 key 的
 * 同一次采纳曾经照样 append 第二条 explicit（真实数据里出现过三条）。这份测试守住
 * 修复后的行为：
 *
 * - 第二次采纳**没有任何副作用**：explicit 条数、history 长度、operations 条数
 *   三个计数全部不变（相同 key 与不同 key 都如此），返回体带 `already: true`。
 * - 原 inferred 被停用后再采纳，仍然命中幂等路径，不重复建、不重复停用。
 * - 并发语义靠现有版本校验兜底：带过期 `expected_explicit_version` 的第二个请求
 *   被判 409，而不是写出第二条。
 * - 历史上已经存在的重复数据（同一 inferred 对应多条 explicit）一条都不碰，
 *   预检返回**第一条**。
 *
 * 隔离方式与 `tests/settings.test.ts` 同源：`freshDb()` 的一次性内存库 +
 * `os.tmpdir()` 下的临时 habits 目录。因为 `server/config.ts` 在模块求值那一刻就
 * 把 `PWQ_HABITS_DIR` 读成常量，这里必须**先设环境变量、再动态 import** 服务端
 * 模块（静态 import 会被提升到赋值之前）。用户真实的 `data/` 与 `habits/` 永不被
 * 触碰。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pwq-adopt-'));
// 必须早于 server/config.ts 第一次求值。
process.env.PWQ_HABITS_DIR = path.join(tempRoot, 'habits');
process.env.PWQ_DB_PATH = path.join(tempRoot, 'unused.db');

const { freshDb } = await import('./helpers.ts');
const { buildRouter } = await import('../server/http/routes.ts');
const { ApiError } = await import('../server/lib/errors.ts');
const { ensureHabitFiles, findExistingAdoption, readHabitFile, writeHabitFile } = await import(
  '../server/domain/habits.ts'
);
import type { Db, Row } from '../server/db/connection.ts';
import type { HabitEntry, SettingsSnapshot } from '../shared/types.ts';

type Router = ReturnType<typeof buildRouter>;

/** 采纳的返回体：快照永远在，幂等命中时多带两个字段。 */
interface AdoptResponse {
  snapshot: SettingsSnapshot;
  already?: boolean;
  existing_id?: string;
}

/** 每个用例都从一套干净的习惯文件 + 一个空内存库开始。 */
function setup(): { db: Db; router: Router } {
  fs.rmSync(process.env.PWQ_HABITS_DIR!, { recursive: true, force: true });
  ensureHabitFiles();
  const db = freshDb();
  return { db, router: buildRouter(() => db) };
}

let keyCounter = 0;
const nextKey = (): string => `adopt-test-${(keyCounter += 1)}`;

/** 按真实路径调用一条路由；`ctx` 只给对应 handler 实际会读的字段。 */
async function callRoute<T>(
  router: Router,
  method: 'GET' | 'POST',
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

/** 一次采纳调用。`key` 不给就用新的，用来区分「相同 key」与「不同 key」两种重放。 */
const adopt = (
  router: Router,
  id: string,
  body: { expected_version: string; expected_explicit_version: string },
  key = nextKey(),
) =>
  callRoute<AdoptResponse>(router, 'POST', `/api/settings/inferred/${id}/adopt`, {
    body,
    idempotencyKey: key,
  });

const operationCount = (db: Db): number =>
  Number((db.prepare('SELECT COUNT(*) AS n FROM operations').get() as Row).n);

const historyLength = (name: 'explicit' | 'inferred'): number => readHabitFile(name).history.length;

/** 三个计数一起拍快照：任何一个变了都说明这次调用留下了副作用。 */
const counts = (db: Db) => ({
  explicit: readHabitFile('explicit').payload.entries.length,
  explicitHistory: historyLength('explicit'),
  inferredHistory: historyLength('inferred'),
  operations: operationCount(db),
});

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

/**
 * 直接往 explicit 文件里塞一条带 `source_relation` 的采纳结果。
 *
 * 用来复现「历史上已经写出了多条」的真实数据形态——这种数据只能被读、被识别，
 * 不能被测试代码之外的任何逻辑改写或清理。
 */
function seedAdoptedExplicit(inferredId: string, statement: string): string {
  const file = readHabitFile('explicit');
  const id = `habit_adopted_${file.payload.entries.length + 1}`;
  const at = new Date(Date.now() + 1).toISOString();
  writeHabitFile('explicit', {
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
          confidence: null,
          source: 'user',
          source_relation: { type: 'adopted_from_inferred', inferred_id: inferredId },
          created_at: at,
          updated_at: at,
        },
      ],
    },
    history: [{ at, actor: 'test', change: 'seeded adopted explicit habit' }, ...file.history],
  });
  return id;
}

/** 取 explicit 里所有指回某条 inferred 的条目——断言「只有一条」用。 */
const adoptionsOf = (inferredId: string): HabitEntry[] =>
  (readHabitFile('explicit').payload.entries as HabitEntry[]).filter((entry) => {
    const relation = entry.source_relation as { type?: unknown; inferred_id?: unknown } | undefined;
    return relation?.type === 'adopted_from_inferred' && relation?.inferred_id === inferredId;
  });

// ── 1. 首次采纳：正常建一条 ──────────────────────────────────────────────────

test('首次 adopt → 1 条带 source_relation 的 explicit，原 inferred 变 enabled:false', async () => {
  const { router } = setup();
  const id = seedInferred('你更愿意把同类沟通攒到一起处理', 0.82);
  const snapshot = await getSnapshot(router);

  const result = await adopt(router, id, {
    expected_version: snapshot.versions.inferred,
    expected_explicit_version: snapshot.versions.explicit,
  });

  // 首次采纳走的是真正的写路径，不该带幂等标记。
  assert.equal(result.already, undefined, '首次采纳不是幂等命中');

  assert.equal(result.snapshot.explicit.length, 1);
  const entry = result.snapshot.explicit[0];
  assert.equal(entry.statement, '你更愿意把同类沟通攒到一起处理');
  assert.equal(entry.source, 'user', '采纳之后它就是用户自己说的话');
  assert.equal(entry.confidence, null, '采纳后置信度（观察的不确定性）不再适用');
  assert.deepEqual(entry.source_relation, { type: 'adopted_from_inferred', inferred_id: id });

  // 原推断条目保留（来源证据），只是被停用。
  assert.equal(result.snapshot.inferred.length, 1, '采纳不该删除原推断条目');
  assert.equal(result.snapshot.inferred[0].id, id);
  assert.equal(result.snapshot.inferred[0].enabled, false);

  assert.equal(adoptionsOf(id).length, 1);
});

// ── 2/3. 重放：相同 key 与不同 key 都不许留下任何副作用 ───────────────────────

for (const mode of ['相同', '不同'] as const) {
  test(`再次 adopt（${mode} Idempotency-Key）→ 返回已存在条目，三个计数全部不变`, async () => {
    const { db, router } = setup();
    const id = seedInferred('你倾向于在周五收尾杂事');
    const first = await getSnapshot(router);

    const firstKey = nextKey();
    const created = await adopt(
      router,
      id,
      {
        expected_version: first.versions.inferred,
        expected_explicit_version: first.versions.explicit,
      },
      firstKey,
    );
    const createdId = created.snapshot.explicit[0].id;
    const before = counts(db);

    // 第二次带的是采纳后的最新版本号——即「用户又点了一下」的真实形态。
    const after = await getSnapshot(router);
    const replay = await adopt(
      router,
      id,
      {
        expected_version: after.versions.inferred,
        expected_explicit_version: after.versions.explicit,
      },
      mode === '相同' ? firstKey : nextKey(),
    );

    // 返回体：完整快照 + 指回已有条目。
    assert.equal(replay.already, true, `${mode} key 的重放应标记为幂等命中`);
    assert.equal(replay.existing_id, createdId, '应指回首次采纳生成的那条');
    assert.ok(replay.snapshot.versions.explicit, 'snapshot 仍是完整快照');
    assert.equal(replay.snapshot.explicit.length, 1);

    // 零副作用：文件没写、history 没长、操作日志没多一条。
    assert.deepEqual(counts(db), before, `${mode} key 的重放不该产生任何副作用`);
    assert.equal(adoptionsOf(id).length, 1, '不该出现第二条采纳结果');
    // 文件没被写过，所以版本号也不动。
    assert.deepEqual(replay.snapshot.versions, after.versions, '幂等返回不该推进任何版本');
  });
}

// ── 4. 原 inferred 已被停用后再采纳 ──────────────────────────────────────────

test('原 inferred 被手动停用后再 adopt → 仍返回已有条目，不重复建也不重复停用', async () => {
  const { db, router } = setup();
  const id = seedInferred('你习惯在晚间处理阅读类任务');
  const first = await getSnapshot(router);
  const created = await adopt(router, id, {
    expected_version: first.versions.inferred,
    expected_explicit_version: first.versions.explicit,
  });

  // 手动再停用一次（采纳已经把它停了，这里模拟用户又去动了开关）。
  const mid = await getSnapshot(router);
  await callRoute(router, 'POST', `/api/settings/inferred/${id}/enabled`, {
    body: { enabled: false, expected_version: mid.versions.inferred },
    idempotencyKey: nextKey(),
  });

  const before = counts(db);
  const afterSnapshot = await getSnapshot(router);
  const replay = await adopt(router, id, {
    expected_version: afterSnapshot.versions.inferred,
    expected_explicit_version: afterSnapshot.versions.explicit,
  });

  assert.equal(replay.already, true);
  assert.equal(replay.existing_id, created.snapshot.explicit[0].id);
  assert.deepEqual(counts(db), before, '停用后的重复采纳同样不该有副作用');
  assert.equal(adoptionsOf(id).length, 1);
  assert.equal(replay.snapshot.inferred[0].enabled, false, '原条目仍是停用，没被再写一次');
});

// ── 5. 并发：第二个请求带过期版本号 → 409，而不是第二条 ───────────────────────

test('并发/旧版本：第二个请求带过期 expected_explicit_version → 409，explicit 仍只有 1 条', async () => {
  const { db, router } = setup();
  const idA = seedInferred('你喜欢上午先清掉短任务');
  const idB = seedInferred('你偏好把评审集中在下午');
  // 两个并发请求在同一时刻各自读到了同一份快照。
  const shared = await getSnapshot(router);

  // 第一个请求成功，推进了 explicit 与 inferred 的版本。
  await adopt(router, idA, {
    expected_version: shared.versions.inferred,
    expected_explicit_version: shared.versions.explicit,
  });
  const before = counts(db);

  // 第二个请求还攥着旧版本号：它采纳的是另一条 inferred，所以预检不会命中幂等，
  // 必须被版本校验挡住——否则就是在一份过期的认知上写文件。
  await assert.rejects(
    () =>
      adopt(router, idB, {
        expected_version: shared.versions.inferred,
        expected_explicit_version: shared.versions.explicit,
      }),
    (error: unknown) => {
      assert.ok(error instanceof ApiError, `expected ApiError, got ${String(error)}`);
      assert.equal(error.status, 409);
      assert.equal(error.code, 'version_conflict');
      return true;
    },
  );

  const snapshot = await getSnapshot(router);
  assert.equal(snapshot.explicit.length, 1, '被拒的并发请求不该写出第二条 explicit');
  assert.equal(adoptionsOf(idB).length, 0, '被拒的请求不该留下采纳痕迹');
  assert.equal(
    snapshot.inferred.find((entry) => entry.id === idB)?.enabled,
    true,
    '被拒的 adopt 不该停用它的源条目',
  );
  assert.deepEqual(counts(db), before, '被拒的 adopt 不该留下任何副作用');
});

// ── 6. 历史重复数据：认第一条，一条都不碰 ────────────────────────────────────

test('历史上已有两条重复采纳 → 返回第一条，不建第三条、不改动已有记录', async () => {
  const { db, router } = setup();
  const id = seedInferred('你倾向于把会议排在同一个半天');
  // 预置两条都指回同一条 inferred 的 explicit——修复前重复点击留下的真实形态。
  const firstId = seedAdoptedExplicit(id, '你倾向于把会议排在同一个半天');
  const secondId = seedAdoptedExplicit(id, '你倾向于把会议排在同一个半天');

  // 纯读 helper 自己也要认第一条。
  assert.equal(findExistingAdoption(id)?.id, firstId);

  const before = counts(db);
  assert.equal(before.explicit, 2, '预置数据应有两条');

  const snapshot = await getSnapshot(router);
  const replay = await adopt(router, id, {
    expected_version: snapshot.versions.inferred,
    expected_explicit_version: snapshot.versions.explicit,
  });

  assert.equal(replay.already, true);
  assert.equal(replay.existing_id, firstId, '应返回最早的那条，而不是最后一条');
  assert.equal(replay.snapshot.explicit.length, 2, '不该建第三条');
  assert.deepEqual(counts(db), before, '面对历史重复数据同样零副作用');

  // 两条历史记录都原样留着：不区分谁是用户操作、谁是重复写入，所以一条都不碰。
  const ids = replay.snapshot.explicit.map((entry) => entry.id);
  assert.deepEqual(ids, [firstId, secondId], '已有记录不该被删除或重排');
});

// ── 7. 未采纳过的 id 不该误命中 ──────────────────────────────────────────────

test('findExistingAdoption：没采纳过返回 null，不与别的 inferred 串台', async () => {
  const { router } = setup();
  const idA = seedInferred('你喜欢把写作安排在清晨');
  const idB = seedInferred('你喜欢把杂事留到傍晚');
  assert.equal(findExistingAdoption(idA), null);

  const snapshot = await getSnapshot(router);
  await adopt(router, idA, {
    expected_version: snapshot.versions.inferred,
    expected_explicit_version: snapshot.versions.explicit,
  });

  assert.ok(findExistingAdoption(idA), 'A 已采纳');
  assert.equal(findExistingAdoption(idB), null, 'B 没采纳过，不该被 A 的记录命中');

  // 所以 B 还能正常走真正的写路径。
  const next = await getSnapshot(router);
  const adoptedB = await adopt(router, idB, {
    expected_version: next.versions.inferred,
    expected_explicit_version: next.versions.explicit,
  });
  assert.equal(adoptedB.already, undefined, 'B 是首次采纳，不是幂等命中');
  assert.equal(adoptionsOf(idB).length, 1);
  assert.equal(adoptedB.snapshot.explicit.length, 2);
});
