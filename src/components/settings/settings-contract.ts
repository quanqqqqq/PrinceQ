/**
 * 设置页的纯逻辑层：中文标签表、权重夹取与摘要、换算范围校验，以及
 * 「软移除分组 / 采纳去重 / 未保存判断」这组交互判据。
 *
 * 刻意不引 React——这样 `tests/settings-logic.test.ts` 与
 * `tests/settings-remove-restore.test.ts` 能在 node:test 里直接 import 它，不需要
 * DOM 环境。界面组件只负责把这里的结果渲染出来。
 *
 * kind 一律以英文 key 的形式与后端往来，中文只在这一层做展示映射。
 */
import {
  DAYS_PER_MONTH_MAX,
  DAYS_PER_MONTH_MIN,
  DEFAULT_DURATION_CONFIG,
  HOURS_PER_DAY_MAX,
  HOURS_PER_DAY_MIN,
} from '../../../shared/duration.ts';
import { sameTypePeakHours } from '../../../shared/peak-hours.ts';
import { TASK_TYPE_LABELS } from '../../lib/i18n.ts';
import type {
  ExplicitHabitEntry,
  SettingsWeights,
  WeightsDraft,
  WeightsPayload,
} from '@/lib/settings-client';

/** 明确习惯的 kind → 中文。 */
export const EXPLICIT_KIND_LABELS: Record<string, string> = {
  scheduling: '时间安排',
  batching: '批量处理',
  preference: '个人偏好',
  estimation: '耗时估计',
};

/** 硬性约束的 kind → 中文。 */
export const CONSTRAINT_KIND_LABELS: Record<string, string> = {
  forbidden_window: '禁止时段',
  max_daily_minutes: '每日时长上限',
  required_buffer: '必要缓冲',
};

/**
 * 查中文标签，查不到就原样返回。
 *
 * 后端可以随时新增 kind，界面不该因为不认识就显示空白——显示原始 key 至少还能
 * 读懂，也方便排查。
 */
export function kindLabel(map: Record<string, string>, kind: string): string {
  return map[kind] ?? kind;
}

/** 六项排序权重的中文名。 */
export const WEIGHT_KEY_LABELS: Record<keyof SettingsWeights, string> = {
  deadline: '截止时间',
  manual_priority: '手动优先级',
  dependency: '依赖关系',
  effort: '预计耗时',
  habit_alignment: '习惯契合',
  context_switch: '上下文连续性',
};

/** 权重档位 0/1/2 的中文名。1 是默认的「平衡」。 */
export const WEIGHT_LEVEL_LABELS: Record<0 | 1 | 2, string> = {
  0: '关闭',
  1: '平衡',
  2: '优先',
};

/** 权重只有 0/1/2 三档：夹到范围内并取整，NaN 之类的坏输入落回 0。 */
export function clampWeight(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(2, Math.max(0, Math.round(n)));
}

/** 默认档位。摘要里只列出偏离它的项。 */
const DEFAULT_WEIGHT_LEVEL = 1;

/** 权重表的遍历顺序，与界面上六行的顺序一致。 */
const WEIGHT_KEYS = Object.keys(WEIGHT_KEY_LABELS) as (keyof SettingsWeights)[];

/**
 * 一行中文预览，只列出非默认档位，例如
 * `截止时间=优先 · 预计耗时=关闭`。
 *
 * 全是 1 时说明用户没调过任何一项，直接说清这件事比显示六个「=平衡」有用。
 */
export function summarizeWeights(weights: SettingsWeights): string {
  const parts = WEIGHT_KEYS.filter((key) => clampWeight(weights[key]) !== DEFAULT_WEIGHT_LEVEL).map(
    (key) => {
      const level = clampWeight(weights[key]) as 0 | 1 | 2;
      return `${WEIGHT_KEY_LABELS[key]}=${WEIGHT_LEVEL_LABELS[level]}`;
    },
  );
  if (parts.length === 0) return '全部保持平衡（1）';
  return parts.join(' · ');
}

