/**
 * `/matrix` 响应式布局的纯函数（与 React / DOM 解耦，便于单测）。
 *
 * 移动端（< md）与桌面端（>= md）共用同一份筛选与统计：
 * - 桌面：散点图在上、四列横向并排，一次看全部分布；
 * - 手机：默认先看「按象限任务列表」，散点图放进二级页签，四个象限用
 *   标签切换，单象限一列竖排，不需要左右横滑。
 *
 * 这里只决定「默认落到哪个象限 / 移动端页签语义」，不复制统计口径——
 * 统计永远来自 `matrixStats(visible)`，与桌面四列同源。
 */
import type { Quadrant } from '@shared/types';

/** 四象限固定顺序，列表、页签、统计条都按它排。 */
export const QUADRANT_ORDER: Quadrant[] = ['q1', 'q2', 'q3', 'q4'];

/** 移动端两个页签：列表（默认）与散点图。 */
export type MobileMatrixView = 'list' | 'chart';

/**
 * 手机端默认选中的象限：落在任务最多的那一列，打开就能看到内容；
 * 四列都空时退回 q1，避免选中一个看不见东西的象限。
 */
export function pickDefaultQuadrant(
  counts: Record<Quadrant, number>,
): Quadrant {
  let best: Quadrant = 'q1';
  let bestCount = -1;
  for (const quadrant of QUADRANT_ORDER) {
    if (counts[quadrant] > bestCount) {
      bestCount = counts[quadrant];
      best = quadrant;
    }
  }
  return best;
}
