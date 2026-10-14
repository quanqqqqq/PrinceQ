/**
 * 本地 CLI Agent 运行时的隔离测试。
 *
 * **全程不碰真实环境**：数据库是一次性内存库（`freshDb`），habits 指向临时目录
 * （`withTempHabits`），运行时配置指向临时目录（`PWQ_AGENT_RUNTIME_CONFIG`）。用户的
 * `data/work-queue.db` 与 `habits/` 一个字节都不会被写。
 *
 * **绝不调用真实的 `claude` / `codex`**：每个用例自己写一个 shell 脚本当假 CLI，
 * 按需要装成「正常回答」「超时」「非零退出」「输出乱码」。这样既能跑真实的 spawn
 * 路径（argv 传递、环境白名单、输出截断、信号终止都是真的），又完全离线、可重复。
 *
 * 最该守住的一条：**确认之前零写入。** 模型说要建任务，`tasks` 表必须还是空的。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 运行时配置落在临时目录——真实的 `config/agent-runtime.json` 不被读也不被写。
 *
 * 这几行必须在任何 server 模块被 import **之前**执行：`server/config.ts` 现在是
 * 惰性读取 `PWQ_AGENT_RUNTIME_CONFIG`，但 habits 的 `HABITS_DIR` 仍是模块加载时的
 * 常量，所以两个环境变量都在这里、在下面的 import 之前就位。
 */
const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwq-agent-cfg-'));
const cfgPath = path.join(cfgDir, 'agent-runtime.json');
process.env.PWQ_AGENT_RUNTIME_CONFIG = cfgPath;
const habitsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwq-habits-'));
process.env.PWQ_HABITS_DIR = habitsDir;

const { freshDb } = await import('./helpers.ts');
const { all } = await import('../server/db/connection.ts');
const { buildRouter } = await import('../server/http/routes.ts');
const { buildProviderPromptArgs, runCli } = await import('../server/agent/cli-exec.ts');
const { invalidateHealth, refreshHealth } = await import('../server/agent/health.ts');
const { readRuntimeConfig, defaultRuntimeConfig } = await import(
  '../server/agent/runtime-config.ts'
);
const { ApiError } = await import('../server/lib/errors.ts');
const { ROOT_DIR } = await import('../server/config.ts');
type Db = import('../server/db/connection.ts').Db;
type AgentRuntimeStatusView = import('../shared/types.ts').AgentRuntimeStatusView;

/** 假 CLI 脚本也放临时目录。 */
const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwq-agent-bin-'));

type Router = ReturnType<typeof buildRouter>;

interface Ctx {
  db: Db;
  router: Router;
}

/** 每个用例一套干净的内存库 + 干净的配置文件 + 干净的健康缓存。 */
function setup(): Ctx {
  fs.rmSync(cfgPath, { force: true });
  invalidateHealth();
  const db = freshDb();
  return { db, router: buildRouter(() => db) };
}

let keyCounter = 0;
const nextKey = (): string => `agent-rt-${(keyCounter += 1)}`;

async function callRoute<T>(
  router: Router,
  method: 'GET' | 'POST' | 'PUT',
  pathname: string,
  init: { body?: unknown; idempotencyKey?: string } = {},
): Promise<T> {
  const match = router.match(method, pathname);
  assert.ok(match, `route ${method} ${pathname} must exist`);
  return (await match.handler({
    req: { headers: {} },
    url: new URL(`http://local${pathname}`),
    params: match.params,
    body: init.body,
    idempotencyKey: init.idempotencyKey ?? nextKey(),
  } as never)) as T;
}

/**
 * 写一个假 CLI。`body` 是 sh 脚本正文，`$@` 就是真实传进来的 argv。
 *
 * 脚本对 `--version` 一律快速成功退出：健康探测走的是这条路，业务行为写在它后面。
 */
