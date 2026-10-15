import {absoluteFilesystemPath, hasParentPathSegment} from '../../shared/filesystem-path.ts';
/**
 * Agent runtime（本机 Claude / Codex CLI）前端契约的纯逻辑层。
 *
 * 字段名与后端逐一对齐（shared/types.ts + server/http/routes.ts 实测）：
 * - 配置 GET `/api/agent/runtime-config` → `{ config, updated_at }`（updated_at 即乐观并发版本号）。
 * - PUT body 是**嵌套**的 `{ config, expected_version }`。
 * - 健康状态在独立的 `GET /api/agent/runtime-status`，形状是
 *   `AgentRuntimeStatusView`，其中 health 为 `{ ok, reason, checked_at }`（snake，可空）。
 * - 连通测试是 `POST /api/agent/runtime-test`，无入参（只测已保存配置，不收草稿）。
 * - 消息统一走既有 `POST /api/agent/message`，靠 `processing_mode` 选路。
 *
 * 与 settings 那套同一思路：**不引 React、不碰网络**，中文标签/校验/载荷都在这里，
 * `tests/agent-runtime-contract.test.ts` 直接 import；网络层在 `agent-runtime-client.ts`。
 */
import type {
  AgentRuntimeConfigView,
  AgentRuntimeProvider,
  AgentRuntimeStatusView,
} from '@shared/types';

export type { AgentRuntimeProvider, AgentRuntimeConfigView, AgentRuntimeStatusView };

/** 面板当前实际用哪条路处理消息。 */
export type EffectiveMode = 'agent' | 'local-command';

/**
 * 设置区块编辑中的草稿：只取可写字段（schema_version/updated_at/history 由后端产生）。
 * env 只存**大写变量名**，绝不存值——密钥由用户本机环境提供，界面既不展示也不保存。
 */
export interface AgentConfigForm {
  enabled: boolean;
  provider: AgentRuntimeProvider;
  /** CLI 可执行文件的绝对路径；启用时必填。 */
  cli_path: string;
  /** 模型 id；null 表示用 provider 默认。 */
  model: string | null;
  /** 逐项 argv 参数（每一项单独一个 token），不是 shell 命令串。 */
  args: string[];
  /** 单次请求超时（毫秒）。 */
  timeout_ms: number;
  /** 工作目录，必须落在项目根目录之内。 */
  working_directory: string;
  /** 允许传给 CLI 的环境变量**大写名**白名单。 */
  allowed_env_names: string[];
}

/** GET 配置返回：config 全量视图 + updated_at（= 保存时要回传的 expected_version）。 */
export interface RuntimeConfigEnvelope {
  config: AgentRuntimeConfigView;
  updated_at: string;
}

/** PUT 配置返回。replayed 表示这次写是否被幂等跳过。 */
export interface RuntimeConfigSaveResult {
  config: AgentRuntimeConfigView;
  updated_at: string;
  replayed: boolean;
}

/** POST /api/agent/runtime-test 的返回（固定无副作用，只探测 CLI）。 */
export interface RuntimeTestResult {
  ok: boolean;
  reason: string | null;
  warnings?: import('@shared/types').AgentWarning[];
  status?: 'success' | 'success_with_warning' | 'failure';
  stdout_excerpt: string;
  exit_code: number;
  timed_out: boolean;
  provider: AgentRuntimeProvider | null;
  checked_at?: string;
  latency_ms?: number;
  cli_path?: string;
}

export interface RuntimeProviderEntry {
  provider: AgentRuntimeProvider;
  candidate: DetectedCandidate | null;
  connection: RuntimeTestResult | null;
}

// ── 模式推导 ──────────────────────────────────────────────────────────────────

/**
 * 只有「启用 且 健康探测 ok」才走真实 Agent；其余任何一种都回落到本地命令解析器。
 * 回落时输入框**仍然发出去**，只是走本地命令——不静默、不吞。
 */
export function deriveEffectiveMode(enabled: boolean, healthOk: boolean): EffectiveMode {
  return enabled && healthOk ? 'agent' : 'local-command';
}

// ── 中文标签 ──────────────────────────────────────────────────────────────────

export const PROVIDER_LABELS: Record<AgentRuntimeProvider, string> = {
  claude: 'Claude',
  codex: 'Codex',
};

