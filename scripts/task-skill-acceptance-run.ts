import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
const meta=JSON.parse(fs.readFileSync('.preview/task-skill-acceptance/metadata.json','utf8'));
const base=meta.base,id=meta.task_id,reportFile=path.join(meta.directory,'report.json');
async function api(route:string,body?:unknown):Promise<any>{const r=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json','Idempotency-Key':crypto.randomUUID()},body:body===undefined?undefined:JSON.stringify(body)});const data=await r.json();assert.ok(r.ok,JSON.stringify(data));return data;}
const before=await api('/api/goals/'+meta.goal_id);
const report:any={case:'制定并试行30天健身计划',isolated:true,source_goal_id:meta.source_goal_id,task_id:id,steps:[],before};
fs.writeFileSync(reportFile,JSON.stringify(report,null,2));
const message='这是隔离产品验收，所有活动记录均为模拟。请在当前健身目标下先预览三项变更，确认前绝不执行：1）新建“每周回顾训练与恢复记录”，每周一次，从2026年10月18日起，结束日跟随当前目标，每次10分钟；详情写汇总本周记录、列出待调整事项和待确认问题，不生成训练处方。2）把当前“每日记录训练、恢复与身体反馈”的每次预计用时从5分钟改成8分钟，并在原详情末尾追加“完成标准补充：明确记录当天训练或恢复内容、实际用时、反馈与待确认项。”其他原有说明保留。3）当前循环从2026年10月16日起改为每2天执行一次，结束日继续跟随目标到11月13日，保留今天已经完成的模拟记录。不修改其他字段，不新增其他目标，不生成额外内容产出。';
try {
  const reply=await api(`/api/tasks/${id}/assistance/messages`,{message});
  report.reply=reply;fs.writeFileSync(reportFile,JSON.stringify(report,null,2));
  assert.equal(reply.skill.version,4);assert.equal(reply.previews.length,1);assert.equal(reply.previews[0].status,'pending');
  const names=reply.previews[0].changes.map((change:any)=>change.operation);
  for(const name of ['task.create','task.update','task.recurrence.update'])assert.ok(names.includes(name),JSON.stringify(names));
  const after=await api('/api/goals/'+meta.goal_id);assert.deepEqual(after,before);
  report.steps.push({name:'真实 Agent 生成创建、修改与循环调整三项预览；确认前业务数据完全一致',changes:reply.previews[0].changes});report.token=reply.previews[0].token;report.preview_ready=true;fs.writeFileSync(reportFile,JSON.stringify(report,null,2));
  console.log(JSON.stringify({preview_ready:true,token:report.token,operations:names,report:reportFile}));
} catch(error){report.error=(error as Error).stack;fs.writeFileSync(reportFile,JSON.stringify(report,null,2));throw error;}
