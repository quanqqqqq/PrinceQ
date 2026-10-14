/**
 * Pure helpers behind the goal detail panel's linked-task list.
 *
 * The panel shows the tasks that point at a goal, a breakdown by status / type /
 * quadrant above the list, and three combinable filters. All of that is derived
 * here so it can be unit-tested without React:
 *
 * - `goalTaskBreakdown` counts the tasks per status, per task type and per
 *   quadrant (unscored tasks land in an explicit `unscored` bucket rather than
 *   being dropped),
 * - `filterGoalTasks` applies the three filters as an AND and reports both the
 *   matched count and the total, so the view can say "当前 X / 共 Y".
 *
 * Covered by `tests/goal-task-filter.test.ts`.
 *
 * No formatting and no translation: the view maps the enum keys through the
 * existing label tables in `@/lib/i18n`.
 */
import type { Quadrant, TaskStatus, TaskType } from './types.ts';
import { QUADRANTS, TASK_STATUSES, TASK_TYPES } from './types.ts';
import { resolveMatrixPlacement, type MatrixTaskLike } from './matrix-view.ts';

/** The minimum shape the filters and the breakdown read. */
export interface GoalTaskLike extends MatrixTaskLike {
  status: TaskStatus;
  task_type?: TaskType | null;
}

/** Sentinel for "全部" — kept out of the enum so the API values stay untouched. */
export const GOAL_FILTER_ALL = 'all';

/** Quadrant filter: the four quadrants, or the tasks that carry no score yet. */
export const GOAL_QUADRANT_FILTER_UNSCORED = 'unscored';

export type GoalStatusFilter = typeof GOAL_FILTER_ALL | TaskStatus;
export type GoalTypeFilter = typeof GOAL_FILTER_ALL | TaskType | 'none';
export type GoalQuadrantFilter =
  | typeof GOAL_FILTER_ALL
  | Quadrant
  | typeof GOAL_QUADRANT_FILTER_UNSCORED;

export interface GoalTaskFilters {
  status: GoalStatusFilter;
  type: GoalTypeFilter;
  quadrant: GoalQuadrantFilter;
}

export const DEFAULT_GOAL_TASK_FILTERS: GoalTaskFilters = {
  status: GOAL_FILTER_ALL,
  type: GOAL_FILTER_ALL,
  quadrant: GOAL_FILTER_ALL,
};

/**
 * Which quadrant bucket a task falls into for filtering and counting.
 *
 * Derived from the continuous scores via `resolveMatrixPlacement`, exactly like
 * the `/matrix` columns — never from the stored `quadrant` column, so the two
 * views can never disagree.
 */
export function goalTaskQuadrantBucket(
  task: GoalTaskLike,
): Quadrant | typeof GOAL_QUADRANT_FILTER_UNSCORED {
  const placement = resolveMatrixPlacement(task);
  return placement ? placement.quadrant : GOAL_QUADRANT_FILTER_UNSCORED;
}

/** Does one task pass all three filters? Unset filters pass everything. */
export function goalTaskMatches(task: GoalTaskLike, filters: GoalTaskFilters): boolean {
  if (filters.status !== GOAL_FILTER_ALL && task.status !== filters.status) return false;

  if (filters.type !== GOAL_FILTER_ALL) {
    const type = task.task_type ?? null;
    if (filters.type === 'none') {
      if (type != null) return false;
    } else if (type !== filters.type) {
      return false;
    }
  }

  if (filters.quadrant !== GOAL_FILTER_ALL && goalTaskQuadrantBucket(task) !== filters.quadrant) {
    return false;
  }

  return true;
}

export interface GoalTaskFilterResult<T> {
  /** The tasks that passed every filter, in the input order. */
  tasks: T[];
  /** `tasks.length` — the "当前" number. */
  matched: number;
  /** Size of the unfiltered input — the "共" number. */
  total: number;
  /** True when filters are active but nothing matched: show the empty state. */
  emptyBecauseFiltered: boolean;
}

/** True when at least one of the three filters is narrowing the list. */
export const hasActiveGoalTaskFilters = (filters: GoalTaskFilters): boolean =>
  filters.status !== GOAL_FILTER_ALL ||
  filters.type !== GOAL_FILTER_ALL ||
  filters.quadrant !== GOAL_FILTER_ALL;

