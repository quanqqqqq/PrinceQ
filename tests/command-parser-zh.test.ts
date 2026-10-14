/**
 * UX-03：中文自然表达的意图解析单测。
 *
 * 只测解析器（纯函数，不碰数据库）。覆盖查看队列/创建任务/领取/开始/完成/
 * 标记受阻/创建目标/查看习惯这些常用说法，以及「标题里混着结尾日期/耗时要剥掉」
 * 「带引号的标题原样保留」「破坏性批量输入先拦下」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand } from '../server/agent/commands.ts';

function expectKind<K extends ReturnType<typeof parseCommand>['kind']>(
  input: string,
  kind: K,
): Extract<ReturnType<typeof parseCommand>, { kind: K }> {
  const intent = parseCommand(input);
  assert.equal(intent.kind, kind, `expected "${input}" to parse as ${kind}, got ${intent.kind}`);
  return intent as Extract<ReturnType<typeof parseCommand>, { kind: K }>;
}

test('查看队列：常见说法都命中 show_queue', () => {
  for (const input of ['看看队列', '查看队列', '显示当前队列', '列出队列', '队列', '看看待办', '现在有哪些任务']) {
    expectKind(input, 'show_queue');
  }
  assert.equal(expectKind('看看队列前5', 'show_queue').limit, 5);
});

test('创建任务：标题、结尾日期与耗时被正确分离', () => {
  const t = expectKind('创建任务 复核计费迁移，明天', 'create_task');
  assert.equal(t.title, '复核计费迁移');
  assert.ok(t.deadline, '“明天”应解析成截止时间');

  assert.equal(expectKind('新建任务：写迁移脚本', 'create_task').title, '写迁移脚本');
  assert.equal(expectKind('加个任务 回复供应商', 'create_task').title, '回复供应商');
  assert.equal(expectKind('提醒我 给客户打电话', 'create_task').title, '给客户打电话');
});

test('任务流转：领取/开始/完成/受阻各归各位', () => {
  assert.equal(expectKind('领取 修复线上故障', 'task_action').action, 'claim');
  assert.equal(expectKind('认领任务 设计表结构', 'task_action').action, 'claim');
  assert.equal(expectKind('开始 修复线上故障', 'task_action').action, 'start');
  assert.equal(expectKind('动手 读WAL文档', 'task_action').action, 'start');
  assert.equal(expectKind('完成 回复供应商邮件', 'task_action').action, 'complete');
  assert.equal(expectKind('把 回复供应商邮件 做完', 'task_action').title, '回复供应商邮件');
  assert.equal(expectKind('标记 设计表结构 完成', 'task_action').title, '设计表结构');
});

test('标记受阻：「把 X 标记为受阻」与「X 卡住了」都识别，标题不被污染', () => {
  const b1 = expectKind('把 修复线上故障 标记为受阻', 'task_action');
  assert.equal(b1.action, 'block');
  assert.equal(b1.title, '修复线上故障');

  const b2 = expectKind('写迁移脚本 卡住了', 'task_action');
  assert.equal(b2.action, 'block');
  assert.equal(b2.title, '写迁移脚本');

  const b3 = expectKind('把 写迁移脚本 标记为受阻，因为接口没上线', 'task_action');
  assert.equal(b3.action, 'block');
  assert.equal(b3.title, '写迁移脚本');
  assert.equal(b3.reason, '接口没上线');
});

test('创建目标与查看目标分开', () => {
  assert.equal(expectKind('创建目标 上线计费重写', 'create_goal').title, '上线计费重写');
  assert.equal(expectKind('新建目标：学会SQLite', 'create_goal').title, '学会SQLite');
  expectKind('看看目标', 'show_goals');
  expectKind('目标有哪些', 'show_goals');
});

test('习惯：查看 / 添加', () => {
  expectKind('查看习惯', 'list_habits');
  expectKind('看看我的习惯', 'list_habits');
  assert.equal(expectKind('添加习惯 上午效率最高', 'add_habit').statement, '上午效率最高');
});

test('带引号的中文标题原样保留', () => {
  const t = expectKind('开始「修复线上发票故障」', 'task_action');
  assert.equal(t.action, 'start');
  assert.equal(t.title, '修复线上发票故障');
});

test('破坏性批量的中文说法先拦下', () => {
  for (const input of ['删除所有任务', '清空队列', '重置数据库']) {
    assert.equal(parseCommand(input).kind, 'batch_warning', `"${input}" 不应直接执行`);
  }
});

test('拿不准的中文输入落到 unknown，不瞎写', () => {
  assert.equal(parseCommand('今天天气怎么样').kind, 'unknown');
});
