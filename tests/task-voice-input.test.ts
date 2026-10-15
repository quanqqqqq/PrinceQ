/// <reference lib="dom" />
import test from 'node:test';
import assert from 'node:assert/strict';
import {VoiceInputController} from '../src/lib/voice-input-controller.ts';
import {claimVoiceInput,releaseVoiceInput} from '../src/lib/voice-input-ownership.ts';
const oldWindow=globalThis.window;
Object.assign(globalThis,{window:{setInterval,clearInterval}});
test.after(()=>{Object.assign(globalThis,{window:oldWindow});});
const deferred=<T,>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};};
function fixture(transcribe:(wav:Blob,signal:AbortSignal)=>Promise<string>=async()=> '识别文字') {
  let stops=0;const texts:string[]=[];let processor:any;
  const stream={getTracks:()=>[{stop:()=>{stops++;}}]};
  const node=()=>({connect(){},disconnect(){}});
  const context={sampleRate:16000,destination:{},createMediaStreamSource:node,createGain:()=>({...node(),gain:{value:1}}),createScriptProcessor:()=>{processor={...node(),onaudioprocess:null};return processor;},resume:async()=>{},close:async()=>{}};
  const controller=new VoiceInputController({scope:'fixture',getMedia:async()=>stream as any,createContext:()=>context as any,transcribe,onTranscript:text=>texts.push(text)});
  const emit=(ms:number,level:number)=>processor?.onaudioprocess?.({inputBuffer:{getChannelData:()=>new Float32Array(ms*16).fill(level)}});
  return {controller,texts,emit,stops:()=>stops,stream};
}
test('cancelling pending permission stops a late microphone stream and cannot resume old recording',async()=>{
  const pending=deferred<MediaStream>();const stream={getTracks:()=>[{stop:()=>{stopped++;}}]};let stopped=0;
  const controller=new VoiceInputController({getMedia:()=>pending.promise,createContext:()=>{throw new Error('must not create audio context');},transcribe:async()=>'',onTranscript:()=>{throw new Error('late transcript');}});
  const start=controller.toggle();await Promise.resolve();assert.equal(controller.getSnapshot().phase,'starting');controller.cancel();pending.resolve(stream as any);await start;
  assert.equal(stopped,1);assert.equal(controller.getSnapshot().phase,'idle');
});
test('late transcript from task A cannot enter task B, and switching releases A microphone',async()=>{
  const old=deferred<string>();const a=fixture(()=>old.promise);const b=fixture();
  await a.controller.toggle();a.emit(200,0.1);const finish=a.controller.finish();assert.equal(a.stops(),1);
  await b.controller.toggle();assert.equal(a.controller.getSnapshot().phase,'idle');old.resolve('任务A的迟到结果');await finish;
  assert.deepEqual(a.texts,[]);assert.deepEqual(b.texts,[]);b.controller.cancel();
});
test('silence stops only after speech, final text remains editable without auto-submit',async()=>{
  const f=fixture();await f.controller.toggle();f.emit(2000,0);assert.equal(f.controller.getSnapshot().phase,'recording');
  f.emit(200,0.1);f.emit(500,0);assert.equal(f.controller.getSnapshot().phase,'recording');
  f.emit(500,0);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.stops(),1);assert.equal(f.controller.getSnapshot().phase,'idle');assert.deepEqual(f.texts,['识别文字']);f.controller.cancel();
});
test('manual editing or sending cancels final ASR and ignores its late correction',async()=>{
  const pending=deferred<string>();const f=fixture(()=>pending.promise);await f.controller.toggle();f.emit(200,0.1);
  const finishing=f.controller.finish();f.controller.cancel('保留编辑文字');pending.resolve('不应覆盖编辑内容');await finishing;
  assert.deepEqual(f.texts,[]);assert.equal(f.controller.getSnapshot().status,'保留编辑文字');
});
test('shared ownership coordinates task/global voice inputs without cancelling the new owner',async()=>{
  const f=fixture();await f.controller.toggle();const globalOwner=Symbol('global');let globalCancelled=0;
  claimVoiceInput(globalOwner,()=>{globalCancelled++;releaseVoiceInput(globalOwner);});assert.equal(f.stops(),1);assert.equal(f.controller.getSnapshot().phase,'idle');
  await f.controller.toggle();assert.equal(globalCancelled,1);releaseVoiceInput(globalOwner);assert.equal(f.controller.getSnapshot().phase,'recording');f.controller.cancel();
});