function fakeCli(name: string, body: string): string {
  const file = path.join(binDir, name);
  fs.writeFileSync(
    file,
    [
      '#!/bin/sh',
      // 健康探测只问「你能跑吗」，不该触发下面的业务分支。
      'for a in "$@"; do',
      '  if [ "$a" = "--version" ]; then echo "fake-cli 1.0.0"; exit 0; fi',
      'done',
      body,
    ].join('\n'),
    { mode: 0o755 },
  );
  return file;
}

interface PutResult {
  config: { updated_at: string };
  updated_at: string;
}

/**
 * 直接写配置文件（绕过 PUT 的 expected_version），用于铺设用例前置状态。
 *
 * 以 `defaultRuntimeConfig()` 为底再覆盖传入字段：骨架永远是完整的、永远能通过
 * `agentRuntimeConfigSchema`，所以用例读回来时不会被「文件不合法」挡在被测逻辑之外。
 */
function writeConfigFile(overrides: Record<string, unknown>): void {
  fs.writeFileSync(
    cfgPath,
    JSON.stringify(
      {
        ...defaultRuntimeConfig(),
        updated_at: new Date().toISOString(),
        ...overrides,
      },
      null,
      2,
    ),
  );
}

interface MessageResponse {
  result: {
    kind: string;
    headline: string;
    pending_action: { token: string } | null;
    mode: string;
    reasoning: string[];
  };
  source: string;
  mode: string;
  fallback_reason: string | null;
  available_actions: string[];
}

const sendMessage = (ctx: Ctx, body: Record<string, unknown>) =>
  callRoute<MessageResponse>(ctx.router, 'POST', '/api/agent/message', { body });

/** 让健康缓存变成 ok：业务调用前必须先探测过一次（`isAgentReady` 的约定）。 */
const primeHealth = async () => {
  const health = await refreshHealth(readRuntimeConfig(), { force: true });
  return health;
};

const taskTitles = (db: Db): string[] =>
  all<{ title: string }>(db, 'SELECT title FROM tasks ORDER BY created_at').map((r) => r.title);

// ── 1. 未配置：不 spawn，直接走确定性解析 ─────────────────────────────────────

test('未配置运行时：走确定性解析，fallback_reason 说明未启用', async () => {
  const ctx = setup();
  assert.equal(fs.existsSync(cfgPath), false, '前置：配置文件不存在');

  const res = await sendMessage(ctx, { message: 'show queue' });

  assert.equal(res.source, 'deterministic-local');
  assert.equal(res.mode, 'deterministic-local');
  assert.equal(res.fallback_reason, 'not_enabled');
  assert.equal(res.result.mode, 'deterministic-local');
});

// ── 2. 显式停用 ───────────────────────────────────────────────────────────────

test('enabled=false：同样走确定性解析', async () => {
  const ctx = setup();
  writeConfigFile({ enabled: false, cli_path: fakeCli('never-called.sh', 'echo SHOULD_NOT_RUN') });

  const res = await sendMessage(ctx, { message: 'show goals' });

  assert.equal(res.source, 'deterministic-local');
  assert.equal(res.fallback_reason, 'not_enabled');
});

// ── 3. CLI 不存在 ─────────────────────────────────────────────────────────────

test('cli_path 指向不存在的文件：auto 回落确定性，状态路由报 cli_not_found', async () => {
  const ctx = setup();
  writeConfigFile({ enabled: true, cli_path: path.join(binDir, 'definitely-missing') });

  const res = await sendMessage(ctx, { message: 'show queue' });
  assert.equal(res.source, 'deterministic-local');
  assert.equal(res.fallback_reason, 'cli_not_found');

  const status = await callRoute<AgentRuntimeStatusView>(
    ctx.router,
    'GET',
    '/api/agent/runtime-status',
  );
  assert.equal(status.health.ok, false);
  assert.equal(status.health.reason, 'cli_not_found');
  assert.equal(status.effective_mode, 'deterministic-local');
  assert.deepEqual(status.background, { implemented: false, status: 'not_implemented' });
});

// ── 4. 正常纯文本回答 ──────────────────────────────────────────────────────────

