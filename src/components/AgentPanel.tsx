/**
 * 常驻助手面板。调用 POST /api/agent/message——一个确定性的本地命令接口，
 * 不涉及任何模型；面板里的文案也如实这么说明。
 *
 * 注意：示例指令本身是发给后端解析器的业务值（英文关键词），只给中文说明，
 * 不翻译要发送的指令文本。
 */
import { useEffect, useMemo, useRef } from 'react';
import {useAgentConversation} from '@/hooks/use-agent-conversation';
import {
  ArrowUp,
  Bot,
  Cpu,
  History,
  Loader2,
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
  onCollapse,
  onStatusChange,
}: {
  className?: string;
  /** 传入才会在头部显示收起按钮；窄屏抽屉里不传。 */
  onCollapse?: () => void;
  onStatusChange?: (status: AgentPanelStatus) => void;
}) {
  const {messages,sessionId,sessionTitle,input,setInput,sending,confirming,error,setError,disabledTokens,sources,
    runtime,effectiveMode,failedTurn,abortRef,send,confirm,cancel,reset,sessions,nextCursor,historyOpen,
    historyLoading,historyError,sessionLoading,showHistory,refreshSessions,selectSession}=useAgentConversation();
  const recommendations=useRecommendations();
  const endRef=useRef<HTMLDivElement>(null);
  useEffect(()=>{endRef.current?.scrollIntoView({behavior:'smooth',block:'end'});},[messages,sending]);
  useEffect(()=>{onStatusChange?.({messageCount:messages.length,sending});},[messages.length,sending,onStatusChange]);

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
            disabled={messages.length === 0 || sending || confirming || sessionLoading}
            onClick={reset}
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
            onClick={()=>void selectSession(session.id)}>
            <span className="block truncate text-sm font-medium">{session.title || '未命名会话'}</span>
            <span className="mt-1 block truncate text-xs text-muted-foreground">{session.last_message || '查看对话'}</span>
            <span className="mt-1 block text-[11px] text-muted-foreground">{session.message_count} 条消息 · {new Date(session.updated_at).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})}{session.id===sessionId?' · 当前会话':''}</span>
          </button>)}
          {historyLoading ? <p role="status" className="text-xs text-muted-foreground">正在读取历史…</p> : sessions.length===0 ? <p className="py-8 text-center text-sm text-muted-foreground">还没有历史会话，发送消息后会自动保存。</p> : null}
          {nextCursor ? <Button variant="outline" className="w-full" disabled={historyLoading} onClick={()=>void refreshSessions(nextCursor)}>加载更早会话</Button> : null}
        </div>
      </ScrollArea> : <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 p-4">
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
                <div className="max-w-[85%] space-y-1">
                  <p className="whitespace-pre-wrap break-words rounded-lg rounded-br-sm bg-primary px-3 py-2 text-sm text-primary-foreground">{message.content}</p>
                  {message.delivery ? <div className="flex items-center justify-end gap-2 text-[11px] text-muted-foreground">
                    <span>{message.delivery === 'sending' ? '等待回复…' : message.delivery === 'cancelled' ? '已停止等待' : '未完成，请重新发送'}</span>
                    {message.delivery !== 'sending' ? <Button size="sm" variant="ghost" className="h-6 px-1 text-xs" disabled={sending}
                      onClick={() => void send(message.content, undefined, undefined, message.id)}>重新发送</Button> : null}
                  </div> : null}
                </div>
              </div>
            ) : (
              <div key={message.id} className="space-y-1">
                {/* 来源标签：这条回复是真实 Agent 跑的，还是本地命令解析器给的。 */}
                <Badge variant="outline" className="font-normal text-muted-foreground">
                  {sourceLabel(sourceModeForResult(message.result?.mode, sources[message.id]), message.result?.provider)}
                </Badge>
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
                  <p className="text-sm text-muted-foreground">{message.content}</p>
                )}
              </div>
            ),
          )}

          {sending ? (
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              {effectiveMode === 'agent' ? 'Agent 正在处理（可随时取消）…' : '正在匹配本地命令…'}
              <Button
                size="sm"
                variant="outline"
                className="h-6 px-2 text-xs"
                onClick={() => abortRef.current?.abort()}
              >
                <Square className="size-3" />
                取消
              </Button>
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

      <Separator />

      <form
        className="shrink-0 p-3"
        onSubmit={(event) => {
          event.preventDefault();
          void send(input);
        }}
      >
        <div className="rounded-lg border border-border bg-card! focus-within:border-primary/50">
          <Textarea
            disabled={sessionLoading || historyOpen}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              // Enter sends, Shift+Enter breaks the line.
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void send(input);
              }
            }}
            placeholder="可以让它给出队列、创建任务、确认象限…"
            rows={2}
            className="min-h-0 resize-none border-0 bg-card! px-3 py-2.5 text-sm shadow-none focus-visible:ring-0 disabled:bg-muted! read-only:bg-muted!"
          />
          <div className="flex items-center justify-between gap-2 px-2 pb-2">
            <Badge variant="outline" className="font-normal text-muted-foreground">
              回车发送，Shift+回车换行
            </Badge>
            <Button type="submit" size="icon" disabled={!input.trim() || sending || confirming || sessionLoading || historyOpen}>
              {sending ? <Loader2 className="animate-spin" /> : <ArrowUp />}
              <span className="sr-only">发送</span>
            </Button>
          </div>
        </div>
      </form>
    </aside>
  );
}
