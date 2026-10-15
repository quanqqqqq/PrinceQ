import {captureToWav,releaseVoiceCapture,microphoneErrorMessage,type VoiceCapture} from '@/lib/voice-capture';
import {claimVoiceInput,releaseVoiceInput,onVoiceInputStart} from '@/lib/voice-input-ownership';
/**
 * 常驻助手面板。调用 POST /api/agent/message——一个确定性的本地命令接口，
 * 不涉及任何模型；面板里的文案也如实这么说明。
 *
 * 注意：示例指令本身是发给后端解析器的业务值（英文关键词），只给中文说明，
 * 不翻译要发送的指令文本。
 */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {useAgentConversation} from '@/hooks/use-agent-conversation';
import {
  ArrowUp,
  Bot,
  Cpu,
  History,
  Loader2,
  Mic,
  PanelRightClose,
  RotateCcw,
  Sparkles,
  Square,
  Terminal,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { AgentResultView } from '@/components/AgentResultView';
import { AgentSummary } from '@/components/AgentSummary';
import { SkillDownloadButton } from '@/components/SkillDownloadButton';
import { WriteError } from '@/components/states';
import { api } from '@/lib/api';
import {
  healthMeta,
  modeSubtitle,
  sourceLabel,
  sourceModeForResult,
} from '@/lib/agent-runtime-contract';
import { useResource } from '@/hooks/use-resource';
import { APP_NAME, demoTitle } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { checkAgentVoice, synthesizeAgentSpeech, transcribeAgentVoice } from '@/lib/agent-voice-client';
import { VoiceSilenceDetector } from '@/lib/voice-silence-detector';
import type { AgentMessageResponse } from '@shared/types';

/**
 * 快捷示例：原样发给后端中文解析器（UX-10）。和手敲走的是同一条
 * POST /api/agent/message 流程，不是写死的假动作。
 */
const QUICK_EXAMPLES: { command: string; label: string }[] = [
  { command: '看看队列', label: '看看当前队列' },
  { command: '查看习惯', label: '查看我的习惯' },
  { command: '创建任务 给客户回个电话，明天', label: '新建一个明天要办的任务' },
  { command: '创建目标 学会 SQLite', label: '新建一个目标' },
];

/**
 * 用户在输入框直接打中文「取消/算了」：不送解析器，而是取消最近一个还没处理的预览。
 * （点候选卡/点示例带的 target 不走这条分支。）静态常量放模块作用域，渲染间保持同一引用。
 */

/**
 * Agent 运行时读不到时的安全兜底：一律当本地命令模式，绝不默认走真实 CLI。
 * 后端没起 / 没配置时，面板行为与改造前完全一致。
 */
const HEALTH_TONE_CLASS: Record<string, string> = {
  ok: 'border-emerald-300 bg-emerald-50 text-emerald-700',
  muted: 'border-border bg-muted text-muted-foreground',
  warn: 'border-amber-300 bg-amber-50 text-amber-700',
  bad: 'border-red-300 bg-red-50 text-red-700',
};

const AGENT_PROGRESS_STEPS = [
  {phase: 'context', label: '整理工作区上下文'},
  {phase: 'calling', label: '调用本机 Agent'},
  {phase: 'response', label: '接收 Agent 输出'},
  {phase: 'validation', label: '校验答复与待确认操作'},
] as const;

const AGENT_PROGRESS_INDEX: Record<string, number> = {
  checking: -1,
  context: 0,
  calling: 1,
  response: 2,
  validation: 3,
  complete: 4,
  failed: -1,
};

/** 队列里一条「推荐指令」：绑定任务稳定 id，标题随真实任务更新。 */
interface Recommendation {
  taskId: string;
  label: string;
  command: string;
}

/**
 * 从当前真实队列动态生成推荐示例（UX-11）。
 *
 * 每条都绑定任务的稳定 id 作为 React key，指令里带的是该任务的最新标题——
 * 任务改名后这里的标题跟着变；完成/归档后它离开队列，下一次重算这条推荐就消失。
 */
function useRecommendations(): Recommendation[] {
  const queue = useResource(['queue'], () => api.queue());
  return useMemo(() => {
    const entries = queue.data?.entries ?? [];
    const recs: Recommendation[] = [];
    const byId = new Map<string, Recommendation>();
    for (const { task } of entries) {
      if (byId.has(task.id)) continue;
      let command: string;
      let verb: string;
      if (task.status === 'inbox') {
        command = `领取 "${task.title}"`;
        verb = '领取它';
      } else if (task.status === 'claimed') {
        command = `开始 "${task.title}"`;
        verb = '开始做它';
      } else if (task.status === 'in_progress' || task.status === 'blocked') {
        command = `完成 "${task.title}"`;
        verb = '完成它';
      } else {
        continue;
      }
      const rec = { taskId: task.id, command, label: `${verb}：${demoTitle(task.title)}` };
      byId.set(task.id, rec);
      recs.push(rec);
      if (recs.length >= 3) break;
    }
    return recs;
  }, [queue.data]);
}

/**
 * 面板对外暴露的状态快照，给收缩后的窄栏显示提示用（消息条数、是否正在处理）。
 * 面板收缩时仍然挂载，所以这些数字在收缩期间照常更新。
 */
export type AgentPanelStatus = {
  /** 当前会话里的消息条数，0 表示还没开始对话。 */
  messageCount: number;
  /** 是否正在等待后端解析器返回。 */
  sending: boolean;
};

export function AgentPanel({
  className,
  isOpen = true,
  onCollapse,
  onStatusChange,
}: {
  className?: string;
  isOpen?: boolean;
  /** 传入才会在头部显示收起按钮；窄屏抽屉里不传。 */
  onCollapse?: () => void;
  onStatusChange?: (status: AgentPanelStatus) => void;
}) {
  const {messages,sessionId,sessionTitle,voiceScopeVersion,input,setInput,sending,agentProgress,confirming,error,setError,disabledTokens,sources,
    runtime,effectiveMode,failedTurn,abortRef,send,confirm,cancel,reset,sessions,nextCursor,historyOpen,
    historyLoading,historyError,sessionLoading,showHistory,refreshSessions,refreshConversation,selectSession}=useAgentConversation();
  const recommendations=useRecommendations();
  const endRef=useRef<HTMLDivElement>(null);
  const conversationRef=useRef<HTMLDivElement>(null);
  const pendingPreviewRef=useRef<HTMLDivElement>(null);
  const pendingPreview=[...messages].reverse().find(message => message.result?.pending_action && !disabledTokens.has(message.result.pending_action.token));
  useEffect(() => {
    if (isOpen) void refreshConversation(sessionId);
  }, [isOpen, sessionId, refreshConversation]);
  const voiceOwnerRef=useRef(Symbol('global-agent-voice'));
  const captureRef=useRef<VoiceCapture|null>(null);
  const voiceDraftRef=useRef<string|null>(null);
  const speechUrlRef=useRef<string|null>(null);
  const voiceAbortRef=useRef<AbortController|null>(null);
  const speechAbortRef=useRef<AbortController|null>(null);
  const voiceGenerationRef=useRef(0);
  const speechGenerationRef=useRef(0);
  const [recording,setRecording]=useState(false);
  const [voiceStarting,setVoiceStarting]=useState(false);
  const [voiceBusy,setVoiceBusy]=useState(false);
  const [voiceRefining,setVoiceRefining]=useState(false);
  const [speechBusy,setSpeechBusy]=useState(false);
  const [speechStatus,setSpeechStatus]=useState('');
  const [voiceStatus,setVoiceStatus]=useState('');
  const [speechUrl,setSpeechUrl]=useState<string|null>(null);
  const voiceStatusId=useId();
  const voiceCanCancel=voiceStarting||voiceBusy||voiceRefining;
  const voiceDisabledReason=recording?'':voiceStarting
    ? '正在检查语音环境并准备麦克风；再次点击可取消启动。'
    : voiceBusy
    ? `${voiceStatus || '录音已结束，正在等待识别结果。'}再次点击麦克风可断开本次识别。`
    : confirming
          ? '语音输入暂不可用：正在执行已确认的操作，完成后可再次录音。'
          : sessionLoading
            ? '语音输入暂不可用：正在加载会话，请稍候。'
            : historyOpen
              ? '语音输入暂不可用：当前正在查看历史会话，请返回会话后再录音。'
              : !window.isSecureContext
                ? '语音输入不可用：当前页面不是安全连接，请通过 HTTPS 或本机 localhost 打开。'
                : !navigator.mediaDevices?.getUserMedia || typeof AudioContext==='undefined'
                  ? '语音输入不可用：当前浏览器不支持麦克风录音，请使用支持录音的浏览器。'
                  : '';
  const voiceButtonDisabled=Boolean(voiceDisabledReason)&&!voiceCanCancel;
  const voiceActionLabel=recording?'结束录音':voiceBusy||voiceRefining?'断开语音识别':voiceStarting?'取消启动录音':'语音输入';
  const voiceDescription=voiceDisabledReason || voiceStatus;
  useLayoutEffect(() => {
    if (!isOpen || historyOpen || sessionLoading) return;
    const content = conversationRef.current;
    const viewport = endRef.current?.closest<HTMLDivElement>('[data-slot="scroll-area-viewport"]');
    if (!content || !viewport) return;
    // Reopening a mounted panel must reset its saved scroll position. Observe
    // later layout changes too, including the summaries' character animation.
    let followingLatest = true;
    const scrollToLatest = () => {
      if (followingLatest && viewport.clientHeight > 0) viewport.scrollTop = viewport.scrollHeight;
    };
    const onScroll = () => {
      followingLatest = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 4;
    };
    scrollToLatest();
    const frame = requestAnimationFrame(scrollToLatest);
    const observer = new ResizeObserver(scrollToLatest);
    observer.observe(viewport);
    observer.observe(content);
    viewport.addEventListener('scroll', onScroll, {passive: true});
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      viewport.removeEventListener('scroll', onScroll);
    };
  }, [isOpen, historyOpen, sessionLoading, sessionId, messages, sending]);
  useEffect(()=>{onStatusChange?.({messageCount:messages.length,sending});},[messages.length,sending,onStatusChange]);
  const cancelVoiceInput=useCallback((status='')=>{
    releaseVoiceInput(voiceOwnerRef.current);
    voiceGenerationRef.current++;
    voiceAbortRef.current?.abort();voiceAbortRef.current=null;
    const capture=captureRef.current;
    captureRef.current=null;
    if(capture)releaseVoiceCapture(capture);
    voiceDraftRef.current=null;
    setRecording(false);setVoiceStarting(false);setVoiceBusy(false);setVoiceRefining(false);setVoiceStatus(status);
  },[]);
  const cancelSpeechWork=useCallback((status='')=>{
    speechGenerationRef.current++;
    speechAbortRef.current?.abort();speechAbortRef.current=null;
    if(speechUrlRef.current)URL.revokeObjectURL(speechUrlRef.current);
    speechUrlRef.current=null;setSpeechUrl(null);
    setSpeechBusy(false);setSpeechStatus(status);
  },[]);
  const cancelVoiceWork=useCallback((status='')=>{
    cancelVoiceInput(status);cancelSpeechWork();
  },[cancelVoiceInput,cancelSpeechWork]);
  useEffect(()=>onVoiceInputStart(()=>cancelSpeechWork()),[cancelSpeechWork]);
  // A new/switching conversation cancels its predecessor's work. Each async
  // callback also checks its generation so late responses cannot alter drafts.
  useEffect(()=>()=>cancelVoiceWork(),[voiceScopeVersion,cancelVoiceWork]);

  const speakReply=async(result:AgentMessageResponse['result'])=>{
    const generation=speechGenerationRef.current;
    const controller=new AbortController();
    speechAbortRef.current?.abort();speechAbortRef.current=controller;
    setSpeechBusy(true);setSpeechStatus('正在生成回复语音，可继续录音或输入。');
    try{
      await checkAgentVoice('tts', controller.signal);
      const blob=await synthesizeAgentSpeech(result,controller.signal);
      if(controller.signal.aborted || generation!==speechGenerationRef.current || speechAbortRef.current!==controller)return;
      const nextUrl=URL.createObjectURL(blob);
      if(speechUrlRef.current)URL.revokeObjectURL(speechUrlRef.current);
      speechUrlRef.current=nextUrl;setSpeechUrl(nextUrl);
      setSpeechStatus('回复语音已生成，可播放。');
    }catch(cause){
      if(!controller.signal.aborted && generation===speechGenerationRef.current && speechAbortRef.current===controller)setSpeechStatus(`语音合成失败：${cause instanceof Error?cause.message:'未知错误'}`);
    }finally{
      if(speechAbortRef.current===controller){speechAbortRef.current=null;setSpeechBusy(false);}
    }
  };

  const sendCurrentInput=()=>{
    if(recording||voiceStarting||voiceBusy||sending||confirming||sessionLoading||historyOpen)return;
    const text=input.trim();
    if(!text)return;
    const cameFromVoice=voiceDraftRef.current===text;
    // Sending closes this input's recognition and any preceding reply audio.
    // Reply synthesis has its own lifetime and never reserves the microphone.
    cancelVoiceWork();
    const generation=speechGenerationRef.current;
    void send(text,undefined,undefined,undefined,cameFromVoice?{
      onReply:reply=>{
        if(generation!==speechGenerationRef.current)return;
        if(reply.result.kind==='error')setSpeechStatus('本轮没有可朗读的回复。');
        else void speakReply(reply.result);
      },
    }:undefined);
  };

  const toggleVoiceCapture=async()=>{
    if(voiceCanCancel){
      cancelVoiceInput(voiceBusy||voiceRefining
        ? '已断开本次语音识别，可以重新点击麦克风开始录音；输入框中的文字已保留。'
        : '已停止本次语音处理，可以重新点击麦克风开始录音；输入框中的文字已保留。');
      return;
    }
    if(!recording){
      if(voiceDisabledReason || voiceAbortRef.current)return;
      // Stop prior reply audio before a new recording so it cannot be captured
      // as microphone input or keep the shared model queue occupied.
      cancelSpeechWork();
      claimVoiceInput(voiceOwnerRef.current,()=>cancelVoiceInput('已切换语音输入，本次识别已停止；已识别文字保留。'));
      const generation=voiceGenerationRef.current;
      const controller=new AbortController();
      voiceAbortRef.current=controller;setVoiceStarting(true);
      let stream:MediaStream|undefined;
      let context:AudioContext|undefined;
      try{
        await checkAgentVoice('asr', controller.signal);
        if(controller.signal.aborted || generation!==voiceGenerationRef.current)return;
        stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true}});
        if(controller.signal.aborted || generation!==voiceGenerationRef.current){stream.getTracks().forEach(track=>track.stop());return;}
        context=new AudioContext();
        const source=context.createMediaStreamSource(stream);
        const processor=context.createScriptProcessor(4096,1,1);
        const sink=context.createGain();sink.gain.value=0;
        const chunks:Float32Array[]=[];
        const capture:VoiceCapture={controller,stream,context,source,processor,sink,sampleRate:context.sampleRate,chunks,partialBusy:false,partialTimer:null,partialRequest:null,partialSampleCount:0,lastTranscript:'',silenceDetector:new VoiceSilenceDetector()};
        captureRef.current=capture;
        processor.onaudioprocess=event=>{
          if(captureRef.current!==capture || controller.signal.aborted)return;
          const samples=new Float32Array(event.inputBuffer.getChannelData(0));
          chunks.push(samples);
          if(capture.silenceDetector.process(samples,capture.sampleRate))void finishVoiceCapture(capture,true);
        };
        source.connect(processor);processor.connect(sink);sink.connect(context.destination);
        await context.resume();
        if(controller.signal.aborted || generation!==voiceGenerationRef.current || captureRef.current!==capture)return;
        capture.partialTimer=window.setInterval(()=>{
          if(captureRef.current!==capture||capture.partialBusy||capture.chunks.length===0)return;
          capture.partialBusy=true;
          capture.partialSampleCount=capture.chunks.reduce((count,chunk)=>count+chunk.length,0);
          capture.partialRequest=transcribeAgentVoice(captureToWav(capture),controller.signal);
          void capture.partialRequest.then(transcript=>{
            if(captureRef.current!==capture)return;
            const text=transcript.trim();
            if(text){capture.lastTranscript=text;voiceDraftRef.current=text;setInput(text);setVoiceStatus('正在录音…识别文字已实时更新；说话后静音 1 秒自动结束。');}
          }).catch(()=>{
            if(captureRef.current===capture)setVoiceStatus('正在录音…本段暂未识别，请继续说或结束录音重试');
          }).finally(()=>{capture.partialBusy=false;});
        },1800);
        setRecording(true);setVoiceStatus('正在录音，识别文字会实时填入输入框；说话后静音 1 秒自动结束。');
      }catch(cause){
        const current=!controller.signal.aborted && generation===voiceGenerationRef.current;
        if(captureRef.current?.controller===controller){releaseVoiceCapture(captureRef.current);captureRef.current=null;}
        stream?.getTracks().forEach(track=>track.stop());
        if(context)void context.close().catch(()=>{});
        if(current){
          releaseVoiceInput(voiceOwnerRef.current);
          voiceAbortRef.current=null;
          setVoiceStatus(`语音输入无法启动：${microphoneErrorMessage(cause)}`);
        }
      }finally{if(generation===voiceGenerationRef.current)setVoiceStarting(false);}
      return;
    }

    const capture=captureRef.current;
    if(capture)await finishVoiceCapture(capture);
  };

  async function finishVoiceCapture(capture:VoiceCapture,automatic=false){
    if(captureRef.current!==capture)return;
    const generation=voiceGenerationRef.current;
    captureRef.current=null;setRecording(false);
    // Stop the physical microphone without killing an ASR request that can
    // finish this recording. Killing it forced a cold model restart on stop.
    releaseVoiceCapture(capture,false);
    const controller=capture.controller;voiceAbortRef.current=controller;
    let preview=capture.lastTranscript;
    const endDescription=automatic?'连续静音 1 秒，麦克风已自动关闭。':'录音已结束。';
    const showPreview=(text:string)=>{
      preview=text;voiceDraftRef.current=text;setInput(text);
      setVoiceBusy(false);setVoiceRefining(true);
      setVoiceStatus(`${endDescription}文字可编辑并手动发送；正在后台补全最后一段语音。`);
    };
    if(preview)showPreview(preview);
    else{setVoiceBusy(true);setVoiceStatus(`${endDescription}正在识别语音…`);}
    let deadline:ReturnType<typeof setTimeout>;
    const armDeadline=()=>{
      clearTimeout(deadline);
      deadline=setTimeout(()=>controller.abort(new DOMException('本次语音识别等待超时','TimeoutError')),preview?15_000:90_000);
    };
    armDeadline();
    try{
      let transcript='';
      if(capture.partialRequest){
        try{transcript=(await capture.partialRequest).trim();}catch{controller.signal.throwIfAborted();}
        if(controller.signal.aborted || generation!==voiceGenerationRef.current)return;
      }
      const sampleCount=capture.chunks.reduce((count,chunk)=>count+chunk.length,0);
      if(!transcript || capture.partialSampleCount!==sampleCount){
        if(transcript){showPreview(transcript);armDeadline();}
        transcript=(await transcribeAgentVoice(captureToWav(capture),controller.signal)).trim();
      }
      if(controller.signal.aborted || generation!==voiceGenerationRef.current)return;
      if(!transcript)throw new Error('没有识别到语音，请再试一次。');
      voiceDraftRef.current=transcript;
      setInput(transcript);
      setVoiceStatus(`${automatic?'连续静音 1 秒后已自动结束录音。':''}语音已识别，文本已填入输入框；检查后手动发送。`);
    }catch(cause){
      if(voiceAbortRef.current===controller && generation===voiceGenerationRef.current){
        const message=controller.signal.reason?.name==='TimeoutError'?'识别服务等待超时':cause instanceof Error?cause.message:'未知错误';
        setVoiceStatus(preview
          ? `后台补全未完成：${message}；已保留实时识别文字，可以编辑后手动发送。`
          : `语音输入失败：${message}；可以重新录音。`);
      }
    }finally{
      clearTimeout(deadline);
      if(voiceAbortRef.current===controller){releaseVoiceInput(voiceOwnerRef.current);voiceAbortRef.current=null;setVoiceBusy(false);setVoiceRefining(false);}
    }
  }

  return (
    <aside className={cn('flex h-full min-h-0 flex-col bg-card', className)}>
      {/*
        头部在 <lg 换行成两行：标题占满第一行，动作簇落到第二行靠左——移动端这个
        面板装在 Sheet 里，Sheet 自带的关闭叉号固定在 top-4 right-4，右上角得腾给它。
        lg 起是桌面停靠面板（不在 Sheet 里，没有那个叉号），flex-nowrap + w-auto
        回到原来的单行左右布局。
      */}
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-x-2 gap-y-1 border-b border-border px-4 py-3 lg:flex-nowrap">
        <div className="flex w-full min-w-0 items-center gap-2 lg:w-auto">
          <Bot className="size-4 shrink-0 text-primary" />
          <div className="min-w-0">
            <h2 className="truncate text-sm font-medium">{APP_NAME} 助手</h2>
            <p className="max-w-44 truncate text-xs text-muted-foreground" title={sessionTitle}>{sessionTitle || '新会话'}</p>
            <p className="flex items-center gap-1 text-xs text-muted-foreground">
              <Cpu className="size-3" />
              <span className="truncate">{modeSubtitle(effectiveMode, runtime.enabled, runtime.provider, runtime.health)}</span>
            </p>
            <div className="mt-0.5">
              <Badge
                variant="outline"
                className={cn('font-normal', HEALTH_TONE_CLASS[healthMeta(runtime.health).tone])}
              >
                {healthMeta(runtime.health).label}
              </Badge>
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button size="sm" variant={historyOpen?'secondary':'ghost'} disabled={sending||confirming||sessionLoading} onClick={showHistory} aria-label="历史会话" aria-expanded={historyOpen}>
            <History />历史
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-muted-foreground"
            disabled={(messages.length === 0 && !recording && !voiceStarting && !voiceBusy && !voiceRefining && !speechBusy && !voiceStatus && !input.trim()) || sending || confirming || sessionLoading}
            onClick={()=>{cancelVoiceWork();reset();}}
          >
            <RotateCcw />
            新会话
          </Button>
          {onCollapse ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  className="text-muted-foreground"
                  onClick={onCollapse}
                >
                  <PanelRightClose />
                  <span className="sr-only">收起助手</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>收起助手，腾出更多绘图宽度</TooltipContent>
            </Tooltip>
          ) : null}
        </div>
      </header>

      {sessionLoading ? <div role="status" className="px-4 py-2 text-xs text-muted-foreground">正在打开会话…</div> : null}
      {historyOpen ? <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-2 p-3">
          <div className="flex items-center justify-between"><h3 className="text-sm font-medium">历史会话</h3><Button size="sm" variant="ghost" disabled={historyLoading} onClick={()=>void refreshSessions()}>刷新</Button></div>
          <p className="text-xs text-muted-foreground">会话保存在本机，选择后可查看并继续对话。</p>
          {historyError ? <p role="alert" className="text-xs text-destructive">{historyError}</p> : null}
          {sessions.map(session=><button key={session.id} type="button" disabled={sessionLoading||sending||confirming}
            aria-current={session.id===sessionId?'true':undefined}
            className={cn('w-full rounded-lg border p-3 text-left transition-colors hover:bg-muted',session.id===sessionId?'border-primary bg-primary/5':'border-border')}
            onClick={()=>{cancelVoiceWork();void selectSession(session.id);}}>
            <span className="block truncate text-sm font-medium">{session.title || '未命名会话'}</span>
            <span className="mt-1 block truncate text-xs text-muted-foreground">{session.last_message || '查看对话'}</span>
            <span className="mt-1 block text-[11px] text-muted-foreground">{session.message_count} 条消息 · {new Date(session.updated_at).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})}{session.id===sessionId?' · 当前会话':''}</span>
          </button>)}
          {historyLoading ? <p role="status" className="text-xs text-muted-foreground">正在读取历史…</p> : sessions.length===0 ? <p className="py-8 text-center text-sm text-muted-foreground">还没有历史会话，发送消息后会自动保存。</p> : null}
          {nextCursor ? <Button variant="outline" className="w-full" disabled={historyLoading} onClick={()=>void refreshSessions(nextCursor)}>加载更早会话</Button> : null}
        </div>
      </ScrollArea> : <ScrollArea className="min-h-0 flex-1">
        <div ref={conversationRef} className="space-y-5 p-4">
          {messages.length === 0 ? (
            <div className="space-y-3">
              <div className="rounded-md border border-border bg-muted/30 p-3">
                <p className="text-xs text-muted-foreground">
                  {effectiveMode === 'agent'
                    ? '我会结合当前对话、完整的任务与目标，以及你的工作习惯，帮你安排下一步。涉及修改时会先给预览，确认后执行。'
                    : '这个面板用确定性的本地命令解析器操作与左侧视图同一个 SQLite 数据库，不涉及任何语言模型。语义不清或涉及批量改动的请求，会返回追问或需要你确认的预览。在「设置」里启用并配好 CLI 后，这里会自动切换到 Agent 模式。'}
                </p>
              </div>
              <div>
                {recommendations.length > 0 ? (
                  <div className="mb-3">
                    <p className="mb-2 flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      <Sparkles className="size-3" />
                      根据你的队列推荐
                    </p>
                    <div className="space-y-1.5">
                      {recommendations.map((rec) => (
                        <button
                          key={rec.taskId}
                          type="button"
                          className="w-full rounded-md border border-primary/30 bg-primary/5 px-2.5 py-2 text-left text-xs text-foreground hover-elevate active-elevate-2"
                          onClick={() => void send(rec.command, { task_id: rec.taskId })}
                        >
                          <span className="block">{rec.label}</span>
                          <span className="mt-0.5 block font-mono text-[11px] text-muted-foreground">
                            {rec.command}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  可以试试这些
                </p>
                <div className="space-y-1.5">
                  {QUICK_EXAMPLES.map((example) => (
                    <button
                      key={example.command}
                      type="button"
                      className="w-full rounded-md border border-border bg-background px-2.5 py-2 text-left text-xs text-foreground hover-elevate active-elevate-2"
                      onClick={() => void send(example.command)}
                    >
                      <span className="block">{example.label}</span>
                      <span className="mt-0.5 block font-mono text-[11px] text-muted-foreground">
                        {example.command}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : null}

          {messages.map((message) =>
            message.role === 'user' ? (
              <div key={message.id} className="flex justify-end">
                <div className="max-w-[88%] space-y-1.5">
                  <p className="px-1 text-right text-[11px] font-medium text-muted-foreground">你</p>
                  <p className="whitespace-pre-wrap break-words rounded-2xl rounded-br-md border border-primary/15 bg-primary/5 px-4 py-3 text-[14px] leading-6 text-foreground shadow-sm">{message.content}</p>
                  {message.delivery ? <div className="flex items-center justify-end gap-2 text-[11px] text-muted-foreground">
                    <span>{message.delivery === 'sending' ? '等待回复…' : message.delivery === 'cancelled' ? '已停止等待' : '未完成，请重新发送'}</span>
                    {message.delivery !== 'sending' ? <Button size="sm" variant="ghost" className="h-6 px-1 text-xs" disabled={sending}
                      onClick={() => void send(message.content, undefined, undefined, message.id)}>重新发送</Button> : null}
                  </div> : null}
                </div>
              </div>
            ) : (
              <div key={message.id} ref={message.id === pendingPreview?.id ? pendingPreviewRef : undefined} className="flex items-start gap-3">
                <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full border border-primary/15 bg-primary/5 text-primary">
                  <Bot className="size-4" />
                </div>
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2 px-1">
                    <span className="text-xs font-semibold text-foreground">PrinceQ</span>
                    <Badge variant="outline" className="h-5 font-normal text-[10px] text-muted-foreground">
                      {sourceLabel(sourceModeForResult(message.result?.mode, sources[message.id]), message.result?.provider)}
                    </Badge>
                  </div>
                  <div className="rounded-2xl rounded-tl-md border border-border/70 bg-card p-4 shadow-sm">
                    {message.result ? (
                      <AgentResultView
                        result={message.result}
                        onConfirm={(token, drafts) => void confirm(token, drafts)}
                        onCancel={(token) => void cancel(token)}
                        onSend={(text, target) => void send(text, target)}
                        confirming={confirming}
                        disabledTokens={disabledTokens}
                      />
                    ) : (
                      <p className="whitespace-pre-wrap break-words text-[14px] leading-6 text-foreground">{message.content}</p>
                    )}
                  </div>
                </div>
              </div>
            ),
          )}

          {sending ? (
            <div className="flex items-start gap-3">
              <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full border border-primary/15 bg-primary/5 text-primary">
                <Loader2 className="size-4 animate-spin" />
              </div>
              <div className="min-w-0 flex-1 rounded-2xl rounded-tl-md border border-border/70 bg-card p-4 shadow-sm">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-foreground">
                      {effectiveMode === 'agent' ? 'Agent 正在处理' : '正在处理请求'}
                    </p>
                    <p role="status" className="mt-1 text-xs leading-5 text-muted-foreground">
                      {effectiveMode === 'agent' ? agentProgress?.message ?? '正在启动进度跟踪…' : '正在匹配本地命令…'}
                    </p>
                  </div>
                  <Button size="sm" variant="outline" className="h-7 shrink-0 px-2.5 text-xs" onClick={() => abortRef.current?.abort()}>
                    <Square className="size-3" />
                    取消
                  </Button>
                </div>
                {effectiveMode === 'agent' ? (
                  <>
                    <ol className="mt-3 grid gap-x-4 gap-y-2 border-t border-border/70 pt-3 sm:grid-cols-2">
                      {AGENT_PROGRESS_STEPS.map((step,index)=>{
                        const current=AGENT_PROGRESS_INDEX[agentProgress?.phase ?? 'checking'] ?? -1;
                        const complete=current>index;
                        const active=current===index;
                        return <li key={step.phase} aria-current={active?'step':undefined}
                          className={cn('flex items-center gap-2 text-xs',complete||active?'text-foreground':'text-muted-foreground')}>
                          <span aria-hidden="true" className={cn('flex size-4 shrink-0 items-center justify-center rounded-full text-[10px]',complete?'bg-primary/10 text-primary':active?'bg-primary text-primary-foreground':'border border-border')}>
                            {complete?'✓':active?<span className="size-1.5 rounded-full bg-current"/>:''}
                          </span>
                          {step.label}
                        </li>;
                      })}
                    </ol>
                    {agentProgress?.summary_text ? (
                      <div className="mt-3 rounded-xl border border-border/70 bg-muted/30 px-3 py-2.5">
                        <p className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">
                          <Sparkles className="size-3" />处理摘要
                        </p>
                        <AgentSummary
                          key={agentProgress.request_id}
                          text={agentProgress.summary_text}
                          generating={agentProgress.phase !== 'complete' && agentProgress.phase !== 'failed'}
                        />
                      </div>
                    ) : null}
                  </>
                ) : null}
              </div>
            </div>
          ) : null}

          {failedTurn ? (
            <div className="rounded-md border border-red-200 bg-red-50 p-3">
              <p className="text-sm font-medium text-red-700">Agent 这次处理失败了</p>
              <p className="mt-1 text-xs text-red-600">
                {failedTurn.intent === 'goal_task_drafts' ? '任务草稿未生成，输入和会话已保留。请重试 Agent 或检查助手配置。' : '你的输入和会话都已保留。要再试一次 Agent，还是先用本地命令把这条处理掉？'}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void send(failedTurn.text, failedTurn.target, 'agent', failedTurn.localId, { preserveInput: failedTurn.preserveInput, intent: failedTurn.intent })}
                >
                  <RotateCcw />
                  重试 Agent
                </Button>
                {failedTurn.intent !== 'goal_task_drafts' ? <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void send(failedTurn.text, failedTurn.target, 'local-command', failedTurn.localId, { preserveInput: failedTurn.preserveInput, intent: failedTurn.intent })}
                >
                  <Terminal />
                  使用命令模式处理本条
                </Button> : null}
              </div>
            </div>
          ) : null}

          {error ? <WriteError message={error} onDismiss={() => setError(null)} /> : null}

          <div ref={endRef} />
        </div>
      </ScrollArea>}

      {!historyOpen && pendingPreview && messages.at(-1)?.id !== pendingPreview.id ? (
        <div className="flex shrink-0 items-center gap-2 border-t border-amber-200 bg-amber-50 px-3 py-2">
          <p className="min-w-0 flex-1 text-xs text-amber-900">有一份建议等待确认，尚未执行。</p>
          <Button size="sm" variant="outline" onClick={() => pendingPreviewRef.current?.scrollIntoView({behavior: 'smooth', block: 'end'})}>查看并确认</Button>
        </div>
      ) : null}

      <Separator />

      <form
        className="shrink-0 p-3"
        onSubmit={(event) => {
          event.preventDefault();
          sendCurrentInput();
        }}
      >
        <div className="rounded-lg border border-border bg-card! focus-within:border-primary/50">
          <Textarea
            disabled={sessionLoading || historyOpen || recording || voiceBusy}
            value={input}
            onChange={(event) => {
              if(voiceRefining)cancelVoiceInput('已保留你编辑的文字，停止后台识别。');
              if(event.target.value!==voiceDraftRef.current)voiceDraftRef.current=null;
              setInput(event.target.value);
            }}
            onKeyDown={(event) => {
              // Enter sends, Shift+Enter breaks the line.
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                sendCurrentInput();
              }
            }}
            placeholder="可以让它给出队列、创建任务、确认象限…"
            rows={2}
            className="min-h-0 resize-none border-0 bg-card! px-3 py-2.5 text-sm shadow-none focus-visible:ring-0 disabled:bg-muted! read-only:bg-muted!"
          />
          <div className="flex items-center justify-between gap-2 px-2 pb-2">
            <Badge variant="outline" className="font-normal text-muted-foreground">
              回车发送 · Shift+回车换行
            </Badge>
            <div className="flex items-center gap-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex rounded-md focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    tabIndex={voiceButtonDisabled?0:undefined}
                    aria-label={voiceButtonDisabled?'语音输入不可用':undefined}
                    aria-describedby={voiceDescription?voiceStatusId:undefined}>
                    <Button type="button" size="icon" variant={recording?'destructive':voiceCanCancel?'outline':'ghost'}
                      disabled={voiceButtonDisabled}
                      onClick={()=>void toggleVoiceCapture()} aria-label={voiceActionLabel}
                      aria-describedby={voiceDescription?voiceStatusId:undefined}>
                      {voiceBusy||voiceStarting||voiceRefining?<Loader2 className="animate-spin"/>:<Mic className={recording?'animate-pulse':''}/>}
                      <span className="sr-only">{voiceActionLabel}</span>
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent className="max-w-72">{voiceDisabledReason || (voiceRefining?'文字已可发送，再次点击麦克风停止后台识别':recording?'手动结束录音；说话后静音 1 秒会自动结束':'本地 Qwen 实时语音转写；说话后静音 1 秒自动结束')}</TooltipContent>
              </Tooltip>
              <Button type="submit" size="icon" disabled={!input.trim() || recording || voiceStarting || sending || confirming || sessionLoading || historyOpen || voiceBusy}>
                {sending ? <Loader2 className="animate-spin" /> : <ArrowUp />}
                <span className="sr-only">发送</span>
              </Button>
            </div>
          </div>
        </div>
        {voiceDescription?<p id={voiceStatusId} role="status" className={cn('mt-1.5 text-xs',voiceDisabledReason?'text-amber-700':'text-muted-foreground')}>{voiceDescription}</p>:null}
        {voiceStarting||voiceBusy||voiceRefining?<Button type="button" size="sm" variant="outline" className="mt-2"
          onClick={()=>cancelVoiceInput('已取消语音识别，可以重新录音；输入框中的文字已保留。')}>
          <Square className="size-3"/>{voiceStarting?'取消启动录音':voiceBusy?'取消识别':'停止后台识别'}
        </Button>:null}
        {speechStatus?<p role="status" className="mt-1.5 text-xs text-muted-foreground">{speechStatus}</p>:null}
        {speechBusy?<Button type="button" size="sm" variant="outline" className="mt-2"
          onClick={()=>cancelSpeechWork('已停止生成回复语音，可以继续录音或输入。')}>
          <Square className="size-3"/>停止生成语音
        </Button>:null}
        {speechUrl?<audio className="mt-2 h-8 w-full" controls autoPlay src={speechUrl} aria-label="助手语音回复"/>:null}
        <div className="mt-2 border-t border-border pt-1">
          <SkillDownloadButton />
        </div>
      </form>
    </aside>
  );
}
