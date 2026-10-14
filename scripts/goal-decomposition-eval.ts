/** Ten live goal-draft cases against the actual HTTP/model/Skill path. Isolated data only. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const provider=process.argv[2]??'claude';
assert.ok(provider==='claude'||provider==='codex');
const uiFirst=process.argv.includes('--ui-first');
const only=process.argv.find(v=>v.startsWith('--cases='))?.slice(8).split(',');
const tag=process.argv.find(v=>v.startsWith('--tag='))?.slice(6)??'baseline';
const root=path.resolve(import.meta.dirname,'..');
const cases=JSON.parse(fs.readFileSync(path.join(root,'scripts/fixtures/goal-decomposition-cases.json'),'utf8')).filter((c:any)=>!only||only.includes(c.id));
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'princeq-goal-eval-'+provider+'-'));
process.env.PWQ_DB_PATH=path.join(dir,'work.db');
process.env.PWQ_HABITS_DIR=path.join(dir,'habits');
process.env.PWQ_AGENT_RUNTIME_CONFIG=path.join(dir,'runtime.json');
process.env.PWQ_API_PORT='0';process.env.PWQ_TIME_ZONE='Asia/Shanghai';
assert.ok(process.env.PWQ_DB_PATH.startsWith(dir+path.sep));
const {getDb,closeDb,all}=await import('../server/db/connection.ts');
const {seedActors}=await import('../server/db/seed.ts');
const {createGoal}=await import('../server/repo/goal-service.ts');
const {createTask,applyAction}=await import('../server/repo/task-service.ts');
const {ensureHabitFiles,readHabitFile,writeHabitFile,addExplicitHabit,setHabitEnabled,updateDurationPrefs}=await import('../server/domain/habits.ts');
const {defaultRuntimeConfig,writeRuntimeConfig}=await import('../server/agent/runtime-config.ts');
const {detectCli}=await import('../server/agent/detect.ts');
const {createServer}=await import('../server/index.ts');
const db=getDb();seedActors(db);ensureHabitFiles();
const cli=(await detectCli({provider:provider as any})).candidates.find(c=>c.provider===provider&&c.exists&&c.exit_code===0);
assert.ok(cli,'No usable '+provider+' CLI');
const defaultCfg=defaultRuntimeConfig();
writeRuntimeConfig({...defaultCfg,provider:provider as any,enabled:true,cli_path:cli.path,model:process.env.PWQ_EVAL_MODEL??null,timeout_ms:120000},defaultCfg.updated_at,'actor-human-me');
const server=createServer();
const captured:any[]=[];
server.prependListener('request',(req,res)=>{
  if(req.url!=='/api/agent/message')return;
  const original=res.end.bind(res);
  (res as any).end=(chunk:any,...args:any[])=>{
    try{captured.push(JSON.parse(String(chunk)));}catch{ /* only complete JSON replies */ }
    return original(chunk,...args as any);
  };
});
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
const address=server.address();assert.ok(address&&typeof address!=='string');
const base='http://127.0.0.1:'+address.port;
assert.notEqual(address.port,28642);
let web:any=null;
const report:any={provider,model:process.env.PWQ_EVAL_MODEL??'CLI default',tag,dir,api:base,started_at:new Date().toISOString(),cases:[],ok:false};
const reportPath=process.env.PWQ_EVAL_REPORT??path.join(dir,'report.json');
function save(){fs.writeFileSync(reportPath,JSON.stringify(report,null,2));fs.writeFileSync(path.join(dir,'report.json'),JSON.stringify(report,null,2));}
function promptHash(){return crypto.createHash('sha256').update(['server/agent/princeq-system-prompt.md','skill/SKILL.md','skill/references/scoring.md'].map(p=>fs.readFileSync(path.join(root,p),'utf8')).join('\n')).digest('hex');}
async function api(url:string,body?:any,key=crypto.randomUUID()){
  const response=await fetch(base+url,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json','idempotency-key':key},body:body===undefined?undefined:JSON.stringify(body)});
  const result=await response.json();assert.ok(response.ok,JSON.stringify(result));return result as any;
}
function business(){
  const names=['tasks','goals','task_assignments','task_dependencies','rescoring_requests','queue_snapshots','queue_entries','operations'];
  const exists=new Set(all(db,"SELECT name FROM sqlite_master WHERE type='table'").map(r=>r.name));
  return JSON.stringify({tables:Object.fromEntries(names.filter(n=>exists.has(n)).map(n=>[n,all(db,'SELECT * FROM "'+n+'" ORDER BY rowid')])),
    habits:fs.readdirSync(process.env.PWQ_HABITS_DIR!).filter(n=>n.endsWith('.json')).sort().map(n=>[n,fs.readFileSync(path.join(process.env.PWQ_HABITS_DIR!,n),'utf8')]),
    config:fs.readFileSync(process.env.PWQ_AGENT_RUNTIME_CONFIG!,'utf8')});
}
function reset(){
  db.exec('PRAGMA foreign_keys=OFF');
  for(const row of all(db,"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")) {
    if(['actors','schema_meta'].includes(row.name))continue;
    db.exec('DELETE FROM "'+row.name.replaceAll('"','""')+'"');
  }
  db.exec('PRAGMA foreign_keys=ON');
  for(const name of ['explicit','inferred','constraints'] as const){
    const f=readHabitFile(name);writeHabitFile(name,{...f,payload:{entries:[]},history:[]});
  }
  updateDurationPrefs({hours_per_day:3,days_per_month:17},'isolated-evaluation');
}
function seed(c:any){
  reset();
  for(const statement of c.habits??[])addExplicitHabit({statement},'evaluation');
  for(const statement of c.disabled_habits??[]){
    const h=addExplicitHabit({statement},'evaluation');setHabitEnabled('explicit',h.id,false,'evaluation');
  }
  if(c.daily_minutes){const f=readHabitFile('constraints');writeHabitFile('constraints',{...f,payload:{entries:[{id:'test-daily-cap',kind:'max_daily_minutes',statement:'\u6bcf\u5929\u5b66\u4e60\u6700\u591a '+c.daily_minutes+' \u5206\u949f',value:String(c.daily_minutes),enabled:true}]}});}
  const goal=createGoal(db,{title:c.title,description:c.description,target_date:c.target_hours?new Date(Date.now()+c.target_hours*3600000).toISOString():null});
  if(c.other_goal_description)createGoal(db,{title:c.title,description:c.other_goal_description});
  for(const item of c.existing??[]){
    const task=createTask(db,{title:item.title,description:item.description,goal_id:goal.id,estimated_minutes:30});
    if(item.status!=='inbox'){
      applyAction(db,task.id,{action:'claim',actor_id:'actor-human-me'});
      applyAction(db,task.id,{action:'start',actor_id:'actor-human-me'});
      if(item.status==='completed')applyAction(db,task.id,{action:'complete',actor_id:'actor-human-me'});
      if(item.status==='blocked')applyAction(db,task.id,{action:'block',actor_id:'actor-human-me',reason:'\u7b49\u5f85\u6d4b\u8bd5\u5e93\u5907\u4efd\u6587\u4ef6'});
    }
  }
  return goal;
}
function message(title:string){return '\u8bf7\u7ed3\u5408\u76ee\u6807\u300c'+title+'\u300d\u7684\u8bf4\u660e\u3001\u5df2\u6709\u4efb\u52a1\u548c\u6211\u7684\u5de5\u4f5c\u4e60\u60ef\uff0c\u8865\u9f50\u5b9e\u73b0\u76ee\u6807\u6240\u9700\u7684\u4efb\u52a1\u8349\u7a3f\u3002\u4efb\u52a1\u8981\u5177\u4f53\u3001\u53ef\u6267\u884c\uff0c\u5e76\u8bf4\u660e\u4ea4\u4ed8\u7269\u6216\u9a8c\u6536\u6807\u51c6\uff1b\u907f\u514d\u91cd\u590d\u5df2\u6709\u4efb\u52a1\u3002\u8bf7\u751f\u6210\u53ef\u521b\u5efa\u7684\u5f85\u786e\u8ba4\u4efb\u52a1\u9884\u89c8\uff0c\u786e\u8ba4\u524d\u4e0d\u8981\u5199\u5165\u6570\u636e\u3002';}
async function waitUntil(test:()=>boolean,ms=900000){
  const started=Date.now();while(!test()){if(Date.now()-started>ms)throw new Error('UI checkpoint timed out');await new Promise(r=>setTimeout(r,250));}
}
async function turn(c:any,goal:any,session?:string,fromUI=false,records:any[]=[]){
  const before=business(),start=Date.now(),hash=promptHash();
  let reply:any;
  if(fromUI){
    const {createServer:createVite}=await import('vite');
    const {createServer:createProbe}=await import('node:net'); const probe=createProbe(); await new Promise<void>(resolve=>probe.listen(0,'127.0.0.1',resolve)); const probeAddress=probe.address(); assert.ok(probeAddress&&typeof probeAddress!=='string'); const webPort=probeAddress.port; await new Promise<void>(resolve=>probe.close(()=>resolve()));
    web=await createVite({root,configFile:path.join(root,'vite.config.ts'),server:{host:'127.0.0.1',port:webPort,strictPort:true,proxy:{'/api':{target:base,changeOrigin:false}}}});
    await web.listen();
    const addr=web.httpServer.address();
    report.ui={url:'http://127.0.0.1:'+addr.port+'/goals',case_id:c.id,goal_id:goal.id,checkpoint:path.join(dir,'ui-reviewed')};
    save();console.log('UI_READY '+JSON.stringify(report.ui));
    const index=captured.length;
    await waitUntil(()=>captured.length>index);
    reply=captured[index];
    console.log('UI_PREVIEW_READY '+JSON.stringify({source:reply.source,kind:reply.result?.kind,checkpoint:report.ui.checkpoint}));
    await waitUntil(()=>fs.existsSync(report.ui.checkpoint));
    await web.close();web=null;
  }else{
    reply=await api('/api/agent/message',{message:message(goal.title),target_goal_id:goal.id,intent:'goal_task_drafts',session_id:session,processing_mode:'agent',fallback:false});
  }
  const record:any={message:message(goal.title),reply,latency_ms:Date.now()-start,prompt_hash:hash,actions:[]};
  records.push(record);save();
  assert.equal(reply.source,'agent','must be a real Agent with no fallback');
  assert.equal(reply.result.mode,'agent');
  assert.equal(reply.result.provider,provider);
  assert.equal(business(),before,'business data changed before confirmation');
  record.business_unchanged_before_confirmation=true;
  assert.ok(!/\u5176\u4e2d \d+ \u6761\u64cd\u4f5c\u4e0d\u53d7\u652f\u6301/.test(reply.result.answer??''),'model emitted invalid actions');
  if(reply.result.pending_action){
    const pending=await api('/api/skills/princeq/previews/'+reply.result.pending_action.token);
    assert.equal(pending.status,'pending');record.actions=pending.actions;record.token=pending.token??reply.result.pending_action.token;
    assert.ok(record.actions.length>0&&record.actions.length<=20);
    for(const action of record.actions){
      assert.equal(action.action,'skill_operation');assert.equal(action.operation,'task.create');
      assert.equal(action.payload.goal_id,goal.id,'task must use the selected goal ID');
      assert.ok(action.payload.title?.trim()&&action.payload.description?.trim(),'task must have a title and completion description');
      if(c.id==='06'){assert.ok(action.payload.estimated_minutes>0&&action.payload.estimated_minutes<=30,'learning task should fit <=30 minutes');}
    }
  }
  return record;
}
try{
  for(const c of cases){
    const item:any={id:c.id,name:c.name,fixture:c,turns:[],checks:[],ok:false};report.cases.push(item);save();
    console.log(provider+' case '+c.id+' '+c.name+' RUNNING');
    try{
      const goal=seed(c);item.goal_id=goal.id;
      await api('/api/queue');
      const initial=business();
      const first=await turn(c,goal,undefined,uiFirst&&c===cases[0],item.turns);save();
      if(c.no_new){assert.equal(first.actions.length,0,'covered goal must not create duplicate work');}
      else if(c.id!=='08'&&c.id!=='07'){assert.ok(first.actions.length>0,'expected a confirmable task draft');}
      if(c.id==='07'){
        const answer=first.reply.result.answer??'';
        assert.match(answer,/(330|5.5|五个半)/);assert.match(answer,/(120|2 小时|两小时)/);
        assert.match(answer,/(缩|精简|调整|取舍|确认|协商)/);
        for(const action of first.actions)assert.match(action.payload.title,/(确认|协商|沟通|说明|评估|取舍|选择|决策|请求|调整选项)/,'without agreement only decision work is allowed');
      }
      if(c.id==='08'){
        assert.ok(first.actions.length<=3,'underspecified goal should only have near-term discovery drafts');
        for(const action of first.actions)assert.doesNotMatch(action.payload.title,/(实现.*MVP|开发.*MVP|部署|上线)/);
      }
      const seeded=(c.existing??[]).map((v:any)=>v.title.trim());
      for(const a of first.actions)assert.ok(!seeded.includes(a.payload.title.trim()),'duplicate existing task title');
      item.checks.push('real_provider','no_business_write_before_confirm','selected_goal_binding','valid_operation_contract','no_exact_duplicate_titles');
      if(c.repeat&&first.token){
        const next=await turn(c,goal,first.reply.session.id,false,item.turns);save();
        assert.equal(next.actions.length,0,'repeat click must reuse/remind the pending preview, not duplicate it');
        item.checks.push('pending_preview_not_duplicated');
      }
      if(first.token){
        if(c.id==='01'){
          const token=first.token;
          const rejected=await fetch(base+'/api/skills/princeq/previews/'+token+'/confirm',{method:'POST',headers:{'content-type':'application/json','idempotency-key':crypto.randomUUID()},body:JSON.stringify({confirmed:false})});
          assert.equal(rejected.ok,false);assert.equal(business(),initial);item.checks.push('false_confirmation_rejected');
          const key=crypto.randomUUID();await api('/api/skills/princeq/previews/'+token+'/confirm',{confirmed:true},key);
          const saved=all(db,'SELECT title,description,goal_id,estimated_minutes FROM tasks WHERE goal_id=?',[goal.id]);
          assert.equal(saved.length,first.actions.length);
          for(const a of first.actions)assert.ok(saved.some(t=>t.title===a.payload.title&&t.description===a.payload.description));
          const after=business();await api('/api/skills/princeq/previews/'+token+'/confirm',{confirmed:true},key);assert.equal(business(),after);
          item.readback=saved;item.checks.push('confirmed_batch_readback','idempotent_confirm');
        }else{
          await api('/api/skills/princeq/previews/'+first.token+'/cancel',{});
          assert.equal(business(),initial);item.checks.push('cancel_keeps_business_unchanged');
        }
      }
      item.ok=true;console.log(provider+' case '+c.id+' PASS '+first.actions.length+' drafts');
    }catch(error){item.error=error instanceof Error?error.message:String(error);console.error(provider+' case '+c.id+' FAIL '+item.error);}
    save();
  }
  report.ok=report.cases.every((c:any)=>c.ok);
}catch(error){report.error=error instanceof Error?error.message:String(error);}
finally{
  report.finished_at=new Date().toISOString();save();if(web)await web.close();
  await new Promise<void>(resolve=>server.close(()=>resolve()));closeDb();
  console.log('EVAL_REPORT '+reportPath);process.exitCode=report.ok?0:1;
}
