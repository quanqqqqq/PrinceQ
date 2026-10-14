/**
 * 本地 CLI 自动检测的隔离测试。
 *
 * **全程不碰真实环境**：数据库是一次性内存库（`freshDb`），运行时配置指向临时目录
 * （`PWQ_AGENT_RUNTIME_CONFIG`），假 CLI 写在临时目录里。用户的 `data/work-queue.db`、
 * `habits/`、真实的 `config/agent-runtime.json` 一个字节都不会被写。
 *
 * **绝不调用真实的 `claude` / `codex`**（只有最后一个用例是例外，且只跑 `--version`）：
 * 每个用例自己写 shell 脚本当假 CLI，装成「正常回答」「超时」「输出乱码」。这样跑的是
 * 真实的 spawn 路径（argv 传递、环境白名单、超时终止都是真的），又完全离线、可重复。
 *
 * 最该守住的几条：**检测只跑 `--version`**（假 CLI 把自己收到的 argv 记在文件里，用例
 * 回头检查里面没有 auth/login/status）、**子进程只拿到 PATH**（用例先把假的
 * `ANTHROPIC_API_KEY` 塞进 `process.env`，假 CLI 断言自己看不到）、**不走 shell**
 * （名字里带 `;` 的文件只是字面文件名）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 这几行必须在任何 server 模块被 import **之前**执行：`server/config.ts` 惰性读取
 * `PWQ_AGENT_RUNTIME_CONFIG`，但 habits 的 `HABITS_DIR` 仍是模块加载时的常量，所以两个
 * 环境变量都在这里、在下面的 import 之前就位。
 */
const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwq-detect-cfg-'));
const cfgPath = path.join(cfgDir, 'agent-runtime.json');
process.env.PWQ_AGENT_RUNTIME_CONFIG = cfgPath;
const habitsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwq-detect-habits-'));
process.env.PWQ_HABITS_DIR = habitsDir;

const { freshDb } = await import('./helpers.ts');
const { buildRouter } = await import('../server/http/routes.ts');
const { detectCli } = await import('../server/agent/detect.ts');
const { readRuntimeConfig, defaultRuntimeConfig } = await import(
  '../server/agent/runtime-config.ts'
);
const { ROOT_DIR } = await import('../server/config.ts');
type RuntimeDetectResponse = import('../server/agent/detect.ts').RuntimeDetectResponse;

type Router = ReturnType<typeof buildRouter>;

let keyCounter = 0;
const nextKey = (): string => `agent-detect-${(keyCounter += 1)}`;

async function callRoute<T>(
  router: Router,
  method: 'GET' | 'POST' | 'PUT',
  pathname: string,
  init: { body?: unknown } = {},
): Promise<T> {
  const match = router.match(method, pathname);
  assert.ok(match, `route ${method} ${pathname} must exist`);
  return (await match.handler({
    url: new URL(`http://local${pathname}`),
    params: match.params,
    body: init.body,
    idempotencyKey: nextKey(),
  } as never)) as T;
}

/**
 * 一套隔离环境：空的假 `HOME`（于是白名单里的 `~/.local/bin` 指向一个不存在的目录）、
 * 受控的 `PATH`、干净的配置文件。
 *
 * 为什么要换 `HOME`：白名单第一项是 `~/.local/bin`，而开发机上那里**真的**装着
 * `claude`。不隔离的话，「无候选」这个用例在作者机器上必然失败、在 CI 上必然通过——
 * 一个随机器而变的测试等于没有测试。
 */
interface Env {
  dir: string;
  /** 白名单目录之一（`<fakeHome>/.local/bin`），用来验证「白名单优先于 PATH」。 */
  localBin: string;
  /** 只在 `PATH` 里、不在白名单里的目录。 */
  pathBin: string;
  restore: () => void;
}

function withEnv(opts: { pathDirs?: string[]; extraEnv?: Record<string, string> } = {}): Env {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwq-detect-env-'));
  const localBin = path.join(dir, 'home', '.local', 'bin');
  const pathBin = path.join(dir, 'pathbin');

  const saved = { ...process.env };
  process.env.HOME = path.join(dir, 'home');
  // PATH 不能真的空：`runCli` 的 buildEnv 在 PATH 缺失时会兜底成 /usr/bin:/bin。给一个
  // 存在但空无一物的目录，才是真正「PATH 上什么都没有」。
  process.env.PATH = (opts.pathDirs ?? [path.join(dir, 'empty')]).join(path.delimiter);
  for (const [name, value] of Object.entries(opts.extraEnv ?? {})) {
    process.env[name] = value;
  }
  fs.mkdirSync(path.join(dir, 'empty'), { recursive: true });
  fs.rmSync(cfgPath, { force: true });

  return {
    dir,
    localBin,
    pathBin,
    restore: () => {
      for (const name of Object.keys(process.env)) {
        if (!(name in saved)) delete process.env[name];
      }
      Object.assign(process.env, saved);
    },
  };
}

/**
 * 写一个假 CLI，并返回它记录 argv / env 的那个文件的路径。
 *
 * 脚本把每次调用收到的 argv 和几个敏感环境变量的可见性**追加**到日志文件里，用例回头读
 * 它来断言「检测只跑了 `--version`」「子进程看不到 API key」。日志是「被测对象自己写下
 * 的供词」，比在测试里重新推演一遍 spawn 参数更可信。
 */
function fakeCli(
  dir: string,
  name: string,
  body: string,
): { file: string; log: string } {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  const log = `${file}.argv.log`;
  fs.writeFileSync(
    file,
    [
      '#!/bin/sh',
      `echo "ARGV:$*" >> "${log}"`,
      // 敏感变量的可见性如实记一笔：空 = 子进程确实没拿到。
      `echo "ANTHROPIC_API_KEY:\${ANTHROPIC_API_KEY-}" >> "${log}"`,
      `echo "OPENAI_API_KEY:\${OPENAI_API_KEY-}" >> "${log}"`,
      `echo "PATH_SEEN:\${PATH-}" >> "${log}"`,
      body,
    ].join('\n'),
    { mode: 0o755 },
  );
  return { file, log };
}

