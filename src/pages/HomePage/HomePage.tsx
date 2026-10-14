/**
 * `/` — 工作队列，带三个可访问视图：
 *
 * - **队列**（默认）：评分算法排好序的活跃任务，带名次与逐项因子。
 * - **全部任务**：不分状态列出所有任务（含已完成、已归档、无目标任务），
 *   用于找回那些不再出现在活跃队列里、但仍可查看/恢复的任务。
 * - **已归档**：只列已归档任务，每条都带「恢复」，刷新后也能在这里恢复。
 *
 * 三个视图共用同一张 TaskCard 与统一的 TaskDetailDrawer，所以归档、恢复、
 * 重开、详情这些能力在任何视图里都可用。
 *
 * 队列视图额外有一个 **分组方式** 开关（优先顺序 / 轻重缓急 / 任务状态）：它
 * 纯粹是视觉分组——每组内任务顺序、名次、分值、评分因子全部沿用队列原始数据，
 * 不重排也不产生百分比，进度仍然只由卡片上的状态徽章表达。分组逻辑在
 * `@/lib/home-grouping`，这里只负责渲染。
 */
import { useMemo, useState } from 'react';
import { Archive, Grid2x2, ListOrdered, RefreshCw, SlidersHorizontal } from 'lucide-react';
import type { QueueEntry, TaskAction } from '@shared/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { TaskCard } from '@/components/TaskCard';
import { TaskDetailDrawer } from '@/components/TaskDetailDrawer';
import { CreateTaskDialog } from '@/components/CreateTaskDialog';
import { EmptyState, ErrorState, LoadingRows, WriteError } from '@/components/states';
import { useResource, useMutation } from '@/hooks/use-resource';
import { useTaskActions } from '@/hooks/use-task-actions';
import { api, type TaskWithMatrix } from '@/lib/api';
import { formatRelative, snapshotReasonLabel } from '@/lib/format';
import {
  HOME_GROUP_MODE_LABELS,
  groupHomeItems,
  type HomeGroupMode,
} from '@/lib/home-grouping';
import { availableActionsFor } from '@/lib/actions';
import { APP_TAGLINE } from '@/lib/i18n';

type HomeView = 'queue' | 'all' | 'archived';

type ListedTask = TaskWithMatrix & { available_actions?: TaskAction[] };

const VIEW_TABS: { key: HomeView; label: string; icon: typeof ListOrdered }[] = [
  { key: 'queue', label: '队列', icon: ListOrdered },
  { key: 'all', label: '全部任务', icon: ListOrdered },
  { key: 'archived', label: '已归档', icon: Archive },
];

/** 分组方式切换条：只在队列视图出现，默认「优先顺序」＝原来的扁平列表。 */
const GROUP_TABS: { key: HomeGroupMode; label: string; icon: typeof ListOrdered }[] = [
  { key: 'priority', label: HOME_GROUP_MODE_LABELS.priority, icon: ListOrdered },
  { key: 'quadrant', label: HOME_GROUP_MODE_LABELS.quadrant, icon: Grid2x2 },
  { key: 'status', label: HOME_GROUP_MODE_LABELS.status, icon: SlidersHorizontal },
];

