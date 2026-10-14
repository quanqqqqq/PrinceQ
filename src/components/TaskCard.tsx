/**
 * 任务行的标准实现。队列、四象限和目标详情共用它，所以任一处可做的操作在别处
 * 同样可做。
 *
 * 四象限页额外用到三个能力：稳定短编号、选中高亮，以及点击/悬停时回传任务 id
 * 以便定位散点图中的点。
 */
import { useState } from 'react';
import {
  AlertTriangle,
  CalendarDays,
  Check,
  ChevronDown,
  Clock,
  Info,
  Link2,
  ListOrdered,
  Sparkles,
} from 'lucide-react';
import type { Quadrant, Task, TaskAction } from '@shared/types';
import { resolveMatrixPlacement, type MatrixScoreFields } from '@shared/matrix-view';
import { reasonSummary, topReasonFactors } from '@shared/queue-reasons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { queuePriorityBand } from '@/lib/queue-priority';
import {
  ACTION_LABELS,
  MATRIX_SCORE_SOURCE_HINTS,
  MATRIX_SCORE_SOURCE_LABELS,
  QUADRANT_ACTIONS,
  QUADRANT_TITLES,
  STATUS_CLASSES,
  STATUS_LABELS,
  demoText,
  formatDeadline,
  formatMatrixScore,
  formatMinutes,
  isOverdue,
  needsQuadrantReview,
  translateSystemText,
} from '@/lib/format';
import { ScoreBreakdownPanel } from '@/components/ScoreBreakdownPanel';
import type { ScoreBreakdown } from '@shared/types';

const QUADRANT_ORDER: Quadrant[] = ['q1', 'q2', 'q3', 'q4'];

/** 各状态下用户最常要做的下一步。 */
const PRIMARY_ACTION: Partial<Record<Task['status'], TaskAction>> = {
  inbox: 'claim',
  claimed: 'start',
  in_progress: 'complete',
  blocked: 'unblock',
  completed: 'archive',
  archived: 'restore',
};

export interface TaskCardProps {
  task: Task & Partial<MatrixScoreFields> & { available_actions?: TaskAction[] };
  position?: number | null;
  score?: number | null;
  breakdown?: ScoreBreakdown | null;
  availableActions: TaskAction[];
  pendingLabel: string | null;
  onAction: (task: Task, action: TaskAction) => void;
  onConfirmQuadrant: (task: Task) => void;
  onChangeQuadrant: (task: Task, quadrant: Quadrant) => void;
  onResuggestQuadrant: (task: Task) => void;
  /** 四象限页不展示排序因子，否则列会被挤爆。 */
  showBreakdown?: boolean;
  compact?: boolean;
  /** 稳定短编号，与散点图上的点一一对应。 */
  code?: string;
  /** 展示两轴 0..100 评分（四象限页使用）。 */
  showMatrixScores?: boolean;
  highlighted?: boolean;
  /** 点击任务条：用于在图中定位对应的点。 */
  onSelect?: (taskId: string) => void;
  /** 悬停任务条：用于临时高亮图中的点。 */
  onHoverChange?: (taskId: string | null) => void;
  /** 打开三入口共用的任务详情抽屉；不传则不显示「详情」按钮。 */
  onOpenDetail?: (taskId: string) => void;
}

