/**
 * CLI 执行器。这是整个特性里唯一会启动外部进程的地方。
 *
 * 安全边界，三条都不可退让：
 * 1. **永不拼 shell。** `spawn(executable, args, { shell: false })`，prompt 永远是
 *    单个 argv 元素，所以标题里的 `;`、`$(...)`、反引号都只是普通字符。
 * 2. **环境变量白名单。** 子进程只拿到 `PATH` 加上配置里点名的那几个名字（且仅当
 *    当前进程真有这个变量）。默认继承 `process.env` 会把本机所有 token 一并泄给
 *    被调起的 CLI。
 * 3. **输出有上限、超时必杀。** 先 SIGTERM 给清理机会，2 秒后 SIGKILL 兜底。
 */
import { spawn } from 'node:child_process';
import {resolveCliLaunch, terminateProcessTree, trackRuntimeProcess} from '../lib/process-launch.ts';
import type { AgentRuntimeConfig } from './runtime-config.ts';

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  canceled: boolean;
}

/** 默认 64 KiB。够装一份 JSON 回答，又不至于让跑飞的 CLI 吃光内存。 */
const DEFAULT_MAX_OUTPUT_BYTES = 65536;

/** SIGTERM 之后留给进程自己收尾的宽限期。 */
const KILL_GRACE_MS = 2000;

export interface RunCliOptions {
  executable: string;
  args: string[];
  cwd: string;
  envNames: string[];
  timeoutMs: number;
  signal?: AbortSignal;
  maxOutputBytes?: number;
  /**
   * 可选的 stdin 文本。**默认不传**：此时 stdin 接 `/dev/null`（`ignore`），子进程一读
   * 就拿到 EOF——这是修掉 `codex exec "..."` 在非 TTY 下仍「Reading additional input
   * from stdin」挂死的关键。只有显式要喂 stdin 时才传，本函数会写进去并**立刻 end**，
   * 永远不把一个开着的 stdin 留在子进程手里。
   */
  input?: string;
  /**
   * 用于决定额外继承哪个 provider 专属的安全基础变量（codex 需要 `CODEX_HOME`）。
   * 缺省时只继承通用基础变量——探测（detect）不挑 provider。
   */
  provider?: AgentRuntimeConfig['provider'];
  /** Signals that the child has emitted its first stdout bytes without exposing their contents. */
  onFirstStdout?: () => void;
  /** Receives raw stdout chunks so callers can parse selected safe streaming fields. */
  onStdoutChunk?: (chunk: Buffer) => void;
}

/**
 * 固定安全基础环境变量。
 *
 * 这些名字**不含任何凭据值**，但 CLI 必须靠它们才能找到自己的配置/登录态与本地化：
 * - `HOME`：Claude Code 读 `~/.claude.json` / keychain，Codex 读 `~/.codex/`。没有它，
 *   两个 CLI 都找不到登录态，在非交互下卡死或退回 onboarding——这正是线上「不返回」的根因。
 * - `USER`/`LOGNAME`/`SHELL`：多数 CLI 启动时读取，缺省会告警或行为漂移。
 * - `LANG`/`LC_ALL`：输出与排序的本地化，避免非 UTF-8 环境把 help 解析搞乱。
 * - `TMPDIR`：临时目录解析。
 * - `PATH`：没它连 `/usr/bin/env` 都找不到，永远给。
 *
 * 注意：我们只**传变量名让 CLI 自己去读它自己的凭据文件**，从不打开、读取或回显凭据内容。
 */
const BASE_ENV_NAMES = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'LANG',
  'LC_ALL',
] as const;

/** Codex 专属：配置/登录根目录。仅当进程里真的设了才继承，不凭空造。 */
const CODEX_ENV_NAMES = ['CODEX_HOME'] as const;

/**
 * 危险变量 denylist。即便用户在 `allowed_env_names` 里点名了这些，也**一律不透传**：
 * 它们能改变子进程加载行为（注入库、改 node/python/bash 启动脚本），等于把任意代码
 * 执行权交出去。白名单是「想给什么」，这张表是「给了也不许」，两者取交集。
 */
const DENIED_ENV_NAMES = new Set<string>([
  'NODE_OPTIONS',
  'NODE_EXTRA_CA_CERTS',
  'BASH_ENV',
  'ENV',
  'CORRECT_ENV',
  'PYTHONSTARTUP',
  'PYTHONPATH',
  'RUBYOPT',
  'PERL5OPT',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH',
  'DYLD_ROOT_PATH',
  'DYLD_LIBRARY_PATH',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'LD_PROFILE',
]);

/**
 * 组装子进程环境：固定安全基础变量 + 用户白名单（去危险项）。
 *
 * 基础变量只有「当前进程里真有值」才塞——不存在的名字不塞成空串，因为空值和未设置
 * 对多数 CLI 含义不同。用户白名单同理，且还要再过一遍 denylist。
 */
