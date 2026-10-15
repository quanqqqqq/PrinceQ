/** Task-owned proposals use the same strict Skill contract and transactional executor as global chat. */
import type {Db,Row} from '../db/connection.ts';
import {all,get,run,transaction} from '../db/connection.ts';
import {skillCatalog,skillOperationSchema,prepareSkillOperation,describeSkillOperation,type SkillOperation} from '../skills/catalog.ts';
import {savePendingActions,confirmPendingActions,cancelPendingActions} from './pending-actions.ts';
import {checkSkillPreconditions} from '../skills/catalog.ts';
import {findTask,findGoal} from '../repo/tasks.ts';
import {updateRecurrence} from '../repo/recurrence.ts';
import {DEFAULT_ACTOR_ID} from '../config.ts';
import {badRequest,conflict,notFound} from '../lib/errors.ts';
import {newId,nowIso} from '../lib/ids.ts';
import type {TaskSkillPreview,TaskSkillChange} from '../../shared/task-assistance.ts';
import {recurrenceUnitLabels,calendarDate,type RecurrenceInput} from '../../shared/recurrence.ts';

const allowed=new Set(['task.create','task.update','task.action','task.dependency.add','task.dependency.remove','task.matrix.score','task.quadrant.confirm','task.quadrant.resuggest','task.rescoring.request','task.recurrence.configure','task.recurrence.update','task.recurrence.control','task.occurrence.action','goal.update','queue.recalculate']);
export const taskSkillActionSchema=skillOperationSchema.superRefine((call,ctx)=>{if(!allowed.has(call.operation))ctx.addIssue({code:'custom',message:'此任务协助不支持该操作，请使用全局助手'});});
export function taskSkillCatalog(){const catalog=skillCatalog();return {...catalog,mode:'task_assistance',operations:catalog.operations.filter(item=>allowed.has(item.name))};}
const labels:Record<string,string>={title:'任务名称',description:'任务详情',goal_id:'关联目标',estimated_minutes:'每次预计用时（分钟）',deadline:'截止时间',task_type:'任务类型',cognitive_load:'认知负荷',manual_priority:'优先级',start_date:'起始／生效日期',start_time:'首次执行时间',interval:'循环间隔',unit:'周期单位',timezone:'时区',end_mode:'结束方式',end_date:'结束日期',target_date:'目标日期',recurrence:'循环计划',action:'操作',reason:'原因',note:'执行备注',date:'执行日期'};
const values:Record<string,string>={...recurrenceUnitLabels,goal:'跟随目标结束',date:'指定结束日期',deep_work:'深度工作',review:'复盘／评审',learning:'学习',communication:'沟通',admin:'事务',low:'低',medium:'中',high:'高',pause:'暂停循环',resume:'恢复循环',finish:'结束循环'};
function display(db:Db,key:string,value:unknown):string {
  if(value===undefined||value===null||value==='')return '未设置';
  if(key==='goal_id')return findGoal(db,String(value))?.title??String(value);
  if(key==='recurrence'&&typeof value==='object'){const plan=value as RecurrenceInput;return `每 ${plan.interval} ${recurrenceUnitLabels[plan.unit]}，${plan.start_date}${plan.unit==='hour'?' '+plan.start_time:''} 起，${plan.end_mode==='goal'?'随目标结束':'至 '+plan.end_date}`;}
  return typeof value==='object'?JSON.stringify(value):values[String(value)]??String(value);
}
function changeFor(db:Db,call:SkillOperation):TaskSkillChange {
  const target=call.target_id?(call.operation.startsWith('goal.')?findGoal(db,call.target_id):findTask(db,call.target_id)):null;
  const before:Record<string,unknown>=call.operation.startsWith('task.recurrence.')?(findTask(db,call.target_id!)?.recurrence??{}) as unknown as Record<string,unknown>:(target??{}) as unknown as Record<string,unknown>;
  const fields=Object.entries(call.payload).filter(([key])=>!['expected_version','expected_explicit_version'].includes(key)).map(([key,value])=>{
    const targetTask=call.target_id?findTask(db,call.target_id):null;
    const goal=targetTask?.goal_id?findGoal(db,targetTask.goal_id):null;
    const effectiveEnd=key==='end_date'&&call.payload.end_mode==='goal'&&goal?.target_date?calendarDate(goal.target_date,String(call.payload.timezone)):value;
    return {label:labels[key]??key,before:display(db,key,key==='end_date'?before.effective_end_date??before[key]:before[key]),after:display(db,key,effectiveEnd)};
  });
  if(call.operation==='task.create'&&call.payload.recurrence){const plan=call.payload.recurrence as RecurrenceInput;const goal=typeof call.payload.goal_id==='string'?findGoal(db,call.payload.goal_id):null;if(plan.end_mode==='goal'&&goal?.target_date)fields.push({label:'目标结束日期',before:'未创建',after:calendarDate(goal.target_date,plan.timezone)});}
  if(call.operation==='task.recurrence.update') {
    const previous=findTask(db,call.target_id!)!.recurrence!;
    db.exec('SAVEPOINT task_recurrence_preview');
    try {
      const updated=updateRecurrence(db,call.target_id!,call.payload as unknown as RecurrenceInput,Number(call.payload.expected_version));
      fields.push({label:'计划总次数',before:String(previous.total),after:String(updated.total)});
      fields.push({label:'生效后执行时间（前 8 次）',before:previous.occurrences.filter(item=>!item.out_of_schedule&&item.date>=String(call.payload.start_date)).slice(0,8).map(item=>item.date).join('、')||'无',after:updated.occurrences.filter(item=>!item.out_of_schedule&&item.date>=String(call.payload.start_date)).slice(0,8).map(item=>item.date).join('、')||'无'});
    } finally {db.exec('ROLLBACK TO SAVEPOINT task_recurrence_preview');db.exec('RELEASE SAVEPOINT task_recurrence_preview');}
  }
  return {operation:call.operation,title:target?.title??String(call.payload.title??'工作队列'),description:describeSkillOperation(db,call),fields};
}
export function readTaskSkillPreviews(db:Db,taskId:string):TaskSkillPreview[] {
  return all<Row>(db,`SELECT a.*,p.snapshot_json,p.result_json,p.replaced_by FROM task_assistance_previews p JOIN agent_pending_actions a ON a.token=p.token WHERE p.task_id=? ORDER BY a.created_at,a.rowid`,[taskId]).map(row=>{
    let stale:string|undefined;
    if(row.status==='pending')try{checkSkillPreconditions(db,JSON.parse(row.actions_json));}catch(error){stale=(error as Error).message;}
    return {token:row.token,status:row.status,summary:row.summary,created_at:row.created_at,resolved_at:row.resolved_at,changes:JSON.parse(row.snapshot_json),result:row.result_json?JSON.parse(row.result_json):null,stale_reason:stale,replaced_by:row.replaced_by??null};
  });
}
export function saveTaskSkillPreview(db:Db,taskId:string,sessionId:string,messageId:string,actions:SkillOperation[]):string {
  return transaction(db,()=>{
  const validated=actions.map(action=>taskSkillActionSchema.parse(action));
  const token=savePendingActions(db,{sessionId,summary:`待确认的 ${actions.length} 项任务操作`,actions:validated});
  const stored=get<Row>(db,'SELECT actions_json FROM agent_pending_actions WHERE token=?',[token])!;
  const prepared=JSON.parse(stored.actions_json) as SkillOperation[];
  const owner=findTask(db,taskId);if(!owner)throw notFound('任务不存在');
  const source=prepareSkillOperation(db,{action:'skill_operation',operation:'task.update',target_id:taskId,payload:{description:owner.description}}).preconditions!.find(guard=>guard.resource==='task'&&guard.id===taskId)!;
  for(const call of prepared)if(!call.preconditions?.some(guard=>guard.resource==='task'&&guard.id===taskId))call.preconditions=[...(call.preconditions??[]),source];
  run(db,'UPDATE agent_pending_actions SET actions_json=? WHERE token=?',[JSON.stringify(prepared),token]);
  const snapshot=prepared.map(call=>changeFor(db,call));
  // A revised proposal supersedes the old draft; neither proposal performs business writes.
  for(const row of all<Row>(db,`SELECT p.token FROM task_assistance_previews p JOIN agent_pending_actions a ON a.token=p.token WHERE p.session_id=? AND a.status='pending'`,[sessionId])) {
    cancelPendingActions(db,row.token);run(db,'UPDATE task_assistance_previews SET replaced_by=? WHERE token=?',[token,row.token]);
  }
  run(db,'INSERT INTO task_assistance_previews(token,session_id,task_id,message_id,snapshot_json) VALUES(?,?,?,?,?)',[token,sessionId,taskId,messageId,JSON.stringify(snapshot)]);
  return token;
  });
}
function owned(db:Db,taskId:string,token:string):Row {
  const row=get<Row>(db,'SELECT p.*,a.status FROM task_assistance_previews p JOIN agent_pending_actions a ON a.token=p.token WHERE p.token=? AND p.task_id=?',[token,taskId]);
  if(!row)throw notFound('预览不属于当前任务协助会话');return row;
}
export function isTaskSkillPreview(db:Db,token:string):boolean {return !!get(db,'SELECT token FROM task_assistance_previews WHERE token=?',[token]);}
export function resolveTaskSkillPreview(db:Db,taskId:string,token:string,action:'confirm'|'cancel',key:string,execute?:(call:SkillOperation,index:number)=>unknown):TaskSkillPreview {
  return transaction(db,()=>{
    const row=owned(db,taskId,token);
    if(action==='confirm') {
      if(row.status==='confirmed')return readTaskSkillPreviews(db,taskId).find(item=>item.token===token)!;
      if(row.status!=='pending')throw conflict('预览已取消，不能再执行');
      const calls=JSON.parse(get<Row>(db,'SELECT actions_json FROM agent_pending_actions WHERE token=?',[token])!.actions_json) as SkillOperation[];
      if(calls.some(call=>!allowed.has(call.operation)))throw badRequest('预览包含当前任务协助不支持的操作');
      const result=confirmPendingActions(db,token,DEFAULT_ACTOR_ID,key,execute);
      const ids=[...new Set([...result.createdTaskIds,...calls.filter(call=>call.operation.startsWith('task.')&&call.target_id).map(call=>call.target_id!)])];
      const readback=ids.flatMap(id=>{const task=findTask(db,id);return task?[{id:task.id,title:task.title,status:task.status,description:task.description,estimated_minutes:task.estimated_minutes,recurrence:task.recurrence}]:[];});
      run(db,'UPDATE task_assistance_previews SET result_json=? WHERE token=?',[JSON.stringify({...result,tasks:readback}),token]);
      const current=findTask(db,taskId)!;
      run(db,'UPDATE task_assistance_sessions SET ready=CASE WHEN artifact_task_version=? THEN ready ELSE 0 END WHERE id=?',[current.version,row.session_id]);
    } else cancelPendingActions(db,token);
    const content=action==='confirm'?'已按确认的预览执行修改，并读回最新任务数据。':'已取消这份预览，没有执行任务或循环计划修改。';
    run(db,"INSERT OR IGNORE INTO task_assistance_messages(id,session_id,role,content,request_key,created_at,summary_json) VALUES(?,?,'assistant',?,?,?,'[]')",[newId('am'),row.session_id,content,'preview-'+token+'-'+action,nowIso()]);
    return readTaskSkillPreviews(db,taskId).find(item=>item.token===token)!;
  });
}
