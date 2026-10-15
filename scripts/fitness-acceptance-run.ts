import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
const dir=path.resolve('.preview/fitness-acceptance');
const meta=JSON.parse(fs.readFileSync(path.join(dir,'metadata.json'),'utf8'));
const report:any={case:'制定并试行30天健身计划',isolated:true,period:['2026-10-15','2026-11-13'],steps:[],started_at:new Date().toISOString()};
const save=()=>fs.writeFileSync(path.join(dir,'report.json'),JSON.stringify(report,null,2));
async function api(route:string,body?:unknown,key=crypto.randomUUID()):Promise<any> {
  const response=await fetch(meta.base+route,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json','Idempotency-Key':key},body:body===undefined?undefined:JSON.stringify(body)});
  const result=await response.json();assert.ok(response.ok,JSON.stringify(result));return result;
}
const step=(name:string,detail:unknown)=>{report.steps.push({name,detail,at:new Date().toISOString()});save();console.log('PASS '+name);};
try {
  const before=await api('/api/tasks');
  const draft=await api('/api/agent/message',{message:'请结合目标说明补齐实现这个30天目标所需的任务草稿。用户已确定10月15日开始，连续30天至11月13日。现有三个一次性任务覆盖准备、计划和首次试行，请检查是否还缺少长期持续执行任务，按实际需要补齐；不要重复已覆盖的工作。先预览，不创建。',target_goal_id:meta.goal_id,intent:'goal_task_drafts',processing_mode:'agent',fallback:false});
  report.decomposition=draft;save();assert.equal(draft.source,'agent');assert.ok(draft.result.pending_action?.token,JSON.stringify(draft.result));
  const preview=await api('/api/skills/princeq/previews/'+draft.result.pending_action.token);
  assert.ok(preview.actions.some((a:any)=>a.payload?.recurrence?.unit==='day'));assert.equal((await api('/api/tasks')).tasks.length,before.tasks.length);
  step('真实 Agent 通过更新后的 Skill 生成循环任务，确认前零创建',preview.actions);
  await api('/api/skills/princeq/previews/'+preview.token+'/confirm',{confirmed:true});
  const tasks=(await api('/api/tasks')).tasks;
  const recurring=tasks.find((task:any)=>task.goal_id===meta.goal_id&&task.recurrence);
  assert.ok(recurring);assert.equal(recurring.recurrence.total,30);assert.equal(recurring.recurrence.start_date,'2026-10-15');assert.equal(recurring.recurrence.effective_end_date,'2026-11-13');
  step('确认后创建单个长期循环任务与30次执行日历',{id:recurring.id,recurrence:recurring.recurrence});
  const task=meta.tasks.find((task:any)=>task.title==='整理训练起点与健康限制');
  const first=await api('/api/tasks/'+task.id+'/assistance/messages',{message:'请协助完成本项整理任务。当前是隔离产品验收，请先询问整理起点记录所需的信息，不要编造个人事实。'});
  assert.equal(first.messages.length,2);assert.equal((await api('/api/tasks/'+task.id)).task.status,'inbox');
  const other=await api('/api/tasks/'+meta.tasks[1].id+'/assistance');assert.equal(other.messages.length,0);
  step('真实任务 Agent 首轮问询，独立会话且不自动完成',first);
  const second=await api('/api/tasks/'+task.id+'/assistance/messages',{message:'仅供产品验收的虚构资料：过去每周步行2次，每天可投入20分钟，家中有瑜伽垫、无其他器械。健康限制尚未确认，本任务不判断是否适合训练。请将所有资料标为模拟，输出完整起点记录和需要进一步确认的问题清单。本任务完成标准是整理记录及待确认问题，不是提供训练处方。'});
  report.assistance=second;save();assert.equal(second.messages.length,4);assert.ok(second.session.artifact);assert.equal(second.session.ready,true);
  const restored=await api('/api/tasks/'+task.id+'/assistance');assert.equal(restored.session.id,first.session.id);assert.equal(restored.messages.length,4);
  step('持续对话产出可恢复的完整模拟起点记录',restored);
  const current=(await api('/api/tasks/'+task.id)).task;
  await api('/api/tasks/'+task.id+'/assistance/accept',{revision:restored.session.revision,expected_version:current.version});
  assert.equal((await api('/api/tasks/'+task.id)).task.status,'completed');
  step('显式采纳产出后完成普通任务',{task_id:task.id});
  let recurrence=(await api('/api/tasks/'+recurring.id+'/recurrence')).recurrence;
  let occurrence=recurrence.today_occurrence;assert.ok(occurrence);
  await api('/api/tasks/'+recurring.id+'/occurrences/actions',{date:occurrence.date,action:'open',expected_version:occurrence.version});
  recurrence=(await api('/api/tasks/'+recurring.id+'/recurrence')).recurrence;assert.ok(recurrence.today_occurrence.opened_at);assert.equal(recurrence.completed,0);
  await api('/api/tasks/'+recurring.id+'/occurrences/actions',{date:recurrence.today_occurrence.date,action:'complete',expected_version:recurrence.today_occurrence.version,note:'隔离验收模拟：今天为恢复日，已记录模拟活动与反馈；不代表真实训练。'});
  recurrence=(await api('/api/tasks/'+recurring.id+'/recurrence')).recurrence;assert.equal(recurrence.completed,1);assert.notEqual((await api('/api/tasks/'+recurring.id)).task.status,'completed');
  assert.equal(recurrence.occurrences[1].opened_at,null);assert.equal(recurrence.total,30);
  step('打开与完成分离，完成今天只影响1/30次',{recurrence});
  report.recurring_task_id=recurring.id;report.assisted_task_id=task.id;report.success=true;report.finished_at=new Date().toISOString();save();
} catch(error) {report.success=false;report.error=(error as Error).stack;save();throw error;}
