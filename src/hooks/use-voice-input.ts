import {useLayoutEffect,useMemo,useSyncExternalStore} from 'react';
import {VoiceInputController} from '@/lib/voice-input-controller';
import {checkAgentVoice,transcribeAgentVoice} from '@/lib/agent-voice-client';
export function useVoiceInput(scope:string,active:boolean,onTranscript:(text:string)=>void) {
  const controller=useMemo(()=>new VoiceInputController({scope,prepare:signal=>checkAgentVoice('asr',signal),getMedia:()=>navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true}}),createContext:()=>new AudioContext(),transcribe:transcribeAgentVoice,onTranscript}),[onTranscript,scope]);
  const state=useSyncExternalStore(controller.subscribe,controller.getSnapshot);
  useLayoutEffect(()=>{if(!active)controller.cancel();return()=>controller.cancel();},[controller,active]);
  const unavailable=!window.isSecureContext?'当前页面不是安全连接，请用 HTTPS 或 localhost 打开。':!navigator.mediaDevices?.getUserMedia||typeof AudioContext==='undefined'?'当前浏览器不支持麦克风录音。':'';
  return {...state,unavailable,cancel:controller.cancel,toggle:()=>controller.toggle()};
}
