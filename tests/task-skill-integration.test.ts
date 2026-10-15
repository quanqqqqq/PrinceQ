import test from 'node:test';
import assert from 'node:assert/strict';
import {freshDb,withTempHabits} from './helpers.ts';
import {all,get,type Db} from '../server/db/connection.ts';
import {createGoal} from '../server/repo/goal-service.ts';
import {createTask,updateTask} from '../server/repo/task-service.ts';
import {findTask,listTasks} from '../server/repo/tasks.ts';
import {assistTask,readTaskAssistance} from '../server/agent/task-assistance.ts';
import {buildRouter} from '../server/http/routes.ts';
import {readRecurrence,occurrenceAction,updateRecurrence} from '../server/repo/recurrence.ts';
import type {RecurrenceInput} from '../shared/recurrence.ts';
import type {SkillOperation} from '../server/skills/catalog.ts';
withTempHabits();
const plan:RecurrenceInput={start_date:'2026-10-15',start_time:'09:00',unit:'day',interval:1,timezone:'Asia/Shanghai',end_mode:'goal'};
function fixture(){const db=freshDb(),goal=createGoal(db,{title:'制定并试行30天健身计划',target_date:'2026-11-13T15:59:59Z'}),task=createTask(db,{title:'每日记录训练、恢复与身体反馈',goal_id:goal.id,description:'记录事实，未知项待确认',recurrence:plan});return {db,goal,task};}
async function call(db:Db,method:string,url:string,body?:unknown,key='task-preview-test') {
  const route=buildRouter(()=>db).match(method,url)!;assert.ok(route);
  return await route.handler({req:{headers:{}},params:route.params,body,url:new URL('http://local'+url),idempotencyKey:key} as never) as any;
}
async function proposal(db:Db,id:string,actions:SkillOperation[],key='propose') {
  return assistTask(db,id,'请先预览，确认前不要执行。',key,{invoke:async(_prompt,system)=>{
    assert.ok(system?.includes('默认注入的 PrinceQ Skill'));assert.ok(system?.includes('task.recurrence.update'));assert.ok(system?.includes('独立任务协助模式'));
    return {answer:'已生成修改预览，尚未执行。',artifact:null,ready:false,summary:['核对现有任务与循环记录'],proposed_actions:actions};
  }});
}
const create=(goal:string,title='补充每周回顾'):SkillOperation=>({action:'skill_operation',operation:'task.create',payload:{title,description:'汇总本周模拟记录并列出待调整事项',goal_id:goal,estimated_minutes:10}});
test('task Agent receives real Skill, stages proposals with zero business writes, and confirms once',async()=>{
  const {db,goal,task}=fixture();const before=listTasks(db).length;
  const reply=await proposal(db,task.id,[create(goal.id)]);assert.equal(listTasks(db).length,before);assert.equal(reply.skill?.version,4);assert.equal(reply.previews?.[0].status,'pending');assert.ok(reply.messages.at(-1)?.preview_token);
  const token=reply.previews![0].token;
  await assert.rejects(call(db,'POST',`/api/tasks/${task.id}/assistance/previews/${token}/confirm`,{}),/显式确认/);
  const result=await call(db,'POST',`/api/tasks/${task.id}/assistance/previews/${token}/confirm`,{confirmed:true});assert.equal(listTasks(db).length,before+1);assert.equal(result.previews[0].status,'confirmed');assert.equal(result.previews[0].result.tasks[0].title,'补充每周回顾');
  await call(db,'POST',`/api/tasks/${task.id}/assistance/previews/${token}/confirm`,{confirmed:true},'repeat-confirm');assert.equal(listTasks(db).length,before+1);assert.equal(all(db,'SELECT * FROM agent_sessions').length,0);db.close();
});
test('task edits and cancelled proposals preserve data until confirmed',async()=>{
  const {db,task}=fixture();const proposed=await proposal(db,task.id,[{action:'skill_operation',operation:'task.update',target_id:task.id,payload:{description:'新的记录标准：活动、用时与反馈',estimated_minutes:8}}]);
  assert.equal(findTask(db,task.id)!.estimated_minutes,null);const token=proposed.previews![0].token;
  const before=JSON.stringify(all(db,'SELECT * FROM tasks'));
  await call(db,'POST',`/api/tasks/${task.id}/assistance/previews/${token}/cancel`,{});assert.equal(JSON.stringify(all(db,'SELECT * FROM tasks')),before);
  await assert.rejects(call(db,'POST',`/api/tasks/${task.id}/assistance/previews/${token}/confirm`,{confirmed:true}),/取消/);db.close();
});
test('a newer proposal replaces the pending draft; old draft cannot execute',async()=>{
  const {db,goal,task}=fixture();const a=await proposal(db,task.id,[create(goal.id,'旧草稿')],'one');const b=await proposal(db,task.id,[create(goal.id,'新草稿')],'two');
  const old=b.previews!.find(item=>item.token===a.previews![0].token)!;assert.equal(old.status,'cancelled');assert.ok(old.replaced_by);
  await assert.rejects(call(db,'POST',`/api/tasks/${task.id}/assistance/previews/${old.token}/confirm`,{confirmed:true}),/取消/);assert.equal(listTasks(db).length,1);db.close();
});
test('task-owned previews cannot be confirmed from another task or the global chat',async()=>{
  const {db,goal,task}=fixture();const other=createTask(db,{title:'其他会话',goal_id:goal.id});const reply=await proposal(db,task.id,[create(goal.id)]);const token=reply.previews![0].token;
  await assert.rejects(call(db,'POST',`/api/tasks/${other.id}/assistance/previews/${token}/confirm`,{confirmed:true}),/不属于/);
  await assert.rejects(call(db,'POST',`/api/skills/princeq/previews/${token}/confirm`,{confirmed:true}),/对应任务/);
  await assert.rejects(call(db,'POST','/api/agent/preview/confirm',{token}),/对应任务/);assert.equal(all(db,'SELECT * FROM agent_sessions').length,0);assert.equal(listTasks(db).length,2);db.close();
});
test('stale proposals fail closed with no partial task creation',async()=>{
  const {db,goal,task}=fixture();const reply=await proposal(db,task.id,[create(goal.id),{action:'skill_operation',operation:'task.update',target_id:task.id,payload:{description:'草稿说明'}}]);
  updateTask(db,task.id,{description:'另一个窗口保存的说明'});
  const token=reply.previews![0].token;await assert.rejects(call(db,'POST',`/api/tasks/${task.id}/assistance/previews/${token}/confirm`,{confirmed:true}),/已改变/);
  assert.equal(listTasks(db).length,1);assert.equal(findTask(db,task.id)!.description,'另一个窗口保存的说明');assert.ok(readTaskAssistance(db,task.id).previews![0].stale_reason);db.close();
});
test('failure of a later operation rolls the entire confirmed batch back',async()=>{
  const {db,goal,task}=fixture();const reply=await proposal(db,task.id,[create(goal.id),{action:'skill_operation',operation:'task.action',target_id:task.id,payload:{action:'claim',actor_id:'missing-actor'}}]);const token=reply.previews![0].token;
  const before=JSON.stringify(all(db,'SELECT * FROM tasks'));
  await assert.rejects(call(db,'POST',`/api/tasks/${task.id}/assistance/previews/${token}/confirm`,{confirmed:true}));
  assert.equal(JSON.stringify(all(db,'SELECT * FROM tasks')),before);assert.equal(get(db,'SELECT status FROM agent_pending_actions WHERE token=?',[token])?.status,'pending');db.close();
});
test('recurrence update preview simulates without writes; confirmation changes future cadence and preserves today',async()=>{
  const {db,task}=fixture();const now=new Date('2026-10-15T08:00:00Z');occurrenceAction(db,task.id,{date:'2026-10-15',action:'complete',expected_version:0,note:'模拟：恢复日记录'},now);
  const before=findTask(db,task.id)!;const reply=await proposal(db,task.id,[{action:'skill_operation',operation:'task.recurrence.update',target_id:task.id,payload:{...plan,start_date:'2026-10-16',interval:2,expected_version:1}}]);
  assert.equal(all(db,'SELECT * FROM task_recurrence_revisions').length,0);assert.equal(findTask(db,task.id)!.version,before.version);assert.equal(readRecurrence(db,task.id,now)!.total,30);
  const change=reply.previews![0].changes[0];assert.ok(change.fields.some(field=>field.label==='计划总次数'&&field.before==='30'&&field.after==='16'));
  await call(db,'POST',`/api/tasks/${task.id}/assistance/previews/${reply.previews![0].token}/confirm`,{confirmed:true});
  const updated=readRecurrence(db,task.id,now)!;assert.equal(updated.total,16);assert.equal(updated.completed,1);assert.equal(updated.occurrences[0].note,'模拟：恢复日记录');assert.equal(updated.occurrences[0].opened_at,now.toISOString());
  assert.deepEqual(updated.occurrences.slice(0,4).map(item=>item.date),['2026-10-15','2026-10-16','2026-10-18','2026-10-20']);assert.equal(updated.effective_end_date,'2026-11-13');db.close();
});
test('cycle edits cannot rewrite recorded dates or shift the timezone',()=>{
  const {db,task}=fixture();const now=new Date('2026-10-15T08:00:00Z');occurrenceAction(db,task.id,{date:'2026-10-15',action:'open',expected_version:0},now);
  assert.throws(()=>updateRecurrence(db,task.id,{...plan,interval:2},1,now),/已有执行记录/);
  assert.throws(()=>updateRecurrence(db,task.id,{...plan,start_date:'2026-10-16',timezone:'UTC'},1,now),/原时区/);assert.equal(all(db,'SELECT * FROM task_recurrence_revisions').length,0);db.close();
});
test('hour/week/month changes retain earlier slots and calendar anchors',()=>{
  for(const unit of ['hour','week','month'] as const){const {db,task}=fixture();const now=new Date('2026-10-15T08:00:00Z');
    updateRecurrence(db,task.id,{...plan,start_date:'2026-10-16',start_time:'09:00',unit,interval:unit==='hour'?6:1},1,now);
    const updated=readRecurrence(db,task.id,now)!;assert.equal(updated.occurrences[0].date,'2026-10-15');assert.equal(updated.plan_changes![0].unit,unit);db.close();}
});
test('unsupported or invalid actions leave no orphan preview or business writes',async()=>{
  const {db,task}=fixture();await assert.rejects(proposal(db,task.id,[{action:'skill_operation',operation:'task.recurrence.update',target_id:task.id,payload:{...plan,start_date:'2026-10-14',expected_version:1}}]),/过去/);
  assert.equal(all(db,'SELECT * FROM agent_pending_actions').length,0);assert.equal(all(db,'SELECT * FROM task_recurrence_revisions').length,0);db.close();
});

