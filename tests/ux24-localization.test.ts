/**
 * UX-24：系统中文词典、/api/meta 中文标签与页面文案的完整性断言。
 *
 *  - 词典：状态/象限/评分因子/助手 facts 值全部有中文映射，且不残留英文枚举原值。
 *  - /api/meta：中文展示字段齐备，英文枚举 key（q1..q4、deterministic-local、
 *    actor id、英文 quadrant_labels）原样保留。
 *
 * 用临时 SQLite + 临时 habits 起独立服务，绝不碰 data/work-queue.db。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pwq-ux24-'));
process.env.PWQ_DB_PATH = path.join(tempRoot, 'test.db');
process.env.PWQ_HABITS_DIR = path.join(tempRoot, 'habits');
process.env.PWQ_AGENT_RUNTIME_CONFIG = path.join(process.env.PWQ_HABITS_DIR!, '..', 'runtime.json');
process.env.PWQ_API_PORT = '0';

const { applySchema, getDb, closeDb } = await import('../server/db/connection.ts');
const { seedActors } = await import('../server/db/seed.ts');
const { ensureHabitFiles } = await import('../server/domain/habits.ts');
const { createServer } = await import('../server/index.ts');

const {
  STATUS_LABELS,
  GOAL_STATUS_LABELS,
  QUADRANT_TITLES,
  QUEUE_FACTOR_LABELS,
  AGENT_FACT_LABELS,
  agentFactValue,
  translateSystemText,
} = await import('../src/lib/i18n.ts');

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

// ── 词典完整性 ──────────────────────────────────────────────────────────────

test('词典：状态/目标状态/象限标签全部为中文且无英文残留', () => {
  for (const [, label] of Object.entries(STATUS_LABELS)) {
    assert.match(label, /[一-鿿]/, `状态标签应为中文：${label}`);
  }
  for (const [, label] of Object.entries(GOAL_STATUS_LABELS)) {
    assert.match(label, /[一-鿿]/, `目标状态标签应为中文：${label}`);
  }
  for (const [, title] of Object.entries(QUADRANT_TITLES)) {
    assert.match(title, /[一-鿿]/, `象限标题应为中文：${title}`);
  }
});

test('词典：队列评分因子 6 个 key 全部有中文标签', () => {
  for (const key of ['deadline', 'manual_priority', 'dependency', 'effort', 'habit_alignment', 'context_switch']) {
    assert.ok(QUEUE_FACTOR_LABELS[key], `缺少因子标签：${key}`);
    assert.match(QUEUE_FACTOR_LABELS[key], /[一-鿿]/);
  }
});

test('词典：助手 facts 值把系统枚举/none 翻成中文，用户标题原样保留', () => {
  assert.equal(agentFactValue('Status', 'inbox'), STATUS_LABELS.inbox);
  assert.equal(agentFactValue('Status', 'completed'), STATUS_LABELS.completed);
  assert.equal(agentFactValue('Status', 'active'), GOAL_STATUS_LABELS.active);
  assert.equal(agentFactValue('Goal', 'none'), '（暂无）');
  assert.equal(agentFactValue('Enabled', 'true'), '已启用');
  assert.equal(agentFactValue('Enabled', 'false'), '未启用');
  assert.equal(agentFactValue('Quadrant', 'q2 — Important, not urgent — schedule'),
    `q2 · ${QUADRANT_TITLES.q2}`);
  // 用户输入的标题不是系统枚举，原样返回。
  assert.equal(agentFactValue('Goal', '我的真实目标'), '我的真实目标');
  // AGENT_FACT_LABELS 里 (none) 有中文展示。
  assert.equal(AGENT_FACT_LABELS['(none)'], '（暂无）');
});

test('词典：已知系统英文句子经 translateSystemText 转为中文', () => {
  assert.equal(
    translateSystemText('The queue is empty.'),
    '队列是空的。',
  );
  assert.equal(
    translateSystemText('Nothing was written.'),
    '未写入任何数据。',
  );
  // 用户自由文本不在映射表内，原样返回。
  assert.equal(
    translateSystemText('我自己写的一句备注'),
    '我自己写的一句备注',
  );
});

// ── /api/meta ───────────────────────────────────────────────────────────────

async function getMeta() {
  const res = await fetch(`${base}/api/meta`);
  return res.json() as Promise<{
    agent_mode: string;
    agent_mode_label: string;
    quadrant_labels: Record<string, string>;
    quadrant_titles: Record<string, string>;
    default_actor_id: string;
    supported_commands: { command: string; description_zh: string }[];
    actors: { id: string; display_name: string; display_name_zh: string }[];
  }>;
}

test('meta：中文展示字段齐备，英文枚举 key 保留', async () => {
  const meta = await getMeta();

  // 英文枚举 key 原样保留。
  assert.equal(meta.agent_mode, 'deterministic-local');
  assert.ok(meta.quadrant_labels.q1.startsWith('Important'), '英文 quadrant_labels 应保留');
  assert.ok(meta.default_actor_id.startsWith('actor-'));

  // 中文展示镜像。
  assert.equal(meta.quadrant_titles.q1, '重要且紧急');
  assert.equal(meta.quadrant_titles.q4, '不重要不紧急');
  assert.equal(meta.agent_mode_label, '确定性本地模式');

  for (const cmd of meta.supported_commands) {
    assert.ok(cmd.command, 'command 为可发送英文原值');
    assert.match(cmd.description_zh, /[一-鿿]/, `中文描述缺失：${cmd.command}`);
  }

  const me = meta.actors.find((a: { id: string }) => a.id === 'actor-human-me');
  assert.equal(me.display_name, 'Me');
  assert.equal(me.display_name_zh, '我');
});
