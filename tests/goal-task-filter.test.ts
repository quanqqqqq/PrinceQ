/**
 * Unit tests for the pure helpers behind the goal detail panel's linked-task
 * list: the status/type/quadrant breakdown, the three combinable filters, the
 * "待评分" bucket for unscored tasks, and the empty-collection edge cases.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_GOAL_TASK_FILTERS,
  GOAL_FILTER_ALL,
  GOAL_QUADRANT_FILTER_UNSCORED,
  describeActiveGoalTaskFilters,
  filterGoalTasks,
  goalTaskBreakdown,
  goalTaskMatches,
  goalTaskQuadrantBucket,
  hasActiveGoalTaskFilters,
  type GoalTaskFilters,
  type GoalTaskLike,
} from '../shared/goal-task-filter.ts';

/** A linked task carrying only the fields the helpers read. */
const task = (id: string, overrides: Partial<GoalTaskLike> = {}): GoalTaskLike => ({
  id,
  status: 'inbox',
  task_type: null,
  matrix_importance_score: null,
  matrix_urgency_score: null,
  matrix_score_source: 'unset',
  importance: null,
  urgency: null,
  ...overrides,
});

/** Scored on both axes, so the task lands in a real quadrant. */
const scored = (
  id: string,
  importance: number,
  urgency: number,
  overrides: Partial<GoalTaskLike> = {},
): GoalTaskLike =>
  task(id, {
    matrix_importance_score: importance,
    matrix_urgency_score: urgency,
    matrix_score_source: 'agent',
    ...overrides,
  });

const filters = (overrides: Partial<GoalTaskFilters> = {}): GoalTaskFilters => ({
  ...DEFAULT_GOAL_TASK_FILTERS,
  ...overrides,
});

/** The shared fixture: six tasks spread over the statuses, types and quadrants. */
const sample: GoalTaskLike[] = [
  scored('a', 80, 80, { status: 'in_progress', task_type: 'deep_work' }), // q1
  scored('b', 80, 20, { status: 'inbox', task_type: 'deep_work' }), // q2
  scored('c', 20, 80, { status: 'inbox', task_type: 'communication' }), // q3
  scored('d', 10, 10, { status: 'completed', task_type: 'admin' }), // q4
  task('e', { status: 'inbox', task_type: 'deep_work' }), // unscored
  task('f', { status: 'blocked' }), // unscored, no type
];

const ids = (tasks: GoalTaskLike[]): string[] => tasks.map((item) => item.id);

// ── quadrant bucket ─────────────────────────────────────────────────────────

test('goalTaskQuadrantBucket derives the quadrant from the continuous scores', () => {
  assert.equal(goalTaskQuadrantBucket(scored('t', 80, 80)), 'q1');
  assert.equal(goalTaskQuadrantBucket(scored('t', 80, 20)), 'q2');
  assert.equal(goalTaskQuadrantBucket(scored('t', 20, 80)), 'q3');
  assert.equal(goalTaskQuadrantBucket(scored('t', 20, 20)), 'q4');
  assert.equal(goalTaskQuadrantBucket(scored('t', 50, 50)), 'q1', '50 is high on both axes');
});

test('goalTaskQuadrantBucket ignores the stored quadrant column', () => {
  // The task claims q1, but only the scores decide — same rule as /matrix.
  const task = scored('t', 10, 10, { quadrant: 'q1' });
  assert.equal(goalTaskQuadrantBucket(task), 'q4');
});

test('goalTaskQuadrantBucket reports 待评分 for a task with no usable score', () => {
  assert.equal(goalTaskQuadrantBucket(task('t')), GOAL_QUADRANT_FILTER_UNSCORED);
  assert.equal(
    goalTaskQuadrantBucket(task('t', { matrix_importance_score: 60 })),
    GOAL_QUADRANT_FILTER_UNSCORED,
    'one axis alone is not a placement',
  );
  assert.equal(
    goalTaskQuadrantBucket(task('t', { matrix_importance_score: 120, matrix_urgency_score: 60 })),
    GOAL_QUADRANT_FILTER_UNSCORED,
    'an out-of-range score is not usable',
  );
  // The legacy 1..5 integers still place a task, so it is not "待评分".
  assert.equal(goalTaskQuadrantBucket(task('t', { importance: 5, urgency: 1 })), 'q2');
});

// ── single filters ──────────────────────────────────────────────────────────

test('the default filters pass every task', () => {
  assert.equal(hasActiveGoalTaskFilters(DEFAULT_GOAL_TASK_FILTERS), false);
  for (const item of sample) {
    assert.equal(goalTaskMatches(item, DEFAULT_GOAL_TASK_FILTERS), true, item.id);
  }
});

test('hasActiveGoalTaskFilters reports each filter on its own', () => {
  assert.equal(hasActiveGoalTaskFilters(filters({ status: 'inbox' })), true);
  assert.equal(hasActiveGoalTaskFilters(filters({ type: 'deep_work' })), true);
  assert.equal(hasActiveGoalTaskFilters(filters({ quadrant: 'q1' })), true);
  assert.equal(
    hasActiveGoalTaskFilters(filters({ quadrant: GOAL_QUADRANT_FILTER_UNSCORED })),
    true,
    '待评分 narrows the list like any other value',
  );
});

