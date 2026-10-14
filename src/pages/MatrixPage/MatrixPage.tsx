/**
 * `/matrix` — 活跃任务的轻重缓急分布与四列复核表。
 *
 * 结构（自上而下）：
 * 1. 筛选与统计条——筛选同时作用于图和四列，分母是"当前筛选下已评分的任务"。
 * 2. 任务轻重缓急分布图（`MatrixScatter`，二维散点）。
 * 3. 真正的横向四列：重要且紧急 / 重要不紧急 / 不重要但紧急 / 不重要不紧急。
 *    每列展示全部任务，不截断；窄屏保留横向滚动而不是折成 2×2。
 * 4. 待评分区——没有有效评分的任务单列出来，不塞到图中心。
 *
 * 四列里**不**直接渲染完整 `TaskCard`：四条列同屏时完整卡片会把每列挤成一团。
 * 每个任务只占一行摘要（短编号、单行标题、状态、两轴分数、待确认标记），点一下
 * 在浮窗里展开完整卡片和它的全部操作——能力一个不少，只是换了承载位置。
 *
 * 这个视图只呈现分布，不参与排序；排序仍由 `/` 的评分算法决定。缩放只改变
 * 图的视窗，统计与四列内容完全不受影响。
 */
import { useMemo, useState } from 'react';
import type { Quadrant, TaskAction } from '@shared/types';
import { Grid2x2, HelpCircle, LayoutList, LineChart } from 'lucide-react';
import {
  assignShortCodes,
  matrixStats,
  matrixSummaryByQuadrant,
  matrixSummaryRow,
  needsQuadrantReview,
  resolveMatrixPlacement,
} from '@shared/matrix-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { TaskCard } from '@/components/TaskCard';
import { TaskDetailDrawer } from '@/components/TaskDetailDrawer';
import { EmptyState, ErrorState, LoadingRows, WriteError } from '@/components/states';
import { MatrixScatter } from '@/pages/MatrixPage/MatrixScatter';
import {
  MatrixSummaryRowItem,
  MatrixTaskDialog,
} from '@/pages/MatrixPage/MatrixSummaryRow';
import {
  QUADRANT_ORDER,
  pickDefaultQuadrant,
  type MobileMatrixView,
} from '@/pages/MatrixPage/layout';
import { useResource } from '@/hooks/use-resource';
import { useTaskActions } from '@/hooks/use-task-actions';
import { api, type TaskWithMatrix } from '@/lib/api';
import {
  QUADRANT_ACTIONS,
  QUADRANT_SUBTITLES,
  QUADRANT_TITLES,
  formatRatio,
} from '@/lib/format';
import { availableActionsFor } from '@/lib/actions';
import { cn } from '@/lib/utils';

/** 克制的列强调色，与散点图的象限配色一致。 */
const QUADRANT_ACCENTS: Record<Quadrant, string> = {
  q1: 'border-t-2 border-t-amber-600/60',
  q2: 'border-t-2 border-t-primary/60',
  q3: 'border-t-2 border-t-teal-600/50',
  q4: 'border-t-2 border-t-border',
};

type Filter = 'all' | 'unconfirmed';

