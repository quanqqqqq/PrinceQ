/**
 * UX-04：「标记受阻」改走站内弹窗后的契约测试。
 *
 * 用临时 SQLite 文件 + 临时 habits 目录起独立服务，绝不触碰 data/work-queue.db。
 * 覆盖三种行为：
 *  - 确认写入：POST /actions { action:'block', reason } 写入 blocked 状态与原因；
 *  - 统一任务详情回读：GET /tasks/:id 能读到 blocked 状态与原因；
 *  - 失败恢复：前置条件不满足时 block 返回 4xx，任务保持原状、修好后可重试；
 *  - 取消不写：从未发起 block 的任务不进入 blocked、blocked_reason 为 null
 *    （取消 = 不发任何 POST）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pwq-block-'));
// Must be set before the config module is first evaluated.
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

interface Call {
  status: number;
  body: any;
}

async function call(
  method: string,
  pathname: string,
  body?: unknown,
  idempotencyKey?: string,
): Promise<Call> {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const createTask = (title: string, key: string) =>
  call('POST', '/api/tasks', { title }, key);

test('确认写入：block 带上原因，状态与 blocked_reason 同时落库', async () => {
  const created = await createTask('UX04 confirm write', 'ux04-confirm-create');
  const id = created.body.task.id;

  const claimed = await call('POST', `/api/tasks/${id}/actions`, { action: 'claim' }, 'ux04-claim');
  assert.equal(claimed.status, 200);
  assert.equal(claimed.body.task.status, 'claimed');

  const reason = '在等设计稿评审';
  const blocked = await call(
    'POST',
    `/api/tasks/${id}/actions`,
    { action: 'block', reason },
    'ux04-block',
  );
  assert.equal(blocked.status, 200);
  assert.equal(blocked.body.task.status, 'blocked');
  assert.equal(blocked.body.task.blocked_reason, reason, '原因被原样持久化');

  // 统一任务详情回读：状态与原因必须一致。
  const detail = await call('GET', `/api/tasks/${id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.task.status, 'blocked');
  assert.equal(detail.body.task.blocked_reason, reason);
  assert.ok(Array.isArray(detail.body.task.available_actions));
});

test('失败恢复：未持有 claim 时 block 被拒绝，任务保持原状，修好前置条件后可重试', async () => {
  const created = await createTask('UX04 failure retry', 'ux04-fail-create');
  const id = created.body.task.id;
  // inbox 状态、没有任何 claim —— block 的前置条件不满足。
  assert.equal(created.body.task.status, 'inbox');

  const rejected = await call(
    'POST',
    `/api/tasks/${id}/actions`,
    { action: 'block', reason: '还没领就想标受阻' },
    'ux04-block-rejected',
  );
  assert.ok(rejected.status >= 400 && rejected.status < 500, `应被拒绝，实际 ${rejected.status}`);
  assert.equal(rejected.body.error.code, 'conflict');

  // 没有半成品写入：状态与原因都保持初始值。
  const beforeRetry = await call('GET', `/api/tasks/${id}`);
  assert.equal(beforeRetry.body.task.status, 'inbox');
  assert.equal(beforeRetry.body.task.blocked_reason, null);

  // 修好前置条件（先 claim）再提交——同一个原因可以成功落库。
  await call('POST', `/api/tasks/${id}/actions`, { action: 'claim' }, 'ux04-fail-claim');
  const reason = '依赖的 API 还没上线';
  const retried = await call(
    'POST',
    `/api/tasks/${id}/actions`,
    { action: 'block', reason },
    'ux04-block-retry',
  );
  assert.equal(retried.status, 200);
  assert.equal(retried.body.task.status, 'blocked');
  assert.equal(retried.body.task.blocked_reason, reason);
});

test('取消不写：从未发起 block 的任务不进入 blocked、原因保持 null', async () => {
  const created = await createTask('UX04 cancel no write', 'ux04-cancel-create');
  const id = created.body.task.id;
  // 先 claim，让它「本来可以」被受阻——模拟用户打开弹窗又取消的情形。
  await call('POST', `/api/tasks/${id}/actions`, { action: 'claim' }, 'ux04-cancel-claim');
  // 关键：不发送任何 block 请求（站内弹窗的「取消」分支）。

  const detail = await call('GET', `/api/tasks/${id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.task.status, 'claimed', '取消后仍是已领取，没有被标成受阻');
  assert.equal(detail.body.task.blocked_reason, null, '没有留下任何受阻原因');
});
