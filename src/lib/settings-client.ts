/**
 * `/api/settings/*` 的独立 typed client。
 *
 * 为什么不并进 `src/lib/api.ts`：那个文件是全站共用的契约层，而设置页的十几条路由
 * 正由另一条线接入后端。先在这里按最终契约写完、测完，等路由落地后再整体并回
 * `api`，期间两边时序不同步也不会互相阻塞。错误类型沿用 `ApiRequestError`，所以
 * `useMutation`/`WriteError` 那套既有的中文报错展示一个字都不用改。
 *
 * 每个写端点都带 `Idempotency-Key`，并在 body 里带对应文件的 `expected_version`：
 * 设置分四个文件（explicit/constraints/inferred/weights）各自版本独立，哪一类写
 * 哪一类的版本，发错会被后端判成 409。
 */
import type {HabitInferenceStatus} from '@shared/habit-inference';
import type { TaskType } from '@shared/types';
import { ApiRequestError } from '@/lib/api';

/** 明确习惯的 kind。后端允许扩展，所以类型留成开放的 string。 */
export interface ExplicitHabitEntry {
  id: string;
  statement: string;
  kind: string;
  enabled: boolean;
  confidence: number | null;
  source: 'user' | 'agent';
  /** 采纳自某条推断习惯时的来源关联，结构由后端定义，界面只透传。 */
  source_relation?: unknown;
  updated_at?: string;
}

/** Evidence-backed Agent observations; legacy observations remain inactive history. */
export interface InferredHabitEntry {
  id: string;
  statement: string;
  kind: string;
  enabled: boolean;
  confidence: number;
  source: 'observed' | 'agent_inference';
  source_relation?: unknown;
  updated_at?: string;
}

/** 硬性约束：`value` 的格式随 kind 变（时段是 "HH:MM-HH:MM"，其余是分钟数串）。 */
export interface ConstraintEntry {
  id: string;
  statement: string;
  kind: string;
  enabled: boolean;
  value: string;
  updated_at?: string;
}

export interface SettingsWeights {
  deadline: number;
  manual_priority: number;
  dependency: number;
  effort: number;
  habit_alignment: number;
  context_switch: number;
}

/** 排序偏好三件套：权重 + 偏好任务类型 + 精力高峰时段，同属 weights.json。 */
export interface WeightsPayload {
  weights: SettingsWeights;
  preferred_task_types: TaskType[];
  peak_hours: number[];
  task_type_peak_hours?: Partial<Record<TaskType, number[]>>;
}

export interface ConversionPayload {
  hours_per_day: number;
  days_per_month: number;
}

/**
 * 四个设置文件各自的版本号。写操作要带上对应那一项，后端用它做乐观并发检查。
 */
export interface SettingsVersions {
  explicit: string;
  constraints: string;
  inferred: string;
  weights: string;
}

export interface SettingsSnapshot {
  versions: SettingsVersions;
  weights: WeightsPayload;
  conversion: ConversionPayload;
  explicit: ExplicitHabitEntry[];
  inferred: InferredHabitEntry[];
  constraints: ConstraintEntry[];
}

/** 写端点的成功响应：以 `snapshot` 为准，额外字段忽略。 */
interface SnapshotEnvelope {
  snapshot: SettingsSnapshot;
}

/**
 * 采纳的响应：快照永远在，重复采纳命中后端预检时多带两个字段。
 *
 * `already: true` 表示这次调用**没有写任何东西**——这条推断之前已经被采纳过了，
 * `existing_id` 指回已有的那条 explicit。
 */
export interface AdoptEnvelope extends SnapshotEnvelope {
  already?: boolean;
  existing_id?: string;
}

/** 权重预览（dryrun）的响应：至少含 weights，可带一句后端给的说明。 */
export interface WeightsPreviewResponse {
  weights: SettingsWeights;
  message?: string;
}

export interface ConversionInput {
  hours_per_day?: number;
  days_per_month?: number;
}

export interface ConstraintInput {
  statement: string;
  kind: string;
  value: string;
}

/** PATCH 用：三个字段都可选，只发用户真改了的那些。 */
export type ConstraintPatch = Partial<ConstraintInput>;

export interface ExplicitInput {
  statement: string;
  kind?: string;
}

export type ExplicitPatch = Partial<ExplicitInput>;

/** 权重草稿：预览与保存共用。保存时 `weights` 必填，另两项可选。 */
export interface WeightsDraft {
  weights: SettingsWeights;
  preferred_task_types?: TaskType[];
  peak_hours?: number[];
  task_type_peak_hours?: Partial<Record<TaskType, number[]>>;
}

