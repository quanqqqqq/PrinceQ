/**
 * UX-22：草稿预览的默认勾选规则。
 *
 * 疑似重复的草稿默认不勾——重复建任务比漏建更难收拾；用户仍可手动勾回。
 * GoalDetailPanel（目标详情）与 AgentResultView（助手预览）共用同一条规则，
 * 保证两处口径一致。
 */
import type { DecompositionDraft } from './types.ts';

export function defaultDraftSelection(drafts: DecompositionDraft[]): boolean[] {
  return drafts.map((draft) => !draft.duplicate);
}
