/**
 * 本地 CLI 自动检测。回答一个很窄的问题：「这台机器上有没有能跑的 `claude` /
 * `codex`，在哪」。
 *
 * 安全边界，和 `./cli-exec.ts` 同样不可退让，而且这里更严：
 * 1. **只读、无副作用。** 这个模块不写库、不建 session、不写配置文件。检测结果只作为
 *    `config_patch` 返回；写回配置是调用方的显式动作（`POST /api/agent/runtime-detect`
 *    带 `persist=true` → `runtime-config.ts` 的 `persistDetected`），而且那条路径也只覆盖
 *    `field_sources` 标成 `auto` 的字段——用户手动填的 `cli_path` 不会被一次「刷新」
 *    悄悄冲掉。
 * 2. **只跑 `--version` 和 `--help`。** 两者都只是「自我描述」类调用：不跑 prompt、
 *    不跑模型、不碰网络、不产生任何计费调用；也**不跑 `auth` / `login` / `status`
 *    子命令**——那类命令会联网、可能改动 CLI 自己的登录态。所以 `auth_status` 恒为
 *    `'unknown'`：不知道就说不知道，不猜。
 * 3. **不读 token，环境变量使用白名单。** 不打开任何凭据文件，探针子进程只继承
 *    系统基础变量（走 `runCli` 的 env 白名单），所以 `ANTHROPIC_API_KEY` 之类
 *    既不会被读、也不会被转发给被探测的二进制。
 * 4. **不走 shell、不递归扫盘。** 候选路径是「固定目录 × 固定 basename」拼出来的，
 *    `spawn(..., { shell: false })` 让任何含 `;`、`$(...)` 的**文件名**都只是字面名字。
 */
import os from 'node:os';
import path from 'node:path';
import { ROOT_DIR } from '../config.ts';
import {executableFile} from '../lib/process-launch.ts';
import { runCli } from './cli-exec.ts';
import { nowIso } from '../lib/ids.ts';

export type DetectProvider = 'claude' | 'codex';

/**
 * 从 `--help` 文本里读出来的能力声明。**全部来自 help 文本的字面解析**，不是试探出来的：
 * 检测不会真的拿这些 flag 去跑一次。
 *
 * `help_checked=false`（help 超时 / 非零退出 / spawn 失败）时三项一律取保守默认
 * （`false` / `[]`），因为「没读到」不等于「不支持」，而把没读到当成支持会让
 * `recommended_args` 塞进 CLI 并不认识的参数。
 */
export interface CliCapabilities {
  /** help 里出现 `-p` / `--print` / `--non-interactive` 一类的非交互开关。 */
  non_interactive: boolean;
  /** help 里 `--output-format` 那几行列出的格式名，去重后字典序。 */
  output_formats: string[];
  supports_model_flag: boolean;
  /** `--help` 是否成功跑完（退出码 0 且未超时）。false ⇒ 上面三项是保守默认值。 */
  help_checked: boolean;
}

export interface DetectedCandidate {
  provider: DetectProvider;
  /** 绝对路径。检测只产生绝对路径，相对路径会随 cwd 漂移。 */
  path: string;
  /** 1 = 推荐顺位最靠前。按「白名单目录优先、再按 PATH 顺序」排。 */
  rank: number;
  /** 探针动手那一刻仍然存在且可执行。 */
  exists: boolean;
  /** `--version` 的首行（已 sanitize、截断）；拿不到为 null。 */
  version: string | null;
  exit_code: number;
  timed_out: boolean;
  /** 该候选两次探针（`--version` + `--help`）的总耗时。 */
  latency_ms: number;
  /** 恒为 `'unknown'`：检测不跑任何 auth/login/status 命令，也不读凭据。 */
  auth_status: 'unknown';
  /** `--help` 文本里读到的能力。只影响展示与 `recommended_args`，不影响是否被推荐。 */
  capabilities: CliCapabilities;
}

