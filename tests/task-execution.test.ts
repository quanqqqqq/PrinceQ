import test from 'node:test';
import assert from 'node:assert/strict';
import {freshDb,withTempHabits} from './helpers.ts';
import {run,all,transaction} from '../server/db/connection.ts';
import {createTask,applyAction} from '../server/repo/task-service.ts';
import {createGoal,updateGoal} from '../server/repo/goal-service.ts';
import {findTask} from '../server/repo/tasks.ts';
import {configureRecurrence,readRecurrence,occurrenceAction,controlRecurrence} from '../server/repo/recurrence.ts';
import {assistTask,readTaskAssistance,acceptTaskAssistance} from '../server/agent/task-assistance.ts';
import {recurrenceKey} from '../shared/recurrence.ts';
import {deleteGoal} from '../server/repo/delete-service.ts';
import {skillOperationSchema,skillCatalog} from '../server/skills/catalog.ts';
import type {RecurrenceInput} from '../shared/recurrence.ts';
withTempHabits();
const today=new Date('2026-10-15T04:00:00Z');
const input:RecurrenceInput={start_date:'2026-10-15',interval:1,unit:'day',timezone:'Asia/Shanghai',end_mode:'goal'};
function fixture() {
  const db=freshDb();
  const goal=createGoal(db,{title:'制定并试行30天健身计划',target_date:'2026-11-13T15:59:59Z'});
  const task=createTask(db,{title:'记录每日训练或恢复情况',goal_id:goal.id,recurrence:input});
  return {db,goal,task};
}
test('30-day lifecycle: open is separate from complete; duplicate, stale, future and backfill rules',()=>{
  const {db,task}=fixture();
  let r=readRecurrence(db,task.id,today)!;assert.equal(r.total,30);assert.equal(r.opened,0);
  r=occurrenceAction(db,task.id,{date:'2026-10-15',action:'open',expected_version:0},today);
  assert.equal(r.today_occurrence?.status,'pending');assert.ok(r.today_occurrence?.opened_at);assert.equal(r.opened_days,1);
  assert.throws(()=>occurrenceAction(db,task.id,{date:'2026-10-15',action:'complete',expected_version:0},today),/更新/);
  r=occurrenceAction(db,task.id,{date:'2026-10-15',action:'complete',note:'模拟验收：恢复日，未训练。',expected_version:1},today);
  assert.equal(r.completed,1);assert.equal(findTask(db,task.id)!.status,'inbox');
  const tomorrow=new Date('2026-10-16T04:00:00Z');r=readRecurrence(db,task.id,tomorrow)!;
  assert.equal(r.today_occurrence?.status,'pending');assert.equal(r.today_occurrence?.opened_at,null);assert.equal(r.completed,1);
  assert.throws(()=>occurrenceAction(db,task.id,{date:'2026-10-17',action:'complete',expected_version:0},tomorrow),/只能记录/);
  r=readRecurrence(db,task.id,new Date('2026-10-17T04:00:00Z'))!;assert.equal(r.missed,1);
  r=occurrenceAction(db,task.id,{date:'2026-10-16',action:'skip',note:'验收：补记休息日',expected_version:0},new Date('2026-10-17T04:00:00Z'));
  assert.equal(r.occurrences[1].opened_at,null);assert.equal(r.skipped,1);
  assert.throws(()=>applyAction(db,task.id,{action:'complete',actor_id:'actor-human-me'}),/单独结束/);
  db.close();
});
test('hour/week/month cadence, month-end anchor and leap year',()=>{
  const base={...input,end_mode:'date' as const,end_date:'2027-04-30'};
  assert.equal(recurrenceKey({...base,start_date:'2026-01-31',unit:'month'},1),'2026-02-28');
  assert.equal(recurrenceKey({...base,start_date:'2026-01-31',unit:'month'},2),'2026-03-31');
  assert.equal(recurrenceKey({...base,start_date:'2028-01-31',unit:'month'},1),'2028-02-29');
  assert.equal(recurrenceKey({...base,unit:'week',interval:2},1),'2026-10-29');
  const db=freshDb();const task=createTask(db,{title:'每6小时记录',recurrence:{...base,start_time:'09:00',interval:6,unit:'hour',end_date:'2026-10-16'}});
  let r=readRecurrence(db,task.id,today)!;assert.equal(r.today_occurrence?.date,'2026-10-15T09:00');assert.equal(r.total,7);
  r=readRecurrence(db,task.id,new Date('2026-10-15T08:00:00Z'))!;assert.equal(r.today_occurrence?.date,'2026-10-15T15:00');assert.equal(r.missed,1);
  db.close();
});
test('goal date linkage, pause/resume, completion guard and invalid policies',()=>{
  const {db,goal,task}=fixture();
  updateGoal(db,goal.id,{target_date:'2026-11-14T15:59:59Z'});assert.equal(readRecurrence(db,task.id,today)!.total,31);
  assert.throws(()=>updateGoal(db,goal.id,{target_date:null}),/不能清空/);
  let r=controlRecurrence(db,task.id,'pause',1,today);assert.equal(r.status,'paused');assert.equal(r.next_date,null);
  assert.throws(()=>occurrenceAction(db,task.id,{date:'2026-10-15',action:'open',expected_version:0},today),/暂停/);
  r=controlRecurrence(db,task.id,'resume',2,today);assert.equal(r.status,'active');
  assert.throws(()=>controlRecurrence(db,task.id,'finish',3,today),/尚未到/);
  assert.throws(()=>configureRecurrence(db,task.id,{...input,start_date:'2026-02-30'}),/不合法/);
  const plain=createTask(db,{title:'未设置目标日期'});assert.throws(()=>configureRecurrence(db,plain.id,input),/关联目标/);
  db.close();
});
test('30 days complete independently; end cannot bypass unresolved occurrences',()=>{
  const {db,task}=fixture();const end=new Date('2026-11-13T12:00:00Z');
  assert.throws(()=>controlRecurrence(db,task.id,'finish',1,end),/仍有未完成/);
  for(const item of readRecurrence(db,task.id,end)!.occurrences)occurrenceAction(db,task.id,{date:item.date,action:'complete',expected_version:0,note:'隔离模拟验收'},end);
  const r=controlRecurrence(db,task.id,'finish',1,end);assert.equal(r.completed,30);assert.equal(findTask(db,task.id)!.status,'completed');
  db.close();
});
test('task Agent conversations are isolated, persistent and idempotent; acceptance owns completion',async()=>{
  const db=freshDb();const a=createTask(db,{title:'整理训练起点与健康限制'});const b=createTask(db,{title:'另一任务'});
  await assistTask(db,a.id,'仅用于验收的模拟资料','turn1',{invoke:async prompt=>{assert.ok(prompt.includes(a.title));return {answer:'请补充可投入时间。',artifact:null,ready:false};}});
  assert.equal(findTask(db,a.id)!.status,'inbox');assert.equal(readTaskAssistance(db,b.id).messages.length,0);
  await assistTask(db,a.id,'模拟每次20分钟','turn2',{invoke:async prompt=>{assert.ok(prompt.includes('仅用于验收'));return {answer:'草稿可供验收。',artifact:'模拟验收起点记录：每次20分钟，健康限制待本人核实。',ready:true};}});
  await assistTask(db,a.id,'模拟每次20分钟','turn2',{invoke:async()=>{throw new Error('should not call');}});
  const detail=readTaskAssistance(db,a.id);assert.equal(detail.messages.length,4);assert.ok(detail.session?.artifact);
  assert.equal(all(db,'SELECT * FROM agent_sessions').length,0);
  assert.throws(()=>transaction(db,()=>acceptTaskAssistance(db,a.id,{revision:1,expected_version:a.version})),/已更新/);
  transaction(db,()=>acceptTaskAssistance(db,a.id,{revision:2,expected_version:a.version}));
  assert.equal(findTask(db,a.id)!.status,'completed');assert.ok(readTaskAssistance(db,a.id).session?.accepted_at);
  db.close();
});
test('changed task blocks stale artifact; failed turns can retry without duplicating messages',async()=>{
  const db=freshDb();const task=createTask(db,{title:'起点记录'});
  await assert.rejects(assistTask(db,task.id,'模拟资料','fail',{invoke:async()=>{throw new Error('timeout');}}),/timeout/);
  await assistTask(db,task.id,'模拟资料','fail',{invoke:async()=>({answer:'产出',artifact:'验收草稿',ready:true})});
  assert.equal(readTaskAssistance(db,task.id).messages.length,2);
  run(db,'UPDATE tasks SET version=version+1 WHERE id=?',[task.id]);
  assert.throws(()=>acceptTaskAssistance(db,task.id,{revision:1,expected_version:2}),/已更新/);
  db.close();
});
test('cascade deletion includes recurrence histories and isolated Agent sessions',async()=>{
  const {db,goal,task}=fixture();await assistTask(db,task.id,'模拟','one',{invoke:async()=>({answer:'你好',artifact:null,ready:false})});
  deleteGoal(db,goal.id);
  for(const table of ['task_recurrences','task_occurrences','task_assistance_sessions','task_assistance_messages'])assert.equal(all(db,`SELECT * FROM ${table}`).length,0);
  db.close();
});
test('portable Skill accepts all four recurrence units and daily operations in its live contract',()=>{
  const catalog=skillCatalog();assert.ok(catalog.operations.some(item=>item.name==='task.occurrence.action'));
  for(const unit of ['hour','day','week','month'])assert.ok(skillOperationSchema.safeParse({action:'skill_operation',operation:'task.create',payload:{title:'循环任务',recurrence:{...input,unit}}}).success);
});

