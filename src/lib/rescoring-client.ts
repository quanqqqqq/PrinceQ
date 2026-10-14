/**
 * 复评请求的薄 fetch 封装。
 *
 * 为什么不放进 `src/lib/api.ts`：那个文件是全站共用的契约层，而复评的五条路由
 * 正由另一条线接入 `server/http/routes.ts`。把它们暂时放在这里，面板就能先按最终
 * 契约写完、测完，等路由落地后再整体并回 `api`，期间不会因为两边时序不同步而互相
 * 阻塞。错误类型沿用 `ApiRequestError`，所以 `useMutation`/`WriteError` 那套既有的
 * 中文报错展示一个字都不用改。
 *
 * **这里一行都不产生分数。** 所有分数要么来自真实外部 Agent 的 submit，要么是请求
 * 创建时的快照原值；本模块只负责把它们搬运给界面。
 */
import type { Quadrant, Task } from '@shared/types';
import { ApiRequestError } from '@/lib/api';

/** 复评可以请求重评的轴。与后端 `RescoringAxis` 同构。 */
export type RescoringAxis = 'importance' | 'urgency';

export type RescoringStatus = 'pending' | 'awaiting_confirm' | 'done' | 'cancelled';

/**
 * 面板要渲染的一条复评请求。
 *
 * `before_*` 是请求创建那一刻的快照，`after_*` 是 Agent 建议合并后的结果——两者
 * 分开存，面板才能逐轴显示「30 → 72」，并把未请求的轴标成「原样保留」。
 * `pending` 阶段 `after_*` 必然是 `null`：那时还没有任何真实建议，界面也绝不该
 * 显示一个数字。
 */
export interface RescoringRequestView {
  id: string;
  task_id: string;
  status: RescoringStatus;
  /** 用户当初想拖到的象限；派生象限仍由确认时的两轴分数算出，不从它反推。 */
  target_quadrant: Quadrant | null;
  changed_axes: RescoringAxis[];
  before_importance: number | null;
  before_urgency: number | null;
  after_importance: number | null;
  after_urgency: number | null;
  reason: string | null;
  confidence: number | null;
  agent_name: string | null;
  expected_version: number;
  created_at: string;
  submitted_at: string | null;
  decided_at: string | null;
}

/** 交给外部 Agent 的上下文：全部是读出来的事实，没有一处是生成的判断。 */
export interface RescoringContextView {
  task: Task;
  goal_title: string | null;
  depends_on: { id: string; title: string; status: string }[];
  habits_summary: string;
}

/** 列表返回里每条请求可以附带它的上下文，省掉面板再发一次请求。 */
export type RescoringRequestWithContext = RescoringRequestView & {
  context?: RescoringContextView | null;
};

/** 每次写操作带一个，重试不会写入两次。 */
const newIdempotencyKey = (prefix: string): string =>
  `ui-${prefix}-${crypto.randomUUID().slice(0, 18)}`;

interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  /** 给了前缀就带上 `Idempotency-Key` 头。 */
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
    const error = (payload as { error?: { code?: string; message?: string; details?: unknown } } | null)
      ?.error;
    throw new ApiRequestError(
      response.status,
      error?.code ?? 'unknown',
      error?.message ?? `本地 API 返回状态码 ${response.status}。`,
      error?.details,
    );
  }
  return payload as T;
}

export const rescoringClient = {
  /**
   * 发起复评。`target_quadrant` 与 `changed_axes` 至少给一个：只给前者时后端
   * 用 `axesMismatchingQuadrant` 算出真正跨线的轴，已经在目标那一侧的轴不动。
   */
  create: (
    taskId: string,
    body: { target_quadrant?: Quadrant; changed_axes?: RescoringAxis[] },
  ) =>
    request<{ request: RescoringRequestWithContext }>(`/tasks/${taskId}/rescoring-request`, {
      method: 'POST',
      body,
      idempotency: 'rescore-create',
    }),

  list: (status?: RescoringStatus) =>
    request<{ requests: RescoringRequestWithContext[] }>(
      `/rescoring-requests${status ? `?status=${status}` : ''}`,
    ),

  /**
   * 外部 Agent 提交建议。面板**不**调用它——网页没有真实语言模型，界面里也不该
   * 出现让用户自己填分数的输入框。留在这里是为了契约完整、以及 Agent 侧复用。
   */
  submit: (
    requestId: string,
    body: {
      importance_score?: number;
      urgency_score?: number;
      reason: string;
      confidence?: number;
      agent_name: string;
    },
  ) =>
    request<{ request: RescoringRequestView }>(`/rescoring-requests/${requestId}/submit`, {
      method: 'POST',
      body,
      idempotency: 'rescore-submit',
    }),

  /** 用户点「确认保存」——整个流程里唯一会写 `tasks` 的一步。 */
  confirm: (requestId: string) =>
    request<{ request: RescoringRequestView; task: Task }>(
      `/rescoring-requests/${requestId}/confirm`,
      { method: 'POST', body: {}, idempotency: 'rescore-confirm' },
    ),

  cancel: (requestId: string) =>
    request<{ request: RescoringRequestView }>(`/rescoring-requests/${requestId}/cancel`, {
      method: 'POST',
      body: {},
      idempotency: 'rescore-cancel',
    }),
};
