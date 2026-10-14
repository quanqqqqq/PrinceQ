/**
 * `/activity` — 面向用户的动态时间线（UX-19）。
 *
 * 不再直接把审计表原样铺开：
 * - 每条只显示「一个动作 + 对象 + 时间」，点动作即可打开对应的任务 / 目标
 *   （含已完成、已归档对象——详情接口不按状态过滤）；
 * - 展开分两层：「变更详情」说人话（改了哪个字段、从什么变成什么、谁在什么时候改的、
 *   成没成），「开发者信息」才是幂等键、原始事件码、对象 / 操作者 ID 与 detail JSON，
 *   默认再折一层——排查问题时才需要，日常回看不该挡路；
 * - 普通动态与队列重算 / 排序历史分开两个页签；
 * - 顶部可按任务 / 目标名搜索，按操作类型与日期范围过滤（参数全部交给 API
 *   做 zod 校验与参数化 SQL，前端只是把它们拼进 querystring）。
 */
import { useMemo, useState } from 'react';
import {
  Activity,
  CheckCircle2,
  ChevronDown,
  RefreshCw,
  Repeat,
  XCircle,
} from 'lucide-react';
import type { OperationRecord, QueueSnapshot } from '@shared/types';
import {
  activityTarget,
  buildActivityQuery,
  describeOperationChange,
  describeQueueSnapshot,
  groupOperationsByDay,
  splitOperations,
  type ActivityFilters,
  type ChangeField,
} from '@shared/activity';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { GoalDateField } from '@/components/GoalDateField';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EmptyState, ErrorState, LoadingRows } from '@/components/states';
import { useResource } from '@/hooks/use-resource';
import { GoalDetailPanel } from '@/components/GoalDetailPanel';
import { TaskDetailDrawer } from '@/components/TaskDetailDrawer';
import { api } from '@/lib/api';
import {
  actorDisplayName,
  formatLocalDateSafe,
  formatRelative,
  formatTimestamp,
  operationSummaryText,
  targetTypeLabel,
} from '@/lib/format';

/**
 * 操作类型筛选桶：值直接拼成 API 的 `type`（逗号分隔的 operation_type 白名单）。
 * 桶是粗分类，覆盖用户最常回看的几类动作。
 */
const TYPE_FILTERS: { value: string; label: string }[] = [
  { value: '', label: '全部类型' },
  { value: 'task.create', label: '创建任务' },
  {
    value: 'task.claim,task.start,task.complete,task.archive,task.restore,task.reopen,task.block,task.release',
    label: '任务流转 / 完成归档',
  },
  {
    value: 'task.update,task.dependency.add,task.quadrant.confirm,task.quadrant.change,task.quadrant.resuggest,task.matrix.score',
    label: '任务整理 / 评分',
  },
  {
    value: 'goal.create,goal.update,goal.decomposition.confirm',
    label: '目标变更',
  },
  { value: 'habit.add,habit.enable,habit.disable,habit.weights.update', label: '习惯变更' },
];

function StatusIcon({ operation }: { operation: OperationRecord }) {
  if (operation.status === 'failed') {
    return <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" />;
  }
  return <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" />;
}

/**
 * 一行字段变更。
 *
 * 三种模板对应 `ChangeField` 的三种完整度：前后都有就画箭头；只有「修改后」就直接
 * 陈述新值（原因、评分这类本来没有旧值）；两边都空说明只知道「这个字段动过」
 * （`task.update` 的 detail 只记了键名），那就老实说"已修改"，不编一个旧值出来。
 */
function ChangeFieldRow({ field }: { field: ChangeField }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
      <span className="text-muted-foreground">{field.label}：</span>
      {field.before != null && field.after != null ? (
        <>
          <span className="line-through decoration-muted-foreground/60">{field.before}</span>
          <span aria-hidden className="text-muted-foreground">
            →
          </span>
          <span className="font-medium text-foreground">{field.after}</span>
        </>
      ) : field.after != null ? (
        <span className="font-medium text-foreground">{field.after}</span>
      ) : (
        <span className="text-foreground">已修改</span>
      )}
    </div>
  );
}