/** provider 查不到就原样返回（后端将来加 provider 时界面不空白）。 */
export function providerLabel(provider: string | null | undefined): string {
  if (!provider) return '未选择';
  return PROVIDER_LABELS[provider as AgentRuntimeProvider] ?? provider;
}

type HealthTone = 'ok' | 'muted' | 'warn' | 'bad';

interface HealthMeta {
  label: string;
  tone: HealthTone;
}

/** 后端 reason 码 → 中文徽章 + 配色。查不到归到「未知」。 */
const HEALTH_BY_REASON: Record<string, HealthMeta> = {
  disabled: { label: '已停用', tone: 'muted' },
  not_enabled: { label: '已停用', tone: 'muted' },
  cli_not_found: { label: '未找到 CLI', tone: 'bad' },
  cli_not_executable: { label: 'CLI 不可执行', tone: 'bad' },
  cli_probe_failed: { label: 'CLI 探测失败', tone: 'bad' },
  health_unknown: { label: '状态未知', tone: 'warn' },
  timeout: { label: '连接超时（CLI 已安装）', tone: 'bad' },
  model_config_warning: { label: '本机模型配置需检查', tone: 'warn' },
  nonzero_exit: { label: 'CLI 未返回有效回答', tone: 'bad' },
  no_ok_in_output: { label: '未收到预期回答', tone: 'bad' },
  canceled: { label: '已取消', tone: 'muted' },
};

const HEALTH_OK: HealthMeta = { label: 'CLI 可运行', tone: 'ok' };

export interface SimpleHealth {
  ok: boolean;
  reason: string | null;
}

export function healthMeta(health: SimpleHealth): HealthMeta {
  return health.ok
    ? HEALTH_OK
    : (HEALTH_BY_REASON[health.reason ?? ''] ?? { label: '状态未知', tone: 'warn' });
}

/** 头部副标题：agent 不可用时把原因明说出来，而不是悄悄当成本地模式。 */
export function modeSubtitle(
  mode: EffectiveMode,
  enabled: boolean,
  provider: AgentRuntimeProvider | null,
  health: SimpleHealth,
): string {
  if (mode === 'agent') return `Agent 模式 · ${providerLabel(provider)}`;
  if (!enabled) return '本地命令模式（Agent 未启用）';
  return `本地命令模式（Agent 不可用：${healthMeta(health).label}）`;
}

/** 响应卡上给人看的「来源」标签。 */
export function sourceModeForResult(mode: 'agent' | 'deterministic-local' | undefined | null, fallback: EffectiveMode = 'local-command'): EffectiveMode {
  return mode === 'agent' ? 'agent' : mode === 'deterministic-local' ? 'local-command' : fallback;
}
export function sourceLabel(mode: EffectiveMode, provider: string | null | undefined): string {
  return mode === 'agent' ? (provider ? `Agent · ${providerLabel(provider)}` : 'Agent') : '本地命令';
}

// ── env 变量名白名单：只存大写名字，绝不存值 ───────────────────────────────────

export const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

const SECRET_NAME_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL)/;

export interface EnvNameParse {
  ok: boolean;
  name: string;
  /** 校验失败/安全提醒文案（中文），ok=true 时也可能带一条提醒。 */
  message?: string;
}

/**
 * 解析用户敲进来的一行，只接受**大写变量名**。
 * 带 `=` 直接拒；小写自动转大写；像密钥的名字放行但提醒「只存名字」。
 */
export function parseEnvName(raw: string): EnvNameParse {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, name: '', message: '变量名为空。' };
  if (trimmed.includes('=')) {
    return { ok: false, name: '', message: '只填变量名（例如 ANTHROPIC_API_KEY），不要填等号或任何密钥值。' };
  }
  const upper = trimmed.toUpperCase();
  if (!ENV_NAME_RE.test(upper)) {
    return { ok: false, name: '', message: '变量名只能含大写字母、数字与下划线，且以字母或下划线开头。' };
  }
  if (SECRET_NAME_RE.test(upper)) {
    return {
      ok: true,
      name: upper,
      message: '这看起来像密钥变量名——我们只保存名字，绝不保存、也绝不回显任何密钥值。',
    };
  }
  return { ok: true, name: upper };
}

// ── args：逐项 argv，不是 shell 字符串 ─────────────────────────────────────────