test('CLI 返回纯文本：agent 模式给出 answer', async () => {
  const ctx = setup();
  writeConfigFile({ enabled: true, cli_path: fakeCli('plain.sh', 'echo "你好"') });
  await primeHealth();

  const res = await sendMessage(ctx, { message: '随便聊聊', processing_mode: 'agent' });

  assert.equal(res.source, 'agent');
  assert.equal(res.mode, 'agent');
  assert.equal(res.result.kind, 'answer');
  assert.equal(res.result.mode, 'agent');
  assert.match(res.result.headline, /你好/);
});

// ── 5. JSON + proposed_actions：确认前零写入 ───────────────────────────────────

test('JSON proposed_actions：先 preview，确认前 tasks 表为空，确认后才落库', async () => {
  const ctx = setup();
  writeConfigFile({
    enabled: true,
    cli_path: fakeCli(
      'json.sh',
      `cat <<'EOF'
{"answer":"好的","proposed_actions":[{"action":"create_task","title":"写测试"}]}
EOF`,
    ),
  });
  await primeHealth();

  const res = await sendMessage(ctx, { message: '帮我建个任务', processing_mode: 'agent' });

  assert.equal(res.source, 'agent');
  assert.equal(res.result.kind, 'preview');
  assert.ok(res.result.pending_action?.token, 'preview 必须带 token');

  // 这是本特性最关键的不变量：模型说要建任务，但确认之前一个字都没写。
  assert.deepEqual(taskTitles(ctx.db), [], '确认前 tasks 表必须为空');

  await callRoute(ctx.router, 'POST', '/api/agent/preview/confirm', {
    body: { token: res.result.pending_action!.token },
  });

  assert.deepEqual(taskTitles(ctx.db), ['写测试'], '确认后任务才出现');
});

test('预览可以取消，且取消后不写任何数据', async () => {
  const ctx = setup();
  writeConfigFile({
    enabled: true,
    cli_path: fakeCli(
      'json-cancel.sh',
      `cat <<'EOF'
{"answer":"好的","proposed_actions":[{"action":"create_task","title":"不该被创建"}]}
EOF`,
    ),
  });
  await primeHealth();

  const res = await sendMessage(ctx, { message: '建任务', processing_mode: 'agent' });
  const token = res.result.pending_action!.token;

  await callRoute(ctx.router, 'POST', '/api/agent/preview/cancel', { body: { token } });
  assert.deepEqual(taskTitles(ctx.db), [], '取消后 tasks 仍为空');

  // 取消过的 token 不能再确认。
  await assert.rejects(
    () =>
      callRoute(ctx.router, 'POST', '/api/agent/preview/confirm', {
        body: { token },
      }),
    (error: unknown) => error instanceof ApiError && error.status === 404,
  );
});

// ── 6. 超时：不自动回退 ────────────────────────────────────────────────────────

test('超时：报 agent-error 且不自动回退；显式 fallback 才走确定性', async () => {
  const ctx = setup();
  writeConfigFile({
    enabled: true,
    timeout_ms: 700,
    cli_path: fakeCli('slow.sh', 'sleep 5\necho "太慢了"'),
  });
  await primeHealth();

  const res = await sendMessage(ctx, { message: 'show queue', processing_mode: 'agent' });

  assert.equal(res.source, 'agent-error');
  assert.equal(res.result.kind, 'error');
  assert.deepEqual(res.available_actions, ['retry_agent', 'process_with_command_mode']);
  assert.match(res.result.headline, /未写入任何数据/);

  // 同一条消息带 fallback:true 重发，才允许退回确定性解析，并如实标注来源。
  await primeHealth();
  const retried = await sendMessage(ctx, {
    message: 'show queue',
    processing_mode: 'agent',
    fallback: true,
  });
  assert.equal(retried.source, 'deterministic-local-fallback');
  assert.equal(retried.fallback_reason, 'agent-error-fallback');
});

// ── 7. 非零退出 ───────────────────────────────────────────────────────────────

