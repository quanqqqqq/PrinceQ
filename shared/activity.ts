/**
 * Pure helpers behind the activity timeline (UX-19).
 *
 * The activity page used to be an audit table of raw operation rows. It is now
 * a user-facing timeline: each row shows one clear action + object + time, the
 * technical fields (idempotency key, raw event code, detail JSON) are collapsed,
 * and queue recalculation history lives on its own tab.
 *
 * Everything here is derived without React so it can be unit-tested directly;
 * the view maps the enum keys through the label tables in `@/lib/i18n`.
 */
import type { OperationRecord } from './types.ts';

/**
 * Queue recalculation is infrastructure, not a user-facing action. It has its
 * own tab (the snapshot history) so it does not clutter the activity timeline.
 */
export function isQueueRecalcOperation(
  op: Pick<OperationRecord, 'operation_type' | 'target_type'>,
): boolean {
  return op.target_type === 'queue' || op.operation_type === 'queue.recalculate';
}

/** Splits the operation log into the timeline feed and the recalc history. */
export function splitOperations(operations: OperationRecord[]): {
  activities: OperationRecord[];
  recalc: OperationRecord[];
} {
  const activities: OperationRecord[] = [];
  const recalc: OperationRecord[] = [];
  for (const op of operations) {
    (isQueueRecalcOperation(op) ? recalc : activities).push(op);
  }
  return { activities, recalc };
}

/**
 * The openable object an operation points at. Tasks open in the task drawer,
 * goals in the goal panel — both by id, so completed / archived objects open too
 * (the detail endpoints never filter by status).
 */
export type ActivityTarget =
  | { kind: 'task'; id: string }
  | { kind: 'goal'; id: string }
  | { kind: 'none'; id: null };

export function activityTarget(
  op: Pick<OperationRecord, 'target_type' | 'target_id'>,
): ActivityTarget {
  if (op.target_type === 'task' && op.target_id) return { kind: 'task', id: op.target_id };
  if (op.target_type === 'goal' && op.target_id) return { kind: 'goal', id: op.target_id };
  return { kind: 'none', id: null };
}

/** Filters accepted by `GET /api/activity`; empty values are dropped. */
export interface ActivityFilters {
  /** Free-text search over task / goal titles (falls back to the summary). */
  query?: string;
  /** Comma-separated `operation_type` values, e.g. `task.create,goal.create`. */
  type?: string;
  /** Inclusive lower bound on `created_at` (ISO-8601). */
  from?: string;
  /** Inclusive upper bound on `created_at` (ISO-8601). */
  to?: string;
  limit?: number;
}

/** Serialises filters into a querystring, omitting empty / default values. */
export function buildActivityQuery(filters: ActivityFilters = {}): string {
  const params = new URLSearchParams();
  const query = filters.query?.trim();
  if (query) params.set('query', query);
  const type = filters.type?.trim();
  if (type) params.set('type', type);
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  if (filters.limit && filters.limit !== 100) params.set('limit', String(filters.limit));
  const text = params.toString();
  return text;
}

/**
 * Groups newest-first operations by local calendar day for timeline headings.
 * Returns groups in chronological order (newest day first) with the raw local
 * `YYYY-MM-DD` key the view formats however it likes.
 */
export interface ActivityDayGroup {
  /** Local `YYYY-MM-DD` derived from the operation's `created_at`. */
  dayKey: string;
  items: OperationRecord[];
}