const readLog = (log: string): string[] =>
  fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];

const argvLines = (log: string): string[] =>
  readLog(log).filter((line) => line.startsWith('ARGV:'));

/** 直接写配置文件（绕过 PUT 的 expected_version），用于铺设用例前置状态。 */
function writeConfigFile(overrides: Record<string, unknown>): void {
  fs.writeFileSync(
    cfgPath,
    JSON.stringify(
      {
        ...defaultRuntimeConfig(),
        // 刻意落在过去，而不是 `new Date()`。否则「persist 之后 updated_at 推进了吗」
        // 这个断言会偶发失败：`nowIso()` 只有毫秒精度，而无候选那条路径一个子进程都不
        // spawn，于是前置写入和 persist 真的可能落在同一毫秒里，两个时间戳逐字节相同。
        // 把基线推到过去，时序就是确定的——断言本身的强度一点没减。
        updated_at: new Date(Date.now() - 1000).toISOString(),
        ...overrides,
      },
      null,
      2,
    ),
  );
}

// ── 1. 无候选：不推荐、不给路径 ───────────────────────────────────────────────

test('无候选：空 PATH + 白名单目录不存在 → recommended=null、cli_path=null', async () => {
  const env = withEnv();
  try {
    const result = await detectCli({});

    // 项目自己的 node_modules/.bin 也在白名单里，但那里没有 claude/codex，所以
    // 「一个候选都没有」是可断言的硬结论，而不是「大概没有」。
    assert.deepEqual(result.candidates, []);
    assert.equal(result.recommended, null);
    assert.equal(result.config_patch.cli_path, null);
    assert.equal(result.config_patch.provider, null);
    // 没探到也要给出可用的默认值，否则前端拿不到能填的工作目录。
    assert.equal(result.config_patch.working_directory, ROOT_DIR);
    assert.equal(result.config_patch.timeout_ms, 20000);
    assert.ok(Date.parse(result.detected_at) > 0, 'detected_at 必须是合法时间');
  } finally {
    env.restore();
  }
});

// ── 2. 多候选排序：白名单目录优先于 PATH ──────────────────────────────────────

test('多候选：白名单目录里的 claude rank=1，PATH 里的排在后面', async () => {
  const env = withEnv();
  try {
    process.env.PATH = [env.pathBin, path.join(env.dir, 'empty')].join(path.delimiter);
    const whitelisted = fakeCli(env.localBin, 'claude', 'echo "whitelisted 1.0.0"; exit 0');
    const onPath = fakeCli(env.pathBin, 'claude', 'echo "on-path 2.0.0"; exit 0');

    const result = await detectCli({ provider: 'claude' });

    assert.equal(result.candidates.length, 2);
    const [first, second] = result.candidates;
    assert.equal(first.path, whitelisted.file, '~/.local/bin 必须排在 PATH 目录之前');
    assert.equal(first.rank, 1);
    assert.equal(second.path, onPath.file);
    assert.equal(second.rank, 2);
    // 推荐跟着排序走：第一个跑得起来的就是它。
    assert.equal(result.recommended?.path, whitelisted.file);
    assert.equal(result.config_patch.cli_path, whitelisted.file);
    assert.equal(result.config_patch.provider, 'claude');
  } finally {
    env.restore();
  }
});

test('只找指定 provider：provider=codex 时不去探 claude', async () => {
  const env = withEnv();
  try {
    fakeCli(env.localBin, 'claude', 'echo "claude 1.0.0"; exit 0');
    const codex = fakeCli(env.localBin, 'codex', 'echo "codex 9.9.9"; exit 0');

    const result = await detectCli({ provider: 'codex' });

    assert.deepEqual(
      result.candidates.map((c) => c.path),
      [codex.file],
    );
    assert.equal(result.recommended?.provider, 'codex');
  } finally {
    env.restore();
  }
});

// ── 3. version 文本 ──────────────────────────────────────────────────────────

test('version 文本：取 --version 首行，exit_code=0', async () => {
  const env = withEnv();
  try {
    const cli = fakeCli(env.localBin, 'claude', 'echo "1.2.3"; exit 0');

    const result = await detectCli({ provider: 'claude' });

    const [candidate] = result.candidates;
    assert.equal(candidate.version, '1.2.3');
    assert.equal(candidate.exit_code, 0);
    assert.equal(candidate.exists, true);
    assert.equal(candidate.timed_out, false);
    assert.equal(typeof candidate.latency_ms, 'number');
    // 两次探针，顺序固定，而且只有这两个参数。
    assert.deepEqual(argvLines(cli.log), ['ARGV:--version', 'ARGV:--help']);
  } finally {
    env.restore();
  }
});

test('version 文本：多行 banner 只取首行，超长截断到 200 字符', async () => {
  const env = withEnv();
  try {
    // 长串在 JS 这边拼好再 echo。**不能**在脚本里用 `seq`/`head` 之类生成：探针给
    // 子进程的 PATH 只有被测环境那一个空目录，外部命令一个都找不到——这恰好也是
    // env 白名单在起作用的旁证。
    const long = 'v'.repeat(400);
    fakeCli(env.localBin, 'claude', `echo "${long}"; echo "second line"; exit 0`);

    const result = await detectCli({ provider: 'claude' });

    const version = result.candidates[0].version ?? '';
    assert.equal(version.length, 200, '超长版本串必须被截断');
    assert.ok(!version.includes('second'), '只取首行');
  } finally {
    env.restore();
  }
});

// ── 4. 乱码 / 非 UTF-8 输出不炸 ──────────────────────────────────────────────