test('非零退出码：报 agent-error，不静默回退', async () => {
  const ctx = setup();
  writeConfigFile({ enabled: true, cli_path: fakeCli('boom.sh', 'echo "坏了" >&2\nexit 3') });
  await primeHealth();

  const res = await sendMessage(ctx, { message: 'show queue', processing_mode: 'agent' });

  assert.equal(res.source, 'agent-error');
  assert.equal(res.result.kind, 'error');
  assert.match(res.result.reasoning.join(' '), /nonzero_exit/);
});

// ── 8. 非法 JSON 当纯文本 ──────────────────────────────────────────────────────

test('输出不是 JSON：当作纯文本回答，不报错', async () => {
  const ctx = setup();
  writeConfigFile({
    enabled: true,
    cli_path: fakeCli('garbage.sh', 'echo "}{ not json at all ][ %%%"'),
  });
  await primeHealth();

  const res = await sendMessage(ctx, { message: '随便问问', processing_mode: 'agent' });

  assert.equal(res.source, 'agent');
  assert.equal(res.result.kind, 'answer');
  assert.equal(res.result.pending_action, null);
});

// ── 9. 输出上限 ───────────────────────────────────────────────────────────────

test('CLI 输出 200KB：不炸，stdout 被截断到上限', async () => {
  const big = await runCli({
    executable: fakeCli(
      'flood.sh',
      // 2000 行 × ~100 字符 ≈ 200KB，远超 64KiB 上限。
      'i=0\nwhile [ $i -lt 2000 ]; do printf "%0100d\\n" $i; i=$((i+1)); done',
    ),
    args: [],
    cwd: ROOT_DIR,
    envNames: ['PATH'],
    timeoutMs: 20000,
  });

  assert.equal(big.exitCode, 0);
  assert.ok(big.stdout.length <= 65536, `stdout 应被截断，实际 ${big.stdout.length}`);
  assert.ok(big.stdout.length > 1000, '截断后仍应保留前面的内容');
});

// ── 10. 环境变量白名单 ─────────────────────────────────────────────────────────

test('环境白名单：未被允许的变量不传给子进程', async () => {
  process.env.PWQ_SHOULD_NOT_EXIST = 'leaked-value';
  process.env.PWQ_ALLOWED_MARKER = 'allowed-value';
  try {
    const result = await runCli({
      executable: fakeCli(
        'envcheck.sh',
        [
          '[ -n "$PWQ_SHOULD_NOT_EXIST" ] && echo LEAK',
          '[ -n "$PWQ_ALLOWED_MARKER" ] && echo ALLOWED_PRESENT',
          '[ -n "$PATH" ] && echo PATH_PRESENT',
          'exit 0',
        ].join('\n'),
      ),
      args: [],
      cwd: ROOT_DIR,
      // 只放行这一个；PWQ_SHOULD_NOT_EXIST 不在白名单里。
      envNames: ['PWQ_ALLOWED_MARKER'],
      timeoutMs: 20000,
    });

    assert.doesNotMatch(result.stdout, /LEAK/, '未白名单的变量绝不能泄给子进程');
    assert.match(result.stdout, /ALLOWED_PRESENT/, '白名单内的变量应被传入');
    assert.match(result.stdout, /PATH_PRESENT/, 'PATH 总是给，否则连 sh 都找不到');
  } finally {
    delete process.env.PWQ_SHOULD_NOT_EXIST;
    delete process.env.PWQ_ALLOWED_MARKER;
  }
});

// ── 11. 工作目录逃逸 ───────────────────────────────────────────────────────────

test('working_directory 指向项目外：PUT 被 400 拒绝', async () => {
  const ctx = setup();
  writeConfigFile({ enabled: false });
  const current = readRuntimeConfig();

  await assert.rejects(
    () =>
      callRoute(ctx.router, 'PUT', '/api/agent/runtime-config', {
        body: {
          expected_version: current.updated_at,
          config: {
            enabled: true,
            provider: 'claude',
            cli_path: '/bin/echo',
            model: null,
            args: [],
            timeout_ms: 20000,
            working_directory: '/tmp',
            allowed_env_names: ['PATH'],
          },
        },
      }),
    (error: unknown) =>
      error instanceof ApiError &&
      error.status === 400 &&
      /working_directory/.test(error.message),
  );
});

