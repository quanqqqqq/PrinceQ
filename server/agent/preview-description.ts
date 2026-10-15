import type {PendingAction} from './pending-actions.ts';
import type {Db} from '../db/connection.ts';
import {describeSkillOperation} from '../skills/catalog.ts';
export function describePendingAction(db:Db,action:PendingAction):string {
  if(action.action==='skill_operation')return describeSkillOperation(db,action);
  if(action.action==='create_task')return `新建任务：${action.title}${action.minutes?'；预计 '+action.minutes+' 分钟':''}${action.deadline_iso?'；截止 '+action.deadline_iso:''}${action.goal_title?'；目标 '+action.goal_title:''}`;
  if(action.action==='create_goal')return `新建目标：${action.title}${action.description?'；说明 '+action.description:''}${action.target_date_iso?'；目标日期 '+action.target_date_iso:''}`;
  if(action.action==='create_goal_with_tasks')return [
    `新建目标：${action.title}${action.description?'；说明 '+action.description:''}${action.target_date_iso?'；目标日期 '+action.target_date_iso:''}`,
    ...action.tasks.map((task,index)=>`任务 ${index+1}：${task.title}${task.minutes?'；预计 '+task.minutes+' 分钟':''}${task.deadline_iso?'；截止 '+task.deadline_iso:''}；${task.description}`),
  ].join('\n');
  if(action.action==='task_action')return `任务操作：${action.lifecycle} → ${action.task_title}${action.reason?'；原因 '+action.reason:''}`;
  return `新增习惯：${action.statement}`;
}