/** 换算输入框下方的范围提示。边界值从 `@shared/duration` 读，避免两处漂移。 */
export function conversionRangeHint(): string {
  return (
    `每天 ${trim(HOURS_PER_DAY_MIN)}–${trim(HOURS_PER_DAY_MAX)} 小时 · ` +
    `每月 ${trim(DAYS_PER_MONTH_MIN)}–${trim(DAYS_PER_MONTH_MAX)} 个工作日`
  );
}

/**
 * 换算配置是否可提交。
 *
 * 两个值都必须是范围内的有限数；天数额外要求整数——半天工作日没有意义，后端也
 * 按整数存。
 */
export function isConversionValid(hoursPerDay: number, daysPerMonth: number): boolean {
  if (!Number.isFinite(hoursPerDay) || !Number.isFinite(daysPerMonth)) return false;
  if (hoursPerDay < HOURS_PER_DAY_MIN || hoursPerDay > HOURS_PER_DAY_MAX) return false;
  if (daysPerMonth < DAYS_PER_MONTH_MIN || daysPerMonth > DAYS_PER_MONTH_MAX) return false;
  return Number.isInteger(daysPerMonth);
}

/** 默认换算配置，「恢复默认」的文案与校验都用它。 */
export const DEFAULT_CONVERSION = DEFAULT_DURATION_CONFIG;

/** 置信度 0.62 → `62%`。非法值给 `—`，不显示 `NaN%`。 */
export function confidenceLabel(confidence: number | null | undefined): string {
  if (confidence === null || confidence === undefined || !Number.isFinite(confidence)) return '—';
  return `${Math.round(confidence * 100)}%`;
}