test('非 UTF-8 输出：不抛错，非法字节变成 U+FFFD', async () => {
  const env = withEnv();
  try {
    // 0xff 0xfe 在 UTF-8 里是非法起始字节。
    fakeCli(env.localBin, 'claude', `printf '\\377\\376 broken\\n'; exit 0`);

    const result = await detectCli({ provider: 'claude' });

    const candidate = result.candidates[0];
    assert.equal(candidate.exit_code, 0);
    assert.ok(candidate.version, '乱码也要给出一个字符串，而不是 null');
    assert.ok(
      candidate.version?.includes('�'),
      `非法字节应被替换为 U+FFFD，实际：${JSON.stringify(candidate.version)}`,
    );
    // 整个响应必须可序列化：它要经由 JSON 发给前端。
    assert.ok(JSON.stringify(result).length > 0);
  } finally {
    env.restore();
  }
});

test('控制字符被剔除：ANSI 转义不进 version 文本', async () => {
  const env = withEnv();
  try {
    fakeCli(env.localBin, 'claude', `printf '\\033[31m1.2.3\\033[0m\\n'; exit 0`);

    const result = await detectCli({ provider: 'claude' });

    const version = result.candidates[0].version ?? '';
    assert.ok(!version.includes('\u001b'), 'ESC 必须被剔掉');
    assert.ok(version.includes('1.2.3'));
  } finally {
    env.restore();
  }
});

// ── 5. 超时 ──────────────────────────────────────────────────────────────────

test('超时：探针 3 秒上限，超时仍如实返回候选', async () => {
  const env = withEnv();
  try {
    // `/bin/sleep` 写绝对路径：子进程的 PATH 只有一个空目录，裸 `sleep` 找不到。
    fakeCli(env.localBin, 'claude', '/bin/sleep 5; echo "never"; exit 0');

    const result = await detectCli({ provider: 'claude' });

    assert.equal(result.candidates.length, 1, '超时的候选不能从列表里消失');
    const candidate = result.candidates[0];
    assert.equal(candidate.timed_out, true);
    assert.equal(candidate.exists, true);
    assert.notEqual(candidate.exit_code, 0);
    // 跑不起来的不该被推荐。
    assert.equal(result.recommended, null);
    assert.equal(result.config_patch.cli_path, null);
  } finally {
    env.restore();
  }
});

test('非零退出：列为候选但不被推荐', async () => {
  const env = withEnv();
  try {
    const broken = fakeCli(env.localBin, 'claude', 'echo "boom" >&2; exit 3');
    process.env.PATH = [env.pathBin, path.join(env.dir, 'empty')].join(path.delimiter);
    const good = fakeCli(env.pathBin, 'claude', 'echo "2.0.0"; exit 0');

    const result = await detectCli({ provider: 'claude' });

    assert.equal(result.candidates[0].path, broken.file);
    assert.equal(result.candidates[0].exit_code, 3);
    // 推荐跳过坏的那个，落到真正能跑的。
    assert.equal(result.recommended?.path, good.file);
    assert.equal(result.config_patch.cli_path, good.file);
  } finally {
    env.restore();
  }
});

// ── 6. auth_status 恒为 unknown，且从不跑 auth/login/status ────────────────────

test('auth_status 恒为 unknown：检测从不执行 auth/login/status 子命令', async () => {
  const env = withEnv();
  try {
    const claude = fakeCli(env.localBin, 'claude', 'echo "1.0.0"; exit 0');
    const codex = fakeCli(env.localBin, 'codex', 'echo "2.0.0"; exit 0');

    const result = await detectCli({});

    assert.equal(result.candidates.length, 2);
    for (const candidate of result.candidates) {
      assert.equal(candidate.auth_status, 'unknown');
    }

    // 假 CLI 自己记下的 argv 才是证据。每个候选只被调用两次：--version 和 --help。
    // claude 用根 --help；codex 用子命令 exec --help。argv 形状按 provider 区分。
    assert.deepEqual(argvLines(claude.log), ['ARGV:--version', 'ARGV:--help']);
    assert.deepEqual(argvLines(codex.log), ['ARGV:--version', 'ARGV:exec --help']);
    for (const log of [claude.log, codex.log]) {
      const lines = argvLines(log);
      for (const forbidden of ['auth', 'login', 'logout', 'status', 'whoami', 'token']) {
        assert.ok(
          !lines.some((line) => line.includes(forbidden)),
          `argv 不允许出现 "${forbidden}"：${lines.join(' | ')}`,
        );
      }
    }
  } finally {
    env.restore();
  }
});

// ── 7. help 能力探测 ─────────────────────────────────────────────────────────

/**
 * 一个会响应 `--help` 的假 CLI 的脚本体：help 分支按传入的脚本行作答，`--version`
 * 一律正常退出（这样「help 怎么样」和「候选是否可用」能被分开断言）。
 *
 * help 文本只用 `echo` / `printf` 拼出来：探针给子进程的 PATH 只有被测环境那一个空目录，
 * `cat` 之类的外部命令一个都找不到。
 */
const helpBody = (branch: string[]): string =>
  [
    // claude 用根 `--help`；codex 用子命令 `exec --help`。两者都要命中 help 分支。
    'if [ "$1" = "--help" ] || { [ "$1" = "exec" ] && [ "$2" = "--help" ]; }; then',
    ...branch.map((line) => `  ${line}`),
    'fi',
    'echo "1.2.3"; exit 0',
  ].join('\n');

/** 一份「长得像真 CLI」的 help：非交互开关、输出格式列表、`--model` 都有。 */
const HELP_BODY = helpBody([
  'echo "Usage: claude [options]"',
  'echo "  -p, --print            Print (non-interactive) mode"',
  `echo '  --output-format <fmt>  Output format: "json", "text", "stream"'`,
  'echo "  --model <name>         Model to use"',
  'exit 0',
]);

