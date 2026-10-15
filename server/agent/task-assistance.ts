import {readTaskSkillPreviews,saveTaskSkillPreview,taskSkillActionSchema,taskSkillCatalog} from './task-skill-previews.ts';
import {composeTaskSkillSystemPrompt} from '../skills/injection.ts';
import {buildPrinceQContext} from './prompt-context.ts';
import {StringDecoder} from 'node:string_decoder';
import {createPublicSummaryDecoder} from './public-summary-stream.ts';
import {taskProgress,appendTaskSummary,readTaskProgress} from './task-assistance-progress.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';
import type {TaskAssistanceDetail, TaskAssistanceSession} from '../../shared/task-assistance.ts';
import type {AgentRuntimeConfig} from '../../shared/types.ts';
import {all,get,run,transaction,type Db,type Row} from '../db/connection.ts';
import {badRequest,conflict,notFound} from '../lib/errors.ts';
import {newId,nowIso} from '../lib/ids.ts';
import {findTask,findGoal} from '../repo/tasks.ts';
import {applyAction} from '../repo/task-service.ts';
import {occurrenceAction} from '../repo/recurrence.ts';
import {DEFAULT_ACTOR_ID} from '../config.ts';
import {buildProviderPromptArgs,runCli} from './cli-exec.ts';
import {normalizeCliOutput} from './output.ts';
import {readRuntimeConfig} from './runtime-config.ts';
import {connectionFor} from './provider-connections.ts';
import {refreshHealth,isAgentReady} from './health.ts';

