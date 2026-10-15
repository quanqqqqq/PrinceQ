import {nodeCli} from './fixtures/cli.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {stopQwenWorker, synthesizeQwenSpeech, transcribeQwenAudio} from '../server/voice/qwen-runtime.ts';
import {buildRouter} from '../server/http/routes.ts';
import {readJsonBody, sendError, sendJson} from '../server/http/router.ts';

test('voice cancellation and timeouts release the shared worker queue', async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'princeq-voice-test-'));
  const started=path.join(root,'started');
  const executable=nodeCli(path.join(root,'fake-qwen'),`const fs=require('node:fs');
const readline=require('node:readline');
readline.createInterface({input:process.stdin}).on('line',line=>{
  const request=JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(started)},request.audio_base64||request.text);
  if(request.audio_base64==='hang'||request.text==='hang')return;
  const reply=()=>process.stdout.write(JSON.stringify({id:request.id,ok:true,text:'recognized',audio_base64:'audio'})+'\\n');
  if(request.audio_base64==='slow')setTimeout(reply,100);else reply();
});
`);
  const previous=process.env.PWQ_QWEN_PYTHON;
  process.env.PWQ_QWEN_PYTHON=executable;
  t.after(()=>{
    stopQwenWorker();
    if(previous===undefined)delete process.env.PWQ_QWEN_PYTHON;else process.env.PWQ_QWEN_PYTHON=previous;
    fs.rmSync(root,{recursive:true,force:true});
  });

  await t.test('a stuck recognition times out and a new request succeeds',async()=>{
    await assert.rejects(transcribeQwenAudio('hang',{timeoutMs:50}),/语音识别超时/);
    assert.equal(await transcribeQwenAudio('ok',{timeoutMs:5000}),'recognized');
  });
  await t.test('cancelling active work lets a new session proceed; old exit cannot reject its worker',async()=>{
    const controller=new AbortController();
    const stuck=transcribeQwenAudio('hang',{signal:controller.signal,timeoutMs:5000});
    const rejected=assert.rejects(stuck,{name:'AbortError'});
    controller.abort();
    const next=transcribeQwenAudio('ok',{timeoutMs:5000});
    await rejected;
    assert.equal(await next,'recognized');
    assert.equal(await synthesizeQwenSpeech('ok',{timeoutMs:5000}),'audio');
  });
  await t.test('cancelling queued work does not kill another active request',async()=>{
    const active=transcribeQwenAudio('slow',{timeoutMs:5000});
    const controller=new AbortController();
    const queued=synthesizeQwenSpeech('hang',{signal:controller.signal,timeoutMs:5000});
    const rejected=assert.rejects(queued,{name:'AbortError'});
    controller.abort();
    await rejected;
    assert.equal(await active,'recognized');
  });
  await t.test('a queued timeout releases only the queued request',async()=>{
    const active=transcribeQwenAudio('slow',{timeoutMs:5000});
    await assert.rejects(synthesizeQwenSpeech('hang',{timeoutMs:20}),/语音合成超时/);
    assert.equal(await active,'recognized');
  });
  await t.test('disconnecting the HTTP request cancels active model work',async()=>{
    const router=buildRouter(()=>{throw new Error('Voice must not access the database');});
    let startedRequest:()=>void;
    const requestStarted=new Promise<void>(resolve=>{startedRequest=resolve;});
    const server=http.createServer(async(req,res)=>{
      const url=new URL(req.url!,`http://${req.headers.host}`);
      const route=router.match(req.method!,url.pathname)!;
      try{
        const body=await readJsonBody(req);
        const work=route.handler({req,res,url,params:route.params,body,idempotencyKey:null});
        startedRequest();
        const payload=await work;
        if(!res.destroyed)sendJson(res,200,payload);
      }catch(cause){if(!res.destroyed)sendError(res,cause);}
    });
    server.listen(0,'127.0.0.1');await once(server,'listening');
    try{
      const address=server.address() as {port:number};
      const url=`http://127.0.0.1:${address.port}/api/agent/voice/transcribe`;
      const controller=new AbortController();
      const stuck=fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({audio_base64:'hang'}),signal:controller.signal});
      const rejected=assert.rejects(stuck,{name:'AbortError'});
      await requestStarted;
      controller.abort();await rejected;
      const next=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({audio_base64:'ok'}),signal:AbortSignal.timeout(5000)});
      assert.equal(next.status,200);
      assert.deepEqual(await next.json(),{text:'recognized'});
    }finally{
      server.closeAllConnections();server.close();await once(server,'close');
    }
  });
});
