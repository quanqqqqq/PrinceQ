/**
 * 队列评分的逐项说明：每个因子、权重、贡献值，以及打分器输出的备注。只读。
 */
import type { ScoreBreakdown } from '@shared/types';
import { Info } from 'lucide-react';
import { QUEUE_FACTOR_LABELS, translateSystemText } from '@/lib/i18n';
import { cn } from '@/lib/utils';

export function ScoreBreakdownPanel({
  breakdown,
  className,
}: {
  breakdown: ScoreBreakdown;
  className?: string;
}) {
  // 以绝对值最大的贡献作为标尺，这样扣分项也能看清。
  const peak = Math.max(
    1,
    ...breakdown.factors.map((factor) => Math.abs(factor.contribution)),
  );

  return (
    <div className={cn('space-y-3', className)}>
      <div className="flex items-baseline justify-between">
        <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          评分构成
        </h4>
        <span className="text-sm font-medium tabular-nums">{breakdown.score.toFixed(2)}</span>
      </div>

      <ul className="space-y-2">
        {breakdown.factors.map((factor) => {
          const negative = factor.contribution < 0;
          return (
            <li key={factor.key} className="space-y-1">
              <div className="flex items-baseline justify-between gap-2 text-xs">
                <span className="font-medium text-foreground">{QUEUE_FACTOR_LABELS[factor.key] ?? factor.label}</span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {negative ? '' : '+'}
                  {factor.contribution.toFixed(2)}
                  <span className="ml-1 text-muted-foreground/70">×{factor.weight}</span>
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className={cn('h-full rounded-full', negative ? 'bg-amber-400' : 'bg-primary')}
                  style={{ width: `${(Math.abs(factor.contribution) / peak) * 100}%` }}
                />
              </div>
              <p className="text-xs text-muted-foreground">{translateSystemText(factor.detail)}</p>
            </li>
          );
        })}
      </ul>

      {breakdown.notes.length > 0 ? (
        <div className="rounded-md border border-border bg-muted/30 p-2">
          <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
            <Info className="size-3" />
            备注
          </div>
          <ul className="mt-1 space-y-0.5">
            {breakdown.notes.map((note) => (
              <li key={note} className="text-xs text-muted-foreground">
                · {translateSystemText(note)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
