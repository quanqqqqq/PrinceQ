/**
 * 首页「队列」视图的三种分组方式（纯函数，无 React、无副作用）。
 *
 * 分组 **只是视觉分组**：组内条目顺序一律沿用调用方传进来的原始顺序（队列视图里
 * 就是按 `position` 升序的原数组顺序），不重排、不重算分数、不产生任何百分比。
 * 进度展示仍然由卡片自己的状态徽章负责。
 *
 * 三种模式：
 * - `priority` — 当前扁平列表的行为，整个数组就是唯一一组；
 * - `quadrant` — 按 `task.quadrant` 分组，组序固定 q1→q2→q3→q4，无象限的落到末尾
 *   的「未分类」组；
 * - `status`   — 按 `task.status` 分组，组序固定 TASK_STATUSES（inbox→…→archived）。
 *
 * 空组一律不返回，所以调用方直接 map 即可，不必再过滤。
 *
 * 标签取自中文词典 `shared/labels.ts`——`./i18n.ts` 与 `@/lib/format` 导出的
 * `QUADRANT_TITLES` / `STATUS_LABELS` 都是从这里 re-export 的同一份常量。这里直接
 * 走相对路径取源头，而不是经由 `./i18n.ts` 或 `@/lib/format`，是为了让本模块能被
 * `node:test` 直接加载：那两个模块里有运行时的 `@shared/*` 别名导入，只有 Vite /
 * tsc 认得，Node 解析不了。顺序常量同理从 `shared/types.ts` 相对导入。
 *
 * 所以本模块内不得出现任何 `@shared/...` 形式的导入（含 type-only），保持可被
 * Node 直接解析。
 */
import { QUADRANTS, TASK_STATUSES } from '../../shared/types.ts';
import type { Quadrant, TaskStatus } from '../../shared/types.ts';
import { QUADRANT_TITLES, STATUS_LABELS } from '../../shared/labels.ts';

/** 分组方式。`priority` 是默认值，等价于不分组。 */
export type HomeGroupMode = 'priority' | 'quadrant' | 'status';

/** 分组只需要读这两个字段，所以直接接受任何结构兼容的任务对象。 */
export interface HomeGroupableTask {
  status: TaskStatus;
  quadrant: Quadrant | null;
}

/** 一组条目：`key` 稳定可作 React key，`label` 已是中文展示文案。 */
export interface HomeGroup<T> {
  key: string;
  label: string;
  items: T[];
}

/** 无象限任务归到这一组，固定排在四个象限之后。 */
export const UNCLASSIFIED_GROUP_KEY = 'unclassified';

/** 「优先顺序」模式下那唯一一组的 key。 */
export const PRIORITY_GROUP_KEY = 'priority';

export const HOME_GROUP_MODE_LABELS: Record<HomeGroupMode, string> = {
  priority: '优先顺序',
  quadrant: '轻重缓急',
  status: '任务状态',
};

const UNCLASSIFIED_LABEL = '未分类';

/** 象限分组的固定组序：q1..q4，然后是「未分类」。 */
const QUADRANT_GROUP_KEYS: string[] = [...QUADRANTS, UNCLASSIFIED_GROUP_KEY];

const isQuadrant = (value: unknown): value is Quadrant =>
  QUADRANTS.includes(value as Quadrant);

/** 认不出来的象限值（含 null）一律当作未分类，不让脏数据把分组弄丢。 */
const quadrantGroupKey = (task: HomeGroupableTask): string =>
  isQuadrant(task.quadrant) ? task.quadrant : UNCLASSIFIED_GROUP_KEY;

const quadrantGroupLabel = (key: string): string =>
  isQuadrant(key) ? QUADRANT_TITLES[key] : UNCLASSIFIED_LABEL;

/**
 * 按固定组序把条目分到各组，保留每组内的原始相对顺序，并丢掉空组。
 *
 * 组序由 `orderedKeys` 决定（而不是由数据出现的先后决定），所以同一份数据在任何
 * 筛选下都得到同样稳定的组顺序。
 */
function groupByFixedOrder<T>(
  items: readonly T[],
  orderedKeys: readonly string[],
  keyOf: (item: T) => string,
  labelOf: (key: string) => string,
): HomeGroup<T>[] {
  const buckets = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(item);
    else buckets.set(key, [item]);
  }
  return orderedKeys
    .filter((key) => (buckets.get(key)?.length ?? 0) > 0)
    .map((key) => ({ key, label: labelOf(key), items: buckets.get(key)! }));
}

/**
 * 把条目数组按 `mode` 分组。
 *
 * `taskOf` 负责从条目里取出任务本体——队列条目是 `{ position, score, task }`，
 * 「全部任务」里条目本身就是任务，所以这层由调用方决定。
 *
 * 返回值永远按固定组序排列、不含空组；输入为空时返回空数组（包括 `priority`
 * 模式，调用方此时该渲染空状态而不是一个空分组）。
 */
export function groupHomeItems<T>(
  items: readonly T[],
  mode: HomeGroupMode,
  taskOf: (item: T) => HomeGroupableTask,
): HomeGroup<T>[] {
  if (items.length === 0) return [];

  if (mode === 'quadrant') {
    return groupByFixedOrder(
      items,
      QUADRANT_GROUP_KEYS,
      (item) => quadrantGroupKey(taskOf(item)),
      quadrantGroupLabel,
    );
  }

  if (mode === 'status') {
    return groupByFixedOrder(
      items,
      TASK_STATUSES,
      (item) => taskOf(item).status,
      (key) => STATUS_LABELS[key as TaskStatus] ?? key,
    );
  }

  // priority：不分组，整条队列就是唯一一组，顺序与输入完全一致。
  return [
    {
      key: PRIORITY_GROUP_KEY,
      label: HOME_GROUP_MODE_LABELS.priority,
      items: [...items],
    },
  ];
}
