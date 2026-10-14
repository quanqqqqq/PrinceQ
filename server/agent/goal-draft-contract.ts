/** Goal-button drafts are constrained to task creation under the selected goal. */
import type { PendingAction } from './pending-actions.ts';
import type { Db } from '../db/connection.ts';
import { findGoal, listTasks } from '../repo/tasks.ts';

const titleKey = (title: string) => title.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

export function goalDraftFingerprint(db: Db, goalId: string): string {
  const goal = findGoal(db, goalId);
  if (!goal) throw new Error('所选目标已不存在，请重新选择目标。');
  const tasks = listTasks(db, { goal_id: goalId }).map(task => ({ id: task.id, version: task.version })).sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify({ goal_version: goal.version, tasks });
}

export function normalizeGoalDraftActions(
  actions: PendingAction[], goalId: string, existingTitles: string[], dropped = 0,
): PendingAction[] {
  if (dropped) throw new Error('任务草稿包含无效字段，请重新生成完整预览。');
  const seen = new Set(existingTitles.map(titleKey));
  return actions.map(action => {
    if (action.action !== 'skill_operation' || action.operation !== 'task.create') {
      throw new Error('目标任务草稿只能新增所选目标的任务，不能夹带其他修改。');
    }
    const payload = { ...action.payload };
    // The UI explicitly chose this goal. Fill omitted binding deterministically;
    // an explicitly different/null binding is rejected rather than silently replaced.
    if (payload.goal_id === undefined) payload.goal_id = goalId;
    if (payload.goal_id !== goalId) throw new Error('任务草稿关联了其他目标，请重新生成。');
    if (typeof payload.title !== 'string' || !payload.title.trim() ||
        typeof payload.description !== 'string' || !payload.description.trim()) {
      throw new Error('任务草稿必须包含具体名称和完成标准。');
    }
    const key = titleKey(payload.title);
    if (seen.has(key)) throw new Error('任务草稿与已有任务或本批草稿重复，请去重后重试。');
    seen.add(key);
    return { ...action, payload };
  });
}