test('cli_path 非绝对路径：PUT 被 400 拒绝', async () => {
  const ctx = setup();
  writeConfigFile({ enabled: false });
  const current = readRuntimeConfig();

  await assert.rejects(
    () =>
      callRoute(ctx.router, 'PUT', '/api/agent/runtime-config', {
        body: {
          expected_version: current.updated_at,
          config: {
            enabled: true,
            provider: 'claude',
            cli_path: 'claude',
            model: null,
            args: [],
            timeout_ms: 20000,
            working_directory: ROOT_DIR,
            allowed_env_names: ['PATH'],
          },
        },
      }),
    (error: unknown) =>
      error instanceof ApiError && error.status === 400 && /cli_path/.test(error.message),
  );
});

// ── 11b. 关闭态可以不填 cli_path，且必须能往返 ────────────────────────────────

test('enabled=false + cli_path 空串：PUT 成功，且回读不抛错（默认态可往返）', async () => {
  const ctx = setup();
  const current = readRuntimeConfig();
  assert.equal(current.cli_path, '', '前置：默认态不预设任何二进制');

  const res = await callRoute<PutResult>(ctx.router, 'PUT', '/api/agent/runtime-config', {
    body: {
      expected_version: current.updated_at,
      config: {
        enabled: false,
        provider: 'claude',
        cli_path: '',
        model: null,
        args: [],
        timeout_ms: 30000,
        working_directory: ROOT_DIR,
        allowed_env_names: ['PATH'],
      },
    },
  });
  assert.ok(res.updated_at);

  // 关键：写回磁盘的关闭态文件必须自己过得了 schema，否则「还没配置」会长得像「文件坏了」。
  const reread = readRuntimeConfig();
  assert.equal(reread.enabled, false);
  assert.equal(reread.cli_path, '');
  assert.equal(reread.timeout_ms, 30000);
});

test('enabled=true + cli_path 空串：PUT 被 400 拒绝（启用时必填）', async () => {
  const ctx = setup();
  const current = readRuntimeConfig();

  await assert.rejects(
    () =>
      callRoute(ctx.router, 'PUT', '/api/agent/runtime-config', {
        body: {
          expected_version: current.updated_at,
          config: {
            enabled: true,
            provider: 'claude',
            cli_path: '',
            model: null,
            args: [],
            timeout_ms: 20000,
            working_directory: ROOT_DIR,
            allowed_env_names: ['PATH'],
          },
        },
      }),
    (error: unknown) =>
      error instanceof ApiError && error.status === 400 && /cli_path/.test(error.message),
  );
});

test('enabled=false 也不能填相对 cli_path：关掉开关不是蒙混的借口', async () => {
  const ctx = setup();
  const current = readRuntimeConfig();

  await assert.rejects(
    () =>
      callRoute(ctx.router, 'PUT', '/api/agent/runtime-config', {
        body: {
          expected_version: current.updated_at,
          config: {
            enabled: false,
            provider: 'claude',
            cli_path: 'claude',
            model: null,
            args: [],
            timeout_ms: 20000,
            working_directory: ROOT_DIR,
            allowed_env_names: ['PATH'],
          },
        },
      }),
    (error: unknown) =>
      error instanceof ApiError && error.status === 400 && /cli_path/.test(error.message),
  );
});

// ── 12. 参数注入 / NUL ─────────────────────────────────────────────────────────

test('args 含 NUL：被校验拒绝', async () => {
  const ctx = setup();
  writeConfigFile({ enabled: false });
  const current = readRuntimeConfig();

  await assert.rejects(
    () =>
      callRoute(ctx.router, 'PUT', '/api/agent/runtime-config', {
        body: {
          expected_version: current.updated_at,
          config: {
            enabled: true,
            provider: 'claude',
            cli_path: '/bin/echo',
            model: null,
            args: ['--flag injected'],
            timeout_ms: 20000,
            working_directory: ROOT_DIR,
            allowed_env_names: ['PATH'],
          },
        },
      }),
    (error: unknown) => error instanceof ApiError && error.status === 400,
  );
});

