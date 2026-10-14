import type { Goal } from '@shared/types';
import { demoText } from '@/lib/format';

export const OPEN_AGENT_PANEL_EVENT = 'princeq:open-agent-panel';

/** Opens the shared conversation on desktop or in the mobile drawer. */
export function openAgentPanel() {
  window.dispatchEvent(new Event(OPEN_AGENT_PANEL_EVENT));
}

/** Human-readable request; stable goal identity travels separately in target_goal_id. */
export function buildGoalDraftMessage(goal: Pick<Goal, 'title' | 'is_demo'>) {
  return '请结合目标「' + demoText(goal.title, goal.is_demo) +
    '」的说明、已有任务和我的工作习惯，补齐实现目标所需的任务草稿。任务要具体、可执行，并说明交付物或验收标准；避免重复已有任务。请生成可创建的待确认任务预览，确认前不要写入数据。';
}