/**
 * Applies the three filters as a conjunction.
 *
 * Generic over the task type so the caller keeps its richer objects (with
 * `available_actions` etc.) and can still hand them straight to `TaskCard`.
 */
export function filterGoalTasks<T extends GoalTaskLike>(
  tasks: T[],
  filters: GoalTaskFilters,
): GoalTaskFilterResult<T> {
  const matched = tasks.filter((task) => goalTaskMatches(task, filters));
  return {
    tasks: matched,
    matched: matched.length,
    total: tasks.length,
    // An empty goal is a different situation from "filtered everything out".
    emptyBecauseFiltered:
      matched.length === 0 && tasks.length > 0 && hasActiveGoalTaskFilters(filters),
  };
}

// ── 选中条件的可移除 chips ───────────────────────────────────────────────────

/** 一个正在生效的筛选维度。`value` 是原样的筛选值，不做任何翻译。 */
export interface ActiveGoalTaskFilter {
  dimension: 'status' | 'type' | 'quadrant';
  value: string;
}

/**
 * 列出当前生效的筛选维度，供视图渲染成可逐个移除的 chips。
 *
 * 只收「非全部」的维度：`type === 'none'`（未指定类型）和
 * `quadrant === 'unscored'`（待评分）都是真实的筛选值，和 `GOAL_FILTER_ALL`
 * 不是一回事，所以照样算选中。
 *
 * 维度顺序固定为 状态 → 类型 → 象限，和筛选行的排列一致；中文文案由视图层用
 * 既有的 label 表自己映射，这里只给 key。
 */
export function describeActiveGoalTaskFilters(
  filters: GoalTaskFilters,
): ActiveGoalTaskFilter[] {
  const active: ActiveGoalTaskFilter[] = [];
  if (filters.status !== GOAL_FILTER_ALL) {
    active.push({ dimension: 'status', value: filters.status });
  }
  if (filters.type !== GOAL_FILTER_ALL) {
    active.push({ dimension: 'type', value: filters.type });
  }
  if (filters.quadrant !== GOAL_FILTER_ALL) {
    active.push({ dimension: 'quadrant', value: filters.quadrant });
  }
  return active;
}

// ── breakdown above the list ────────────────────────────────────────────────

/** One counted bucket. `count` is over the **unfiltered** linked tasks. */
export interface GoalTaskCount<K extends string> {
  key: K;
  count: number;
}

export interface GoalTaskBreakdown {
  total: number;
  /** Only the statuses actually present, in the canonical enum order. */
  byStatus: GoalTaskCount<TaskStatus>[];
  /** Task types present; `none` collects the tasks with no type set. */
  byType: GoalTaskCount<TaskType | 'none'>[];
  /** Quadrants present; `unscored` collects the tasks with no usable score. */
  byQuadrant: GoalTaskCount<Quadrant | typeof GOAL_QUADRANT_FILTER_UNSCORED>[];
}

/** Counts into a map, then emits only the non-empty keys in `order`. */
function tally<K extends string>(keys: K[], order: readonly K[]): GoalTaskCount<K>[] {
  const counts = new Map<K, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return order.flatMap((key) => {
    const count = counts.get(key);
    return count ? [{ key, count }] : [];
  });
}

const TYPE_ORDER: readonly (TaskType | 'none')[] = [...TASK_TYPES, 'none'];
const QUADRANT_ORDER: readonly (Quadrant | typeof GOAL_QUADRANT_FILTER_UNSCORED)[] = [
  ...QUADRANTS,
  GOAL_QUADRANT_FILTER_UNSCORED,
];

/**
 * Category counts shown above the linked-task list.
 *
 * Always computed from the **full** linked list, so the numbers stay a stable
 * reference while the filters narrow what is rendered below them.
 */
export function goalTaskBreakdown(tasks: GoalTaskLike[]): GoalTaskBreakdown {
  return {
    total: tasks.length,
    byStatus: tally(
      tasks.map((task) => task.status),
      TASK_STATUSES,
    ),
    byType: tally(
      tasks.map((task): TaskType | 'none' => task.task_type ?? 'none'),
      TYPE_ORDER,
    ),
    byQuadrant: tally(tasks.map(goalTaskQuadrantBucket), QUADRANT_ORDER),
  };
}
