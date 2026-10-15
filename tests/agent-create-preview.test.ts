import {nodeCli} from './fixtures/cli.ts';
/** Regression for embedded creation replies wrapped in skill_operation's payload envelope. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'princeq-create-preview-'));
process.env.PWQ_HABITS_DIR = path.join(temporary, 'habits');
process.env.PWQ_AGENT_RUNTIME_CONFIG = path.join(temporary, 'runtime.json');
const {freshDb} = await import('./helpers.ts');
const {parseAgentReply, runAgentMessage, AgentRuntimeError} = await import('../server/agent/llm-adapter.ts');
const {defaultRuntimeConfig} = await import('../server/agent/runtime-config.ts');
const {confirmPendingActions, cancelPendingActions} = await import('../server/agent/pending-actions.ts');
const {previewActionPath} = await import('../src/lib/agent-preview-contract.ts');
const {buildRouter} = await import('../server/http/routes.ts');
const {ensureHabitFiles} = await import('../server/domain/habits.ts');
ensureHabitFiles();
const combined = {
  action: 'create_goal_with_tasks' as const,
  title: '整理个人作品集', description: '完成可供审阅的作品集初稿',
  tasks: [
    {title: '整理作品清单', description: '列出作品及已有材料', minutes: 20},
    {title: '完成作品集初稿', description: '形成可供审阅的文档', minutes: 30},
  ],
};
const {action: combinedAction, ...combinedPayload} = combined;
const wrapped = {action: combinedAction, payload: combinedPayload};
function reply(actions: unknown) {return JSON.stringify({answer: '尚未创建，请确认预览。', proposed_actions: actions});}
let sequence = 0;
async function generate(db: ReturnType<typeof freshDb>, actions: unknown) {
  const cli = nodeCli(path.join(temporary, `fake-${++sequence}`), `console.log(${JSON.stringify(reply(actions))});`);
  return runAgentMessage({db, message: '帮我创建目标及任务', actorId: 'actor-human-me', idempotencyKey: `message-${sequence}`},
    {...defaultRuntimeConfig(), enabled: true, cli_path: cli});
}
const count = (db: ReturnType<typeof freshDb>, table: string) => Number((db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {n: number}).n);
test.after(() => fs.rmSync(temporary, {recursive: true, force: true}));

test('实测 payload 包装和标准顶层动作生成同一个严格创建合同', () => {
  for (const candidate of [combined, wrapped]) {
    const parsed = parseAgentReply('SUMMARY: 先生成可确认预览。\n' + reply([candidate]));
    assert.deepEqual(parsed.actions, [combined]);
    assert.equal(parsed.dropped, 0);
  }
  for (const action of [{action: 'create_task', title: '回电话'}, {action: 'create_goal', title: '作品集'}]) {
    const {action: name, ...payload} = action;
    assert.deepEqual(parseAgentReply(reply([{action: name, payload}])).actions, [action]);
  }
});
test('包装兼容仍拒绝未知执行字段、伪造动作以及缺少完成标准的任务', () => {
  for (const candidate of [
    {...wrapped, shell: 'forbidden'},
    {action: combinedAction, payload: {...combinedPayload, shell: 'forbidden'}},
    {action: combinedAction, payload: {...combinedPayload, action: 'create_goal'}},
    {...combined, tasks: [{title: '缺少完成标准'}]},
    {action: 'arbitrary_operation', payload: combinedPayload},
  ]) {
    const parsed = parseAgentReply(reply([candidate]));
    assert.equal(parsed.actions.length, 0);
    assert.equal(parsed.dropped, 1);
  }
});
test('组合创建返回按钮所需令牌；确认前零创建，确认后关联正确且重复确认幂等', async () => {
  const db = freshDb();
  try {
    const outcome = await generate(db, [wrapped]);
    assert.equal(outcome.result.kind, 'preview');
    const token = outcome.result.pending_action!.token;
    assert.equal(previewActionPath(token, 'confirm'), '/agent/preview/confirm');
    assert.ok(outcome.result.blocks.some(block => block.title === '待创建任务（2）'));
    assert.equal(count(db, 'goals'), 0); assert.equal(count(db, 'tasks'), 0);
    const saved = confirmPendingActions(db, token, 'actor-human-me', 'confirm-once');
    assert.equal(saved.createdGoalIds.length, 1); assert.equal(saved.createdTaskIds.length, 2);
    const tasks = db.prepare('SELECT title, description, goal_id, estimated_minutes FROM tasks ORDER BY rowid').all();
    assert.deepEqual(tasks.map(task => ({...task})), combined.tasks.map(task => ({title: task.title, description: task.description, goal_id: saved.createdGoalIds[0], estimated_minutes: task.minutes})));
    confirmPendingActions(db, token, 'actor-human-me', 'confirm-once');
    assert.equal(count(db, 'goals'), 1); assert.equal(count(db, 'tasks'), 2);
  } finally {db.close();}
});
test('取消组合预览零创建，后续任务失败时整批回滚', async () => {
  const db = freshDb();
  try {
    const first = await generate(db, [wrapped]);
    cancelPendingActions(db, first.result.pending_action!.token);
    assert.equal(count(db, 'goals'), 0); assert.equal(count(db, 'tasks'), 0);
    const next = await generate(db, [combined]);
    db.exec("CREATE TRIGGER fail_second_task BEFORE INSERT ON tasks WHEN NEW.title = '完成作品集初稿' BEGIN SELECT RAISE(ABORT, 'isolated failure'); END");
    assert.throws(() => confirmPendingActions(db, next.result.pending_action!.token, 'actor-human-me', 'rollback'));
    assert.equal(count(db, 'goals'), 0); assert.equal(count(db, 'tasks'), 0);
  } finally {db.close();}
});
test('无效动作包括混合批次明确失败，不产生部分预览或误导成功回复', async () => {
  const db = freshDb();
  try {
    for (const actions of [[{...wrapped, unexpected: true}], [{action: 'create_task', title: '有效任务'}, {action: 'unsupported'}], {}]) {
      await assert.rejects(generate(db, actions), error => error instanceof AgentRuntimeError && error.kind === 'preview_invalid' && /重试 Agent/.test(error.message));
    }
    assert.equal(count(db, 'agent_pending_actions'), 0);
    assert.equal(count(db, 'goals'), 0); assert.equal(count(db, 'tasks'), 0);
  } finally {db.close();}
});
test('单独新建任务和目标的 Skill 动作也能通过按钮对应路由确认创建', async () => {
  const db = freshDb();
  try {
    const router = buildRouter(() => db);
    for (const operation of ['task.create', 'goal.create']) {
      const title = operation === 'task.create' ? '单独新任务' : '单独新目标';
      const outcome = await generate(db, [{action: 'skill_operation', operation, payload: {title}}]);
      assert.equal(outcome.result.kind, 'preview');
      const token = outcome.result.pending_action!.token;
      const match = router.match('POST', '/api' + previewActionPath(token, 'confirm'))!;
      const result = await match.handler({req: {headers: {}}, url: new URL('http://local/api/agent/preview/confirm'), params: match.params, body: {token}, idempotencyKey: operation} as never) as {result: {kind: string}};
      assert.equal(result.result.kind, 'applied');
      const table = operation === 'task.create' ? 'tasks' : 'goals';
      assert.equal(db.prepare(`SELECT title FROM ${table}`).get()!.title, title);
    }
  } finally {db.close();}
});