export interface RuntimeDetectResponse {
  detected_at: string;
  latency_ms: number;
  candidates: DetectedCandidate[];
  /** 第一个「存在且 `--version` 退出码为 0」的候选；没有就是 null。 */
  recommended: DetectedCandidate | null;
  /**
   * 建议的配置补丁。**后端不会自己应用**——只有调用方显式带 `persist=true` 时才写回，
   * 且写回只覆盖 `field_sources` 里仍是 `auto` 的字段（标成 `manual` 的不被重检覆盖）。
   */
  config_patch: {
    provider: DetectProvider | null;
    cli_path: string | null;
    /** 恒为 null：用哪个模型由 CLI 自己的配置决定，检测不猜。 */
    model: string | null;
    timeout_ms: number;
    working_directory: string;
    /**
     * 只可能包含 help 里确认过的**输出格式** flag。永远不含 prompt 文本、不含
     * `--model`、也不含 `-p`/`--print`（它的用途就是接 prompt，而 prompt 由运行时的
     * `buildProviderPromptArgs` 另行负责）。
     */
    recommended_args: string[];
    model_source: 'cli-config';
  };
  note: string;
}

/** 探针超时上限。只是问「你能跑起来吗」，不该等满业务超时。 */
const PROBE_TIMEOUT_MS = 3000;

/** 探针输出上限。一行版本号用不了 8 KiB，多出来的一律不要。 */
const PROBE_MAX_OUTPUT_BYTES = 65536;

/** version 文本的截断长度。超长的 banner 没有展示价值。 */
const VERSION_MAX_CHARS = 200;

/** 合并进配置时建议的默认超时，与 `defaultRuntimeConfig()` 对齐。 */
const SUGGESTED_TIMEOUT_MS = 20000;

const PROVIDERS: DetectProvider[] = ['claude', 'codex'];

/** 每个 provider 的可执行文件名。固定字面量——不接受外部传入的 basename。 */
const BASENAMES: Record<DetectProvider, string[]> = {
  claude: process.platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude'],
  codex: process.platform === 'win32' ? ['codex.exe', 'codex.cmd'] : ['codex'],
};

const NOTE =
  '本地只读检测：每个候选只执行 --version 与 --help（后者仅用于读 help 文本做能力探测，' +
  '不调用模型、不联网、不产生计费调用），不走 shell、不读取 token/密钥文件，' +
  '子进程只继承系统基础变量与显式允许的变量；不执行 auth/login/status 命令，所以 auth_status 恒为 unknown。' +
  '检测结果默认不写回配置（persist=true 时才写，且 manual 字段不被覆盖）。';

/**
 * 固定搜索目录白名单。**不递归子目录**，顺序即优先级。
 *
 * `/opt/homebrew/bin` 无条件列入：非 macOS 上这个目录根本不存在，扫一遍的代价是一次
 * `accessSync` 失败，比加一个在测试里永远为真的平台分支更诚实。
 */
