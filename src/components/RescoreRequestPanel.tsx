/**
 * 复评请求面板：把一次「想把任务挪到别的象限」变成一次交给**外部 Agent** 的复评。
 *
 * 这个面板替掉的旧行为是：用户在卡片上点一个象限，前端直接把两轴分数写成那个格子
 * 的 band（75/25 之类），一次点击凭空产生两个看起来像判断的数字。现在整条链路是：
 *
 *   发起（算出要重评哪几根轴，不给分）
 *     → 等待（本页**没有**真实语言模型，上下文交给外部 Agent 读）
 *     → 待确认（逐轴显示 前→后 + 理由 + Agent 署名）
 *     → 用户点「确认保存」才写库
 *
 * 三条红线落在这个文件里：
 *
 * 1. **不伪造分数。** 建议到达前只显示「等待外部 Agent 复评建议」，没有本地兜底
 *    评分，也**没有让用户自己填分数的输入框**——那只会把"用户猜的数"伪装成评分。
 * 2. **未请求的轴原样保留**，界面明确标注，用户一眼能看出这次只动了哪根轴。
 * 3. **不点「确认保存」就不写 tasks**，取消与关闭都只丢弃这次请求。
 *
 * 受控组件：开关、忙碌、报错全部由 `useTaskActions` 注入，自身只持有「勾了哪几根
 * 轴」这一个本地状态。
 */
import { useState } from 'react';
import type { Quadrant, Task } from '@shared/types';
import { Bot, Clock, RefreshCw } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { QUADRANT_TITLES, STATUS_LABELS, demoText, formatMatrixScore } from '@/lib/format';
import type {
  RescoringAxis,
  RescoringContextView,
  RescoringRequestWithContext,
} from '@/lib/rescoring-client';

const AXIS_LABELS: Record<RescoringAxis, string> = {
  importance: '重要',
  urgency: '紧急',
};

const ALL_AXES: readonly RescoringAxis[] = ['importance', 'urgency'];

/** 目标象限在每根轴上要求的那一侧。与后端 `axesMismatchingQuadrant` 同一套规则。 */
const wantHigh: Record<RescoringAxis, (target: Quadrant) => boolean> = {
  importance: (target) => target === 'q1' || target === 'q2',
  urgency: (target) => target === 'q1' || target === 'q3',
};

const scoreOf = (task: Task, axis: RescoringAxis): number | null =>
  axis === 'importance' ? task.matrix_importance_score : task.matrix_urgency_score;

/** 分数的展示：缺分明确写「未评分」，不拿 0 或 50 顶上。 */
const showScore = (score: number | null): string =>
  score == null ? '未评分' : formatMatrixScore(score);

/**
 * 前端侧算出「哪几根轴跨线了」，只用来给复选框一个默认勾选。
 *
 * 真正生效的那份仍由后端在创建请求时算（或校验），这里算一遍纯粹是为了让用户在
 * 点按钮之前就看见这次会动哪根轴。
 */
function mismatchingAxes(task: Task, target: Quadrant): RescoringAxis[] {
  return ALL_AXES.filter((axis) => {
    const score = scoreOf(task, axis);
    // 没有分数就没有 side：无从判断"已经匹配"，按不匹配处理。
    if (score == null) return true;
    return score >= 50 !== wantHigh[axis](target);
  });
}

export interface RescoreRequestPanelProps {
  open: boolean;
  /** 要复评的任务；`null` 表示没有可展示的目标。 */
  task: Task | null;
  /** 用户想拖到的象限。 */
  targetQuadrant: Quadrant | null;
  /** 已经发起的请求；`null` 表示还停在发起态。 */
  request?: RescoringRequestWithContext | null;
  busy: boolean;
  error: string | null;
  /** 发起态点按钮：把最终勾选的轴交出去。 */
  onCreate?: (axes: RescoringAxis[]) => void;
  /** 等待态点「刷新状态」。 */
  onRefresh?: () => void;
  /** 待确认态点「确认保存」——唯一会写库的出口。 */
  onConfirm?: () => void;
  /** 取消这次复评请求。 */
  onCancelRequest?: () => void;
  onClose: () => void;
  /** 确认成功后由调用方刷新列表。 */
  onDone?: () => void;
}

