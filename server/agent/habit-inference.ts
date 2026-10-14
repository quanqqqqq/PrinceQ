/** Hourly evidence-backed observation; no model can write business data. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {z} from 'zod';
import {TASK_TYPES,type HabitEntry,type TaskType} from '../../shared/types.ts';
import {usableObservation,observationEvidence,type HabitInferenceStatus,type HabitObservationEvidence} from '../../shared/habit-inference.ts';
import {all,get,run,transaction,type Db,type Row} from '../db/connection.ts';
import {readAllHabits,readHabitFile,writeHabitFile} from '../domain/habits.ts';
import {refreshQueue} from '../repo/queue-service.ts';
import {readInjectedPrinceQSkill} from '../skills/injection.ts';
import {buildProviderPromptArgs,runCli} from './cli-exec.ts';
import {normalizeCliOutput} from './output.ts';
import {readRuntimeConfig,type AgentRuntimeConfig} from './runtime-config.ts';
import {refreshHealth} from './health.ts';
import {recordAgentConnection,runtimeConnectionKey} from './provider-connections.ts';
import {inferenceConnection,inferenceTimezone,localObservationTime} from './habit-inference-availability.ts';

const STATE_KEY='princeq.habit-inference.v1',HOUR=3600000,LOOKBACK=30*86400000;
export const HABIT_INFERENCE_PROMPT_VERSION='princeq.habit-observer.v3';
interface State {
  config_key:string;cursor:number;next_run_at:string;last_attempt_at:string|null;
  last_saved_at:string|null;last_result:string;saved_count:number;last_error:string|null;
  connected:boolean;owner?:string|null;lease_until?:number;effective_key?:string;
}
export interface EventFact {
  rowid:number;id:string;task_id:string;action:string;at:string;local_date:string;local_hour:number;
  task_title:string;task_type:TaskType|null;task_version:number;reason:string|null;
}
function stateOf(db:Db):State|null {
  try {
    const row=get<Row>(db,'SELECT value FROM schema_meta WHERE key=?',[STATE_KEY]);
    const v=row?JSON.parse(String(row.value)):null;
    return v&&typeof v.config_key==='string'&&Number.isFinite(v.cursor)&&Number.isFinite(Date.parse(v.next_run_at))?v:null;
  }catch{return null;}
}
function storeState(db:Db,state:State) {
  run(db,'INSERT INTO schema_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',[STATE_KEY,JSON.stringify(state)]);
}
export function collectHabitEvidence(db:Db,at:number):EventFact[] {
  const rows=all<Row>(db,"SELECT o.rowid AS sequence,o.id,o.target_id,o.operation_type,o.created_at,o.detail,t.title,t.task_type,t.version FROM operations o JOIN tasks t ON t.id=o.target_id JOIN actors a ON a.id=o.actor_id WHERE o.status='succeeded' AND o.target_type='task' AND t.is_demo=0 AND a.kind='human' AND o.operation_type IN ('task.start','task.complete','task.block','task.unblock','task.release','agent.task.start','agent.task.complete','agent.task.block','agent.task.unblock','agent.task.release') AND o.created_at>=? AND o.created_at<=? ORDER BY o.rowid DESC LIMIT 500",
    [new Date(at-LOOKBACK).toISOString(),new Date(at).toISOString()]);
  return rows.reverse().flatMap(row=>{
    if(!Number.isFinite(Date.parse(String(row.created_at))))return [];
    let reason:string|null=null;
    try{const detail=JSON.parse(String(row.detail));reason=typeof detail?.reason==='string'?detail.reason.slice(0,400):null;}catch{/* absent */}
    const local=localObservationTime(row.created_at);
    return [{rowid:Number(row.sequence),id:String(row.id),task_id:String(row.target_id),action:String(row.operation_type).replace(/^agent\./,''),
      at:String(row.created_at),local_date:local.date,local_hour:local.hour,task_title:String(row.title).slice(0,200),
      task_type:row.task_type??null,task_version:Number(row.version),reason}];
  });
}
const unique=<T>(values:T[])=>[...new Set(values)];
export const observationReplySchema=z.strictObject({schema_version:z.literal(1),
  hypotheses:z.array(z.strictObject({
    statement:z.string().trim().min(8).max(400),kind:z.enum(['scheduling','batching','workflow']),
    pattern:z.enum(['start_hour','blocking_pattern','completion_cluster']),
    task_types:z.array(z.enum(TASK_TYPES)).max(6),
    preferred_hours:z.array(z.number().int().min(0).max(23)).max(4),
    confidence:z.number().min(0).max(1),rationale:z.string().trim().min(8).max(700),
    evidence_ids:z.array(z.string().min(1).max(80)).min(3).max(12),
    counter_evidence_ids:z.array(z.string().min(1).max(80)).max(12),
  })).max(3)});
