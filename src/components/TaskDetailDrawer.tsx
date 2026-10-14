/**
 * 三入口共用的任务详情抽屉（UX-06）。
 *
 * 工作队列、四象限弹窗、目标详情三处的任务卡片都带一个「详情」入口，点开这里。
 *
 * 行为约定：
 * - 普通字段（标题/描述/目标关联/截止/预计耗时/类型/优先级）完整显示且可编辑；
 * - 依赖、认知负荷、受阻信息、排序细节只展示，排序细节默认折叠；
 * - 「取消」/关闭一律不写库；只有点「保存」才 PATCH，且带上 `expected_version`
 *   做乐观并发；同一保存点击走幂等键，冲突（409）时抽屉保持打开并提示。
 */
import { useMemo, useState } from 'react';
import type { CognitiveLoad, DurationUnit, GoalWithProgress, TaskType } from '@shared/types';
import { TASK_TYPES } from '@shared/types';
import { ChevronDown, CircleAlert, Info, ListOrdered } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import { TaskDateTimeField } from '@/components/TaskDateTimeField';
import { DurationField } from '@/components/DurationField';
import { ErrorState, LoadingRows, WriteError } from '@/components/states';
import { useMutation, useResource } from '@/hooks/use-resource';
import { api, type TaskDetail } from '@/lib/api';
import {
  COGNITIVE_LOAD_LABELS,
  MANUAL_PRIORITY_LABELS,
  STATUS_CLASSES,
  STATUS_LABELS,
  TASK_TYPE_LABELS,
  demoText,
  formatDeadline,
  formatMinutes,
} from '@/lib/format';
import { ScoreBreakdownPanel } from '@/components/ScoreBreakdownPanel';

/** ISO 时间 → datetime-local 输入框需要的本地 `YYYY-MM-DDTHH:mm`。 */
function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 编辑草稿：所有可写字段都在这一份里改，保存时再和原始任务 diff。 */
interface Draft {
  title: string;
  description: string;
  goalId: string;
  deadline: string; // datetime-local 值
  /** 耗时数值字符串；它的单位是下面的 durationUnit，不一定是分钟。 */
  minutes: string;
  /** 耗时单位。任务没记原单位（旧任务）时回退成 'minute'。 */
  durationUnit: DurationUnit;
  taskType: string;
  priority: string;
}

const EMPTY_DRAFT: Draft = {
  title: '',
  description: '',
  goalId: '',
  deadline: '',
  minutes: '',
  durationUnit: 'minute',
  taskType: '',
  priority: '0',
};

