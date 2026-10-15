/**
 * 目标详情面板：关联任务、进度，以及 Agent 优先的任务草稿流程。
 *
 * 助手启用时在后台生成任务预览并在当前目标页展示；未启用时使用本地
 * `previewDecomposition` 草稿。两种路径都要由用户确认后才会真正创建。
 *
 * 关联任务列表上方给出按状态 / 任务类型 / 象限的分类统计（始终基于未筛选的全量
 * 任务，所以它是一组稳定的参照数），下面三个紧凑下拉可任意组合地收窄列表，选中的
 * 条件再以可逐个移除的 chips 回显——下拉只负责"选"，chips 负责"现在筛着什么、怎么
 * 撤掉其中一条"。分类、过滤与"哪些维度在生效"都在 `@shared/goal-task-filter` 里以
 * 纯函数实现，这里只负责渲染与中文映射。
 *
 * 目标日期走 `GoalDateField`（Popover + Calendar），墙钟日期 ↔ UTC ISO 的换算交给
 * `@shared/datetime`，不再 `new Date(字符串)` / `.slice(0, 10)` 硬切。
 */
import { useRef, useState } from 'react';
import type {
  AgentResult,
  DecompositionDraft,
  DecompositionPreview,
  GoalStatus,
  GoalWithProgress,
  Task,
  TaskAction,
} from '@shared/types';
import { TASK_STATUSES, TASK_TYPES, QUADRANTS } from '@shared/types';
import { defaultDraftSelection } from '@shared/decomposition';
import { isoToWallDate, wallDateToIso } from '@shared/datetime';
import {
  Archive,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Filter,
  ListChecks,
  Pencil,
  RotateCcw,
  Sparkles,
  Target,
  X,
} from 'lucide-react';
import {
  DEFAULT_GOAL_TASK_FILTERS,
  GOAL_FILTER_ALL,
  GOAL_QUADRANT_FILTER_UNSCORED,
  describeActiveGoalTaskFilters,
  filterGoalTasks,
  goalTaskBreakdown,
  hasActiveGoalTaskFilters,
  type GoalQuadrantFilter,
  type GoalStatusFilter,
  type GoalTaskFilters,
  type GoalTypeFilter,
} from '@shared/goal-task-filter';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import { GoalDateField } from '@/components/GoalDateField';
import { TaskCard } from '@/components/TaskCard';
import { TaskDetailDrawer } from '@/components/TaskDetailDrawer';
import { DeleteEntityButton } from '@/components/DeleteEntityButton';
import { AgentResultView } from '@/components/AgentResultView';
import { ErrorState, LoadingRows, WriteError } from '@/components/states';
import { useResource, useMutation } from '@/hooks/use-resource';
import { useTaskActions } from '@/hooks/use-task-actions';
import { api } from '@/lib/api';
import { useAgentConversation } from '@/hooks/use-agent-conversation';
import { getRuntimeStatus } from '@/lib/agent-runtime-client';
import { buildGoalDraftMessage } from '@/lib/goal-draft-request';
import {
  GOAL_STATUS_LABELS,
  QUADRANT_TITLES,
  STATUS_LABELS,
  TASK_TYPE_LABELS,
  demoText,
  formatDeadline,
  formatMinutes,
  percent,
  translateSystemText,
} from '@/lib/format';
import { availableActionsFor } from '@/lib/actions';

/** 用户在预览里确认的草稿：按下标定位，标题与描述是用户最终认可的文本。 */
interface DraftOverride {
  index: number;
  title: string;
  description: string | null;
}