function localDayKey(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function groupOperationsByDay(operations: OperationRecord[]): ActivityDayGroup[] {
  const groups: ActivityDayGroup[] = [];
  const index = new Map<string, ActivityDayGroup>();
  for (const op of operations) {
    const dayKey = localDayKey(op.created_at);
    let group = index.get(dayKey);
    if (!group) {
      group = { dayKey, items: [] };
      index.set(dayKey, group);
      groups.push(group);
    }
    group.items.push(op);
  }
  return groups;
}

// ── 「变更详情」：把 detail JSON 翻成业务字段的前后对照 ───────────────────────
//
// `operations.detail` 是为审计写的自由 JSON，不同 operation_type 的键完全不同。
// 时间线上的第一层折叠要回答的却是一个很具体的问题：「这次改了哪个字段，从什么
// 变成了什么」。这里把已知的 detail 形态归一成一组 `ChangeField`，视图只负责按
// before / after 是否存在选渲染模板；认不出来的 detail 一概不进这一层，留给第二
// 层「开发者信息」里的原始 JSON——宁可少说，也不要编一个看着像真的字段名。

/**
 * 一行「字段：修改前 → 修改后」。
 *
 * `before` / `after` 为 null 表示这一侧没有可展示的值：两侧都空就只能说"已修改"
 * （`task.update` 的 `fields` 只记了改过哪些键，没记旧值）。
 */
export interface ChangeField {
  key: string;
  label: string;
  before: string | null;
  after: string | null;
}

/** 状态码 → 中文。与 `@/lib/i18n` 的 STATUS_LABELS 同源，这里独立一份保持纯函数。 */
const STATUS_TEXT: Record<string, string> = {
  inbox: '待处理',
  claimed: '已领取',
  in_progress: '进行中',
  blocked: '受阻',
  completed: '已完成',
  archived: '已归档',
};

/** 象限码 → 中文。 */
const QUADRANT_TEXT: Record<string, string> = {
  q1: '重要且紧急',
  q2: '重要不紧急',
  q3: '不重要但紧急',
  q4: '不重要不紧急',
};

/** `task.update` / `goal.update` 的 `fields` 列表里的字段名 → 中文。 */
const FIELD_LABELS: Record<string, string> = {
  title: '标题',
  description: '说明',
  target_date: '目标日期',
  status: '状态',
  task_type: '任务类型',
  priority: '优先级',
  deadline: '截止时间',
  notes: '备注',
  reason: '原因',
};

/** 认不出的码原样显示，而不是显示成空白。 */
const mapCode = (table: Record<string, string>, value: unknown): string | null =>
  value == null ? null : (table[String(value)] ?? String(value));

/**
 * 把一条操作的 detail 翻成「变更详情」里的字段行。
 *
 * 只认下列形态，其余 detail 键（`idempotency`、`score_source`、`depends_on` 等）
 * 留在开发者信息里：
 *   - `{ from, to }`        状态流转，或 operation_type 带 `quadrant` 时的象限流转
 *   - `{ reason }`          流转/阻塞原因（只有「修改后」一侧）
 *   - `{ fields: [...] }`   更新了哪些字段（旧值没留，两侧都空）
 *   - `{ importance_score | urgency_score }`  两轴评分
 *   - `{ task_ids: [...] }` 一次拆分新建了几个任务
 *   - `{ file }`            习惯类操作写了哪个文件
 */
export function describeOperationChange(op: OperationRecord): ChangeField[] {
  const detail = op.detail;
  if (!detail) return [];
  const changes: ChangeField[] = [];

  // 状态与象限共用 `{ from, to }`：靠 operation_type（或 detail 里的 quadrant 键）
  // 区分是哪一种流转，映射错了会把象限码当状态码显示成乱码。
  if (detail.from != null || detail.to != null) {
    const isQuadrant =
      op.operation_type.includes('quadrant') || typeof detail.quadrant === 'string';
    const table = isQuadrant ? QUADRANT_TEXT : STATUS_TEXT;
    changes.push({
      key: isQuadrant ? 'quadrant' : 'status',
      label: isQuadrant ? '象限' : '状态',
      before: mapCode(table, detail.from),
      after: mapCode(table, detail.to),
    });
  }

  if (typeof detail.reason === 'string' && detail.reason.trim()) {
    changes.push({ key: 'reason', label: '原因', before: null, after: String(detail.reason) });
  }

  // `fields` 只记了改过哪些键，没记前后值——渲染成"标题：已修改"。
  if (Array.isArray(detail.fields)) {
    for (const field of detail.fields) {
      if (typeof field !== 'string') continue;
      changes.push({
        key: field,
        label: FIELD_LABELS[field] ?? field,
        before: null,
        after: null,
      });
    }
  }

  if (detail.importance_score != null) {
    changes.push({
      key: 'importance',
      label: '重要度',
      before: null,
      after: String(detail.importance_score),
    });
  }
  if (detail.urgency_score != null) {
    changes.push({
      key: 'urgency',
      label: '紧急度',
      before: null,
      after: String(detail.urgency_score),
    });
  }

  if (Array.isArray(detail.task_ids)) {
    changes.push({
      key: 'task_count',
      label: '新建任务',
      before: null,
      after: String(detail.task_ids.length),
    });
  }

  if (typeof detail.file === 'string') {
    changes.push({ key: 'habit_file', label: '习惯文件', before: null, after: detail.file });
  }

  return changes;
}

// ── 「排序说明」：把快照的 reason 翻成「为什么又排了一次」 ─────────────────────
//
// `withOperation` 每做完一次写操作都会 `refreshQueue(db, operation_type)`，所以
// `queue_snapshots.reason` 存的其实就是事件码本身（`task.create`、`goal.update`、
// `queue.recalculate` …）。重算页签过去直接把它铺在主标题上，用户看到的是一串英文
// 事件码。这里按事件码反推触发场景，给出一句中文说明；事件码本身留给「开发者信息」。

/** 一条快照的「为什么重排」。 */
export interface QueueSortNote {
  /** 触发原因的中文说明，例如「创建任务后自动重排」。 */
  triggerLabel: string;
  /** true = 用户手动触发（manual-recalculate / manual-ui / seed / migration）；false = 写操作后自动重排。 */
  manual: boolean;
}

/** `task.<action>` 里的动作码 → 中文动作名。认不出的 action 走通用兜底。 */
const TASK_ACTION_TEXT: Record<string, string> = {
  create: '创建任务',
  update: '修改任务',
  claim: '领取任务',
  start: '开始任务',
  complete: '完成任务',
  archive: '归档任务',
  restore: '恢复任务',
  block: '标记受阻',
  release: '释放任务',
  reopen: '重新打开任务',
};

/** 多段事件码直接整条匹配，避免被 `task.<action>` 规则截成 `quadrant` 这种半截动作。 */
const EXACT_TRIGGER_TEXT: Record<string, string> = {
  'task.matrix.score': '记录评分后自动重排',
  'task.dependency.add': '添加依赖后自动重排',
  'goal.decomposition.confirm': '拆分目标后自动重排',
};

/** 写操作能认出前缀、认不出具体动作时的说法。 */
const FALLBACK_WRITE_LABEL = '写操作后自动重排';

/**
 * 把快照的 reason 翻成一句中文排序说明。
 *
 * 手动一侧（`manual: true`）是用户或运维自己按下的：手动重算、初始化示例数据、
 * 数据迁移；其余都是某次写操作顺带触发的自动重排。完全认不出的 reason 只说
 * 「队列排序已刷新」——宁可说得笼统，也不要猜一个看着像真的触发场景。
 */
export function describeQueueSnapshot(reason: string | null | undefined): QueueSortNote {
  const code = reason?.trim() ?? '';
  if (!code) return { triggerLabel: '队列排序已刷新', manual: false };

  if (code === 'seed') return { triggerLabel: '初始化示例数据时建立排序', manual: true };
  if (code === 'migration') return { triggerLabel: '数据迁移后重建排序', manual: true };
  if (code === 'manual-recalculate' || code === 'manual-ui' || code === 'queue.recalculate') {
    return { triggerLabel: '你手动触发了重排', manual: true };
  }

  const exact = EXACT_TRIGGER_TEXT[code];
  if (exact) return { triggerLabel: exact, manual: false };

  if (code.startsWith('task.quadrant.')) {
    return { triggerLabel: '调整象限后自动重排', manual: false };
  }
  if (code.startsWith('task.')) {
    const action = TASK_ACTION_TEXT[code.slice('task.'.length)];
    return {
      triggerLabel: action ? `「${action}」后自动重排` : FALLBACK_WRITE_LABEL,
      manual: false,
    };
  }
  if (code.startsWith('goal.')) return { triggerLabel: '目标变更后自动重排', manual: false };
  if (code.startsWith('habit.')) return { triggerLabel: '习惯调整后自动重排', manual: false };

  return { triggerLabel: '队列排序已刷新', manual: false };
}
