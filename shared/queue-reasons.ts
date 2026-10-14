/**
 * 「为什么这个任务排在这里」的纯函数（UX-14）。
 *
 * 队列卡片默认只露 N 条最关键理由（按 |贡献| 排序），完整评分依据仍在统一
 * 详情抽屉 / 展开面板里。抽到 shared 便于在 node:test 里静态断言。
 */
import type { ScoreBreakdown, ScoreFactor } from './types';

/** 可忽略的零贡献阈值（浮点抖动）。 */
const EPSILON = 1e-9;

/**
 * 选出最能解释排序名次的 N 条因子。
 *
 * 按 |contribution| 降序：既覆盖「把它顶上来的正贡献」，也覆盖「把它压下去的
 * 负贡献」——两者都是读者最该先看到的理由。零贡献因子不出现在短理由里。
 */
export function topReasonFactors(
  breakdown: ScoreBreakdown,
  limit = 2,
): ScoreFactor[] {
  return breakdown.factors
    .filter((factor) => Math.abs(factor.contribution) > EPSILON)
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
    .slice(0, Math.max(0, limit));
}

/**
 * 把一条因子压成一句短理由（不超过一行），例如「截止紧迫 +2.30」。
 * 负贡献自动带负号，方便读者区分「加分项 / 减分项」。
 */
export function reasonSummary(factor: ScoreFactor): string {
  const signed = `${factor.contribution > 0 ? '+' : ''}${factor.contribution.toFixed(1)}`;
  return `${factor.label} ${signed}`;
}