export function TaskCard({
  task,
  position,
  score,
  breakdown,
  availableActions,
  pendingLabel,
  onAction,
  onConfirmQuadrant,
  onChangeQuadrant,
  onResuggestQuadrant,
  showBreakdown = false,
  compact = false,
  code,
  showMatrixScores = false,
  highlighted = false,
  onSelect,
  onHoverChange,
  onOpenDetail,
}: TaskCardProps) {
  const [expanded, setExpanded] = useState(false);
  const scoreBand = queuePriorityBand(score);
  const primary = PRIMARY_ACTION[task.status];
  const primaryAvailable = primary && availableActions.includes(primary) ? primary : null;
  const secondary = availableActions.filter((action) => action !== primaryAvailable);
  const overdue = isOverdue(task.deadline);
  const busy = pendingLabel !== null;
  const placement = showMatrixScores ? resolveMatrixPlacement(task) : null;
  // 「为什么优先」默认只露两条最关键理由，完整评分依据在展开面板 / 详情抽屉里。
  const topReasons = showBreakdown && breakdown ? topReasonFactors(breakdown, 2) : [];

  return (
    <article
      className={cn(
        'task-card rounded-xl border bg-card transition-colors',
        highlighted
          ? 'border-primary/60 bg-primary/5 ring-1 ring-primary/30'
          : 'border-border hover:border-muted-foreground/30',
        busy && 'opacity-60',
        compact ? 'p-3' : 'p-4',
        onSelect && 'cursor-pointer',
      )}
      onClick={onSelect ? () => onSelect(task.id) : undefined}
      onMouseEnter={onHoverChange ? () => onHoverChange(task.id) : undefined}
      onMouseLeave={onHoverChange ? () => onHoverChange(null) : undefined}
    >
      <div className="flex items-start gap-3">
        {code ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="flex h-6 shrink-0 items-center justify-center rounded-md border border-border bg-muted/60 px-1.5 font-mono text-[11px] font-medium text-muted-foreground">
                {code}
              </span>
            </TooltipTrigger>
            <TooltipContent>稳定短编号，与上方散点图中的点一致</TooltipContent>
          </Tooltip>
        ) : null}

        {position != null ? (
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-muted/50 text-xs font-medium tabular-nums text-muted-foreground">
            {position}
          </div>
        ) : null}

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            {/* 默认只突出标题；长描述在统一详情抽屉里查看 / 编辑。 */}
            <h3 className={cn('font-semibold text-foreground',compact?'truncate text-sm':'line-clamp-2 text-[15px] leading-[22px]')}>
              {demoText(task.title, task.is_demo)}
            </h3>
            {score != null && scoreBand ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    tabIndex={0}
                    data-priority={scoreBand.tone}
                    className={cn(
                      'shrink-0 rounded-md border px-2 py-0.5 text-xs font-medium tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                      scoreBand.className,
                    )}
                  >
                    <span className="sr-only">{scoreBand.label}，队列评分 </span>
                    {score.toFixed(1)}
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  <p className="font-medium">{scoreBand.label} · {scoreBand.range}</p>
                  <p className="mt-1">队列分数越高，建议越优先处理。颜色仅表示分数档位。</p>
                  <p className="mt-1">下面两条理由是最主要的排序依据，展开可看逐项因子。</p>
                </TooltipContent>
              </Tooltip>
            ) : null}
          </div>

          <dl className="task-card-meta mt-2.5">
            <div className="task-card-meta-item">
              <dt className="sr-only">状态</dt>
              <dd>
                <Badge variant="outline" className={cn('font-normal', STATUS_CLASSES[task.status])}>
                  {STATUS_LABELS[task.status]}
                </Badge>
              </dd>
            </div>
            <div className="task-card-meta-item">
              <dt className="sr-only">轻重分类</dt>
              <dd className="text-muted-foreground">
                {task.quadrant ? QUADRANT_TITLES[task.quadrant] : '未分类'}
              </dd>
            </div>
            <div className="task-card-meta-item">
              <dt className="sr-only">截止时间</dt>
              <dd className={cn(overdue ? 'font-medium text-destructive' : 'text-muted-foreground')}>
                {overdue ? <AlertTriangle className="size-3.5" /> : <CalendarDays className="size-3.5" />}
                {task.deadline ? formatDeadline(task.deadline) : '未设截止'}
              </dd>
            </div>
            <div className="task-card-meta-item">
              <dt className="sr-only">预计用时</dt>
              <dd className="tabular-nums text-muted-foreground">
                <Clock className="size-3.5" />
                {task.estimated_minutes != null ? '预计 ' + formatMinutes(task.estimated_minutes) : '未估时'}
              </dd>
            </div>
            {placement ? (
              <div className="task-card-meta-item">
                <dt className="sr-only">评分</dt>
                <dd>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="tabular-nums text-muted-foreground">
                        重要 {formatMatrixScore(placement.importance)} · 紧急 {formatMatrixScore(placement.urgency)}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{MATRIX_SCORE_SOURCE_HINTS[placement.source]}</p>
                      {placement.reason ? <p className="mt-1 max-w-64">{translateSystemText(placement.reason)}</p> : null}
                    </TooltipContent>
                  </Tooltip>
                </dd>
              </div>
            ) : null}
            {placement?.legacy ? (
              <div className="task-card-meta-item">
                <dt className="sr-only">评分来源</dt>
                <dd>
                  <Badge variant="outline" className="font-normal text-muted-foreground">
                    {MATRIX_SCORE_SOURCE_LABELS.legacy}
                  </Badge>
                </dd>
              </div>
            ) : null}
          </dl>
          {!task.dependency_ready && task.depends_on.length>0 ? <div className="mt-3"><Badge variant="outline" className="gap-1 border-amber-300 bg-amber-50 font-normal text-amber-700"><Link2 className="size-3"/>{task.depends_on.length} 项依赖未完成</Badge></div>:null}

          {task.blocked_reason ? (
            <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-800">
              受阻原因：{demoText(task.blocked_reason, task.is_demo)}
            </p>
          ) : null}

          {needsQuadrantReview(task) ? (
            <div
              className="mt-2 flex flex-wrap items-center gap-1.5"
              // 确认/改象限的点击不应同时触发任务条的"定位到图中"行为。
              onClick={(event) => event.stopPropagation()}
            >
              {/* 象限确认压成一行短提示：推断理由收进 tooltip，完整改象限仍在右侧菜单。 */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex items-center gap-1 text-xs text-primary">
                    <Sparkles className="size-3" />
                    建议「{task.quadrant ? QUADRANT_TITLES[task.quadrant] : '待定'}」待确认
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  {translateSystemText(task.quadrant_reason)}
                </TooltipContent>
              </Tooltip>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => onConfirmQuadrant(task)}
              >
                <Check />
                确认
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="ghost" disabled={busy} aria-label="调整象限">
                    <ChevronDown />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuLabel>自己指定象限</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {QUADRANT_ORDER.map((quadrant) => (
                    <DropdownMenuItem
                      key={quadrant}
                      disabled={quadrant === task.quadrant}
                      onClick={() => onChangeQuadrant(task, quadrant)}
                    >
                      <span className="font-medium">{QUADRANT_TITLES[quadrant]}</span>
                      <span className="text-xs text-muted-foreground">
                        {QUADRANT_ACTIONS[quadrant]}
                      </span>
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => onResuggestQuadrant(task)}>
                    <Sparkles />
                    重新运行本地规则推断
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ) : null}

          {/* 「为什么优先」：默认只露两条最关键理由，展开看完整评分依据。 */}
          {topReasons.length > 0 ? (
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <ListOrdered className="size-3 shrink-0" />
                优先因为
              </span>
              {topReasons.map((reason) => (
                <span key={reason.key} className="tabular-nums">
                  {reasonSummary(reason)}
                </span>
              ))}
            </div>
          ) : null}

          <div
            className="task-card-actions mt-3 flex flex-wrap items-center gap-1.5 border-t border-border/60 pt-2"
            onClick={(event) => event.stopPropagation()}
          >
            {primaryAvailable ? (
              <Button
                // Desktop controls are compact; coarse pointers retain 40px targets in CSS.
                size="sm"
                disabled={busy}
                onClick={() => onAction(task, primaryAvailable)}
              >
                {pendingLabel === primaryAvailable ? '处理中…' : ACTION_LABELS[primaryAvailable]}
              </Button>
            ) : null}

            {onOpenDetail ? (
              <Button
                size="sm"
                variant="ghost"
                // 卡片是 bg-card（白），辅助灰在它上面已达 AA（见
                // tests/color-contrast.test.ts）；hover 时升到 foreground，
                // 叠加按钮自带的 hover-elevate，全部走 token，不写死颜色。
                className="text-muted-foreground hover:text-foreground"
                disabled={busy}
                onClick={() => onOpenDetail(task.id)}
              >
                <Info />
                详情
              </Button>
            ) : null}

            {secondary.length > 0 ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="outline" disabled={busy}>
                    更多
                    <ChevronDown />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuLabel>生命周期</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {secondary.map((action) => (
                    <DropdownMenuItem key={action} onClick={() => onAction(task, action)}>
                      {ACTION_LABELS[action]}
                    </DropdownMenuItem>
                  ))}
                  {task.quadrant_confirmed ? (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuLabel>象限</DropdownMenuLabel>
                      {QUADRANT_ORDER.map((quadrant) => (
                        <DropdownMenuItem
                          key={quadrant}
                          disabled={quadrant === task.quadrant}
                          onClick={() => onChangeQuadrant(task, quadrant)}
                        >
                          移动到「{QUADRANT_TITLES[quadrant]}」
                        </DropdownMenuItem>
                      ))}
                    </>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}

            {showBreakdown && breakdown ? (
              <Button
                size="sm"
                variant="ghost"
                className="text-muted-foreground"
                onClick={() => setExpanded((open) => !open)}
              >
                {expanded ? '收起全部依据' : '展开全部依据'}
                <ChevronDown className={cn('transition-transform', expanded && 'rotate-180')} />
              </Button>
            ) : null}
          </div>

          {expanded && breakdown ? (
            <>
              <Separator className="my-3" />
              <ScoreBreakdownPanel breakdown={breakdown} />
            </>
          ) : null}
        </div>
      </div>
    </article>
  );
}
