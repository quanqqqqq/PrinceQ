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

/** New-goal requests stay in the goal flow and preview the goal with its first tasks together. */
export function buildGoalCreationMessage(input: {title: string; description: string; targetDate: string}) {
  const details = [
    `目标名称：${input.title.trim()}`,
    input.description.trim() ? `完成标准与背景：${input.description.trim()}` : '',
    input.targetDate ? `目标日期（本地日期）：${input.targetDate}` : '',
  ].filter(Boolean).join('\n');
  return `请根据以下信息创建一个新目标，并一起规划它的第一批关联任务。\n${details}\n任务要具体、可执行，并写明完成标准；不要编造截止日期或工作事实。请生成目标和任务的组合待确认预览，用户确认前不要创建或写入任何数据。`;
}
