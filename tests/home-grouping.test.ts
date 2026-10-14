/**
 * 首页「队列」三种分组方式的语义测试。
 *
 * 核心约束：分组 **只分组、不排序**。所有断言都盯着两件事——
 *  1) 组的顺序是固定的（q1→q4→未分类 / TASK_STATUSES 的声明序），与数据里谁先
 *     出现无关；
 *  2) 组内条目的相对顺序与输入完全一致（队列原序，不按分数重排）。
 *
 * 另外覆盖：优先顺序返回单组、空组不渲染、无象限落到末尾的未分类组。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Quadrant, TaskStatus } from '../shared/types.ts';
import {
  HOME_GROUP_MODE_LABELS,
  PRIORITY_GROUP_KEY,
  UNCLASSIFIED_GROUP_KEY,
  groupHomeItems,
  type HomeGroupableTask,
} from '../src/lib/home-grouping.ts';
import { QUADRANT_TITLES, STATUS_LABELS } from '../shared/labels.ts';

/** 队列条目的最小形状：id 用来断言顺序，task 是分组真正读的部分。 */
interface Entry {
  id: string;
  position: number;
  task: HomeGroupableTask;
}

const entry = (id: string, position: number, status: TaskStatus, quadrant: Quadrant | null): Entry => ({
  id,
  position,
  task: { status, quadrant },
});

const taskOf = (item: Entry): HomeGroupableTask => item.task;

const ids = (items: Entry[]): string[] => items.map((item) => item.id);

/**
 * 一份故意打乱的队列：象限与状态都交错出现，所以「固定组序」与「组内原序」
 * 只有在实现真的按固定顺序分桶时才会同时成立。
 */
const QUEUE: Entry[] = [
  entry('a', 1, 'in_progress', 'q3'),
  entry('b', 2, 'inbox', null),
  entry('c', 3, 'blocked', 'q1'),
  entry('d', 4, 'inbox', 'q3'),
  entry('e', 5, 'claimed', 'q1'),
  entry('f', 6, 'in_progress', 'q4'),
  entry('g', 7, 'inbox', null),
];

// ── 优先顺序 ────────────────────────────────────────────────────────────────

test('优先顺序：返回单组，且顺序与输入完全一致', () => {
  const groups = groupHomeItems(QUEUE, 'priority', taskOf);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].key, PRIORITY_GROUP_KEY);
  assert.equal(groups[0].label, HOME_GROUP_MODE_LABELS.priority);
  assert.deepEqual(ids(groups[0].items), ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  // position 也原样带回：分组不碰任何排序字段。
  assert.deepEqual(
    groups[0].items.map((item) => item.position),
    [1, 2, 3, 4, 5, 6, 7],
  );
});

test('优先顺序：输出是副本，改它不会污染输入数组', () => {
  const groups = groupHomeItems(QUEUE, 'priority', taskOf);
  groups[0].items.reverse();
  assert.deepEqual(ids(QUEUE), ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
});

// ── 轻重缓急（象限） ────────────────────────────────────────────────────────

test('轻重缓急：组序固定 q1→q2→q3→q4，组内保持队列原序', () => {
  const groups = groupHomeItems(QUEUE, 'quadrant', taskOf);
  // q2 整组为空，所以不出现；未分类排在最后。
  assert.deepEqual(
    groups.map((group) => group.key),
    ['q1', 'q3', 'q4', UNCLASSIFIED_GROUP_KEY],
  );
  // 输入里 q3 的 'a' 先于 q1 的 'c' 出现，组序仍按 q1 在前。
  assert.deepEqual(ids(groups[0].items), ['c', 'e']);
  assert.deepEqual(ids(groups[1].items), ['a', 'd']);
  assert.deepEqual(ids(groups[2].items), ['f']);
});

test('轻重缓急：无象限的任务进「未分类」，且该组固定在末尾', () => {
  const groups = groupHomeItems(QUEUE, 'quadrant', taskOf);
  const last = groups[groups.length - 1];
  assert.equal(last.key, UNCLASSIFIED_GROUP_KEY);
  assert.equal(last.label, '未分类');
  assert.deepEqual(ids(last.items), ['b', 'g']);
});

test('轻重缓急：只有未分类任务时，未分类是唯一一组', () => {
  const onlyUnclassified = [entry('x', 1, 'inbox', null), entry('y', 2, 'claimed', null)];
  const groups = groupHomeItems(onlyUnclassified, 'quadrant', taskOf);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].key, UNCLASSIFIED_GROUP_KEY);
  assert.deepEqual(ids(groups[0].items), ['x', 'y']);
});

