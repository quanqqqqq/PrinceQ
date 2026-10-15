import test from 'node:test';
import assert from 'node:assert/strict';
import {transcribeAgentVoice} from '../src/lib/agent-voice-client.ts';

test('an old session cannot deliver a late transcript even if fetch ignores abort',async t=>{
  let finish:(response:Response)=>void;
  let started:()=>void;
  let requestSignal:AbortSignal|undefined;
  const requestStarted=new Promise<void>(resolve=>{started=resolve;});
  t.mock.method(globalThis,'fetch',(_path:unknown,options:RequestInit)=>{
    requestSignal=options.signal as AbortSignal;
    started();
    return new Promise<Response>(resolve=>{finish=resolve;});
  });
  const controller=new AbortController();
  const old=transcribeAgentVoice(new Blob(['wave']),controller.signal);
  const rejected=assert.rejects(old,{name:'AbortError'});
  await requestStarted;
  controller.abort();
  assert.equal(requestSignal?.aborted,true);
  finish(new Response(JSON.stringify({text:'old conversation'}),{status:200}));
  await rejected;
  t.mock.restoreAll();
  t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({text:'new conversation'}),{status:200}));
  assert.equal(await transcribeAgentVoice(new Blob(['wave']),new AbortController().signal),'new conversation');
});

test('a cancelled recording does not start a network request',async t=>{
  const mocked=t.mock.method(globalThis,'fetch',async()=>{throw new Error('must not fetch');});
  const controller=new AbortController();controller.abort();
  await assert.rejects(transcribeAgentVoice(new Blob(['wave']),controller.signal),{name:'AbortError'});
  assert.equal(mocked.mock.callCount(),0);
});

test('cancellation releases the caller even when the transport never settles',{timeout:1000},async t=>{
  let started:()=>void;
  const requestStarted=new Promise<void>(resolve=>{started=resolve;});
  t.mock.method(globalThis,'fetch',()=>{started();return new Promise<Response>(()=>{});});
  const controller=new AbortController();
  const result=transcribeAgentVoice(new Blob(['wave']),controller.signal);
  const rejected=assert.rejects(result,{name:'AbortError'});
  await requestStarted;controller.abort();await rejected;
});

test('cancellation also releases a stalled response body',{timeout:1000},async t=>{
  let reading:()=>void;
  const bodyStarted=new Promise<void>(resolve=>{reading=resolve;});
  t.mock.method(globalThis,'fetch',async()=>({
    ok:true,
    json:()=>{reading();return new Promise(()=>{});},
  } as unknown as Response));
  const controller=new AbortController();
  const result=transcribeAgentVoice(new Blob(['wave']),controller.signal);
  const rejected=assert.rejects(result,{name:'AbortError'});
  await bodyStarted;controller.abort();await rejected;
});

test('dependency check prevents recording when local voice is unavailable',async t=>{
  const {checkAgentVoice}=await import('../src/lib/agent-voice-client.ts');
  t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({asr:{available:false,reason:'请安装语音环境'},tts:{available:true,reason:null}}),{status:200}));
  await assert.rejects(checkAgentVoice('asr'),/请安装语音环境/);
  await checkAgentVoice('tts');
});