export function RescoreRequestPanel({
  open,
  task,
  targetQuadrant,
  request = null,
  busy,
  error,
  onCreate,
  onRefresh,
  onConfirm,
  onCancelRequest,
  onClose,
}: RescoreRequestPanelProps) {
  const autoAxes = task && targetQuadrant ? mismatchingAxes(task, targetQuadrant) : [];

  /**
   * 发起态里用户勾选的轴。
   *
   * `null` 表示"还没手动动过"，渲染时落回算出来的 `autoAxes`——这样换任务或换
   * 目标象限时不必用 effect 去重置 state（那会触发级联渲染），调用方给
   * `key={...}` 时同样天然干净。
   */
  const [picked, setPicked] = useState<RescoringAxis[] | null>(null);
  const selected = picked ?? autoAxes;

  if (!task) return null;

  const title = demoText(task.title, task.is_demo);
  const status = request?.status ?? null;
  const context = request?.context ?? null;

  /** 发起态：显示当前分数、当前/目标象限，以及这次会动哪几根轴。 */
  const renderCreate = () => (
    <div className="space-y-3">
      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 rounded-md border border-border bg-muted/20 px-3 py-2.5 text-xs">
        <div>
          <dt className="text-muted-foreground">当前重要</dt>
          <dd className="mt-0.5 font-medium tabular-nums">
            {showScore(task.matrix_importance_score)}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">当前紧急</dt>
          <dd className="mt-0.5 font-medium tabular-nums">
            {showScore(task.matrix_urgency_score)}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">当前象限</dt>
          <dd className="mt-0.5 font-medium">
            {task.quadrant ? QUADRANT_TITLES[task.quadrant] : '未分类'}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">目标象限</dt>
          <dd className="mt-0.5 font-medium">
            {targetQuadrant ? QUADRANT_TITLES[targetQuadrant] : '—'}
          </dd>
        </div>
      </dl>

      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">
          按当前分数判断，下面勾选的轴需要重新评分；未勾选的轴会原样保留原值。
          至少要选一根。
        </p>
        {ALL_AXES.map((axis) => {
          const checked = selected.includes(axis);
          const auto = autoAxes.includes(axis);
          return (
            <div key={axis} className="flex items-center gap-2">
              <Checkbox
                id={`rescore-axis-${axis}`}
                checked={checked}
                disabled={busy}
                onCheckedChange={(next) =>
                  setPicked(
                    next === true
                      ? selected.includes(axis)
                        ? selected
                        : [...selected, axis]
                      : selected.filter((item) => item !== axis),
                  )
                }
              />
              <Label htmlFor={`rescore-axis-${axis}`} className="text-xs font-normal">
                重新评估{AXIS_LABELS[axis]}
                <span className="ml-1 tabular-nums text-muted-foreground">
                  （当前 {showScore(scoreOf(task, axis))}）
                </span>
              </Label>
              {auto ? (
                <Badge variant="outline" className="h-5 px-1.5 text-[10px] font-normal">
                  与目标象限不一致
                </Badge>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );

  /** 等待态：把上下文摆出来给外部 Agent 读，绝不在这里让用户填分。 */
  const renderPending = (ctx: RescoringContextView | null) => (
    <div className="space-y-3">
      <Alert>
        <Clock />
        <AlertTitle>等待外部 Agent 复评建议</AlertTitle>
        <AlertDescription>
          本页未接入真实语言模型，以下上下文请由外部 Agent（加载本 Skill 的主 Agent）
          读取后提交建议。建议到达前这里不会显示任何分数。
        </AlertDescription>
      </Alert>

      <dl className="space-y-2 rounded-md border border-border bg-muted/20 px-3 py-2.5 text-xs">
        <div>
          <dt className="text-muted-foreground">任务标题</dt>
          <dd className="mt-0.5 font-medium">{title}</dd>
        </div>
        {ctx?.task.description ? (
          <div>
            <dt className="text-muted-foreground">任务描述</dt>
            <dd className="mt-0.5 whitespace-pre-wrap leading-relaxed">
              {demoText(ctx.task.description, ctx.task.is_demo)}
            </dd>
          </div>
        ) : null}
        <div>
          <dt className="text-muted-foreground">所属目标</dt>
          <dd className="mt-0.5">{ctx?.goal_title ?? '（未关联目标）'}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">依赖任务</dt>
          <dd className="mt-0.5">
            {ctx?.depends_on.length
              ? ctx.depends_on.map((item) => (
                  <span key={item.id} className="mr-2 inline-block">
                    {item.title}
                    <span className="ml-1 text-muted-foreground">
                      （{STATUS_LABELS[item.status as Task['status']] ?? item.status}）
                    </span>
                  </span>
                ))
              : '（无依赖）'}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">习惯摘要</dt>
          <dd className="mt-0.5">{ctx?.habits_summary ?? '（本次请求未附带习惯摘要）'}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">本次请求重评的轴</dt>
          <dd className="mt-0.5">
            {(request?.changed_axes ?? []).map((axis) => AXIS_LABELS[axis]).join(' + ') || '—'}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">请求编号</dt>
          <dd className="mt-0.5 font-mono text-[11px]">{request?.id ?? '—'}</dd>
        </div>
      </dl>
    </div>
  );

  /** 待确认态：逐轴 前→后，未改的轴标「原样保留」。 */
  const renderAwaitingConfirm = () => {
    const changed = new Set(request?.changed_axes ?? []);
    const after: Record<RescoringAxis, number | null> = {
      importance: request?.after_importance ?? null,
      urgency: request?.after_urgency ?? null,
    };
    const before: Record<RescoringAxis, number | null> = {
      importance: request?.before_importance ?? null,
      urgency: request?.before_urgency ?? null,
    };

    return (
      <div className="space-y-3">
        <Alert>
          <Bot />
          <AlertTitle>外部 Agent 已给出建议，等你确认</AlertTitle>
          <AlertDescription>
            下面是建议值，还没有写进任务。点「确认保存」才会落库。
          </AlertDescription>
        </Alert>

        <ul className="space-y-1.5 rounded-md border border-border bg-muted/20 px-3 py-2.5 text-xs">
          {ALL_AXES.map((axis) => (
            <li key={axis} className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">{AXIS_LABELS[axis]}</span>
              {changed.has(axis) ? (
                <span className="font-medium tabular-nums">
                  {showScore(before[axis])} → {showScore(after[axis])}
                </span>
              ) : (
                <span className="tabular-nums text-muted-foreground">
                  {showScore(before[axis])}
                  <Badge variant="outline" className="ml-1.5 h-5 px-1.5 text-[10px] font-normal">
                    原样保留
                  </Badge>
                </span>
              )}
            </li>
          ))}
        </ul>

        <dl className="space-y-2 text-xs">
          <div>
            <dt className="text-muted-foreground">理由</dt>
            <dd className="mt-0.5 whitespace-pre-wrap leading-relaxed">
              {request?.reason ?? '（未提供）'}
            </dd>
          </div>
          <div className="flex items-center gap-2">
            <dt className="text-muted-foreground">给出判断的 Agent</dt>
            <dd className="font-medium">{request?.agent_name ?? '（未署名）'}</dd>
            {request?.confidence != null ? (
              <Badge variant="outline" className="h-5 px-1.5 text-[10px] font-normal tabular-nums">
                置信度 {request.confidence}
              </Badge>
            ) : null}
          </div>
        </dl>
      </div>
    );
  };

  const body =
    status === null
      ? renderCreate()
      : status === 'pending'
        ? renderPending(context)
        : status === 'awaiting_confirm'
          ? renderAwaitingConfirm()
          : null;

  const footer =
    status === null ? (
      <>
        <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
          取消
        </Button>
        <Button
          type="button"
          disabled={busy || selected.length === 0}
          onClick={() => onCreate?.(selected)}
        >
          {busy ? '发起中…' : '发起复评请求，交由外部 Agent'}
        </Button>
      </>
    ) : status === 'pending' ? (
      <>
        <Button type="button" variant="outline" onClick={onCancelRequest} disabled={busy}>
          取消请求
        </Button>
        <Button type="button" variant="secondary" onClick={onRefresh} disabled={busy}>
          <RefreshCw className="size-3.5" />
          {busy ? '刷新中…' : '刷新状态'}
        </Button>
      </>
    ) : status === 'awaiting_confirm' ? (
      <>
        <Button type="button" variant="outline" onClick={onCancelRequest} disabled={busy}>
          取消
        </Button>
        <Button type="button" onClick={onConfirm} disabled={busy}>
          {busy ? '保存中…' : '确认保存'}
        </Button>
      </>
    ) : (
      <Button type="button" variant="outline" onClick={onClose}>
        关闭
      </Button>
    );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-sm">复评任务的轻重缓急</DialogTitle>
          <DialogDescription className="text-xs">
            「{title}」的两轴分数由真实外部 Agent 重新评估；本页不会自动评分，
            未经你确认也不会写入任务。
          </DialogDescription>
        </DialogHeader>

        {body}

        {error ? (
          <Alert variant="destructive">
            <AlertTitle>这次操作没有生效</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <Separator />
        <DialogFooter>{footer}</DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