/** 去掉 `24.0` 这类多余的小数尾巴。 */
function trim(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/**
 * 「移除」=`enabled:false` 的软移除：条目留着、历史留着，只是不再参与排序。
 * 没有 DELETE，所以界面必须自己把一份列表劈成「在用」与「已移除」两段——主列表
 * 只渲染在用的，已移除的收进折叠区，随时能恢复。
 *
 * 两段各自保持入参里的原序（文件里的顺序），不重排也不改动入参数组：用户刚移除
 * 一条又点恢复时，它该回到原来的位置，而不是跳到列表末尾。
 */
export function splitByEnabled<T extends { enabled: boolean }>(
  entries: T[],
): { active: T[]; removed: T[]; removedCount: number } {
  const active: T[] = [];
  const removed: T[] = [];
  for (const entry of entries) {
    (entry.enabled ? active : removed).push(entry);
  }
  return { active, removed, removedCount: removed.length };
}

/** 采纳关系的 `type`，与服务端 `findExistingAdoption` 的判据同一个字符串。 */
const ADOPTED_FROM_INFERRED = 'adopted_from_inferred';

/**
 * 哪些推断已经被采纳过——采纳按钮据此置灰。
 *
 * 判据必须和服务端 `findExistingAdoption` 完全一致（看 `source_relation`，**不看**
 * `enabled`）：若前端放过一条服务端会判成幂等命中的推断，用户点下去什么都不会发生，
 * 看起来就是按钮坏了。真实数据里出现过同一条推断对应三条 explicit，所以这里收成
 * Set 做去重。
 *
 * `source_relation` 在类型上是 `unknown`，而 habits/*.json 是本机文件、用户手改过
 * 是常态，所以这里逐层收窄：任何不认识的形状都跳过，绝不抛错——设置页因为一条脏
 * 数据整页白屏是最差的结果。
 */
export function findAdoptedInferredIds(explicitEntries: ExplicitHabitEntry[]): Set<string> {
  const adopted = new Set<string>();
  for (const entry of explicitEntries) {
    const relation = entry.source_relation;
    if (typeof relation !== 'object' || relation === null || Array.isArray(relation)) continue;
    const { type, inferred_id: inferredId } = relation as {
      type?: unknown;
      inferred_id?: unknown;
    };
    if (type !== ADOPTED_FROM_INFERRED) continue;
    if (typeof inferredId !== 'string' || inferredId === '') continue;
    adopted.add(inferredId);
  }
  return adopted;
}

/**
 * 采纳成功后该弹哪句话。
 *
 * 服务端对重复采纳的处理是「什么都不写并返回 `already: true`」。这种情况下说
 * 「已采纳为明确习惯」是在撒谎——用户会以为刚刚新建了一条，于是去明确习惯区块找，
 * 找不到新东西又回来再点一次。
 *
 * 容忍空返回体：`request` 在 200 且 body 为空时回 `null`。写已经成功了，为了算一句
 * 文案而抛错会让调用方把它归成失败——弹红字且不刷新，比少一句准确文案糟得多。
 */
export function adoptToastMessage(result: { already?: boolean } | null | undefined): string {
  return result?.already ? '该推断已采纳过' : '已采纳为明确习惯';
}

/** 六项权重全 1 的「平衡」基线，「恢复默认权重」与摘要都以它为准。 */
export const DEFAULT_BALANCED_WEIGHTS: SettingsWeights = {
  deadline: 1,
  manual_priority: 1,
  dependency: 1,
  effort: 1,
  habit_alignment: 1,
  context_switch: 1,
};

/**
 * 两个列表装着同一组值（顺序无关）。
 *
 * 不能按下标比：已存文件里的顺序不由界面决定（`saveSettingsWeights` 原样落盘，
 * schema 也不排序），而界面的 toggle 永远按升序重建。于是「点开一个小时再点掉」
 * 会把 `[14, 9, 10]` 写成 `[9, 10, 14]`——集合没变，按下标比却是 dirty，徽标就
 * 再也消不掉了。
 */
function sameList<T>(a: T[] | undefined, b: T[] | undefined): boolean {
  const left = a ?? [];
  const right = b ?? [];
  if (left.length !== right.length) return false;
  const counts = new Map<T, number>();
  for (const item of left) counts.set(item, (counts.get(item) ?? 0) + 1);
  for (const item of right) {
    const seen = counts.get(item);
    if (!seen) return false;
    counts.set(item, seen - 1);
  }
  return true;
}

/**
 * 草稿相对已存快照有没有未保存的改动。
 *
 * 工作偏好与排序权重编辑同一份 weights.json，保存入口只有「高级：排序权重」里那
 * 一个。点 chip 看起来像即时生效，实际不是——所以两个区块都要靠这个判断挂「未保存」
 * 徽标，否则用户关掉页面就把改动丢了。
 *
 * 草稿为 `null` 即「还没动过」，按不 dirty 算。比较只看值不看引用：页面层的草稿是
 * 从快照浅拷出来的，引用必然不同。
 *
 * 权重**按原值比，不 clamp**：写入 schema 只要求 0..2、刻意不要求整数，所以文件里
 * 可能存着 1.5。界面把它显示成「优先」档（clamp 后是 2），用户点「优先」让草稿变成
 * 真正的 2 —— 两边都 clamp 的话这一步会被看成「没改」，徽标不出现，用户以为存过了，
 * 而排序实际仍在用 1.5。
 */
/** Show the actual values that a preference save will persist. */
export function summarizeSortingPreferences(draft: WeightsDraft): string {
  const hours = (value: number[]) => value.length ? value.map(hour => hour + ':00').join('、') : '不设高峰时段';
  const lines = [
    summarizeWeights(draft.weights),
    '通用时段：' + hours(draft.peak_hours ?? []),
    '偏好类型：' + ((draft.preferred_task_types ?? []).map(type => TASK_TYPE_LABELS[type]).join('、') || '未设置'),
  ];
  for (const [type, value] of Object.entries(draft.task_type_peak_hours ?? {})) {
    lines.push((TASK_TYPE_LABELS[type] ?? type) + '独立时段：' + hours(value));
  }
  return lines.join('\n');
}

export function isWeightsDirty(original: WeightsPayload, draft: WeightsDraft | null): boolean {
  if (!draft) return false;
  const changedWeight = WEIGHT_KEYS.some((key) => draft.weights[key] !== original.weights[key]);
  if (changedWeight) return true;
  if (!sameList(original.preferred_task_types, draft.preferred_task_types)) return true;
  if (!sameList(original.peak_hours, draft.peak_hours)) return true;
  return !sameTypePeakHours(original.task_type_peak_hours, draft.task_type_peak_hours);
}
