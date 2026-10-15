/** Isolated acceptance workspace. Never copies simulated completions to the real workspace. */
import fs from 'node:fs';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const dir=path.join(root,'.preview','fitness-acceptance');fs.mkdirSync(dir,{recursive:true});
process.env.PWQ_DB_PATH=path.join(dir,'work.db');
process.env.PWQ_HABITS_DIR=path.join(dir,'habits');
process.env.PWQ_AGENT_RUNTIME_CONFIG=path.join(dir,'runtime.json');
process.env.PWQ_API_PORT='28652';
process.env.PWQ_TIME_ZONE='Asia/Shanghai';
if(!fs.existsSync(process.env.PWQ_AGENT_RUNTIME_CONFIG))fs.copyFileSync(path.join(root,'config','agent-runtime.json'),process.env.PWQ_AGENT_RUNTIME_CONFIG);
const {getDb,all}=await import('../server/db/connection.ts');
const {seedActors}=await import('../server/db/seed.ts');
const {ensureHabitFiles}=await import('../server/domain/habits.ts');
const {createGoal}=await import('../server/repo/goal-service.ts');
const {createTask}=await import('../server/repo/task-service.ts');
const {createServer}=await import('../server/index.ts');
const db=getDb();seedActors(db);ensureHabitFiles();
let goal=all(db,'SELECT * FROM goals WHERE title=?',['制定并试行30天健身计划'])[0];
if(!goal) {
  goal=createGoal(db,{title:'制定并试行30天健身计划',description:'隔离产品验收案例。10月15日起连续30天，形成适配个人基础与健康限制的计划，持续记录训练、恢复和反馈。所有资料与执行记录均为模拟，不代表用户实际健康状况或真实训练。',target_date:'2026-11-13T15:59:59Z'});
  createTask(db,{goal_id:goal.id,title:'整理训练起点与健康限制',description:'整理运动经历、身体不适或限制、可投入时间、场地器械；产出起点记录和待确认问题。所有信息均为产品验收模拟资料，不能当作用户实际健康事实。',estimated_minutes:20});
  createTask(db,{goal_id:goal.id,title:'拟定30天训练与恢复计划',description:'根据起点记录形成30天计划草案，含训练、恢复、记录方式和调整原则；信息不足处待定。',estimated_minutes:30});
  createTask(db,{goal_id:goal.id,title:'试行首次训练并记录反馈',description:'适用条件明确后试行一次并记录实际反馈。验收中只模拟，不执行真实训练。',estimated_minutes:45});
}
const server=createServer();await new Promise<void>(resolve=>server.listen(28652,'127.0.0.1',resolve));
const meta={base:'http://127.0.0.1:28652',goal_id:goal.id,tasks:all(db,'SELECT id,title FROM tasks WHERE goal_id=?',[goal.id]),directory:dir};
fs.writeFileSync(path.join(dir,'metadata.json'),JSON.stringify(meta,null,2));console.log(JSON.stringify(meta));
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>server.close(()=>process.exit(0)));