function whitelistDirs(): string[] {
  return [
    path.join(os.homedir(), '.local', 'bin'),
    ...(process.platform === 'win32'
      ? [process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : '',
          process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links') : ''].filter(Boolean)
      : ['/usr/local/bin', '/opt/homebrew/bin']),
    path.join(ROOT_DIR, 'node_modules', '.bin'),
  ];
}

/**
 * 搜索目录的最终顺序：白名单在前（按上面的顺序），`PATH` 目录在后（按 `PATH` 顺序）。
 *
 * 按绝对路径去重，所以一个同时出现在白名单和 `PATH` 里的目录只扫一次，并且保留**靠前**
 * 那个位置——这正是「白名单优先」的落点。
 */
function searchDirs(): string[] {
  const fromPath = (process.env.PATH ?? '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);

  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const dir of [...whitelistDirs(), ...fromPath]) {
    // 相对的 PATH 条目（历史上的 "." 之类）直接丢弃：它的含义随 cwd 漂移。
    if (!path.isAbsolute(dir)) continue;
    const resolved = path.resolve(dir);
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(resolved);
  }
  return ordered;
}

/**
 * 这个路径现在是不是一个可执行的普通文件。不 spawn、不跟随到目录。
 */
const isExecutableFile = executableFile;

/**
 * `--output-format` 行里要剔掉的噪声词。
 *
 * help 文本里和格式名混在一起的是说明文字（`Output format:`、`(default: json)`），不是格式。
 * 名单保持短：多剔一个词的代价是漏报一种真实格式，所以只列那些不可能是格式名的。
 */
const FORMAT_STOPWORDS = new Set([
  'format',
  'formats',
  'output',
  'outputs',
  'optional',
  'default',
  'defaults',
  'choices',
  'value',
  'values',
]);

/**
 * sanitize help 文本，为解析做准备。
 *
 * 两步，顺序有讲究：先整段删掉 ANSI CSI 序列（带色的 help 很常见），再把残余控制字符
 * 换成**空格**而不是删掉。换成空格是因为下面所有匹配都依赖 token 边界——若把残余字符
 * 直接删掉，`--model` 可能紧贴前一个可见字符，反而匹配不上；换成空格它就还是一个独立
 * token。换行与制表符保留：分行与分词都要用。
 */
function sanitizeHelp(stdout: string, stderr: string): string {
  return (
    `${stdout}\n${stderr}`
      // CSI 序列（颜色、光标移动）整段剔除。
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\[[0-9;?]*[\u0020-\u002f]*[@-~]/g, '')
      // 其余控制字符（含裸 ESC、退格）换成空格。
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ')
  );
}

/** 独立 token 的匹配：前面是行首或空白，后面是空白、`=` 或行尾。 */
const MODEL_FLAG_RE = /(?:^|\s)--model(?=[\s=]|$)/;
const OUTPUT_FORMAT_FLAG_RE = /(?:^|\s)--output-format\b/;
const NON_INTERACTIVE_RES = [
  /(?:^|\s)--print(?=[\s=]|$)/,
  /(?:^|\s)--non-interactive(?=[\s=]|$)/,
  /(?:^|\s)--noninteractive(?=[\s=]|$)/,
  /(?:^|\s)--no-interactive(?=[\s=]|$)/,
  /(?:^|\s)-p(?=[\s=]|$)/,
];

/**
 * 解析 `--help` 文本里的能力声明。**纯函数**：只看字符串，不 spawn、不读文件。
 *
 * 一律按「独立 token」匹配，所以 `--model-list` 不会被当成 `--model`，正文里的
 * `-points` 也不会被当成 `-p`。
 *
 * `output_formats` 只在 help 真的有 `--output-format` 时才非空，而且格式名只从**被引号
 * 包住或写在括号里**的片段里取——`--output-format <fmt>` 这种占位符是语法说明，不是一个
 * 叫 `fmt` 的格式。`help_checked` 不在这里决定：这个函数只负责解析，成不成功由调用方按
 * `--help` 的退出码判断。
 */
export function parseHelpCapabilities(text: string): {
  non_interactive: boolean;
  output_formats: string[];
  supports_model_flag: boolean;
} {
  return {
    non_interactive: NON_INTERACTIVE_RES.some((re) => re.test(text)) || /Usage:\s*codex\s+exec\b/i.test(text),
    output_formats: /(?:^|\s)--json(?=[\s=]|$)/m.test(text) ? [...new Set([...parseOutputFormats(text), 'jsonl'])].sort() : parseOutputFormats(text),
    supports_model_flag: MODEL_FLAG_RE.test(text),
  };
}

function parseOutputFormats(text: string): string[] {
  if (!OUTPUT_FORMAT_FLAG_RE.test(text)) return [];
  const found = new Set<string>();
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    // Only the option declaration, not a prose reference such as --output-format=stream-json.
    if (!/^\s*--output-format(?=\s|$)/.test(lines[index])) continue;
    let section = lines[index];
    for (let next = index+1; next < lines.length && !/^\s*--?[a-zA-Z]/.test(lines[next]); next++) section += '\n' + lines[next];
    for (const [, single, double, parens] of section.matchAll(/'([^']*)'|"([^"]*)"|\(([^)]*)\)/g)) {
      const quoted = single ?? double;
      if (quoted !== undefined) {
        if (/^[a-z][a-z0-9_-]{0,19}$/.test(quoted) && !FORMAT_STOPWORDS.has(quoted)) found.add(quoted);
      } else if (parens && /\b(?:choices?|default|formats?|text|json|yaml|stream-json|jsonl)\b/.test(parens)) {
        for (const token of parens.matchAll(/[a-z][a-z0-9_-]{0,19}/g)) if (!FORMAT_STOPWORDS.has(token[0])) found.add(token[0]);
      }
    }
  }
  return [...found].sort();
}