const SHELL_META_RE = /[;&|`$<>\\\n\r]/;

export interface ArgsAddResult {
  args: string[];
  error?: string;
}

export function addArgToList(current: string[], raw: string): ArgsAddResult {
  const token = raw.trim();
  if (!token) return { args: current, error: '参数为空。' };
  if (SHELL_META_RE.test(token)) {
    return { args: current, error: '参数应逐项添加，不要包含 shell 符号（; | & $ > ` 等）。' };
  }
  if (current.includes(token)) return { args: current, error: '该参数已存在。' };
  return { args: [...current, token] };
}

// ── 工作目录：限制在项目内 ──────────────────────────────────────────────────────

export interface PathCheck {
  ok: boolean;
  error?: string;
}

export function checkWorkingDir(raw: string): PathCheck {
  const value = raw.trim();
  if (value === '') return { ok: false, error: '工作目录必填，需位于项目目录内。' };
  if (hasParentPathSegment(value)) {
    return { ok: false, error: '工作目录不能包含「..」上跳，请填项目目录内的绝对路径。' };
  }
  const isAbsolute = absoluteFilesystemPath(value);
  if (!isAbsolute) {
    return { ok: false, error: '请填项目目录内的绝对路径。' };
  }
  return { ok: true };
}

// ── 超时（毫秒，与后端一致） ────────────────────────────────────────────────────

export const TIMEOUT_MS_MIN = 500;
export const TIMEOUT_MS_MAX = 120_000;

export function clampTimeoutMs(value: number): number {
  if (!Number.isFinite(value)) return 20_000;
  return Math.min(TIMEOUT_MS_MAX, Math.max(TIMEOUT_MS_MIN, Math.round(value)));
}

// ── 整份表单校验 + 保存载荷（嵌套 config/expected_version） ──────────────────────

export function validateConfig(form: AgentConfigForm): string[] {
  const errors: string[] = [];
  if (form.enabled) {
    if (!form.cli_path.trim()) errors.push('启用时必须填写 CLI 绝对路径。');
    else if (!absoluteFilesystemPath(form.cli_path.trim())) {
      errors.push('CLI 路径必须是绝对路径。');
    }
  }
  if (
    !Number.isFinite(form.timeout_ms) ||
    form.timeout_ms < TIMEOUT_MS_MIN ||
    form.timeout_ms > TIMEOUT_MS_MAX
  ) {
    errors.push(`超时需在 ${TIMEOUT_MS_MIN}–${TIMEOUT_MS_MAX} 毫秒之间。`);
  }
  const dir = checkWorkingDir(form.working_directory);
  if (!dir.ok && dir.error) errors.push(dir.error);
  for (const name of form.allowed_env_names) {
    if (!ENV_NAME_RE.test(name)) errors.push(`环境变量名不合法：${name}`);
  }
  return errors;
}

/**
 * 组装 PUT 载荷：**嵌套** `{ config: <可写字段>, expected_version }`。
 * env 只留合法大写名；args trim 去空；超时夹范围。绝不带任何密钥值字段。
 */
export function buildSavePayload(
  form: AgentConfigForm,
  expectedVersion: string,
  sources?: FieldSource,
): { config: AgentConfigForm & { field_sources?: FieldSource }; expected_version: string } {
  return {
    expected_version: expectedVersion,
    config: {
      enabled: form.enabled,
      provider: form.provider,
      cli_path: form.cli_path.trim(),
      model: form.model ? form.model.trim() : null,
      args: form.args.map((a) => a.trim()).filter(Boolean),
      timeout_ms: clampTimeoutMs(form.timeout_ms),
      working_directory: form.working_directory.trim(),
      allowed_env_names: form.allowed_env_names.filter((name) => ENV_NAME_RE.test(name)),
      ...(sources ? { field_sources: sources } : {}),
    },
  };
}

// ── 自动检测（auto-detect） ─────────────────────────────────────────────────────
// 形状与 server/agent/detect.ts `RuntimeDetectResponse` 逐一对齐。检测是**纯本机只读
// 探查**：每个候选只跑 `--version` 与 `--help`，不调用模型、不联网、不读 token、不写库；
// 所以 auth_status 恒为 'unknown'（后端不跑 auth/login/status）。

/** 从 --help 文本读到的能力（全部来自字面解析，不是试探出来的）。 */
export interface CliCapabilities {
  non_interactive: boolean;
  output_formats: string[];
  supports_model_flag: boolean;
  help_checked: boolean;
}

