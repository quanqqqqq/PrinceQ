import {TaskSkillPreviewCard} from '@/components/TaskSkillPreviewCard';
import {ConversationMessage,ConversationSystemNotice} from '@/components/ConversationMessage';
import {useConversationScroll} from '@/hooks/use-conversation-scroll';
import type {TaskAssistanceSession,TaskSkillPreview,TaskAssistanceDetail} from '@shared/task-assistance';
import {mergeTaskAssistanceMessages,mergeTaskSkillPreviews,shouldSendTaskMessage,type TaskChatMessage} from '@/lib/task-assistance-messages';
import {useVoiceInput} from '@/hooks/use-voice-input';
import type {AgentProgressView} from '@shared/types';
import {useEffect,useRef,useState} from 'react';
import {Sparkles,Repeat2,Send,Check,CalendarDays,Mic,Loader2} from 'lucide-react';
import type {Task} from '@shared/types';
import {calendarDate,occurrenceLabels,recurrenceUnitLabels,localMinute,type RecurrenceUnit} from '@shared/recurrence';
import {api} from '@/lib/api';
import {useResource,useMutation} from '@/hooks/use-resource';
import {Button} from '@/components/ui/button';
import {Sheet,SheetContent,SheetHeader,SheetTitle,SheetDescription} from '@/components/ui/sheet';
import {ScrollArea} from '@/components/ui/scroll-area';
import {Textarea} from '@/components/ui/textarea';
import {Input} from '@/components/ui/input';
import {Label} from '@/components/ui/label';
import {Badge} from '@/components/ui/badge';
import {LoadingRows,WriteError} from '@/components/states';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