function DraftPreview({
  preview,
  onConfirm,
  onCancel,
  pending,
}: {
  preview: DecompositionPreview;
  onConfirm: (overrides: DraftOverride[]) => void;
  onCancel: () => void;
  pending: boolean;
}) {
  /**
   * 预览持有草稿的唯一可编辑副本：标题和描述都能改，确认时按下标回传，
   * 所以「改过的草稿」和「原始草稿」不会出现两份不一致的数据。
   */
  const [editable, setEditable] = useState<DecompositionDraft[]>(() =>
    preview.drafts.map((d) => ({ ...d })),
  );
  /**
   * 默认勾选所有**非重复**草稿（UX-22）。
   *
   * 疑似重复的默认不勾——重复建任务比漏建更难收拾，但仍留着让用户手动勾回。
   * 按位置记录，标题改了也不会丢。
   */
  const [selected, setSelected] = useState<boolean[]>(() =>
    defaultDraftSelection(preview.drafts),
  );
  /**
   * 展开了「依据/置信度」的草稿下标。默认全折叠——理由与信号是复查时才需要的
   * 细节，常显会把真正要读的标题挤走。
   */
  const [explained, setExplained] = useState<Set<number>>(() => new Set());

  const toggle = (index: number) =>
    setSelected((current) => current.map((on, i) => (i === index ? !on : on)));

  const toggleExplained = (index: number) =>
    setExplained((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });

  const patch = (index: number, fields: Partial<DecompositionDraft>) =>
    setEditable((current) =>
      current.map((draft, i) => (i === index ? { ...draft, ...fields } : draft)),
    );

  const chosen = selected.filter(Boolean).length;

  const confirm = () =>
    onConfirm(
      selected
        .map((on, i) =>
          on
            ? {
                index: i,
                title: editable[i].title.trim(),
                description: editable[i].description?.trim() || null,
              }
            : null,
        )
        .filter((override): override is DraftOverride => override !== null),
    );

  return (
    <div className="space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h4 className="text-sm font-medium">任务草稿——尚未写入任何数据</h4>
          <p className="text-xs text-muted-foreground">
            勾选要创建的草稿，标题和描述都可以直接改，然后确认。疑似重复的默认不勾。
          </p>
        </div>
        <Button size="icon" variant="ghost" className="shrink-0" onClick={onCancel}>
          <X />
          <span className="sr-only">丢弃草稿</span>
        </Button>
      </div>

      <ul className="space-y-2">
        {editable.map((draft, index) => (
          <li
            key={index}
            className="flex items-start gap-2.5 rounded-md border border-border bg-card p-2.5"
          >
            <Checkbox
              id={`draft-${index}`}
              checked={selected[index]}
              onCheckedChange={() => toggle(index)}
              className="mt-0.5"
              aria-label={`选择第 ${index + 1} 个草稿`}
            />
            <div className="min-w-0 flex-1 space-y-1.5">
              <Input
                id={`draft-title-${index}`}
                value={draft.title}
                onChange={(event) => patch(index, { title: event.target.value })}
                className="h-8 bg-card! text-sm font-medium disabled:bg-muted! read-only:bg-muted!"
                aria-label={`第 ${index + 1} 个草稿的标题`}
              />
              <Textarea
                id={`draft-description-${index}`}
                value={draft.description ?? ''}
                onChange={(event) => patch(index, { description: event.target.value })}
                className="min-h-14 bg-card! text-xs disabled:bg-muted! read-only:bg-muted!"
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
                  <span className="text-xs text-muted-foreground">
                    {formatDeadline(draft.deadline)}
                  </span>
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
                {/* 理由与置信度默认折叠，需要复查时才展开。 */}
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-6 px-1.5 text-xs text-muted-foreground"
                  onClick={() => toggleExplained(index)}
                  aria-expanded={explained.has(index)}
                  aria-controls={`draft-reason-${index}`}
                >
                  {explained.has(index) ? <ChevronUp /> : <ChevronDown />}
                  依据/置信度
                </Button>
              </div>

              {explained.has(index) ? (
                <div
                  id={`draft-reason-${index}`}
                  className="space-y-1 rounded-md border border-border bg-muted/30 p-2"
                >
                  <p className="text-xs text-muted-foreground">
                    {translateSystemText(draft.suggestion.reason)}
                  </p>
                  {draft.suggestion.signals.length > 0 ? (
                    <ul className="space-y-0.5">
                      {draft.suggestion.signals.map((signal, i) => (
                        <li key={`${index}-${i}`} className="text-xs text-muted-foreground">
                          · {translateSystemText(signal)}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <p className="text-xs tabular-nums text-muted-foreground">
                    置信度 {Math.round(draft.suggestion.confidence * 100)}%
                  </p>
                  {draft.duplicate ? (
                    <p className="text-xs text-amber-700">{draft.duplicate.reason}</p>
                  ) : null}
                </div>
              ) : null}
            </div>
          </li>
        ))}
      </ul>

      <ul className="space-y-0.5">
        {preview.notes.map((note) => (
          <li key={note} className="text-xs text-muted-foreground">
            · {translateSystemText(note)}
          </li>
        ))}
      </ul>

      <div className="flex items-center gap-2">
        <Button size="sm" disabled={chosen === 0 || pending} onClick={confirm}>
          {pending ? '创建中…' : `创建 ${chosen} 个任务`}
        </Button>
        <Button size="sm" variant="outline" onClick={onCancel} disabled={pending}>
          丢弃
        </Button>
        {/* 全是疑似重复时一条都没勾，按钮会是禁用态——说清这不是卡住了。 */}
        {editable.length > 0 && chosen === 0 ? (
          <span className="text-xs text-muted-foreground">
            草稿都疑似重复，默认未勾选；确实要建的话勾上即可。
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** 象限筛选里多出来的一档：两轴评分缺失或超范围的任务。 */
const UNSCORED_LABEL = '待评分';

/** 任务类型筛选里多出来的一档：没填类型的任务。 */
const NO_TYPE_LABEL = '未指定类型';

const quadrantBucketLabel = (key: string): string =>
  key === GOAL_QUADRANT_FILTER_UNSCORED ? UNSCORED_LABEL : (QUADRANT_TITLES[key] ?? key);

const typeBucketLabel = (key: string): string =>
  key === 'none' ? NO_TYPE_LABEL : (TASK_TYPE_LABELS[key] ?? key);

/**
 * 三个筛选维度的中文名。
 *
 * 用「状态 / 类型 / 象限」而不是「任务类型」这类全称：三个触发器要并排挤在同一行，
 * 和上方分类统计的「按状态 / 按类型 / 按象限」也正好对得上。
 */
const FILTER_DIMENSION_LABELS: Record<'status' | 'type' | 'quadrant', string> = {
  status: '状态',
  type: '类型',
  quadrant: '象限',
};

/** 把某个维度的筛选值映射成中文；`all` 统一显示成「全部」。 */
function filterValueLabel(dimension: 'status' | 'type' | 'quadrant', value: string): string {
  if (value === GOAL_FILTER_ALL) return '全部';
  if (dimension === 'status') return STATUS_LABELS[value] ?? value;
  if (dimension === 'type') return typeBucketLabel(value);
  return quadrantBucketLabel(value);
}

/**
 * 一个紧凑的筛选下拉：触发器本身就是当前选中值（"状态：进行中"），省掉独立 Label。
 *
 * 选项与取值跟原来的 NativeSelect 完全一致，只是换了个呈现方式——所以筛选语义没有
 * 任何变化，仍旧是三个维度求交集。
 */
function FilterMenu({
  dimension,
  value,
  options,
  onSelect,
}: {
  dimension: 'status' | 'type' | 'quadrant';
  value: string;
  /** 候选值，第一项固定是 `GOAL_FILTER_ALL`。 */
  options: string[];
  onSelect: (value: string) => void;
}) {
  const name = FILTER_DIMENSION_LABELS[dimension];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline" className="h-8 font-normal">
          <span className="text-muted-foreground">{name}：</span>
          {filterValueLabel(dimension, value)}
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {options.map((option) => (
          <DropdownMenuItem
            key={option}
            // 选中项不禁用：禁用项无法聚焦，键盘用户就读不到"现在选的是哪个"。
            onSelect={() => onSelect(option)}
          >
            {option === value ? (
              <CheckCircle2 className="size-3.5 text-primary" />
            ) : (
              <span className="size-3.5" aria-hidden />
            )}
            {filterValueLabel(dimension, option)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * 一组分类统计。
 *
 * 只渲染真实出现过的分类（空桶由 `goalTaskBreakdown` 过滤掉），所以这一行永远
 * 是"这个目标实际有什么"，而不是把六种状态全列一遍。
 */
function CountRow({
  label,
  counts,
  labelFor,
}: {
  label: string;
  counts: { key: string; count: number }[];
  labelFor: (key: string) => string;
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      {counts.length === 0 ? (
        <span className="text-xs text-muted-foreground">—</span>
      ) : (
        counts.map(({ key, count }) => (
          <Badge
            key={key}
            variant="outline"
            className="font-normal tabular-nums text-muted-foreground"
          >
            {labelFor(key)} {count}
          </Badge>
        ))
      )}
    </div>
  );
}

export function GoalDetailPanel({
  goal,
  open,
  onOpenChange,
}: {
  goal: GoalWithProgress | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [preview, setPreview] = useState<DecompositionPreview | null>(null);
  const [agentDraftResult, setAgentDraftResult] = useState<AgentResult | null>(null);
  const [preparingDraft, setPreparingDraft] = useState(false);
  const [planningError, setPlanningError] = useState<string | null>(null);
  const preparingRef = useRef(false);
  const conversation = useAgentConversation();
  const goalId = goal?.id ?? null;
  /** 三入口共用的任务详情抽屉。 */
  const [detailTaskId, setDetailTaskId] = useState<string | null>(null);
  /** 目标自身的编辑态：标题 / 说明 / 目标日期。 */
  const [editingGoal, setEditingGoal] = useState(false);
  const [goalDraft, setGoalDraft] = useState({ title: '', description: '', targetDate: '' });

  /**
   * 筛选状态连同它所属的目标 id 一起存。
   *
   * 换目标时不去 effect 里重置，而是直接忽略属于上一个目标的选择——渲染期就能
   * 得到正确结果，不会出现"先按旧条件筛一帧再跳回全部"的闪动。
   */
  const [selection, setSelection] = useState<GoalTaskFilters & { goalId: string | null }>({
    ...DEFAULT_GOAL_TASK_FILTERS,
    goalId,
  });
  const active: GoalTaskFilters =
    selection.goalId === goalId ? selection : DEFAULT_GOAL_TASK_FILTERS;

  const setFilters = (patch: Partial<GoalTaskFilters>) =>
    setSelection({ ...active, ...patch, goalId });
  const resetFilters = () => setSelection({ ...DEFAULT_GOAL_TASK_FILTERS, goalId });

  // `goalId` 进 scope：换目标时 `detail.current` 立刻变 false，不会把上一个目标
  // 的任务当成这一个的。
  const detail = useResource(
    ['goals', 'tasks', 'queue'],
    () => (goalId ? api.getGoal(goalId) : Promise.resolve(null)),
    [goalId],
  );
  const draft = useMutation(['goals', 'tasks', 'queue', 'activity']);
  const goalWrite = useMutation(['goals', 'tasks', 'queue', 'activity']);
  const { handlers, pendingLabelFor, error, clearError, blockDialog } = useTaskActions();

  // 以最新返回的目标为准（写操作会触发重取），保证 expected_version 不过期。
  const currentGoal = detail.data?.goal ?? goal;

  const startEditGoal = () => {
    if (!currentGoal) return;
    setGoalDraft({
      title: currentGoal.title,
      description: currentGoal.description ?? '',
      // 库里是 UTC 瞬间，编辑态要的是用户时区的墙钟日历日——两者在非 UTC 时区差一天。
      targetDate: currentGoal.target_date ? isoToWallDate(currentGoal.target_date) : '',
    });
    setEditingGoal(true);
  };

  const saveGoalEdit = async () => {
    if (!currentGoal) return;
    const body: Record<string, unknown> = { expected_version: currentGoal.version };
    const title = goalDraft.title.trim();
    if (title && title !== currentGoal.title) body.title = title;
    const description = goalDraft.description.trim();
    if (description !== (currentGoal.description ?? '')) body.description = description || null;
    const targetDate = goalDraft.targetDate ? wallDateToIso(goalDraft.targetDate) : null;
    if ((targetDate ?? null) !== (currentGoal.target_date ?? null)) body.target_date = targetDate;
    if (Object.keys(body).length === 1) {
      setEditingGoal(false);
      return;
    }
    const result = await goalWrite.run('goal-edit', () =>
      api.updateGoal(currentGoal.id, body as Parameters<typeof api.updateGoal>[1]),
    );
    if (result) setEditingGoal(false);
  };

  const setGoalStatus = async (status: GoalStatus) => {
    if (!currentGoal) return;
    await goalWrite.run('goal-status', () =>
      api.updateGoal(currentGoal.id, { status, expected_version: currentGoal.version }),
    );
  };

  const requestPreview = async () => {
    if (!goalId || !currentGoal || currentGoal.id !== goalId || preparingRef.current) return;
    preparingRef.current = true;
    setPreparingDraft(true);
    setPlanningError(null);
    setPreview(null);
    setAgentDraftResult(null);
    const selectedGoal = currentGoal;
    try {
      // Read current enablement at click time. An enabled but unhealthy Agent
      // must report its error here rather than silently use a rule template.
      const runtime = await getRuntimeStatus();
      if (runtime.enabled) {
        const accepted = await conversation.send(
          buildGoalDraftMessage(selectedGoal),
          { goal_id: selectedGoal.id },
          'agent',
          undefined,
          {
            preserveInput: true,
            fromShortcut: true,
            intent: 'goal_task_drafts',
            onReply: reply => {
              setAgentDraftResult(reply.result);
            },
            onError: cause => setPlanningError(cause instanceof Error ? cause.message : 'Agent 生成任务草稿失败，请重试。'),
          },
        );
        if (accepted === false) setPlanningError('助手正在处理其他操作，请完成后再生成任务草稿。');
        return;
      }
      const result = await draft.run('preview', () => api.previewDecomposition(selectedGoal.id));
      if (result) setPreview(result.preview);
    } catch (cause) {
      setPlanningError(cause instanceof Error ? cause.message : '暂时无法生成任务草稿，请重试。');
    } finally {
      preparingRef.current = false;
      setPreparingDraft(false);
    }
  };

  const confirmPreview = async (overrides: DraftOverride[]) => {
    if (!goalId || !preview) return;
    const created = await draft.run('confirm', () =>
      api.confirmDecomposition(goalId, preview.preview_token, overrides),
    );
    if (created) setPreview(null);
  };

  const confirmAgentDraft = async (token: string, drafts?: DraftOverride[]) => {
    if (await conversation.confirm(token, drafts)) setAgentDraftResult(null);
  };

  const cancelAgentDraft = async (token: string) => {
    if (await conversation.cancel(token)) setAgentDraftResult(null);
  };

  // 残留的 preview token 属于上一个打开的目标，必须清掉。
  const close = (next: boolean) => {
    if (!next) { setPreview(null); setAgentDraftResult(null); }
    onOpenChange(next);
  };

  const tasks = (detail.data?.tasks ?? []) as (Task & { available_actions?: TaskAction[] })[];
  const progress = detail.data?.goal.progress ?? goal?.progress;

  // 统计基于全量任务，过滤结果单独算——所以上面的分类数不会跟着筛选一起变。
  // 两者都是便宜的纯函数（一次遍历），交给 React Compiler 处理即可。
  const breakdown = goalTaskBreakdown(tasks);
  const filtered = filterGoalTasks(tasks, active);
  // 「有筛选在生效」而不是「筛掉了东西」：某状态恰好匹配全部时也该能清除。
  const narrowed = hasActiveGoalTaskFilters(active);
  // 非「全部」的维度，逐个渲染成可移除的 chip。
  const activeChips = describeActiveGoalTaskFilters(active);

  return (
    <Sheet open={open} onOpenChange={close}>
      <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-xl">
        <SheetHeader className="shrink-0 border-b border-border px-4 py-3 text-left">
          <SheetTitle className="flex items-center gap-2 text-sm">
            <Target className="size-4 shrink-0 text-primary" />
            <span className="min-w-0 truncate">
              {goal ? demoText(goal.title, goal.is_demo) : '目标'}
            </span>
          </SheetTitle>
        </SheetHeader>

        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-4 p-4">
            {/* 目标自身：可编辑标题/说明/目标日期，以及完成/重新打开/归档。 */}
            {currentGoal ? (
              <div className="space-y-2 rounded-lg border border-border bg-muted/20 p-3">
                {editingGoal ? (
                  <div className="space-y-2">
                    <div className="space-y-1">
                      <Label htmlFor="goal-edit-title" className="text-xs font-normal">标题</Label>
                      <Input
                        id="goal-edit-title"
                        value={goalDraft.title}
                        onChange={(event) => setGoalDraft((g) => ({ ...g, title: event.target.value }))}
                        className="bg-card! disabled:bg-muted! read-only:bg-muted!"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="goal-edit-description" className="text-xs font-normal">说明</Label>
                      <Textarea
                        id="goal-edit-description"
                        rows={2}
                        value={goalDraft.description}
                        onChange={(event) =>
                          setGoalDraft((g) => ({ ...g, description: event.target.value }))
                        }
                        className="bg-card! disabled:bg-muted! read-only:bg-muted!"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="goal-edit-date" className="text-xs font-normal">目标日期</Label>
                      <GoalDateField
                        id="goal-edit-date"
                        value={goalDraft.targetDate}
                        onChange={(targetDate) => setGoalDraft((g) => ({ ...g, targetDate }))}
                      />
                    </div>
                    <div className="flex justify-end gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={goalWrite.pending !== null}
                        onClick={() => setEditingGoal(false)}
                      >
                        取消
                      </Button>
                      <Button
                        size="sm"
                        disabled={!goalDraft.title.trim() || goalWrite.pending !== null}
                        onClick={() => void saveGoalEdit()}
                      >
                        {goalWrite.pending === 'goal-edit' ? '保存中…' : '保存目标'}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="flex items-start justify-between gap-2">
                      <p className="min-w-0 flex-1 text-sm text-muted-foreground">
                        {currentGoal.description
                          ? demoText(currentGoal.description, currentGoal.is_demo)
                          : '这个目标还没有说明。'}
                      </p>
                      <Badge variant="outline" className="shrink-0 font-normal">
                        {GOAL_STATUS_LABELS[currentGoal.status]}
                      </Badge>
                    </div>
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      <Button size="sm" variant="outline" onClick={startEditGoal}>
                        <Pencil />
                        编辑目标
                      </Button>
                      <DeleteEntityButton
                        kind="goal"
                        entity={currentGoal}
                        disabled={!detail.current || goalWrite.pending !== null || draft.pending !== null || preparingDraft || conversation.sending || conversation.confirming}
                        onDeleted={() => close(false)}
                      />
                      {currentGoal.status === 'active' ? (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={goalWrite.pending !== null}
                            onClick={() => void setGoalStatus('achieved')}
                          >
                            <CheckCircle2 />
                            标记达成
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={goalWrite.pending !== null}
                            onClick={() => void setGoalStatus('dropped')}
                          >
                            <Archive />
                            归档
                          </Button>
                        </>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={goalWrite.pending !== null}
                          onClick={() => void setGoalStatus('active')}
                        >
                          <RotateCcw />
                          重新打开
                        </Button>
                      )}
                    </div>
                  </>
                )}
              </div>
            ) : null}

            {progress ? (
              <div className="space-y-2 rounded-lg border border-border bg-muted/20 p-3">
                <div className="flex items-baseline justify-between text-xs">
                  <span className="font-medium">
                    已完成 {progress.completed}/{progress.total} 个任务
                  </span>
                  <span className="tabular-nums text-muted-foreground">
                    {percent(progress.ratio)}%
                  </span>
                </div>
                <Progress value={percent(progress.ratio)} />
                <div className="flex flex-wrap gap-1.5">
                  <Badge variant="outline" className="font-normal text-muted-foreground">
                    已领取/进行中 {progress.in_flight}
                  </Badge>
                  <Badge variant="outline" className="font-normal text-muted-foreground">
                    未开始 {progress.open}
                  </Badge>
                  <Badge variant="outline" className="font-normal">受阻 {progress.blocked ?? 0}</Badge>
                  {goal?.target_date ? (
                    <Badge variant="outline" className="font-normal text-muted-foreground">
                      {formatDeadline(goal.target_date)}
                    </Badge>
                  ) : null}
                </div>
                {/* 完成率不自动等同达成：100% 只提示，仍由你手动标记。 */}
                {progress.total > 0 && progress.ratio >= 1 ? (
                  <Alert className="border-primary/30 bg-primary/5 text-primary">
                    <CheckCircle2 className="size-4" />
                    <AlertTitle>任务已全部完成</AlertTitle>
                    <AlertDescription>
                      完成率到 100% 不代表目标自动达成——是否达成由你判断。确认后可点上方「标记达成」。
                    </AlertDescription>
                  </Alert>
                ) : null}
              </div>
            ) : null}

            {goalWrite.error ? (
              <WriteError message={goalWrite.error} onDismiss={goalWrite.clearError} />
            ) : null}

            {planningError ? (
              <WriteError message={planningError} onDismiss={() => setPlanningError(null)} />
            ) : null}
            {draft.error ? (
              <WriteError message={draft.error} onDismiss={draft.clearError} />
            ) : null}
            {error ? <WriteError message={error} onDismiss={clearError} /> : null}
            {blockDialog}

            {agentDraftResult ? (
              <AgentResultView
                result={agentDraftResult}
                onConfirm={(token, drafts) => void confirmAgentDraft(token, drafts)}
                onCancel={token => void cancelAgentDraft(token)}
                onSend={(text, target) => void conversation.send(text, target)}
                confirming={conversation.confirming}
                disabledTokens={conversation.disabledTokens}
              />
            ) : preview ? (
              <DraftPreview
                preview={preview}
                onConfirm={(overrides) => void confirmPreview(overrides)}
                onCancel={() => setPreview(null)}
                pending={draft.pending === 'confirm'}
              />
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={!detail.current || preparingDraft || draft.pending !== null || conversation.sending || conversation.confirming || conversation.sessionLoading || editingGoal}
                onClick={() => void requestPreview()}
              >
                <Sparkles />
                {preparingDraft || draft.pending === 'preview' ? '正在后台生成任务草稿…' : '为这个目标拟任务草稿'}
              </Button>
            )}

            <Separator />

            <div>
              <h4 className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <ListChecks className="size-3.5" />
                关联任务（{breakdown.total}）
              </h4>
              {/* 四路互斥：数据还不属于当前目标时只显示骨架，不显示空状态。 */}
              {!detail.current ? (
                <LoadingRows rows={2} />
              ) : detail.error ? (
                <ErrorState message={detail.error} onRetry={detail.refetch} />
              ) : breakdown.total === 0 ? (
                <p className="rounded-md border border-dashed border-border bg-muted/20 px-3 py-4 text-center text-xs text-muted-foreground">
                  尚未添加任务。可以在上方拟草稿，或者新建任务时选择这个目标。
                </p>
              ) : (
                <div className="space-y-3">
                  {/* 分类统计：始终基于全量任务，不随下面的筛选变化。 */}
                  <div className="space-y-1.5 rounded-lg border border-border bg-muted/20 p-3">
                    <CountRow
                      label="按状态"
                      counts={breakdown.byStatus}
                      labelFor={(key) => STATUS_LABELS[key] ?? key}
                    />
                    <CountRow label="按类型" counts={breakdown.byType} labelFor={typeBucketLabel} />
                    <CountRow
                      label="按象限"
                      counts={breakdown.byQuadrant}
                      labelFor={quadrantBucketLabel}
                    />
                  </div>

                  {/* 三个筛选条件之间是「与」的关系，可任意组合。 */}
                  <div className="space-y-2 rounded-lg border border-border p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Filter className="size-3.5" />
                        筛选（可组合）
                      </span>
                      <span className="flex items-center gap-2">
                        <span className="text-xs tabular-nums text-muted-foreground">
                          当前 {filtered.matched} / 共 {filtered.total}
                        </span>
                        {narrowed ? (
                          <Button size="sm" variant="ghost" onClick={resetFilters}>
                            清除筛选
                          </Button>
                        ) : null}
                      </span>
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5">
                      <FilterMenu
                        dimension="status"
                        value={active.status}
                        options={[GOAL_FILTER_ALL, ...TASK_STATUSES]}
                        onSelect={(status) => setFilters({ status: status as GoalStatusFilter })}
                      />
                      <FilterMenu
                        dimension="type"
                        value={active.type}
                        options={[GOAL_FILTER_ALL, ...TASK_TYPES, 'none']}
                        onSelect={(type) => setFilters({ type: type as GoalTypeFilter })}
                      />
                      <FilterMenu
                        dimension="quadrant"
                        value={active.quadrant}
                        options={[GOAL_FILTER_ALL, ...QUADRANTS, GOAL_QUADRANT_FILTER_UNSCORED]}
                        onSelect={(quadrant) =>
                          setFilters({ quadrant: quadrant as GoalQuadrantFilter })
                        }
                      />
                    </div>

                    {/* 选中条件的 chips：X 只重置自己那一个维度，别的条件照旧生效。 */}
                    {activeChips.length > 0 ? (
                      <div className="flex flex-wrap items-center gap-1.5">
                        {activeChips.map(({ dimension, value }) => (
                          <Badge
                            key={dimension}
                            variant="outline"
                            className="gap-1 pr-1 font-normal text-muted-foreground"
                          >
                            {FILTER_DIMENSION_LABELS[dimension]}：
                            {filterValueLabel(dimension, value)}
                            <button
                              type="button"
                              aria-label={`移除${FILTER_DIMENSION_LABELS[dimension]}筛选`}
                              className="inline-flex size-4 items-center justify-center rounded-sm hover:bg-muted hover:text-foreground"
                              onClick={() => setFilters({ [dimension]: GOAL_FILTER_ALL })}
                            >
                              <X className="size-3" />
                            </button>
                          </Badge>
                        ))}
                      </div>
                    ) : null}
                  </div>

                  {filtered.emptyBecauseFiltered ? (
                    <div className="rounded-md border border-dashed border-border bg-muted/20 px-3 py-4 text-xs text-muted-foreground">
                      <p>当前筛选条件下没有匹配的任务。</p>
                      <Button size="sm" variant="outline" className="mt-2" onClick={resetFilters}>
                        清除筛选
                      </Button>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {filtered.tasks.map((task) => (
                        <TaskCard
                          key={task.id}
                          task={task}
                          availableActions={
                            task.available_actions ?? availableActionsFor(task.status)
                          }
                          pendingLabel={pendingLabelFor(task.id)}
                          compact
                          onOpenDetail={setDetailTaskId}
                          {...handlers}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </ScrollArea>
      </SheetContent>
      {/* 嵌套在目标抽屉之上的任务详情抽屉。 */}
      <TaskDetailDrawer taskId={detailTaskId} onOpenChange={() => setDetailTaskId(null)} />
    </Sheet>
  );
}