/** 单个候选 CLI。注意路径字段叫 `path`（不是 cli_path）。 */
export interface DetectedCandidate {
  provider: AgentRuntimeProvider;
  /** 绝对路径。 */
  path: string;
  rank: number;
  exists: boolean;
  version: string | null;
  exit_code: number;
  timed_out: boolean;
  latency_ms: number;
  /** 恒为 'unknown'：检测不跑任何 auth/login/status，也不读凭据。 */
  auth_status: 'unknown';
  capabilities: CliCapabilities;
}

/** detect 给的建议配置补丁；后端不自动应用，persist=true 时才写回。 */
export interface DetectedConfigPatch {
  provider: AgentRuntimeProvider | null;
  cli_path: string | null;
  /** 恒为 null：用哪个模型由 CLI 自己的配置决定，检测不猜。 */
  model: string | null;
  timeout_ms: number;
  working_directory: string;
  /** 只可能含 help 里确认过的输出格式 flag（如 --output-format json）。 */
  recommended_args: string[];
  /** 恒为 'cli-config'。 */
  model_source: 'cli-config';
}

/** POST /api/agent/runtime-detect 的响应主体（不含 persisted/config/updated_at 外壳）。 */
export interface RuntimeDetectResponse {
  detected_at: string;
  latency_ms: number;
  candidates: DetectedCandidate[];
  /** 第一个「存在且 --version 退出码 0」的候选；没有就是 null。 */
  recommended: DetectedCandidate | null;
  config_patch: DetectedConfigPatch;
  note: string;
}

/** detect 响应外壳：persist=true 时额外带 config/updated_at。 */
export interface RuntimeDetectEnvelope extends RuntimeDetectResponse {
  persisted: boolean;
  config?: AgentConfigForm & { updated_at?: string };
  updated_at?: string;
}

/**
 * 安全解析 config.detected（后端故意标成 unknown|null）。形状不对就返回 null，
 * 绝不让一次字段增减把配置判坏——界面回退到「没有检测结果」即可。
 */
export function parseDetectedSnapshot(raw: unknown): RuntimeDetectResponse | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.candidates)) return null;
  const patch = r.config_patch as Record<string, unknown> | undefined;
  if (!patch || typeof patch !== 'object') return null;
  return {
    detected_at: typeof r.detected_at === 'string' ? r.detected_at : '',
    latency_ms: typeof r.latency_ms === 'number' ? r.latency_ms : 0,
    candidates: (r.candidates as Record<string, unknown>[])
      .filter((c) => c && typeof c.path === 'string' && typeof c.provider === 'string')
      .map((c) => ({
        provider: c.provider as AgentRuntimeProvider,
        path: c.path as string,
        rank: typeof c.rank === 'number' ? c.rank : 0,
        exists: Boolean(c.exists),
        version: typeof c.version === 'string' ? c.version : null,
        exit_code: typeof c.exit_code === 'number' ? c.exit_code : -1,
        timed_out: Boolean(c.timed_out),
        latency_ms: typeof c.latency_ms === 'number' ? c.latency_ms : 0,
        auth_status: 'unknown',
        capabilities: {
          non_interactive: Boolean(c.capabilities && (c.capabilities as Record<string, unknown>).non_interactive),
          output_formats: Array.isArray((c.capabilities as Record<string, unknown>)?.output_formats)
            ? ((c.capabilities as Record<string, unknown>).output_formats as string[])
            : [],
          supports_model_flag: Boolean(c.capabilities && (c.capabilities as Record<string, unknown>).supports_model_flag),
          help_checked: Boolean(c.capabilities && (c.capabilities as Record<string, unknown>).help_checked),
        },
      })),
    recommended:
      r.recommended && typeof r.recommended === 'object' && typeof (r.recommended as Record<string, unknown>).path === 'string'
        ? (() => {
            const c = r.recommended as Record<string, unknown>;
            return {
              provider: c.provider as AgentRuntimeProvider,
              path: c.path as string,
              rank: typeof c.rank === 'number' ? c.rank : 0,
              exists: Boolean(c.exists),
              version: typeof c.version === 'string' ? c.version : null,
              exit_code: typeof c.exit_code === 'number' ? c.exit_code : -1,
              timed_out: Boolean(c.timed_out),
              latency_ms: typeof c.latency_ms === 'number' ? c.latency_ms : 0,
              auth_status: 'unknown' as const,
              capabilities: {
                non_interactive: Boolean(c.capabilities && (c.capabilities as Record<string, unknown>).non_interactive),
                output_formats: Array.isArray((c.capabilities as Record<string, unknown>)?.output_formats)
                  ? ((c.capabilities as Record<string, unknown>).output_formats as string[])
                  : [],
                supports_model_flag: Boolean(c.capabilities && (c.capabilities as Record<string, unknown>).supports_model_flag),
                help_checked: Boolean(c.capabilities && (c.capabilities as Record<string, unknown>).help_checked),
              },
            };
          })()
        : null,
    config_patch: {
      provider: typeof patch.provider === 'string' ? (patch.provider as AgentRuntimeProvider) : null,
      cli_path: typeof patch.cli_path === 'string' ? patch.cli_path : null,
      model: typeof patch.model === 'string' ? patch.model : null,
      timeout_ms: typeof patch.timeout_ms === 'number' ? patch.timeout_ms : 20_000,
      working_directory: typeof patch.working_directory === 'string' ? patch.working_directory : '',
      recommended_args: Array.isArray(patch.recommended_args) ? (patch.recommended_args as string[]) : [],
      model_source: 'cli-config',
    },
    note: typeof r.note === 'string' ? r.note : '',
  };
}