test('help 探测：解析出非交互开关、--model、--output-format 的可选值', async () => {
  const env = withEnv();
  try {
    fakeCli(env.localBin, 'claude', HELP_BODY);

    const result = await detectCli({ provider: 'claude' });

    const caps = result.candidates[0].capabilities;
    assert.equal(caps.help_checked, true);
    assert.equal(caps.non_interactive, true, '-p / --print 必须被认出来');
    assert.equal(caps.supports_model_flag, true);
    for (const format of ['json', 'text', 'stream']) {
      assert.ok(caps.output_formats.includes(format), `output_formats 应含 ${format}`);
    }
    // 尖括号占位符是语法说明，不是一个叫 fmt 的格式。
    assert.ok(!caps.output_formats.includes('fmt'), '<fmt> 占位符不该被当成格式名');
    // 确认过 json 之后，才建议这一对 flag——而且只有这一对。
    assert.deepEqual(result.config_patch.recommended_args, ['--output-format', 'json']);
  } finally {
    env.restore();
  }
});

test('help 探测：recommended_args 永不包含 prompt / --model / -p', async () => {
  const env = withEnv();
  try {
    fakeCli(env.localBin, 'claude', HELP_BODY);

    const args = (await detectCli({ provider: 'claude' })).config_patch.recommended_args;

    // help 里 --model 与 -p 都在，能力里也如实记了，但它们不该进建议 argv：
    // 模型由配置的 model 字段决定，-p 是用来接 prompt 的。
    for (const forbidden of ['--model', '-p', '--print', '--dangerously-skip-permissions']) {
      assert.ok(!args.includes(forbidden), `recommended_args 不允许出现 ${forbidden}：${args}`);
    }
  } finally {
    env.restore();
  }
});

test('help 超时：能力取保守默认，但候选仍由 --version 决定可用性', async () => {
  const env = withEnv();
  try {
    // `/bin/sleep` 写绝对路径：子进程 PATH 只有一个空目录，裸 `sleep` 找不到。
    const cli = fakeCli(env.localBin, 'claude', helpBody(['/bin/sleep 5', 'exit 0']));

    const result = await detectCli({ provider: 'claude' });

    assert.equal(result.candidates.length, 1, 'help 超时的候选不能从列表里消失');
    const candidate = result.candidates[0];
    const caps = candidate.capabilities;
    assert.equal(caps.help_checked, false);
    assert.equal(caps.non_interactive, false, '没读到不等于支持');
    assert.equal(caps.supports_model_flag, false);
    assert.deepEqual(caps.output_formats, []);
    // --version 退出 0，所以它照样是推荐项；只是我们不替它猜参数。
    assert.equal(candidate.exit_code, 0);
    assert.equal(candidate.timed_out, false, 'timed_out 只反映 --version');
    assert.equal(result.recommended?.path, cli.file);
    assert.deepEqual(result.config_patch.recommended_args, []);
  } finally {
    env.restore();
  }
});

test('help 非零退出：help_checked=false，候选仍可用且仍被推荐', async () => {
  const env = withEnv();
  try {
    const cli = fakeCli(env.localBin, 'claude', helpBody(['echo "no help for you" >&2', 'exit 3']));

    const result = await detectCli({ provider: 'claude' });

    assert.equal(result.candidates[0].capabilities.help_checked, false);
    assert.equal(result.candidates[0].exit_code, 0, 'exit_code 只来自 --version');
    assert.equal(result.recommended?.path, cli.file);
    assert.deepEqual(result.config_patch.recommended_args, []);
  } finally {
    env.restore();
  }
});

test('help 输出乱码：不抛错，响应仍可 JSON 序列化', async () => {
  const env = withEnv();
  try {
    fakeCli(env.localBin, 'claude', helpBody([`printf '\\377\\376 broken\\n'`, 'exit 0']));

    const result = await detectCli({ provider: 'claude' });

    assert.equal(result.candidates[0].exit_code, 0);
    assert.equal(result.candidates[0].capabilities.help_checked, true, 'help 退出 0 就算读到了');
    // 乱码里没有任何 flag，所以能力一律是空的——但解析过程不能炸。
    assert.deepEqual(result.candidates[0].capabilities.output_formats, []);
    assert.ok(JSON.stringify(result).length > 0, '整个响应必须可序列化');
  } finally {
    env.restore();
  }
});

test('help 里 --output-format 但没有 json：不建议任何 argv', async () => {
  const env = withEnv();
  try {
    fakeCli(
      env.localBin,
      'claude',
      helpBody([`echo '  --output-format  Output format: "text", "yaml"'`, 'exit 0']),
    );

    const result = await detectCli({ provider: 'claude' });

    assert.deepEqual(result.candidates[0].capabilities.output_formats, ['text', 'yaml']);
    assert.deepEqual(result.config_patch.recommended_args, [], 'json 没确认过就不建议');
  } finally {
    env.restore();
  }
});

test('help 解析按独立 token：--model-list / -points 不算', async () => {
  const env = withEnv();
  try {
    fakeCli(
      env.localBin,
      'claude',
      helpBody(['echo "  --model-list   List models"', 'echo "  show -points only"', 'exit 0']),
    );

    const caps = (await detectCli({ provider: 'claude' })).candidates[0].capabilities;
    assert.equal(caps.help_checked, true);
    assert.equal(caps.supports_model_flag, false, '--model-list 不是 --model');
    assert.equal(caps.non_interactive, false, '-points 不是 -p');
  } finally {
    env.restore();
  }
});

test('help 带 ANSI 颜色：转义被剥掉后仍能认出 flag', async () => {
  const env = withEnv();
  try {
    // 带色的 help 很常见。转义序列必须在解析前被剥掉，而且要剥成**空格**——
    // 直接删掉会让 `--model` 紧贴前一个可见字符，反而匹配不上。
    fakeCli(
      env.localBin,
      'claude',
      helpBody([
        `printf '  \\033[1m-p, --print\\033[0m  Print mode\\n'`,
        `printf '  \\033[1m--model\\033[0m <name>  Model\\n'`,
        `printf '  \\033[1m--output-format\\033[0m <fmt>  Output format: "json"\\n'`,
        'exit 0',
      ]),
    );

    const result = await detectCli({ provider: 'claude' });

    const caps = result.candidates[0].capabilities;
    assert.equal(caps.help_checked, true);
    assert.equal(caps.non_interactive, true, '带色的 -p 仍该被认出来');
    assert.equal(caps.supports_model_flag, true, '带色的 --model 仍该被认出来');
    assert.deepEqual(caps.output_formats, ['json']);
    assert.deepEqual(result.config_patch.recommended_args, ['--output-format', 'json']);
  } finally {
    env.restore();
  }
});

