import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

type WorkerResponse = {id?: string; ok?: boolean; text?: string; audio_base64?: string; error?: string};
type Pending = {child: ChildProcessWithoutNullStreams; resolve: (value: WorkerResponse) => void; reject: (error: Error) => void};
type RequestOptions = {signal?: AbortSignal; timeoutMs?: number};

const workerPath = fileURLToPath(new URL('./qwen_worker.py', import.meta.url));
let worker: ChildProcessWithoutNullStreams | null = null;
const pending = new Map<string, Pending>();
let activeRequest: Promise<WorkerResponse> | null = null;

function rejectWorkerRequests(child: ChildProcessWithoutNullStreams, error: Error): void {
  for (const [id, task] of pending) {
    if (task.child!==child) continue;
    pending.delete(id);
    task.reject(error);
  }
  if (worker===child) worker=null;
}

async function waitForTurn(task: Promise<WorkerResponse>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  let cancel: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    cancel=()=>reject(signal.reason);
    signal.addEventListener('abort', cancel, {once: true});
  });
  try { await Promise.race([task.catch(()=>undefined), cancelled]); }
  finally { signal.removeEventListener('abort', cancel!); }
}

function pythonPath(): string {
  const configured = process.env.PWQ_QWEN_PYTHON?.trim();
  if (configured) return configured;
  const candidates = [
    path.join(process.cwd(), '.voice-venv', 'bin', 'python'),
    path.join(os.homedir(), 'Documents/ChatGPT/Jev/.voice-venv/bin/python'),
  ];
  return candidates.find(candidate => fs.existsSync(candidate)) ?? 'python3';
}

function startWorker(): ChildProcessWithoutNullStreams {
  if (worker && worker.exitCode === null && !worker.killed) return worker;
  // The local model worker does not need PrinceQ Agent credentials or the
  // parent process environment. Pass only runtime and cache settings.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: os.homedir(),
    TMPDIR: process.env.TMPDIR,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    HF_HOME: process.env.HF_HOME,
    HF_HUB_CACHE: process.env.HF_HUB_CACHE,
    HUGGINGFACE_HUB_CACHE: process.env.HUGGINGFACE_HUB_CACHE,
    HF_HUB_DISABLE_IMPLICIT_TOKEN: '1',
  };
  const asr = process.env.PWQ_QWEN_ASR_MODEL?.trim();
  const tts = process.env.PWQ_QWEN_TTS_MODEL?.trim();
  if (asr) env.PRINCEQ_QWEN_ASR_MODEL = asr;
  if (tts) env.PRINCEQ_QWEN_TTS_MODEL = tts;

  const child = spawn(pythonPath(), ['-u', workerPath], {stdio: 'pipe', env});
  worker = child;
  let buffer = '';
  child.stderr.on('data', chunk => process.stderr.write(`[qwen-voice] ${chunk}`));
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      try {
        const response = JSON.parse(line) as WorkerResponse;
        const task = response.id ? pending.get(response.id) : undefined;
        if (!task || task.child!==child) continue;
        pending.delete(response.id!);
        if (response.ok) task.resolve(response);
        else task.reject(new Error(response.error ?? '本地 Qwen 语音处理失败。'));
      } catch (error) {
        process.stderr.write(`[qwen-voice] invalid worker response: ${(error as Error).message}\n`);
      }
    }
  });
  child.once('error', error => {
    rejectWorkerRequests(child, error);
  });
  child.stdin.on('error', error => {rejectWorkerRequests(child, error);child.kill('SIGKILL');});
  child.once('exit', (code, signal) => {
    const error = new Error(`Qwen worker exited (${signal ?? code}). Check local MLX voice dependencies.`);
    rejectWorkerRequests(child, error);
  });
  return child;
}

async function request(payload: Record<string, string>, options: RequestOptions = {}): Promise<WorkerResponse> {
  const controller=new AbortController();
  const cancel=()=>controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', cancel, {once:true});
  if(options.signal?.aborted)cancel();
  const timeoutMs=options.timeoutMs ?? (payload.op==='transcribe'?90_000:180_000);
  const timer=setTimeout(()=>controller.abort(new Error(
    payload.op==='transcribe'
      ? '语音识别超时，已停止本次识别；可以重新录音或手动发送已识别的文字。'
      : '语音合成超时，已停止生成；可以继续输入或重新录音。',
  )),timeoutMs);
  const signal=controller.signal;
  let task:Promise<WorkerResponse>|undefined;
  let cancelActive:(()=>void)|undefined;
  // MLX has one shared device queue; serialize ASR and TTS requests.
  try {
    while (activeRequest) await waitForTurn(activeRequest, signal);
    signal.throwIfAborted();
    const child = startWorker();
    const id = randomUUID();
    task = new Promise<WorkerResponse>((resolve, reject) => pending.set(id, {child, resolve, reject}));
    activeRequest = task;
    cancelActive=()=>{
      // Cancelling a queued request never terminates another request's worker.
      // For active work, terminate the blocked Python operation as well as fetch.
      rejectWorkerRequests(child, signal.reason instanceof Error?signal.reason:new Error('语音处理已取消。'));
      child.kill('SIGKILL');
    };
    signal.addEventListener('abort', cancelActive, {once:true});
    child.stdin.write(`${JSON.stringify({id, ...payload})}\n`);
    return await task;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
    if(cancelActive)signal.removeEventListener('abort',cancelActive);
    if(task && activeRequest===task)activeRequest=null;
  }
}

export async function transcribeQwenAudio(audioBase64: string, options?: RequestOptions): Promise<string> {
  if (audioBase64.length > 11_200_000) throw new Error('录音过大，请缩短后重试。');
  const result = await request({op: 'transcribe', audio_base64: audioBase64}, options);
  return result.text ?? '';
}

export async function synthesizeQwenSpeech(text: string, options?: RequestOptions): Promise<string> {
  if (text.length > 2000) throw new Error('朗读文本过长，请选取较短内容。');
  const result = await request({op: 'synthesize', text}, options);
  return result.audio_base64 ?? '';
}

export function stopQwenWorker(): void {
  const child=worker;
  if(!child)return;
  rejectWorkerRequests(child,new Error('本地语音服务已停止。'));
  child.kill('SIGKILL');
}