/** 单条动态：默认只有动作 + 对象 + 时间；变更详情与开发者信息各折一层。 */
function ActivityRow({
  operation,
  onOpenTarget,
}: {
  operation: OperationRecord;
  onOpenTarget: (operation: OperationRecord) => void;
}) {
  const target = activityTarget(operation);
  const clickable = target.kind !== 'none';
  const summary = operationSummaryText(operation.summary);
  // 业务字段的前后对照；认不出的 detail 返回空数组，这一层就只剩谁/何时/结果。
  const changes = describeOperationChange(operation);

  return (
    <li className="flex gap-3 rounded-lg border border-border bg-card p-3">
      <StatusIcon operation={operation} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-start justify-between gap-2">
          {clickable ? (
            <button
              type="button"
              onClick={() => onOpenTarget(operation)}
              className="text-left text-[13px] leading-5 font-medium text-foreground underline-offset-2 hover:underline"
              title="打开对应任务 / 目标"
            >
              {summary}
            </button>
          ) : (
            <p className="text-[13px] leading-5 font-medium text-foreground">{summary}</p>
          )}
          <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
            {formatRelative(operation.created_at)}
          </span>
        </div>

        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
          <span>{actorDisplayName(operation.actor_name)}</span>
          <span aria-hidden>·</span>
          <Badge variant="outline" className="font-normal text-muted-foreground">
            {targetTypeLabel(operation.target_type)}
          </Badge>
          {operation.status === 'failed' ? (
            <Badge variant="outline" className="border-destructive/30 font-normal text-destructive">
              失败
            </Badge>
          ) : null}
          {operation.replayed ? (
            <Badge variant="outline" className="border-primary/30 bg-primary/5 font-normal text-primary">
              <Repeat className="size-3" />
              已重放
            </Badge>
          ) : null}
        </div>

        {/* 第一层：业务层面的「这次改了什么」。 */}
        <Collapsible className="mt-2">
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px] text-muted-foreground">
              <ChevronDown className="size-3.5 transition-transform" />
              变更详情
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-1 space-y-1 rounded-md border border-border bg-muted/30 p-2 text-[11px]">
            {changes.map((field) => (
              <ChangeFieldRow key={field.key} field={field} />
            ))}
            <div className="flex flex-wrap items-baseline gap-x-1.5">
              <span className="text-muted-foreground">谁：</span>
              <span className="text-foreground">{actorDisplayName(operation.actor_name)}</span>
            </div>
            <div className="flex flex-wrap items-baseline gap-x-1.5">
              <span className="text-muted-foreground">何时：</span>
              <span className="text-foreground">{formatTimestamp(operation.created_at)}</span>
            </div>
            <div className="flex flex-wrap items-baseline gap-x-1.5">
              <span className="text-muted-foreground">结果：</span>
              <span className={operation.status === 'failed' ? 'text-destructive' : 'text-foreground'}>
                {operation.status === 'failed' ? '失败' : '成功'}
              </span>
            </div>

            {/* 第二层：排查用的原始字段，默认再折一层。 */}
            <Collapsible className="pt-1">
              <CollapsibleTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-1.5 text-[11px] text-muted-foreground"
                >
                  <ChevronDown className="size-3 transition-transform" />
                  开发者信息
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-1 space-y-1 rounded-md border border-border bg-background/60 p-2">
                <div className="flex justify-between gap-2">
                  <span className="text-muted-foreground">原始事件码</span>
                  <span className="font-mono">{operation.operation_type}</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-muted-foreground">幂等键</span>
                  <span className="break-all font-mono">{operation.idempotency_key}</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-muted-foreground">对象 ID</span>
                  <span className="font-mono">{operation.target_id ?? '—'}</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-muted-foreground">操作者 ID</span>
                  <span className="font-mono">{operation.actor_id}</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-muted-foreground">完整时间</span>
                  <span>{formatTimestamp(operation.created_at)}</span>
                </div>
                {operation.detail ? (
                  <pre className="max-h-40 overflow-auto rounded bg-background p-1.5 font-mono text-[10px] leading-relaxed">
                    {JSON.stringify(operation.detail, null, 2)}
                  </pre>
                ) : null}
              </CollapsibleContent>
            </Collapsible>
          </CollapsibleContent>
        </Collapsible>
      </div>
    </li>
  );
}

