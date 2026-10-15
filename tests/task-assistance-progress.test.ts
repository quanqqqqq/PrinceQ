import test from 'node:test';
import assert from 'node:assert/strict';
import {createPublicSummaryDecoder} from '../server/agent/public-summary-stream.ts';
import {taskProgress,appendTaskSummary,readTaskProgress} from '../server/agent/task-assistance-progress.ts';
import {assistTask,readTaskAssistance} from '../server/agent/task-assistance.ts';
import {freshDb,withTempHabits} from './helpers.ts';
import {createTask} from '../server/repo/task-service.ts';
withTempHabits();
test('public summary decoder handles fragmented Claude text and excludes provider thinking',()=>{
  let output='';const decoder=createPublicSummaryDecoder('claude',part=>{output+=part;});
  decoder.push(JSON.stringify({type:'stream_event',event:{type:'content_block_delta',delta:{type:'thinking_delta',thinking:'private-secret'}}})+'\n');
  for(const text of ['SUM','MARY: 整理用户资料','并列出待确认项。\n{"answer":"reply"}'])decoder.push(JSON.stringify({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text}}})+'\n');
  decoder.finish();assert.equal(output,'整理用户资料并列出待确认项。');assert.ok(!output.includes('private-secret'));assert.ok(!output.includes('answer'));
});
test('Codex public text snapshots are deduplicated; reasoning and tool events ignored',()=>{
  let output='';const decoder=createPublicSummaryDecoder('codex',part=>{output+=part;});
  for(const item of [{id:'r',type:'reasoning',text:'private-secret'},{id:'a',type:'agent_message',text:'SUMMARY: 整理资料'},{id:'a',type:'agent_message',text:'SUMMARY: 整理资料并生成草稿。\n{"answer":"ready"}'},{id:'a',type:'agent_message',text:'SUMMARY: 整理资料并生成草稿。\n{"answer":"ready"}'}])decoder.push(JSON.stringify({type:'item.completed',item})+'\n');
  decoder.finish();assert.equal(output,'整理资料并生成草稿。');
});
test('progress is isolated by task and request, and summaries survive history reload',async()=>{
  taskProgress('a','same-key','calling');appendTaskSummary('a','same-key','公开摘要');
  assert.equal(readTaskProgress('b','same-key'),null);assert.equal(readTaskProgress('a','different'),null);
  assert.equal(readTaskProgress('a','same-key')?.summary_text,'公开摘要');
  const db=freshDb(),task=createTask(db,{title:'整理训练起点'});
  await assistTask(db,task.id,'整理资料','persist-summary',{invoke:async()=>({answer:'请补充实际信息',artifact:null,ready:false,summary:['核对了任务要求','健康限制仍待确认']})});
  const restored=readTaskAssistance(db,task.id);assert.deepEqual(restored.messages[1].summary,['核对了任务要求','健康限制仍待确认']);
  assert.equal(readTaskProgress(task.id,'persist-summary')?.phase,'complete');db.close();
});