/**
 * sanitize 版本文本：取首行、trim、截断。
 *
 * `runCli` 已经用 `toString('utf8')` 解过码，非法字节在那一步就变成了 U+FFFD，所以这里
 * 不会因为 CLI 吐出二进制垃圾而抛错。控制字符（除空白）一律剔掉：这段文本会被原样
 * 回显到界面上，不该带 ANSI 转义或退格。
 */
function sanitizeVersion(stdout: string, stderr: string): string | null {
  const raw = stdout.trim() ? stdout : stderr;
  const firstLine = raw.split(/\r?\n/, 1)[0] ?? '';
  const cleaned = firstLine
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .trim();
  if (!cleaned) return null;
  return cleaned.slice(0, VERSION_MAX_CHARS);
}

/** 找出所有候选路径，已按优先级排好、已去重。 */
function collectPaths(providers: DetectProvider[]): { provider: DetectProvider; path: string }[] {
  const dirs = searchDirs();
  const found: { provider: DetectProvider; path: string }[] = [];
  const seen = new Set<string>();

  for (const provider of providers) {
    for (const dir of dirs) {
      for (const basename of BASENAMES[provider]) {
        const full = path.join(dir, basename);
        if (seen.has(full)) continue;
        if (!isExecutableFile(full)) continue;
        seen.add(full);
        found.push({ provider, path: full });
      }
    }
  }
  return found;
}

/**
 * help 读不到时的保守能力声明：一律当成「不支持」。
 *
 * 每次新建一个对象而不是共享一个常量：这些对象会被挂进响应、还可能被写进配置快照，
 * 共享引用会让任何一处意外改动波及到别的候选。
 */
const unknownCapabilities = (): CliCapabilities => ({
  non_interactive: false,
  output_formats: [],
  supports_model_flag: false,
  help_checked: false,
});

/** 统一的探针参数。只有 `args` 因调用而异，其余三项是写死的边界。 */
const probeOnce = (executable: string, args: string[]) =>
  runCli({
    executable,
    args,
    cwd: ROOT_DIR,
    envNames: ['PATH'],
    timeoutMs: PROBE_TIMEOUT_MS,
    maxOutputBytes: PROBE_MAX_OUTPUT_BYTES,
  });

/**
 * 探一个候选：先 `--version` 再 `--help`，env 只给 `PATH`，cwd 固定在项目根目录。
 *
 * 两次调用分工明确：**`--version` 决定这个候选能不能用**（`version` / `exit_code` /
 * `timed_out` 都只来自它），`--help` 只用来读能力文本。所以 `--help` 失败（非零退出、
 * 超时、spawn 失败）**不影响候选是否可用、是否被推荐**——一个能跑但 help 写得不规整的
 * CLI 仍然是个好候选，只是我们不替它猜参数。
 *
 * 临到动手前再确认一次可执行：扫目录和 spawn 之间文件可能已经被删/被改权限，那种情况
 * 如实报 `exists: false` 而**不** spawn，而不是让 ENOENT 冒出来。
 */
