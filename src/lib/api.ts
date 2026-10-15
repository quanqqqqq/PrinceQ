/**
 * Typed client for the local work-queue API.
 *
 * Vite proxies `/api` to the Node service on 127.0.0.1:28642 (see vite.config.ts),
 * so the browser only ever talks to its own origin. Reference: docs/local-api.md.
 */
import type {
  ActivityResponse,
  AgentMessage,
  AgentMessageResponse,
  AgentSession,
  Actor,
  ApiErrorBody,
  DecompositionPreview,
  DurationUnit,
  Goal,
  GoalWithProgress,
  HabitEntry,
  HabitsResponse,
  HealthResponse,
  Quadrant,
  QueueResponse,
  QueueSnapshot,
  ScoreBreakdown,
  ScoringWeights,
  Task,
  TaskAction,
  TaskAssignment,
} from '@shared/types';
import type { MatrixScoreFields } from '@shared/matrix-view';
import { buildActivityQuery, type ActivityFilters } from '@shared/activity';
import { formatApiError } from '@/lib/i18n';
import { previewActionPath } from '@/lib/agent-preview-contract';

/**
 * 任务加上连续评分字段。
 *
 * 这些列正由后端另一个进程加入 `tasks`，所以这里用可选交叉类型兼容新旧两种
 * 返回结构，前端读不到时按未评分处理。
 */
export type TaskWithMatrix = Task & Partial<MatrixScoreFields>;

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    // 展示用中文由错误码映射得出，业务码与原始消息保持不变。
    super(formatApiError(code, message));
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Every write carries one, so a retried request never applies twice. */
const newIdempotencyKey = (prefix: string): string =>
  `ui-${prefix}-${crypto.randomUUID().slice(0, 18)}`;

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Supplying a prefix turns on the Idempotency-Key header. */
  idempotency?: string;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, idempotency } = options;

  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(idempotency ? { 'Idempotency-Key': newIdempotencyKey(idempotency) } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    // The API is a separate local process; it being down is the common failure.
    throw new ApiRequestError(
      0,
      'offline',
      'Cannot reach the local API on 127.0.0.1:28642. Start it with `npm run dev`.',
    );
  }

  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const error = (payload as ApiErrorBody | null)?.error;
    throw new ApiRequestError(
      response.status,
      error?.code ?? 'unknown',
      error?.message ?? `本地 API 返回状态码 ${response.status}。`,
      error?.details,
    );
  }
  return payload as T;
}

export interface ExplainResponse {
  task_id: string;
  position: number | null;
  breakdown: ScoreBreakdown;
  snapshot: QueueSnapshot | null;
}

export interface TaskDetail {
  task: TaskWithMatrix & { available_actions: TaskAction[] };
  assignments: TaskAssignment[];
  explanation: ExplainResponse;
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  goal_id?: string;
  deadline?: string;
  /** 旧字段：直接给分钟数。与下面两个「数值 + 单位」二选一。 */
  estimated_minutes?: number;
  /**
   * 「数值 + 单位」的耗时输入。两者必须同时给——服务端按最新 habits 配置换算出
   * `estimated_minutes` 落库，并留档原单位供回显。
   */
  duration_value?: number;
  duration_unit?: DurationUnit;
  cognitive_load?: Task['cognitive_load'];
  task_type?: Task['task_type'];
  manual_priority?: number;
}