test('pausing across dates excuses those occurrences, resuming restores future schedule',()=>{
  const {db,task}=fixture();
  controlRecurrence(db,task.id,'pause',1,today);
  let r=readRecurrence(db,task.id,new Date('2026-10-17T04:00:00Z'))!;
  assert.equal(r.missed,0);assert.ok(r.paused>0);
  r=controlRecurrence(db,task.id,'resume',2,new Date('2026-10-17T04:00:00Z'));
  assert.equal(r.occurrences[0].status,'paused');assert.equal(r.occurrences[1].status,'paused');assert.equal(r.today_occurrence?.status,'pending');
  db.close();
});
test('HTTP and portable Skill preview use the same recurrence contract and idempotent writes',async()=>{
  const {buildRouter}=await import('../server/http/routes.ts');
  const {db,goal}=fixture();const router=buildRouter(()=>db);
  const call=async(method:string,url:string,body?:unknown,key='execution-test-request')=>{
    const route=router.match(method,url)!;assert.ok(route);
    return route.handler({req:{headers:{}},params:route.params,body,url:new URL('http://local'+url),idempotencyKey:key} as never) as Promise<any>;
  };
  const created=await call('POST','/api/tasks',{title:'每周回顾训练计划',goal_id:goal.id,recurrence:{...input,unit:'week'}},'weekly-create');
  assert.equal(created.task.recurrence.unit,'week');assert.equal(created.task.recurrence.total,5);
  assert.equal((await call('POST','/api/tasks',{title:'每周回顾训练计划',goal_id:goal.id,recurrence:{...input,unit:'week'}},'weekly-create')).task.id,created.task.id);
  const preview=await call('POST','/api/skills/princeq/previews',{actions:[{action:'skill_operation',operation:'task.create',payload:{title:'每月复盘',goal_id:goal.id,recurrence:{...input,unit:'month'}}}]},'monthly-preview');
  const pending=await call('GET','/api/skills/princeq/previews/'+preview.token);
  assert.equal(pending.actions[0].payload.recurrence.unit,'month');assert.equal(all(db,"SELECT id FROM tasks WHERE title='每月复盘'").length,0);
  await call('POST','/api/skills/princeq/previews/'+preview.token+'/confirm',{confirmed:true},'monthly-confirm');
  assert.equal(all(db,"SELECT id FROM tasks WHERE title='每月复盘'").length,1);
  const before=all(db,'SELECT * FROM task_occurrences').length;await call('GET','/api/tasks/'+created.task.id+'/recurrence');assert.equal(all(db,'SELECT * FROM task_occurrences').length,before);
  db.close();
});

