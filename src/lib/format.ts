/** 跨页面复用的展示辅助函数。文案统一来自 `@/lib/i18n`。 */
import type { Task, TaskAction } from '@shared/types';
import {
  formatDeadlineLocal,
  formatLocalDate,
  formatLocalRelative,
  formatLocalTimestamp,
  isOverdueLocal,
} from '@shared/datetime';
import { renderOperationSummaryZh } from '../../shared/activity-summary.ts';
import { ACTION_LABELS, OPERATION_TYPE_LABELS } from '@/lib/i18n';

export {
  ACTION_LABELS,
  AGENT_COMMAND_LABELS,
  COGNITIVE_LOAD_LABELS,
  GOAL_STATUS_LABELS,
  MANUAL_PRIORITY_LABELS,
  MATRIX_SCORE_SOURCE_HINTS,
  MATRIX_SCORE_SOURCE_LABELS,
  OPERATION_STATUS_LABELS,
  QUADRANT_ACTIONS,
  QUADRANT_SUBTITLES,
  QUADRANT_TITLES,
  STATUS_LABELS,
  TASK_TYPE_LABELS,
  agentCommandLabel,
  demoText,
  demoTitle,
  operationTypeLabel,
  snapshotReasonLabel,
  targetTypeLabel,
  translateSystemText,
} from '@/lib/i18n';

/** 中性为主的状态色；只有进行中使用主色强调。 */
export const STATUS_CLASSES: Record<Task['status'], string> = {
  inbox: 'border-border bg-muted/60 text-muted-foreground',
  claimed: 'border-border bg-background text-foreground',
  in_progress: 'border-primary/30 bg-primary/10 text-primary',
  blocked: 'border-amber-300 bg-amber-50 text-amber-700',
  completed: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  archived: 'border-border bg-muted/40 text-muted-foreground',
};

export function formatMinutes(minutes: number | null): string {
  if (minutes == null) return '未估时';
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
}

/** 截止时间的相对描述，逾期单独成一类。 */
export function formatDeadline(deadline: string | null, now = Date.now()): string {
  return formatDeadlineLocal(deadline, { now: new Date(now) });
}

export const isOverdue = (deadline: string | null, now = Date.now()): boolean =>
  isOverdueLocal(deadline, new Date(now));

export function formatDate(iso: string): string {
  return formatLocalDate(iso);
}

/** 时间线的分组标题：坏时间戳退回空串，避免页面抛错。 */
export function formatLocalDateSafe(iso: string): string {
  if (Number.isNaN(new Date(iso).getTime())) return '';
  return formatLocalDate(iso);
}

export function formatTimestamp(iso: string): string {
  return formatLocalTimestamp(iso);
}

export function formatRelative(iso: string, now = Date.now()): string {
  return formatLocalRelative(iso, { now: new Date(now) });
}

/** 等待用户确认助手所给象限的任务。判定本身在 `@shared/matrix-view`。 */
export { needsQuadrantReview } from '@shared/matrix-view';

export const percent = (ratio: number): number => Math.round(ratio * 100);

/** 占比展示：保留一位小数，但整数不拖 `.0`。 */
export function formatRatio(ratio: number): string {
  const value = ratio * 100;
  const rounded = Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}%`;
}

/** 0..100 的矩阵评分：整数直出，小数保留一位。 */
export function formatMatrixScore(score: number): string {
  const rounded = Math.round(score * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

// ── 操作记录的展示转换 ──────────────────────────────────────────────────────

/**
 * `actors.display_name` 的中文展示。
 *
 * seed 写入的三个操作者名字属于系统内容；其它名字（将来可能由用户自定义）原样返回。
 */
export const ACTOR_DISPLAY_NAMES: Record<string, string> = {
  Me: '我',
  'Local Agent (deterministic)': '本地助手（确定性）',
  'Scheduled automation': '定时自动化',
};

export function actorDisplayName(name: string | null | undefined): string {
  if (!name) return '';
  return ACTOR_DISPLAY_NAMES[name.trim()] ?? name;
}

/**
 * 补齐 `OPERATION_TYPE_LABELS` 里没有的真实 `operation_type`。
 *
 * 后端实际写入的是 `task.quadrant.confirm`、`habit.enable` 这类更细的值，
 * i18n 里的映射只覆盖了一部分。
 */
const OPERATION_TYPE_EXTRA: Record<string, string> = {
  'task.quadrant.confirm': '确认象限',
  'task.quadrant.change': '修改象限',
  'task.quadrant.resuggest': '重新推断象限',
  'task.matrix.score': '提交矩阵评分',
  'goal.decomposition.confirm': '确认目标拆分',
  'decomposition.confirm': '确认目标拆分',
  'habit.enable': '启用习惯',
  'habit.disable': '停用习惯',
  'habit.weights.update': '调整评分权重',
};

/** `task.<action>` 的生命周期操作，直接复用动作标签。 */
function taskActionTypeLabel(type: string): string | null {
  const action = /^task\.(\w+)$/.exec(type)?.[1];
  const label = action && ACTION_LABELS[action as TaskAction];
  return label ? `${label}任务` : null;
}

/**
 * `operation_type` 的中文名；`agent.` 前缀统一显示为「助手…」。
 *
 * 认不出来时返回 `null`，由调用方决定是否退回显示技术代码。
 */
export function operationTypeText(type: string): string | null {
  const agentInner = /^agent\.(.+)$/.exec(type)?.[1];
  if (agentInner) {
    const inner = operationTypeText(agentInner);
    return inner ? `助手${inner}` : null;
  }
  return (
    OPERATION_TYPE_LABELS[type] ?? OPERATION_TYPE_EXTRA[type] ?? taskActionTypeLabel(type) ?? null
  );
}

/**
 * `operations.summary` 的中文展示。
 *
 * 渲染规则整套住在 `@shared/activity-summary`——服务端的 /activity 中文搜索要把每条
 * summary 渲染成同样的中文再比对，两边必须同源，所以这里只做转发。
 */
export function operationSummaryText(summary: string | null | undefined): string {
  return renderOperationSummaryZh({ summary });
}
