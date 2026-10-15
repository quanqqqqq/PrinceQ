/** Fresh isolated copy of the fitness goal, for real-model and browser confirmation acceptance. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const root=path.resolve(import.meta.dirname,'..'),parent=path.join(root,'.preview','task-skill-acceptance');fs.mkdirSync(parent,{recursive:true});
const dir=fs.mkdtempSync(path.join(parent,'run-'));
const source=await (await fetch('http://127.0.0.1:28642/api/goals')).json() as any;
const sourceGoal=source.goals.find((goal:any)=>goal.title==='制定并试行30天健身计划');if(!sourceGoal)throw new Error('Fitness goal is missing');
const detail=await (await fetch('http://127.0.0.1:28642/api/goals/'+sourceGoal.id)).json() as any;
process.env.PWQ_DB_PATH=path.join(dir,'work.db');process.env.PWQ_HABITS_DIR=path.join(dir,'habits');process.env.PWQ_AGENT_RUNTIME_CONFIG=path.join(dir,'runtime.json');process.env.PWQ_API_PORT='28652';process.env.PWQ_TIME_ZONE='Asia/Shanghai';
fs.copyFileSync(path.join(root,'config','agent-runtime.json'),process.env.PWQ_AGENT_RUNTIME_CONFIG);fs.cpSync(path.join(root,'habits'),process.env.PWQ_HABITS_DIR,{recursive:true});
const {getDb,all}=await import('../server/db/connection.ts');const {seedActors}=await import('../server/db/seed.ts');const {createGoal}=await import('../server/repo/goal-service.ts');const {createTask}=await import('../server/repo/task-service.ts');const {occurrenceAction}=await import('../server/repo/recurrence.ts');const {createServer}=await import('../server/index.ts');
const db=getDb();seedActors(db);
const goal=createGoal(db,{title:sourceGoal.title,description:sourceGoal.description+'\n隔离功能验收：本库执行记录均为模拟，不代表真实运动。',target_date:sourceGoal.target_date});
let selected:any;
for(const item of detail.tasks){const r=item.recurrence;const task=createTask(db,{title:item.title,description:item.description,estimated_minutes:item.estimated_minutes,goal_id:goal.id,...(r?{recurrence:{start_date:r.series_start_date??r.start_date,start_time:r.start_time,interval:r.interval,unit:r.unit,timezone:r.timezone,end_mode:r.end_mode,end_date:r.end_date}}:{})});if(r)selected=task;}
if(!selected)selected=createTask(db,{title:'每日记录训练、恢复与身体反馈',description:'记录当日模拟活动和反馈',goal_id:goal.id,estimated_minutes:5,recurrence:{start_date:'2026-10-15',start_time:'09:00',interval:1,unit:'day',timezone:'Asia/Shanghai',end_mode:'goal'}});
occurrenceAction(db,selected.id,{date:'2026-10-15',action:'complete',expected_version:0,note:'隔离产品验收模拟：恢复日，未进行真实训练。'});
const api=createServer();await new Promise<void>(resolve=>api.listen(28652,'127.0.0.1',resolve));
const {createServer:createVite}=await import('vite');const web=await createVite({cacheDir:path.join(dir,'vite-cache'),server:{host:'127.0.0.1',port:28651,strictPort:true,proxy:{'/api':{target:'http://127.0.0.1:28652',changeOrigin:false}}}});await web.listen();
const metadata={directory:dir,base:'http://127.0.0.1:28652',web:'http://127.0.0.1:28651/goals',goal_id:goal.id,task_id:selected.id,source_goal_id:sourceGoal.id,before_tasks:all(db,'SELECT id,title,description,estimated_minutes FROM tasks'),run_id:crypto.randomUUID()};fs.writeFileSync(path.join(parent,'metadata.json'),JSON.stringify(metadata,null,2));console.log(JSON.stringify(metadata));
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{void web.close().then(()=>api.close(()=>process.exit(0)));});
