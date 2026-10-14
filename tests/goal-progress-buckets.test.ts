import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'pwq-goal-buckets-'));
process.env.PWQ_HABITS_DIR=path.join(tmp,'habits');process.env.PWQ_DB_PATH=path.join(tmp,'unused.db');
const {freshDb}=await import('./helpers.ts');
const {createGoal}=await import('../server/repo/goal-service.ts');
const {createTask}=await import('../server/repo/task-service.ts');
const {findGoal,listGoals}=await import('../server/repo/tasks.ts');
test('目标状态计数互斥，受阻单独计数，归档不进入分母',()=>{
  const db=freshDb();const goal=createGoal(db,{title:'隔离目标'});
  for(const status of ['inbox','claimed','in_progress','blocked','completed','archived']){
    const task=createTask(db,{title:status,goal_id:goal.id});
    db.prepare('UPDATE tasks SET status=? WHERE id=?').run(status,task.id);
  }
  const p=findGoal(db,goal.id)!.progress;
  assert.deepEqual(p,{total:5,completed:1,in_flight:2,open:1,blocked:1,ratio:0.2});
  assert.equal(p.completed+p.in_flight+p.open+p.blocked!,p.total);
  assert.deepEqual(listGoals(db)[0].progress,p);
  db.close();
});
