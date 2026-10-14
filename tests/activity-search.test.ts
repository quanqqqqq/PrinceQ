/**
 * 活动记录的中文多词全文搜索。
 *
 * 搜索框里输入两个词时，用户要的是「同时提到这两件事的那条」，而不是「提到任意
 * 一个的所有条」——所以 token 之间是 AND。中文不需要分词：一段连续汉字就是一个
 * token，按子串匹配即全文匹配；真正要切的只有空白。
 *
 * 匹配面覆盖任务/目标标题、`summary`（英文原值与渲染后的中文）和 `detail` 里的
 * JSON 文本。渲染与别名那两层已由 `activity-search-zh.test.ts` 覆盖，本文件专注
 * 多 token 的 AND 语义与 detail 字段。
 *
 * 全部跑在一次性内存 SQLite 上，habits 指向临时目录——绝不触碰 data/work-queue.db。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, withTempHabits } from './helpers.ts';
import { listOperations } from '../server/repo/operations.ts';
import { run as runSql, type Db } from '../server/db/connection.ts';

withTempHabits();

/** 两条 summary 中文各不相同的操作，外加一条 detail 里才有中文的。 */
function seedChineseOperations(db: Db): void {
  runSql(
    db,
    `INSERT INTO operations
       (id, idempotency_key, operation_type, target_type, target_id, actor_id, status, summary, detail, created_at)
     VALUES
       ('op_zh_1', 'key-zh-1', 'task.create', 'task', NULL, 'actor-human-me', 'succeeded',
        '创建任务「季度目标 对账流程梳理」', NULL, '2026-10-12T10:00:00.000Z'),
       ('op_zh_2', 'key-zh-2', 'task.create', 'task', NULL, 'actor-human-me', 'succeeded',
        '创建任务「季度目标 招聘面试安排」', NULL, '2026-10-12T10:01:00.000Z'),
       ('op_zh_3', 'key-zh-3', 'task.matrix.rescore.confirm', 'task', NULL, 'actor-human-me', 'succeeded',
        'Rescore confirmed', ?, '2026-10-12T10:02:00.000Z')`,
    [JSON.stringify({ agent_name: '外部Agent', reason: '季度目标影响重估，优先级下调' })],
  );
}

const idsFor = (db: Db, query: string): string[] =>
  listOperations(db, { query }).map((o) => o.id);

// ── 单 token：与改造前行为一致 ───────────────────────────────────────────────

test('单个中文 token 按子串命中，不需要分词', () => {
  const db = freshDb();
  seedChineseOperations(db);

  const hits = idsFor(db, '对账流程');
  assert.deepEqual(hits, ['op_zh_1'], '连续汉字应作为一个 token 做子串匹配');
});

test('单个 token 同时命中多条时都返回', () => {
  const db = freshDb();
  seedChineseOperations(db);

  const hits = idsFor(db, '季度目标');
  assert.deepEqual(
    new Set(hits),
    new Set(['op_zh_1', 'op_zh_2', 'op_zh_3']),
    '共有的词应命中全部三条（其中一条只在 detail 里出现）',
  );
});

// ── 多 token：AND ───────────────────────────────────────────────────────────

test('多个 token 之间是 AND：全部命中才算命中', () => {
  const db = freshDb();
  seedChineseOperations(db);

  // 「季度目标」三条都有，「对账流程」只有第一条有 → 交集只剩第一条。
  assert.deepEqual(idsFor(db, '季度目标 对账流程'), ['op_zh_1']);
  assert.deepEqual(idsFor(db, '季度目标 招聘面试'), ['op_zh_2']);
  // 顺序无关。
  assert.deepEqual(idsFor(db, '对账流程 季度目标'), ['op_zh_1']);
});

test('任一 token 落空则整条不命中', () => {
  const db = freshDb();
  seedChineseOperations(db);

  assert.deepEqual(
    idsFor(db, '季度目标 不存在的词xyz'),
    [],
    '一个 token 没命中就不该返回任何行（AND 而非 OR）',
  );
  // 两个词分别命中不同的行，没有一行同时包含两者。
  assert.deepEqual(idsFor(db, '对账流程 招聘面试'), []);
});