export function TaskDetailDrawer({
  taskId,
  onOpenChange,
}: {
  taskId: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  const open = taskId !== null;

  // 按任务 id 独立加载：换任务立刻视为「旧数据」，不会把上一个任务的字段带进来。
  const detail = useResource<TaskDetail>(
    ['tasks', 'goals', 'queue'],
    () => (taskId ? api.getTask(taskId) : Promise.resolve(null)),
    [taskId],
  );
  const goals = useResource<{ goals: GoalWithProgress[] }>(['goals'], () => api.listGoals(), []);
  const save = useMutation(['tasks', 'goals', 'queue', 'activity']);

  const task = detail.data?.task ?? null;

  // 每次拿到「属于当前任务 id」的数据，就用它初始化一份可编辑副本。
  // 在渲染期按 (任务 id + 版本) 调整状态——这是 React 官方推荐的「prop 变化时重置」
  // 写法，避免在 effect 里同步 setState 造成级联渲染。
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const loadedKey = task && detail.current ? `${task.id}@${task.version}` : null;
  if (loadedKey !== null && loadedKey !== loadedFor) {
    setLoadedFor(loadedKey);
    setDraft({
      title: task!.title,
      description: task!.description ?? '',
      goalId: task!.goal_id ?? '',
      deadline: toLocalInput(task!.deadline),
      // 任务记了原单位就按原单位回显；旧任务（两列为 NULL）回退成分钟 +
      // estimated_minutes，和这个字段存在之前看到的完全一样。
      minutes:
        task!.duration_value != null
          ? String(task!.duration_value)
          : task!.estimated_minutes != null
            ? String(task!.estimated_minutes)
            : '',
      durationUnit: task!.duration_value != null && task!.duration_unit
        ? task!.duration_unit
        : 'minute',
      taskType: task!.task_type ?? '',
      priority: String(task!.manual_priority ?? 0),
    });
  }

  const set = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));

  // 关闭即丢弃：不发任何请求。
  const close = (next: boolean) => {
    if (!next) onOpenChange(false);
  };

  const canSave = task !== null && draft.title.trim().length > 0 && save.pending === null;

  /**
   * 归档任务在此抽屉里可「恢复」（回到归档前状态）；已完成任务可「重新打开」
   * （回到待处理）。都带 expected_version 做乐观并发，成功后关抽屉并让
   * 队列/目标/活动一起刷新。
   */
  const lifecycleAction = async (action: 'restore' | 'reopen') => {
    if (!task) return;
    const result = await save.run(action, () =>
      api.taskAction(task.id, action, { expected_version: task.version }),
    );
    if (result) onOpenChange(false);
  };

  const persist = async () => {
    if (!task) return;
    const body: Record<string, unknown> = { expected_version: task.version };

    const title = draft.title.trim();
    if (title !== task.title) body.title = title;

    const description = draft.description.trim();
    const currentDescription = task.description ?? '';
    if (description !== currentDescription) body.description = description || null;

    const goalId = draft.goalId || null;
    if (goalId !== (task.goal_id ?? null)) body.goal_id = goalId;

    const deadlineIso = draft.deadline ? new Date(draft.deadline).toISOString() : null;
    const currentDeadline = task.deadline ?? null;
    if ((deadlineIso ?? null) !== currentDeadline) body.deadline = deadlineIso;

    // 耗时：和「草稿初始化时的原单位值」比，变了才发。一律按
    // duration_value/duration_unit 发（清空时两者都是 null），由服务端按最新
    // habits 配置重算 estimated_minutes。
    const durationValue = draft.minutes.trim() ? Number(draft.minutes) : null;
    const originalValue =
      task.duration_value != null ? task.duration_value : task.estimated_minutes;
    const originalUnit: DurationUnit =
      task.duration_value != null && task.duration_unit ? task.duration_unit : 'minute';
    if (durationValue !== (originalValue ?? null) || draft.durationUnit !== originalUnit) {
      body.duration_value = durationValue;
      body.duration_unit = durationValue == null ? null : draft.durationUnit;
    }

    const taskType = (draft.taskType || null) as TaskType | null;
    if (taskType !== (task.task_type ?? null)) body.task_type = taskType;

    const priority = Number(draft.priority);
    if (priority !== task.manual_priority) body.manual_priority = priority;

    // 没有任何字段真正变化时，不发请求（expected_version 本身不算业务字段）。
    if (Object.keys(body).length === 1) {
      onOpenChange(false);
      return;
    }

    const result = await save.run('update', () =>
      api.updateTask(task.id, body as Parameters<typeof api.updateTask>[1]),
    );
    // 成功后关闭；失败（含 409 版本冲突）保持打开，错误已由 useMutation 透出。
    if (result) onOpenChange(false);
  };

  const goalsList = goals.data?.goals ?? [];

  const blockedInfo = useMemo(() => {
    if (!task) return null;
    return {
      dependsOn: task.depends_on,
      blocks: task.blocks,
      dependencyReady: task.dependency_ready,
      cognitiveLoad: task.cognitive_load,
      blockedReason: task.blocked_reason,
      position: task.queue_position,
      score: task.queue_score,
    };
  }, [task]);

  return (
    <Sheet open={open} onOpenChange={close}>
      {/*
        手机（390/320）下全屏抽屉：w-full + inset-y-0 顶到底；桌面 sm 起限宽为近全屏。

        背景/正文/边框一律写成显式 token 类（bg-background / text-foreground /
        border-l border-border），不依赖继承也不留任何硬编码颜色——抽屉是 portal
        渲染到 body 下的，显式声明才能保证它和页面用的是同一套浅色 token。
      */}
      <SheetContent
        side="right"
        className="w-full gap-0 border-l border-border bg-background p-0 text-foreground sm:max-w-xl"
      >
        {/* pr-10 给右上角固定的关闭叉号留位，长中文标题与状态徽章不会被压住。 */}
        <SheetHeader className="shrink-0 border-b border-border px-4 py-3 text-left pr-10">
          <SheetTitle className="flex min-w-0 items-center gap-2 text-sm">
            <Info className="size-4 shrink-0 text-primary" />
            <span className="min-w-0 truncate">任务详情</span>
            {task ? (
              <Badge variant="outline" className={cnStatus(task.status)}>
                {STATUS_LABELS[task.status]}
              </Badge>
            ) : null}
          </SheetTitle>
        </SheetHeader>

        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-4 p-4">
            {taskId && !detail.current ? (
              <LoadingRows rows={3} />
            ) : detail.error ? (
              <ErrorState message={detail.error} onRetry={detail.refetch} />
            ) : !task ? (
              <p className="text-xs text-muted-foreground">这个任务不存在或已被移除。</p>
            ) : (
              <>
                {save.error ? (
                  <WriteError
                    message={save.error}
                    onDismiss={() => {
                      save.clearError();
                      detail.refetch();
                    }}
                  />
                ) : null}

                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="detail-title" className="text-xs font-normal">标题</Label>
                    <Input
                      id="detail-title"
                      value={draft.title}
                      onChange={(event) => set({ title: event.target.value })}
                      className="bg-card! disabled:bg-muted! read-only:bg-muted!"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="detail-description" className="text-xs font-normal">描述</Label>
                    <Textarea
                      id="detail-description"
                      rows={3}
                      value={draft.description}
                      onChange={(event) => set({ description: event.target.value })}
                      placeholder="怎样算做完了？"
                      className="bg-card! disabled:bg-muted! read-only:bg-muted!"
                    />
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="detail-goal" className="text-xs font-normal">目标关联</Label>
                      <NativeSelect
                        id="detail-goal"
                        value={draft.goalId}
                        onChange={(event) => set({ goalId: event.target.value })}
                        className="bg-card! disabled:bg-muted!"
                      >
                        <NativeSelectOption value="">不关联目标</NativeSelectOption>
                        {goalsList.map((goal) => (
                          <NativeSelectOption key={goal.id} value={goal.id}>
                            {demoText(goal.title, goal.is_demo)}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                    </div>

                    <div className="space-y-1.5">
                      <Label htmlFor="detail-deadline" className="text-xs font-normal">截止时间</Label>
                      <TaskDateTimeField
                        id="detail-deadline"
                        value={draft.deadline}
                        onChange={(v) => set({ deadline: v })}
                      />
                    </div>

                    <div className="space-y-1.5">
                      <Label htmlFor="detail-minutes" className="text-xs font-normal">预计耗时</Label>
                      <DurationField
                        id="detail-minutes"
                        value={draft.minutes}
                        unit={draft.durationUnit}
                        onValueChange={(next) => set({ minutes: next })}
                        onUnitChange={(next) => set({ durationUnit: next })}
                      />
                    </div>

                    <div className="space-y-1.5">
                      <Label htmlFor="detail-type" className="text-xs font-normal">任务类型</Label>
                      <NativeSelect
                        id="detail-type"
                        value={draft.taskType}
                        onChange={(event) => set({ taskType: event.target.value })}
                        className="bg-card! disabled:bg-muted!"
                      >
                        <NativeSelectOption value="">未指定</NativeSelectOption>
                        {TASK_TYPES.map((type) => (
                          <NativeSelectOption key={type} value={type}>
                            {TASK_TYPE_LABELS[type]}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                    </div>

                    <div className="space-y-1.5">
                      <Label htmlFor="detail-priority" className="text-xs font-normal">手动优先级</Label>
                      <NativeSelect
                        id="detail-priority"
                        value={draft.priority}
                        onChange={(event) => set({ priority: event.target.value })}
                        className="bg-card! disabled:bg-muted!"
                      >
                        {MANUAL_PRIORITY_LABELS.map((option) => (
                          <NativeSelectOption key={option.value} value={option.value}>
                            {option.label}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                    </div>
                  </div>
                </div>

                <Separator />

                {/* 高级信息：依赖 / 认知负荷 / 受阻 / 排序细节，默认折叠。 */}
                <Collapsible>
                  <CollapsibleTrigger asChild>
                    <Button variant="ghost" size="sm" className="w-full justify-between text-muted-foreground">
                      <span className="flex items-center gap-1.5 text-xs">
                        <ListOrdered className="size-3.5" />
                        依赖、认知负荷、受阻与排序细节
                      </span>
                      <ChevronDown className="size-4 transition-transform" />
                    </Button>
                  </CollapsibleTrigger>
                  <CollapsibleContent className="mt-2 space-y-3">
                    <div className="rounded-lg border border-border bg-muted/20 p-3 text-xs">
                      <div className="flex items-baseline justify-between">
                        <span className="font-medium">依赖</span>
                        <span className={blockedInfo?.dependencyReady ? 'text-muted-foreground' : 'text-amber-600'}>
                          {blockedInfo?.dependencyReady ? '依赖已就绪' : '存在未完成依赖'}
                        </span>
                      </div>
                      <p className="mt-1 text-muted-foreground">
                        前置：{blockedInfo?.dependsOn.length ? blockedInfo.dependsOn.join('、') : '无'}
                      </p>
                      <p className="text-muted-foreground">
                        阻塞后续：{blockedInfo?.blocks.length ? blockedInfo.blocks.join('、') : '无'}
                      </p>
                    </div>

                    <div className="grid grid-cols-1 gap-3 text-xs sm:grid-cols-2">
                      <div className="rounded-lg border border-border bg-muted/20 p-3">
                        <p className="text-muted-foreground">认知负荷</p>
                        <p className="mt-1 font-medium">
                          {blockedInfo?.cognitiveLoad
                            ? COGNITIVE_LOAD_LABELS[blockedInfo.cognitiveLoad as CognitiveLoad]
                            : '未指定'}
                        </p>
                      </div>
                      <div className="rounded-lg border border-border bg-muted/20 p-3">
                        <p className="text-muted-foreground">当前截止 / 预计</p>
                        <p className="mt-1 font-medium">
                          {task.deadline ? formatDeadline(task.deadline) : '无截止'}
                        </p>
                        <p className="text-muted-foreground">{formatMinutes(task.estimated_minutes)}</p>
                      </div>
                    </div>

                    {task.blocked_reason ? (
                      <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
                        <p className="flex items-center gap-1.5 font-medium">
                          <CircleAlert className="size-3.5" />
                          受阻原因
                        </p>
                        <p className="mt-1">{demoText(task.blocked_reason, task.is_demo)}</p>
                      </div>
                    ) : null}

                    {task.queue_position != null && task.queue_score != null ? (
                      <div className="rounded-lg border border-border bg-muted/20 p-3">
                        <p className="text-xs text-muted-foreground">
                          队列位置 #{task.queue_position} · 分值 {task.queue_score.toFixed(2)}
                        </p>
                        {detail.data?.explanation ? (
                          <div className="mt-2">
                            <ScoreBreakdownPanel breakdown={detail.data.explanation.breakdown} />
                          </div>
                        ) : null}
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        当前状态不参与队列排序（已完成 / 已归档等）。
                      </p>
                    )}
                  </CollapsibleContent>
                </Collapsible>

                <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                  <div className="flex flex-wrap items-center gap-2">
                    {task.status === 'archived' ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void lifecycleAction('restore')}
                        disabled={save.pending !== null}
                      >
                        {save.pending === 'restore' ? '恢复中…' : '恢复此任务'}
                      </Button>
                    ) : null}
                    {task.status === 'completed' ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void lifecycleAction('reopen')}
                        disabled={save.pending !== null}
                      >
                        {save.pending === 'reopen' ? '打开中…' : '重新打开'}
                      </Button>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button size="sm" variant="outline" onClick={() => onOpenChange(false)} disabled={save.pending !== null}>
                      取消
                    </Button>
                    <Button size="sm" disabled={!canSave} onClick={() => void persist()}>
                      {save.pending === 'update' ? '保存中…' : '保存'}
                    </Button>
                  </div>
                </div>
              </>
            )}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}

/** STATUS_CLASSES 已从 format 导出，这里直接复用以保证与卡片一致。 */
function cnStatus(status: keyof typeof STATUS_CLASSES): string {
  return STATUS_CLASSES[status];
}