test('buildProviderPromptArgs 产出数组，prompt 永远是单个 argv 元素', () => {
  const nasty = 'title"; rm -rf / #$(whoami)`id`';

  const claudeArgs = buildProviderPromptArgs('claude', nasty, { model: 'm1', args: ['--extra'] });
  assert.ok(Array.isArray(claudeArgs));
  // shell 元字符原样保留在**一个**元素里，没有被切开，也没有被转义成命令。
  assert.equal(claudeArgs.filter((a) => a === nasty).length, 1);
  assert.deepEqual(claudeArgs, [
    '-p', nasty,
    '--tools', '',
    '--output-format', 'text',
    '--safe-mode',
    '--no-session-persistence',
    '--model', 'm1',
    '--extra',
  ]);

  const codexArgs = buildProviderPromptArgs('codex', nasty, { model: null, args: [] });
  assert.deepEqual(codexArgs, [
    'exec',
    '--json',
    '--sandbox', 'read-only',
    '--ephemeral',
    '--skip-git-repo-check',
    '--color', 'never',
    nasty,
  ]);
});

test('shell:false —— 元字符不会被执行', async () => {
  // 脚本把收到的第一个参数原样打印。若走了 shell，`$(...)` 会被求值。
  const result = await runCli({
    executable: fakeCli('argecho.sh', 'printf "%s" "$1"'),
    args: ['$(echo EXECUTED)'],
    cwd: ROOT_DIR,
    envNames: ['PATH'],
    timeoutMs: 20000,
  });

  assert.equal(result.stdout, '$(echo EXECUTED)', '参数必须原样到达，不被 shell 求值');
  assert.doesNotMatch(result.stdout, /EXECUTED$/);
});

// ── 13. expected_version 幂等与 409 ────────────────────────────────────────────

test('PUT：首次成功、旧 version 409、同内容重 PUT 不 bump', async () => {
  const ctx = setup();
  const payload = {
    enabled: true,
    provider: 'claude' as const,
    cli_path: fakeCli('cfg.sh', 'echo hi'),
    model: null,
    args: [],
    timeout_ms: 20000,
    working_directory: ROOT_DIR,
    allowed_env_names: ['PATH'],
  };

  const first = await callRoute<PutResult>(ctx.router, 'PUT', '/api/agent/runtime-config', {
    body: { expected_version: readRuntimeConfig().updated_at, config: payload },
  });
  const version1 = first.updated_at;
  assert.ok(version1);

  // 旧 version 再 PUT（内容也变了）→ 409 version_conflict。
  await assert.rejects(
    () =>
      callRoute(ctx.router, 'PUT', '/api/agent/runtime-config', {
        body: {
          expected_version: '1970-01-01T00:00:00.000Z',
          config: { ...payload, timeout_ms: 30000 },
        },
      }),
    (error: unknown) =>
      error instanceof ApiError && error.status === 409 && error.code === 'version_conflict',
  );

  // 相同内容重 PUT → 幂等，不 bump updated_at。
  const again = await callRoute<PutResult>(ctx.router, 'PUT', '/api/agent/runtime-config', {
    body: { expected_version: version1, config: payload },
  });
  assert.equal(again.updated_at, version1, '同内容重 PUT 不应 bump 版本');
});

test('GET runtime-config 不回显任何环境变量的值', async () => {
  const ctx = setup();
  process.env.PWQ_SECRET_PROBE = 'super-secret-value';
  try {
    writeConfigFile({ enabled: true, allowed_env_names: ['PATH', 'PWQ_SECRET_PROBE'] });
    const res = await callRoute<{ config: unknown }>(
      ctx.router,
      'GET',
      '/api/agent/runtime-config',
    );
    const serialized = JSON.stringify(res);

    assert.match(serialized, /PWQ_SECRET_PROBE/, '名字应该在');
    assert.doesNotMatch(serialized, /super-secret-value/, '值绝不能出现在响应里');
  } finally {
    delete process.env.PWQ_SECRET_PROBE;
  }
});

