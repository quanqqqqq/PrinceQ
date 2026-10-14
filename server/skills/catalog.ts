/** One operation contract for embedded assistants and portable PrinceQ Skills. */
import {z} from 'zod';
import * as S from '../http/schemas.ts';
import {all, get, type Db, type Row} from '../db/connection.ts';
import {findTask, findGoal, listTasks} from '../repo/tasks.ts';
import {buildSettingsSnapshot, loadDurationConfig} from '../domain/habits.ts';
import {durationToMinutes} from '../../shared/duration.ts';
import type {DurationUnit} from '../../shared/types.ts';
import {badRequest, conflict, notFound} from '../lib/errors.ts';
import {displayDemoText} from '../../shared/demo-text.ts';

type Resource = 'task' | 'goal' | 'rescoring' | 'preview' | 'settings';
interface OperationDefinition {name:string; label:string; method:string; path:string; target?:Resource; schema:z.ZodType; fileWrite?:boolean}
const version = z.number().int().positive().optional();
const empty = z.strictObject({});
const deleteBody = z.strictObject({expected_version:version});
export const SKILL_OPERATIONS: OperationDefinition[] = [
  {name:'task.create',label:'新建任务',method:'POST',path:'/api/tasks',schema:S.createTaskSchema.strict()},
  {name:'task.update',label:'编辑任务',method:'PATCH',path:'/api/tasks/:id',target:'task',schema:S.updateTaskSchema.strict()},
  {name:'task.delete',label:'永久删除任务',method:'DELETE',path:'/api/tasks/:id',target:'task',schema:deleteBody},
  {name:'task.action',label:'改变任务状态',method:'POST',path:'/api/tasks/:id/actions',target:'task',schema:S.taskActionSchema.strict()},
  {name:'task.dependency.add',label:'增加任务依赖',method:'POST',path:'/api/tasks/:id/dependencies',target:'task',schema:S.addDependencySchema.strict()},
  {name:'task.dependency.remove',label:'移除任务依赖',method:'POST',path:'/api/tasks/:id/dependencies/remove',target:'task',schema:S.addDependencySchema.strict()},
  {name:'task.matrix.score',label:'记录任务评分',method:'POST',path:'/api/tasks/:id/matrix-score',target:'task',schema:S.matrixScoreSchema.strict()},
  {name:'task.quadrant.confirm',label:'确认任务评分',method:'POST',path:'/api/tasks/:id/quadrant/confirm',target:'task',schema:empty},
  {name:'task.quadrant.resuggest',label:'按本地规则重新建议评分',method:'POST',path:'/api/tasks/:id/quadrant/resuggest',target:'task',schema:empty},
  {name:'task.rescoring.request',label:'发起任务复评',method:'POST',path:'/api/tasks/:id/rescoring-request',target:'task',schema:S.createRescoringRequestSchema.strict()},
  {name:'rescoring.submit',label:'提交复评建议',method:'POST',path:'/api/rescoring-requests/:id/submit',target:'rescoring',schema:S.rescoringSubmitSchema.strict()},
  {name:'rescoring.confirm',label:'接受复评建议',method:'POST',path:'/api/rescoring-requests/:id/confirm',target:'rescoring',schema:empty},
  {name:'rescoring.cancel',label:'取消复评',method:'POST',path:'/api/rescoring-requests/:id/cancel',target:'rescoring',schema:empty},
  {name:'goal.create',label:'新建目标',method:'POST',path:'/api/goals',schema:S.createGoalSchema.strict()},
  {name:'goal.update',label:'编辑目标',method:'PATCH',path:'/api/goals/:id',target:'goal',schema:S.updateGoalSchema.strict()},
  {name:'goal.delete',label:'永久删除目标（保留并解除关联任务）',method:'DELETE',path:'/api/goals/:id',target:'goal',schema:deleteBody},
  {name:'goal.decomposition.confirm',label:'创建选定的目标拆分任务',method:'POST',path:'/api/goals/:id/decomposition/confirm',target:'goal',schema:S.confirmDecompositionSchema.strict()},
  {name:'queue.recalculate',label:'重新计算工作队列',method:'POST',path:'/api/queue/recalculate',schema:S.recalculateSchema.strict()},
  {name:'settings.conversion.update',label:'修改耗时换算',method:'POST',path:'/api/settings/conversion',target:'settings',schema:S.settingsConversionSchema.strict(),fileWrite:true},
  {name:'settings.conversion.reset',label:'恢复默认耗时换算',method:'POST',path:'/api/settings/conversion/reset',target:'settings',schema:S.settingsVersionOnlySchema.strict(),fileWrite:true},
  {name:'settings.explicit.create',label:'新增明确习惯',method:'POST',path:'/api/settings/explicit',target:'settings',schema:S.settingsExplicitCreateSchema.strict(),fileWrite:true},
  {name:'settings.explicit.update',label:'编辑明确习惯',method:'PATCH',path:'/api/settings/explicit/:id',target:'settings',schema:S.settingsExplicitPatchSchema.strict(),fileWrite:true},
  {name:'settings.explicit.enabled',label:'启用或停用明确习惯',method:'POST',path:'/api/settings/explicit/:id/enabled',target:'settings',schema:S.settingsEnabledSchema.strict(),fileWrite:true},
  {name:'settings.constraint.create',label:'新增工作约束',method:'POST',path:'/api/settings/constraints',target:'settings',schema:S.settingsConstraintCreateSchema.strict(),fileWrite:true},
  {name:'settings.constraint.update',label:'编辑工作约束',method:'PATCH',path:'/api/settings/constraints/:id',target:'settings',schema:S.settingsConstraintPatchSchema.strict(),fileWrite:true},
  {name:'settings.constraint.enabled',label:'启用或停用工作约束',method:'POST',path:'/api/settings/constraints/:id/enabled',target:'settings',schema:S.settingsEnabledSchema.strict(),fileWrite:true},
  {name:'settings.inferred.enabled',label:'启用或停用推断习惯',method:'POST',path:'/api/settings/inferred/:id/enabled',target:'settings',schema:S.settingsEnabledSchema.strict(),fileWrite:true},
  {name:'settings.inferred.adopt',label:'采纳推断习惯',method:'POST',path:'/api/settings/inferred/:id/adopt',target:'settings',schema:S.settingsAdoptSchema.strict(),fileWrite:true},
  {name:'settings.weights.save',label:'修改工作偏好和排序权重',method:'POST',path:'/api/settings/weights',target:'settings',schema:S.settingsWeightsSaveSchema.strict(),fileWrite:true},
];
export const skillOperationSchema = z.strictObject({
  action:z.literal('skill_operation'), operation:z.string().min(1).max(80),
  target_id:z.string().trim().min(1).max(80).optional(), payload:z.record(z.string(),z.unknown()),
  // Some providers attach this harmless label. Never use it to resolve or execute an action.
  display_title:z.string().trim().max(200).optional(),
  // Generated by the server at preview time. Caller-supplied guards are discarded.
  preconditions:z.array(z.strictObject({resource:z.enum(['task','goal','rescoring','preview','settings']),id:z.string(),fingerprint:z.string()})).optional(),
}).superRefine((call,ctx) => {
  const def=SKILL_OPERATIONS.find(item=>item.name===call.operation);
  if (!def) {ctx.addIssue({code:'custom',message:'Unsupported PrinceQ operation'});return;}
  if (def.path.includes(':id') && !call.target_id) ctx.addIssue({code:'custom',path:['target_id'],message:'target_id is required'});
  if (!def.path.includes(':id') && call.target_id && !(def.target==='settings' && ['settings','personal'].includes(call.target_id))) ctx.addIssue({code:'custom',path:['target_id'],message:'This singleton operation has no target_id; omit it'});
  const parsed=def.schema.safeParse(call.payload);
  if (!parsed.success) ctx.addIssue({code:'custom',path:['payload'],message:parsed.error.message});
});
export type SkillOperation = z.infer<typeof skillOperationSchema>;
export function definitionFor(call:SkillOperation) {const def=SKILL_OPERATIONS.find(item=>item.name===call.operation);if(!def) throw badRequest('不支持的 PrinceQ 操作');return def;}
export function skillCatalog() {
  return {name:'personal-work-queue',product:'PrinceQ',version:2,auth:{mode:'none',authorization_hook:'authorizePrinceQRequest'},
    confirmation_required:true, max_batch_actions:20, action_keys:['action','operation','target_id','payload'],
    ignored_display_metadata:['display_title'], server_owned_metadata:['preconditions'],
    reads:['GET /api/tasks','GET /api/tasks/:id','GET /api/goals','GET /api/goals/:id','GET /api/queue','GET /api/queue/explain/:id','GET /api/activity','GET /api/settings','GET /api/rescoring-requests','GET /api/skills/princeq/context'],
    previews:['POST /api/goals/:id/decomposition/preview','POST /api/settings/weights/preview'],
    operations:SKILL_OPERATIONS.map(({schema,...def})=>({...def,requires_target_id:def.path.includes(':id'),target_id_aliases:!def.path.includes(':id')&&def.target==='settings'?['settings','personal']:[],payload_schema:z.toJSONSchema(schema,{io:'input',unrepresentable:'any'})}))};
}
function fingerprint(db:Db,resource:Resource,id:string):string {
  if (resource==='settings') return JSON.stringify(buildSettingsSnapshot().versions);
  if (resource==='task') {const task=findTask(db,id);if(!task) throw notFound('任务已不存在');return JSON.stringify({version:task.version,depends_on:task.depends_on,blocks:task.blocks});}
  if (resource==='goal') {const goal=findGoal(db,id);if(!goal) throw notFound('目标已不存在');return JSON.stringify({version:goal.version,tasks:all<Row>(db,'SELECT id, version FROM tasks WHERE goal_id = ? ORDER BY id',[id])});}
  if (resource==='rescoring') {const row=get<Row>(db,'SELECT * FROM rescoring_requests WHERE id = ?',[id]);if(!row)throw notFound('复评请求已不存在');return JSON.stringify(row);}
  const row=get<Row>(db,'SELECT * FROM pending_previews WHERE token = ?',[id]);if(!row) throw notFound('目标拆分预览已不存在');return JSON.stringify(row);
}
export function prepareSkillOperation(db:Db,input:SkillOperation):SkillOperation {
  const call=skillOperationSchema.parse(input),def=definitionFor(call);
  call.payload=def.schema.parse(call.payload) as Record<string,unknown>;
  delete call.display_title;
  if (!def.path.includes(':id')) delete call.target_id;
  const guards: NonNullable<SkillOperation['preconditions']>=[];
  const add=(resource:Resource,id:string)=>{if(!guards.some(g=>g.resource===resource&&g.id===id))guards.push({resource,id,fingerprint:fingerprint(db,resource,id)});};
  if(def.target && def.target!=='settings')add(def.target,call.target_id!);
  if(def.target==='settings' || call.operation==='task.create' || call.operation==='task.quadrant.resuggest' || 'duration_value' in call.payload) add('settings','personal');
  if((def.target==='task'||def.target==='goal') && call.payload.expected_version!==undefined){
    const current=def.target==='task'?findTask(db,call.target_id!):findGoal(db,call.target_id!);
    if(current?.version!==call.payload.expected_version)throw conflict('对象已改变，请重新读取后生成预览');
  }
  if(typeof call.payload.goal_id==='string')add('goal',call.payload.goal_id);
  for(const id of Array.isArray(call.payload.depends_on)?call.payload.depends_on:[])if(typeof id==='string')add('task',id);
  if(typeof call.payload.depends_on_id==='string')add('task',call.payload.depends_on_id);
  if(def.target==='rescoring') {const row=get<Row>(db,'SELECT task_id FROM rescoring_requests WHERE id = ?',[call.target_id!]);if(row)add('task',String(row.task_id));}
  if(typeof call.payload.preview_token==='string') {
    const row=get<Row>(db,'SELECT payload FROM pending_previews WHERE token = ?',[call.payload.preview_token]);
    if(!row||JSON.parse(String(row.payload)).goal_id!==call.target_id)throw badRequest('拆分预览不属于这个目标');
    add('preview',call.payload.preview_token);
  }
  if(call.operation==='task.delete') {const task=findTask(db,call.target_id!)!;for(const id of [...task.depends_on,...task.blocks])add('task',id);}
  call.preconditions=guards;
  return call;
}
export function checkSkillPreconditions(db:Db,calls:SkillOperation[]) {
  for(const call of calls)for(const guard of call.preconditions??[]) {
    if(fingerprint(db,guard.resource,guard.id)!==guard.fingerprint)throw conflict('预览生成后数据已改变，请取消旧预览并重新生成');
  }
}
const FIELD_LABELS:Record<string,string>={title:'名称',description:'说明',deadline:'截止时间',estimated_minutes:'预计分钟',duration_value:'耗时数值',duration_unit:'耗时单位',goal_id:'关联目标',target_date:'目标日期',status:'目标状态',manual_priority:'优先级',manual_override:'排序调整',task_type:'工作类型',cognitive_load:'认知负荷',importance_score:'重要程度',urgency_score:'紧急程度',reason:'原因',source:'评分来源',confidence:'置信度',action:'状态操作',depends_on_id:'依赖任务',depends_on:'依赖任务',statement:'工作习惯',enabled:'启用',kind:'类型',value:'约束值',weights:'排序权重',preferred_task_types:'偏好类型',peak_hours:'通用工作时段',task_type_peak_hours:'各类工作时段',hours_per_day:'每日换算小时',days_per_month:'每月换算工作日',color:'颜色',accepted_titles:'选定任务',accepted_drafts:'编辑后的拆分任务',changed_axes:'复评轴',target_quadrant:'目标象限',agent_name:'建议来源',actor_id:'分配对象'};
const ACTION_LABELS:Record<string,string>={claim:'领取',release:'释放',start:'开始',block:'标记受阻',unblock:'解除受阻',complete:'完成',archive:'归档',restore:'恢复归档',reopen:'重新打开'};
export function describeSkillOperation(db:Db,call:SkillOperation):string {
  const def=definitionFor(call);
  const entity=def.target==='task'?findTask(db,call.target_id!):def.target==='goal'?findGoal(db,call.target_id!):null;
  const title=entity?displayDemoText(entity.title,entity.is_demo):String(call.payload.title??call.payload.statement??'');
  const fields=Object.entries(call.payload).filter(([key])=>!['expected_version','expected_explicit_version','preview_token'].includes(key)).map(([key,value])=>{
    if(key==='actor_id')return `分配对象：${get<Row>(db,'SELECT display_name FROM actors WHERE id = ?',[String(value)])?.display_name??value}`;
    if(key==='action')return `操作：${ACTION_LABELS[String(value)]??value}`;
    if((key==='goal_id'||key==='depends_on_id')&&typeof value==='string')return `${FIELD_LABELS[key]}：${findGoal(db,value)?.title??findTask(db,value)?.title??value}`;
    return `${FIELD_LABELS[key]??key}：${value===null?'清空':typeof value==='object'?JSON.stringify(value):String(value)}`;
  });
  if(typeof call.payload.duration_value==='number' && typeof call.payload.duration_unit==='string') {
    const conversion=loadDurationConfig();
    const minutes=durationToMinutes(call.payload.duration_value,call.payload.duration_unit as DurationUnit,conversion);
    fields.push(`换算后将保存 ${minutes} 分钟（按 ${conversion.hours_per_day} 小时/天、${conversion.days_per_month} 天/月）；以数值和单位的换算结果为准。`);
  }
  if(call.operation==='goal.decomposition.confirm') {
    const row=get<Row>(db,'SELECT payload FROM pending_previews WHERE token = ?',[String(call.payload.preview_token)]);
    if(row) {
      const drafts=JSON.parse(String(row.payload)).drafts as {title:string;description:string;estimated_minutes:number}[];
      const overrides=call.payload.accepted_drafts as {index:number;title:string;description?:string|null}[]|undefined;
      const accepted=call.payload.accepted_titles as string[]|undefined;
      const selected=overrides?.length?overrides.map(override=>({...drafts[override.index],...override})):
        accepted?.length?drafts.filter(draft=>accepted.includes(draft.title)):drafts;
      fields.push('将创建：'+selected.map(draft=>`${draft.title}（${draft.estimated_minutes??'未知'} 分钟）${draft.description?'：'+draft.description:''}`).join('；'));
    }
  }
  if(call.operation==='task.delete') {
    fields.push('永久删除该任务及其领取记录、依赖、复评记录；其他任务保留，相关依赖会解除。');
    const task=findTask(db,call.target_id!)!;
    if(task.depends_on.length||task.blocks.length)fields.push('解除依赖关联：'+[...new Set([...task.depends_on,...task.blocks])].map(id=>findTask(db,id)?.title??id).join('、'));
  }
  if(call.operation==='goal.delete') {
    fields.push('永久删除该目标；关联任务全部保留并解除目标关联。');
    const retained=listTasks(db,{goal_id:call.target_id});
    fields.push(`保留 ${retained.length} 个任务${retained.length?'：'+retained.map(task=>displayDemoText(task.title,task.is_demo)).join('、'):''}`);
  }
  return `${def.label}${title?'：'+title:''}${fields.length?'\n'+fields.join('\n'):''}`;
}
export function operationPath(call:SkillOperation):string {return definitionFor(call).path.replace(':id',encodeURIComponent(call.target_id??''));}
