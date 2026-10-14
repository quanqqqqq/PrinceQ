/**
 * 本地 CLI Agent 运行时配置的持久层。
 *
 * 独立于 `habits/`：习惯文件是用户的排序偏好，这里是「调哪个可执行文件、用什么
 * 参数」的运行时开关，两者生命周期无关，混在一起会让习惯文件的 history 变成
 * 配置变更日志。写入沿用 `server/domain/habits.ts` 的
 * validate-then-atomic-rename（tmp + fsync + rename），所以进程被 kill 也不会留下
 * 半个 JSON。
 *
 * **只存环境变量名，绝不存值。** `allowed_env_names` 是一串名字；真正取值发生在
 * `./cli-exec.ts` 里、从当前 `process.env` 现读。因此这个文件可以安全落盘、可以
 * 原样 GET 回显，不含任何 secret。
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { AgentRuntimeConfig as AgentRuntimeConfigView } from '../../shared/types.ts';
import { agentRuntimeConfigPath, ROOT_DIR } from '../config.ts';
import { ApiError, badRequest } from '../lib/errors.ts';
import { nowIso } from '../lib/ids.ts';
// 只要类型：`detect.ts` 反过来不 import 本模块，但用 `import type` 把这条边界钉死，
// 省得以后谁在 detect 里加一行运行时 import 就凑出一个循环。
import type { RuntimeDetectResponse } from './detect.ts';

/** 单个 argv 元素：NUL 会在 execve 处截断字符串，必须在入口就拒掉。 */
const argvItem = z
  .string()
  .max(200)
  .refine((value) => !value.includes('\0'), 'argv 元素不允许包含 NUL 字符');

/** 环境变量名的通用形状。只校验名字，值永远不经过这里。 */
const envName = z
  .string()
  .trim()
  .max(60)
  .regex(/^[A-Z_][A-Z0-9_]*$/, '环境变量名只允许大写字母、数字与下划线，且不能以数字开头');

/**
 * 可写字段（PUT 收的那一组），不含 `schema_version`/`updated_at`/`history`。
 *
 * `cli_path` 在这一层**允许空串**：关闭态（`defaultRuntimeConfig()`）本来就不预设
 * 任何二进制，若在 schema 里 `min(1)`，那份安全默认自己就过不了 `safeParse`，
 * `readRuntimeConfig` 会把「还没配置」误判成「文件坏了」。「启用时必填且必须绝对」
 * 这条规则属于语义校验，交给 `validateRuntimeConfigInput`。
 */
export const agentRuntimeConfigDraft = {
  enabled: z.boolean(),
  provider: z.enum(['claude', 'codex']),
  cli_path: z.string().trim().max(400),
  model: z.string().trim().min(1).max(120).nullish(),
  args: z.array(argvItem).max(32),
  timeout_ms: z.number().int().min(500).max(120000),
  working_directory: z.string().trim().min(1).max(400),
  allowed_env_names: z.array(envName).max(32),
  /**
   * 字段来源标记与上次检测快照。两者都**可选且宽松**。
   *
   * 宽松是刻意的：这两项是检测特性的元数据，不是运行时真正依赖的东西——`cli-exec`
   * 一个字节都不读它们。给它们上严格 schema，只会让「前端加了一个新字段」变成
   * 「整份配置 400、Agent 连不上」。`field_sources` 的键故意不收敛成 ConfigField
   * 枚举，同理：前端新管一个字段，不该要求后端先发版。
   */
  field_sources: z.record(z.string().max(60), z.enum(['auto', 'manual'])).optional(),
  detected: z.unknown().nullish(),
};

export const agentRuntimeConfigSchema = z.object({
  schema_version: z.literal(1),
  ...agentRuntimeConfigDraft,
  updated_at: z.string(),
  history: z
    .array(z.object({ at: z.string(), change: z.string() }))
    .max(50),
});

export type AgentRuntimeConfig = AgentRuntimeConfigView;

/** 文件不存在时的安全默认：**关闭**，且不预设任何 CLI 路径。 */
export function defaultRuntimeConfig(): AgentRuntimeConfig {
  return {
    schema_version: 1,
    enabled: false,
    provider: 'claude',
    cli_path: '',
    model: null,
    args: [],
    timeout_ms: 20000,
    working_directory: ROOT_DIR,
    allowed_env_names: ['PATH'],
    field_sources: {},
    detected: null,
    updated_at: '1970-01-01T00:00:00.000Z',
    history: [],
  };
}

