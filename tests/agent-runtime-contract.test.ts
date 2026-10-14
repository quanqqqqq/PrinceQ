/**
 * Agent 运行时前端契约的纯逻辑单测（不引 React、不发真实 CLI / API 请求）。
 *
 * 覆盖：模式推导与中文标签、env 只收大写名字（拒收值/密钥）、args 逐项 argv（拒收
 * shell 串）、工作目录逃逸拦截、超时夹取，以及**嵌套**保存载荷——重点守住「绝不带
 * 密钥值」。字段名与 server/agent/runtime-config.ts / routes.ts 逐一对齐。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addArgToList,
  buildSavePayload,
  checkWorkingDir,
  clampTimeoutMs,
  deriveEffectiveMode,
  healthMeta,
  modeSubtitle,
  parseEnvName,
  providerLabel,
  sourceLabel,
  validateConfig,
  type AgentConfigForm,
} from '../src/lib/agent-runtime-contract.ts';

const baseForm: AgentConfigForm = {
  enabled: true,
  provider: 'claude',
  cli_path: '/usr/local/bin/claude',
  model: null,
  args: [],
  timeout_ms: 20_000,
  working_directory: '/Users/me/project',
  allowed_env_names: [],
};

// ── 模式推导：只有「启用且探测 ok」才走 Agent，否则一律本地命令 ────────────────

test('deriveEffectiveMode：启用且健康 → agent，否则本地命令', () => {
  assert.equal(deriveEffectiveMode(true, true), 'agent');
  assert.equal(deriveEffectiveMode(false, true), 'local-command');
  assert.equal(deriveEffectiveMode(true, false), 'local-command');
  assert.equal(deriveEffectiveMode(false, false), 'local-command');
});

test('modeSubtitle：agent 行带 provider；回落行必须明说为什么没用上 Agent', () => {
  assert.match(modeSubtitle('agent', true, 'claude', { ok: true, reason: null }), /Claude/);
  assert.match(
    modeSubtitle('local-command', false, 'claude', { ok: false, reason: 'health_unknown' }),
    /Agent 未启用/,
  );
  assert.match(
    modeSubtitle('local-command', true, 'claude', { ok: false, reason: 'cli_not_found' }),
    /Agent 不可用/,
  );
});

test('健康中文标签：按 reason 码给徽章，ok 给「CLI 可运行」', () => {
  assert.equal(healthMeta({ ok: true, reason: null }).label, 'CLI 可运行');
  assert.equal(healthMeta({ ok: false, reason: 'cli_not_found' }).label, '未找到 CLI');
  assert.equal(healthMeta({ ok: false, reason: 'cli_not_executable' }).label, 'CLI 不可执行');
  assert.equal(healthMeta({ ok: false, reason: 'nope' }).tone, 'warn');
});

test('providerLabel：未知 provider 原样返回', () => {
  assert.equal(providerLabel('claude'), 'Claude');
  assert.equal(providerLabel('codex'), 'Codex');
  assert.equal(providerLabel('gemini'), 'gemini');
});

// ── env：只收大写变量名，绝不收值 ─────────────────────────────────────────────

test('parseEnvName：带 = 直接拒，界面永远不收值', () => {
  const r = parseEnvName('ANTHROPIC_API_KEY=sk-abc123');
  assert.equal(r.ok, false);
  assert.match(r.message ?? '', /变量名/);
});

test('parseEnvName：小写自动转大写；非法命名拒', () => {
  assert.equal(parseEnvName('google_api_key').name, 'GOOGLE_API_KEY');
  assert.equal(parseEnvName('1BAD').ok, false);
  assert.equal(parseEnvName('has-dash').ok, false);
  assert.equal(parseEnvName('PATH').ok, true);
});

test('parseEnvName：像密钥的名字放行，但提醒「只存名字」', () => {
  const r = parseEnvName('anthropic_api_key');
  assert.equal(r.ok, true);
  assert.equal(r.name, 'ANTHROPIC_API_KEY');
  assert.match(r.message ?? '', /只保存名字/);
});

// ── args：逐项 argv，不是 shell 字符串 ────────────────────────────────────────

test('addArgToList：空串拒、shell 元字符拒、去重', () => {
  assert.equal(addArgToList([], '').error, '参数为空。');
  assert.match(addArgToList([], 'foo; rm -rf /').error ?? '', /shell/);
  assert.match(addArgToList([], 'a && b').error ?? '', /shell/);
  assert.deepEqual(addArgToList([], '--foo').args, ['--foo']);
  assert.match(addArgToList(['--foo'], '--foo').error ?? '', /已存在/);
});

// ── 工作目录：必填且在项目内，拦逃逸 ────────────────────────────────────────────

test('checkWorkingDir：必填；.. 与相对路径拒；绝对路径过', () => {
  assert.equal(checkWorkingDir('').ok, false, '工作目录必填');
  assert.equal(checkWorkingDir('../outside').ok, false);
  assert.equal(checkWorkingDir('relative/dir').ok, false);
  assert.equal(checkWorkingDir('/Users/me/project').ok, true);
});

// ── 超时 + 整份校验 + 嵌套保存载荷 ─────────────────────────────────────────────

test('clampTimeoutMs：夹进范围，坏输入回落默认', () => {
  assert.equal(clampTimeoutMs(1), 500);
  assert.equal(clampTimeoutMs(999999), 120_000);
  assert.equal(clampTimeoutMs(NaN), 20_000);
});

test('validateConfig：启用时缺 CLI 路径报错；超时越界/工作目录逃逸/非法 env 名都报错', () => {
  assert.ok(validateConfig({ ...baseForm, cli_path: '' }).length > 0);
  assert.ok(validateConfig({ ...baseForm, timeout_ms: 100 }).length > 0);
  assert.ok(validateConfig({ ...baseForm, working_directory: '../x' }).length > 0);
  assert.ok(validateConfig({ ...baseForm, allowed_env_names: ['bad-name'] }).length > 0);
  assert.equal(validateConfig(baseForm).length, 0);
});

test('buildSavePayload：嵌套 { config, expected_version }，env 只留大写名，绝不带密钥值', () => {
  const payload = buildSavePayload(
    {
      ...baseForm,
      cli_path: '  /usr/local/bin/claude  ',
      args: ['--foo', '  ', '--bar'],
      allowed_env_names: ['PATH', 'ANTHROPIC_API_KEY', 'not a name'],
      timeout_ms: 999_999,
    },
    '2026-10-13T00:00:00.000Z',
  );
  assert.equal(payload.expected_version, '2026-10-13T00:00:00.000Z');
  assert.equal(payload.config.cli_path, '/usr/local/bin/claude');
  assert.deepEqual(payload.config.args, ['--foo', '--bar']);
  assert.deepEqual(payload.config.allowed_env_names, ['PATH', 'ANTHROPIC_API_KEY']);
  assert.equal(payload.config.timeout_ms, 120_000);
  assert.ok(!('env_values' in payload.config), '载荷绝不能带 env 值');
  assert.ok(!('secret' in payload.config), '载荷绝不能带 secret 字段');
});

test('sourceLabel：agent 带来源 provider，本地命令短标签', () => {
  assert.match(sourceLabel('agent', 'claude'), /Claude/);
  assert.equal(sourceLabel('local-command', 'claude'), '本地命令');
});

// ── 自动检测：config_patch merge、manual 不覆盖、候选采用、安全 parse ─────────

import {
  adoptCandidate,
  allAutoSources,
  applyDetectedRecommendation,
  markManual,
  parseDetectedSnapshot,
  pickRecommendedCandidate,
  sourcesFromRecord,
  type RuntimeDetectResponse,
} from '../src/lib/agent-runtime-contract.ts';

const detect: RuntimeDetectResponse = {
  detected_at: new Date().toISOString(),
  latency_ms: 420,
  candidates: [
    {
      provider: 'claude',
      path: '/usr/local/bin/claude',
      rank: 1,
      exists: true,
      version: '1.0.50',
      exit_code: 0,
      timed_out: false,
      latency_ms: 420,
      auth_status: 'unknown',
      capabilities: { non_interactive: true, output_formats: ['json'], supports_model_flag: true, help_checked: true },
    },
  ],
  recommended: {
    provider: 'claude',
    path: '/usr/local/bin/claude',
    rank: 1,
    exists: true,
    version: '1.0.50',
    exit_code: 0,
    timed_out: false,
    latency_ms: 420,
    auth_status: 'unknown',
    capabilities: { non_interactive: true, output_formats: ['json'], supports_model_flag: true, help_checked: true },
  },
  config_patch: {
    provider: 'claude',
    cli_path: '/usr/local/bin/claude',
    model: null,
    timeout_ms: 20_000,
    working_directory: '/Users/me/project',
    recommended_args: ['--output-format', 'json'],
    model_source: 'cli-config',
  },
  note: 'note',
};

test('applyDetectedRecommendation：全 auto 时把 config_patch 回填（recommended_args→args）', () => {
  const { form } = applyDetectedRecommendation(
    { ...baseForm, cli_path: '', args: [], timeout_ms: 20_000 },
    allAutoSources(),
    detect,
  );
  assert.equal(form.cli_path, '/usr/local/bin/claude');
  assert.deepEqual(form.args, ['--output-format', 'json']);
  assert.equal(form.working_directory, '/Users/me/project');
  assert.equal(form.model, null, 'model 不由检测决定');
});

test('applyDetectedRecommendation：manual 字段不被检测覆盖', () => {
  const src = { ...allAutoSources(), cli_path: 'manual' as const };
  const { form } = applyDetectedRecommendation(
    { ...baseForm, cli_path: '/my/custom/claude' },
    src,
    detect,
  );
  assert.equal(form.cli_path, '/my/custom/claude', 'manual path 保持');
  assert.deepEqual(form.args, ['--output-format', 'json'], '其余 auto 字段照常回填');
});

test('markManual + sourcesFromRecord：缺省 auto，记录里 manual 才生效', () => {
  assert.equal(markManual(allAutoSources(), 'model').model, 'manual');
  const fromServer = sourcesFromRecord({ cli_path: 'manual', bogus: 'manual' });
  assert.equal(fromServer.cli_path, 'manual');
  assert.equal(fromServer.provider, 'auto', '未提到的字段缺省 auto');
});

test('pickRecommendedCandidate：就是 detection.recommended；空为 null', () => {
  assert.equal(pickRecommendedCandidate(detect)?.path, '/usr/local/bin/claude');
  assert.equal(pickRecommendedCandidate({ ...detect, recommended: null }), null);
});

test('adoptCandidate：采用候选的 path/provider 并标 manual', () => {
  const { form, source } = adoptCandidate(baseForm, allAutoSources(), detect.candidates[0]);
  assert.equal(form.cli_path, '/usr/local/bin/claude');
  assert.equal(source.provider, 'manual');
  assert.equal(source.cli_path, 'manual');
});

test('parseDetectedSnapshot：unknown 安全解析，坏形状返回 null', () => {
  const ok = parseDetectedSnapshot(detect);
  assert.equal(ok?.recommended?.path, '/usr/local/bin/claude');
  assert.equal(ok?.config_patch.recommended_args.join(' '), '--output-format json');
  assert.equal(parseDetectedSnapshot(null), null);
  assert.equal(parseDetectedSnapshot({ foo: 1 }), null, '缺 candidates/config_patch 返回 null');
  assert.equal(parseDetectedSnapshot(42), null);
});
