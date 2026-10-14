/**
 * 四象限四列里的一条摘要行，以及点开后承载完整 `TaskCard` 的浮窗。
 *
 * 四列直接渲染完整 TaskCard 会把每一列挤爆（标签、原因、按钮全都在里面），
 * 所以这里只画一行：稳定短编号、单行标题、状态、两轴分数、待确认小标记。
 * 完整卡片和它的全部操作放进 Dialog——没有任何能力因此丢失。
 *
 * 行上的悬停/点击仍然回传任务 id，散点图照旧联动高亮；打开浮窗不改变这一点。
 */
import type { ReactNode } from 'react';
import { Sparkles } from 'lucide-react';
import type { MatrixSummaryRow } from '@shared/matrix-view';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  MATRIX_SCORE_SOURCE_LABELS,
  QUADRANT_TITLES,
  STATUS_CLASSES,
  STATUS_LABELS,
  demoText,
  formatMatrixScore,
} from '@/lib/format';
import { cn } from '@/lib/utils';

export interface MatrixSummaryRowItemProps {
  row: MatrixSummaryRow;
  /** 与散点图联动的高亮态。 */
  highlighted?: boolean;
  /** 正在写入这条任务时置灰。 */
  busy?: boolean;
  /** 点击摘要行——打开完整卡片的浮窗。 */
  onOpen: (taskId: string) => void;
  /** 点击同时把选中态传给散点图。 */
  onSelect?: (taskId: string) => void;
  onHoverChange?: (taskId: string | null) => void;
}

/** 单行摘要。整行是一个按钮，点一下开浮窗。 */
export function MatrixSummaryRowItem({
  row,
  highlighted = false,
  busy = false,
  onOpen,
  onSelect,
  onHoverChange,
}: MatrixSummaryRowItemProps) {
  const title = demoText(row.title, row.isDemo);

  return (
    <button
      type="button"
      className={cn(
        'w-full rounded-md border px-2 py-1.5 text-left transition-colors hover-elevate active-elevate-2',
        highlighted
          ? 'border-primary/60 bg-primary/5 ring-1 ring-primary/30'
          : 'border-border bg-card',
        busy && 'opacity-60',
      )}
      onClick={() => {
        onSelect?.(row.id);
        onOpen(row.id);
      }}
      onMouseEnter={onHoverChange ? () => onHoverChange(row.id) : undefined}
      onMouseLeave={onHoverChange ? () => onHoverChange(null) : undefined}
    >
      <div className="flex items-center gap-1.5">
        <span className="shrink-0 font-mono text-[11px] font-medium text-muted-foreground">
          {row.code}
        </span>
        {/* 单行标题：超出省略，不换行撑开列。 */}
        <span className="min-w-0 flex-1 truncate text-xs text-foreground">{title}</span>
        {row.needsReview ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="flex size-4 shrink-0 items-center justify-center rounded-sm border border-primary/30 bg-primary/5 text-primary">
                <Sparkles className="size-2.5" />
                <span className="sr-only">象限待确认</span>
              </span>
            </TooltipTrigger>
            <TooltipContent>象限待确认，点开可确认或修改</TooltipContent>
          </Tooltip>
        ) : null}
      </div>

      <div className="mt-1 flex items-center gap-1.5">
        <Badge
          variant="outline"
          className={cn('h-4 px-1 text-[10px] font-normal', STATUS_CLASSES[row.status])}
        >
          {STATUS_LABELS[row.status]}
        </Badge>
        {row.importance != null && row.urgency != null ? (
          <span className="shrink-0 tabular-nums text-[11px] text-muted-foreground">
            重 {formatMatrixScore(row.importance)} · 急 {formatMatrixScore(row.urgency)}
          </span>
        ) : (
          <span className="shrink-0 text-[11px] text-muted-foreground">待评分</span>
        )}
        {row.legacy ? (
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {MATRIX_SCORE_SOURCE_LABELS.legacy}
          </span>
        ) : null}
      </div>
    </button>
  );
}

export interface MatrixTaskDialogProps {
  /** 要展示的行；`null` 表示关闭。 */
  row: MatrixSummaryRow | null;
  onOpenChange: (open: boolean) => void;
  /** 完整的 `TaskCard`，由调用方装配，保证操作与别处完全一致。 */
  children: ReactNode;
}

/** 摘要行点开后的浮窗，里面是完整的 TaskCard 及其所有操作。 */
export function MatrixTaskDialog({ row, onOpenChange, children }: MatrixTaskDialogProps) {
  return (
    <Dialog open={row !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <span className="shrink-0 rounded-md border border-border bg-muted/60 px-1.5 font-mono text-[11px] font-medium text-muted-foreground">
              {row?.code}
            </span>
            <span className="min-w-0 truncate">任务详情</span>
          </DialogTitle>
          <DialogDescription>
            {row?.quadrant ? QUADRANT_TITLES[row.quadrant] : '待评分'}
            ：以下是完整任务卡片，所有操作与工作队列中一致。
          </DialogDescription>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}