async function probe(
  candidate: { provider: DetectProvider; path: string },
  rank: number,
): Promise<DetectedCandidate> {
  const base: DetectedCandidate = {
    provider: candidate.provider,
    path: candidate.path,
    rank,
    exists: false,
    version: null,
    exit_code: -1,
    timed_out: false,
    latency_ms: 0,
    auth_status: 'unknown',
    capabilities: unknownCapabilities(),
  };

  if (!isExecutableFile(candidate.path)) return base;

  const startedAt = Date.now();
  // 唯一允许的两组参数，都是字面量数组，不拼接任何外部输入。顺序固定：先问版本，
  // 再读 help。串行而非并行——两次 spawn 打同一个二进制，没必要同时压上去。
  //
  // codex 的能力要看**子命令** help：根 `codex --help` 不展示 `exec` 的非交互参数
  // （`--json`/`--color`/`--sandbox` 等都在 `codex exec --help` 里），解析根 help 会
  // 把 codex 的能力误判成空。claude 的非交互参数全在根 help，保持 `--help`。
  const helpArgs = candidate.provider === 'codex' ? ['exec', '--help'] : ['--help'];
  const version = await probeOnce(candidate.path, ['--version']);
  const help = await probeOnce(candidate.path, helpArgs);

  const helpChecked = help.exitCode === 0 && !help.timedOut;
  const capabilities: CliCapabilities = helpChecked
    ? { ...parseHelpCapabilities(sanitizeHelp(help.stdout, help.stderr)), help_checked: true }
    : unknownCapabilities();

  return {
    ...base,
    exists: true,
    version: sanitizeVersion(version.stdout, version.stderr),
    exit_code: version.exitCode,
    timed_out: version.timedOut,
    latency_ms: Date.now() - startedAt,
    capabilities,
  };
}

/**
 * 从推荐候选的能力推出建议 argv。
 *
 * **只放 help 里确认过的输出格式 flag**，别的一律不放：`--model` 由配置的 `model` 字段
 * 决定（检测恒给 null），`-p`/`--print` 是用来接 prompt 的、由 `buildProviderPromptArgs`
 * 负责，而跳过权限确认那一类参数更是绝不能由检测替用户加上。
 */
function recommendedArgsFor(recommended: DetectedCandidate | null): string[] {
  if (!recommended?.capabilities.help_checked) return [];
  if (!recommended.capabilities.output_formats.includes('json')) return [];
  return ['--output-format', 'json'];
}

/**
 * 跑一次本地检测。
 *
 * `provider` 缺省时两个都找。候选之间并行探测，每个候选内部串行跑两次探针（各 3 秒
 * 上限），所以总耗时取决于最慢的那个候选，而不是候选数量。
 */
export async function detectCli(
  opts: { provider?: DetectProvider } = {},
): Promise<RuntimeDetectResponse> {
  const startedAt = Date.now();
  const providers = opts.provider ? [opts.provider] : PROVIDERS;

  const candidates = await Promise.all(
    collectPaths(providers).map((candidate, index) => probe(candidate, index + 1)),
  );

  // 「推荐」只认跑得起来的：存在、退出码 0。装了但跑不起来的二进制不该被推上去。
  const recommended = candidates.find((c) => c.exists && c.exit_code === 0) ?? null;

  return {
    detected_at: nowIso(),
    latency_ms: Date.now() - startedAt,
    candidates,
    recommended,
    config_patch: {
      provider: recommended?.provider ?? null,
      cli_path: recommended?.path ?? null,
      // 模型由 CLI 自己的配置决定，检测不列模型、不猜模型名。
      model: null,
      timeout_ms: recommended?.provider === 'codex' ? 120000 : recommended ? 60000 : SUGGESTED_TIMEOUT_MS,
      working_directory: ROOT_DIR,
      // 只可能是 help 里确认过的输出格式 flag，见 recommendedArgsFor 的说明。
      recommended_args: recommendedArgsFor(recommended),
      model_source: 'cli-config',
    },
    note: NOTE,
  };
}
