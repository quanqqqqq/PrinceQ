import {useEffect, useRef, useState} from 'react';
import {useLocation, useNavigate} from 'react-router-dom';
import {ArrowRight, Bot, Check, ListTodo, Target, X} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle} from '@/components/ui/dialog';
import {useAgentConversation} from '@/hooks/use-agent-conversation';
import {openAgentPanel} from '@/lib/goal-draft-request';
import {OPEN_ONBOARDING_EVENT, ONBOARDING_STORAGE_KEY, readOnboardingProgress, saveOnboardingProgress, type OnboardingProgress} from '@/lib/onboarding';
import {cn} from '@/lib/utils';

const STEPS = [
  {label: '连接助手', icon: Bot, title: '先连接你的工作助手', description: '用你本机的 Claude 或 Codex，把想做的事直接告诉 PrinceQ。'},
  {label: '描述目标', icon: Target, title: '目标：你想达成什么结果？', description: '说明想实现的结果，以及怎样算完成。助手会帮你整理目标，再拆成可执行的任务。'},
  {label: '描述任务', icon: ListTodo, title: '任务：下一步具体做什么？', description: '直接说要做的事。有截止时间、预计用时或关联目标时，一起补充即可。'},
] as const;
const GOAL_EXAMPLE = '帮我创建一个目标：月底前上线个人作品集网站。完成标准是能展示 3 个项目，手机上也能正常浏览。请先给我目标和任务拆分的预览，确认后再创建。';
const TASK_EXAMPLE = '帮我登记一个任务：明天下午 3 点前，把报价对比表整理好并发给采购同事，预计 30 分钟。请先预览，等我确认再创建。';