type Mode='assistant'|'recurrence';
export function TaskExecutionDialog({taskId,mode,onClose}:{taskId:string|null;mode:Mode;onClose:()=>void}) {
  return <Sheet open={!!taskId} onOpenChange={open=>{if(!open)onClose();}}>
    <SheetContent className="task-execution-dialog w-full gap-0 p-0 sm:max-w-2xl">
      <SheetHeader className="border-b px-4 py-3 pr-10 text-left">
        <SheetTitle className="flex items-center gap-2 text-sm"><Sparkles className="size-4 text-primary"/>任务协作</SheetTitle>
        <SheetDescription className="text-xs">独立保存当前任务的对话、产出与执行记录。</SheetDescription>
      </SheetHeader>
      {taskId?<TaskExecutionContent key={taskId} taskId={taskId} initialMode={mode}/>:null}
    </SheetContent>
  </Sheet>;
}
function TaskExecutionContent({taskId,initialMode}:{taskId:string;initialMode:Mode}) {
  const detail=useResource(['tasks','goals'],()=>api.getTask(taskId),[taskId]);
  const [mode,setMode]=useState(initialMode);
  const [linkedTask,setLinkedTask]=useState<string|null>(null);
  const task=detail.data?.task;
  const openMutation=useMutation(['tasks','goals','queue','activity']);
  const opened=useRef<string|null>(null);
  const occurrence=task?.recurrence?.today_occurrence;
  useEffect(()=>{
    if(!task||task.recurrence?.status!=='active'||!occurrence||occurrence.opened_at)return;
    const key=task.id+':'+occurrence.date;
    if(opened.current===key)return;
    opened.current=key;
    void openMutation.run('open',()=>api.occurrenceAction(task.id,{date:occurrence.date,action:'open',expected_version:occurrence.version}));
  },[task,occurrence,openMutation]);
  return <>
    <div className="flex gap-2 border-b px-4 py-2">
      <Button size="sm" variant={mode==='assistant'?'default':'ghost'} onClick={()=>setMode('assistant')}><Sparkles/>AI 协助</Button>
      <Button size="sm" variant={mode==='recurrence'?'default':'ghost'} onClick={()=>setMode('recurrence')}><Repeat2/>循环与执行记录</Button>
    </div>
    {task?<div className="border-b px-4 py-3"><h3 className="break-words text-sm font-semibold">{task.title}</h3><p className="mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap break-words text-xs leading-5 text-muted-foreground">{task.description}</p></div>:detail.error?<p className="p-4 text-sm text-destructive">{detail.error}</p>:<LoadingRows rows={2}/>}
    {openMutation.error?<p className="px-4 text-xs text-destructive">{openMutation.error}</p>:null}
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={mode==='recurrence'?'min-h-0 flex-1':'hidden'}><ScrollArea className="h-full"><div className="p-4">{task?<RecurrenceEditor task={task}/>:null}</div></ScrollArea></div>
      {/* Keep task drafts mounted while the execution-record tab is selected. */}
      <div className={mode==='assistant'?'flex min-h-0 flex-1 flex-col':'hidden'}>{task?<TaskAssistant task={task} active={mode==='assistant'&&!linkedTask} onOpenTask={setLinkedTask}/>:null}</div>
    </div>
    {linkedTask?<TaskExecutionDialog taskId={linkedTask} mode="assistant" onClose={()=>setLinkedTask(null)}/>:null}
  </>;
}
export function RecurrenceEditor({task}:{task:Task}) {
  const mutation=useMutation(['tasks','goals','queue','activity']);
  const [start,setStart]=useState(()=>calendarDate(new Date(),'Asia/Shanghai'));
  const [interval,setIntervalDays]=useState('1');
  const [unit,setUnit]=useState<RecurrenceUnit>('day');
  const [startTime,setStartTime]=useState('09:00');
  const [end,setEnd]=useState('');
  const [note,setNote]=useState<string|null>(null);
  const [selectedDate,setSelectedDate]=useState('');
  const r=task.recurrence;
  const selected=r?.occurrences.find(item=>item.date===(selectedDate||r.today_occurrence?.date||r.today));
  const busy=!!mutation.pending;
  const perform=(action:'open'|'start'|'complete'|'skip'|'reopen')=>selected&&mutation.run(action,()=>api.occurrenceAction(task.id,{date:selected.date,action,note:note??selected.note,expected_version:selected.version}));
  return <section className="space-y-3 rounded-lg border p-3">
    <h4 className="flex items-center gap-2 text-sm font-medium"><Repeat2 className="size-4"/>{r?'循环计划':'设为循环任务'}</h4>
    {mutation.error?<WriteError message={mutation.error} onDismiss={mutation.clearError}/>:null}
    {!r?<>
      <p className="text-xs leading-5 text-muted-foreground">一个长期任务，每个执行时间单独记录，支持小时、天、周、月。完成今天不会结束整个循环。</p>
      <div className="grid grid-cols-2 gap-3">
        <div><Label htmlFor="recurrence-start">起始日期</Label><Input id="recurrence-start" type="date" value={start} onChange={e=>setStart(e.target.value)}/></div>
        <div><Label htmlFor="recurrence-interval">间隔数量</Label><Input id="recurrence-interval" type="number" min="1" max="365" value={interval} onChange={e=>setIntervalDays(e.target.value)}/></div>
      </div>
      <div className="grid grid-cols-2 gap-3"><div><Label htmlFor="recurrence-unit">周期单位</Label><select id="recurrence-unit" className="h-9 w-full rounded-md border bg-card px-2 text-sm" value={unit} onChange={e=>setUnit(e.target.value as RecurrenceUnit)}>{Object.entries(recurrenceUnitLabels).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></div>{unit==='hour'?<div><Label htmlFor="recurrence-time">首次执行时间</Label><Input id="recurrence-time" type="time" value={startTime} onChange={e=>setStartTime(e.target.value)}/></div>:null}</div>
      {task.goal_id?<p className="text-xs text-muted-foreground">结束日期跟随关联目标；请先为目标设置日期。时区：Asia/Shanghai。</p>:<div><Label htmlFor="recurrence-end">结束日期</Label><Input id="recurrence-end" type="date" value={end} onChange={e=>setEnd(e.target.value)}/></div>}
      <Button size="sm" disabled={busy||!start||!interval||(!task.goal_id&&!end)} onClick={()=>mutation.run('configure',()=>api.configureRecurrence(task.id,{start_date:start,start_time:startTime,interval:Number(interval),unit,timezone:'Asia/Shanghai',end_mode:task.goal_id?'goal':'date',end_date:task.goal_id?null:end,expected_version:task.version}))}>保存循环计划</Button>
    </>:<>
      <p className="text-xs leading-5">{`每 ${r.interval} ${recurrenceUnitLabels[r.unit]}`} · {r.series_start_date??r.start_date} — {r.effective_end_date??'待设置结束日'} · {r.status==='active'?'执行中':r.status==='paused'?'已暂停':'已结束'}</p>
      {r.plan_changes?.map((plan,index)=><p key={index} className="rounded-md bg-primary/5 p-2 text-xs text-primary">{plan.effective_from.replace('T',' ')} 起：每 {plan.interval} {recurrenceUnitLabels[plan.unit]}；此前执行记录保留。</p>)}
      <p className="text-xs text-muted-foreground">已完成 {r.completed}/{r.total} · 已打开 {r.opened} 次（{r.opened_days} 天） · 跳过 {r.skipped} 次 · 暂停 {r.paused} 次 · 未完成 {r.missed} 次</p>
      <div className="flex flex-wrap gap-2">
        {r.status!=='ended'?<Button size="sm" variant="outline" disabled={busy} onClick={()=>mutation.run('control',()=>api.recurrenceControl(task.id,r.status==='paused'?'resume':'pause',r.version))}>{r.status==='paused'?'恢复循环':'暂停循环'}</Button>:null}
        {r.status==='active'&&r.effective_end_date&&r.today>=r.effective_end_date?<Button size="sm" variant="outline" disabled={busy} onClick={()=>mutation.run('finish',()=>api.recurrenceControl(task.id,'finish',r.version))}>结束整个循环</Button>:null}
        <span className="self-center text-xs text-muted-foreground">下次：{r.next_date??'暂无'}</span>
      </div>
      <div className="max-h-52 overflow-auto rounded-md border">
        <table className="w-full text-left text-xs"><thead className="sticky top-0 bg-muted"><tr><th className="p-2">执行日</th><th>是否打开</th><th>完成情况</th></tr></thead><tbody>{r.occurrences.map(item=><tr key={item.date} className={item.date===(selectedDate||r.today_occurrence?.date||r.today)?'bg-primary/5':''}>
          <td className="p-2"><button type="button" className="text-primary underline-offset-2 hover:underline" onClick={()=>{setSelectedDate(item.date);setNote(item.note);}}>{item.date}{item.out_of_schedule?' 历史':item.date.slice(0,10)===r.today?' 今天':''}</button></td>
          <td>{item.opened_at?'已打开':'未打开'}</td><td>{item.status==='pending'&&item.opened_at?'已打开，待完成':occurrenceLabels[item.status]}</td>
        </tr>)}</tbody></table>
      </div>
      {selected?<div className="space-y-2 rounded-md bg-muted/40 p-3">
        <h5 className="text-xs font-medium">{selected.date} 执行记录</h5>
        {selected.date.slice(0,10)<r.today?<p className="text-xs text-muted-foreground">补记历史日期会保留原来的打开时间，不计作当天已打开。</p>:null}
        <Textarea aria-label="执行备注或跳过原因" rows={3} value={note??selected.note} onChange={e=>setNote(e.target.value)} placeholder="记录实际活动、恢复/休息、用时与反馈；跳过时请说明原因"/>
        <div className="flex flex-wrap gap-2">
          {r.status==='active'&&!selected.out_of_schedule&&selected.date<=(r.unit==='hour'?localMinute(new Date(),r.timezone):r.today)?['completed','skipped'].includes(selected.status)?<Button size="sm" variant="outline" disabled={busy} onClick={()=>perform('reopen')}>重新打开本次</Button>:<>
            {!selected.opened_at&&selected.date.slice(0,10)===r.today?<Button size="sm" variant="outline" disabled={busy} onClick={()=>perform('open')}>打开今日任务</Button>:null}
            <Button size="sm" variant="outline" disabled={busy} onClick={()=>perform('start')}>开始本次</Button>
            <Button size="sm" disabled={busy} onClick={()=>perform('complete')}><Check/>完成本次</Button>
            <Button size="sm" variant="ghost" disabled={busy||!note?.trim()} onClick={()=>perform('skip')}>跳过本次</Button>
          </>:null}
        </div>
      </div>:<p className="text-xs text-muted-foreground"><CalendarDays className="mr-1 inline size-3"/>今天没有执行安排；可以选择历史日期查看。</p>}
    </>}
  </section>;
}
export function TaskAssistant({task,active,onOpenTask}:{task:Task;active:boolean;onOpenTask?:(id:string)=>void}) {
  const history=useResource(['tasks'],()=>api.taskAssistance(task.id),[task.id]);
  const mutation=useMutation(['tasks','goals','queue','activity']);
  const [input,setInput]=useState(()=>{try{return localStorage.getItem('pwq.task-assistance.draft.'+task.id)??'';}catch{return '';}});
  useEffect(()=>{try{localStorage.setItem('pwq.task-assistance.draft.'+task.id,input);}catch{/* Storage may be full. */}},[task.id,input]);
  const [localMessages,setLocalMessages]=useState<TaskChatMessage[]>([]);
  const [localSession,setLocalSession]=useState<TaskAssistanceSession|null>(null);
  const [localPreviews,setLocalPreviews]=useState<TaskSkillPreview[]>([]);
  const composerRef=useRef<HTMLTextAreaElement>(null);
  const composing=useRef(false);
  const [sending,setSending]=useState(false);
  const sendInFlight=useRef(false);
  const responseBusy=sending||Boolean(history.data?.busy);
  const requestBusy=responseBusy||Boolean(mutation.pending);
  const voice=useVoiceInput('task:'+task.id,active&&!requestBusy,setInput);
  const [progress,setProgress]=useState<AgentProgressView|null>(null);
  const progressKey=useRef<string|null>(null);
  const progressTimer=useRef<number|undefined>(undefined);
  const contentRef=useRef<HTMLDivElement>(null);
  const endRef=useRef<HTMLDivElement>(null);
  const [error,setError]=useState<string|null>(null);
  const retry=useRef<{text:string;key:string}|null>(null);
  useEffect(()=>{
    if(!history.data?.busy)return;
    const timer=window.setInterval(history.refetch,1500);
    return ()=>window.clearInterval(timer);
  },[history.data?.busy,history.refetch]);
  const messages=mergeTaskAssistanceMessages(history.data?.messages??[],localMessages);
  const previews=mergeTaskSkillPreviews(history.data?.previews??[],localPreviews);
  const pendingPreview=previews.findLast(preview=>preview.status==='pending');
  const savedSession=history.data?.session;
  const session=localSession&&(!savedSession||localSession.revision>savedSession.revision)?localSession:savedSession;
  const artifactOwner=[...messages].reverse().find(message=>message.role==='assistant'&&!message.operation_result)?.id;
  const observedProgress=progress??history.data?.progress;
  const voiceActionLabel=voice.phase==='recording'?'结束录音':voice.phase==='starting'?'取消启动录音':voice.phase==='idle'?'语音输入':'断开语音识别';
  useEffect(()=>()=>{progressKey.current=null;window.clearInterval(progressTimer.current);},[]);
  const pauseAutoScroll=useConversationScroll(contentRef,endRef,active,task.id,messages.at(-1)?.id,sending);
  const receive=(reply:TaskAssistanceDetail,key?:string)=>{setLocalSession(reply.session);setLocalPreviews(reply.previews??[]);setLocalMessages(previous=>mergeTaskAssistanceMessages(reply.messages,previous.filter(message=>message.request_key!==key)));};
  const editDraft=(text:string)=>{if(requestBusy)return;voice.cancel();setInput(text);requestAnimationFrame(()=>{composerRef.current?.focus();composerRef.current?.setSelectionRange(text.length,text.length);});};
  const resolvePreview=async(token:string,action:'confirm'|'cancel')=>{
    voice.cancel();
    const reply=await mutation.run(action+':'+token,()=>api.resolveTaskPreview(task.id,token,action));
    if(reply)receive(reply);history.refetch();
  };
  const send=async(text:string)=>{
    if(sendInFlight.current||requestBusy||!text.trim()||['recording','starting','recognizing'].includes(voice.phase))return;
    sendInFlight.current=true;
    voice.cancel();
    setSending(true);setError(null);
    const key=retry.current?.text===text?retry.current.key:crypto.randomUUID();retry.current={text,key};
    const pending:TaskChatMessage={id:'local-'+key,request_key:key,role:'user',content:text,created_at:new Date().toISOString(),delivery:'sending'};
    setLocalMessages(previous=>[...previous.filter(message=>!(message.role==='user'&&message.request_key===key)),pending]);
    setInput('');progressKey.current=key;
    const at=new Date().toISOString();setProgress({request_id:key,phase:'checking',message:'正在检查任务 Agent 连接',started_at:at,updated_at:at});
    progressTimer.current=window.setInterval(()=>{void api.taskAssistanceProgress(task.id,key).then(value=>{if(progressKey.current===key&&value)setProgress(value);}).catch(()=>{});},600);
    try {const reply=await api.sendTaskAssistance(task.id,text,key);receive(reply,key);retry.current=null;history.refetch();}
    catch(cause){setLocalMessages(previous=>previous.map(message=>message.request_key===key?{...message,delivery:'failed'}:message));setError((cause as Error).message);setInput(previous=>previous||text);history.refetch();}
    finally{if(progressKey.current===key){progressKey.current=null;window.clearInterval(progressTimer.current);setProgress(null);}sendInFlight.current=false;setSending(false);}
  };
  return <div aria-busy={requestBusy} className="flex min-h-0 flex-1 flex-col">
    <ScrollArea className="min-h-0 flex-1 bg-muted/20"><div ref={contentRef} onClickCapture={event=>{if((event.target as Element).closest('summary'))pauseAutoScroll();}} className="space-y-4 p-4">
    <p className="text-xs leading-5 text-muted-foreground">此对话只协助当前任务，可随时关闭后继续。AI 会整理产出；由你验收后完成任务{task.recurrence?'的本次执行':''}。</p>
    <p className="text-xs text-primary">PrinceQ Skill 已接入 · 任务修改先预览，确认后执行</p>
    {history.error?<p className="text-xs text-destructive">{history.error}</p>:null}
    {messages.map(message=>message.operation_result?<ConversationSystemNotice key={message.id}><p className="whitespace-pre-wrap break-words">{message.content}</p></ConversationSystemNotice>:<ConversationMessage key={message.id} role={message.role} name={message.role==='user'?'你':'任务 Agent'} status={message.delivery?<span className={message.delivery==='failed'?'text-destructive':'font-normal'}>{message.delivery==='sending'?'发送中…':'发送失败，可重试'}</span>:null}>
      {message.summary?.length?<details open className="mb-2 rounded-md border border-primary/15 bg-primary/5 p-2 text-xs leading-5"><summary className="cursor-pointer font-medium text-primary">处理摘要</summary><ul className="mt-1 list-disc space-y-1 pl-4">{message.summary.map((item,index)=><li key={index}>{item}</li>)}</ul></details>:null}
      <div className="task-assistant-markdown break-words">{message.role==='user'?<p className="whitespace-pre-wrap">{message.content}</p>:<ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>}</div>
      {message.preview_token?previews.filter(preview=>preview.token===message.preview_token).map(preview=><TaskSkillPreviewCard key={preview.token} preview={preview} busy={requestBusy} processing={mutation.pending?.endsWith(preview.token)?mutation.pending.split(':')[0]:null} onConfirm={()=>void resolvePreview(preview.token,'confirm')} onCancel={()=>void resolvePreview(preview.token,'cancel')} onEdit={()=>editDraft('请调整这份修改预览，新的要求是：')} onOpenTask={id=>onOpenTask?.(id)}/>):null}
    {message.id===artifactOwner&&session?.artifact?<details open={!requestBusy} className="space-y-2 rounded-lg border border-primary/20 bg-primary/5 p-3">
      <summary className="cursor-pointer text-sm font-medium">{requestBusy?'上一版协助产出':'协助产出'} <Badge variant="outline">第 {session.revision} 版</Badge></summary>
      <div className="task-assistant-markdown break-words text-sm leading-6"><ReactMarkdown remarkPlugins={[remarkGfm]}>{session.artifact}</ReactMarkdown></div>
      <p className="text-xs text-muted-foreground">{session.accepted_at?'已采纳并完成。':session.ready?'请核对产出与实际事实，可继续对话修改。':'尚有信息或执行证据待补齐，请继续对话。'}</p>
      {session.ready&&!session.accepted_at?<Button size="sm" disabled={requestBusy||!!mutation.pending||task.status==='completed'||task.status==='archived'} onClick={()=>mutation.run('accept',()=>api.acceptTaskAssistance(task.id,session.revision,task.version))}><Check/>{task.recurrence?'采纳产出并完成本次':'采纳产出并完成任务'}</Button>:null}
    </details>:null}
    </ConversationMessage>)}
    {responseBusy?<ConversationMessage role="assistant" name="任务 Agent" busy><section role="status" aria-live="polite" className="space-y-2 text-xs leading-5">
      <p className="flex items-center gap-2 font-medium text-primary"><Loader2 className="size-3 animate-spin"/>{observedProgress?.message??'Agent 正在处理当前任务…'}</p>
      <ol className="flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground">{['整理任务资料','调用 Agent','接收处理摘要','校验协助产出'].map((label,index)=>{const current=({checking:-1,context:0,calling:1,response:2,validation:3,complete:4,failed:-1} as Record<string,number>)[observedProgress?.phase??'checking'];return <li key={label} className={index===current?'font-medium text-primary':''}>{index<current?'✓ ':''}{label}</li>;})}</ol>
      {observedProgress?.summary_text?<p className="whitespace-pre-wrap text-foreground">{observedProgress.summary_text}</p>:null}
    </section></ConversationMessage>:null}
    <div ref={endRef}/>
    </div></ScrollArea>
    <div className="shrink-0 space-y-2 border-t border-border p-4">
    {error||mutation.error?<WriteError message={error??mutation.error!} onDismiss={()=>{setError(null);mutation.clearError();}}/>:null}
    {pendingPreview?<div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-primary/5 px-2 py-1 text-xs"><span>{pendingPreview.stale_reason?'旧预览需要重新生成':'有一份修改预览待你确认'}</span><button type="button" className="text-primary underline-offset-2 hover:underline" onClick={()=>{pauseAutoScroll();contentRef.current?.querySelector<HTMLElement>(`[data-preview-token="${pendingPreview.token}"]`)?.scrollIntoView({block:'start',behavior:'smooth'});}}>查看预览</button></div>:null}
    <div className="flex flex-wrap gap-1 text-xs"><button type="button" disabled={requestBusy} className="rounded-md px-2 py-1 text-muted-foreground hover:bg-muted disabled:opacity-50" onClick={()=>editDraft('请先预览，为当前目标新增任务：')}>新建任务</button><button type="button" disabled={requestBusy} className="rounded-md px-2 py-1 text-muted-foreground hover:bg-muted disabled:opacity-50" onClick={()=>editDraft('请先预览，修改当前任务：')}>修改当前任务</button><button type="button" disabled={requestBusy} className="rounded-md px-2 py-1 text-muted-foreground hover:bg-muted disabled:opacity-50" onClick={()=>editDraft(task.recurrence?'请先预览，调整当前任务的循环计划；从下一个未执行日期生效，我希望：':'请先预览，把当前任务设为循环执行，我希望：')}>{task.recurrence?'调整循环计划':'设为循环任务'}</button></div>
    <Textarea ref={composerRef} onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={()=>{composing.current=false;}} onKeyDown={event=>{if(shouldSendTaskMessage({key:event.key,shiftKey:event.shiftKey,isComposing:composing.current||event.nativeEvent.isComposing,keyCode:event.nativeEvent.keyCode})){event.preventDefault();void send(input);}}} aria-label="向任务 Agent 发送消息" value={input} disabled={requestBusy||['recording','starting','recognizing'].includes(voice.phase)} onChange={e=>{if(voice.phase==='refining')voice.cancel('已保留手动编辑的文字，停止后台识别。');setInput(e.target.value);}} rows={4} placeholder={requestBusy?'Agent 正在回复，完成后可继续输入…':'补充资料、提出问题，或请 Agent 修改产出…'}/>
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" className={`inline-flex size-9 shrink-0 items-center justify-center rounded-md bg-transparent p-0 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 ${voice.phase==='recording'?'text-destructive':'text-muted-foreground hover:text-foreground'}`} disabled={requestBusy||(!!voice.unavailable&&voice.phase==='idle')} aria-label={voiceActionLabel} aria-pressed={voice.phase==='recording'} title={voice.unavailable||voiceActionLabel} onClick={()=>void voice.toggle()}>{['starting','recognizing','refining'].includes(voice.phase)?<Loader2 className="size-4 animate-spin"/>:<Mic className={`size-4 ${voice.phase==='recording'?'animate-pulse':''}`}/>}</button>
      {!messages.length?<Button size="sm" variant="outline" disabled={requestBusy||['recording','starting','recognizing'].includes(voice.phase)} onClick={()=>send('请协助我完成这项任务。先结合任务要求直接整理已有信息，再询问影响完成标准的必要问题。')}>开始 AI 协助</Button>:null}
      <Button size="sm" disabled={requestBusy||!input.trim()||['recording','starting','recognizing'].includes(voice.phase)} onClick={()=>send(input)}><Send/>发送</Button>
    </div>
    <p className="text-xs text-muted-foreground">回车发送 · Shift+回车换行</p>
    {voice.status||voice.unavailable?<p role="status" className="text-xs leading-5 text-muted-foreground">{voice.unavailable||voice.status}</p>:null}
    </div>
  </div>;
}