test('the status filter keeps only that status', () => {
  assert.deepEqual(ids(filterGoalTasks(sample, filters({ status: 'inbox' })).tasks), [
    'b',
    'c',
    'e',
  ]);
  assert.deepEqual(ids(filterGoalTasks(sample, filters({ status: 'blocked' })).tasks), ['f']);
});

test('the type filter has a dedicated bucket for tasks with no type', () => {
  assert.deepEqual(ids(filterGoalTasks(sample, filters({ type: 'deep_work' })).tasks), [
    'a',
    'b',
    'e',
  ]);
  assert.deepEqual(ids(filterGoalTasks(sample, filters({ type: 'none' })).tasks), ['f']);
  assert.deepEqual(ids(filterGoalTasks(sample, filters({ type: 'review' })).tasks), []);
});

test('the quadrant filter covers the four quadrants and 待评分', () => {
  assert.deepEqual(ids(filterGoalTasks(sample, filters({ quadrant: 'q1' })).tasks), ['a']);
  assert.deepEqual(ids(filterGoalTasks(sample, filters({ quadrant: 'q3' })).tasks), ['c']);
  assert.deepEqual(
    ids(filterGoalTasks(sample, filters({ quadrant: GOAL_QUADRANT_FILTER_UNSCORED })).tasks),
    ['e', 'f'],
  );
});

// ── combined filters ────────────────────────────────────────────────────────

test('the three filters combine as an AND', () => {
  const result = filterGoalTasks(
    sample,
    filters({ status: 'inbox', type: 'deep_work', quadrant: 'q2' }),
  );
  assert.deepEqual(ids(result.tasks), ['b']);
  assert.equal(result.matched, 1);
  assert.equal(result.total, 6, 'the total stays the unfiltered count');
  assert.equal(result.emptyBecauseFiltered, false);
});

test('a combination with no overlap matches nothing and asks for the empty state', () => {
  // `e` is inbox + deep_work but unscored; `b` is the only q2 task.
  const result = filterGoalTasks(
    sample,
    filters({ status: 'inbox', type: 'deep_work', quadrant: GOAL_QUADRANT_FILTER_UNSCORED }),
  );
  assert.deepEqual(ids(result.tasks), ['e']);

  const none = filterGoalTasks(
    sample,
    filters({ status: 'completed', type: 'deep_work', quadrant: 'q4' }),
  );
  assert.deepEqual(none.tasks, []);
  assert.equal(none.matched, 0);
  assert.equal(none.total, 6);
  assert.equal(none.emptyBecauseFiltered, true);
});

test('combining 待评分 with a status narrows to that intersection', () => {
  const result = filterGoalTasks(
    sample,
    filters({ status: 'blocked', quadrant: GOAL_QUADRANT_FILTER_UNSCORED }),
  );
  assert.deepEqual(ids(result.tasks), ['f']);
  assert.equal(result.matched, 1);
});

test('filtering preserves the input order and the original objects', () => {
  const rich = sample.map((item) => ({ ...item, available_actions: ['claim'] as const }));
  const result = filterGoalTasks(rich, filters({ status: 'inbox' }));
  assert.deepEqual(ids(result.tasks), ['b', 'c', 'e']);
  // Generic over the caller's richer shape, so the panel can still use TaskCard.
  assert.deepEqual(result.tasks[0].available_actions, ['claim']);
  assert.equal(result.tasks[0], rich[1], 'the same object is handed back, not a copy');
});

// ── breakdown ───────────────────────────────────────────────────────────────

test('goalTaskBreakdown counts every category over the unfiltered list', () => {
  const breakdown = goalTaskBreakdown(sample);
  assert.equal(breakdown.total, 6);
  assert.deepEqual(breakdown.byStatus, [
    { key: 'inbox', count: 3 },
    { key: 'in_progress', count: 1 },
    { key: 'blocked', count: 1 },
    { key: 'completed', count: 1 },
  ]);
  assert.deepEqual(breakdown.byType, [
    { key: 'deep_work', count: 3 },
    { key: 'communication', count: 1 },
    { key: 'admin', count: 1 },
    { key: 'none', count: 1 },
  ]);
  assert.deepEqual(breakdown.byQuadrant, [
    { key: 'q1', count: 1 },
    { key: 'q2', count: 1 },
    { key: 'q3', count: 1 },
    { key: 'q4', count: 1 },
    { key: GOAL_QUADRANT_FILTER_UNSCORED, count: 2 },
  ]);
});

