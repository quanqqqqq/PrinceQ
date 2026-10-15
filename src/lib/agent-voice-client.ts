import type {AgentResult} from '@shared/types';

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let cancel:()=>void;
  const result=new Promise<T>((resolve,reject)=>{
    cancel=()=>reject(signal.reason);
    if(signal.aborted)cancel();
    else signal.addEventListener('abort',cancel,{once:true});
    work.then(resolve,reject);
  });
  return result.finally(()=>signal.removeEventListener('abort',cancel!));
}

async function post<T>(path: string, body: unknown, signal: AbortSignal | undefined, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', cancel, {once: true});
  if (signal?.aborted) cancel();
  const timer = setTimeout(() => controller.abort(new DOMException('语音处理超时', 'TimeoutError')), timeoutMs);
  try {
    const response = await abortable(fetch(path, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body),
      signal: controller.signal,
    }),controller.signal);
    const payload = await abortable(response.json(),controller.signal) as T & {error?: {message?: string}};
    controller.signal.throwIfAborted();
    if (!response.ok) throw new Error(payload.error?.message ?? `语音服务返回 ${response.status}`);
    return payload;
  } catch (cause) {
    if (controller.signal.aborted && controller.signal.reason?.name === 'TimeoutError') {
      throw new Error('本地语音服务长时间没有返回，已结束本次处理；可以重新录音或手动发送已识别的文字。');
    }
    throw cause;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export async function transcribeAgentVoice(wav: Blob, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const audio_base64 = toBase64(new Uint8Array(await wav.arrayBuffer()));
  signal?.throwIfAborted();
  const result = await post<{text: string}>('/api/agent/voice/transcribe', {audio_base64}, signal, 100_000);
  return result.text;
}

export async function synthesizeAgentSpeech(result: AgentResult, signal?: AbortSignal): Promise<Blob> {
  const text = (result.answer?.trim() || result.headline).slice(0, 2000);
  const payload = await post<{audio_base64: string; mime_type: string}>(
    '/api/agent/voice/synthesize', {text}, signal, 190_000,
  );
  const binary = atob(payload.audio_base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], {type: payload.mime_type || 'audio/wav'});
}
