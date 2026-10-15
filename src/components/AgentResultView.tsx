/**
 * 渲染一条助手回复：回答、结构化区块，以及指令被拦为预览时的确认按钮。
 *
 * 文案全部经过 `@/lib/i18n` 的展示映射：后端写死的英文句子转为中文，夹在句子
 * 里的用户标题由捕获组原样带回，不作改写。
 *
 * 歧义候选（同名任务/目标）与目标拆分草稿都是「点一下就把指令重发/确认」的交互：
 * 候选卡只展示标题/目标/状态/截止，不展示也不复制任何 id。
 */
import { useState } from 'react';
import { useAgentWarningPreferences } from '@/hooks/use-agent-warning-preferences';
import type { AgentResult, DecompositionDraft } from '@shared/types';
import { defaultDraftSelection } from '@shared/decomposition';
import { AlertCircle, CheckCircle2, HelpCircle, Info, ShieldAlert, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { ScoreBreakdownPanel } from '@/components/ScoreBreakdownPanel';
import { Textarea } from '@/components/ui/textarea';
import { AgentSummary } from '@/components/AgentSummary';
import {
  agentBlockTitle,
  agentCommandLabel,
  agentFactLabel,
  agentFactValue,
  agentKindLabel,
  demoTitle,
  translateSystemText,
} from '@/lib/i18n';
import { GOAL_STATUS_LABELS, QUADRANT_TITLES, STATUS_LABELS, formatDeadline, formatMinutes } from '@/lib/format';
import { cn } from '@/lib/utils';

const KIND_META = {
  applied: { icon: CheckCircle2, className: 'text-emerald-600' },
  preview: { icon: ShieldAlert, className: 'text-amber-600' },
  clarification: { icon: HelpCircle, className: 'text-primary' },
  answer: { icon: Info, className: 'text-muted-foreground' },
  error: { icon: AlertCircle, className: 'text-destructive' },
} as const;

interface DraftOverride {
  index: number;
  title: string;
  description: string | null;
}

/** 助手面板里的目标拆分草稿编辑器：逐项勾选、可改标题/描述，明确「创建 N 个任务」。 */
function DecompositionPreviewBlock({
  drafts,
  notes,
  disabled,
  busy,
  onConfirm,
  onCancel,
}: {
  drafts: DecompositionDraft[];
  notes: string[];
  disabled: boolean;
  busy: boolean;
  onConfirm: (overrides: DraftOverride[]) => void;
  onCancel: () => void;
}) {
  const [editable, setEditable] = useState<DecompositionDraft[]>(() => drafts.map((d) => ({ ...d })));
  /**
   * 默认勾选所有**非重复**草稿（UX-22）——与 GoalDetailPanel 共用同一条规则。
   *
   * 疑似重复的默认不勾，遵后端「不建议」；用户仍可手动勾回。
   */
  const [selected, setSelected] = useState<boolean[]>(() => defaultDraftSelection(drafts));

  const chosen = selected.filter(Boolean).length;

  const confirm = () =>
    onConfirm(
      selected
        .map((on, i) =>
          on
            ? { index: i, title: editable[i].title.trim(), description: editable[i].description?.trim() || null }
            : null,
        )
        .filter((o): o is DraftOverride => o !== null),
    );

  if (disabled) {
    return (
      <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        这份草稿已经处理过，按钮已失效。
      </p>
    );
  }

  return (
    <div className="space-y-2.5 rounded-md border border-primary/30 bg-primary/5 p-2.5">
      <p className="text-xs font-medium">任务草稿——尚未写入任何数据</p>
      <ul className="space-y-2">
        {editable.map((draft, index) => (
          <li key={index} className="flex items-start gap-2 rounded-md border border-border bg-card p-2">
            <Checkbox
              id={`agent-draft-${index}`}
              checked={selected[index]}
              onCheckedChange={() =>
                setSelected((cur) => cur.map((on, i) => (i === index ? !on : on)))
              }
              className="mt-0.5"
              aria-label={`选择第 ${index + 1} 个草稿`}
            />
            <div className="min-w-0 flex-1 space-y-1.5">
              <Input
                value={draft.title}
                onChange={(e) =>
                  setEditable((cur) => cur.map((d, i) => (i === index ? { ...d, title: e.target.value } : d)))
                }
                className="h-8 text-sm font-medium"
                aria-label={`第 ${index + 1} 个草稿的标题`}
              />
              <Textarea
                value={draft.description ?? ''}
                onChange={(e) =>
                  setEditable((cur) => cur.map((d, i) => (i === index ? { ...d, description: e.target.value } : d)))
                }
                className="min-h-14 text-xs"
                aria-label={`第 ${index + 1} 个草稿的描述`}
              />
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant="outline" className="font-normal">
                  {QUADRANT_TITLES[draft.suggestion.quadrant]}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  {formatMinutes(draft.estimated_minutes)}
                </span>
                {draft.deadline ? (
                  <span className="text-xs text-muted-foreground">{formatDeadline(draft.deadline)}</span>
                ) : null}
                {/* 疑似重复：点明撞上了哪条已有任务，但不阻止创建。 */}
                {draft.duplicate ? (
                  <Badge
                    variant="outline"
                    className="border-amber-300 bg-amber-50 font-normal text-amber-700"
                  >
                    疑似重复：已有「{draft.duplicate.existing_title}」
                  </Badge>
                ) : null}
              </div>
              {draft.duplicate ? (
                <p className="text-xs text-amber-700">{draft.duplicate.reason}</p>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      <ul className="space-y-0.5">
        {notes.map((note) => (
          <li key={note} className="text-xs text-muted-foreground">
            · {translateSystemText(note)}
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={chosen === 0 || busy} onClick={confirm}>
          {busy ? '创建中…' : `创建 ${chosen} 个任务`}
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={onCancel}>
          取消
        </Button>
      </div>
    </div>
  );
}

export function AgentResultView({
  result,
  onConfirm,
  onCancel,
  onSend,
  confirming,
  disabledTokens,
  showHeader = true,
}: {
  result: AgentResult;
  onConfirm: (token: string, drafts?: DraftOverride[]) => void;
  /** 取消当前预览：服务端注销该 token，不创建任务。 */
  onCancel: (token: string) => void;
  /** 歧义候选点选：把「同一指令 + 精确标题」连同内部 id 一起发回解析器。 */
  onSend: (message: string, target?: { task_id?: string; goal_id?: string }) => void;
  confirming: boolean;
  /** 已经确认或取消过的 token，按钮永久失效，不能再次提交。 */
  disabledTokens: ReadonlySet<string>;
  /** System notices already show the outcome above their expandable details. */
  showHeader?: boolean;
}) {
  const meta = KIND_META[result.kind];
  const Icon = meta.icon;
  const token = result.pending_action?.token ?? null;
  const pendingDisabled = token !== null && disabledTokens.has(token);

  return (
    <div className="space-y-2.5">
      {showHeader ? <div className="flex items-start gap-2">
        <Icon className={cn('mt-0.5 size-4 shrink-0', meta.className)} />
        <div className="min-w-0 flex-1">
          <p className="whitespace-pre-wrap break-words text-[14px] leading-7 text-foreground">
            {result.answer ?? translateSystemText(result.headline)}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Badge variant="outline" className="font-normal text-muted-foreground">
              {agentKindLabel(result.kind)}
            </Badge>
            {result.matched_command ? (
              <Badge variant="outline" className="font-mono text-xs font-normal">
                {agentCommandLabel(result.matched_command)}
              </Badge>
            ) : null}
          </div>
        </div>
      </div> : null}

      <AgentWarnings warnings={result.warnings} />

      {result.summary?.length ? (
        <div className="rounded-xl border border-primary/15 bg-primary/[0.035] px-3 py-2.5">
          <p className="mb-1 text-[11px] font-semibold tracking-wide text-primary">处理摘要</p>
          <AgentSummary key={result.summary.join('\n')} text={result.summary.join('\n')} />
        </div>
      ) : null}

      {result.kind !== 'error' && result.reasoning.length > 0 ? (
        <div className="rounded-md border border-border bg-muted/30 px-3 py-2">
          <p className="text-xs font-medium text-foreground">结果说明</p>
          <ul className="mt-1 space-y-1">
            {result.reasoning.map((item,index)=>(
              <li key={index} className="text-xs text-muted-foreground">· {translateSystemText(item)}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {result.kind === 'error' && result.reasoning.length > 0 ? (
        <p role="alert" className="whitespace-pre-wrap text-xs text-destructive">
          {result.reasoning.map(translateSystemText).join('\n')}
        </p>
      ) : null}

      {result.blocks.map((block, index) => {
        if (block.type === 'task_candidates') {
          return (
            <div key={index} className="space-y-1.5 rounded-md border border-border bg-card p-2.5">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {block.title}
              </p>
              {block.candidates.map((candidate) => (
                <button
                  key={candidate.title}
                  type="button"
                  className="w-full rounded-md border border-border bg-background px-2.5 py-2 text-left hover-elevate active-elevate-2"
                  onClick={() => onSend(candidate.select_message, { task_id: candidate.task_id })}
                >
                  <span className="block text-xs font-medium text-foreground">{demoTitle(candidate.title)}</span>
                  <span className="mt-0.5 block text-[11px] text-muted-foreground">
                    {candidate.goal_title ? `目标：${demoTitle(candidate.goal_title ?? '')} · ` : ''}
                    状态：{STATUS_LABELS[candidate.status] ?? candidate.status}
                    {candidate.deadline ? ` · 截止 ${formatDeadline(candidate.deadline)}` : ''}
                  </span>
                </button>
              ))}
            </div>
          );
        }
        if (block.type === 'goal_candidates') {
          return (
            <div key={index} className="space-y-1.5 rounded-md border border-border bg-card p-2.5">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {block.title}
              </p>
              {block.candidates.map((candidate) => (
                <button
                  key={candidate.title}
                  type="button"
                  className="w-full rounded-md border border-border bg-background px-2.5 py-2 text-left hover-elevate active-elevate-2"
                  onClick={() => onSend(candidate.select_message, { goal_id: candidate.goal_id })}
                >
                  <span className="block text-xs font-medium text-foreground">{demoTitle(candidate.title)}</span>
                  <span className="mt-0.5 block text-[11px] text-muted-foreground">
                    状态：{GOAL_STATUS_LABELS[candidate.status] ?? candidate.status}
                    {candidate.target_date ? ` · 目标日期 ${formatDeadline(candidate.target_date)}` : ''}
                  </span>
                </button>
              ))}
            </div>
          );
        }
        if (block.type === 'decomposition_preview') {
          return (
            <DecompositionPreviewBlock
              key={index}
              drafts={block.preview.drafts}
              notes={block.preview.notes}
              disabled={pendingDisabled}
              busy={confirming}
              onConfirm={(drafts) => token && onConfirm(token, drafts)}
              onCancel={() => token && onCancel(token)}
            />
          );
        }
        return (
          <div key={index} className="rounded-md border border-border bg-card p-2.5">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {agentBlockTitle(block.title)}
            </p>
            {block.type === 'facts' ? (
              <dl className="mt-1.5 space-y-1">
                {block.items.map((item) => (
                  <div key={item.label} className="flex justify-between gap-3 text-xs">
                    <dt className="text-muted-foreground">{agentFactLabel(item.label)}</dt>
                    <dd className="text-right font-medium text-foreground">{demoTitle(agentFactValue(item.label, item.value))}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
            {block.type === 'list' ? (
              <ul className="mt-1.5 space-y-1">
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex} className="whitespace-pre-line text-xs text-muted-foreground">
                    · {translateSystemText(item)}
                  </li>
                ))}
              </ul>
            ) : null}
            {block.type === 'tasks' ? (
              <p className="mt-1.5 text-xs text-muted-foreground">
                共 {block.task_ids.length} 个关联任务，可在工作队列中查看详情。
              </p>
            ) : null}
            {block.type === 'score' ? (
              <ScoreBreakdownPanel breakdown={block.breakdown} className="mt-2" />
            ) : null}
          </div>
        );
      })}

      {result.pending_action && !result.blocks.some((b) => b.type === 'decomposition_preview') ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-2.5">
          <p className="text-xs font-medium text-amber-900">目前尚未写入任何数据</p>
          <p className="mt-1 text-xs text-amber-800">
            {translateSystemText(result.pending_action.summary)}
          </p>
          {pendingDisabled ? (
            <p className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
              <X className="size-3" />
              已处理，按钮已失效。
            </p>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="mt-2"
              disabled={confirming}
              onClick={() => onConfirm(result.pending_action!.token)}
            >
              {confirming ? '执行中…' : '确认并执行'}
            </Button>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** The dismissal is shared across conversations, settings and future replies in this browser. */
export function AgentWarnings({warnings}: {warnings?: AgentResult['warnings']}) {
  const {dismissed, dismiss} = useAgentWarningPreferences();
  const visible = (warnings ?? []).filter(warning => !dismissed.has(warning.code));
  if (!visible.length) return null;
  return <ul className="space-y-1 rounded-md border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-900">
    {visible.map(warning => <li key={warning.code} className="flex items-start gap-2">
      <span className="min-w-0 flex-1">{warning.message}</span>
      {warning.code === 'model_config_warning' ? <Button type="button" variant="ghost" size="icon"
        className="size-7 shrink-0 text-amber-900" aria-label="不再显示模型配置提示" title="关闭后不再提示"
        onClick={() => dismiss(warning.code)}><X className="size-3.5" /></Button> : null}
    </li>)}
  </ul>;
}
