/**
 * 「新建任务」对话框里「更多设置」折叠区的判定与摘要（UX-15）。
 *
 * 对话框把类型 / 认知负荷 / 手动优先级三个高级项收进折叠区。折叠时如果用户其实
 * 已经改过它们，就得给一行摘要，否则设置会「藏」得看不见。
 *
 * 判定规则只有一条值得写下来：手动优先级的 `'0'`（普通）与 `''` 都算**没设置**，
 * 因为 `'0'` 是 select 的默认档位，不是用户的选择——这跟 `isCreateTaskDraftEmpty`
 * 对 manual_priority 的口径保持一致，避免「草稿算空、摘要却说已设置」。
 *
 * 纯逻辑、零 React 依赖，可被 `node --test` 直接引入。
 */
import type { CognitiveLoad, TaskType } from '@shared/types';
import {
  COGNITIVE_LOAD_LABELS,
  MANUAL_PRIORITY_LABELS,
  TASK_TYPE_LABELS,
} from './i18n.ts';

/** 摘要里各项之间的分隔符。 */
export const ADVANCED_SUMMARY_SEPARATOR = ' · ';

/** 摘要前缀，拼在各项之前。 */
export const ADVANCED_SUMMARY_PREFIX = '已设置：';

/** 摘要只看这三个高级项，其余字段一律无关。 */
export interface AdvancedCreateFields {
  task_type: string;
  cognitive_load: string;
  manual_priority: string;
}

/**
 * 手动优先级是否被用户真正选过。
 *
 * `'0'` 是默认档位（普通），`''` 是草稿里没值，两者都不算设置。
 */
export function isManualPrioritySet(value: string): boolean {
  return value !== '' && value !== '0';
}

/** 三个高级项里是否至少有一个被设置过。 */
export function hasAdvancedCreateFields(fields: AdvancedCreateFields): boolean {
  if (fields.task_type) return true;
  if (fields.cognitive_load) return true;
  return isManualPrioritySet(fields.manual_priority);
}

/** 手动优先级的中文档位名；认不出的 value 原样返回，绝不吞掉信息。 */
function manualPriorityLabel(value: string): string {
  return MANUAL_PRIORITY_LABELS.find((option) => option.value === value)?.label ?? value;
}

/**
 * 折叠态摘要，形如 `已设置：类型=评审 · 认知负荷=高 · 优先级=较高`。
 *
 * 一个高级项都没设置时返回空串，调用方据此决定整行是否渲染。
 */
export function createAdvancedSummary(fields: AdvancedCreateFields): string {
  const parts: string[] = [];

  if (fields.task_type) {
    const label = TASK_TYPE_LABELS[fields.task_type as TaskType] ?? fields.task_type;
    parts.push(`类型=${label}`);
  }
  if (fields.cognitive_load) {
    const label =
      COGNITIVE_LOAD_LABELS[fields.cognitive_load as CognitiveLoad] ?? fields.cognitive_load;
    parts.push(`认知负荷=${label}`);
  }
  if (isManualPrioritySet(fields.manual_priority)) {
    parts.push(`优先级=${manualPriorityLabel(fields.manual_priority)}`);
  }

  if (parts.length === 0) return '';
  return `${ADVANCED_SUMMARY_PREFIX}${parts.join(ADVANCED_SUMMARY_SEPARATOR)}`;
}