export function buildCliEnv(envNames: string[], provider?: AgentRuntimeConfig['provider'],
  source: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Record<string, string> {
  const windows = platform === 'win32';
  const names: string[] = [...BASE_ENV_NAMES, ...(provider === 'codex' ? CODEX_ENV_NAMES : []),
    ...(windows ? ['USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'HOMEDRIVE', 'HOMEPATH'] : [])];
  const env: Record<string, string> = {};
  for (const name of [...names, ...envNames]) {
    const key = windows ? name.toUpperCase() : name;
    if (DENIED_ENV_NAMES.has(key)) continue;
    const sourceKey = windows ? Object.keys(source).find(candidate => candidate.toUpperCase() === key) : name;
    const value = sourceKey === undefined ? undefined : source[sourceKey];
    if (typeof value === 'string') env[key] = value;
  }
  if (env.PATH === undefined) env.PATH = windows ? '' : '/usr/bin:/bin';
  if (windows && !env.HOME && env.USERPROFILE) env.HOME = env.USERPROFILE;
  return env;
}

export function runCli(opts: RunCliOptions): Promise<ExecResult> {
  const maxBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (opts.signal?.aborted) return Promise.resolve({exitCode: -1, stdout: '', stderr: '', timedOut: false, canceled: true});

  return new Promise<ExecResult>((resolve) => {
    let settled = false;
    let timedOut = false;
    let canceled = false;

    // stdin 永远不留开：不传 input → `/dev/null`（一读即 EOF，专治 codex 等在 stdin 上）；
    // 传了 input → pipe，写完立刻 end，同样立刻 EOF。两条路子进程都不会卡在「等更多输入」。
    const useStdinPipe = typeof opts.input === 'string';
    let launch;
    try { launch = resolveCliLaunch(opts.executable, opts.args); }
    catch (error) { resolve({exitCode: -1, stdout: '', stderr: `spawn failed: ${(error as Error).message}`, timedOut: false, canceled: false}); return; }
    const child = trackRuntimeProcess(spawn(launch.executable, launch.args, {
      shell: false,
      cwd: opts.cwd,
      env: buildCliEnv(opts.envNames, opts.provider),
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: [useStdinPipe ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    }));

    if (useStdinPipe && child.stdin) {
      // A CLI may reject its argv before consuming a large context; async EPIPE must not crash the API.
      child.stdin.on('error', () => {});
      try {
        child.stdin.write(opts.input as string);
      } catch {
        // 进程已退，写不进去无所谓——后面 'error'/'close' 会收敛结果。
      }
      child.stdin.end();
    }

    /** 收集到上限就停止累积，但继续排空流——否则子进程会卡在写管道上。 */
    const sink = () => {
      const chunks: Buffer[] = [];
      let size = 0;
      return {
        push(chunk: Buffer) {
          if (size >= maxBytes) return;
          const room = maxBytes - size;
          const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
          chunks.push(slice);
          size += slice.length;
        },
        text(): string {
          return Buffer.concat(chunks).toString('utf8');
        },
      };
    };

    const out = sink();
    const err = sink();
    let sawStdout = false;
    child.stdout?.on('data', (chunk: Buffer) => {
      if (!sawStdout) {
        sawStdout = true;
        opts.onFirstStdout?.();
      }
      opts.onStdoutChunk?.(chunk);
      out.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => err.push(chunk));

    let killTimer: NodeJS.Timeout | null = null;

    /** SIGTERM → 宽限 → SIGKILL。两次 kill 都包 try：进程可能已经自己退了。 */
    const terminate = () => {
      try {
        terminateProcessTree(child, 'SIGTERM');
      } catch {
        // 已经退出，没有可杀的目标。
      }
      killTimer = setTimeout(() => {
        try {
          terminateProcessTree(child, 'SIGKILL');
        } catch {
          // 同上。
        }
      }, KILL_GRACE_MS);
      killTimer.unref?.();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, opts.timeoutMs);
    timer.unref?.();

    const onAbort = () => {
      canceled = true;
      terminate();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (exitCode: number, extraStderr = '') => {
      if (settled) return;
      settled = true;
      if ((timedOut || canceled) && process.platform !== 'win32') terminateProcessTree(child, 'SIGKILL');
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({
        exitCode,
        stdout: out.text(),
        stderr: err.text() + extraStderr,
        timedOut,
        canceled,
      });
    };

    // spawn 本身失败（ENOENT / EACCES）不抛：调用方要的是「这次调用失败了」这个
    // 结果，和「CLI 跑完但退出码非零」走同一条处理路径。
    child.on('error', (error: Error) => finish(-1, `spawn failed: ${error.message}`));
    child.on('close', (code) => finish(code ?? -1));
  });
}

/**
 * 这些「执行形状」flag 由本模块硬编码、是唯一事实来源。用户 `cfg.args` 里若再次点名
 * 它们，会被 `dropConflictingArgs` 丢掉——否则同一条命令里出现
 * `--output-format text ... --output-format json` 这种后写覆盖前写，形状就不确定了。
 *
 * 值型 flag 后面跟一个参数（如 `--output-format text`），去重时要把那个值也一起跳过。
 */
const CLAUDE_OWNED_FLAGS = new Set([
  '-p',
  '--print',
  '--output-format',
  '--include-partial-messages',
  '--tools',
  '--model',
  '--safe-mode',
  '--no-session-persistence',
  '--system-prompt',
  '--append-system-prompt',
  '--system-prompt-file',
  '--append-system-prompt-file',
]);
const CODEX_OWNED_FLAGS = new Set([
  'exec',
  '--json',
  '--sandbox',
  '--ephemeral',
  '--skip-git-repo-check',
  '--color',
  '--model',
  '-m',
]);
/** 取一个值的 flag：去重命中时，连它后面那个参数一起丢。 */
const VALUE_TAKING_FLAGS = new Set([
  '--output-format',
  '--permission-prompts',
  '--tools',
  '--model',
  '-m',
  '--sandbox',
  '--color',
  '--permission-mode',
  '--system-prompt',
  '--append-system-prompt',
  '--system-prompt-file',
  '--append-system-prompt-file',
]);

/** 从用户 `cfg.args` 里剔除与硬编码形状冲突的 flag（含其值）。 */
function dropConflictingArgs(args: string[], provider: AgentRuntimeConfig['provider']): string[] {
  const owned = provider === 'codex' ? CODEX_OWNED_FLAGS : CLAUDE_OWNED_FLAGS;
  const unsupported = provider === 'codex'
    ? new Set(['-a', '--ask-for-approval', '--dangerously-bypass-approvals-and-sandbox', '--output-format', '--tools', '--print', '--safe-mode', '--no-session-persistence', '--system-prompt', '--append-system-prompt', '--system-prompt-file', '--append-system-prompt-file'])
    : new Set(['--permission-prompts', '--permission-mode', '--safe-mode', '--bare', '--dangerously-skip-permissions']);
  const values = new Set([...VALUE_TAKING_FLAGS, '-a', '--ask-for-approval']);
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    const flag = token.split('=', 1)[0];
    if (owned.has(flag) || unsupported.has(flag)) {
      if (!token.includes('=') && values.has(flag) && i + 1 < args.length && !args[i + 1].startsWith('-')) i++;
      continue;
    }
    out.push(token);
  }
  return out;
}

/**
 * 按 provider 组装 argv。
 *
 * `promptText` 永远作为**一个** argv 元素传入——这是不走 shell 之外的第二道保险：
 * 即便 prompt 里有空格、换行、引号，也不会被切成多个参数。
 *
 * 参数全部来自本机真实 help 的实测结论（Claude 2.1.274 / Codex 0.162）：
 * - claude：`-p <prompt> --tools ''`。`-p/--print` 即非交互；`--tools ''` 禁用全部工具。
 *   Agent 请求启用 stream-json/partial messages，只供 UI 流式展示受控的 SUMMARY 前缀；
 *   连通性探测继续用 text。模型与认证仍使用本机配置，不改全局设置。
 * - codex：`exec --sandbox read-only --ephemeral --skip-git-repo-check --color never
 *   <prompt>`。`exec` 本身即非交互；`--sandbox read-only` 让它不为写盘/审批卡住；
 *   绝不用 `-a`/`--ask-for-approval`。
 */
export function buildProviderPromptArgs(
  provider: AgentRuntimeConfig['provider'],
  promptText: string,
  cfg: Pick<AgentRuntimeConfig, 'model' | 'args'>,
  options: {systemPrompt?: string; systemPromptFile?: string; promptViaStdin?: boolean; streamingSummary?: boolean} = {},
): string[] {
  const model = cfg.model ? ['--model', cfg.model] : [];
  const extra = dropConflictingArgs(cfg.args ?? [], provider);

  if (provider === 'codex') {
    return [
      'exec',
      '--json',
      '--sandbox',
      'read-only',
      '--ephemeral',
      '--skip-git-repo-check',
      '--color',
      'never',
      ...(options.promptViaStdin ? [] : [promptText]),
      ...model,
      ...extra,
      ...(options.systemPromptFile ? ['--config', 'model_instructions_file=' + JSON.stringify(options.systemPromptFile),
        '--config', 'developer_instructions=""', '--config', 'project_doc_max_bytes=0',
        '--config', 'features.apps=false', '--config', 'mcp_servers={}', '--config', 'plugins={}'] : []),
      ...(options.promptViaStdin ? ['-'] : []),
    ];
  }

  return [
    '-p',
    ...(options.promptViaStdin ? [] : [promptText]),
    // 空串 = 禁用全部工具（help："Use \"\" to disable all tools"），模型只能说话。
    '--tools',
    '',
    '--output-format',
    options.streamingSummary ? 'stream-json' : 'text',
    ...(options.streamingSummary ? ['--include-partial-messages'] : []),
    '--safe-mode',
    '--no-session-persistence',
    ...(options.systemPromptFile ? ['--system-prompt-file', options.systemPromptFile] : options.systemPrompt ? ['--system-prompt', options.systemPrompt] : []),
    ...model,
    ...extra,
  ];
}