/**
 * 队列重算历史行：主标题固定是「排序说明」，正文一句中文说清为什么又排了一次
 * （reason 其实是事件码，详见 `describeQueueSnapshot`）；事件码、算法版本、快照 ID
 * 这些只在排查时才需要的字段收进「开发者信息」，默认折叠。
 */
function SnapshotRow({ snapshot }: { snapshot: QueueSnapshot }) {
  const note = describeQueueSnapshot(snapshot.reason);

  return (
    <li className="flex gap-3 rounded-lg border border-border bg-card p-3">
      <RefreshCw className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <p className="text-[13px] leading-5 font-medium text-foreground">排序说明</p>
          <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
            {formatRelative(snapshot.created_at)}
          </span>
        </div>
        <p className="mt-1 text-[11px] text-muted-foreground">
          {note.triggerLabel} · 已排序 {snapshot.entry_count} 个任务 · 更新于{' '}
          {formatTimestamp(snapshot.created_at)}
        </p>
        <Collapsible className="mt-2">
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px] text-muted-foreground">
              <ChevronDown className="size-3.5 transition-transform" />
              开发者信息
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-1 space-y-1 rounded-md border border-border bg-muted/30 p-2 text-[11px]">
            <div className="flex justify-between gap-2">
              <span className="text-muted-foreground">算法版本</span>
              <span className="font-mono">{snapshot.algorithm_version}</span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-muted-foreground">原因码</span>
              <span className="font-mono">{snapshot.reason}</span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-muted-foreground">快照 ID</span>
              <span className="font-mono">{snapshot.id}</span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-muted-foreground">完整时间</span>
              <span>{formatTimestamp(snapshot.created_at)}</span>
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>
    </li>
  );
}

