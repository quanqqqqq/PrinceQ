import test from 'node:test';
import assert from 'node:assert/strict';
import {VoiceSilenceDetector} from '../src/lib/voice-silence-detector.ts';

const audio=(durationMs:number,level=0,sampleRate=16000)=>new Float32Array(Math.round(durationMs*sampleRate/1000)).fill(level);

test('initial quiet does not close the microphone before the user speaks',()=>{
  const detector=new VoiceSilenceDetector();
  assert.equal(detector.process(audio(10000),16000),false);
  assert.equal(detector.process(audio(120,0.1),16000),false);
  assert.equal(detector.process(audio(999),16000),false);
  assert.equal(detector.process(audio(1),16000),true);
});

test('another sound restarts the full one second quiet interval',()=>{
  const detector=new VoiceSilenceDetector();
  detector.process(audio(120,0.1),16000);
  assert.equal(detector.process(audio(900),16000),false);
  assert.equal(detector.process(audio(20,0.1),16000),false);
  assert.equal(detector.process(audio(999),16000),false);
  assert.equal(detector.process(audio(1),16000),true);
});

test('a short initial click does not arm automatic closure',()=>{
  const detector=new VoiceSilenceDetector();
  assert.equal(detector.process(audio(10,0.5),16000),false);
  assert.equal(detector.process(audio(5000),16000),false);
});

test('quiet background noise permits closure and sustained louder sound postpones it',()=>{
  const detector=new VoiceSilenceDetector();
  assert.equal(detector.process(audio(3000,0.1),16000),false);
  assert.equal(detector.process(audio(999,0.002),16000),false);
  assert.equal(detector.process(audio(1,0.002),16000),true);
});

test('closure fires once and a new recording gets an independent detector',()=>{
  const previous=new VoiceSilenceDetector();
  previous.process(audio(120,0.1),16000);
  assert.equal(previous.process(audio(1000),16000),true);
  assert.equal(previous.process(audio(2000),16000),false);
  const next=new VoiceSilenceDetector();
  assert.equal(next.process(audio(2000),16000),false);
  next.process(audio(120,0.1),16000);
  assert.equal(next.process(audio(1000),16000),true);
});

test('normal browser sample rates and uneven buffers preserve the quiet duration',()=>{
  for(const sampleRate of [44100,48000]){
    const detector=new VoiceSilenceDetector();
    detector.process(audio(120,0.1,sampleRate),sampleRate);
    let remaining=sampleRate-1;
    while(remaining>0){
      const size=Math.min(4096,remaining);
      assert.equal(detector.process(new Float32Array(size),sampleRate),false);
      remaining-=size;
    }
    assert.equal(detector.process(new Float32Array(1),sampleRate),true);
  }
});