type Hypothesis=z.infer<typeof observationReplySchema>['hypotheses'][number];
export function supportedObservation(h:Hypothesis,events:EventFact[],cursor:number):EventFact[]|null {
  if(!['start_hour','blocking_pattern','completion_cluster'].includes(h.pattern)||h.confidence<0.75||/^\s*(demo\b|示例[：:])/i.test(h.statement))return null;
  const ids=unique(h.evidence_ids),index=new Map(events.map(e=>[e.id,e]));
  if(ids.length!==h.evidence_ids.length)return null;
  const selected=ids.map(id=>index.get(id));
  if(selected.some(e=>!e)||h.counter_evidence_ids.some(id=>!index.has(id)||ids.includes(id)))return null;
  const samples=selected as EventFact[],types=unique(h.task_types);
  if(unique(samples.map(e=>e.task_id)).length<3||unique(samples.map(e=>e.local_date)).length<2||
     !samples.some(e=>e.rowid>cursor)||types.length!==h.task_types.length||
     samples.some(e=>types.length&&(!e.task_type||!types.includes(e.task_type))))return null;
  if(h.pattern==='start_hour') {
    if(samples.some(e=>e.action!=='task.start'))return null;
    if(h.pattern==='start_hour') {
      if(h.kind!=='scheduling'||!h.preferred_hours.length||types.length>1||unique(h.preferred_hours).length!==h.preferred_hours.length)return null;
      if(!h.preferred_hours.some(start=>h.preferred_hours.every(hour=>(hour-start+24)%24<=3)))return null;
      const scope=events.filter(e=>e.action==='task.start'&&(!types.length||Boolean(e.task_type&&types.includes(e.task_type))));
      if(h.preferred_hours.some(hour=>!scope.some(e=>e.local_hour===hour)))return null;
      const groups=new Map<string,EventFact[]>();
      for(const event of scope)groups.set(event.task_id,[...(groups.get(event.task_id)??[]),event]);
      const support=[...groups.values()].reduce((sum,group)=>sum+group.filter(e=>h.preferred_hours.includes(e.local_hour)).length/group.length,0)/Math.max(groups.size,1);
      if(support<0.75||samples.some(e=>!h.preferred_hours.includes(e.local_hour)))return null;
    }
  }else if(h.pattern==='blocking_pattern') {
    if(h.kind!=='workflow'||h.preferred_hours.length||samples.some(e=>e.action!=='task.block'))return null;
  }else {
    if(h.kind!=='batching'||h.preferred_hours.length||samples.some(e=>e.action!=='task.complete'))return null;
    for(const day of unique(samples.map(e=>e.local_date))) {
      const group=samples.filter(e=>e.local_date===day);
      if(unique(group.map(e=>e.task_id)).length<2||
         Math.max(...group.map(e=>Date.parse(e.at)))-Math.min(...group.map(e=>Date.parse(e.at)))>HOUR)return null;
    }
  }
  return samples;
}
function signature(h:Hypothesis) {
  return createHash('sha256').update(JSON.stringify({pattern:h.pattern,types:[...h.task_types].sort(),
    hours:unique(h.preferred_hours).sort((a,b)=>a-b)})).digest('hex');
}
export function persistObservedHabits(db:Db,cfg:AgentRuntimeConfig,hypotheses:Hypothesis[],events:EventFact[],cursor:number,at:number) {
  if(!inferenceConnection(cfg).connected||runtimeConnectionKey(readRuntimeConfig())!==runtimeConnectionKey(cfg))return 0;
  const constraints=readHabitFile('constraints').payload.entries;
  const file=readHabitFile('inferred'),explicit=readHabitFile('explicit'),entries=[...file.payload.entries];
  const adopted=new Set(explicit.payload.entries.map(e=>(e.source_relation as {inferred_id?:string}|undefined)?.inferred_id));
  const seen=new Set<string>();
  let count=0;
  for(const h of hypotheses) {
    const samples=supportedObservation(h,events,cursor);
    if(!samples||samples.some(e=>Number(get<Row>(db,'SELECT version FROM tasks WHERE id=?',[e.task_id])?.version)!==e.task_version))continue;
    if(h.pattern==='start_hour'&&constraints.some(c=>{
      if(!c.enabled||c.kind!=='forbidden_window')return false;
      const m=/^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(c.value);
      if(!m)return true;
      const values=m.slice(1).map(Number);
      if(values[0]>23||values[2]>23||values[1]>59||values[3]>59)return true;
      const start=values[0]*60+values[1],end=values[2]*60+values[3];
      return h.preferred_hours.some(hour=>Array.from({length:60},(_,minute)=>hour*60+minute).some(t=>
        start===end||(start<end?t>=start&&t<end:t>=start||t<end)));
    }))continue;
    const key=signature(h);
    if(seen.has(key))continue;
    const protectedPattern=entries.some(entry=>{
      const evidence=observationEvidence(entry.source_relation);
      if(!evidence||entry.enabled&&!adopted.has(entry.id)||evidence.pattern!==h.pattern)return false;
      const sameScope=!evidence.task_types.length||!h.task_types.length||h.task_types.some(t=>evidence.task_types.includes(t));
      return sameScope&&(h.pattern!=='start_hour'||h.preferred_hours.some(hour=>evidence.preferred_hours.includes(hour)));
    });
    if(protectedPattern)continue;
    const found=entries.findIndex(e=>observationEvidence(e.source_relation)?.signature===key);
    if(found>=0&&(!entries[found].enabled||adopted.has(entries[found].id)))continue;
    if(found<0&&entries.filter(e=>e.source==='agent_inference').length>=100)continue;
    seen.add(key);
    const stamp=new Date(at).toISOString();
    const evidence:HabitObservationEvidence={type:'agent_inference',schema_version:1,signature:key,
      provider:cfg.provider,model:cfg.model,prompt_version:HABIT_INFERENCE_PROMPT_VERSION,
      analyzed_at:stamp,timezone:inferenceTimezone(),window_from:events[0]?.at??stamp,window_to:events.at(-1)?.at??stamp,
      rationale:h.rationale,sample_tasks:unique(samples.map(e=>e.task_id)).length,
      sample_days:unique(samples.map(e=>e.local_date)).length,pattern:h.pattern,
      task_types:unique(h.task_types),preferred_hours:unique(h.preferred_hours).sort((a,b)=>a-b),
      evidence:samples.map(e=>({operation_id:e.id,task_id:e.task_id,action:e.action,at:e.at,local_date:e.local_date})),
      counter_evidence_ids:unique(h.counter_evidence_ids)};
    const limit=evidence.sample_tasks<10||evidence.sample_days<3?0.85:0.95;
    const entry:HabitEntry={id:found>=0?entries[found].id:'habit_'+randomUUID().slice(0,18),
      statement:h.statement,kind:h.kind,enabled:true,confidence:Math.min(h.confidence,limit),source:'agent_inference',
      source_relation:evidence,created_at:found>=0?entries[found].created_at:stamp,updated_at:stamp};
    if(found>=0)entries[found]=entry;else entries.push(entry);
    count++;
  }
  if(count) {
    const stamp=new Date(at).toISOString();
    writeHabitFile('inferred',{...file,updated_at:stamp,payload:{entries},
      history:[{at:stamp,actor:'agent:'+cfg.provider,change:'自动保存 '+count+' 条有执行证据的观察；未采纳为明确习惯'},
        ...file.history].slice(0,200)});
  }
  return count;
}
function settingsKey() {return JSON.stringify(Object.values(readAllHabits()).map(h=>h.updated_at));}
export async function requestHabitObservations(cfg:AgentRuntimeConfig,events:EventFact[],signal:AbortSignal) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'princeq-habit-observer-'));
  try {
    const skill=readInjectedPrinceQSkill();
    const policy=fs.readFileSync(fileURLToPath(new URL('./habit-inference-prompt.md',import.meta.url)),'utf8');
    const system=['你是 PrinceQ 工作助手。Skill 供了解产品事实；本轮只作后台观察，不执行 Skill 写操作。',
      skill.instructions,skill.scoringInstructions,policy,
      '严格输出合同（没有可保存的候选时 hypotheses=[]）：\n'+JSON.stringify(z.toJSONSchema(observationReplySchema))].join('\n\n');
    const input=JSON.stringify({mode:'habit_observation',timezone:inferenceTimezone(),evidence_events:events,
      window_is_bounded:true,max_events:500,personal_settings:readAllHabits()});
    if(Buffer.byteLength(system)+Buffer.byteLength(input)>1024*1024)throw new Error('context_too_large');
    const file=path.join(dir,'system.md');fs.writeFileSync(file,system,{mode:0o600});
    const result=await runCli({executable:cfg.cli_path,
      args:buildProviderPromptArgs(cfg.provider,'',cfg,{systemPrompt:system,systemPromptFile:file,promptViaStdin:true}),
      cwd:cfg.working_directory,envNames:cfg.allowed_env_names,timeoutMs:cfg.timeout_ms,provider:cfg.provider,input,signal});
    const normalized=normalizeCliOutput(cfg.provider,result);
    if(result.timedOut||result.canceled||!normalized.valid) {
      if(!result.canceled)recordAgentConnection(cfg,false,result.exitCode);
      throw new Error(result.canceled?'canceled':'agent_unavailable');
    }
    recordAgentConnection(cfg,true,result.exitCode);
    const text=normalized.answer.trim().replace(/^\x60{3}(?:json)?\s*/i,'').replace(/\s*\x60{3}$/,'');
    let payload:unknown;try{payload=JSON.parse(text);}catch{throw new Error('invalid_reply');}
    const parsed=observationReplySchema.safeParse(payload);
    if(!parsed.success)throw new Error('invalid_reply');
    return parsed.data.hypotheses;
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
}
export function habitInferenceStatus(db:Db,at=Date.now()):HabitInferenceStatus {
  const state=stateOf(db),gate=inferenceConnection();
  return {connected:gate.connected,paused_reason:gate.reason,interval_minutes:60,
    next_run_at:gate.connected?state?.next_run_at??null:null,last_attempt_at:state?.last_attempt_at??null,
    last_saved_at:state?.last_saved_at??null,last_result:state?.last_result??'waiting',saved_count:state?.saved_count??0,
    last_error:state?.last_error??null,running:gate.connected&&!!state?.owner&&(state.lease_until??0)>at};
}
/** No timer exists merely from importing the module. */
export interface HabitInferenceWorkerOptions {
  now?:()=>number; schedule?:boolean;
  observe?:typeof requestHabitObservations; probe?:typeof refreshHealth;
}
export function startHabitInferenceWorker(db:Db,options:HabitInferenceWorkerOptions={}) {
  const clock=options.now??Date.now;
  const owner=randomUUID(),controller=new AbortController();
  let stopped=false,busy=false;
  async function tick() {
    if(stopped||busy)return;
    busy=true;
    try {
      const cfg=readRuntimeConfig(),gate=inferenceConnection(cfg),at=clock(),key=runtimeConnectionKey(cfg);
      let previous=stateOf(db);
      const observations=readHabitFile('inferred').payload.entries;
      const effectiveKey=gate.connected?observations.filter(e=>e.enabled&&usableObservation(e,at)).map(e=>e.id+':'+e.updated_at).sort().join('|'):'';
      if(previous&&previous.effective_key!==effectiveKey) {
        transaction(db,()=>{
          const current=stateOf(db);
          if(!current||(current.owner&&(current.lease_until??0)>at))return;
          if(current.effective_key||effectiveKey)refreshQueue(db,'inferred-habits-effectiveness');
          storeState(db,{...current,effective_key:effectiveKey});
        });
        previous=stateOf(db);
      }
      if(!gate.connected) {
        if(previous?.connected)transaction(db,()=>{
          const current=stateOf(db);if(!current||(current.owner&&(current.lease_until??0)>at))return;
          storeState(db,{...current,connected:false,owner:null,last_result:'paused'});
          // Effectiveness changes are handled once above, including disconnects.
        });
        return;
      }
      const events=collectHabitEvidence(db,at),latest=events.at(-1)?.rowid??0;
      if(!previous||previous.config_key!==key||!previous.connected) {
        transaction(db,()=>{
          const current=stateOf(db);if(current?.owner&&(current.lease_until??0)>at)return;
          if(current?.config_key===key&&current.connected)return;
          storeState(db,{config_key:key,cursor:latest,next_run_at:new Date(at+HOUR).toISOString(),
            last_attempt_at:previous?.last_attempt_at??null,last_saved_at:previous?.last_saved_at??null,
            last_result:'scheduled',saved_count:0,last_error:null,connected:true,owner:null,effective_key:effectiveKey});
          // Reconnection restarts the hourly interval; observations stay advisory.
        });
        return;
      }
      if(at<Date.parse(previous.next_run_at))return;
      const enough=latest>previous.cursor&&unique(events.map(e=>e.task_id)).length>=3&&unique(events.map(e=>e.local_date)).length>=2;
      const lease=transaction(db,()=>{
        const current=stateOf(db);
        if(!current||current.config_key!==key||at<Date.parse(current.next_run_at)||(current.owner&&(current.lease_until??0)>at))return null;
        const next={...current,next_run_at:new Date(at+HOUR).toISOString(),saved_count:0,last_error:null,
          last_result:enough?'running':'insufficient',owner:enough?owner:null,
          lease_until:enough?at+cfg.timeout_ms+60000:0,last_attempt_at:enough?new Date(at).toISOString():current.last_attempt_at};
        storeState(db,next);return enough?next:null;
      });
      if(!lease)return;
      const inputs=settingsKey();
      try {
        const health=await (options.probe??refreshHealth)(cfg,{force:true});
        if(!health.ok){recordAgentConnection(cfg,false);throw new Error('agent_unavailable');}
        const hypotheses=await (options.observe??requestHabitObservations)(cfg,events,controller.signal);
        if(stopped||!inferenceConnection().connected||runtimeConnectionKey(readRuntimeConfig())!==key)throw new Error('runtime_changed');
        if(settingsKey()!==inputs)throw new Error('settings_changed');
        transaction(db,()=>{
          const current=stateOf(db);
          if(!current||current.owner!==owner||(current.lease_until??0)<=clock())return;
          const count=persistObservedHabits(db,cfg,hypotheses,events,lease.cursor,clock());
          // Atomic file writes are not a cross-storage transaction. Signatures prevent duplicate additions after a crash.
          let queueRefreshed=false;
          if(count) {
            try { transaction(db,()=>refreshQueue(db,'habit-inference')); queueRefreshed=true; } catch { /* The next effectiveness check retries the queue only. */ }
          }
          storeState(db,{...current,cursor:latest,owner:null,lease_until:0,last_result:count?'saved':'no_valid_observation',
            saved_count:count,last_saved_at:count?new Date(clock()).toISOString():current.last_saved_at,
            effective_key:queueRefreshed?readHabitFile('inferred').payload.entries.filter(e=>e.enabled&&usableObservation(e,clock())).map(e=>e.id+':'+e.updated_at).sort().join('|'):current.effective_key});
        });
      }catch(cause) {
        if(!stopped)transaction(db,()=>{
          const current=stateOf(db);if(!current||current.owner!==owner)return;
          const message=cause instanceof Error?cause.message:'inference_failed';
          const safe=['invalid_reply','agent_unavailable','settings_changed','runtime_changed','context_too_large','canceled'];
          storeState(db,{...current,owner:null,lease_until:0,last_result:'error',last_error:safe.includes(message)?message:'inference_failed'});
        });
      }
    }catch{/* Fail closed: malformed configuration cannot produce observations. */}
    finally{busy=false;}
  }
  const timer=options.schedule===false?null:setInterval(()=>void tick(),60000);timer?.unref();
  if(options.schedule!==false)void tick();
  const stop=()=>{
    if(stopped)return;
    stopped=true;if(timer)clearInterval(timer);controller.abort();
    try {transaction(db,()=>{
      const current=stateOf(db);
      if(current?.owner===owner)storeState(db,{...current,owner:null,lease_until:0,last_result:'canceled',last_error:'canceled'});
    });}catch{/* The database may already be closing; the persisted lease still has a deadline. */}
  };
  return Object.assign(stop,{tick});
}