export default function ActivityPage() {
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const [openGoalId, setOpenGoalId] = useState<string | null>(null);

  /** 日期输入按「本地整天」转成 ISO 边界，from 起、to 止。 */
  const filters: ActivityFilters = useMemo(() => {
    const applied: ActivityFilters = { limit: 200 };
    const needle = query.trim();
    if (needle) applied.query = needle;
    if (typeFilter) applied.type = typeFilter;
    if (from) applied.from = new Date(`${from}T00:00:00`).toISOString();
    if (to) applied.to = new Date(`${to}T23:59:59.999`).toISOString();
    return applied;
  }, [query, typeFilter, from, to]);

  // 把过滤条件序列化进 fetch scope：条件一变就带着新参数重新拉取。
  const scopeKey = buildActivityQuery(filters);
  const activity = useResource(['activity'], () => api.activity(filters), [scopeKey]);
  const goals = useResource(['goals'], () => api.listGoals(), []);

  if (activity.loading) return <LoadingRows rows={5} />;
  if (activity.error) return <ErrorState message={activity.error} onRetry={activity.refetch} />;
  if (!activity.data) return null;

  const { operations, snapshots } = activity.data;
  const { activities } = splitOperations(operations);
  const days = groupOperationsByDay(activities);

  const openGoal = openGoalId ? (goals.data?.goals.find((g) => g.id === openGoalId) ?? null) : null;

  const openTarget = (operation: OperationRecord) => {
    const target = activityTarget(operation);
    if (target.kind === 'task') setOpenTaskId(target.id);
    else if (target.kind === 'goal') setOpenGoalId(target.id);
  };

  const resetFilters = () => {
    setQuery('');
    setTypeFilter('');
    setFrom('');
    setTo('');
  };
  const hasFilters = Boolean(query.trim() || typeFilter || from || to);

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold tracking-tight">动态时间线</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            你和助手做过的每一个动作，按时间倒序排列；点一条可直接打开对应的任务或目标。
          </p>
        </div>
        <Button size="sm" variant="outline" disabled={activity.refreshing} onClick={activity.refetch}>
          <RefreshCw className={activity.refreshing ? 'animate-spin' : undefined} />
          刷新
        </Button>
      </header>

      {/* 过滤栏：搜索任务 / 目标 / 操作内容 + 操作类型 + 日期范围。 */}
      <div className="activity-filters flex flex-wrap items-end gap-3 rounded-lg border border-border bg-muted/20 p-3">
        <div className="min-w-[200px] flex-1">
          <Label htmlFor="activity-search" className="text-xs text-muted-foreground">
            搜索任务、目标或操作内容
          </Label>
          <Input
            id="activity-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索任务、目标或操作内容"
            className="bg-card! disabled:bg-muted! read-only:bg-muted!"
          />
        </div>
        <div>
          <Label htmlFor="activity-type" className="text-xs text-muted-foreground">
            操作类型
          </Label>
          <NativeSelect
            id="activity-type"
            value={typeFilter}
            onChange={(event) => setTypeFilter(event.target.value)}
            className="bg-card! disabled:bg-muted!"
          >
            {TYPE_FILTERS.map((option) => (
              <NativeSelectOption key={option.label} value={option.value}>
                {option.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className="min-w-40">
          <Label htmlFor="activity-from" className="text-xs text-muted-foreground">
            从
          </Label>
          <GoalDateField id="activity-from" label="开始日期" placeholder="选择开始日期" value={from} onChange={setFrom} />
        </div>
        <div className="min-w-40">
          <Label htmlFor="activity-to" className="text-xs text-muted-foreground">
            到
          </Label>
          <GoalDateField id="activity-to" label="结束日期" placeholder="选择结束日期" value={to} onChange={setTo} />
        </div>
        {hasFilters ? (
          <Button size="sm" variant="ghost" onClick={resetFilters}>
            清除过滤
          </Button>
        ) : null}
      </div>

      <Tabs defaultValue="activities">
        <TabsList>
          <TabsTrigger value="activities">
            动态
            <Badge variant="outline" className="ml-1.5 font-normal tabular-nums">
              {activities.length}
            </Badge>
          </TabsTrigger>
          <TabsTrigger value="recalc">
            队列重算
            <Badge variant="outline" className="ml-1.5 font-normal tabular-nums">
              {snapshots.length}
            </Badge>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="activities" className="mt-3">
          {activities.length === 0 ? (
            <EmptyState
              icon={<Activity />}
              title={hasFilters ? '没有匹配的动态' : '还没有任何动态'}
              description={
                hasFilters ? '换个关键字或放宽日期范围试试。' : '创建 / 完成一个任务，它就会出现在这里。'
              }
            />
          ) : (
            <div className="space-y-4">
              {days.map((group) => (
                <section key={group.dayKey || 'unknown'} className="space-y-2">
                  <h3 className="text-xs font-medium text-muted-foreground">
                    {formatLocalDateSafe(group.items[0].created_at)}
                  </h3>
                  <ul className="space-y-2">
                    {group.items.map((operation) => (
                      <ActivityRow key={operation.id} operation={operation} onOpenTarget={openTarget} />
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="recalc" className="mt-3">
          {snapshots.length === 0 ? (
            <EmptyState
              icon={<RefreshCw />}
              title="还没有重算记录"
              description="队列每次刷新排序都会留一份快照，单独放在这里，不干扰日常动态。"
            />
          ) : (
            <ul className="space-y-2">
              {snapshots.map((snapshot) => (
                <SnapshotRow key={snapshot.id} snapshot={snapshot} />
              ))}
            </ul>
          )}
        </TabsContent>
      </Tabs>

      <TaskDetailDrawer taskId={openTaskId} onOpenChange={() => setOpenTaskId(null)} />
      <GoalDetailPanel
        goal={openGoal}
        open={openGoalId !== null}
        onOpenChange={(next) => {
          if (!next) setOpenGoalId(null);
        }}
      />
    </div>
  );
}
