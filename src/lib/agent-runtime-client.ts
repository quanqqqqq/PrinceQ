/**
 * Agent runtime（本机 Claude / Codex CLI）的独立 typed client。
 *
 * 路由与 server/http/routes.ts 实测一致：
 * - GET  `/api/agent/runtime-config`            → `{ config, updated_at }`
 * - PUT  `/api/agent/runtime-config`            → body 嵌套 `{ config, expected_version }`
 * - GET  `/api/agent/runtime-status`            → AgentRuntimeStatusView（实时健康 + effective_mode）
 * - POST `/api/agent/runtime-test`              → 无入参，固定无副作用探测 CLI
 * - POST `/api/agent/message`                   → 消息走既有端点，靠 processing_mode 选路
 *
 * 为什么不并进 `src/lib/api.ts`：那个文件是全站共用、由另一条线维护的契约层；
 * 这里只是按实测形状薄封装，错误类型沿用 `ApiRequestError`，长请求可 AbortSignal 取消。
 * env 只发变量名——契约里没有任何密钥值字段。
 */
import type { AgentMessageResponse } from '@shared/types';
import { ApiRequestError } from '@/lib/api';
import type {
  AgentRuntimeStatusView,
  AgentConfigForm,
  AgentRuntimeProvider,
  RuntimeDetectEnvelope,
  RuntimeConfigEnvelope,
  RuntimeConfigSaveResult,
  RuntimeTestResult,
  RuntimeProviderEntry,
} from '@/lib/agent-runtime-contract';

export const RUNTIME_CONFIG_CHANGED_EVENT = 'princeq:agent-runtime-config-changed';
function notifyRuntimeChange() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(RUNTIME_CONFIG_CHANGED_EVENT));
}

/** 每条写/调用带一个；重试由用户显式触发。 */
const newIdempotencyKey = (prefix: string): string =>
  `ui-${prefix}-${crypto.randomUUID().slice(0, 18)}`;

interface RequestOptions {
  method?: 'GET' | 'PUT' | 'POST';
  body?: unknown;
  idempotency?: string;
  /** 长请求可由调用方取消（AbortController）。 */
  signal?: AbortSignal;
  idempotencyKey?: string;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, idempotency, signal, idempotencyKey } = options;

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(idempotency ? { 'Idempotency-Key': idempotencyKey ?? newIdempotencyKey(idempotency) } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new ApiRequestError(
      0,
      'offline',
      'Cannot reach the local API on 127.0.0.1:28642. Start it with `npm run dev`.',
    );
  }

  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const error = (
      payload as { error?: { code?: string; message?: string; details?: unknown } } | null
    )?.error;
    throw new ApiRequestError(
      response.status,
      error?.code ?? 'unknown',
      error?.message ?? `本地 API 返回状态码 ${response.status}。`,
      error?.details,
    );
  }
  return payload as T;
}

/** 409 = 配置在别处被改过，本地 expected_version 过期。 */
export function isRuntimeConflict(err: unknown): boolean {
  return err instanceof ApiRequestError && err.status === 409;
}

/** 只读：拿当前配置全量视图。expected_version 就是返回里的 updated_at。 */
export const getRuntimeConfig = (): Promise<RuntimeConfigEnvelope> =>
  request<RuntimeConfigEnvelope>('/api/agent/runtime-config');

/** 实时状态（强制跳过健康缓存）：是否配置过/启用/provider/health/effective_mode。 */
export const getRuntimeStatus = (): Promise<AgentRuntimeStatusView> =>
  request<AgentRuntimeStatusView>('/api/agent/runtime-status');

/**
 * 保存配置。body 是**嵌套** `{ config, expected_version }`；config 只含可写字段，
 * env 只带大写变量名——后端契约里没有任何密钥值字段。
 */