// ── 14. 连通性测试 ─────────────────────────────────────────────────────────────

test('runtime-test：CLI 回 OK 则 ok=true，且不建 session、不写库', async () => {
  const ctx = setup();
  writeConfigFile({ enabled: true, cli_path: fakeCli('ok.sh', 'echo OK') });

  const res = await callRoute<{ ok: boolean; stdout_excerpt: string }>(
    ctx.router,
    'POST',
    '/api/agent/runtime-test',
    { body: {} },
  );

  assert.equal(res.ok, true);
  assert.match(res.stdout_excerpt, /OK/);

  // 连通性测试不该留下任何痕迹。
  assert.deepEqual(all(ctx.db, 'SELECT id FROM agent_sessions'), []);
  assert.deepEqual(taskTitles(ctx.db), []);
});

test('runtime-test：关闭状态也可以验证连接，但不会启用助手', async () => {
  const ctx = setup();
  writeConfigFile({ enabled: false, cli_path: fakeCli('unused.sh', 'echo OK') });

  const res = await callRoute<{ ok: boolean; reason: string }>(
    ctx.router,
    'POST',
    '/api/agent/runtime-test',
    { body: {} },
  );

  assert.equal(res.ok, true);
  assert.equal(res.reason, null);
  assert.equal(readRuntimeConfig().enabled, false);
  assert.deepEqual(all(ctx.db, 'SELECT id FROM agent_sessions'), []);
});

// ── 命令模式与原始消息留存 ──────────────────────────────────────────────────────

test('processing_mode=command：即使 agent 就绪也走确定性解析', async () => {
  const ctx = setup();
  writeConfigFile({ enabled: true, cli_path: fakeCli('ready.sh', 'echo "不该被调用"') });
  await primeHealth();

  const res = await sendMessage(ctx, { message: 'show queue', processing_mode: 'command' });

  assert.equal(res.source, 'deterministic-local');
  assert.equal(res.fallback_reason, 'user-requested-command-mode');
});

test('agent 失败时仍然保留用户的原始消息', async () => {
  const ctx = setup();
  writeConfigFile({ enabled: true, cli_path: fakeCli('fail.sh', 'exit 9') });
  await primeHealth();

  await sendMessage(ctx, { message: '这句话必须被保留', processing_mode: 'agent' });

  const stored = all<{ content: string; role: string }>(
    ctx.db,
    "SELECT content, role FROM agent_messages WHERE role = 'user'",
  );
  assert.ok(
    stored.some((m) => m.content === '这句话必须被保留'),
    '原始 user message 必须落库，会话不能因模型失败而丢',
  );
});

test('真实业务库与 habits 未被触碰：本文件全程用内存库 + 临时目录', () => {
  // 这不是一句注释而是一条断言：配置与 habits 的环境变量都必须指向临时目录。
  assert.ok(process.env.PWQ_AGENT_RUNTIME_CONFIG?.includes('pwq-agent-cfg-'));
  assert.ok(process.env.PWQ_HABITS_DIR?.includes('pwq-habits-'));
  assert.doesNotMatch(process.env.PWQ_AGENT_RUNTIME_CONFIG ?? '', /personal-work-queue\/config/);
});

test('启用后的首条助手消息自动检查 CLI，无需先打开设置或查询状态', async () => {
  const ctx = setup();
  writeConfigFile({enabled:true, cli_path:fakeCli('cold-ready.sh', 'echo "cold-start-answer"')});
  invalidateHealth();
  const result = await sendMessage(ctx, {message:'请回答', processing_mode:'agent'});
  assert.equal(result.source, 'agent');
  assert.equal(result.result.headline, 'cold-start-answer');
});