/** 被检测/手动覆盖管理的可写字段。 */
export type ConfigField =
  | 'provider'
  | 'cli_path'
  | 'model'
  | 'args'
  | 'timeout_ms'
  | 'working_directory';

/** 每个字段的值来自「自动检测」还是「用户手动」。缺省视为 auto。随 config 一起 PUT。 */
export type FieldSource = Record<ConfigField, 'auto' | 'manual'>;

export function allAutoSources(): FieldSource {
  return { provider: 'auto', cli_path: 'auto', model: 'auto', args: 'auto', timeout_ms: 'auto', working_directory: 'auto' };
}

/** 从后端 config.field_sources（宽松 Record）读成完整 FieldSource，缺省 auto。 */
export function sourcesFromRecord(raw: Record<string, string> | undefined): FieldSource {
  const base = allAutoSources();
  if (!raw) return base;
  for (const key of Object.keys(base) as ConfigField[]) {
    if (raw[key] === 'manual') base[key] = 'manual';
  }
  return base;
}

export function markManual(source: FieldSource, field: ConfigField): FieldSource {
  return { ...source, [field]: 'manual' };
}

/** 后端推荐候选就是 detection.recommended。 */
export function pickRecommendedCandidate(detect: RuntimeDetectResponse): DetectedCandidate | null {
  return detect.recommended;
}

/**
 * 把 detection.config_patch 合进表单：**只覆盖当前标记为 auto 的字段**；manual 字段不动。
 * 注意映射：config_patch.recommended_args → form.args；model 不由检测决定，永远不动。
 */
export function applyDetectedRecommendation(
  form: AgentConfigForm,
  source: FieldSource,
  detect: RuntimeDetectResponse,
): { form: AgentConfigForm; source: FieldSource } {
  const patch = detect.config_patch;
  const next = { ...form };
  if (source.provider === 'auto' && patch.provider) next.provider = patch.provider;
  if (source.cli_path === 'auto' && patch.cli_path) next.cli_path = patch.cli_path;
  if (source.args === 'auto') next.args = [...patch.recommended_args];
  if (source.timeout_ms === 'auto') next.timeout_ms = patch.timeout_ms;
  if (source.working_directory === 'auto' && patch.working_directory) next.working_directory = patch.working_directory;
  return { form: next, source };
}

/** 用户在候选列表里明确选了一个：采用该候选的 provider+path，并把这两项标为 manual。 */
export function adoptCandidate(
  form: AgentConfigForm,
  source: FieldSource,
  candidate: DetectedCandidate,
): { form: AgentConfigForm; source: FieldSource } {
  const changedProvider = form.provider !== candidate.provider;
  return {
    form: { ...form, provider: candidate.provider, cli_path: candidate.path,
      ...(changedProvider ? {model: null, args: []} : {}),
      timeout_ms: source.timeout_ms === 'manual' && !changedProvider ? form.timeout_ms : candidate.provider === 'codex' ? 120000 : 60000 },
    source: { ...source, provider: 'manual', cli_path: 'manual',
      ...(changedProvider ? {model: 'auto', args: 'auto', timeout_ms: 'auto'} : {}) },
  };
}