// ── 8. model 不被检测决定 ────────────────────────────────────────────────────

test('model unsupported：config_patch.model=null、model_source=cli-config', async () => {
  const env = withEnv();
  try {
    // 即便 CLI 自称支持一堆模型，检测也不采信、不猜。
    fakeCli(env.localBin, 'claude', 'echo "1.0.0 (models: opus, sonnet)"; exit 0');

    const result = await detectCli({ provider: 'claude' });

    assert.equal(result.config_patch.model, null);
    assert.equal(result.config_patch.model_source, 'cli-config');
    assert.deepEqual(result.config_patch.recommended_args, []);
    // 候选里也没有 models 字段，避免前端误以为可以从这里挑模型。
    assert.ok(!('models' in result.candidates[0]));
  } finally {
    env.restore();
  }
});

// ── 9. manual 来源不被重检覆盖 ───────────────────────────────────────────────

test('manual sources retained：PUT 标了 manual 后，detect 不覆盖配置', async () => {
  const env = withEnv();
  try {
    const db = freshDb();
    const router = buildRouter(() => db);
    const manualPath = fakeCli(env.localBin, 'claude', 'echo "1.0.0"; exit 0').file;
    // 另一个候选，detect 会把它算作可用——如果后端擅自写回，就会顶掉手动值。
    process.env.PATH = [env.pathBin, path.join(env.dir, 'empty')].join(path.delimiter);
    fakeCli(env.pathBin, 'codex', 'echo "2.0.0"; exit 0');

    writeConfigFile({});
    const before = readRuntimeConfig();
    await callRoute(router, 'PUT', '/api/agent/runtime-config', {
      body: {
        config: {
          enabled: true,
          provider: 'claude',
          cli_path: manualPath,
          model: null,
          args: [],
          timeout_ms: 20000,
          working_directory: ROOT_DIR,
          allowed_env_names: ['PATH'],
          field_sources: { cli_path: 'manual' },
        },
        expected_version: before.updated_at,
      },
    });

    const saved = readRuntimeConfig();
    assert.equal(saved.field_sources?.cli_path, 'manual');
    const savedVersion = saved.updated_at;

    const detect = await callRoute<RuntimeDetectResponse>(
      router,
      'POST',
      '/api/agent/runtime-detect',
      { body: {} },
    );
    assert.ok(detect.recommended, '本用例需要至少探到一个可用候选');

    // detect 之后配置必须**逐字节不变**：manual 标记还在，路径还是手动那个，
    // updated_at 没被 bump（= 根本没发生写入）。
    const after = readRuntimeConfig();
    assert.equal(after.field_sources?.cli_path, 'manual');
    assert.equal(after.cli_path, manualPath);
    assert.equal(after.updated_at, savedVersion, 'detect 不得写配置');
    assert.equal(after.detected ?? null, null, 'detect 不得把快照写回配置');
  } finally {
    env.restore();
  }
});

test('field_sources / detected 可选：旧配置读回来兜底为 {} 与 null', async () => {
  const env = withEnv();
  try {
    // 刻意写一份「旧版」配置：完全没有这两个键。
    const legacy = { ...defaultRuntimeConfig(), updated_at: new Date().toISOString() };
    delete (legacy as Record<string, unknown>).field_sources;
    delete (legacy as Record<string, unknown>).detected;
    fs.writeFileSync(cfgPath, JSON.stringify(legacy, null, 2));

    const config = readRuntimeConfig();
    assert.deepEqual(config.field_sources, {});
    assert.equal(config.detected, null);
  } finally {
    env.restore();
  }
});

test('PUT 允许带 detected 快照，且重复 PUT 仍然幂等', async () => {
  const env = withEnv();
  try {
    const db = freshDb();
    const router = buildRouter(() => db);
    writeConfigFile({});

    const body = (expected: string) => ({
      config: {
        enabled: false,
        provider: 'claude' as const,
        cli_path: '',
        model: null,
        args: [],
        timeout_ms: 20000,
        working_directory: ROOT_DIR,
        allowed_env_names: ['PATH'],
        // 键序刻意和下面那次相反，用来验证比较时做了归一化。
        field_sources: { provider: 'auto' as const, cli_path: 'manual' as const },
        detected: { recommended: null, detected_at: '2026-10-13T00:00:00.000Z' },
      },
      expected_version: expected,
    });

    const first = readRuntimeConfig().updated_at;
    await callRoute(router, 'PUT', '/api/agent/runtime-config', { body: body(first) });
    const saved = readRuntimeConfig();
    assert.equal(saved.field_sources?.cli_path, 'manual');
    assert.deepEqual(saved.detected, {
      recommended: null,
      detected_at: '2026-10-13T00:00:00.000Z',
    });

    // 同一份载荷再 PUT 一次：不该 bump updated_at（否则别的标签页的 version 立刻作废）。
    await callRoute(router, 'PUT', '/api/agent/runtime-config', {
      body: body(saved.updated_at),
    });
    assert.equal(readRuntimeConfig().updated_at, saved.updated_at, '重复 PUT 必须幂等');
  } finally {
    env.restore();
  }
});

// ── 10. persist=true：写回，但只覆盖 auto 字段 ────────────────────────────────

/** persist 响应：检测契约之外多出写回的结果。 */
type PersistResponse = RuntimeDetectResponse & {
  persisted: boolean;
  config: import('../server/agent/runtime-config.ts').AgentRuntimeConfig;
  updated_at: string;
};

const detectPersist = (router: Router, expected: string): Promise<PersistResponse> =>
  callRoute<PersistResponse>(router, 'POST', '/api/agent/runtime-detect', {
    body: { persist: true, expected_version: expected },
  });

