import type {PendingAction} from './pending-actions.ts';
import type {Db} from '../db/connection.ts';
import {describeSkillOperation} from '../skills/catalog.ts';
export function describePendingAction(db:Db,action:PendingAction):string {
  if(action.action==='skill_operation')return describeSkillOperation(db,action);
  if(action.action==='create_task')return `新建任务：${action.title}${action.minutes?'；预计 '+action.minutes+' 分钟':''}${action.deadline_iso?'；截止 '+action.deadline_iso:''}${action.goal_title?'；目标 '+action.goal_title:''}`;
  if(action.action==='create_goal')return `新建目标：${action.title}${action.target_date_iso?'；目标日期 '+action.target_date_iso:''}`;
  if(action.action==='task_action')return `任务操作：${action.lifecycle} → ${action.task_title}${action.reason?'；原因 '+action.reason:''}`;
  return `新增习惯：${action.statement}`;
}
