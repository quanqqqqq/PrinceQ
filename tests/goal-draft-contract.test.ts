import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGoalDraftActions } from '../server/agent/goal-draft-contract.ts';
import { agentMessageSchema } from '../server/http/schemas.ts';
const draft = (payload: Record<string,unknown> = {}, operation = 'task.create') =>
  ({action:'skill_operation',operation,payload:{title:'撰写项目介绍',description:'交付一页介绍，说明用途与使用入口。',...payload}} as any);

test('goal draft fills an omitted binding without mutating model input',()=>{
  const input=draft();const output=normalizeGoalDraftActions([input],'goal-chosen',[]);
  assert.equal((output[0] as any).payload.goal_id,'goal-chosen');
  assert.equal(input.payload.goal_id,undefined);
});
test('goal draft rejects explicit null or wrong goal',()=>{
  assert.throws(()=>normalizeGoalDraftActions([draft({goal_id:'other'})],'chosen',[]),/其他目标/);
  assert.throws(()=>normalizeGoalDraftActions([draft({goal_id:null})],'chosen',[]),/其他目标/);
});
test('goal draft rejects unrelated operations and partially invalid batches',()=>{
  assert.throws(()=>normalizeGoalDraftActions([draft({},'goal.delete')],'chosen',[]),/不能夹带/);
  assert.throws(()=>normalizeGoalDraftActions([draft()],'chosen',[],1),/无效字段/);
});
test('goal draft requires completion descriptions',()=>{
  assert.throws(()=>normalizeGoalDraftActions([draft({description:null})],'chosen',[]),/完成标准/);
});
test('goal draft prevents normalized existing and intra-batch duplicate titles',()=>{
  assert.throws(()=>normalizeGoalDraftActions([draft()],'chosen',['撰写 项目介绍']),/重复/);
  assert.throws(()=>normalizeGoalDraftActions([draft(),draft()],'chosen',[]),/重复/);
});
test('goal draft can correctly produce zero actions',()=>{
  assert.deepEqual(normalizeGoalDraftActions([],'chosen',[]),[]);
});
test('goal workflow requires a stable selected goal and stays additive',()=>{
  assert.equal(agentMessageSchema.safeParse({message:'拟任务',intent:'goal_task_drafts'}).success,false);
  assert.equal(agentMessageSchema.safeParse({message:'拟任务',intent:'goal_task_drafts',target_goal_id:'g'}).success,true);
  assert.equal(agentMessageSchema.safeParse({message:'普通查询'}).success,true);
});
