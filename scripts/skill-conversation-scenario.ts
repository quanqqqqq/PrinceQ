/** Live Skill conversation scenario. Only isolated DB/settings are modified. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
const provider=process.argv[2]??'claude';
assert.ok(provider==='claude'||provider==='codex','provider must be claude or codex');
const selectedModel=process.env.PWQ_SCENARIO_MODEL??null;
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'princeq-conversation-'+provider+'-'));
process.env.PWQ_DB_PATH=path.join(dir,'db.sqlite');process.env.PWQ_HABITS_DIR=path.join(dir,'habits');process.env.PWQ_AGENT_RUNTIME_CONFIG=path.join(dir,'runtime.json');process.env.PWQ_API_PORT='0';process.env.PWQ_TIME_ZONE='Asia/Shanghai';
const {getDb,closeDb,all}=await import('../server/db/connection.ts');
const {seedActors}=await import('../server/db/seed.ts');
const {ensureHabitFiles,updateDurationPrefs,addExplicitHabit}=await import('../server/domain/habits.ts');
const {createGoal}=await import('../server/repo/goal-service.ts');
const {createServer}=await import('../server/index.ts');
const {defaultRuntimeConfig,writeRuntimeConfig}=await import('../server/agent/runtime-config.ts');
const {detectCli}=await import('../server/agent/detect.ts');
const db=getDb();seedActors(db);ensureHabitFiles();updateDurationPrefs({hours_per_day:3,days_per_month:17},'scenario');
addExplicitHabit({statement:'安排工作时优先推进目标相关的任务'},'scenario');
const goal=createGoal(db,{title:'【场景测试】工作交付目标',description:'仅用于临时联调'});
const detection=await detectCli({provider});const cli=detection.candidates.find(candidate=>candidate.provider===provider&&candidate.exists&&candidate.exit_code===0);assert.ok(cli,'No usable CLI detected');
writeRuntimeConfig({...defaultRuntimeConfig(),provider,enabled:true,cli_path:cli.path,model:selectedModel,timeout_ms:120000},defaultRuntimeConfig().updated_at,'actor-human-me');
const server=createServer();await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
const address=server.address();assert.ok(address&&typeof address!=='string');const base='http://127.0.0.1:'+address.port;
const report:{provider:string;model:string|null;dir:string;api:string;ok:boolean;turns:any[];checks:string[];error?:string}={provider,model:selectedModel,dir,api:base,ok:false,turns:[],checks:[]};
const writeReport=()=>{fs.writeFileSync(path.join(dir,'report.json'),JSON.stringify(report,null,2));if(process.env.PWQ_SCENARIO_REPORT)fs.writeFileSync(process.env.PWQ_SCENARIO_REPORT,JSON.stringify(report,null,2));};
async function api(url:string,body?:unknown,key=crypto.randomUUID()) {const response=await fetch(base+url,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json','idempotency-key':key},body:body===undefined?undefined:JSON.stringify(body)});const result=await response.json();assert.ok(response.ok,JSON.stringify(result));return result;}
function business() {return JSON.stringify({tasks:all(db,'SELECT * FROM tasks ORDER BY id'),goals:all(db,'SELECT * FROM goals ORDER BY id'),habits:fs.readdirSync(process.env.PWQ_HABITS_DIR!).sort().map(name=>fs.readFileSync(path.join(process.env.PWQ_HABITS_DIR!,name),'utf8'))});}
let session:string|undefined;
async function turn(label:string,message:string,operation?:string) {
  const before=business(),start=Date.now();console.log(provider+': '+label+' running');
  const reply=await api('/api/agent/message',{message,session_id:session,processing_mode:'agent',fallback:false});session=reply.session.id;
  report.turns.push({label,user:message,reply,latency_ms:Date.now()-start});writeReport();
  assert.equal(reply.source,'agent');assert.equal(business(),before,'Model changed business data before confirmation');
  if(!operation){assert.equal(reply.result.pending_action,null);return {reply};}
  assert.equal(reply.result.kind,'preview',JSON.stringify(reply.result));
  const token=reply.result.pending_action.token,pending=await api('/api/skills/princeq/previews/'+token);
  assert.equal(pending.status,'pending');assert.equal(pending.actions.length,1);
  assert.equal(pending.actions[0].action,'skill_operation');assert.equal(pending.actions[0].operation,operation);
  report.checks.push(label+': preview_before_write');return {reply,token,action:pending.actions[0],before};
}
async function confirm(token:string) {
  const key=crypto.randomUUID();await api('/api/skills/princeq/previews/'+token+'/confirm',{confirmed:true},key);
  const after=business();await api('/api/skills/princeq/previews/'+token+'/confirm',{confirmed:true},key);assert.equal(business(),after);
  report.checks.push('confirm_idempotent');
}
try {
  const title='【'+provider+' 场景】登记分析任务';
  const registration=await turn('登记',`请登记一个任务“${title}”，说明“整理当前需求”，关联到现有“${goal.title}”，类型deep_work，预计0.25天。先给预览，等待确认。`,'task.create');
  assert.equal(registration.action.payload.goal_id,goal.id);await confirm(registration.token);
  const task=all(db,'SELECT * FROM tasks WHERE title = ?',[title])[0];assert.ok(task);assert.equal(task.estimated_minutes,45);report.checks.push('registration_readback_45_minutes');
  const query=await turn('查询','查一下刚才登记的那个任务，告诉我名称、说明、所属目标和保存的预计分钟数。不修改数据。');
  const answer=query.reply.result.answer??query.reply.result.headline;assert.ok(answer.includes(title)&&answer.includes('45')&&answer.includes(goal.title),answer);report.checks.push('history_query_fact_readback');
  const adjustedTitle=title+'（调整后）';
  const adjustment=await turn('调整',`把刚才那个任务的名称改为“${adjustedTitle}”，说明改成“先整理范围，再输出分析结论”，预计耗时改为0.5天，保留目标关联。先给预览。`,'task.update');
  assert.equal(adjustment.action.target_id,task.id);await confirm(adjustment.token);
  const changed=all(db,'SELECT * FROM tasks WHERE id = ?',[task.id])[0];assert.equal(changed.title,adjustedTitle);assert.equal(changed.description,'先整理范围，再输出分析结论');assert.equal(changed.estimated_minutes,90);assert.equal(changed.goal_id,goal.id);report.checks.push('adjustment_readback_90_minutes');
  const deletion=await turn('删除',`永久删除刚才调整的任务“${adjustedTitle}”，不删除它所属的目标。先让我查看删除预览。`,'task.delete');
  assert.equal(deletion.action.target_id,task.id);assert.ok(all(db,'SELECT id FROM tasks WHERE id = ?',[task.id]).length);await confirm(deletion.token);
  assert.equal(all(db,'SELECT id FROM tasks WHERE id = ?',[task.id]).length,0);assert.ok(all(db,'SELECT id FROM goals WHERE id = ?',[goal.id]).length);report.checks.push('deletion_readback_goal_retained');
  report.ok=true;console.log(provider+': conversation scenario passed');
} catch(error) {report.error=error instanceof Error?error.message:String(error);process.exitCode=1;console.error(provider+': '+report.error);}
finally {writeReport();await new Promise<void>(resolve=>server.close(()=>resolve()));closeDb();console.log('SCENARIO_REPORT '+path.join(dir,'report.json'));}
