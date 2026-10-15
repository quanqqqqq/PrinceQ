import type {VoiceSilenceDetector} from './voice-silence-detector';
export interface VoiceCapture {
  controller: AbortController;
  stream: MediaStream;
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  processor: ScriptProcessorNode;
  sink: GainNode;
  sampleRate: number;
  chunks: Float32Array[];
  partialBusy: boolean;
  partialTimer: number | null;
  partialRequest: Promise<string> | null;
  partialSampleCount: number;
  lastTranscript: string;
  silenceDetector: VoiceSilenceDetector;
}

export function releaseVoiceCapture(capture: VoiceCapture, abortRecognition=true): void {
  if(abortRecognition)capture.controller.abort();
  if (capture.partialTimer!==null) window.clearInterval(capture.partialTimer);
  capture.processor.onaudioprocess=null;
  capture.processor.disconnect();
  capture.source.disconnect();
  capture.sink.disconnect();
  capture.stream.getTracks().forEach(track=>track.stop());
  void capture.context.close().catch(()=>{});
}

export function microphoneErrorMessage(cause: unknown): string {
  if (cause instanceof Error) {
    switch (cause.name) {
      case 'NotAllowedError':
      case 'SecurityError':
        return '麦克风权限被拒绝，请在浏览器或系统设置中允许此页面使用麦克风，再重试。';
      case 'NotFoundError':
        return '没有找到可用的麦克风，请连接麦克风并检查系统的声音输入设置。';
      case 'NotReadableError':
        return '无法读取麦克风，设备可能被其他应用占用或发生故障；请检查后重试。';
      case 'AbortError':
        return '麦克风启动被中断，请再试一次。';
      default:
        return cause.message || '麦克风启动失败，请检查麦克风权限和声音输入设置。';
    }
  }
  return '麦克风启动失败，请检查麦克风权限和声音输入设置。';
}

function encodePcmWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const write = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
  };
  write(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); write(8, 'WAVE'); write(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); write(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (const sample of samples) {
    const clipped = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, clipped < 0 ? clipped * 32768 : clipped * 32767, true);
    offset += 2;
  }
  return new Blob([buffer], {type: 'audio/wav'});
}

function resampleMono(input: Float32Array, inputRate: number, outputRate: number): Float32Array {
  if (inputRate === outputRate) return input;
  const ratio = inputRate / outputRate;
  const output = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < output.length; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j += 1) sum += input[j];
    output[i] = sum / Math.max(1, end - start);
  }
  return output;
}

export function captureToWav(capture: VoiceCapture): Blob {
  const samples=new Float32Array(capture.chunks.reduce((count,chunk)=>count+chunk.length,0));
  let cursor=0;
  for(const chunk of capture.chunks){samples.set(chunk,cursor);cursor+=chunk.length;}
  return encodePcmWav(resampleMono(samples,capture.sampleRate,16000),16000);
}