/**
 * 读配置。文件不存在 → 安全默认（关闭）；JSON 坏或校验失败 → 400。
 *
 * 坏文件**不**静默回退成默认值：那会让「配置被写坏」长得和「还没配置」一样，
 * 用户永远看不到自己需要修的那一行。
 */
export function readRuntimeConfig(): AgentRuntimeConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(agentRuntimeConfigPath(), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultRuntimeConfig();
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw badRequest(
      `config/agent-runtime.json 不是合法 JSON：${(error as Error).message}`,
    );
  }

  const result = agentRuntimeConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw badRequest('config/agent-runtime.json 内容不合法', result.success ? [] : result.error.issues);
  }
  // 旧配置文件没有这两项。兜底成 `{}` / `null` 而不是留 undefined，这样调用方
  // （以及 GET 的回显）永远能直接读 `config.field_sources[x]`，不必各自判空。
  return {
    ...result.data,
    field_sources: result.data.field_sources ?? {},
    detected: result.data.detected ?? null,
  } as AgentRuntimeConfig;
}

/**
 * PUT 收的那一组字段。`model` 可缺省（等价于 null = 用 provider 默认模型），其余必填。
 *
 * `field_sources` / `detected` 也可缺省：旧前端完全不送这两项，照样能保存。
 */
export type AgentRuntimeConfigInput = Pick<
  AgentRuntimeConfig,
  | 'enabled'
  | 'provider'
  | 'cli_path'
  | 'args'
  | 'timeout_ms'
  | 'working_directory'
  | 'allowed_env_names'
> & {
  model?: string | null;
  field_sources?: Record<string, 'auto' | 'manual'>;
  detected?: unknown | null;
};

/** 规范化后的载荷：`model` 已经收敛成 `string | null`，不再有 undefined。 */
export type NormalizedRuntimeConfigInput = Required<AgentRuntimeConfigInput> & {
  model: string | null;
  field_sources: Record<string, 'auto' | 'manual'>;
  detected: unknown | null;
};

/**
 * zod 之外的代码层强校验，返回规范化后的载荷。
 *
 * - `cli_path` 的必填性跟着 `enabled` 走，与前端契约
 *   （`src/lib/agent-runtime-contract.ts` 的 `validateConfig`）一致：启用时必须填、
 *   且必须是绝对路径；关闭时允许留空（还没配置的安全默认）。
 * - 不论开关如何，**非空的** `cli_path` 一律必须是绝对路径：相对路径会随 cwd 漂移，
 *   等于让「调哪个二进制」变成不确定的事，不能靠关掉开关蒙混过关。
 * - `working_directory` 必须落在 `ROOT_DIR` 之内。这是本任务的沙箱边界：模型只
 *   能在项目目录里被启动，不能把 cwd 指到 `/` 或用户家目录去扫文件。
 * - `field_sources` / `detected` **原样透传、不做强校验**：它们是检测特性的展示元数据，
 *   不参与任何 spawn 决策，所以这里不该成为「前端加个字段就保存失败」的那道关。
 */
export function validateRuntimeConfigInput(
  input: AgentRuntimeConfigInput,
): NormalizedRuntimeConfigInput {
  const cliPath = input.cli_path.trim();
  if (input.enabled && !cliPath) {
    throw badRequest('启用 Agent 时 cli_path 必填，且必须是绝对路径');
  }
  if (cliPath && !path.isAbsolute(cliPath)) {
    throw badRequest(`cli_path 必须是绝对路径，收到 "${cliPath}"`);
  }

  const resolved = path.resolve(input.working_directory);
  const inside = resolved === ROOT_DIR || resolved.startsWith(ROOT_DIR + path.sep);
  if (!inside) {
    throw badRequest(
      `working_directory 必须位于项目目录内（${ROOT_DIR}），收到 "${resolved}"`,
    );
  }

  return {
    enabled: input.enabled,
    provider: input.provider,
    cli_path: cliPath,
    model: input.model ?? null,
    args: [...input.args],
    timeout_ms: input.timeout_ms,
    working_directory: resolved,
    allowed_env_names: [...input.allowed_env_names],
    field_sources: normalizeFieldSources(input.field_sources),
    detected: input.detected ?? null,
  };
}

