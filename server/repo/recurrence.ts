import type { RecurrenceInput, TaskOccurrence, TaskRecurrence } from '../../shared/recurrence.ts';
import {addDays, calendarDate, dayNumber, localMinute, recurrenceKey} from '../../shared/recurrence.ts';
import {all, get, run, type Db, type Row} from '../db/connection.ts';
import {badRequest, conflict, notFound} from '../lib/errors.ts';
import {newId,nowIso} from '../lib/ids.ts';

const fullKey=(key:string):string=>key.length===10?key+'T00:00':key;
function planFromRow(row:Row):RecurrenceInput {return {start_date:row.start_date,start_time:row.start_time,interval:row.interval,unit:row.unit,timezone:row.timezone,end_mode:row.end_mode,end_date:row.end_date};}
export function readRecurrence(db: Db, taskId: string, now = new Date()): TaskRecurrence | null {
  const row=get<Row>(db,`SELECT r.*,g.target_date,g.status AS goal_status,t.status AS task_status FROM task_recurrences r JOIN tasks t ON t.id=r.task_id LEFT JOIN goals g ON g.id=t.goal_id WHERE r.task_id=?`,[taskId]);
  if(!row)return null;
  const today=calendarDate(now,row.timezone),current=localMinute(now,row.timezone);
  const changes=all<Row>(db,'SELECT effective_from,plan_json FROM task_recurrence_revisions WHERE task_id=? ORDER BY effective_from',[taskId]).map(record=>({...JSON.parse(record.plan_json) as RecurrenceInput,effective_from:record.effective_from}));
  const base=planFromRow(row),plans=[{...base,effective_from:fullKey(recurrenceKey(base,0))},...changes];
  const visible=plans.filter(plan=>plan.effective_from<=current).at(-1)??plans[0];
  const endFor=(plan:RecurrenceInput)=>plan.end_mode==='goal'?(row.target_date?calendarDate(row.target_date,row.timezone):null):plan.end_date??null;
  const end=endFor(plans.at(-1)!);
  const stored=new Map(all<Row>(db,'SELECT * FROM task_occurrences WHERE task_id=? ORDER BY date',[taskId]).map(record=>[record.date,record]));
  const pauses=all<Row>(db,'SELECT from_key,to_key FROM task_recurrence_pauses WHERE task_id=?',[taskId]);
  const occurrences:TaskOccurrence[]=[];
  for(let phase=0;phase<plans.length;phase++) {
    const plan=plans[phase],cutoff=plans[phase+1]?.effective_from??null,planEnd=endFor(plan);
    if(!planEnd)continue;
    for(let index=0;;index++) {
      const date=recurrenceKey(plan,index),key=fullKey(date);
      if(date.startsWith('+')||date.slice(0,10)>planEnd||(cutoff&&key>=cutoff))break;
      if(key<plan.effective_from)continue;
      if(occurrences.length>=3660)throw badRequest('循环任务最多支持 3660 次执行');
      const next=fullKey(recurrenceKey(plan,index+1)),expires=cutoff&&cutoff<next?cutoff:next;
      const past=plan.unit==='hour'?expires<=current:date<today||!!(cutoff&&cutoff<=current&&next>cutoff);
      const record=stored.get(date);
      const status=record?.status==='completed'||record?.status==='skipped'?record.status:pauses.some(p=>key>=fullKey(p.from_key)&&(!p.to_key||key<fullKey(p.to_key)))?'paused':past?'missed':key>current?'scheduled':record?.status??'pending';
      occurrences.push({date,status,opened_at:record?.opened_at??null,completed_at:record?.completed_at??null,note:record?.note??'',version:record?.version??0});
    }
  }
  const planned=occurrences.slice();
  for(const [date,record] of stored)if(!planned.some(item=>item.date===date))occurrences.push({date,out_of_schedule:true,status:record.status,opened_at:record.opened_at,completed_at:record.completed_at,note:record.note,version:record.version});
  occurrences.sort((a,b)=>a.date.localeCompare(b.date));
  const status=['archived','completed'].includes(row.task_status)||['achieved','dropped'].includes(row.goal_status)?'ended':row.goal_status==='paused'?'paused':row.status;
  return {...visible,series_start_date:row.start_date,plan_changes:changes,status,effective_end_date:end,today,
    today_occurrence:planned.filter(item=>item.date.slice(0,10)===today&&fullKey(item.date)<=current&&['pending','in_progress','completed','skipped'].includes(item.status)).at(-1)??null,
    next_date:status==='active'?planned.find(item=>(fullKey(item.date)>=current||item.status==='pending'||item.status==='in_progress')&&['pending','in_progress','scheduled'].includes(item.status))?.date??null:null,
    total:planned.length,paused:planned.filter(item=>item.status==='paused').length,completed:planned.filter(item=>item.status==='completed').length,skipped:planned.filter(item=>item.status==='skipped').length,
    missed:planned.filter(item=>item.status==='missed').length,opened:planned.filter(item=>item.opened_at).length,opened_days:new Set(planned.filter(item=>item.opened_at).map(item=>calendarDate(item.opened_at!,row.timezone))).size,occurrences,version:row.version};
}
export function updateRecurrence(db:Db,taskId:string,input:RecurrenceInput,expectedVersion:number,now=new Date()):TaskRecurrence {
  const current=readRecurrence(db,taskId,now),task=get<Row>(db,'SELECT goal_id,status FROM tasks WHERE id=?',[taskId]);
  if(!current||!task)throw notFound('任务没有循环计划');
  if(current.version!==expectedVersion)throw conflict('循环计划已改变，请刷新后重新预览');
  if(current.status==='ended')throw conflict('循环已结束，请恢复或新建任务');
  if(input.timezone!==current.timezone)throw badRequest('调整计划时请保持原时区，避免改写历史日期');
  validateRecurrence(db,task.goal_id,input);
  const effective=fullKey(recurrenceKey(input,0)),nowKey=localMinute(now,input.timezone);
  if(input.start_date<current.today||(input.unit==='hour'&&effective<nowKey))throw badRequest('循环调整不能追溯到过去，请选择今天尚未执行的时段或未来日期');
  if(get(db,`SELECT date FROM task_occurrences WHERE task_id=? AND (CASE WHEN length(date)=10 THEN date||'T00:00' ELSE date END)>=? LIMIT 1`,[taskId,effective]))throw conflict('生效时间之后已有执行记录，请选择更晚的日期以保留历史');
  run(db,'DELETE FROM task_recurrence_revisions WHERE task_id=? AND effective_from>=?',[taskId,effective]);
  run(db,'INSERT INTO task_recurrence_revisions(id,task_id,effective_from,plan_json,created_at) VALUES(?,?,?,?,?)',[newId('rr'),taskId,effective,JSON.stringify(input),nowIso()]);
  run(db,'UPDATE task_recurrences SET version=version+1 WHERE task_id=?',[taskId]);
  run(db,'UPDATE tasks SET version=version+1,updated_at=? WHERE id=?',[nowIso(),taskId]);
  return readRecurrence(db,taskId,now)!;
}
export function validateRecurrence(db: Db, goalId: string | null, input: RecurrenceInput): void {
  const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(dayNumber(value)) && addDays(value,0)===value;
  if (!validDate(input.start_date) || !Number.isInteger(input.interval) || input.interval<1 || input.interval>365 || !['hour','day','week','month'].includes(input.unit)) throw badRequest('循环起点或间隔不合法');
  try {calendarDate(new Date(),input.timezone);} catch {throw badRequest('循环时区不合法');}
  const goal = goalId ? get<Row>(db,'SELECT target_date FROM goals WHERE id=?',[goalId]) : null;
  const end = input.end_mode==='goal' ? (goal?.target_date ? calendarDate(goal.target_date,input.timezone) : null) : input.end_date;
  if (!end || !validDate(end)) throw badRequest(input.end_mode==='goal'?'请先设置关联目标的结束日期，再创建循环任务':'请设置循环结束日期');
  if (end<input.start_date)throw badRequest('循环结束日期不能早于起点');
  for(let index=0;index<=3660;index++) {const key=recurrenceKey(input,index);if(key.startsWith('+')||key.slice(0,10)>end)break;if(index===3660)throw badRequest('循环最多支持 3660 次');}
}
export function configureRecurrence(db: Db, taskId: string, input: RecurrenceInput, expectedVersion?: number): void {
  const task = get<Row>(db,'SELECT goal_id,status,version FROM tasks WHERE id=?',[taskId]);
  if (!task) throw notFound('任务不存在');
  if (expectedVersion!==undefined && expectedVersion!==task.version) throw conflict('任务已改变，请刷新后重试');
  if (['completed','archived'].includes(task.status)) throw conflict('请先恢复任务，再设置循环');
  validateRecurrence(db,task.goal_id,input);
  if (get(db,'SELECT 1 FROM task_recurrences WHERE task_id=?',[taskId])) throw conflict('已有循环计划；请使用调整计划，从未执行的日期生效，并保留已有历史');
  run(db,`INSERT INTO task_recurrences(task_id,every_days,start_date,start_time,interval,unit,timezone,end_mode,end_date) VALUES(?,?,?,?,?,?,?,?,?)`,[taskId,input.unit==='day'?input.interval:1,input.start_date,input.start_time??'09:00',input.interval,input.unit,input.timezone,input.end_mode,input.end_date??null]);
  run(db,'UPDATE tasks SET version=version+1,updated_at=? WHERE id=?',[nowIso(),taskId]);
}
export function occurrenceAction(db: Db, taskId: string, input: {date:string;action:'open'|'start'|'complete'|'skip'|'reopen';note?:string;expected_version:number}, now=new Date()): TaskRecurrence {
  const recurrence=readRecurrence(db,taskId,now);
  if(!recurrence)throw notFound('任务没有循环计划');
  if(recurrence.status!=='active')throw conflict('循环已暂停或结束');
  const item=recurrence.occurrences.find(item=>item.date===input.date);
  if(item?.out_of_schedule)throw conflict('此记录已不在当前循环范围，仅供历史查看');
  if(!item || fullKey(item.date)>localMinute(now,recurrence.timezone))throw badRequest('只能记录已到日期的执行日');
  if(input.expected_version!==item.version)throw conflict('该日记录已更新，请刷新');
  if (input.action==='open' && item.opened_at) return recurrence;
  if(['completed','skipped'].includes(item.status)&&!['reopen','open'].includes(input.action))throw conflict('该日已处理；请先重新打开');
  const task=get<Row>(db,'SELECT id FROM task_dependencies d JOIN tasks t ON t.id=d.depends_on_id WHERE d.task_id=? AND t.status NOT IN (\'completed\',\'archived\')',[taskId]);
  if(task&&['start','complete'].includes(input.action))throw conflict('前置任务尚未完成');
  if(input.action==='skip'&&!input.note?.trim())throw badRequest('请填写跳过原因');
  const status=input.action==='complete'?'completed':input.action==='skip'?'skipped':input.action==='start'?'in_progress':input.action==='reopen'?'pending':['missed','paused'].includes(item.status)?'pending':item.status;
  const timestamp=now.toISOString();
  run(db,`INSERT INTO task_occurrences(task_id,date,status,opened_at,completed_at,note,version) VALUES(?,?,?,?,?,?,1)
    ON CONFLICT(task_id,date) DO UPDATE SET status=excluded.status,opened_at=COALESCE(task_occurrences.opened_at,excluded.opened_at),completed_at=excluded.completed_at,note=excluded.note,version=task_occurrences.version+1`,
    [taskId,item.date,status,item.date.slice(0,10)===recurrence.today?timestamp:item.opened_at,status==='completed'?timestamp:null,input.note??item.note]);
  run(db,'UPDATE tasks SET version=version+1,updated_at=? WHERE id=?',[timestamp,taskId]);
  return readRecurrence(db,taskId,now)!;
}
export function controlRecurrence(db: Db, taskId:string, action:'pause'|'resume'|'finish', expectedVersion:number, now=new Date()): TaskRecurrence {
  const recurrence=readRecurrence(db,taskId,now);
  if(!recurrence)throw notFound('任务没有循环计划');
  if(recurrence.version!==expectedVersion)throw conflict('循环计划已改变，请刷新');
  const task=get<Row>(db,'SELECT t.status,g.status AS goal_status FROM tasks t LEFT JOIN goals g ON g.id=t.goal_id WHERE t.id=?',[taskId])!;
  if(['completed','archived'].includes(task.status)||['achieved','dropped','paused'].includes(task.goal_status))throw conflict('任务或目标已结束、归档或暂停，请先恢复');
  if(action==='pause' && recurrence.status!=='active')throw conflict('循环已经暂停或结束');
  if(action==='resume' && recurrence.status!=='paused')throw conflict('循环没有暂停');
  if(action==='finish') {
    if(!recurrence.effective_end_date||recurrence.today<recurrence.effective_end_date)throw conflict('循环尚未到结束日；如需提前停止，请归档任务');
    if(recurrence.occurrences.some(item=>item.date.slice(0,10)<=recurrence.effective_end_date!&&!['completed','skipped','paused'].includes(item.status)))throw conflict('仍有未完成执行日，请补记或说明跳过原因后结束');
    run(db,"UPDATE tasks SET status='completed',completed_at=?,version=version+1,updated_at=? WHERE id=?",[nowIso(),nowIso(),taskId]);
    run(db,'UPDATE task_assignments SET released_at=?,release_reason=? WHERE task_id=? AND released_at IS NULL',[nowIso(),'循环结束',taskId]);
  }
  if(action!=='finish')recordRecurrencePause(db,taskId,'task',action==='pause',now);
  run(db,'UPDATE task_recurrences SET status=?,version=version+1 WHERE task_id=?',[action==='pause'?'paused':action==='resume'?'active':'ended',taskId]);
  run(db,'UPDATE tasks SET version=version+1,updated_at=? WHERE id=?',[nowIso(),taskId]);
  return readRecurrence(db,taskId,now)!;
}

export function recordRecurrencePause(db:Db,taskId:string,scope:'task'|'goal',pause:boolean,now=new Date()):void {
  const recurrence=readRecurrence(db,taskId,now);
  if(!recurrence)return;
  const key=recurrence.unit==='hour'?(recurrence.today_occurrence?.date??localMinute(now,recurrence.timezone)):recurrence.today;
  if(pause) {
    if(!get(db,'SELECT id FROM task_recurrence_pauses WHERE task_id=? AND scope=? AND to_key IS NULL',[taskId,scope]))run(db,'INSERT INTO task_recurrence_pauses(id,task_id,scope,from_key) VALUES(?,?,?,?)',[newId('rp'),taskId,scope,key]);
  } else run(db,'UPDATE task_recurrence_pauses SET to_key=? WHERE task_id=? AND scope=? AND to_key IS NULL',[key,taskId,scope]);
}
