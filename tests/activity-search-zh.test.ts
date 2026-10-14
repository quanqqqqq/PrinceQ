/**
 * /activity 的中文操作内容搜索。
 *
 * 落库的 summary 是英文（`Changed quadrant of "..." to q2`），时间线上渲染成中文
 * （`将「示例：阅读 SQLite WAL 设计文档并做笔记」的象限改为重要不紧急`）。用户搜的是
 * 看到的那串中文，所以 `listOperations` 必须用与界面同一套规则渲染后再比对。
 *
 * 覆盖三层：
 *  1. `renderOperationSummaryZh` 的渲染结果本身；
 *  2. `escapeLike` 对 LIKE 通配符的转义；
 *  3. `listOperations` 的中文摘要命中、中文标题别名命中、全表（非当前页）覆盖。
 *
 * 全部跑在一次性内存 SQLite 上，habits 指向临时目录——绝不触碰 data/work-queue.db。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, withTempHabits } from './helpers.ts';
import {
  escapeLike,
  matchesSearchText,
  normalizeSearchText,
  renderOperationSummaryZh,
} from '../shared/activity-summary.ts';
import { listOperations } from '../server/repo/operations.ts';
import { run as runSql, type Db } from '../server/db/connection.ts';

withTempHabits();

const DEMO_TITLE = 'Demo: Read the SQLite WAL design doc and take notes';

/** 一条 is_demo 的任务 + 一条象限变更操作，和真实写入的形状一致。 */
function seedQuadrantChange(db: Db): void {
  runSql(
    db,
    `INSERT INTO tasks (id, title, is_demo, created_at, updated_at)
     VALUES ('task_wal_1', ?, 1, '2026-10-12T10:00:00.000Z', '2026-10-12T10:00:00.000Z')`,
    [DEMO_TITLE],
  );
  runSql(
    db,
    `INSERT INTO operations
       (id, idempotency_key, operation_type, target_type, target_id, actor_id, status, summary, created_at)
     VALUES ('op_wal_1', 'key-wal-1', 'task.quadrant.change', 'task', 'task_wal_1',
             'actor-human-me', 'succeeded', ?, '2026-10-12T10:01:00.000Z')`,
    [`Changed quadrant of "${DEMO_TITLE}" to q2`],
  );
}

// ── 1. 渲染 ─────────────────────────────────────────────────────────────────

test('renderOperationSummaryZh 把象限变更渲染成中文，含象限名与示例标题别名', () => {
  const rendered = renderOperationSummaryZh({
    summary: `Changed quadrant of "${DEMO_TITLE}" to q2`,
    operation_type: 'task.quadrant.change',
    target_type: 'task',
  });
  assert.ok(rendered.includes('重要不紧急'), `应含象限中文名，实际：${rendered}`);
  assert.ok(rendered.includes('改为'), `应含动作中文，实际：${rendered}`);
  assert.ok(
    rendered.includes('示例：阅读 SQLite WAL 设计文档并做笔记'),
    `示例标题应显示中文别名，实际：${rendered}`,
  );
});

test('renderOperationSummaryZh 不改写用户自己录入的标题', () => {
  const rendered = renderOperationSummaryZh({ summary: 'Created task "我的自定义任务"' });
  assert.equal(rendered, '创建任务「我的自定义任务」');
});

test('renderOperationSummaryZh 对空值与认不出的文本保持安全', () => {
  assert.equal(renderOperationSummaryZh({ summary: null }), '');
  assert.equal(renderOperationSummaryZh({ summary: '' }), '');
  // 规则与系统词典都匹配不上时原样返回，绝不吞掉内容。
  assert.equal(renderOperationSummaryZh({ summary: 'Totally unknown phrase' }), 'Totally unknown phrase');
});

// ── 2. LIKE 转义 ────────────────────────────────────────────────────────────

test('escapeLike 转义 LIKE 的通配符与转义符本身', () => {
  assert.equal(escapeLike('50%'), '50\\%');
  assert.equal(escapeLike('a_b'), 'a\\_b');
  assert.equal(escapeLike('a\\b'), 'a\\\\b');
  assert.equal(escapeLike('普通文本'), '普通文本');
});

test('normalizeSearchText 做 trim + 小写', () => {
  assert.equal(normalizeSearchText('  Alpha  '), 'alpha');
  assert.equal(normalizeSearchText('改为重要不紧急'), '改为重要不紧急');
});

