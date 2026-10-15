import {StringDecoder} from 'node:string_decoder';
import {ROOT_DIR} from '../config.ts';
import {buildCliEnv, runCli} from '../agent/cli-exec.ts';
import {resolveCliLaunch, terminateProcessTree, trackRuntimeProcess} from '../lib/process-launch.ts';
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
const workers = new Map<string, ChildProcessWithoutNullStreams>();
type VoiceOperation = 'transcribe' | 'synthesize';
export const voiceBackend = (): string => process.env.PWQ_VOICE_BACKEND?.trim() || (process.platform === 'darwin' && process.arch === 'arm64' ? 'mlx' : 'torch');
const pending = new Map<string, Pending>();
let activeRequest: Promise<WorkerResponse> | null = null;

function rejectWorkerRequests(child: ChildProcessWithoutNullStreams, error: Error): void {
  for (const [id, task] of pending) {
    if (task.child!==child) continue;
    pending.delete(id);
    task.reject(error);
  }
  for (const [key, value] of workers) if (value === child) workers.delete(key);
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

export function voicePythonPath(operation: VoiceOperation): string {
  const configured = (process.env[operation === 'transcribe' ? 'PWQ_QWEN_ASR_PYTHON' : 'PWQ_QWEN_TTS_PYTHON'] ?? process.env.PWQ_QWEN_PYTHON)?.trim();
  if (configured) return configured;
  const directory = voiceBackend() === 'mlx' ? '.voice-venv' : operation === 'transcribe' ? '.voice-asr-venv' : '.voice-tts-venv';
  const candidates = [path.join(ROOT_DIR, directory, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')];
  // Preserve the existing Mac installation; fresh machines use this project's environments.
  if (voiceBackend() === 'mlx') candidates.push(path.join(os.homedir(), 'Documents/ChatGPT/Jev/.voice-venv/bin/python'));
  return candidates.find(candidate => fs.existsSync(candidate)) ?? (process.platform === 'win32' ? 'python' : 'python3');
}

function voiceEnvironment(): NodeJS.ProcessEnv {
  return {...buildCliEnv(['HF_HOME', 'HF_HUB_CACHE', 'HUGGINGFACE_HUB_CACHE']),
    HOME: os.homedir(), PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', HF_HUB_DISABLE_IMPLICIT_TOKEN: '1',
    PWQ_VOICE_BACKEND: voiceBackend(), PWQ_VOICE_DEVICE: process.env.PWQ_VOICE_DEVICE ?? 'cpu'};
}

export async function qwenVoiceStatus() {
  const check = async (operation: VoiceOperation) => {
    const result = await runCli({executable: voicePythonPath(operation), args: ['-u', workerPath, '--probe', operation],
      cwd: ROOT_DIR, envNames: ['PWQ_VOICE_BACKEND', 'PWQ_VOICE_DEVICE', 'PYTHONUTF8'], timeoutMs: 5000, maxOutputBytes: 8192});
    try {
      const status = JSON.parse(result.stdout);
      if (result.exitCode === 0 && typeof status.available === 'boolean') return {available: status.available,
        reason: status.available ? null : String(status.reason ?? '请运行 npm run voice:setup。')};
    } catch { /* Missing interpreter/dependencies; no model is loaded by this probe. */ }
    return {available: false, reason: '本地语音环境尚未就绪，请在项目目录运行 npm run voice:setup。'};
  };
  const [asr, tts] = await Promise.all([check('transcribe'), check('synthesize')]);
  return {backend: voiceBackend(), asr, tts};
}

function startWorker(operation: VoiceOperation): ChildProcessWithoutNullStreams {
  const key = voiceBackend() === 'mlx' ? 'mlx' : operation;
  const existing = workers.get(key);
  if (existing && existing.exitCode === null && !existing.killed) return existing;
  const env = voiceEnvironment();
  const asr = process.env.PWQ_QWEN_ASR_MODEL?.trim();
  const tts = process.env.PWQ_QWEN_TTS_MODEL?.trim();
  if (asr) env.PRINCEQ_QWEN_ASR_MODEL = asr;
  if (tts) env.PRINCEQ_QWEN_TTS_MODEL = tts;

  const launch = resolveCliLaunch(voicePythonPath(operation), ['-u', workerPath]);
  const child = trackRuntimeProcess(spawn(launch.executable, launch.args, {stdio: 'pipe', env, cwd: ROOT_DIR, windowsHide: true, detached: process.platform !== 'win32'}));
  workers.set(key, child);
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  child.stderr.on('data', chunk => process.stderr.write(`[qwen-voice] ${chunk}`));
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += decoder.write(chunk);
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
  child.stdin.on('error', error => {rejectWorkerRequests(child, error);terminateProcessTree(child, 'SIGKILL');});
  child.once('exit', (code, signal) => {
    const error = new Error(`Qwen worker exited (${signal ?? code}). 请检查本地语音依赖，或运行 npm run voice:setup。`);
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
    const child = startWorker(payload.op as VoiceOperation);
    const id = randomUUID();
    task = new Promise<WorkerResponse>((resolve, reject) => pending.set(id, {child, resolve, reject}));
    activeRequest = task;
    cancelActive=()=>{
      // Cancelling a queued request never terminates another request's worker.
      // For active work, terminate the blocked Python operation as well as fetch.
      rejectWorkerRequests(child, signal.reason instanceof Error?signal.reason:new Error('语音处理已取消。'));
      terminateProcessTree(child, 'SIGKILL');
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
  for (const child of [...workers.values()]) {
    rejectWorkerRequests(child,new Error('本地语音服务已停止。'));
    terminateProcessTree(child, 'SIGKILL');
  }
}
