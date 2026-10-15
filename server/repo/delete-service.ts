/** Explicit permanent deletes. Goal deletion also deletes every linked task. */
import {all, get, run, transaction, type Db, type Row} from '../db/connection.ts';
import {conflict, notFound} from '../lib/errors.ts';
import {nowIso} from '../lib/ids.ts';
import {findGoal, findTask} from './tasks.ts';
export function deleteTask(db:Db,id:string,expectedVersion?:number) {
  const task=findTask(db,id);if(!task)throw notFound('任务不存在');
  if(expectedVersion!==undefined&&expectedVersion!==task.version)throw conflict('任务版本已改变');
  const neighbours=[...new Set([...task.depends_on,...task.blocks])];
  run(db,"UPDATE agent_pending_actions SET status='cancelled',resolved_at=? WHERE status='pending' AND token IN (SELECT token FROM task_assistance_previews WHERE task_id=?)",[nowIso(),id]);
  run(db,'DELETE FROM rescoring_requests WHERE task_id = ?',[id]);
  run(db,'DELETE FROM tasks WHERE id = ?',[id]);
  for(const other of neighbours)run(db,'UPDATE tasks SET version = version + 1, updated_at = ? WHERE id = ?',[nowIso(),other]);
  return {deleted_task_id:id,title:task.title,removed_dependency_task_ids:neighbours};
}
export function deleteGoal(db: Db, id: string, expectedVersion?: number) {
  return transaction(db, () => {
    const goal = findGoal(db, id);
    if (!goal) throw notFound('目标不存在');
    if (expectedVersion !== undefined && expectedVersion !== goal.version) throw conflict('目标版本已改变');
    const tasks = all<Row>(db, 'SELECT id FROM tasks WHERE goal_id = ? ORDER BY id', [id]);
    for (const row of tasks) deleteTask(db, String(row.id));
    run(db, 'DELETE FROM goals WHERE id = ?', [id]);
    for (const row of all<Row>(db, "SELECT token, payload FROM pending_previews WHERE kind = 'goal_decomposition' AND consumed_at IS NULL")) {
      try {
        if (JSON.parse(String(row.payload)).goal_id === id) {
          run(db, 'UPDATE pending_previews SET consumed_at = ? WHERE token = ?', [nowIso(), String(row.token)]);
        }
      } catch { /* legacy malformed previews are not changed */ }
    }
    return {
      deleted_goal_id: id,
      title: goal.title,
      deleted_task_ids: tasks.map(row => String(row.id)),
      exists: Boolean(get(db, 'SELECT 1 FROM goals WHERE id = ?', [id])),
    };
  });
}
export function removeDependency(db:Db,taskId:string,dependencyId:string) {
  if(!findTask(db,taskId)||!findTask(db,dependencyId))throw notFound('任务或依赖任务不存在');
  if(get(db,'SELECT 1 FROM task_dependencies WHERE task_id = ? AND depends_on_id = ?',[taskId,dependencyId])) {
    run(db,'DELETE FROM task_dependencies WHERE task_id = ? AND depends_on_id = ?',[taskId,dependencyId]);
    for(const id of [taskId,dependencyId])run(db,'UPDATE tasks SET version = version + 1, updated_at = ? WHERE id = ?',[nowIso(),id]);
  }
  return findTask(db,taskId)!;
}
