/**
 * `/goals` — 带进度的目标卡片，点开后是包含关联任务和拆分草稿流程的详情面板。
 */
import { useState } from 'react';
import type { AgentResult, GoalWithProgress } from '@shared/types';
import { wallDateToIso } from '@shared/datetime';
import { Plus, Target } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Textarea } from '@/components/ui/textarea';
import { GoalDateField } from '@/components/GoalDateField';
import { GoalDetailPanel } from '@/components/GoalDetailPanel';
import { DeleteEntityButton } from '@/components/DeleteEntityButton';
import { AgentResultView } from '@/components/AgentResultView';
import { EmptyState, ErrorState, LoadingRows, WriteError } from '@/components/states';
import { useResource, useMutation } from '@/hooks/use-resource';
import { useAgentConversation } from '@/hooks/use-agent-conversation';
import { api } from '@/lib/api';
import { getRuntimeStatus } from '@/lib/agent-runtime-client';
import { buildGoalCreationMessage } from '@/lib/goal-draft-request';
import { GOAL_STATUS_LABELS, demoText, formatDeadline, percent } from '@/lib/format';

const STATUS_CLASSES: Record<GoalWithProgress['status'], string> = {
  active: 'border-primary/30 bg-primary/5 text-primary',
  paused: 'border-border bg-muted/60 text-muted-foreground',
  achieved: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  dropped: 'border-border bg-muted/40 text-muted-foreground',
};

