/**
 * 任务耗时的「数值 + 单位」换算。
 *
 * 唯一的耗时事实仍然是 `tasks.estimated_minutes`（分钟，INTEGER）——队列评分、
 * effort factor 一律只读它。本模块负责把用户选的单位（分钟/天/月）按**个人习惯
 * 配置**折算成分钟，`duration_value`/`duration_unit` 只是原始输入的留档，供回显
 * 时按用户当初选的单位显示。
 *
 * 换算是纯算术，不涉及日期，所以与时区完全无关。
 *
 * 运行时值模块（与 `shared/types.ts` 的纯类型定位相反）：前端、后端、Skill 都
 * 直接 import 这里的常量与函数，避免三处各写一份换算。
 */
import type { DurationUnit } from './types.ts';

/** 单位的中文展示名。界面下拉与换算摘要都用它。 */
export const DURATION_UNIT_LABELS_ZH = {
  minute: '分钟',
  day: '天',
  month: '月',
} as const;

/** 默认每天工作 8 小时。 */
export const DEFAULT_HOURS_PER_DAY = 8;
/** 默认每月工作 20 天。 */
export const DEFAULT_DAYS_PER_MONTH = 20;

/**
 * 合理范围（zod 与文档同步这两组边界）：
 * - `hours_per_day` ∈ [0.5, 24]：半小时是最小有意义的工作日，24 小时是物理上限。
 * - `days_per_month` ∈ [1, 31]：至少一天，最多一个自然月的天数。
 */
export const HOURS_PER_DAY_MIN = 0.5;
export const HOURS_PER_DAY_MAX = 24;
export const DAYS_PER_MONTH_MIN = 1;
export const DAYS_PER_MONTH_MAX = 31;

/** 换算所需的个人习惯配置（存在 `habits/weights.json` 的 payload 里）。 */
export interface DurationConfig {
  hours_per_day: number;
  days_per_month: number;
}

export const DEFAULT_DURATION_CONFIG: DurationConfig = {
  hours_per_day: DEFAULT_HOURS_PER_DAY,
  days_per_month: DEFAULT_DAYS_PER_MONTH,
};

/**
 * 把「数值 + 单位」折算成分钟整数。
 *
 * - minute → value
 * - day    → value * hours_per_day * 60
 * - month  → value * days_per_month * hours_per_day * 60
 *
 * `estimated_minutes` 是 INTEGER，所以结果一律 `Math.round`。`value` 必须是有限
 * 正数——非法输入直接抛错，不静默折算成 0，否则队列会把它当「快速任务」加分。
 */
export function durationToMinutes(
  value: number,
  unit: DurationUnit,
  cfg: DurationConfig = DEFAULT_DURATION_CONFIG,
): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`耗时数值必须是正数，收到 ${String(value)}`);
  }
  const hoursPerDay = Number.isFinite(cfg.hours_per_day)
    ? cfg.hours_per_day
    : DEFAULT_HOURS_PER_DAY;
  const daysPerMonth = Number.isFinite(cfg.days_per_month)
    ? cfg.days_per_month
    : DEFAULT_DAYS_PER_MONTH;

  switch (unit) {
    case 'minute':
      return Math.round(value);
    case 'day':
      return Math.round(value * hoursPerDay * 60);
    case 'month':
      return Math.round(value * daysPerMonth * hoursPerDay * 60);
  }
}

/**
 * 一行中文换算摘要，例如：
 * `2 天 ≈ 960 分钟（按 8 小时/天、20 天/月）`
 *
 * minute 单位返回空串——数值本身就是分钟，再解释一遍是噪音。
 */
export function formatDurationSummary(
  value: number,
  unit: DurationUnit,
  cfg: DurationConfig = DEFAULT_DURATION_CONFIG,
): string {
  if (unit === 'minute') return '';
  if (!Number.isFinite(value) || value <= 0) return '';
  const minutes = durationToMinutes(value, unit, cfg);
  return (
    `${trimNumber(value)} ${DURATION_UNIT_LABELS_ZH[unit]} ≈ ${minutes} 分钟` +
    `（按 ${trimNumber(cfg.hours_per_day)} 小时/天、${trimNumber(cfg.days_per_month)} 天/月）`
  );
}

/** 去掉 `2.0` 这类多余小数尾巴，摘要里读起来更像人写的。 */
function trimNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  return String(Math.round(value * 100) / 100);
}