test('persist=true：auto 字段被写回，enabled 与 env 名单不动', async () => {
  const env = withEnv();
  try {
    const db = freshDb();
    const router = buildRouter(() => db);
    const cli = fakeCli(env.localBin, 'claude', HELP_BODY);

    writeConfigFile({});
    const before = readRuntimeConfig();

    const result = await detectPersist(router, before.updated_at);

    assert.equal(result.persisted, true);
    assert.ok(result.recommended, '本用例需要探到一个可用候选');
    const config = result.config;
    assert.equal(config.cli_path, cli.file);
    assert.equal(config.cli_path, result.recommended.path);
    assert.equal(config.provider, 'claude');
    assert.equal(config.model, null);
    // help 确认过 json，所以建议的那一对 flag 一起落了盘。
    assert.deepEqual(config.args, ['--output-format', 'json']);
    assert.equal(config.timeout_ms, 60000);
    assert.equal(config.working_directory, ROOT_DIR);

    // 六个字段全被标成 auto —— 下次重检还能继续刷新它们。
    for (const field of [
      'provider',
      'cli_path',
      'model',
      'args',
      'timeout_ms',
      'working_directory',
    ]) {
      assert.equal(config.field_sources?.[field], 'auto', `${field} 应标为 auto`);
    }

    // 用户授权的边界：检测绝不替用户开 Agent，也绝不动环境变量白名单。
    assert.equal(config.enabled, before.enabled, 'persist 不得自动 enable');
    assert.deepEqual(config.allowed_env_names, before.allowed_env_names);
    assert.equal(config.schema_version, 1);

    // 快照与历史都写了，而且落盘的内容和返回的一致。
    assert.ok(config.detected, 'detected 快照必须被写入');
    assert.equal(config.history[0].change, 'POST /api/agent/runtime-detect (persist)');
    assert.deepEqual(readRuntimeConfig(), config);
    assert.equal(result.updated_at, config.updated_at);
  } finally {
    env.restore();
  }
});

test('persist=true：manual 字段的值与标记都原样保留', async () => {
  const env = withEnv();
  try {
    const db = freshDb();
    const router = buildRouter(() => db);
    // 手动指定的那个二进制，和 detect 实际会推荐的那个，刻意不是同一个文件。
    const manualPath = fakeCli(env.localBin, 'claude-manual', 'echo "0.0.1"; exit 0').file;
    const detected = fakeCli(env.localBin, 'claude', HELP_BODY).file;

    writeConfigFile({});
    await callRoute(router, 'PUT', '/api/agent/runtime-config', {
      body: {
        config: {
          enabled: true,
          provider: 'claude',
          cli_path: manualPath,
          model: null,
          args: [],
          timeout_ms: 20000,
          working_directory: ROOT_DIR,
          allowed_env_names: ['PATH'],
          field_sources: { cli_path: 'manual' },
        },
        expected_version: readRuntimeConfig().updated_at,
      },
    });

    const result = await detectPersist(router, readRuntimeConfig().updated_at);

    assert.equal(result.recommended?.path, detected, '推荐项应是那个字面名为 claude 的候选');
    // manual 的那一个字段：值没动，标记也没被改回 auto。
    assert.equal(result.config.cli_path, manualPath, 'manual 的 cli_path 不得被覆盖');
    assert.equal(result.config.field_sources?.cli_path, 'manual');
    // 其余字段照常更新。
    assert.deepEqual(result.config.args, ['--output-format', 'json']);
    assert.equal(result.config.field_sources?.args, 'auto');
    assert.equal(result.config.field_sources?.provider, 'auto');
    assert.deepEqual(readRuntimeConfig(), result.config);
  } finally {
    env.restore();
  }
});

test('persist=true 但无候选：六个字段的值一律不动，只刷新快照', async () => {
  const env = withEnv();
  try {
    const db = freshDb();
    const router = buildRouter(() => db);
    // 空 PATH、假 HOME：一个候选都探不到。
    writeConfigFile({
      enabled: true,
      provider: 'codex',
      cli_path: '/usr/local/bin/codex',
      model: 'some-model',
      args: ['--flag'],
      timeout_ms: 31000,
      working_directory: ROOT_DIR,
      allowed_env_names: ['PATH', 'OPENAI_API_KEY'],
      field_sources: { cli_path: 'auto', provider: 'auto' },
    });
    const before = readRuntimeConfig();

    const result = await detectPersist(router, before.updated_at);

    assert.equal(result.recommended, null, '本用例的前提是探不到候选');
    const config = result.config;
    // 逐字段相等：检测失败不该擦掉用户已经配好的东西，哪怕那几个字段标的是 auto。
    assert.equal(config.provider, before.provider);
    assert.equal(config.cli_path, before.cli_path);
    assert.equal(config.model, before.model);
    assert.deepEqual(config.args, before.args);
    assert.equal(config.timeout_ms, before.timeout_ms);
    assert.equal(config.working_directory, before.working_directory);
    assert.equal(config.enabled, before.enabled);
    assert.deepEqual(config.allowed_env_names, before.allowed_env_names);
    assert.deepEqual(config.field_sources, before.field_sources, 'field_sources 也不该被动');

    // 唯一的变化：快照和时间戳。
    assert.ok(config.detected, 'detected 快照仍要被刷新');
    assert.notEqual(config.updated_at, before.updated_at, 'updated_at 应推进');
  } finally {
    env.restore();
  }
});

test('persist=true：重复 persist 会 bump updated_at（刷新检测时间戳，有意为之）', async () => {
  const env = withEnv();
  try {
    const db = freshDb();
    const router = buildRouter(() => db);
    fakeCli(env.localBin, 'claude', HELP_BODY);
    writeConfigFile({});

    const first = await detectPersist(router, readRuntimeConfig().updated_at);
    const second = await detectPersist(router, first.config.updated_at);

    // 和 PUT 的幂等语义刻意不同：快照里带着新的 detected_at，所以每次都推进。
    assert.notEqual(second.config.updated_at, first.config.updated_at);
    assert.equal(second.config.history[0].change, 'POST /api/agent/runtime-detect (persist)');
  } finally {
    env.restore();
  }
});

