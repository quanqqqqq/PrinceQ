/**
 * 纯展示标签常量：象限、任务状态、生命周期动作、队列快照原因。
 *
 * 放在 shared/ 是因为操作记录的中文摘要要「展示与后端搜索同源」：界面渲染时间线
 * 要用它，`listOperations` 的中文摘要搜索也要用它。shared 不反向依赖 src，所以
 * 这些常量必须住在这里，由 `src/lib/i18n.ts` 再导出给界面层。
 *
 * 只收录系统自己写死的枚举文案；用户录入的标题、描述永不进表。
 */
import type { Quadrant, TaskAction, TaskStatus } from './types.ts';

export const QUADRANT_TITLES: Record<Quadrant, string> = {
  q1: '重要且紧急',
  q2: '重要不紧急',
  q3: '不重要但紧急',
  q4: '不重要不紧急',
};

export const STATUS_LABELS: Record<TaskStatus, string> = {
  inbox: '待处理',
  claimed: '已领取',
  in_progress: '进行中',
  blocked: '受阻',
  completed: '已完成',
  archived: '已归档',
};

export const ACTION_LABELS: Record<TaskAction, string> = {
  claim: '领取',
  release: '释放',
  start: '开始',
  block: '标记受阻',
  unblock: '解除受阻',
  complete: '完成',
  archive: '归档',
  restore: '恢复',
  reopen: '重新打开',
};

/** 队列快照的 `reason` 字段是固定的内部标识。 */
export const SNAPSHOT_REASON_LABELS: Record<string, string> = {
  seed: '初始化示例数据',
  'manual-ui': '手动重算（网页）',
  migration: '数据迁移',
};

/** 认不出来的 key 原样返回，空值返回空串。 */
export const snapshotReasonLabel = (reason: string | null | undefined): string =>
  (reason && SNAPSHOT_REASON_LABELS[reason]) || reason || '';