function CreateGoalDialog() {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [targetDate, setTargetDate] = useState('');
  const [planning, setPlanning] = useState(false);
  const [planningError, setPlanningError] = useState<string | null>(null);
  const [agentPreview, setAgentPreview] = useState<AgentResult | null>(null);
  const [agentFollowup, setAgentFollowup] = useState('');
  const mutation = useMutation(['goals']);
  const conversation = useAgentConversation();

  const resetForm = () => {
    setTitle('');
    setDescription('');
    setTargetDate('');
    setAgentPreview(null);
    setPlanningError(null);
    setAgentFollowup('');
  };

  const createGoalOnly = async () => {
    const trimmed = title.trim();
    if (!trimmed) return;
    const created = await mutation.run('create', () =>
      api.createGoal({
        title: trimmed,
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(targetDate ? { target_date: wallDateToIso(targetDate)! } : {}),
      }),
    );
    if (created) {
      resetForm();
      setOpen(false);
    }
  };

  const requestGoalPlan = async () => {
    if (!title.trim() || planning) return;
    setPlanning(true);
    setPlanningError(null);
    setAgentPreview(null);
    setAgentFollowup('');
    try {
      const runtime = await getRuntimeStatus();
      if (!runtime.enabled) {
        throw new Error('请先在「个人设置 → PrinceQ 助手」启用并连接 Agent，再生成目标与任务预览。');
      }
      const message = buildGoalCreationMessage({
        title,
        description,
        targetDate,
      });
      const accepted = await conversation.send(message, undefined, 'agent', undefined, {
        preserveInput: true,
        fromShortcut: true,
        onReply: (reply) => setAgentPreview(reply.result),
        onError: (cause) => setPlanningError(cause instanceof Error ? cause.message : 'Agent 生成目标预览失败。'),
      });
      if (!accepted) setPlanningError('助手正在处理其他操作，请完成后再生成目标预览。');
    } catch (cause) {
      setPlanningError(cause instanceof Error ? cause.message : '暂时无法生成目标预览，请重试。');
    } finally {
      setPlanning(false);
    }
  };

  const confirmGoalPlan = async (token: string, drafts?: {index: number; title: string; description?: string | null}[]) => {
    const confirmed = await conversation.confirm(token, drafts);
    if (confirmed) {
      resetForm();
      setOpen(false);
    }
  };

  const sendGoalFollowup = async (message: string, target?: {task_id?: string; goal_id?: string}) => {
    setPlanning(true);
    setPlanningError(null);
    const accepted = await conversation.send(message, target, 'agent', undefined, {
      preserveInput: true,
      fromShortcut: true,
      onReply: (reply) => setAgentPreview(reply.result),
      onError: (cause) => setPlanningError(cause instanceof Error ? cause.message : 'Agent 处理失败。'),
    });
    if (!accepted) setPlanningError('助手正在处理其他操作，请完成后再继续。');
    setPlanning(false);
  };

  const cancelGoalPlan = async (token: string) => {
    if (await conversation.cancel(token)) setAgentPreview(null);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus />
          新建目标
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新建目标</DialogTitle>
          <DialogDescription>
            默认让 Agent 同时规划目标和第一批关联任务；预览确认后才会创建。也可以选择只建目标。
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void requestGoalPlan();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="goal-title">标题</Label>
            <Input
              id="goal-title"
              value={title}
              disabled={planning || Boolean(agentPreview?.pending_action)}
              onChange={(event) => { setTitle(event.target.value); setAgentPreview(null); }}
              placeholder="例如：上线计费系统重写"
              className="bg-card! disabled:bg-muted! read-only:bg-muted!"
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="goal-description">描述</Label>
            <Textarea
              id="goal-description"
              value={description}
              disabled={planning || Boolean(agentPreview?.pending_action)}
              onChange={(event) => { setDescription(event.target.value); setAgentPreview(null); }}
              placeholder="达到什么结果才算完成？"
              rows={2}
              className="bg-card! disabled:bg-muted! read-only:bg-muted!"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="goal-target">目标日期</Label>
            <GoalDateField id="goal-target" value={targetDate} disabled={planning || Boolean(agentPreview?.pending_action)} onChange={(value) => { setTargetDate(value); setAgentPreview(null); }} />
          </div>
          {mutation.error ? (
            <WriteError message={mutation.error} onDismiss={mutation.clearError} />
          ) : null}
          {planningError ? <WriteError message={planningError} onDismiss={() => setPlanningError(null)} /> : null}
          {agentPreview ? (
            <AgentResultView
              result={agentPreview}
              onConfirm={(token, drafts) => void confirmGoalPlan(token, drafts)}
              onCancel={(token) => void cancelGoalPlan(token)}
              onSend={sendGoalFollowup}
              confirming={conversation.confirming}
              disabledTokens={conversation.disabledTokens}
            />
          ) : null}
          {agentPreview?.kind === 'clarification' ? (
            <div className="space-y-2 rounded-md border border-border bg-card p-3">
              <Label htmlFor="goal-agent-followup">补充信息</Label>
              <Textarea
                id="goal-agent-followup"
                value={agentFollowup}
                onChange={event => setAgentFollowup(event.target.value)}
                placeholder="回答 Agent 的追问，再继续生成目标与任务预览。"
                rows={2}
              />
              <Button type="button" size="sm" disabled={!agentFollowup.trim() || planning || conversation.sending}
                onClick={() => { const message = agentFollowup.trim(); if(message){setAgentFollowup('');void sendGoalFollowup(message);} }}>
                {planning || conversation.sending ? 'Agent 正在处理…' : '继续生成预览'}
              </Button>
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button type="button" variant="outline" disabled={!title.trim() || mutation.pending !== null || planning || Boolean(agentPreview?.pending_action)} onClick={() => void createGoalOnly()}>
              {mutation.pending ? '创建中…' : '仅创建目标'}
            </Button>
            <Button type="submit" disabled={!title.trim() || mutation.pending !== null || planning || Boolean(agentPreview?.pending_action)}>
              {planning ? 'Agent 正在生成…' : '生成目标与任务预览'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function GoalCard({ goal, onOpen }: { goal: GoalWithProgress; onOpen: () => void }) {
  return (
    <article className="rounded-lg border border-border bg-card p-4 transition-colors hover:border-muted-foreground/30">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-medium">{demoText(goal.title, goal.is_demo)}</h3>
          {goal.description ? (
            <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
              {demoText(goal.description, goal.is_demo)}
            </p>
          ) : null}
        </div>
        <Badge variant="outline" className={`shrink-0 font-normal ${STATUS_CLASSES[goal.status]}`}>
          {GOAL_STATUS_LABELS[goal.status]}
        </Badge>
      </div>

      <div className="mt-3 space-y-1.5">
        <div className="flex items-baseline justify-between text-xs">
          <span className="text-muted-foreground">
            已完成 {goal.progress.completed}/{goal.progress.total}
          </span>
          <span className="tabular-nums font-medium">{percent(goal.progress.ratio)}%</span>
        </div>
        <Progress value={percent(goal.progress.ratio)} />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <Badge variant="outline" className="font-normal text-muted-foreground">
          已领取/进行中 {goal.progress.in_flight}
        </Badge>
        <Badge variant="outline" className="font-normal text-muted-foreground">
          未开始 {goal.progress.open}
        </Badge>
        <Badge variant="outline" className="font-normal">受阻 {goal.progress.blocked ?? 0}</Badge>
        {goal.target_date ? (
          <span className="text-xs text-muted-foreground">{formatDeadline(goal.target_date)}</span>
        ) : null}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={onOpen}>
          查看
        </Button>
        <DeleteEntityButton kind="goal" entity={goal} />
      </div>
    </article>
  );
}

export default function GoalsPage() {
  const [selected, setSelected] = useState<GoalWithProgress | null>(null);
  const goals = useResource(['goals'], () => api.listGoals());

  if (goals.loading) return <LoadingRows rows={3} />;
  if (goals.error) return <ErrorState message={goals.error} onRetry={goals.refetch} />;
  if (!goals.data) return null;

  const list = goals.data.goals;
  // Keep the open panel's data fresh after a write refetches the list.
  const current = selected ? (list.find((goal) => goal.id === selected.id) ?? null) : null;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-start justify-end gap-3">
        <CreateGoalDialog />
      </header>

      {list.length === 0 ? (
        <EmptyState
          icon={<Target />}
          title="还没有目标"
          description="用 Agent 一起规划目标与关联任务，确认预览后再创建。"
          action={<CreateGoalDialog />}
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {list.map((goal) => (
            <GoalCard key={goal.id} goal={goal} onOpen={() => setSelected(goal)} />
          ))}
        </div>
      )}

      <GoalDetailPanel
        goal={current}
        open={current !== null}
        onOpenChange={(next) => {
          if (!next) setSelected(null);
        }}
      />
    </div>
  );
}