test('persist=true + 过期 expected_version → 409，且配置文件逐字节不变', async () => {
  const env = withEnv();
  try {
    const db = freshDb();
    const router = buildRouter(() => db);
    fakeCli(env.localBin, 'claude', HELP_BODY);
    writeConfigFile({});
    const raw = fs.readFileSync(cfgPath, 'utf8');

    await assert.rejects(
      () => detectPersist(router, '1999-01-01T00:00:00.000Z'),
      (error: unknown) => {
        const err = error as { status?: number; code?: string };
        assert.equal(err.status, 409);
        assert.equal(err.code, 'version_conflict');
        return true;
      },
    );

    assert.equal(fs.readFileSync(cfgPath, 'utf8'), raw, '冲突时什么都不该被写');
  } finally {
    env.restore();
  }
});

test('persist=true 缺 expected_version → 400，且不写配置', async () => {
  const env = withEnv();
  try {
    const db = freshDb();
    const router = buildRouter(() => db);
    fakeCli(env.localBin, 'claude', HELP_BODY);
    writeConfigFile({});
    const raw = fs.readFileSync(cfgPath, 'utf8');

    await assert.rejects(
      () =>
        callRoute(router, 'POST', '/api/agent/runtime-detect', {
          body: { persist: true },
        }),
      (error: unknown) => {
        const err = error as { status?: number; code?: string };
        assert.equal(err.status, 400);
        assert.equal(err.code, 'validation_failed');
        return true;
      },
    );

    assert.equal(fs.readFileSync(cfgPath, 'utf8'), raw);
  } finally {
    env.restore();
  }
});

test('persist 缺省为 false：响应标 persisted=false，且不创建配置文件', async () => {
  const env = withEnv();
  try {
    const db = freshDb();
    const router = buildRouter(() => db);
    fakeCli(env.localBin, 'claude', HELP_BODY);

    const result = await callRoute<PersistResponse>(
      router,
      'POST',
      '/api/agent/runtime-detect',
      { body: {} },
    );

    assert.equal(result.persisted, false);
    assert.equal(fs.existsSync(cfgPath), false, '不带 persist 的 detect 不得创建配置文件');
  } finally {
    env.restore();
  }
});

// ── 11. 不读、也不转发密钥类环境变量 ──────────────────────────────────────────

test('secret-like env：子进程只拿到 PATH，看不到 API key', async () => {
  const env = withEnv({
    extraEnv: {
      ANTHROPIC_API_KEY: 'sk-ant-test-must-not-leak',
      OPENAI_API_KEY: 'sk-oai-test-must-not-leak',
    },
  });
  try {
    const cli = fakeCli(env.localBin, 'claude', 'echo "1.0.0"; exit 0');

    const result = await detectCli({ provider: 'claude' });
    assert.equal(result.candidates.length, 1);

    // 假 CLI 自己报告它看到的环境：两个 key 都必须是空的。
    const lines = readLog(cli.log);
    assert.ok(lines.includes('ANTHROPIC_API_KEY:'), `子进程不该看到 ANTHROPIC_API_KEY：${lines}`);
    assert.ok(lines.includes('OPENAI_API_KEY:'), `子进程不该看到 OPENAI_API_KEY：${lines}`);
    assert.ok(
      lines.some((line) => line.startsWith('PATH_SEEN:') && line.length > 'PATH_SEEN:'.length),
      'PATH 必须给，否则连 /usr/bin/env 都找不到',
    );

    // 响应里也不许出现 key 的值——哪怕是被 CLI 回显进 version 的。
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes('must-not-leak'), '响应体不允许包含任何密钥值');
  } finally {
    env.restore();
  }
});

test('不读凭据文件：假 HOME 下的 .claude 凭据从未被打开', async () => {
  const env = withEnv();
  // 直接记录「被读过哪些路径」。atime 不能用来做这个判断：文件系统挂载选项、
  // APFS 的惰性更新都会让它既可能漏报也可能误报。包住读取入口本身才是硬证据。
  const opened: string[] = [];
  const realReadFileSync = fs.readFileSync;
  const realOpenSync = fs.openSync;
  const realCreateReadStream = fs.createReadStream;
  fs.readFileSync = ((p: never, ...rest: never[]) => {
    opened.push(String(p));
    return (realReadFileSync as never as (...a: never[]) => never)(p, ...rest);
  }) as never;
  fs.openSync = ((p: never, ...rest: never[]) => {
    opened.push(String(p));
    return (realOpenSync as never as (...a: never[]) => never)(p, ...rest);
  }) as never;
  fs.createReadStream = ((p: never, ...rest: never[]) => {
    opened.push(String(p));
    return (realCreateReadStream as never as (...a: never[]) => never)(p, ...rest);
  }) as never;

  try {
    const credDir = path.join(env.dir, 'home', '.claude');
    fs.mkdirSync(credDir, { recursive: true });
    const credFile = path.join(credDir, '.credentials.json');
    fs.writeFileSync(credFile, JSON.stringify({ token: 'must-not-be-read' }));

    opened.length = 0; // 布置现场产生的读写不算
    fakeCli(env.localBin, 'claude', 'echo "1.0.0"; exit 0');
    opened.length = 0; // 写假 CLI 也不算

    const result = await detectCli({ provider: 'claude' });

    assert.deepEqual(
      opened.filter((p) => p.includes('.claude') || p.includes('credential')),
      [],
      `检测期间不得打开任何凭据文件，实际打开：${opened.join(', ')}`,
    );
    assert.ok(!JSON.stringify(result).includes('must-not-be-read'));
  } finally {
    fs.readFileSync = realReadFileSync;
    fs.openSync = realOpenSync;
    fs.createReadStream = realCreateReadStream;
    env.restore();
  }
});

// ── 12. 命令注入：名字只是名字 ───────────────────────────────────────────────

