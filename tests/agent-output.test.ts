import {nodeCli} from './fixtures/cli.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeCliOutput, isOkReply } from '../server/agent/output.ts';
import { buildProviderPromptArgs } from '../server/agent/cli-exec.ts';
import type { ExecResult } from '../server/agent/cli-exec.ts';

const exec = (stdout: string, overrides: Partial<ExecResult> = {}): ExecResult => ({
  stdout, stderr: '', exitCode: 0, timedOut: false, canceled: false, ...overrides,
});

test('有效回答与非零退出/模型警告分开，诊断不进入正文', () => {
  const r = normalizeCliOutput('claude', exec('完成了分析', {
    exitCode: 1, stderr: '[claude-code:unrecognized_model] fake-model\nprivate-token-value',
  }));
  assert.equal(r.answer, '完成了分析');
  assert.equal(r.valid, true);
  assert.deepEqual(r.warnings.map(w => w.code), ['model_config_warning', 'nonzero_exit']);
  assert.doesNotMatch(JSON.stringify(r.warnings), /private-token-value/);
});
test('Claude JSON传输envelope提取result且拒绝is_error', () => {
  assert.equal(normalizeCliOutput('claude', exec('{"type":"result","subtype":"success","result":"OK"}')).answer, 'OK');
  assert.equal(normalizeCliOutput('claude', exec('{"type":"result","is_error":true,"result":"error"}')).valid, false);
});
test('模型JSON动作保持原结构供preview校验，不被传输层剥掉', () => {
  const raw = '{"answer":"待确认","proposed_actions":[{"action":"create_task","title":"写方案"}]}';
  assert.equal(normalizeCliOutput('codex', exec(raw)).answer, raw);
  assert.equal(normalizeCliOutput('claude', exec('{"answer":"","proposed_actions":[]}')).valid, false);
});
test('Codex选择最后一个明确回答段，剥banner和tokens统计', () => {
  const raw = 'OpenAI Codex v0.162\nworkdir: /fake\nuser\n问题\ncodex\n旧答案\ntokens used\n123\ncodex\n最终答案\ntokens used\n456';
  assert.equal(normalizeCliOutput('codex', exec(raw)).answer, '最终答案');
  assert.equal(normalizeCliOutput('codex', exec('OpenAI Codex v0.162\ntokens used\n123')).valid, false);
});
test('只有warning/error或空白不可伪装成答案，长文本和HTML原样保留', () => {
  for (const raw of ['', ' \n ', 'error: failed', 'warning: missing config']) {
    assert.equal(normalizeCliOutput('claude', exec(raw)).valid, false);
  }
  const raw = '<script>alert("x")</script>\n' + '长回答'.repeat(200);
  assert.equal(normalizeCliOutput('claude', exec(raw)).answer, raw);
});
test('连接探针仅匹配独立OK，不匹配token/okay/日志', () => {
  for (const raw of ['OK', 'ok!', '"OK"', '{"answer":"OK"}']) assert.equal(isOkReply(raw), true, raw);
  for (const raw of ['tokens used', 'okay', 'not OK', 'OK in warning']) assert.equal(isOkReply(raw), false, raw);
});
test('冲突参数的equals形态不会突破no-tools/read-only，合法附加参数保留', () => {
  const a = buildProviderPromptArgs('claude', 'Q', {model:null,args:['--tools=Bash','--output-format=json','--permission-prompts','host','--safe-mode','--extra']});
  assert.ok(!a.includes('--tools=Bash') && !a.includes('host'));
  assert.equal(a.filter(flag => flag === '--safe-mode').length, 1);
  assert.equal(a[a.indexOf('--tools')+1], '');
  assert.ok(a.includes('--extra'));
  const b = buildProviderPromptArgs('codex', 'Q', {model:null,args:['--sandbox=danger-full-access','-a','never','--ask-for-approval=never','--extra']});
  assert.equal(b[b.indexOf('--sandbox')+1], 'read-only');
  assert.ok(!b.includes('never') || b[b.indexOf('never')-1] === '--color');
  assert.ok(!b.some(x => x.startsWith('--ask-for-approval') || x.startsWith('--sandbox=')));
});

test('Codex JSONL仅取completed agent_message，不把事件诊断当回答', () => {
  const events = [
    {type:'thread.started',thread_id:'test'},
    {type:'item.completed',item:{type:'error',message:'configuration warning'}},
    {type:'item.updated',item:{type:'agent_message',text:'未完成片段'}},
    {type:'item.completed',item:{type:'agent_message',text:'{"answer":"OK","proposed_actions":[]}'}},
    {type:'turn.completed',usage:{output_tokens:5}},
  ].map(event => JSON.stringify(event)).join('\n');
  const r = normalizeCliOutput('codex', exec(events));
  assert.equal(r.answer, '{"answer":"OK","proposed_actions":[]}');
  assert.equal(r.valid, true);
  assert.equal(r.warnings[0].code, 'cli_warning');
  assert.equal(normalizeCliOutput('codex', exec('{"type":"item.updated","item":{"type":"agent_message","text":"OK"}}')).valid, false);
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pwq-output-test-'));
process.env.PWQ_HABITS_DIR = path.join(tmp, 'habits');
process.env.PWQ_AGENT_RUNTIME_CONFIG = path.join(tmp, 'runtime.json');
const { freshDb } = await import('./helpers.ts');
const { defaultRuntimeConfig } = await import('../server/agent/runtime-config.ts');
const { runConnectionTest, runAgentMessage, AgentRuntimeError } = await import('../server/agent/llm-adapter.ts');
let n = 0;
function fake(script: string) {
  const file = nodeCli(path.join(tmp, 'cli-' + (++n)), script);
  return { ...defaultRuntimeConfig(), enabled:true, cli_path:file };
}
test('真实spawn路径：有回答的非零退出连接成功并给warning', async () => {
  const r = await runConnectionTest(fake("console.log('OK'); console.error('[claude-code:unrecognized_model]'); process.exitCode=2;"));
  assert.equal(r.ok,true);
  assert.equal(r.status,'success_with_warning');
  assert.equal(r.stdout_excerpt,'OK');
});
test('真实spawn路径：超时即使已打印OK仍失败', async () => {
  const r = await runConnectionTest({...fake("console.log('OK'); setTimeout(()=>{},1000);"),timeout_ms:50});
  assert.equal(r.ok,false);
  assert.equal(r.reason,'timeout');
});
test('真实spawn路径：空答案不返回成功；会话结果保留200字以外正文', async () => {
  const db = freshDb();
  const req = {db,message:'只回答',actorId:'actor-human-me',idempotencyKey:'output-test'};
  await assert.rejects(runAgentMessage(req,fake('process.exit(0);')), (e: unknown) => e instanceof AgentRuntimeError && e.kind==='no_answer');
  const body = '完整回答'.repeat(100);
  const r = await runAgentMessage(req,fake("process.stdout.write("+JSON.stringify(body)+");"));
  assert.equal(r.result.answer, body);
  assert.equal(r.result.headline.length,200);
  db.close();
});
