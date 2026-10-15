import {nodeCli} from './fixtures/cli.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pwq-provider-check-'));
process.env.PWQ_AGENT_RUNTIME_CONFIG = path.join(tmp, 'runtime.json');
process.env.PWQ_HABITS_DIR = path.join(tmp, 'habits');
const {defaultRuntimeConfig} = await import('../server/agent/runtime-config.ts');
const {candidateConfig, connectionFor, testRuntimeProvider, listRuntimeProviders} = await import('../server/agent/provider-connections.ts');
const {parseHelpCapabilities} = await import('../server/agent/detect.ts');
const {refreshHealth, invalidateHealth, isAgentReady} = await import('../server/agent/health.ts');
const {adoptCandidate, allAutoSources} = await import('../src/lib/agent-runtime-contract.ts');
const {agentRuntimeTestSchema} = await import('../server/http/schemas.ts');
const {ApiError} = await import('../server/lib/errors.ts');

const cli = nodeCli(path.join(tmp, 'claude'), "console.log('OK');");
const base = {...defaultRuntimeConfig(), cli_path: cli, timeout_ms: 60000};
const candidate = {provider:'codex' as const, path:cli, rank:1, exists:true, version:'fixture', exit_code:0,
  timed_out:false, latency_ms:1, auth_status:'unknown' as const,
  capabilities:{non_interactive:true, output_formats:['jsonl'], supports_model_flag:true, help_checked:true}};

test.after(() => fs.rmSync(tmp, {recursive:true, force:true}));
test('关闭时验证连接成功，不修改原配置；证据按实际调用参数匹配', async () => {
  fs.writeFileSync(process.env.PWQ_AGENT_RUNTIME_CONFIG!, JSON.stringify(base));
  const before = fs.readFileSync(process.env.PWQ_AGENT_RUNTIME_CONFIG!, 'utf8');
  const result = await testRuntimeProvider(base);
  assert.equal(result.ok, true);
  assert.equal(result.stdout_excerpt, 'OK');
  assert.equal(connectionFor({...base, enabled:true})?.ok, true);
  assert.equal(connectionFor({...base, model:'another-model'}), null);
  assert.equal(fs.readFileSync(process.env.PWQ_AGENT_RUNTIME_CONFIG!, 'utf8'), before);
  assert.ok(fs.existsSync(process.env.PWQ_AGENT_RUNTIME_CONFIG! + '.connections.json'));
});
test('切换 provider 不沿用另一个 CLI 的模型、参数和短超时', () => {
  const cfg = candidateConfig({...base, model:'claude-only', args:['--claude-flag']}, candidate);
  assert.equal(cfg.provider, 'codex'); assert.equal(cfg.model, null); assert.deepEqual(cfg.args, []); assert.equal(cfg.timeout_ms, 120000);
  const adopted = adoptCandidate({...base, model:'claude-only', args:['--claude-flag']}, {...allAutoSources(), timeout_ms:'manual'}, candidate);
  assert.equal(adopted.form.model, null); assert.deepEqual(adopted.form.args, []); assert.equal(adopted.form.timeout_ms, 120000);
  assert.equal(adopted.source.model, 'auto');
});
test('health 缓存不能把其他 CLI 或关闭状态的结论用于当前配置', async () => {
  invalidateHealth();
  await refreshHealth({...base, enabled:true});
  assert.equal(isAgentReady({...base, enabled:true}), true);
  assert.equal(isAgentReady({...base, enabled:true, provider:'codex'}), false);
  assert.equal((await refreshHealth({...base, enabled:false})).reason, 'disabled');
  assert.equal((await refreshHealth({...base, enabled:true})).ok, true);
});
test('Codex exec help 被识别为非交互 JSONL，不依赖 Claude 的 -p', () => {
  const caps = parseHelpCapabilities('Usage: codex exec [OPTIONS] [PROMPT]\n  --json  JSON events\n  --model <MODEL>');
  assert.equal(caps.non_interactive, true); assert.deepEqual(caps.output_formats, ['jsonl']); assert.equal(caps.supports_model_flag, true);
});
test('指定验证目标需要 provider 与路径成对，不接受任意可执行文件', async () => {
  assert.equal(agentRuntimeTestSchema.safeParse({provider:'codex'}).success, false);
  assert.equal(agentRuntimeTestSchema.safeParse({cli_path:'/bin/sh'}).success, false);
  assert.equal(agentRuntimeTestSchema.safeParse({provider:'codex', cli_path:'/bin/sh', args:['-c']}).success, false);
  const savedHome = process.env.HOME;
  const savedPath = process.env.PATH;
  const home = path.join(tmp, 'empty-home'); fs.mkdirSync(home, {recursive:true});
  try {
    process.env.HOME = home; process.env.PATH = home;
    await assert.rejects(() => testRuntimeProvider(base, {provider:'claude', cli_path:'/bin/sh'}),
      (cause: unknown) => cause instanceof ApiError && cause.status === 400);
    const list = await listRuntimeProviders(base);
    assert.deepEqual(list.providers.map(entry => entry.provider), ['claude','codex']);
    assert.ok(list.providers.every(entry => entry.candidate === null && entry.connection === null));
  } finally {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
  }
});
test('损坏的连接证据不会阻止 CLI 检查或冒充成功', async () => {
  fs.writeFileSync(process.env.PWQ_AGENT_RUNTIME_CONFIG! + '.connections.json', '{"bad":{"ok":true}}');
  assert.equal(connectionFor(base), null);
  assert.equal((await testRuntimeProvider(base)).ok, true);
});

test('Claude 多行 help 读取实际格式，不把 only works with print 当成格式', () => {
  const caps = parseHelpCapabilities('  --output-format <format> Output format (only works with --print):\n    "text" (default), "json" (single result), or "stream-json" (realtime)\n  --model <model> Model');
  assert.deepEqual(caps.output_formats, ['json','stream-json','text']);
});

test('普通 PUT 不带检测元数据时保留快照与来源，不触发重复检测', async () => {
  const {writeRuntimeConfig,readRuntimeConfig} = await import('../server/agent/runtime-config.ts');
  const original = {...base, detected:{fixture:'last-known-detection'}, field_sources:{cli_path:'manual' as const}, updated_at:new Date().toISOString()};
  fs.writeFileSync(process.env.PWQ_AGENT_RUNTIME_CONFIG!, JSON.stringify(original));
  const {detected: _detected, field_sources: _sources, ...input} = original;
  const saved = writeRuntimeConfig({...input,enabled:true}, original.updated_at, 'fixture');
  assert.deepEqual(saved.detected, original.detected);
  assert.deepEqual(saved.field_sources, original.field_sources);
  assert.equal(readRuntimeConfig().enabled, true);
});