test('命令注入：basename 带 shell 元字符的文件不被执行、也不被当候选', async () => {
  const env = withEnv();
  try {
    fs.mkdirSync(env.localBin, { recursive: true });
    const canary = path.join(env.dir, 'injection-canary.txt');
    // 一个名字里带 `;` 的可执行文件。名字里的 `/` 会被当成路径分隔符，所以这里用
    // `claude; echo pwned` —— 足够证明论点：它不是字面的 `claude`，就不该被看一眼；
    // 而若有谁把候选名拼进 shell，这个分号后半截就会执行并留下 canary。
    const evilName = 'claude; echo pwned';
    const evil = path.join(env.localBin, evilName);
    fs.writeFileSync(evil, `#!/bin/sh\necho "pwned" > "${canary}"\nexit 0\n`, { mode: 0o755 });
    const real = fakeCli(env.localBin, 'claude', 'echo "1.0.0"; exit 0');

    const result = await detectCli({ provider: 'claude' });

    // 候选只有字面名为 `claude` 的那一个。
    assert.deepEqual(
      result.candidates.map((c) => c.path),
      [real.file],
    );
    // 恶意脚本没跑过：没有产物。
    assert.equal(fs.existsSync(canary), false, '注入脚本绝不能被执行');
    // 真·candidate 的 argv 里也不该出现分号被当成分隔符的痕迹。
    assert.deepEqual(argvLines(real.log), ['ARGV:--version', 'ARGV:--help']);
  } finally {
    env.restore();
  }
});

test('PATH 里的恶意条目：相对目录被忽略，不随 cwd 漂移', async () => {
  const env = withEnv();
  try {
    // "." 这类相对条目含义随 cwd 变化，必须被丢掉。
    process.env.PATH = ['.', '', env.pathBin].join(path.delimiter);
    const onPath = fakeCli(env.pathBin, 'claude', 'echo "1.0.0"; exit 0');

    const result = await detectCli({ provider: 'claude' });

    for (const candidate of result.candidates) {
      assert.ok(path.isAbsolute(candidate.path), `候选必须是绝对路径：${candidate.path}`);
    }
    assert.deepEqual(
      result.candidates.map((c) => c.path),
      [onPath.file],
    );
  } finally {
    env.restore();
  }
});

test('目录与不可执行文件不算候选', async () => {
  const env = withEnv();
  try {
    // 一个名叫 claude 的**目录**，和一个不可执行的同名文件。
    fs.mkdirSync(path.join(env.localBin, 'claude'), { recursive: true });
    fs.mkdirSync(env.pathBin, { recursive: true });
    fs.writeFileSync(path.join(env.pathBin, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o644 });
    process.env.PATH = [env.pathBin].join(path.delimiter);

    const result = await detectCli({ provider: 'claude' });

    assert.deepEqual(result.candidates, []);
    assert.equal(result.recommended, null);
  } finally {
    env.restore();
  }
});

// ── 路由层：只读，不写库、不建 session ───────────────────────────────────────

test('POST /api/agent/runtime-detect：返回检测契约，且零写入', async () => {
  const env = withEnv();
  try {
    const db = freshDb();
    const router = buildRouter(() => db);
    fakeCli(env.localBin, 'claude', 'echo "1.0.0"; exit 0');

    const result = await callRoute<RuntimeDetectResponse>(
      router,
      'POST',
      '/api/agent/runtime-detect',
      { body: {} },
    );

    assert.equal(result.candidates.length, 1);
    assert.equal(result.config_patch.model_source, 'cli-config');
    assert.ok(result.note.length > 0, 'note 必须说明安全约定');
    assert.ok(typeof result.latency_ms === 'number');

    // 零写入：没有 session、没有消息、配置文件也没被创建。
    const { all } = await import('../server/db/connection.ts');
    assert.equal(all(db, 'SELECT id FROM agent_sessions').length, 0);
    assert.equal(all(db, 'SELECT id FROM agent_messages').length, 0);
    assert.equal(all(db, 'SELECT id FROM tasks').length, 0);
    assert.equal(fs.existsSync(cfgPath), false, 'detect 不得创建配置文件');
  } finally {
    env.restore();
  }
});

test('POST /api/agent/runtime-detect：空体 / 非法 provider 的处理', async () => {
  const env = withEnv();
  try {
    const db = freshDb();
    const router = buildRouter(() => db);

    // 空体合法（provider 可选）。
    const empty = await callRoute<RuntimeDetectResponse>(
      router,
      'POST',
      '/api/agent/runtime-detect',
      {},
    );
    assert.ok(Array.isArray(empty.candidates));

    // 非法 provider 必须被 schema 挡掉，而不是被悄悄忽略。
    await assert.rejects(
      () =>
        callRoute(router, 'POST', '/api/agent/runtime-detect', {
          body: { provider: 'gemini' },
        }),
      /validation/i,
    );
  } finally {
    env.restore();
  }
});

// ── 13. 真实环境（可选，只读）────────────────────────────────────────────────

test('真实 CLI（若已安装）：只跑一次 --version，不碰模型、不写任何文件', async (t) => {
  // 不换 HOME / PATH：这一条刻意跑在真实环境上。但仍然只跑 --version。
  const result = await detectCli({});
  if (!result.recommended) {
    t.skip('本机未安装 claude / codex，跳过');
    return;
  }

  assert.ok(path.isAbsolute(result.recommended.path));
  assert.equal(result.recommended.exit_code, 0);
  assert.equal(result.recommended.auth_status, 'unknown', '真实环境下同样不探 auth');
  assert.ok(result.recommended.version, '真实 CLI 应给出版本串');
  assert.equal(result.config_patch.model, null);

  // 真实的配置文件绝不能因为这次检测而出现。
  const realConfig = path.join(ROOT_DIR, 'config', 'agent-runtime.json');
  const existedBefore = fs.existsSync(realConfig);
  await detectCli({ provider: result.recommended.provider });
  assert.equal(fs.existsSync(realConfig), existedBefore, 'detect 不得创建真实配置文件');
});