test('轻重缓急：组标签来自 QUADRANT_TITLES', () => {
  const groups = groupHomeItems(QUEUE, 'quadrant', taskOf);
  for (const group of groups) {
    if (group.key === UNCLASSIFIED_GROUP_KEY) continue;
    assert.equal(group.label, QUADRANT_TITLES[group.key as Quadrant]);
  }
});

test('轻重缓急：四个象限齐全时组序就是 q1..q4', () => {
  const full = [
    entry('q4', 1, 'inbox', 'q4'),
    entry('q2', 2, 'inbox', 'q2'),
    entry('q1', 3, 'inbox', 'q1'),
    entry('q3', 4, 'inbox', 'q3'),
  ];
  assert.deepEqual(
    groupHomeItems(full, 'quadrant', taskOf).map((group) => group.key),
    ['q1', 'q2', 'q3', 'q4'],
  );
});

// ── 任务状态 ────────────────────────────────────────────────────────────────

test('任务状态：组序固定为 inbox→claimed→in_progress→blocked→completed→archived', () => {
  const all = [
    entry('arch', 1, 'archived', null),
    entry('done', 2, 'completed', 'q1'),
    entry('blk', 3, 'blocked', 'q1'),
    entry('run', 4, 'in_progress', 'q2'),
    entry('got', 5, 'claimed', 'q2'),
    entry('new', 6, 'inbox', 'q3'),
  ];
  assert.deepEqual(
    groupHomeItems(all, 'status', taskOf).map((group) => group.key),
    ['inbox', 'claimed', 'in_progress', 'blocked', 'completed', 'archived'],
  );
});

test('任务状态：空组不出现在结果里', () => {
  const groups = groupHomeItems(QUEUE, 'status', taskOf);
  assert.deepEqual(
    groups.map((group) => group.key),
    ['inbox', 'claimed', 'in_progress', 'blocked'],
  );
  // completed / archived 这两组本来就没数据，必须一条都查不到。
  assert.equal(
    groups.some((group) => group.key === 'completed' || group.key === 'archived'),
    false,
  );
});

test('任务状态：组内保持队列原序', () => {
  const groups = groupHomeItems(QUEUE, 'status', taskOf);
  const byKey = new Map(groups.map((group) => [group.key, group.items]));
  assert.deepEqual(ids(byKey.get('inbox')!), ['b', 'd', 'g']);
  assert.deepEqual(ids(byKey.get('in_progress')!), ['a', 'f']);
  assert.deepEqual(ids(byKey.get('claimed')!), ['e']);
  assert.deepEqual(ids(byKey.get('blocked')!), ['c']);
});

test('任务状态：组标签来自 STATUS_LABELS', () => {
  const groups = groupHomeItems(QUEUE, 'status', taskOf);
  for (const group of groups) {
    assert.equal(group.label, STATUS_LABELS[group.key as TaskStatus]);
  }
  assert.equal(groups[0].label, '待处理');
});

// ── 边界 ────────────────────────────────────────────────────────────────────

test('空输入：三种模式都返回空数组（不产生空分组）', () => {
  for (const mode of ['priority', 'quadrant', 'status'] as const) {
    assert.deepEqual(groupHomeItems([], mode, taskOf), []);
  }
});

test('分组是纯函数：同一份输入连调两次结果一致，且输入未被改动', () => {
  const snapshot = ids(QUEUE);
  const first = groupHomeItems(QUEUE, 'quadrant', taskOf).map((g) => [g.key, ids(g.items)]);
  const second = groupHomeItems(QUEUE, 'quadrant', taskOf).map((g) => [g.key, ids(g.items)]);
  assert.deepEqual(first, second);
  assert.deepEqual(ids(QUEUE), snapshot);
});

test('每个条目恰好落进一组：分组互斥且不丢条目', () => {
  for (const mode of ['priority', 'quadrant', 'status'] as const) {
    const flat = groupHomeItems(QUEUE, mode, taskOf).flatMap((group) => ids(group.items));
    assert.equal(flat.length, QUEUE.length);
    assert.deepEqual([...flat].sort(), [...ids(QUEUE)].sort());
  }
});