export const api = {
  health: () => request<HealthResponse>('/health'),

  meta: () =>
    request<{
      quadrant_labels: Record<Quadrant, string>;
      quadrant_titles: Record<string, string>;
      algorithm_version: string;
      agent_mode: string;
      agent_mode_label: string;
      supported_commands: { command: string; example: string; description_zh: string }[];
      default_actor_id: string;
      actors: (Actor & { display_name_zh: string })[];
    }>('/meta'),

  // ── tasks ───────────────────────────────────────────────────────────────────
  listTasks: (params: Record<string, string> = {}) => {
    const query = new URLSearchParams(params).toString();
    return request<{ tasks: (TaskWithMatrix & { available_actions: TaskAction[] })[] }>(
      `/tasks${query ? `?${query}` : ''}`,
    );
  },

  getTask: (id: string) => request<TaskDetail>(`/tasks/${id}`),

  deleteTask: (id: string, expected_version: number) =>
    request<{ deleted_task_id: string; removed_dependency_task_ids: string[] }>(`/tasks/${id}`, {
      method: 'DELETE',
      body: { expected_version },
      idempotency: 'task-delete',
    }),

  createTask: (body: CreateTaskInput) =>
    request<{ task: Task }>('/tasks', { method: 'POST', body, idempotency: 'task-create' }),

  updateTask: (id: string, body: Partial<CreateTaskInput> & { expected_version?: number }) =>
    request<{ task: Task }>(`/tasks/${id}`, {
      method: 'PATCH',
      body,
      idempotency: 'task-update',
    }),

  taskAction: (
    id: string,
    action: TaskAction,
    extra: { actor_id?: string; reason?: string; expected_version?: number } = {},
  ) =>
    request<{ task: Task }>(`/tasks/${id}/actions`, {
      method: 'POST',
      body: { action, ...extra },
      idempotency: `task-${action}`,
    }),

  addDependency: (id: string, depends_on_id: string) =>
    request<{ task: Task }>(`/tasks/${id}/dependencies`, {
      method: 'POST',
      body: { depends_on_id },
      idempotency: 'task-dep',
    }),

  // ── quadrant ────────────────────────────────────────────────────────────────
  confirmQuadrant: (id: string) =>
    request<{ task: Task }>(`/tasks/${id}/quadrant/confirm`, {
      method: 'POST',
      body: {},
      idempotency: 'quadrant-confirm',
    }),

  changeQuadrant: (id: string, quadrant: Quadrant, reason?: string) =>
    request<{ task: Task }>(`/tasks/${id}/quadrant/change`, {
      method: 'POST',
      body: { quadrant, reason },
      idempotency: 'quadrant-change',
    }),

  resuggestQuadrant: (id: string) =>
    request<{ task: Task }>(`/tasks/${id}/quadrant/resuggest`, {
      method: 'POST',
      body: {},
      idempotency: 'quadrant-resuggest',
    }),

  // ── goals ───────────────────────────────────────────────────────────────────
  listGoals: () => request<{ goals: GoalWithProgress[] }>('/goals'),

  getGoal: (id: string) => request<{ goal: GoalWithProgress; tasks: Task[] }>(`/goals/${id}`),

  deleteGoal: (id: string, expected_version: number) =>
    request<{ deleted_goal_id: string; deleted_task_ids: string[] }>(`/goals/${id}`, {
      method: 'DELETE',
      body: { expected_version },
      idempotency: 'goal-delete',
    }),

  createGoal: (body: { title: string; description?: string; target_date?: string }) =>
    request<{ goal: Goal }>('/goals', { method: 'POST', body, idempotency: 'goal-create' }),

  updateGoal: (
    id: string,
    body: {
      title?: string;
      description?: string;
      status?: Goal['status'];
      target_date?: string;
      expected_version?: number;
    },
  ) => request<{ goal: Goal }>(`/goals/${id}`, { method: 'PATCH', body, idempotency: 'goal-update' }),

  previewDecomposition: (id: string) =>
    request<{ preview: DecompositionPreview }>(`/goals/${id}/decomposition/preview`, {
      method: 'POST',
      body: {},
    }),

  confirmDecomposition: (
    id: string,
    preview_token: string,
    accepted?: { index: number; title: string; description?: string | null }[],
  ) =>
    request<{ goal: Goal; tasks: Task[] }>(`/goals/${id}/decomposition/confirm`, {
      method: 'POST',
      body: { preview_token, accepted_drafts: accepted },
      idempotency: 'goal-decompose',
    }),

  // ── queue ───────────────────────────────────────────────────────────────────
  queue: () => request<QueueResponse>('/queue'),

  recalculate: (reason?: string) =>
    request<{ queue: QueueResponse }>('/queue/recalculate', {
      method: 'POST',
      body: { reason },
      idempotency: 'queue-recalc',
    }),

  explain: (id: string) => request<ExplainResponse>(`/queue/explain/${id}`),

  // ── activity ────────────────────────────────────────────────────────────────
  activity: (filters: ActivityFilters = {}) => {
    const query = buildActivityQuery(filters);
    return request<ActivityResponse>(`/activity${query ? `?${query}` : ''}`);
  },

  // ── habits ──────────────────────────────────────────────────────────────────
  habits: () => request<HabitsResponse>('/habits'),

  addHabit: (body: { statement: string; kind?: string }) =>
    request<{ habit: HabitEntry; habits: HabitsResponse }>('/habits', {
      method: 'POST',
      body,
      idempotency: 'habit-add',
    }),

  setHabitEnabled: (file: 'explicit' | 'inferred', id: string, enabled: boolean) =>
    request<{ habit: HabitEntry; habits: HabitsResponse }>('/habits/enabled', {
      method: 'POST',
      body: { file, id, enabled },
      idempotency: 'habit-toggle',
    }),

  setWeights: (weights: Partial<ScoringWeights>) =>
    request<{ weights: ScoringWeights; habits: HabitsResponse }>('/habits/weights', {
      method: 'POST',
      body: weights,
      idempotency: 'habit-weights',
    }),

  // ── agent ───────────────────────────────────────────────────────────────────
  sendMessage: (
    message: string,
    session_id?: string,
    target?: { task_id?: string; goal_id?: string },
  ) =>
    request<AgentMessageResponse>('/agent/message', {
      method: 'POST',
      body: {
        message,
        session_id,
        ...(target?.task_id ? { target_task_id: target.task_id } : {}),
        ...(target?.goal_id ? { target_goal_id: target.goal_id } : {}),
      },
      idempotency: 'agent-msg',
    }),

  confirmAction: (
    token: string,
    session_id?: string,
    accepted_drafts?: { index: number; title: string; description?: string | null }[],
  ) =>
    request<AgentMessageResponse>(previewActionPath(token, 'confirm'), {
      method: 'POST',
      body: { token, session_id, ...(accepted_drafts ? { accepted_drafts } : {}) },
      idempotency: 'agent-confirm',
    }),

  cancelAction: (token: string, session_id?: string) =>
    request<AgentMessageResponse>(previewActionPath(token, 'cancel'), {
      method: 'POST',
      body: { token, session_id },
      idempotency: 'agent-cancel',
    }),

  agentSessions: (options?: {cursor?:string;limit?:number}) => {
    const query=new URLSearchParams();
    if(options?.cursor)query.set('cursor',options.cursor);
    if(options?.limit)query.set('limit',String(options.limit));
    return request<{sessions:AgentSession[];next_cursor?:string|null}>('/agent/sessions'+(query.size?'?'+query.toString():''));
  },

  agentSession: (id: string) =>
    request<{ session: AgentSession; messages: AgentMessage[]; disabled_tokens?:string[] }>(`/agent/sessions/${encodeURIComponent(id)}`),
};
