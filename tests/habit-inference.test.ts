import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'princeq-habit-unit-'));
process.env.PWQ_HABITS_DIR=path.join(root,'habits');
process.env.PWQ_AGENT_RUNTIME_CONFIG=path.join(root,'runtime.json');
process.env.PWQ_DB_PATH=path.join(root,'unused.sqlite');
process.env.PWQ_TIME_ZONE='Asia/Shanghai';
const {openDatabase,applySchema,all,get,run}=await import('../server/db/connection.ts');
const {seedActors}=await import('../server/db/seed.ts');
const {ensureHabitFiles,readHabitFile,writeHabitFile,loadHabitContext,buildSettingsSnapshot,adoptSettingsInferred}=await import('../server/domain/habits.ts');
const {defaultRuntimeConfig,writeRuntimeConfig,readRuntimeConfig}=await import('../server/agent/runtime-config.ts');
const {recordAgentConnection}=await import('../server/agent/provider-connections.ts');
const {collectHabitEvidence,supportedObservation,persistObservedHabits,observationReplySchema,startHabitInferenceWorker,habitInferenceStatus,requestHabitObservations}=await import('../server/agent/habit-inference.ts');
const {inferenceConnection}=await import('../server/agent/habit-inference-availability.ts');
const {usableObservation,observationEvidence}=await import('../shared/habit-inference.ts');
const {buildRouter}=await import('../server/http/routes.ts');
const {scoreTask,buildScoringContext}=await import('../server/domain/queue.ts');
const {findTask}=await import('../server/repo/tasks.ts');
import type {EventFact,HabitInferenceWorkerOptions} from '../server/agent/habit-inference.ts';
import type {Db} from '../server/db/connection.ts';

const H=3600000,KEY='princeq.habit-inference.v1';
let db:Db,now:number,seq:number,cfg:ReturnType<typeof defaultRuntimeConfig>;
let stops:ReturnType<typeof startHabitInferenceWorker>[]=[];
function fact(task:string,index:number,hour=9,day=2,action='task.start'):EventFact {
  const d=new Date(Date.now()-day*86400000);
  const wall=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(d);
  const at=wall+'T'+String(hour).padStart(2,'0')+':00:00+08:00';
  return {rowid:index,id:'op_'+index,task_id:task,action,at:new Date(at).toISOString(),
    local_date:wall,local_hour:hour,task_title:'隔离任务 '+task,task_type:'deep_work',task_version:1,reason:null};
}
function usual():EventFact[] {return [fact('t1',++seq,9,3),fact('t2',++seq,10,2),fact('t3',++seq,9,2)];}
function insert(events:EventFact[],opts:{demo?:boolean;failed?:boolean;actor?:string}={}) {
  for(const e of events) {
    run(db,"INSERT OR IGNORE INTO tasks(id,title,status,task_type,estimated_minutes,is_demo,created_at,updated_at,version) VALUES (?,?,'in_progress',?,60,?,?,?,1)",
      [e.task_id,e.task_title,e.task_type,opts.demo?1:0,e.at,e.at]);
    run(db,"INSERT INTO operations(id,idempotency_key,operation_type,target_type,target_id,actor_id,status,summary,detail,created_at) VALUES (?,?,?,'task',?,?,?,?,?,?)",
      [e.id,e.id,e.action,e.task_id,opts.actor??'actor-human-me',opts.failed?'failed':'succeeded','隔离执行事件',JSON.stringify({reason:e.reason}),e.at]);
  }
}
function hypothesis(events:EventFact[],patch:Record<string,unknown>={}) {
  return {statement:'最近启动深度工作的记录倾向上午九至十点。',kind:'scheduling' as const,pattern:'start_hour' as const,
    task_types:['deep_work' as const],preferred_hours:[9,10],confidence:0.8,
    rationale:'至少两个日期的三个不同任务在九至十点启动；少量样本不能证明该时段效率最高。',
    evidence_ids:events.filter(e=>e.action==='task.start').map(e=>e.id).slice(-12),counter_evidence_ids:[],...patch};
}
function data() {
  return JSON.stringify({tasks:all(db,'SELECT * FROM tasks ORDER BY id').map(row=>{const c={...row};delete c.queue_position;delete c.queue_score;return c;}),
    goals:all(db,'SELECT * FROM goals ORDER BY id'),
    protected:['explicit','constraints','weights'].map(name=>fs.readFileSync(path.join(process.env.PWQ_HABITS_DIR!,name+'.json'),'utf8'))});
}
function inferredBytes(){return fs.readFileSync(path.join(process.env.PWQ_HABITS_DIR!,'inferred.json'),'utf8');}
function worker(observe?:HabitInferenceWorkerOptions['observe']) {
  const w=startHabitInferenceWorker(db,{schedule:false,now:()=>now,
    probe:async()=>({ok:true,reason:null,checkedAt:new Date(now).toISOString()}),observe});
  stops.push(w);return w;
}
async function ready(observe:HabitInferenceWorkerOptions['observe']) {const w=worker(observe);await w.tick();return w;}
function modelReply(events:EventFact[]) {return [hypothesis(events)] as any;}
async function saveOne() {
  const w=await ready(async(_cfg,events)=>modelReply(events));
  const events=usual();insert(events);now+=H;await w.tick();
  assert.equal(habitInferenceStatus(db,now).saved_count,1);
  return {w,events,entry:readHabitFile('inferred').payload.entries[0]};
}
test.beforeEach(()=>{
  fs.rmSync(process.env.PWQ_HABITS_DIR!,{recursive:true,force:true});
  for(const file of [process.env.PWQ_AGENT_RUNTIME_CONFIG!,process.env.PWQ_AGENT_RUNTIME_CONFIG!+'.connections.json'])fs.rmSync(file,{force:true});
  ensureHabitFiles();db=openDatabase(':memory:');applySchema(db);seedActors(db);seq=0;now=Date.now()-6*H;
  run(db,"INSERT INTO goals(id,title,status,is_demo,created_at,updated_at,version) VALUES ('goal-test','隔离目标','active',0,?,?,1)",[new Date(now).toISOString(),new Date(now).toISOString()]);
  cfg=writeRuntimeConfig({...defaultRuntimeConfig(),enabled:true,cli_path:process.execPath},defaultRuntimeConfig().updated_at,'test');
  recordAgentConnection(cfg,true);
  assert.equal(inferenceConnection(cfg).connected,true,'isolated fixture must have a verifiable executable');
});
test.afterEach(()=>{for(const stop of stops)stop();stops=[];db.close();});
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));