export default function MatrixPage() {
  const [filter, setFilter] = useState<Filter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  /** 浮窗里正在查看的任务 id；`null` 表示没开浮窗。 */
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  /** 三入口共用的任务详情抽屉。 */
  const [detailTaskId, setDetailTaskId] = useState<string | null>(null);
  /** 手机端视图：默认先看按象限任务列表，散点图放二级页签。 */
  const [mobileView, setMobileView] = useState<MobileMatrixView>('list');
  /** 手机端当前象限；`null` 时自动落在任务最多的那一列。 */
  const [mobileQuadrant, setMobileQuadrant] = useState<Quadrant | null>(null);
  const tasks = useResource(['tasks', 'queue'], () => api.listTasks({ active: 'true' }));
  const { handlers, pendingLabelFor, error, clearError, blockDialog } = useTaskActions();

  const all = useMemo(() => tasks.data?.tasks ?? [], [tasks.data]);
  const visible = useMemo(
    () => (filter === 'unconfirmed' ? all.filter(needsQuadrantReview) : all),
    [all, filter],
  );

  // 编号基于任务 id，所以筛选、缩放、刷新都不会让它变化。
  const codes = useMemo(() => assignShortCodes(all.map((task) => task.id)), [all]);
  const stats = useMemo(() => matrixStats(visible), [visible]);
  // 四列的摘要行：纯函数派生，与统计同源，所以两者永远一致。
  const columns = useMemo(() => matrixSummaryByQuadrant(visible, codes), [visible, codes]);

  if (tasks.loading) return <LoadingRows rows={4} />;
  if (tasks.error) return <ErrorState message={tasks.error} onRetry={tasks.refetch} />;
  if (!tasks.data) return null;

  const reviewCount = all.filter(needsQuadrantReview).length;
  const unscored = visible.filter((task) => resolveMatrixPlacement(task) == null);

  /** 手机端当前象限：未手动选择时落在任务最多的那一列。 */
  const quadrantCounts = {
    q1: stats.byQuadrant.q1.count,
    q2: stats.byQuadrant.q2.count,
    q3: stats.byQuadrant.q3.count,
    q4: stats.byQuadrant.q4.count,
  };
  const activeMobileQuadrant = mobileQuadrant ?? pickDefaultQuadrant(quadrantCounts);

  /** 浮窗要展示的任务——从当前可见列表里找，写操作刷新后自动拿到新数据。 */
  const openTask = openTaskId
    ? (visible.find((task) => task.id === openTaskId) ?? null)
    : null;

  const renderTask = (
    task: TaskWithMatrix & { available_actions?: TaskAction[] },
    options: { showMatrixScores?: boolean; interactive?: boolean } = {},
  ) => {
    const interactive = options.interactive ?? true;
    return (
      <TaskCard
        key={task.id}
        task={task}
        availableActions={task.available_actions ?? availableActionsFor(task.status)}
        pendingLabel={pendingLabelFor(task.id)}
        compact
        code={codes.get(task.id)}
        showMatrixScores={options.showMatrixScores ?? true}
        highlighted={interactive && selectedId === task.id}
        {...(interactive
          ? {
              onSelect: (id: string) =>
                setSelectedId((current) => (current === id ? null : id)),
              onHoverChange: setHoveredId,
            }
          : {})}
        onOpenDetail={setDetailTaskId}
        {...handlers}
      />
    );
  };

  /**
   * 一个象限的列：头部（标题/副标题/数量占比）+ 该象限全部摘要行。
   * 桌面四列并排与手机单象限竖排都用它，保证两处内容、计数、高亮完全一致。
   */
  const renderQuadrantSection = (quadrant: Quadrant) => {
    const stat = stats.byQuadrant[quadrant];
    const rows = columns[quadrant];
    return (
      <section
        key={quadrant}
        className={cn(
          'flex min-w-0 flex-col rounded-lg border border-border bg-card',
          QUADRANT_ACCENTS[quadrant],
        )}
      >
        <header className="border-b border-border px-3 py-2.5">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h3 className="truncate text-sm font-medium">{QUADRANT_TITLES[quadrant]}</h3>
              <p className="truncate text-xs text-muted-foreground">
                {QUADRANT_SUBTITLES[quadrant]} · {QUADRANT_ACTIONS[quadrant]}
              </p>
            </div>
            {/* 数量与占比：缩放不改变这两个数。 */}
            <Badge
              variant="outline"
              className="shrink-0 font-normal tabular-nums text-muted-foreground"
            >
              {stat.count} · {formatRatio(stat.ratio)}
            </Badge>
          </div>
        </header>
        <div className="space-y-1.5 p-2">
          {rows.length === 0 ? (
            <p className="px-1 py-3 text-xs text-muted-foreground">这一列是空的。</p>
          ) : (
            rows.map((row) => (
              <MatrixSummaryRowItem
                key={row.id}
                row={row}
                highlighted={hoveredId === row.id || selectedId === row.id}
                busy={pendingLabelFor(row.id) !== null}
                onOpen={setOpenTaskId}
                onSelect={setSelectedId}
                onHoverChange={setHoveredId}
              />
            ))
          )}
        </div>
      </section>
    );
  };

  if (all.length === 0) {
    return (
      <EmptyState
        icon={<Grid2x2 />}
        title="没有可放入矩阵的活跃任务"
        description="矩阵展示待处理、已领取、进行中和受阻的任务。先在工作队列里创建一个任务，它就会出现在这里。"
      />
    );
  }

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold tracking-tight">任务分布视图</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            共 {all.length} 个活跃任务。象限用于判断精力投向，不等于队列顺序。
            四列中每行只给摘要，点一下在浮窗里展开完整任务卡片与全部操作。
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            size="sm"
            variant={filter === 'all' ? 'default' : 'outline'}
            onClick={() => setFilter('all')}
          >
            全部
          </Button>
          <Button
            size="sm"
            variant={filter === 'unconfirmed' ? 'default' : 'outline'}
            onClick={() => setFilter('unconfirmed')}
          >
            待确认
            <Badge variant="outline" className="ml-1 font-normal tabular-nums">
              {reviewCount}
            </Badge>
          </Button>
        </div>
      </header>

      {error ? <WriteError message={error} onDismiss={clearError} /> : null}

      {filter === 'unconfirmed' && visible.length === 0 ? (
        <EmptyState
          icon={<HelpCircle />}
          title="所有象限都已确认"
          description="当前没有活跃任务在等你复核推断出来的象限。"
          action={
            <Button size="sm" variant="outline" onClick={() => setFilter('all')}>
              查看全部任务
            </Button>
          }
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/20 px-3 py-2">
            <span className="text-xs text-muted-foreground">
              占比分母：当前筛选下 {stats.scored} 个已评分任务
            </span>
            {QUADRANT_ORDER.map((quadrant) => (
              <Badge
                key={quadrant}
                variant="outline"
                className="font-normal tabular-nums text-muted-foreground"
              >
                {QUADRANT_TITLES[quadrant]} {stats.byQuadrant[quadrant].count}（
                {formatRatio(stats.byQuadrant[quadrant].ratio)}）
              </Badge>
            ))}
            {stats.unscored > 0 ? (
              <Badge variant="outline" className="font-normal tabular-nums text-muted-foreground">
                待评分 {stats.unscored}
              </Badge>
            ) : null}
          </div>

          {/* 手机端视图切换：默认先看按象限任务列表，散点图放二级页签。桌面恒显两者。 */}
          <div className="md:hidden" role="tablist" aria-label="矩阵视图切换">
            <div className="grid grid-cols-2 gap-1 rounded-lg border border-border bg-muted/20 p-1">
              <button
                type="button"
                role="tab"
                aria-selected={mobileView === 'list'}
                onClick={() => setMobileView('list')}
                className={cn(
                  'flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs transition-colors',
                  mobileView === 'list'
                    ? 'bg-card font-medium text-foreground shadow-sm'
                    : 'text-muted-foreground',
                )}
              >
                <LayoutList className="size-3.5" />
                任务列表
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mobileView === 'chart'}
                onClick={() => setMobileView('chart')}
                className={cn(
                  'flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs transition-colors',
                  mobileView === 'chart'
                    ? 'bg-card font-medium text-foreground shadow-sm'
                    : 'text-muted-foreground',
                )}
              >
                <LineChart className="size-3.5" />
                分布图
              </button>
            </div>
          </div>

          {/*
            散点图：桌面恒显；手机仅在「分布图」页签显示。

            `key={mobileView}` 让手机切页签时整个重新挂载：外层是 hidden/block
            切换，复用的实例可能停在 0×0 的画布上，重挂一次就让 MatrixScatter
            重新同步测量容器。桌面 `mobileView` 恒为 'list'，key 不变、无影响。
            注意这里**不**因为 mobileView==='list' 就不渲染图表——桌面要恒显，
            挂不挂 ECharts 最终由 MatrixScatter 内部测得的容器尺寸决定。
          */}
          <div className={cn('md:block', mobileView === 'chart' ? 'block' : 'hidden')}>
            <MatrixScatter
              key={mobileView}
              tasks={visible}
              codes={codes}
              selectedId={selectedId}
              hoveredId={hoveredId}
              onSelect={setSelectedId}
              onHoverChange={setHoveredId}
            />
          </div>

          {/* 桌面四列：横向并排，窄屏横向滚动，不折成 2×2。 */}
          <div className="hidden md:block -mx-1 overflow-x-auto px-1 pb-1">
            <div className="grid min-w-[64rem] grid-cols-4 gap-3">
              {QUADRANT_ORDER.map((quadrant) => renderQuadrantSection(quadrant))}
            </div>
          </div>

          {/* 手机列表：象限标签 2×2 切换，选中象限单列竖排，不左右横滑。 */}
          <div className={cn('md:hidden', mobileView === 'list' ? 'block' : 'hidden')}>
            <div role="tablist" aria-label="象限切换" className="grid grid-cols-2 gap-1.5">
              {QUADRANT_ORDER.map((quadrant) => {
                const active = activeMobileQuadrant === quadrant;
                return (
                  <button
                    key={quadrant}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setMobileQuadrant(quadrant)}
                    className={cn(
                      'flex items-center justify-between gap-1.5 rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors',
                      active
                        ? 'border-primary/50 bg-primary/5 font-medium text-foreground'
                        : 'border-border bg-card text-muted-foreground',
                    )}
                  >
                    <span className="truncate">{QUADRANT_TITLES[quadrant]}</span>
                    <Badge
                      variant="outline"
                      className="shrink-0 px-1 font-normal tabular-nums text-[10px]"
                    >
                      {stats.byQuadrant[quadrant].count}
                    </Badge>
                  </button>
                );
              })}
            </div>
            <div className="mt-2">{renderQuadrantSection(activeMobileQuadrant)}</div>
          </div>

          {/* 第五区：没有有效评分，不画在图上也不塞到中心。 */}
          <section className="rounded-lg border border-dashed border-border bg-muted/10">
            <header className="flex items-start justify-between gap-2 border-b border-border px-3 py-2.5">
              <div className="min-w-0">
                <h3 className="truncate text-sm font-medium">待评分</h3>
                <p className="truncate text-xs text-muted-foreground">
                  两轴分值缺失或超出范围，未计入上方分母；可请外部 Agent 通过 Skill 的评分命令复评。
                </p>
              </div>
              <Badge
                variant="outline"
                className="shrink-0 font-normal tabular-nums text-muted-foreground"
              >
                {unscored.length}
              </Badge>
            </header>
            <div className="space-y-2 p-2.5">
              {unscored.length === 0 ? (
                <p className="px-1 py-3 text-xs text-muted-foreground">
                  当前筛选下每个任务都有有效评分。
                </p>
              ) : (
                unscored.map((task) => renderTask(task, { showMatrixScores: false }))
              )}
            </div>
          </section>

          {/*
            摘要行点开后的浮窗：完整 TaskCard 与它的全部操作。
            卡片本身不再接 onSelect/onHoverChange——浮窗里的点击应该落在按钮上，
            而不是又去切换散点图的选中态。
          */}
          <MatrixTaskDialog
            row={openTask ? matrixSummaryRow(openTask, codes) : null}
            onOpenChange={(next) => {
              if (!next) setOpenTaskId(null);
            }}
          >
            {openTask
              ? renderTask(openTask, {
                  showMatrixScores: resolveMatrixPlacement(openTask) != null,
                  interactive: false,
                })
              : null}
          </MatrixTaskDialog>
        </>
      )}

      {blockDialog}
      <TaskDetailDrawer taskId={detailTaskId} onOpenChange={() => setDetailTaskId(null)} />
    </div>
  );
}