export default function HomePage() {
  const [view, setView] = useState<HomeView>('queue');
  const [groupMode, setGroupMode] = useState<HomeGroupMode>('priority');
  const queue = useResource(['queue', 'tasks'], () => api.queue());
  // 全部任务视图与已归档视图共用这份列表：服务端不按状态过滤时返回所有任务。
  const allTasks = useResource(['tasks', 'queue'], () => api.listTasks());
  const goals = useResource(['goals'], () => api.listGoals());
  const recalculate = useMutation(['queue', 'tasks', 'activity']);
  const { handlers, pendingLabelFor, error, clearError, blockDialog } = useTaskActions();
  const [detailTaskId, setDetailTaskId] = useState<string | null>(null);

  const archivedOnly = useMemo(
    () => (allTasks.data?.tasks ?? []).filter((task) => task.status === 'archived'),
    [allTasks.data],
  );

  // 队列条目的分组。必须在任何提前 return 之前调用，Hook 顺序才稳定。
  // 依赖 `queue.data` 本身（而不是每次渲染新建的 `?? []`），这样只有数据真的
  // 换了或分组方式变了才重算。「优先顺序」下这就是整条队列的单一分组，渲染
  // 结果与分组功能加入前完全一致。
  const queueGroups = useMemo(
    () => groupHomeItems(queue.data?.entries ?? [], groupMode, (entry) => entry.task),
    [queue.data, groupMode],
  );

  if (queue.loading && view === 'queue') return <LoadingRows rows={5} />;
  if (queue.error && view === 'queue') {
    return <ErrorState message={queue.error} onRetry={queue.refetch} />;
  }

  const entries = queue.data?.entries ?? [];

  const renderTaskCard = (
    task: ListedTask,
    options: { position?: number | null; score?: number | null } = {},
  ) => (
    <TaskCard
      key={task.id}
      task={task}
      position={options.position ?? null}
      score={options.score ?? null}
      availableActions={task.available_actions ?? availableActionsFor(task.status)}
      pendingLabel={pendingLabelFor(task.id)}
      showBreakdown={view === 'queue'}
      onOpenDetail={setDetailTaskId}
      {...handlers}
    />
  );

  /**
   * 队列条目的卡片。扁平列表与分组列表共用它，所以切分组方式时卡片上的名次、
   * 分值、评分因子完全来自同一份 `entry` 数据，不会因为分组而变化。
   */
  const renderQueueEntry = (entry: QueueEntry) => (
    <TaskCard
      key={entry.task.id}
      task={entry.task}
      position={entry.position}
      score={entry.score}
      breakdown={entry.breakdown}
      availableActions={availableActionsFor(entry.task.status)}
      pendingLabel={pendingLabelFor(entry.task.id)}
      showBreakdown
      onOpenDetail={setDetailTaskId}
      {...handlers}
    />
  );

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-prose text-xs text-muted-foreground">
          {view === 'queue'
            ? APP_TAGLINE + ' 根据轻重缓急、期限和工作习惯，安排你的下一步。'
            : view === 'all'
              ? '列出所有状态的任务（含已完成、已归档、无目标任务），可查看详情并恢复。'
              : '已归档任务不参与队列排序；可随时恢复到归档前状态。'}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <CreateTaskDialog goals={goals.data?.goals ?? []} />
          {view === 'queue' ? (
            <Button
              size="sm"
              variant="outline"
              disabled={recalculate.pending !== null}
              onClick={() => void recalculate.run('recalculate', () => api.recalculate('manual-ui'))}
            >
              <RefreshCw className={recalculate.pending ? 'animate-spin' : undefined} />
              重算队列
            </Button>
          ) : null}
        </div>
      </header>

      {/* 视图切换：队列 / 全部任务 / 已归档；分组方式紧随其后，只在队列视图出现。 */}
      <div className="flex flex-wrap items-center gap-1.5">
        {VIEW_TABS.map((tab) => (
          <Button
            key={tab.key}
            size="sm"
            variant={view === tab.key ? 'default' : 'outline'}
            onClick={() => setView(tab.key)}
          >
            <tab.icon />
            {tab.label}
          </Button>
        ))}
        {view === 'archived' ? (
          <Badge variant="outline" className="font-normal tabular-nums text-muted-foreground">
            {archivedOnly.length} 个已归档
          </Badge>
        ) : null}
        {view === 'queue' ? (
          <div
            className="ml-auto flex flex-wrap items-center gap-1.5"
            role="group"
            aria-label="分组方式"
          >
            <Label htmlFor="queue-group-mode" className="text-xs text-muted-foreground">分组方式</Label>
            <NativeSelect id="queue-group-mode" value={groupMode} className="bg-card!"
              onChange={event => setGroupMode(event.target.value as HomeGroupMode)}>
              {GROUP_TABS.map(tab => <NativeSelectOption key={tab.key} value={tab.key}>{tab.label}</NativeSelectOption>)}
            </NativeSelect>
          </div>
        ) : null}
      </div>

      {view === 'queue' && queue.data ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/20 px-3 py-2">
          <Badge variant="outline" className="font-normal text-muted-foreground">
            已排序 {entries.length} 个任务
          </Badge>
          <details className="ml-auto text-xs text-muted-foreground">
            <summary className="cursor-pointer select-none">排序说明</summary>
            <div className="mt-1 space-y-0.5 pl-1">
              <div>根据截止压力、优先级、依赖、耗时、习惯与上下文综合排序。</div>
              <div>
                快照生成于{formatRelative(queue.data.snapshot.created_at)} ·{' '}
                {snapshotReasonLabel(queue.data.snapshot.reason)}
              </div>
            </div>
          </details>
        </div>
      ) : null}

      {recalculate.error ? (
        <WriteError message={recalculate.error} onDismiss={recalculate.clearError} />
      ) : null}
      {error ? <WriteError message={error} onDismiss={clearError} /> : null}

      {view === 'queue' && queue.data ? (
        entries.length === 0 ? (
          <EmptyState
            icon={<ListOrdered />}
            title="队列中没有任务"
            description="已完成和已归档的任务不参与排序。切到「全部任务」或「已归档」可找回它们，或者新建一个任务。"
            action={<CreateTaskDialog goals={goals.data?.goals ?? []} />}
          />
        ) : groupMode === 'priority' ? (
          // 默认路径：扁平列表，与分组功能加入前完全一致。
          <div className="space-y-2">{entries.map(renderQueueEntry)}</div>
        ) : (
          // 分组路径：只多出组标题，卡片本身（名次 / 分值 / 评分因子）一字不变。
          <div className="space-y-5">
            {queueGroups.map((group) => (
              <section key={group.key} className="space-y-2">
                <header className="flex items-center gap-2 border-b border-border pb-1">
                  <h2 className="text-xs font-medium text-foreground">{group.label}</h2>
                  <Badge
                    variant="outline"
                    className="font-normal tabular-nums text-muted-foreground"
                  >
                    {group.items.length}
                  </Badge>
                </header>
                <div className="space-y-2">{group.items.map(renderQueueEntry)}</div>
              </section>
            ))}
          </div>
        )
      ) : null}

      {view === 'all' ? (
        allTasks.loading ? (
          <LoadingRows rows={5} />
        ) : allTasks.error ? (
          <ErrorState message={allTasks.error} onRetry={allTasks.refetch} />
        ) : (allTasks.data?.tasks.length ?? 0) === 0 ? (
          <EmptyState
            icon={<ListOrdered />}
            title="还没有任何任务"
            description="新建一个任务后，它会出现在这里。"
          />
        ) : (
          <div className="space-y-2">
            {(allTasks.data?.tasks ?? []).map((task) => renderTaskCard(task))}
          </div>
        )
      ) : null}

      {view === 'archived' ? (
        allTasks.loading ? (
          <LoadingRows rows={3} />
        ) : allTasks.error ? (
          <ErrorState message={allTasks.error} onRetry={allTasks.refetch} />
        ) : archivedOnly.length === 0 ? (
          <EmptyState
            icon={<Archive />}
            title="没有已归档任务"
            description="归档任务会在这里出现，可随时恢复到归档前状态。"
          />
        ) : (
          <div className="space-y-2">
            {archivedOnly.map((task) => renderTaskCard(task))}
          </div>
        )
      ) : null}

      <TaskDetailDrawer taskId={detailTaskId} onOpenChange={() => setDetailTaskId(null)} />
      {blockDialog}
    </div>
  );
}