/** Mounted once in the shell so route changes never lose tutorial progress. */
export function OnboardingGuide() {
  const [progress, setProgress] = useState(readOnboardingProgress);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const [reviewLink] = useState(() => new URLSearchParams(window.location.search).has('agent_session'));
  const [explicitlyOpened, setExplicitlyOpened] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const {input, setInput, sending, confirming, sessionLoading, runtime} = useAgentConversation();
  const update = (next: OnboardingProgress) => { saveOnboardingProgress(next); setProgress(next); };
  const finish = () => update({...progress, phase: 'done'});
  useEffect(() => {
    const reopen = () => {
      setExplicitlyOpened(true);
      const next: OnboardingProgress = {step: 0, phase: 'dialog'};
      saveOnboardingProgress(next); setProgress(next);
    };
    // Closing the guide in another tab should also dismiss it here.
    const syncCompletion = (event: StorageEvent) => {
      if (event.key === ONBOARDING_STORAGE_KEY && readOnboardingProgress().phase === 'done') {
        setProgress(readOnboardingProgress());
      }
    };
    window.addEventListener(OPEN_ONBOARDING_EVENT, reopen);
    window.addEventListener('storage', syncCompletion);
    return () => {
      window.removeEventListener(OPEN_ONBOARDING_EVENT, reopen);
      window.removeEventListener('storage', syncCompletion);
    };
  }, []);

  if (progress.phase === 'done' || (reviewLink && !explicitlyOpened)) return null;
  const step = STEPS[progress.step];
  const Icon = step.icon;
  const ready = runtime.enabled && runtime.health.ok;
  const busy = sending || confirming || sessionLoading;
  const hasDraft = Boolean(input.trim());
  const configure = () => {
    update({step: 0, phase: 'configure'});
    navigate('/settings#agent-assistant');
  };
  const next = () => {
    if (progress.step === 2) { finish(); openAgentPanel(); }
    else update({step: (progress.step + 1) as 1 | 2, phase: 'dialog'});
  };
  const tryExample = () => {
    if (busy || hasDraft) return;
    setInput(progress.step === 1 ? GOAL_EXAMPLE : TASK_EXAMPLE);
    update({...progress, phase: 'practice'});
    openAgentPanel();
  };

  if (progress.phase !== 'dialog') {
    const configuring = progress.phase === 'configure';
    return <aside aria-label="新手指引" className="shrink-0 border-b border-primary/15 bg-primary/5 px-4 py-3">
      <div className="mx-auto flex max-w-4xl flex-wrap items-center gap-3">
        <Icon className="size-4 shrink-0 text-primary" aria-hidden="true" />
        <div className="min-w-0 flex-1 basis-44">
          <p className="text-[13px] font-medium">{configuring ? '第 1 步 · 配置 Agent 助手' : `第 ${progress.step + 1} 步 · ${step.label}`}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{configuring
            ? ready ? '助手已启用。可以继续了解如何描述目标和任务。' : '选择一个本机 Claude / Codex 入口并启用，设置会自动保存。也可以先继续看用法。'
            : '示例已放入助手输入框；改成自己的内容后再发送。创建前，请检查预览并确认。'}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {configuring && location.pathname !== '/settings' ? <Button size="sm" variant="outline" onClick={configure}>去配置</Button> : null}
          <Button size="sm" onClick={next}>{progress.step === 2 ? '完成指引' : configuring ? '继续：描述目标' : '继续：描述任务'}<ArrowRight /></Button>
          <Button size="icon" variant="ghost" className="size-8" aria-label="结束新手指引" onClick={finish}><X /></Button>
        </div>
      </div>
    </aside>;
  }

  return <Dialog open onOpenChange={open => { if (!open) finish(); }}>
    <DialogContent showCloseButton={false} onOpenAutoFocus={event => { event.preventDefault(); primaryRef.current?.focus(); }} className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-[480px] gap-5 p-5 sm:p-6">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium text-muted-foreground">PrinceQ · 新手指引</span>
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground" onClick={finish}>跳过</Button>
      </div>
      <ol aria-label="指引进度" className="grid grid-cols-3 gap-2">
        {STEPS.map((item, index) => <li key={item.label} aria-current={index === progress.step ? 'step' : undefined} className="space-y-1.5">
          <div className={cn('h-1 rounded-full bg-muted', index <= progress.step && 'bg-primary')} />
          <span className={cn('text-xs text-muted-foreground', index === progress.step && 'font-medium text-primary')}>{index + 1}. {item.label}</span>
        </li>)}
      </ol>
      <DialogHeader className="text-left">
        <div className="mb-1 flex size-9 items-center justify-center rounded-xl bg-primary/10 text-primary"><Icon className="size-5" aria-hidden="true" /></div>
        <DialogTitle className="text-base">{step.title}</DialogTitle>
        <DialogDescription className="text-[13px] leading-relaxed">{step.description}</DialogDescription>
      </DialogHeader>
      {progress.step === 0 ? <div className="space-y-3 rounded-lg border bg-muted/20 p-4 text-[13px] leading-relaxed">
        <p><span className="font-medium">1. 准备好本机 CLI</span><span className="block text-xs text-muted-foreground">在本机安装并登录 Claude Code 或 Codex，任选一个即可。</span></p>
        <p><span className="font-medium">2. 进入「个人设置 → PrinceQ 助手」</span><span className="block text-xs text-muted-foreground">选择检测到的入口并启用。模型先用 CLI 默认值即可，设置会自动保存。</span></p>
        <p><span className="font-medium">3. 展开「助手」，开始对话</span><span className="block text-xs text-muted-foreground">创建或修改目标、任务时，助手会先展示预览，等你确认再执行。</span></p>
        {ready ? <p className="flex items-center gap-1.5 text-xs text-primary"><Check className="size-3.5" />当前已启用 {runtime.provider === 'claude' ? 'Claude' : 'Codex'} 助手</p> : null}
      </div> : <div className="space-y-3">
        <p className="text-xs text-muted-foreground">{progress.step === 1 ? '可以这样说：想实现的结果 + 完成标准 + 截止时间（可选）' : '可以这样说：具体动作 + 交付结果 + 截止时间 / 用时（可选）'}</p>
        <blockquote className="rounded-lg border border-primary/15 bg-primary/5 p-4 text-[13px] leading-7">{progress.step === 1 ? GOAL_EXAMPLE : TASK_EXAMPLE}</blockquote>
        <p className="text-xs leading-relaxed text-muted-foreground">{progress.step === 1
          ? '不必一次想完整。不确定的地方直接说明，助手可以先帮你澄清；已有目标也能用「为这个目标拟任务草稿」继续拆分。'
          : '任务创建后会进入「任务优先队列」。开始工作时点「开始」，做完点「完成」，再看下一项。'}</p>
        <p className="rounded-md bg-muted/40 px-3 py-2 text-xs leading-relaxed"><span className="font-medium">先预览，再确认。</span> 检查名称、时间和关联目标；有问题继续告诉助手调整，确认后才会写入。</p>
        {!runtime.enabled ? <p className="text-xs leading-relaxed text-muted-foreground">自然语言创建需要先启用 Agent 助手。<button type="button" className="ml-1 text-primary underline underline-offset-2" onClick={configure}>去连接助手</button></p> : null}
        <Button size="sm" variant="outline" onClick={tryExample} disabled={busy || hasDraft}>把示例放入助手<ArrowRight /></Button>
        <p className="text-xs text-muted-foreground">{hasDraft ? '助手里已有未发送的内容，先处理它再试示例。' : busy ? '助手正在处理请求，结束后可以试示例。' : '只填入输入框，你可以修改后再发送。'}</p>
      </div>}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-4">
        {progress.step > 0 ? <Button size="sm" variant="ghost" onClick={() => update({step: (progress.step - 1) as 0 | 1, phase: 'dialog'})}>上一步</Button>
          : <Button size="sm" variant="ghost" onClick={next}>先了解用法</Button>}
        <Button ref={primaryRef} size="sm" onClick={progress.step === 0 ? configure : next}>{progress.step === 0 ? '去配置助手' : progress.step === 1 ? '下一步：描述任务' : '开始使用'}<ArrowRight /></Button>
      </div>
      <p className="text-center text-[11px] text-muted-foreground">以后点「助手」下方的问号，或在「帮助」里重看指引。</p>
    </DialogContent>
  </Dialog>;
}
