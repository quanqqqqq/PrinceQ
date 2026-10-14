import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { peakHoursFor, setTypePeakHours, sameTypePeakHours } from '../shared/peak-hours.ts';
import { isWeightsDirty, DEFAULT_BALANCED_WEIGHTS } from '../src/components/settings/settings-contract.ts';

test('类型时段：缺失继承、空数组明确不设、恢复继承且不修改输入', () => {
  const original = {deep_work:[9],communication:[]};
  assert.deepEqual(peakHoursFor('deep_work',[14],original),[9]);
  assert.deepEqual(peakHoursFor('communication',[14],original),[]);
  assert.deepEqual(peakHoursFor('review',[14],original),[14]);
  const next = setTypePeakHours(original,'deep_work',undefined);
  assert.deepEqual(peakHoursFor('deep_work',[14],next),[14]);
  assert.deepEqual(original.deep_work,[9]);
  assert.deepEqual(setTypePeakHours({},'learning',[15,9,15]).learning,[9,15]);
});
test('独立时段比较按集合，missing与empty不同；恢复权重保留独立设置', () => {
  assert.equal(sameTypePeakHours({deep_work:[14,9]},{deep_work:[9,14]}),true);
  assert.equal(sameTypePeakHours({}, {deep_work:[]}),false);
  const original={weights:{...DEFAULT_BALANCED_WEIGHTS},peak_hours:[9],preferred_task_types:[],task_type_peak_hours:{deep_work:[14]}};
  assert.equal(isWeightsDirty(original,{...original,task_type_peak_hours:{deep_work:[]}}),true);
  assert.equal(isWeightsDirty(original,{...original,task_type_peak_hours:{deep_work:[14]}}),false);
  const reset={...original,weights:{...DEFAULT_BALANCED_WEIGHTS}};
  assert.deepEqual(reset.task_type_peak_hours,{deep_work:[14]});
});

const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'pwq-type-peaks-'));
process.env.PWQ_HABITS_DIR=path.join(tmp,'habits');
process.env.PWQ_DB_PATH=path.join(tmp,'unused.db');
const {freshDb,makeTask,emptyHabits}=await import('./helpers.ts');
const {buildRouter}=await import('../server/http/routes.ts');
const {ensureHabitFiles,readHabitFile,loadHabitContext}=await import('../server/domain/habits.ts');
const {scoreTask,buildScoringContext}=await import('../server/domain/queue.ts');
const {ApiError}=await import('../server/lib/errors.ts');
let key=0;
async function call(router: ReturnType<typeof buildRouter>,method:string,url:string,body?:unknown,id?:string):Promise<any> {
  const route=router.match(method,url)!;
  return route.handler({url:new URL('http://local'+url),params:route.params,body,idempotencyKey:id??'type-peaks-'+(++key)} as never);
}
function setup(){fs.rmSync(process.env.PWQ_HABITS_DIR!,{force:true,recursive:true});ensureHabitFiles();const db=freshDb();return {db,router:buildRouter(()=>db)};}
test('独立时段真实进入队列因子：同一时间各类型得分不同，旧全局兼容', () => {
  const at=new Date(2026,9,14,9);
  const deep=makeTask({task_type:'deep_work',cognitive_load:'high'});
  const comm=makeTask({task_type:'communication',cognitive_load:'high'});
  const habits=emptyHabits({peakHours:[9],peakHoursByTaskType:{deep_work:[],communication:[9]}});
  const ctx=buildScoringContext([deep,comm],habits,at);
  const factor=(task: typeof deep,c=ctx)=>scoreTask(task,c).factors.find(f=>f.key==='habit_alignment')!.value;
  assert.ok(factor(comm)>factor(deep));
  const old=buildScoringContext([deep,comm],emptyHabits({peakHours:[9]}),at);
  const inherited=buildScoringContext([deep,comm],emptyHabits({peakHours:[9],peakHoursByTaskType:{}}),at);
  assert.equal(factor(deep,old),factor(deep,inherited));
});
test('保存、预览零写、版本冲突、幂等、转换更新保持类型时段', async () => {
  const {db,router}=setup();
  const snap=await call(router,'GET','/api/settings');
  const mapping={deep_work:[9,10],communication:[]};
  const body={weights:snap.weights.weights,task_type_peak_hours:mapping,expected_version:snap.versions.weights};
  const saved=await call(router,'POST','/api/settings/weights',body,'type-peaks-save');
  assert.deepEqual(saved.snapshot.weights.task_type_peak_hours,mapping);
  assert.deepEqual(loadHabitContext().peakHoursByTaskType,mapping);
  const before=fs.readFileSync(path.join(process.env.PWQ_HABITS_DIR!,'weights.json'),'utf8');
  const opCount=()=>Number((db.prepare('SELECT count(*) AS n FROM operations').get() as any).n);
  const count=opCount();
  const preview=await call(router,'POST','/api/settings/weights/preview',{weights:snap.weights.weights,task_type_peak_hours:{learning:[15]}});
  assert.match(preview.message,/1/);
  assert.equal(fs.readFileSync(path.join(process.env.PWQ_HABITS_DIR!,'weights.json'),'utf8'),before);
  const replay=await call(router,'POST','/api/settings/weights',body,'type-peaks-save');
  assert.deepEqual(replay.snapshot.weights.task_type_peak_hours,mapping);
  assert.equal(opCount(),count);
  await assert.rejects(call(router,'POST','/api/settings/weights',body),e=>e instanceof ApiError&&e.status===409);
  const converted=await call(router,'POST','/api/settings/conversion',{hours_per_day:6,expected_version:saved.snapshot.versions.weights});
  assert.deepEqual(converted.snapshot.weights.task_type_peak_hours,mapping);
  assert.equal(converted.snapshot.conversion.hours_per_day,6);
  db.close();
});
test('非法类型/小时/结构全部拒绝且文件、操作数不变；旧文件读取不回填',async()=>{
  const {db,router}=setup();
  const file=path.join(process.env.PWQ_HABITS_DIR!,'weights.json');
  const raw=JSON.parse(fs.readFileSync(file,'utf8'));delete raw.payload.task_type_peak_hours;
  fs.writeFileSync(file,JSON.stringify(raw));
  const before=fs.readFileSync(file,'utf8');
  const snap=await call(router,'GET','/api/settings');
  assert.deepEqual(readHabitFile('weights').payload.task_type_peak_hours,{});
  assert.equal(fs.readFileSync(file,'utf8'),before);
  for(const map of [{unknown:[9]},{deep_work:[24]},{deep_work:[-1]},{deep_work:[9.5]},{deep_work:null},[]]){
    await assert.rejects(call(router,'POST','/api/settings/weights',{weights:snap.weights.weights,task_type_peak_hours:map,expected_version:snap.versions.weights}),e=>e instanceof ApiError&&e.status===400);
  }
  assert.equal(fs.readFileSync(file,'utf8'),before);
  assert.equal(Number((db.prepare('SELECT count(*) AS n FROM operations').get() as any).n),0);
  db.close();
});