/**
 * 按键名排序重建 `field_sources`。
 *
 * 看着多余，其实是 `samePayload` 的前提：那个比较用 `JSON.stringify`，而前端是逐个字段
 * 累积地标 manual 的，同一份内容很容易带着不同的键序送上来。不归一化的话，重复保存
 * 同一份配置会 bump `updated_at`，把别的标签页手里的 version 作废——而这正是
 * 「重复 PUT 是幂等的」想避免的事。
 */
const normalizeFieldSources = (
  sources: Record<string, 'auto' | 'manual'> | undefined,
): Record<string, 'auto' | 'manual'> =>
  Object.fromEntries(Object.entries(sources ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/** 比较「有效载荷」时用的投影：不含 updated_at/history，它们本身就是写入的产物。 */
const payloadOf = (config: AgentRuntimeConfig): NormalizedRuntimeConfigInput => ({
  enabled: config.enabled,
  provider: config.provider,
  cli_path: config.cli_path,
  model: config.model ?? null,
  args: config.args,
  timeout_ms: config.timeout_ms,
  working_directory: config.working_directory,
  allowed_env_names: config.allowed_env_names,
  field_sources: normalizeFieldSources(config.field_sources),
  detected: config.detected ?? null,
});

const samePayload = (
  a: NormalizedRuntimeConfigInput,
  b: NormalizedRuntimeConfigInput,
): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * 乐观并发写入。`expectedVersion` 必须等于当前 `updated_at`。
 *
 * 载荷与当前深相等时原样返回、**不** bump `updated_at`：重复 PUT 同一份配置是
 * 幂等的，否则界面每次保存都会让别人手里的 version 失效。
 */
export function writeRuntimeConfig(
  input: AgentRuntimeConfigInput,
  expectedVersion: string,
  actor: string,
): AgentRuntimeConfig {
  const current = readRuntimeConfig();
  if (expectedVersion !== current.updated_at) {
    throw new ApiError(
      409,
      'version_conflict',
      'Agent 运行时配置已在别处被修改',
      { expected: expectedVersion, actual: current.updated_at },
      { current },
    );
  }

  const normalized = validateRuntimeConfigInput({...input,
    field_sources: input.field_sources ?? current.field_sources,
    detected: input.detected === undefined ? current.detected : input.detected,
  });
  if (samePayload(normalized, payloadOf(current))) {
    return current;
  }

  const timestamp = nowIso();
  const next: AgentRuntimeConfig = {
    schema_version: 1,
    ...normalized,
    updated_at: timestamp,
    history: [
      { at: timestamp, change: `PUT /api/agent/runtime-config (${actor})` },
      ...current.history,
    ].slice(0, 50),
  };

  const parsed = agentRuntimeConfigSchema.safeParse(next);
  if (!parsed.success) {
    throw badRequest('拒绝写入 config/agent-runtime.json — 载荷不合法', parsed.error.issues);
  }

  return commit(parsed.data as AgentRuntimeConfig);
}

/**
 * validate-then-atomic-rename，与 habits 写入同一套：tmp → fsync → rename。
 *
 * 调用方必须先过 `agentRuntimeConfigSchema`——这个函数只负责落盘，不负责判断合法性。
 */
function commit(config: AgentRuntimeConfig): AgentRuntimeConfig {
  const target = agentRuntimeConfigPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  const body = `${JSON.stringify(config, null, 2)}\n`;
  const fd = fs.openSync(temp, 'w');
  try {
    fs.writeFileSync(fd, body);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, target);

  return config;
}

/**
 * 把一次检测结果合并进配置。**纯函数**：不读盘、不写盘、不看时钟。
 *
 * 三条规则，按优先级：
 * 1. `detected` 永远被整份快照覆盖——它就是「上次检测看到了什么」，刷新它是 persist
 *    的全部意义所在，即便这次什么都没探到。
 * 2. **`manual` 字段一个都不动。** 值保持原样、标记保持 `manual`。这是「自动检测不会
 *    悄悄冲掉我手填的路径」这条承诺的落点，所以它比任何检测结论都优先。
 * 3. **没有 `recommended` 就一个值都不改。** 探不到可用 CLI 时，`config_patch` 里的
 *    `provider` / `cli_path` 都是 null，把它们写进去等于「检测失败 ⇒ 擦掉你的配置」。
 *
 * `enabled` / `allowed_env_names` / `schema_version` 从不在合并范围内：检测**绝不**替
 * 用户开启 Agent，也绝不动环境变量白名单——那两项是用户授权的边界，不是可推断的事实。
 */
function applyDetectedToConfig(opts: {
  current: AgentRuntimeConfig;
  detection: RuntimeDetectResponse;
}): AgentRuntimeConfig {
  const { current, detection } = opts;
  // 完整快照进 `detected`，和候选列表、note 一起——界面要能展示「探到了什么」。
  const next: AgentRuntimeConfig = { ...current, detected: detection };
  if (!detection.recommended) return next;

  const sources: Record<string, 'auto' | 'manual'> = { ...(current.field_sources ?? {}) };
  /**
   * 单个字段的取舍：`manual` 保留原值，否则取检测值并把来源标回 `auto`。
   *
   * 每个字段都显式列一次（而不是遍历一个字符串数组再往对象上打洞），是为了让类型检查
   * 真的管到这里：写错字段名、或把 `args` 和 `timeout_ms` 的值接反，都会在编译期挂掉。
   */
  const merge = <K extends keyof AgentRuntimeConfig>(
    field: K,
    detected: AgentRuntimeConfig[K],
  ): void => {
    if (sources[field as string] === 'manual') return;
    next[field] = detected;
    sources[field as string] = 'auto';
  };

  const patch = detection.config_patch;
  // `?? current.x` 只是给类型收口：`recommended` 非空时这两项必然有值。
  merge('provider', patch.provider ?? current.provider);
  merge('cli_path', patch.cli_path ?? current.cli_path);
  merge('model', patch.model);
  merge('args', patch.recommended_args);
  merge('timeout_ms', next.provider === 'codex' ? Math.max(patch.timeout_ms, 120000) : Math.max(patch.timeout_ms, 60000));
  merge('working_directory', patch.working_directory);

  next.field_sources = normalizeFieldSources(sources);
  return next;
}

/**
 * 把一次检测结果写回配置。只在调用方显式要求（`persist=true`）时才走到这里。
 *
 * 并发语义与 `PUT` 完全一致：`expectedVersion` 必须等于当前 `updated_at`，否则 409 且
 * **什么都不写**。
 *
 * 和 `PUT` 刻意不同的一点：这里**没有**「载荷相同就不 bump」的幂等短路。快照里带着新的
 * `detected_at`，所以重复 persist 每次都会推进 `updated_at`——这是有意为之，「上次检测
 * 是什么时候看到的」本身就是用户要看的信息。代价是别的标签页手里的 version 会作废，
 * 但 persist 是用户按下「应用检测结果」才发生的显式动作，不像 PUT 那样会被界面反复触发。
 */
export function persistDetected(opts: {
  detection: RuntimeDetectResponse;
  expectedVersion: string;
}): { config: AgentRuntimeConfig } {
  const current = readRuntimeConfig();
  if (opts.expectedVersion !== current.updated_at) {
    throw new ApiError(
      409,
      'version_conflict',
      'Agent 运行时配置已在别处被修改',
      { expected: opts.expectedVersion, actual: current.updated_at },
      { current },
    );
  }

  const merged = applyDetectedToConfig({ current, detection: opts.detection });
  const timestamp = nowIso();
  const next: AgentRuntimeConfig = {
    ...merged,
    updated_at: timestamp,
    history: [
      { at: timestamp, change: 'POST /api/agent/runtime-detect (persist)' },
      ...current.history,
    ].slice(0, 50),
  };

  const parsed = agentRuntimeConfigSchema.safeParse(next);
  if (!parsed.success) {
    throw badRequest('拒绝写入 config/agent-runtime.json — 载荷不合法', parsed.error.issues);
  }

  return { config: commit(parsed.data as AgentRuntimeConfig) };
}
