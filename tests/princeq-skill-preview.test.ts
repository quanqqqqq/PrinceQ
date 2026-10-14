/** Real Skill routes with in-memory DB and isolated settings; no model or live API. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {SkillOperation} from '../server/skills/catalog.ts';
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'princeq-skill-preview-'));
process.env.PWQ_HABITS_DIR=path.join(temporary,'habits');
process.env.PWQ_DB_PATH=path.join(temporary,'unused.db');
process.env.PWQ_AGENT_RUNTIME_CONFIG=path.join(temporary,'runtime.json');
const {freshDb}=await import('./helpers.ts');
const {all}=await import('../server/db/connection.ts');
const {buildRouter}=await import('../server/http/routes.ts');
const {ensureHabitFiles,updateDurationPrefs,buildSettingsSnapshot,addExplicitHabit}=await import('../server/domain/habits.ts');
const {createTask,updateTask,addDependency}=await import('../server/repo/task-service.ts');
const {createGoal}=await import('../server/repo/goal-service.ts');
const {findTask,findGoal}=await import('../server/repo/tasks.ts');
const {ApiError}=await import('../server/lib/errors.ts');
const {buildPrinceQContext,readPrinceQSystemPrompt}=await import('../server/agent/prompt-context.ts');
const {composePrinceQSystemPrompt}=await import('../server/skills/injection.ts');
const {defaultRuntimeConfig}=await import('../server/agent/runtime-config.ts');
const {buildProviderPromptArgs}=await import('../server/agent/cli-exec.ts');
type Db=ReturnType<typeof freshDb>;
let db:Db;
let router:ReturnType<typeof buildRouter>;
let nextKey=0;
test.beforeEach(()=>{fs.rmSync(process.env.PWQ_HABITS_DIR!,{recursive:true,force:true});ensureHabitFiles();db=freshDb();router=buildRouter(()=>db);updateDurationPrefs({hours_per_day:4,days_per_month:17},'test');});
test.afterEach(()=>db.close());
test.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
async function call(method:string,url:string,body?:unknown,key?:string):Promise<any> {
  const matched=router.match(method,url);assert.ok(matched);
  return matched.handler({req:{headers:{}},url:new URL('http://isolated'+url),params:matched.params,body,idempotencyKey:key??`skill-test-${++nextKey}`} as never);
}
function operation(name:string,payload:Record<string,unknown>,id?:string):SkillOperation {return {action:'skill_operation',operation:name,payload,...(id?{target_id:id}:{})};}
async function preview(...actions:SkillOperation[]){return call('POST','/api/skills/princeq/previews',{actions});}
async function confirm(token:string,key?:string){return call('POST',`/api/skills/princeq/previews/${token}/confirm`,{confirmed:true},key);}
const rejected409=(error:unknown)=>error instanceof ApiError&&error.status===409;

test('耗时预览展示实际换算分钟，生成时不创建业务数据',async()=>{
  const result=await preview(operation('task.create',{title:'单位耗时任务',duration_value:0.25,duration_unit:'day'}));
  assert.equal(all(db,'SELECT * FROM tasks').length,0);
  assert.match(result.result.blocks[0].items[0],/60 分钟/);
  assert.ok(result.actions[0].preconditions.some((g:{resource:string})=>g.resource==='settings'));
  await confirm(result.token);
  assert.equal(all(db,'SELECT estimated_minutes FROM tasks')[0].estimated_minutes,60);
});
test('新任务预览后换算设置改变，确认拒绝且不创建任务',async()=>{
  const result=await preview(operation('task.create',{title:'过期耗时创建',duration_value:0.25,duration_unit:'day'}));
  updateDurationPrefs({hours_per_day:5},'concurrent');
  await assert.rejects(confirm(result.token),rejected409);
  assert.equal(all(db,'SELECT * FROM tasks').length,0);
  assert.equal((await call('GET',`/api/skills/princeq/previews/${result.token}`)).status,'pending');
});
test('编辑耗时预览后换算设置改变，不覆盖已保存分钟和原单位',async()=>{
  const task=createTask(db,{title:'已有耗时任务',duration_value:0.5,duration_unit:'day'});
  const result=await preview(operation('task.update',{duration_value:0.25,duration_unit:'day'},task.id));
  updateDurationPrefs({hours_per_day:5},'concurrent');
  await assert.rejects(confirm(result.token),rejected409);
  assert.equal(findTask(db,task.id)!.estimated_minutes,120);
  assert.equal(findTask(db,task.id)!.duration_value,0.5);
});
test('新任务的分类输入习惯改变也会使旧预览失效',async()=>{
  const result=await preview(operation('task.create',{title:'依赖习惯的任务'}));
  addExplicitHabit({statement:'每天先处理审核类任务'},'test');
  await assert.rejects(confirm(result.token),rejected409);
  assert.equal(all(db,'SELECT * FROM tasks').length,0);
});
test('只读显示名称不会改变目标定位，也不会进入保存的执行合同',async()=>{
  const first=createTask(db,{title:'展示对象一'}),second=createTask(db,{title:'展示对象二'});
  const result=await preview({...operation('task.update',{description:'只改第二条'},second.id),display_title:first.title});
  assert.equal(result.actions[0].display_title,undefined);
  assert.match(result.result.blocks[0].items[0],/展示对象二/);
  await confirm(result.token);
  assert.equal(findTask(db,first.id)!.description,null);assert.equal(findTask(db,second.id)!.description,'只改第二条');
});
test('未注册的执行字段仍然整条拒绝，展示字段不能藏入 payload',async()=>{
  await assert.rejects(preview({...operation('task.create',{title:'无效操作'}),shell:'touch /tmp/not-allowed'} as SkillOperation),e=>e instanceof ApiError&&e.status===400);
  await assert.rejects(preview(operation('task.create',{title:'无效操作',display_title:'不能作为写字段'})),e=>e instanceof ApiError&&e.status===400);
  assert.equal(all(db,'SELECT * FROM tasks').length,0);
});
test('全局设置的已知单例标签不参与执行，未知标签不接受',async()=>{
  for(const alias of ['personal','settings']) {
    const settings=buildSettingsSnapshot();
    const result=await preview(operation('settings.conversion.update',{hours_per_day:5,expected_version:settings.versions.weights},alias));
    assert.equal(result.actions[0].target_id,undefined);await confirm(result.token);
    assert.equal(buildSettingsSnapshot().conversion.hours_per_day,5);
  }
  const settings=buildSettingsSnapshot();
  await assert.rejects(preview(operation('settings.conversion.update',{hours_per_day:6,expected_version:settings.versions.weights},'another-user')),e=>e instanceof ApiError&&e.status===400);
});
test('没有 confirmed=true 的外部确认不执行',async()=>{
  const result=await preview(operation('goal.create',{title:'未确认目标'}));
  await assert.rejects(call('POST',`/api/skills/princeq/previews/${result.token}/confirm`,{}),e=>e instanceof ApiError&&e.status===400);
  assert.equal(all(db,'SELECT * FROM goals').length,0);
});
test('重复确认同一幂等键只创建一次，已确认预览不能取消',async()=>{
  const result=await preview(operation('task.create',{title:'幂等创建'}));
  await confirm(result.token,'same-confirm-key');await confirm(result.token,'same-confirm-key');
  assert.equal(all(db,'SELECT * FROM tasks').length,1);
  await assert.rejects(call('POST',`/api/skills/princeq/previews/${result.token}/cancel`,{}),rejected409);
});
test('取消预览不创建目标，取消后不能确认',async()=>{
  const result=await preview(operation('goal.create',{title:'取消的目标'}));
  await call('POST',`/api/skills/princeq/previews/${result.token}/cancel`,{});
  await assert.rejects(confirm(result.token),e=>e instanceof ApiError&&e.status===404);
  assert.equal(all(db,'SELECT * FROM goals').length,0);
});
test('批次后续动作失败，前面的有效 SQL 更新及日志一起回滚',async()=>{
  const task=createTask(db,{title:'原任务',description:'原说明'});
  const result=await preview(operation('task.update',{description:'不应保存'},task.id),operation('task.action',{action:'complete'},task.id));
  const before=all(db,'SELECT id FROM operations');
  await assert.rejects(confirm(result.token),rejected409);
  assert.equal(findTask(db,task.id)!.description,'原说明');assert.equal(findTask(db,task.id)!.version,task.version);
  assert.deepEqual(all(db,'SELECT id FROM operations'),before);
});
test('稳定 ID 可以区分同名任务，旧预览不能覆盖并发修改',async()=>{
  const first=createTask(db,{title:'相同名称'}),second=createTask(db,{title:'相同名称'});
  const result=await preview(operation('task.update',{description:'只改第二条'},second.id));
  await confirm(result.token);assert.equal(findTask(db,first.id)!.description,null);assert.equal(findTask(db,second.id)!.description,'只改第二条');
  const stale=await preview(operation('task.update',{description:'过期修改'},second.id));
  updateTask(db,second.id,{description:'更新的数据'});
  await assert.rejects(confirm(stale.token),rejected409);assert.equal(findTask(db,second.id)!.description,'更新的数据');
});
test('删除目标保留关联任务；删除任务解除依赖且其他任务保留',async()=>{
  const goal=createGoal(db,{title:'要删除的目标'}),linked=createTask(db,{title:'保留的关联任务',goal_id:goal.id});
  const dependent=createTask(db,{title:'另一任务'});addDependency(db,dependent.id,linked.id);
  const goalPreview=await preview(operation('goal.delete',{},goal.id));await confirm(goalPreview.token);
  assert.equal(findGoal(db,goal.id),null);assert.equal(findTask(db,linked.id)!.goal_id,null);assert.ok(findTask(db,dependent.id));
  const taskPreview=await preview(operation('task.delete',{},linked.id));await confirm(taskPreview.token);
  assert.equal(findTask(db,linked.id),null);assert.deepEqual(findTask(db,dependent.id)!.depends_on,[]);
});
test('个人设置进入两种 CLI 的原生系统指令，更新后重新读取且不改旧任务耗时',()=>{
  const task=createTask(db,{title:'旧耗时任务',duration_value:0.5,duration_unit:'day'});
  const req={db,message:'只读取上下文',actorId:'actor-human-me',idempotencyKey:'context-read'};
  const cfg=defaultRuntimeConfig(),before=composePrinceQSystemPrompt(readPrinceQSystemPrompt(),buildPrinceQContext(req,cfg));
  assert.match(before, /PERSONAL_SETTINGS_DATA_BEGIN/);assert.match(before,/"hours_per_day":4/);assert.match(before,/personal-work-queue/);assert.match(before,/"name":"task.delete"/);
  updateDurationPrefs({hours_per_day:5},'test');
  const after=composePrinceQSystemPrompt(readPrinceQSystemPrompt(),buildPrinceQContext(req,cfg));
  assert.match(after,/"hours_per_day":5/);assert.equal(findTask(db,task.id)!.estimated_minutes,120);
  const args={systemPrompt:after,systemPromptFile:'/tmp/private-princeq.md',promptViaStdin:true};
  assert.ok(buildProviderPromptArgs('claude','',cfg,args).includes('--system-prompt-file'));
  assert.ok(buildProviderPromptArgs('codex','',cfg,args).includes('model_instructions_file="/tmp/private-princeq.md"'));
  assert.equal(buildSettingsSnapshot().conversion.hours_per_day,5);
});