test('matchesSearchText 既认直接子串，也认忽略空白后的子串', () => {
  assert.equal(matchesSearchText('示例：阅读 SQLite WAL 设计文档并做笔记', '阅读 SQLite'), true);
  // 中文夹英文时用户常不打空格。
  assert.equal(matchesSearchText('示例：阅读 SQLite WAL 设计文档并做笔记', '阅读SQLite WAL'), true);
  assert.equal(matchesSearchText('Changed quadrant of "X" to q2', 'changed quadrant'), true);
  assert.equal(matchesSearchText('示例：阅读 SQLite WAL 设计文档并做笔记', '不存在xyz'), false);
  // 空搜索词不应变成「匹配一切」。
  assert.equal(matchesSearchText('任意文本', '   '), false);
});

test('带通配符的搜索词按字面量匹配，不被当成通配', () => {
  const db = freshDb();
  runSql(
    db,
    `INSERT INTO operations
       (id, idempotency_key, operation_type, target_type, target_id, actor_id, status, summary, created_at)
     VALUES ('op_pct_1', 'key-pct-1', 'habit.weights.update', 'habit', NULL,
             'actor-human-me', 'succeeded', 'Updated scoring weights (deadline 50%)', '2026-10-12T10:00:00.000Z'),
            ('op_pct_2', 'key-pct-2', 'habit.weights.update', 'habit', NULL,
             'actor-human-me', 'succeeded', 'Updated scoring weights (deadline 5 then 0)', '2026-10-12T10:01:00.000Z')`,
  );

  const ids = listOperations(db, { query: '50%' }).map((o) => o.id);
  assert.deepEqual(ids, ['op_pct_1'], '`%` 应按字面量匹配，不展开成通配符');
});

// ── 3. listOperations 的中文命中 ────────────────────────────────────────────

test('中文动作文案「改为重要不紧急」能命中英文落库的象限变更', () => {
  const db = freshDb();
  seedQuadrantChange(db);

  assert.ok(
    listOperations(db, { query: '改为重要不紧急' }).some((o) => o.id === 'op_wal_1'),
    '界面上看到的中文摘要应能搜到这条操作',
  );
});

test('中文标题别名与英文原值都能命中，无关词不命中', () => {
  const db = freshDb();
  seedQuadrantChange(db);

  assert.ok(
    listOperations(db, { query: '阅读SQLite WAL' }).some((o) => o.id === 'op_wal_1'),
    '中文摘要里的标题别名（含空格差异）应命中',
  );
  assert.ok(
    listOperations(db, { query: 'Changed quadrant' }).some((o) => o.id === 'op_wal_1'),
    '落库的英文原值仍应命中',
  );
  assert.ok(
    !listOperations(db, { query: '不存在xyz' }).some((o) => o.id === 'op_wal_1'),
    '无关词不应命中',
  );
});

test('中文摘要命中覆盖全表，而不只是当前页的前 N 条', () => {
  const db = freshDb();
  // 目标操作排在最旧：先插 5 条更新的噪声，再用 limit=2 查询。
  // 若命中集合来自已被 LIMIT 截断的页，这条就会被漏掉。
  seedQuadrantChange(db);
  for (let i = 0; i < 5; i += 1) {
    runSql(
      db,
      `INSERT INTO operations
         (id, idempotency_key, operation_type, target_type, target_id, actor_id, status, summary, created_at)
       VALUES (?, ?, 'task.create', 'task', NULL, 'actor-human-me', 'succeeded', ?, ?)`,
      [`op_noise_${i}`, `key-noise-${i}`, `Created task "Noise ${i}"`, `2026-10-13T1${i}:00:00.000Z`],
    );
  }

  const hits = listOperations(db, { query: '改为重要不紧急', limit: 2 });
  assert.ok(
    hits.some((o) => o.id === 'op_wal_1'),
    '最旧的那条中文摘要匹配项也要能搜到',
  );
});

test('type / from / to 过滤与中文摘要命中是 AND 叠加', () => {
  const db = freshDb();
  seedQuadrantChange(db);

  assert.equal(
    listOperations(db, { query: '改为重要不紧急', type: 'task.create' }).length,
    0,
    'type 不匹配时中文命中不应越过过滤器',
  );
  assert.ok(
    listOperations(db, { query: '改为重要不紧急', type: 'task.quadrant.change' }).some(
      (o) => o.id === 'op_wal_1',
    ),
    'type 匹配时仍能命中',
  );
  assert.equal(
    listOperations(db, { query: '改为重要不紧急', from: '2026-11-01T00:00:00.000Z' }).length,
    0,
    'from 晚于该操作时应被排除',
  );
});