test('goalTaskBreakdown omits empty buckets and keeps the canonical order', () => {
  const breakdown = goalTaskBreakdown([
    task('a', { status: 'archived', task_type: 'learning' }),
    task('b', { status: 'inbox', task_type: 'learning' }),
  ]);
  assert.deepEqual(
    breakdown.byStatus,
    [
      { key: 'inbox', count: 1 },
      { key: 'archived', count: 1 },
    ],
    'enum order, not insertion order',
  );
  assert.deepEqual(breakdown.byType, [{ key: 'learning', count: 2 }]);
  assert.deepEqual(breakdown.byQuadrant, [{ key: GOAL_QUADRANT_FILTER_UNSCORED, count: 2 }]);
  // Every count sums to the total, so the header numbers always add up.
  const sum = (counts: { count: number }[]) => counts.reduce((n, item) => n + item.count, 0);
  assert.equal(sum(breakdown.byStatus), breakdown.total);
  assert.equal(sum(breakdown.byType), breakdown.total);
  assert.equal(sum(breakdown.byQuadrant), breakdown.total);
});

// ── empty collections ───────────────────────────────────────────────────────

test('an empty goal yields zeroed counts and no categories', () => {
  const breakdown = goalTaskBreakdown([]);
  assert.equal(breakdown.total, 0);
  assert.deepEqual(breakdown.byStatus, []);
  assert.deepEqual(breakdown.byType, []);
  assert.deepEqual(breakdown.byQuadrant, []);
});

test('filtering an empty list never reports the filtered empty state', () => {
  for (const active of [
    DEFAULT_GOAL_TASK_FILTERS,
    filters({ status: 'inbox' }),
    filters({ status: 'inbox', type: 'admin', quadrant: GOAL_QUADRANT_FILTER_UNSCORED }),
  ]) {
    const result = filterGoalTasks([], active);
    assert.deepEqual(result.tasks, []);
    assert.equal(result.matched, 0);
    assert.equal(result.total, 0);
    // A goal with no tasks is its own situation — not "筛选后无匹配".
    assert.equal(result.emptyBecauseFiltered, false);
  }
});

test('GOAL_FILTER_ALL is the sentinel the three filters default to', () => {
  assert.equal(DEFAULT_GOAL_TASK_FILTERS.status, GOAL_FILTER_ALL);
  assert.equal(DEFAULT_GOAL_TASK_FILTERS.type, GOAL_FILTER_ALL);
  assert.equal(DEFAULT_GOAL_TASK_FILTERS.quadrant, GOAL_FILTER_ALL);
});

// ── 选中条件的 chips ─────────────────────────────────────────────────────────

test('describeActiveGoalTaskFilters 全部为 all 时没有任何 chip', () => {
  assert.deepEqual(describeActiveGoalTaskFilters(DEFAULT_GOAL_TASK_FILTERS), []);
});

test('describeActiveGoalTaskFilters 只选状态时只回一条', () => {
  assert.deepEqual(describeActiveGoalTaskFilters(filters({ status: 'in_progress' })), [
    { dimension: 'status', value: 'in_progress' },
  ]);
});

test('describeActiveGoalTaskFilters 把 none 与 unscored 当成真实选中值', () => {
  // 「未指定类型」和「待评分」都是在筛，不是默认的「全部」。
  assert.deepEqual(describeActiveGoalTaskFilters(filters({ type: 'none' })), [
    { dimension: 'type', value: 'none' },
  ]);
  assert.deepEqual(
    describeActiveGoalTaskFilters(filters({ quadrant: GOAL_QUADRANT_FILTER_UNSCORED })),
    [{ dimension: 'quadrant', value: GOAL_QUADRANT_FILTER_UNSCORED }],
  );
});

test('describeActiveGoalTaskFilters 三个维度同时生效时按 状态→类型→象限 排列', () => {
  assert.deepEqual(
    describeActiveGoalTaskFilters(
      filters({ quadrant: 'q1', status: 'blocked', type: 'deep_work' }),
    ),
    [
      { dimension: 'status', value: 'blocked' },
      { dimension: 'type', value: 'deep_work' },
      { dimension: 'quadrant', value: 'q1' },
    ],
    '顺序与筛选行的排列一致，不跟着对象字面量的书写顺序走',
  );
});

test('describeActiveGoalTaskFilters 与 hasActiveGoalTaskFilters 判断一致', () => {
  // 两者是同一个「在筛什么」问题的两种问法，不该出现一个说有、一个说没有。
  for (const active of [
    DEFAULT_GOAL_TASK_FILTERS,
    filters({ status: 'inbox' }),
    filters({ type: 'none' }),
    filters({ quadrant: GOAL_QUADRANT_FILTER_UNSCORED }),
    filters({ status: 'completed', type: 'admin', quadrant: 'q4' }),
  ]) {
    assert.equal(
      describeActiveGoalTaskFilters(active).length > 0,
      hasActiveGoalTaskFilters(active),
    );
  }
});

test('移除一个 chip 只重置那一个维度，其余条件照旧', () => {
  const active = filters({ status: 'inbox', type: 'deep_work', quadrant: 'q2' });
  // 组件层点 X 做的就是这个 patch。
  const withoutType: GoalTaskFilters = { ...active, type: GOAL_FILTER_ALL };
  assert.deepEqual(describeActiveGoalTaskFilters(withoutType), [
    { dimension: 'status', value: 'inbox' },
    { dimension: 'quadrant', value: 'q2' },
  ]);
  // 另外两个条件仍然在筛：b 是 inbox + q2。
  assert.deepEqual(ids(filterGoalTasks(sample, withoutType).tasks), ['b']);
});
