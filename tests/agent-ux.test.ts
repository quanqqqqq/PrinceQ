/**
 * UX-12 + 助手草稿预览：助手面板的歧义候选卡与拆分草稿确认。
 *
 * 用临时 SQLite + 临时 habits 起独立服务，绝不碰 data/work-queue.db。
 *  - UX-12：同名任务歧义时返回候选卡（标题/目标/状态/截止 + 可点选的重发指令），
 *    全程不在回复里暴露任务 id；点选某条后用「同一指令 + 精确标题」重新命中唯一任务。
 *  - 草稿预览：助手拟出的草稿可逐条勾选/编辑后再确认（accepted_drafts），
 *    同一 token 确认第二次必须被拒（已消费）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pwq-agent-ux-'));
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

async function call(method: string, pathname: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const createTask = async (title: string) => (await call('POST', '/api/tasks', { title })).body.task;

test('UX-12：完全同名任务返回候选卡，按内部 id 点选后只操作选中那一条', async () => {
  // 两个标题完全相同的任务——靠标题永远分不开。
  const a = await createTask('回客户邮件');
  const b = await createTask('回客户邮件');
  assert.notEqual(a.id, b.id);

  const reply = await call('POST', '/api/agent/message', { message: '领取 回客户邮件' });
  const result = reply.body.result;
  assert.equal(result.kind, 'clarification');

  const card = result.blocks.find((b: any) => b.type === 'task_candidates');
  assert.ok(card, '必须返回 task_candidates 候选卡');
  assert.equal(card.candidates.length, 2);
  for (const c of card.candidates) {
    // 卡片给人看的是标题/目标/状态/截止；内部藏一个 task_id 供点选回传。
    assert.equal(typeof c.title, 'string');
    assert.ok('status' in c && 'deadline' in c);
    assert.ok(typeof c.task_id === 'string' && c.task_id.length > 0, '候选必须带内部 task_id');
  }

  // 点选 a：带上它的 task_id 重发。即便标题完全相同，也只领取 a、不动 b。
  const chosen = card.candidates.find((c: any) => c.task_id === a.id);
  assert.ok(chosen, '候选里应能按 id 找到 a');
  const follow = await call('POST', '/api/agent/message', {
    message: chosen.select_message,
    target_task_id: a.id,
  });
  assert.notEqual(follow.body.result.kind, 'clarification', '带 task_id 后应直接命中 a，不再追问');

  const after = await allTaskRows();
  const rowA = after.find((t: any) => t.id === a.id);
  const rowB = after.find((t: any) => t.id === b.id);
  assert.equal(rowA.status, 'claimed', '被选中的 a 应被领取');
  assert.equal(rowB.status, 'inbox', '没被选中的 b 必须保持原样');
});

test('UX-11：点推荐示例时请求带 target_task_id，改名后标题随之更新', async () => {
  // 动态推荐由前端从队列生成，这里验证后端契约：带 target_task_id 时按 id 命中，
  // 且即使任务改名，绑定的 id 仍指向同一条。
  const task = await createTask('旧标题任务');
  // 模拟改名：直接改标题。
  await call('PATCH', `/api/tasks/${task.id}`, { title: '新标题任务' });

  const follow = await call('POST', '/api/agent/message', {
    message: '领取 新标题任务',
    target_task_id: task.id,
  });
  assert.notEqual(follow.body.result.kind, 'clarification');
  const row = (await allTaskRows()).find((t: any) => t.id === task.id);
  assert.equal(row.status, 'claimed', '按 id 命中并领取了这条任务');
});

test('UX-取消：中文取消服务端注销预览，不建任务，旧 token 再确认被拒', async () => {
  const goal = (await call('POST', '/api/goals', { title: '学 Flask 内部原理' })).body.goal;
  const preview = await call('POST', '/api/agent/message', { message: `为目标"${goal.title}"拟任务` });
  const token = preview.body.result.pending_action.token;

  // 用户点中文「取消」。
  const cancelled = await call('POST', '/api/agent/cancel', { token });
  assert.equal(cancelled.status, 200);
  assert.match(cancelled.body.result.headline, /已取消/);

  // 没有创建任何任务。
  assert.equal((await listTasksOfGoal(goal.id)).length, 0);

  // 服务端已注销：旧 token 再确认必须被拒，不能执行。
  const again = await call('POST', '/api/agent/confirm', {
    token,
    accepted_drafts: [{ index: 0, title: '不该被创建' }],
  });
  assert.ok(again.status >= 400 && again.status < 500, '已取消的 token 不能再确认');
  assert.equal((await listTasksOfGoal(goal.id)).length, 0, '取消后确认没有建任务');
});

test('UX-草稿预览：助手拟草稿可逐条勾选/编辑后确认，重复确认被拒', async () => {
  const goal = (await call('POST', '/api/goals', { title: '学 SQLite 内部原理' })).body.goal;

  const preview = await call('POST', '/api/agent/message', {
    message: `为目标"${goal.title}"拟任务`,
  });
  const result = preview.body.result;
  const block = result.blocks.find((b: any) => b.type === 'decomposition_preview');
  assert.ok(block, '应返回结构化拆分草稿块');
  assert.ok(result.pending_action?.token, '应带一个待确认 token');
  const draftCount = block.preview.drafts.length;
  assert.ok(draftCount >= 2);

  // 只勾选第一个，并改掉它的标题。
  const token = result.pending_action.token;
  const confirmed = await call('POST', '/api/agent/confirm', {
    token,
    accepted_drafts: [{ index: 0, title: '我只建这一条', description: '编辑过的描述' }],
  });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.result.kind, 'applied');
  // 只创建了勾选的那一条，且用了改过的标题。
  const tasksAfter = await listTasksOfGoal(goal.id);
  assert.equal(tasksAfter.length, 1, '只创建被勾选的草稿');
  assert.equal(tasksAfter[0].title, '我只建这一条');
  assert.equal(tasksAfter[0].description, '编辑过的描述');

  // 同一 token 再次确认必须被拒，不能重复提交。
  const again = await call('POST', '/api/agent/confirm', {
    token,
    accepted_drafts: [{ index: 1, title: '不该被创建' }],
  });
  assert.ok(again.status >= 400 && again.status < 500, '已消费的 token 不能再确认');
  assert.equal((await listTasksOfGoal(goal.id)).length, 1, '重复确认没有多建任务');
});

test('UX-03：中文「看看队列」走真实解析流程', async () => {
  const reply = await call('POST', '/api/agent/message', { message: '看看队列' });
  assert.equal(reply.status, 200);
  assert.notEqual(reply.body.result.kind, 'unknown');
  assert.notEqual(reply.body.result.kind, 'error');
});

async function allTaskRows() {
  return (await call('GET', '/api/tasks')).body.tasks;
}
async function listTasksOfGoal(goalId: string) {
  return (await call('GET', `/api/goals/${goalId}`)).body.tasks;
}