test('next goal task receives accepted deliverables but never another task conversation',async()=>{
  const db=freshDb();const goal=createGoal(db,{title:'健身验收'});
  const first=createTask(db,{title:'整理起点',goal_id:goal.id});const next=createTask(db,{title:'制定计划',goal_id:goal.id});
  await assistTask(db,first.id,'不应流入其他会话的原始讨论','private',{invoke:async()=>({answer:'完成整理',artifact:'已采纳的模拟起点记录',ready:true})});
  transaction(db,()=>acceptTaskAssistance(db,first.id,{revision:1,expected_version:first.version}));
  await assistTask(db,next.id,'请制定计划','next',{invoke:async prompt=>{
    assert.ok(prompt.includes('已采纳的模拟起点记录'));assert.ok(!prompt.includes('不应流入其他会话的原始讨论'));
    return {answer:'请核实资料',artifact:null,ready:false};
  }});
  db.close();
});

test('shortening goal dates preserves out-of-range history without inflating current completion counts',()=>{
  const {db,goal,task}=fixture();
  occurrenceAction(db,task.id,{date:'2026-10-16',action:'complete',note:'隔离补记',expected_version:0},new Date('2026-10-17T04:00:00Z'));
  updateGoal(db,goal.id,{target_date:'2026-10-15T15:59:59Z'});
  const r=readRecurrence(db,task.id,today)!;assert.equal(r.total,1);assert.equal(r.completed,0);
  assert.equal(r.occurrences.find(item=>item.date==='2026-10-16')?.out_of_schedule,true);
  assert.throws(()=>occurrenceAction(db,task.id,{date:'2026-10-16',action:'reopen',expected_version:1},new Date('2026-10-17T04:00:00Z')),/历史查看/);
  db.close();
});
