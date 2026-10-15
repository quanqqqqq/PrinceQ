/// <reference lib="dom" />
import test from 'node:test';
import assert from 'node:assert/strict';
import {VoiceInputController} from '../src/lib/voice-input-controller.ts';

test('task voice checks local dependencies before acquiring a microphone',async()=>{
  let mediaCalls=0;
  const controller=new VoiceInputController({prepare:async()=>{throw new Error('请安装本地语音环境');},
    getMedia:async()=>{mediaCalls++;throw new Error('must not acquire microphone');},
    createContext:()=>{throw new Error('must not create context');},transcribe:async()=>'',onTranscript:()=>{}});
  await controller.toggle();
  assert.equal(mediaCalls,0);assert.equal(controller.getSnapshot().phase,'idle');
  assert.match(controller.getSnapshot().status,/请安装本地语音环境/);
  controller.cancel();
});

test('cancelling task voice preflight prevents a late permission request',async()=>{
  let finish:()=>void;let mediaCalls=0;
  const controller=new VoiceInputController({prepare:()=>new Promise<void>(resolve=>{finish=resolve;}),
    getMedia:async()=>{mediaCalls++;throw new Error('must not acquire microphone');},
    createContext:()=>{throw new Error('must not create context');},transcribe:async()=>'',onTranscript:()=>{}});
  const starting=controller.toggle();controller.cancel();finish();await starting;
  assert.equal(mediaCalls,0);assert.equal(controller.getSnapshot().phase,'idle');
});