const pendingConfigKeys = new Map<string, string>();
const ownConfigVersions = new Map<string, string>();
export const saveRuntimeConfig = async (config: AgentConfigForm, expectedVersion: string): Promise<RuntimeConfigSaveResult> => {
  let version = expectedVersion;
  const seen = new Set<string>();
  while (ownConfigVersions.has(version) && !seen.has(version)) { seen.add(version); version = ownConfigVersions.get(version)!; }
  const body = {config, expected_version: version};
  const signature = JSON.stringify(body);
  const key = pendingConfigKeys.get(signature) ?? newIdempotencyKey('agent-runtime-save');
  pendingConfigKeys.set(signature, key);
  const result = await request<RuntimeConfigSaveResult>('/api/agent/runtime-config', {
    method: 'PUT', body, idempotency: 'agent-runtime-save', idempotencyKey: key,
  });
  pendingConfigKeys.delete(signature);
  ownConfigVersions.set(version, result.updated_at);
  notifyRuntimeChange();
  return result;
};

/** 连接测试：固定无副作用，只探测**已保存**的 CLI；不建 session、不写库。 */
export const getRuntimeProviders = (): Promise<{providers: RuntimeProviderEntry[]}> => request('/api/agent/runtime-providers');
export const testRuntimeConnection = (target?: {provider: AgentRuntimeProvider; cli_path: string}): Promise<RuntimeTestResult> =>
  request<RuntimeTestResult>('/api/agent/runtime-test', {
    method: 'POST',
    body: target ?? {},
    idempotency: 'agent-runtime-test',
  });

/**
 * 消息统一走既有 `/api/agent/message`，用 `processing_mode` 选路：
 * - `auto`：后端按健康状况择一（一般不直接用，前端要显式）。
 * - `agent`：强制走模型；未就绪/失败后端返回 `source:'agent-error'`（200，非异常），
 *   由面板读 `available_actions` 给「重试 / 回落命令」按钮。
 * - `command`：强制走确定性规则解析器。
 * `fallback:true` 仅在显式「用命令模式处理本条」时带上。
 */
export const sendAgentMessage = (
  message: string,
  opts: {
    sessionId?: string;
    target?: { task_id?: string; goal_id?: string };
    processingMode: 'auto' | 'agent' | 'command';
    intent?: 'goal_task_drafts';
    fallback?: boolean;
    retryOf?: string;
    signal?: AbortSignal;
  },
): Promise<AgentMessageResponse> =>
  request<AgentMessageResponse>('/api/agent/message', {
    method: 'POST',
    body: {
      message,
      session_id: opts.sessionId,
      processing_mode: opts.processingMode,
      ...(opts.intent ? { intent: opts.intent } : {}),
      ...(opts.fallback ? { fallback: true } : {}),
      ...(opts.retryOf ? { retry_of: opts.retryOf } : {}),
      ...(opts.target?.task_id ? { target_task_id: opts.target.task_id } : {}),
      ...(opts.target?.goal_id ? { target_goal_id: opts.target.goal_id } : {}),
    },
    idempotency: 'agent-runtime-msg',
    signal: opts.signal,
  });

/**
 * 自动检测：**只 POST** `/api/agent/runtime-detect`（无 GET）。
 *
 * - 默认纯只读：不写库/不建 session/不写配置文件。
 * - 带 `persist=true` 时后端才把 config_patch 写回（只覆盖 field_sources=auto 的字段），
 *   且必须同时带 `expected_version`（= 当前 config.updated_at）。
 * - 响应在检测主体外带 `persisted`，persist=true 时还带 `config` / `updated_at`。
 */
export const postRuntimeDetect = async (body: {
  provider?: AgentRuntimeProvider;
  expected_version?: string;
  persist?: boolean;
}): Promise<RuntimeDetectEnvelope> => {
  const result = await request<RuntimeDetectEnvelope>('/api/agent/runtime-detect', {
    method: 'POST', body, idempotency: 'agent-runtime-detect',
  });
  if (result.persisted) notifyRuntimeChange();
  return result;
};