test('a confirmed batch uses recurrence versions between cycle update and pause',async()=>{
  const {db,task}=fixture();const reply=await proposal(db,task.id,[{action:'skill_operation',operation:'task.recurrence.update',target_id:task.id,payload:{...plan,start_date:'2026-10-16',interval:2,expected_version:1}},{action:'skill_operation',operation:'task.recurrence.control',target_id:task.id,payload:{action:'pause',expected_version:1}}]);
  await call(db,'POST',`/api/tasks/${task.id}/assistance/previews/${reply.previews![0].token}/confirm`,{confirmed:true});
  const current=readRecurrence(db,task.id)!;assert.equal(current.version,3);assert.equal(current.status,'paused');assert.equal(current.plan_changes![0].interval,2);db.close();
});

test('standalone creation proposals also bind the source task version',async()=>{
  const db=freshDb(),task=createTask(db,{title:'独立任务'});const reply=await proposal(db,task.id,[{action:'skill_operation',operation:'task.create',payload:{title:'待创建的独立任务'}}]);
  updateTask(db,task.id,{description:'新的源任务信息'});
  await assert.rejects(call(db,'POST',`/api/tasks/${task.id}/assistance/previews/${reply.previews![0].token}/confirm`,{confirmed:true}),/已改变/);assert.equal(listTasks(db).length,1);db.close();
});
test('deleting a source task revokes its pending proposal before ownership rows disappear',async()=>{
  const {deleteTask}=await import('../server/repo/delete-service.ts');const db=freshDb(),task=createTask(db,{title:'待删除的独立任务'});
  const reply=await proposal(db,task.id,[{action:'skill_operation',operation:'task.create',payload:{title:'不能残留执行的草稿'}}]);const token=reply.previews![0].token;
  deleteTask(db,task.id);assert.equal(get(db,'SELECT status FROM agent_pending_actions WHERE token=?',[token])?.status,'cancelled');
  const {confirmPendingActions}=await import('../server/agent/pending-actions.ts');assert.throws(()=>confirmPendingActions(db,token,'actor-human-me','deleted-owner-key'),/处理过/);assert.equal(listTasks(db).length,0);db.close();
});
