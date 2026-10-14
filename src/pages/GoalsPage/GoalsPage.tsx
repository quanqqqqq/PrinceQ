/**
 * `/goals` — 带进度的目标卡片，点开后是包含关联任务和拆分草稿流程的详情面板。
 */
import { useState } from 'react';
import type { GoalWithProgress } from '@shared/types';
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
import { EmptyState, ErrorState, LoadingRows, WriteError } from '@/components/states';
import { useResource, useMutation } from '@/hooks/use-resource';
import { api } from '@/lib/api';
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
  const mutation = useMutation(['goals']);

  const submit = async () => {
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
      setTitle('');
      setDescription('');
      setTargetDate('');
      setOpen(false);
    }
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
            目标是一个结果，不是一条任务。创建后可在详情面板里把它拆成任务。
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="goal-title">标题</Label>
            <Input
              id="goal-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
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
              onChange={(event) => setDescription(event.target.value)}
              placeholder="达到什么结果才算完成？"
              rows={2}
              className="bg-card! disabled:bg-muted! read-only:bg-muted!"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="goal-target">目标日期</Label>
            <GoalDateField id="goal-target" value={targetDate} onChange={setTargetDate} />
          </div>
          {mutation.error ? (
            <WriteError message={mutation.error} onDismiss={mutation.clearError} />
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button type="submit" disabled={!title.trim() || mutation.pending !== null}>
              {mutation.pending ? '创建中…' : '创建目标'}
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

      <Button size="sm" variant="outline" className="mt-3" onClick={onOpen}>
        查看目标
      </Button>
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
  const current = selected ? (list.find((goal) => goal.id === selected.id) ?? selected) : null;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-start justify-end gap-3">
        <CreateGoalDialog />
      </header>

      {list.length === 0 ? (
        <EmptyState
          icon={<Target />}
          title="还没有目标"
          description="先创建一个目标，然后在详情面板里拟出实现它所需的任务。"
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
