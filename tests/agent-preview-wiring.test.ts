import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { previewActionPath } from '../src/lib/agent-preview-contract.ts';
import { sourceModeForResult, sourceLabel } from '../src/lib/agent-runtime-contract.ts';
test('模型预览与目标拆分路由隔离；会话来源以保存的mode/provider为准',()=>{
  assert.equal(previewActionPath('pa_token','confirm'),'/agent/preview/confirm');
  assert.equal(previewActionPath('pa_token','cancel'),'/agent/preview/cancel');
  assert.equal(previewActionPath('preview_goal','confirm'),'/agent/confirm');
  assert.equal(previewActionPath('preview_goal','cancel'),'/agent/cancel');
  assert.equal(sourceModeForResult('agent','local-command'),'agent');
  assert.equal(sourceModeForResult('deterministic-local','agent'),'local-command');
  assert.equal(sourceLabel(sourceModeForResult('agent'),undefined),'Agent');
  assert.equal(sourceLabel('agent','codex'),'Agent · Codex');
});
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'pwq-preview-wiring-'));
process.env.PWQ_DB_PATH=path.join(tmp,'unused.db');
process.env.PWQ_HABITS_DIR=path.join(tmp,'habits');
process.env.PWQ_AGENT_RUNTIME_CONFIG=path.join(tmp,'config.json');
const {freshDb}=await import('./helpers.ts');
const {buildRouter}=await import('../server/http/routes.ts');
const {savePendingActions}=await import('../server/agent/pending-actions.ts');
const {ApiError}=await import('../server/lib/errors.ts');
async function call(router:ReturnType<typeof buildRouter>,url:string,body:unknown,key:string) {
  const match=router.match('POST',url)!;
  return await match.handler({req:{headers:{}},url:new URL('http://local'+url),params:match.params,body,idempotencyKey:key} as never) as any;
}
test('使用前端选择的真实路由：确认创建一次，取消零创建，失败token可重试',async()=>{
  const db=freshDb();const router=buildRouter(()=>db);
  const count=()=>Number((db.prepare('SELECT count(*) AS n FROM tasks').get() as any).n);
  const token=savePendingActions(db,{sessionId:null,summary:'隔离预览',actions:[{action:'create_task',title:'隔离任务'}]});
  assert.equal(count(),0);
  const confirmed=await call(router,'/api'+previewActionPath(token,'confirm'),{token},'preview-wire-1');
  assert.equal(confirmed.result.kind,'applied');
  assert.equal(count(),1);
  const other=savePendingActions(db,{sessionId:null,summary:'隔离取消',actions:[{action:'create_task',title:'不应创建'}]});
  await call(router,'/api'+previewActionPath(other,'cancel'),{token:other},'preview-wire-2');
  assert.equal(count(),1);
  await assert.rejects(call(router,'/api'+previewActionPath(other,'confirm'),{token:other},'preview-wire-3'),e=>e instanceof ApiError&&e.status===404);
  assert.equal(count(),1);
  db.close();
});