test('多余空白被忽略，重复 token 不改变结果', () => {
  const db = freshDb();
  seedChineseOperations(db);

  assert.deepEqual(idsFor(db, '  季度目标   对账流程  '), ['op_zh_1']);
  assert.deepEqual(idsFor(db, '季度目标 季度目标 对账流程'), ['op_zh_1']);
});

// ── detail 里的中文 ─────────────────────────────────────────────────────────

test('detail JSON 里的中文也能被搜到', () => {
  const db = freshDb();
  seedChineseOperations(db);

  // 这条的 summary 是英文，中文只存在于 detail 的 reason / agent_name 里。
  assert.deepEqual(idsFor(db, '优先级下调'), ['op_zh_3']);
  assert.deepEqual(idsFor(db, '外部Agent'), ['op_zh_3']);
  // detail 与 summary 的 token 可以跨字段 AND 命中同一行。
  assert.deepEqual(idsFor(db, 'Rescore 优先级下调'), ['op_zh_3']);
});

// ── 英文大小写与通配符 ──────────────────────────────────────────────────────

test('英文 token 大小写不敏感，多词同样是 AND', () => {
  const db = freshDb();
  runSql(
    db,
    `INSERT INTO operations
       (id, idempotency_key, operation_type, target_type, target_id, actor_id, status, summary, created_at)
     VALUES
       ('op_en_1', 'key-en-1', 'task.create', 'task', NULL, 'actor-human-me', 'succeeded',
        'Created task "Billing Pipeline Rewrite"', '2026-10-12T10:00:00.000Z'),
       ('op_en_2', 'key-en-2', 'task.create', 'task', NULL, 'actor-human-me', 'succeeded',
        'Created task "Billing Report Export"', '2026-10-12T10:01:00.000Z')`,
  );

  assert.deepEqual(idsFor(db, 'BILLING pipeline'), ['op_en_1']);
  assert.deepEqual(idsFor(db, 'billing export'), ['op_en_2']);
  assert.deepEqual(
    new Set(idsFor(db, 'billing')),
    new Set(['op_en_1', 'op_en_2']),
    '单 token 仍然返回全部命中',
  );
});

test('多 token 里带通配符的词仍按字面量匹配', () => {
  const db = freshDb();
  runSql(
    db,
    `INSERT INTO operations
       (id, idempotency_key, operation_type, target_type, target_id, actor_id, status, summary, created_at)
     VALUES
       ('op_pct_a', 'key-pct-a', 'habit.weights.update', 'habit', NULL, 'actor-human-me', 'succeeded',
        '调整评分权重（deadline 50%）', '2026-10-12T10:00:00.000Z'),
       ('op_pct_b', 'key-pct-b', 'habit.weights.update', 'habit', NULL, 'actor-human-me', 'succeeded',
        '调整评分权重（deadline 5 then 0）', '2026-10-12T10:01:00.000Z')`,
  );

  assert.deepEqual(
    idsFor(db, '评分权重 50%'),
    ['op_pct_a'],
    '`%` 应按字面量参与 AND，不展开成通配符',
  );
});

// ── 与其它过滤器叠加 ────────────────────────────────────────────────────────

test('多 token 命中与 type / from 过滤是 AND 叠加', () => {
  const db = freshDb();
  seedChineseOperations(db);

  // 先确认这个查询本身是有命中的，否则下面的 0 说明不了任何事。
  assert.deepEqual(idsFor(db, '季度目标 对账流程'), ['op_zh_1']);

  assert.equal(
    listOperations(db, { query: '季度目标 对账流程', type: 'goal.create' }).length,
    0,
    'type 不匹配时多 token 命中不应越过过滤器',
  );
  assert.deepEqual(
    listOperations(db, { query: '季度目标 对账流程', type: 'task.create' }).map((o) => o.id),
    ['op_zh_1'],
  );
  assert.equal(
    listOperations(db, { query: '季度目标 对账流程', from: '2026-11-01T00:00:00.000Z' }).length,
    0,
    'from 晚于该操作时应被排除',
  );
});