test('reply schema rejects arbitrary actions and invalid field shapes',()=>{
  assert.equal(observationReplySchema.safeParse({schema_version:1,hypotheses:[],proposed_actions:[{}]}).success,false);
  assert.equal(observationReplySchema.safeParse({schema_version:1,hypotheses:[hypothesis(usual(),{confidence:NaN})]}).success,false);
  assert.equal(observationReplySchema.safeParse({schema_version:1,hypotheses:[]}).success,true);
});
test('collector excludes demonstrations, failed and automatic actions; handles confirmed Agent commands',()=>{
  const good=usual();good[0].action='agent.task.start';insert(good);
  insert([fact('demo',++seq)],{demo:true});insert([fact('failed',++seq)],{failed:true});
  insert([fact('auto',++seq)],{actor:'actor-automation-cron'});
  const events=collectHabitEvidence(db,Date.now());
  assert.equal(events.length,3);assert.equal(events[0].action,'task.start');
  assert.equal(events[0].local_hour,9);
});
test('independent cross-day morning evidence is supported',()=>{
  const e=usual();assert.equal(supportedObservation(hypothesis(e),e,0)?.length,3);
});
for(const [label,alter] of [
  ['one task is not three samples',(e:EventFact[])=>e.map(v=>({...v,task_id:'same'}))],
  ['one day is insufficient',(e:EventFact[])=>e.map(v=>({...v,local_date:e[0].local_date}))],
] as const) test(label,()=>{const e=alter(usual());assert.equal(supportedObservation(hypothesis(e),e,0),null);});
test('current workload cannot prove a task-type preference without choice opportunities',()=>{
  const events=usual(),h=hypothesis(events,{kind:'workflow',pattern:'task_type_choice',preferred_hours:[]});
  assert.equal(observationReplySchema.safeParse({schema_version:1,hypotheses:[h]}).success,false);
  assert.equal(supportedObservation(h as any,events,0),null);
});
test('fabricated, repeated, low-confidence and already-consumed evidence is rejected',()=>{
  const e=usual(),h=hypothesis(e);
  for(const patch of [{evidence_ids:['nonexistent',e[1].id,e[2].id]},{evidence_ids:[e[0].id,e[0].id,e[2].id]},
    {confidence:0.74},{counter_evidence_ids:['fabricated']}])
    assert.equal(supportedObservation({...h,...patch},e,0),null);
  assert.equal(supportedObservation(h,e,99),null);
});
test('a task repeatedly started in morning and night is not a morning preference',()=>{
  const e=usual();const mixed=e.concat(e.map(v=>({...v,id:'night_'+v.id,rowid:++seq,local_hour:22})));
  assert.equal(supportedObservation(hypothesis(e),mixed,0),null);
});
test('scattered hours and cherry-picked multi-type scopes cannot form a time preference',()=>{
  const e=[fact('t1',++seq,1,3),fact('t2',++seq,9,2),fact('t3',++seq,17,2)];
  assert.equal(supportedObservation(hypothesis(e,{preferred_hours:[1,9,17]}),e,0),null);
  const morning=usual();
  assert.equal(supportedObservation(hypothesis(morning,{task_types:['deep_work','review']}),morning,0),null);
});
test('unobserved hours are not added to a preferred window',()=>{
  const e=usual();assert.equal(supportedObservation(hypothesis(e,{preferred_hours:[9,10,11]}),e,0),null);
});
test('duplicate model candidates count as one saved observation',()=>{
  const e=usual();insert(e);const h=hypothesis(e),before=data();
  assert.equal(persistObservedHabits(db,cfg,[h,h],e,0,now),1);
  assert.equal(readHabitFile('inferred').payload.entries.length,1);assert.equal(data(),before);
});
test('hard forbidden windows reject incompatible start-hour advice',()=>{
  const e=[fact('t1',++seq,22,3),fact('t2',++seq,23,2),fact('t3',++seq,22,2)];insert(e);
  const c=readHabitFile('constraints');
  writeHabitFile('constraints',{...c,payload:{entries:[{id:'c1',statement:'晚上20点至7点不安排工作',kind:'forbidden_window',enabled:true,value:'20:00-07:00'}]}});
  assert.equal(persistObservedHabits(db,cfg,[hypothesis(e,{preferred_hours:[22,23]})],e,0,now),0);
});
test('disabling or lacking connection verification prevents scheduling and inference',async()=>{
  recordAgentConnection(cfg,false);
  let calls=0;const w=worker(async()=>{calls++;return [];});
  await w.tick();now+=2*H;await w.tick();
  assert.equal(calls,0);assert.equal(habitInferenceStatus(db,now).connected,false);
  cfg=writeRuntimeConfig({...readRuntimeConfig(),enabled:false},readRuntimeConfig().updated_at,'test');
  recordAgentConnection(cfg,true);await w.tick();assert.equal(habitInferenceStatus(db,now).connected,false);
});
test('first connected check is scheduled an hour later and insufficient input never invokes the model',async()=>{
  let calls=0;const w=await ready(async()=>{calls++;return [];});
  const initial=habitInferenceStatus(db,now);
  assert.equal(Date.parse(initial.next_run_at!)-now,H);
  insert([fact('one',++seq)]);await w.tick();assert.equal(calls,0);
  now+=H;await w.tick();assert.equal(calls,0);assert.equal(habitInferenceStatus(db,now).last_result,'insufficient');
});
test('due worker saves traceable evidence without business edits or automatic adoption',async()=>{
  const w=await ready(async(_cfg,events)=>modelReply(events));insert(usual());const before=data();
  now+=H;await w.tick();const entries=readHabitFile('inferred').payload.entries;
  assert.equal(entries.length,1);assert.equal(entries[0].source,'agent_inference');
  assert.equal(observationEvidence(entries[0].source_relation)?.sample_tasks,3);
  assert.equal(buildSettingsSnapshot().inferred[0].source_relation!==undefined,true);
  assert.equal(readHabitFile('explicit').payload.entries.length,0);
  assert.equal(data(),before);
});
test('no new action means no repeat inference or extra habit file write',async()=>{
  let calls=0;const w=await ready(async(_cfg,events)=>{calls++;return modelReply(events);});insert(usual());
  now+=H;await w.tick();const before=inferredBytes();assert.equal(calls,1);
  now+=H;await w.tick();assert.equal(calls,1);assert.equal(inferredBytes(),before);
});
test('fresh evidence updates the same pattern rather than adding a duplicate',async()=>{
  const {w,entry}=await saveOne();insert([fact('t4',++seq,10,1)]);
  now+=H;await w.tick();const list=readHabitFile('inferred').payload.entries;
  assert.equal(list.length,1);assert.equal(list[0].id,entry.id);
  assert.equal(observationEvidence(list[0].source_relation)?.sample_tasks,4);
});
test('ignored pattern stays ignored even with fresh evidence',async()=>{
  const {w,entry}=await saveOne();const file=readHabitFile('inferred');
  writeHabitFile('inferred',{...file,payload:{entries:[{...entry,enabled:false}]}});
  const before=inferredBytes();insert([fact('t4',++seq,9,1)]);now+=H;await w.tick();
  assert.equal(inferredBytes(),before);assert.equal(readHabitFile('inferred').payload.entries[0].enabled,false);
});
test('ignored task-specific observation cannot be resurrected as a general paraphrase',async()=>{
  const {entry}=await saveOne();const file=readHabitFile('inferred');
  writeHabitFile('inferred',{...file,payload:{entries:[{...entry,enabled:false}]}});
  const e=usual();insert(e);const before=inferredBytes();
  assert.equal(persistObservedHabits(db,cfg,[hypothesis(e,{task_types:[],statement:'最近总体上也经常上午开始处理工作。'})],e,0,now),0);
  assert.equal(inferredBytes(),before);
});
test('adopted observation is not automatically recreated',async()=>{
  const {w,entry}=await saveOne();const files=buildSettingsSnapshot();
  adoptSettingsInferred(entry.id,{expected_version:files.versions.inferred,expected_explicit_version:files.versions.explicit},'test');
  const before=data(),inferred=inferredBytes();insert([fact('t4',++seq,9,1)]);const protectedAfterInsert=data();
  now+=H;await w.tick();assert.equal(data(),protectedAfterInsert);
  assert.equal(inferredBytes(),inferred);assert.notEqual(before,protectedAfterInsert);
});
test('stale task version and changed settings cannot be saved',async()=>{
  const e=usual();insert(e);run(db,'UPDATE tasks SET version=version+1 WHERE id=?',[e[0].task_id]);
  assert.equal(persistObservedHabits(db,cfg,[hypothesis(e)],e,0,now),0);
  const w=await ready(async(_cfg,events)=>{
    const file=readHabitFile('explicit');
    writeHabitFile('explicit',{...file,updated_at:new Date(now).toISOString(),payload:{entries:[{id:'user-edit',statement:'用户在分析期间修改的偏好',kind:'preference',enabled:true,confidence:null,source:'user',created_at:new Date(now).toISOString(),updated_at:new Date(now).toISOString()}]}});
    return modelReply(events);
  });
  insert([fact('t4',++seq,9,1)]);now+=H;await w.tick();
  assert.equal(readHabitFile('inferred').payload.entries.length,0);
  assert.equal(habitInferenceStatus(db,now).last_error,'settings_changed');
  assert.equal(readHabitFile('explicit').payload.entries[0].id,'user-edit');
});
test('changed runtime and model errors fail closed with safe error codes',async()=>{
  const w=await ready(async()=>{throw new Error('sensitive runtime details must not be exposed');});
  insert(usual());now+=H;await w.tick();
  assert.equal(habitInferenceStatus(db,now).last_error,'inference_failed');
  assert.equal(JSON.stringify(habitInferenceStatus(db,now)).includes('sensitive'),false);
  assert.equal(readHabitFile('inferred').payload.entries.length,0);
});
test('one database cannot execute two concurrent hourly calls',async()=>{
  let calls=0;const observe:HabitInferenceWorkerOptions['observe']=async(_cfg,events)=>{calls++;await new Promise(r=>setTimeout(r,20));return modelReply(events);};
  const a=await ready(observe),b=await ready(observe);insert(usual());now+=H;
  await Promise.all([a.tick(),b.tick()]);assert.equal(calls,1);
});
test('stopping cancels an active call and releases the persisted lease',async()=>{
  let started!:()=>void;const begin=new Promise<void>(r=>{started=r;});
  const w=await ready(async(_cfg,_events,signal)=>{started();return await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('canceled')),{once:true}));});
  insert(usual());now+=H;const pending=w.tick();await begin;w();await pending;
  assert.equal(habitInferenceStatus(db,now).running,false);
  assert.equal(get<any>(db,'SELECT value FROM schema_meta WHERE key=?',[KEY])!==undefined,true);
  assert.equal(readHabitFile('inferred').payload.entries.length,0);
});
test('legacy and expired observations do not take effect; real connected Chinese hour advice can affect ranking',async()=>{
  const {entry}=await saveOne();
  assert.equal(usableObservation({...entry,source:'observed'}),false);
  assert.equal(usableObservation(entry,now+31*86400000),false);
  const ctx=loadHabitContext();assert.equal(ctx.inferred.length,1);
  const t=findTask(db,'t1')!,time=new Date(fact('time',1,9,1).at);
  const enabled=scoreTask(t,buildScoringContext([t],ctx,time)).factors.find(f=>f.key==='habit_alignment')!.value;
  recordAgentConnection(cfg,false);
  const off=loadHabitContext();assert.equal(off.inferred.length,0);
  const disabled=scoreTask(t,buildScoringContext([t],off,time)).factors.find(f=>f.key==='habit_alignment')!.value;
  assert.ok(enabled>disabled);
});
test('status GET is read-only',async()=>{
  const before=JSON.stringify(all(db,'SELECT * FROM schema_meta'));
  const router=buildRouter(()=>db),matched=router.match('GET','/api/settings/inference-status')!;
  await matched.handler({} as any);
  assert.equal(JSON.stringify(all(db,'SELECT * FROM schema_meta')),before);
});
test('production timer polls each minute while inference remains hourly',async(t)=>{
  let callback:()=>void=()=>{},period=0,calls=0,cleared=false;
  const fakeTimer={unref:()=>{}} as any;
  t.mock.method(globalThis,'setInterval',(cb:()=>void,ms:number)=>{callback=cb;period=ms;return fakeTimer;});
  t.mock.method(globalThis,'clearInterval',()=>{cleared=true;});
  const w=startHabitInferenceWorker(db,{now:()=>now,probe:async()=>({ok:true,reason:null,checkedAt:new Date(now).toISOString()}),
    observe:async(_cfg,events)=>{calls++;return modelReply(events);}});
  stops.push(w);assert.equal(period,60000);
  insert(usual());callback();await new Promise(r=>setImmediate(r));assert.equal(calls,0);
  now+=H;callback();await new Promise(r=>setImmediate(r));assert.equal(calls,1);
  callback();await new Promise(r=>setImmediate(r));assert.equal(calls,1);
  w();assert.equal(cleared,true);
});
test('runtime changes during a call cannot apply the old result',async()=>{
  const w=await ready(async(_cfg,events)=>{
    const current=readRuntimeConfig();
    writeRuntimeConfig({...current,model:'changed-during-analysis'},current.updated_at,'test');
    return modelReply(events);
  });
  insert(usual());now+=H;await w.tick();
  assert.equal(habitInferenceStatus(db,now).last_error,'runtime_changed');
  assert.equal(readHabitFile('inferred').payload.entries.length,0);
});
test('CLI timeout removes its private instruction file and never stores an observation',async(t)=>{
  const executable=path.join(root,'timeout.sh');
  fs.writeFileSync(executable,'#!/bin/sh\ncat >/dev/null\nsleep 2\necho "{}"\n',{mode:0o755});
  const original=fs.mkdtempSync.bind(fs);
  let instructionDirectory='';
  t.mock.method(fs,'mkdtempSync',((prefix:string,options?:any)=>{
    const directory=original(prefix,options) as string;
    if(prefix.includes('princeq-habit-observer-'))instructionDirectory=directory;
    return directory;
  }) as any);
  const before=inferredBytes();
  await assert.rejects(()=>requestHabitObservations({...cfg,cli_path:executable,timeout_ms:500},usual(),new AbortController().signal),/agent_unavailable/);
  assert.ok(instructionDirectory.includes('princeq-habit-observer-'));
  assert.equal(fs.existsSync(instructionDirectory),false);
  assert.equal(inferredBytes(),before);
});

test('real CLI adapter rejects unstructured replies without touching habits',async()=>{
  const executable=path.join(root,'malformed.sh');
  fs.writeFileSync(executable,'#!/bin/sh\ncat >/dev/null\necho malformed-output\n',{mode:0o755});
  const before=inferredBytes();
  await assert.rejects(()=>requestHabitObservations({...cfg,cli_path:executable},usual(),new AbortController().signal),/invalid_reply/);
  assert.equal(inferredBytes(),before);
});