const active = new Map<string,string>();
export function readTaskAssistance(db:Db,taskId:string):TaskAssistanceDetail {
  if(!findTask(db,taskId))throw notFound('任务不存在');
  const row=get<Row>(db,'SELECT * FROM task_assistance_sessions WHERE task_id=?',[taskId]);
  return {session:row?{...row,ready:!!row.ready} as TaskAssistanceSession:null,
    messages:row?all<Row>(db,'SELECT id,role,content,request_key,created_at,summary_json FROM task_assistance_messages WHERE session_id=? ORDER BY rowid',[row.id]).map(message=>({id:message.id,role:message.role,content:message.content,request_key:message.request_key,created_at:message.created_at,summary:JSON.parse(message.summary_json??'[]'),preview_token:get<Row>(db,'SELECT token FROM task_assistance_previews WHERE message_id=?',[message.id])?.token??null,operation_result:String(message.request_key).startsWith('preview-')})):[],previews:readTaskSkillPreviews(db,taskId),skill:{name:'personal-work-queue',version:4},busy:active.has(taskId),progress:active.has(taskId)?readTaskProgress(taskId,active.get(taskId)!):null};
}
const replySchema=z.strictObject({answer:z.string().trim().min(1).max(16000),artifact:z.string().trim().min(1).max(24000).nullable(),ready:z.boolean(),summary:z.array(z.string().trim().min(1).max(400)).max(4).optional(),proposed_actions:z.array(taskSkillActionSchema).max(20).optional()});
export type AssistanceReply=z.infer<typeof replySchema>;
export async function invokeTaskAssistant(prompt:string,cfg:AgentRuntimeConfig,signal?:AbortSignal,onSummary?:(text:string)=>void,systemPrompt?:string):Promise<AssistanceReply> {
  const system=systemPrompt??fs.readFileSync(fileURLToPath(new URL('./task-assistance-prompt.md',import.meta.url)),'utf8');
  if(Buffer.byteLength(prompt)+Buffer.byteLength(system)>2*1024*1024)throw badRequest('会话上下文过大，请精简后重试');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'princeq-task-assistance-'));
  try {
    const file=path.join(dir,'system.md');fs.writeFileSync(file,system,{mode:0o600});
    const decoder=new StringDecoder('utf8');const publicSummary=createPublicSummaryDecoder(cfg.provider,text=>onSummary?.(text));
    const result=await runCli({executable:cfg.cli_path,args:buildProviderPromptArgs(cfg.provider,'',cfg,{systemPromptFile:file,promptViaStdin:true,streamingSummary:true}),
      cwd:cfg.working_directory,envNames:cfg.allowed_env_names,timeoutMs:cfg.timeout_ms,provider:cfg.provider,input:prompt,signal,maxOutputBytes:1024*1024,onStdoutChunk:chunk=>publicSummary.push(decoder.write(chunk))});
    publicSummary.push(decoder.end());publicSummary.finish();
    if(result.timedOut)throw badRequest('Agent 响应超时，内容未丢失，可以重试');
    if(result.canceled)throw badRequest('本次协助已取消');
    const normalized=normalizeCliOutput(cfg.provider,result);
    if(!normalized.valid)throw badRequest('Agent 未返回有效回复，请检查个人设置中的连接');
    const text=normalized.answer;let parsed:unknown;
    try {parsed=JSON.parse(text.slice(text.indexOf('{'),text.lastIndexOf('}')+1));}catch{throw badRequest('Agent 回复格式无效，请重试');}
    const reply=replySchema.parse(parsed);
    if(reply.ready&&!reply.artifact)throw badRequest('Agent 未提供可验收产出');
    return reply;
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
}
export async function assistTask(db:Db,taskId:string,message:string,key:string,options:{signal?:AbortSignal;invoke?:(prompt:string,system?:string)=>Promise<AssistanceReply>}={}):Promise<TaskAssistanceDetail> {
  if(active.has(taskId))throw conflict('此任务正在生成回复，请稍候');
  const task=findTask(db,taskId);if(!task)throw notFound('任务不存在');
  const existing=readTaskAssistance(db,taskId);
  if(existing.session) {const prior=get<Row>(db,"SELECT content FROM task_assistance_messages WHERE session_id=? AND request_key=? AND role='user'",[existing.session.id,key]);if(prior&&prior.content!==message)throw conflict('同一请求标识不能发送不同内容');}
  if(existing.session&&get(db,"SELECT id FROM task_assistance_messages WHERE session_id=? AND request_key=? AND role='assistant'",[existing.session.id,key]))return existing;
  active.set(taskId,key);taskProgress(taskId,key,'checking');
  try {
    const cfg=readRuntimeConfig();
    if(!options.invoke) {
      if(!cfg.enabled)throw badRequest('请先在个人设置中启用并连接 Agent，任务协助需要真实模型');
      if(!isAgentReady(cfg)&&!connectionFor(cfg)?.ok)await refreshHealth(cfg);
      if(!isAgentReady(cfg)&&!connectionFor(cfg)?.ok)throw badRequest('Agent 尚未连接，请在个人设置中验证连接');
    }
    taskProgress(taskId,key,'context');
    let session=existing.session;
    if(!session) {
      const id=newId('assist'),time=nowIso();
      run(db,'INSERT INTO task_assistance_sessions(id,task_id,created_at,updated_at) VALUES(?,?,?,?)',[id,taskId,time,time]);
      session=readTaskAssistance(db,taskId).session!;
    }
    run(db,"INSERT OR IGNORE INTO task_assistance_messages(id,session_id,role,content,request_key,created_at) VALUES(?,?,'user',?,?,?)",[newId('am'),session.id,message,key,nowIso()]);
    const current=readTaskAssistance(db,taskId);
    const relatedOutputs=all<Row>(db,`SELECT t.id AS task_id,t.title,s.artifact,s.accepted_at
      FROM task_assistance_sessions s JOIN tasks t ON t.id=s.task_id
      WHERE t.id<>? AND s.accepted_at IS NOT NULL
      AND ((t.goal_id=? AND ? IS NOT NULL) OR t.id IN (SELECT depends_on_id FROM task_dependencies WHERE task_id=?))`,[taskId,task.goal_id,task.goal_id,taskId]);
    const work=buildPrinceQContext({db,message,actorId:DEFAULT_ACTOR_ID,idempotencyKey:key,targetTaskId:taskId,targetGoalId:task.goal_id??undefined},cfg);
    const fixed=fs.readFileSync(fileURLToPath(new URL('./task-assistance-prompt.md',import.meta.url)),'utf8');
    const system=composeTaskSkillSystemPrompt(fixed,work,taskSkillCatalog());
    const previews=current.previews??[];
    const taskPreviews=previews.map(preview=>({...preview,actions:JSON.parse(get<Row>(db,'SELECT actions_json FROM agent_pending_actions WHERE token=?',[preview.token])!.actions_json)}));
    const prompt=JSON.stringify({...work,mode:'task_assistance',task,related_accepted_outputs:relatedOutputs,goal:task.goal_id?findGoal(db,task.goal_id):null,today:task.recurrence?.today??null,
      current_occurrence:task.recurrence?.today_occurrence??null,previous_artifact:session.artifact,history:current.messages,current_message:{...work.current_message,content:message},work_snapshot:{...work.work_snapshot,model_previews:taskPreviews},task_previews:taskPreviews});
    taskProgress(taskId,key,'calling');
    const reply=await (options.invoke?options.invoke(prompt,system):invokeTaskAssistant(prompt,cfg,options.signal,text=>{taskProgress(taskId,key,'response');appendTaskSummary(taskId,key,text);},system));
    taskProgress(taskId,key,'validation');
    transaction(db,()=>{
      if(!findTask(db,taskId))throw notFound('任务在生成过程中已被删除');
      const messageId=newId('am');
      run(db,"INSERT INTO task_assistance_messages(id,session_id,role,content,request_key,created_at,summary_json) VALUES(?,?,'assistant',?,?,?,?)",[messageId,session!.id,reply.answer,key,nowIso(),JSON.stringify(reply.summary??[])]);
      if(reply.proposed_actions?.length)saveTaskSkillPreview(db,taskId,session!.id,messageId,reply.proposed_actions);
      run(db,`UPDATE task_assistance_sessions SET artifact=?,ready=?,artifact_task_version=?,artifact_date=?,accepted_at=NULL,revision=revision+1,updated_at=? WHERE id=?`,
        [reply.artifact??session!.artifact,reply.ready?1:0,task.version,task.recurrence?.today_occurrence?.date??null,nowIso(),session!.id]);
    });
    taskProgress(taskId,key,'complete');
    return {...readTaskAssistance(db,taskId),busy:false};
  } catch(error){taskProgress(taskId,key,'failed');throw error;} finally {active.delete(taskId);}
}
export function acceptTaskAssistance(db:Db,taskId:string,input:{revision:number;expected_version:number}) {
  const detail=readTaskAssistance(db,taskId),session=detail.session,task=findTask(db,taskId)!;
  if(active.has(taskId))throw conflict('Agent 正在回复，请等本轮完成');
  if(!session||!session.artifact||!session.ready)throw conflict('尚无可验收的产出，请继续对话补齐');
  if(session.accepted_at)throw conflict('这份产出已采纳');
  if(session.revision!==input.revision||task.version!==input.expected_version||session.artifact_task_version!==task.version)throw conflict('任务或产出已更新，请继续对话核对最新版后再采纳');
  if(task.recurrence) {
    const occurrence=task.recurrence.today_occurrence;
    if(!occurrence||session.artifact_date!==occurrence.date)throw conflict('产出不属于今天的执行日，请继续对话更新');
    occurrenceAction(db,taskId,{date:occurrence.date,action:'complete',note:session.artifact,expected_version:occurrence.version});
  } else {
    if(task.status==='inbox')applyAction(db,taskId,{action:'claim',actor_id:DEFAULT_ACTOR_ID});
    applyAction(db,taskId,{action:'complete',actor_id:DEFAULT_ACTOR_ID});
  }
  run(db,'UPDATE task_assistance_sessions SET accepted_at=?,updated_at=? WHERE id=?',[nowIso(),nowIso(),session.id]);
  return {task:findTask(db,taskId),...readTaskAssistance(db,taskId)};
}
