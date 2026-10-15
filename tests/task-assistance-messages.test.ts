import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeTaskAssistanceMessages,shouldSendTaskMessage,type TaskChatMessage} from '../src/lib/task-assistance-messages.ts';
const pending=(key='one',content='第一行\n第二行'):TaskChatMessage=>({id:'local-'+key,request_key:key,role:'user',content,created_at:'2026-10-15T00:00:00Z',delivery:'sending'});
test('new user content is visible while the Agent has not replied',()=>{
  const result=mergeTaskAssistanceMessages([], [pending()]);
  assert.equal(result.length,1);assert.equal(result[0].content,'第一行\n第二行');assert.equal(result[0].delivery,'sending');
});
test('server history replaces the local bubble by request key without duplicates',()=>{
  const saved={...pending(),id:'server-one',delivery:undefined};
  const result=mergeTaskAssistanceMessages([saved],[pending()]);assert.equal(result.length,1);assert.equal(result[0].id,'server-one');
  assert.equal(mergeTaskAssistanceMessages([saved],[saved]).length,1);
});
test('failed turn stays visible across history readback and retry; repeated content in another turn stays distinct',()=>{
  const failed={...pending(),delivery:'failed' as const},saved={...pending(),id:'server-one',delivery:undefined};
  assert.equal(mergeTaskAssistanceMessages([saved],[failed])[0].delivery,'failed');
  const retried=mergeTaskAssistanceMessages([saved],[pending()]);assert.equal(retried.length,1);assert.equal(retried[0].delivery,'sending');
  assert.equal(mergeTaskAssistanceMessages([saved],[pending('two')]).length,2);
});
test('Enter sends, Shift+Enter inserts a newline, composition confirmation never sends',()=>{
  const key={key:'Enter',shiftKey:false,isComposing:false};
  assert.equal(shouldSendTaskMessage(key),true);
  assert.equal(shouldSendTaskMessage({...key,shiftKey:true}),false);
  assert.equal(shouldSendTaskMessage({...key,isComposing:true}),false);
  assert.equal(shouldSendTaskMessage({...key,keyCode:229}),false);
  assert.equal(shouldSendTaskMessage({...key,key:'a'}),false);
});