/** 每次写操作带一个，重试不会写入两次。 */
const newIdempotencyKey = (prefix: string): string =>
  `ui-${prefix}-${crypto.randomUUID().slice(0, 18)}`;

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH';
  body?: unknown;
  /** 给了前缀就带上 `Idempotency-Key` 头。 */
  idempotency?: string;
  idempotencyKey?: string;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, idempotency, idempotencyKey } = options;

  let response: Response;
  try {
    response = await fetch(`/api/settings${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(idempotency ? { 'Idempotency-Key': idempotencyKey ?? newIdempotencyKey(idempotency) } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    // 本地 API 是独立进程，没起来是最常见的失败。
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

/**
 * 409 = 版本冲突：设置在别处被改过，本地的 `expected_version` 已经过期。
 *
 * 纯函数，单独导出是为了页面层能一眼区分「冲突（刷新即可）」与「真失败（报错）」。
 */
export const getInferenceStatus = () => request<HabitInferenceStatus>('/api/settings/inference-status');

export function isVersionConflict(err: unknown): boolean {
  return err instanceof ApiRequestError && err.status === 409;
}

/** 写端点返回新快照。成功后刷新列表，但自动保存编辑器保留未提交的新输入。 */
let writeTail: Promise<unknown> = Promise.resolve();
const ownVersions = new Map<string, string>();
const uncertainKeys = new Map<string, string>();
function latestOwnVersion(resource: string, version: unknown): unknown {
  let next = version;
  const seen = new Set<unknown>();
  while (typeof next === 'string' && !seen.has(next) && ownVersions.has(resource + ':' + next)) {
    seen.add(next); next = ownVersions.get(resource + ':' + next)!;
  }
  return next;
}
const write = <T = SnapshotEnvelope>(path: string, body: unknown, idempotency: string, method: 'POST' | 'PATCH' = 'POST'): Promise<T> => {
  const queued = writeTail.then(async () => {
    const resource = path.startsWith('/conversion') || path.startsWith('/weights') ? 'weights' : path.split('/')[1];
    const input = {...body as Record<string, unknown>};
    if (input.expected_version !== undefined) input.expected_version = latestOwnVersion(resource, input.expected_version);
    if (input.expected_explicit_version !== undefined) input.expected_explicit_version = latestOwnVersion('explicit', input.expected_explicit_version);
    const signature = method + path + JSON.stringify(input);
    const key = uncertainKeys.get(signature) ?? newIdempotencyKey(idempotency);
    uncertainKeys.set(signature, key);
    const result = await request<T>(path, {method, body: input, idempotency, idempotencyKey: key});
    uncertainKeys.delete(signature);
    const snapshot = (result as SnapshotEnvelope).snapshot;
    if (snapshot && typeof input.expected_version === 'string') {
      ownVersions.set(resource + ':' + input.expected_version, snapshot.versions[resource as keyof SettingsVersions]);
      if (typeof input.expected_explicit_version === 'string') ownVersions.set('explicit:' + input.expected_explicit_version, snapshot.versions.explicit);
    }
    return result;
  });
  writeTail = queued.catch(() => {});
  return queued;
};

export const getSnapshot = (): Promise<SettingsSnapshot> => request<SettingsSnapshot>('');

export const saveConversion = (
  input: ConversionInput,
  expectedVersion: string,
): Promise<SnapshotEnvelope> =>
  write('/conversion', { ...input, expected_version: expectedVersion }, 'settings-conversion');

export const resetConversion = (expectedVersion: string): Promise<SnapshotEnvelope> =>
  write(
    '/conversion/reset',
    { expected_version: expectedVersion },
    'settings-conversion-reset',
  );

export const createConstraint = (
  input: ConstraintInput,
  expectedVersion: string,
): Promise<SnapshotEnvelope> =>
  write('/constraints', { ...input, expected_version: expectedVersion }, 'settings-constraint-create');

export const updateConstraint = (
  id: string,
  input: ConstraintPatch,
  expectedVersion: string,
): Promise<SnapshotEnvelope> =>
  write(
    `/constraints/${id}`,
    { ...input, expected_version: expectedVersion },
    'settings-constraint-update',
    'PATCH',
  );

export const setConstraintEnabled = (
  id: string,
  enabled: boolean,
  expectedVersion: string,
): Promise<SnapshotEnvelope> =>
  write(
    `/constraints/${id}/enabled`,
    { enabled, expected_version: expectedVersion },
    'settings-constraint-enabled',
  );

export const createExplicit = (
  input: ExplicitInput,
  expectedVersion: string,
): Promise<SnapshotEnvelope> =>
  write('/explicit', { ...input, expected_version: expectedVersion }, 'settings-explicit-create');

export const updateExplicit = (
  id: string,
  input: ExplicitPatch,
  expectedVersion: string,
): Promise<SnapshotEnvelope> =>
  write(
    `/explicit/${id}`,
    { ...input, expected_version: expectedVersion },
    'settings-explicit-update',
    'PATCH',
  );

export const setExplicitEnabled = (
  id: string,
  enabled: boolean,
  expectedVersion: string,
): Promise<SnapshotEnvelope> =>
  write(
    `/explicit/${id}/enabled`,
    { enabled, expected_version: expectedVersion },
    'settings-explicit-enabled',
  );

export const setInferredEnabled = (
  id: string,
  enabled: boolean,
  expectedVersion: string,
): Promise<SnapshotEnvelope> =>
  write(
    `/inferred/${id}/enabled`,
    { enabled, expected_version: expectedVersion },
    'settings-inferred-enabled',
  );

/**
 * 采纳一条推断习惯为明确习惯。
 *
 * 要带两个版本：`expected_version` 是 inferred 文件的（那条推断要被标记掉），
 * `expected_explicit_version` 是 explicit 文件的（要往里插一条）。任一过期都是 409。
 *
 * 重复采纳由后端兜住：预检发现这条推断已经有对应的 explicit 时，它什么都不写
 * （不碰文件、history、operation），只回当前快照 + `already: true`。界面据此换一句
 * 提示，不能说成「已新建」。
 */
export const adoptInferred = (
  id: string,
  inferredVersion: string,
  explicitVersion: string,
): Promise<AdoptEnvelope> =>
  write<AdoptEnvelope>(
    `/inferred/${id}/adopt`,
    { expected_version: inferredVersion, expected_explicit_version: explicitVersion },
    'settings-inferred-adopt',
  );

/** dryrun：只算不写，所以不带 expected_version。 */
export const previewWeights = (draft: WeightsDraft): Promise<WeightsPreviewResponse> =>
  write<WeightsPreviewResponse>('/weights/preview', draft, 'settings-weights-preview');

export const saveWeights = (
  draft: WeightsDraft,
  expectedVersion: string,
): Promise<SnapshotEnvelope> =>
  write('/weights', { ...draft, expected_version: expectedVersion }, 'settings-weights-save');
