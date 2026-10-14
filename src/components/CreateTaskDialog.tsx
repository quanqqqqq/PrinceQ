/**
 * 新建任务对话框。
 *
 * 刻意保持简单：只有标题是必填项，服务端会根据拿到的上下文推断象限。其余字段
 * 都是可选的，直接对应 POST /api/tasks 的请求体。
 *
 * UX-21：输入会即时写入本地草稿（见 @/lib/task-draft）。点遮罩、按 Esc、点
 * 「取消」都只是关闭对话框，草稿保留；下次打开原样恢复。只有提交成功或点
 * 「清空草稿」才真正丢弃。
 *
 * UX-15：表单按「常用 / 可选」分层——标题、目标、截止时间、预计耗时常显，描述
 * 与三个高级项（类型 / 认知负荷 / 手动优先级）默认折叠。折叠只是本地视图状态，
 * 不写草稿；内容始终留在 fields 里并照常落盘，所以收起来不会丢输入。高级项折叠
 * 且被改过时，标题行旁给一行中文摘要，免得设置「藏」得看不见。
 */
import { useState } from 'react';
import type { CognitiveLoad, DurationUnit, GoalWithProgress, TaskType } from '@shared/types';
import { COGNITIVE_LOADS, TASK_TYPES } from '@shared/types';
import { ChevronDown, ChevronUp, Eraser, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { TaskDateTimeField } from '@/components/TaskDateTimeField';
import { DurationField } from '@/components/DurationField';
import { WriteError } from '@/components/states';
import { COGNITIVE_LOAD_LABELS, MANUAL_PRIORITY_LABELS, TASK_TYPE_LABELS } from '@/lib/format';
import { api, type CreateTaskInput } from '@/lib/api';
import {
  EMPTY_CREATE_TASK_DRAFT,
  type CreateTaskDraftFields,
  defaultCreateTaskDraftStore,
  isCreateTaskDraftEmpty,
  restoreCreateTaskDraft,
  serializeCreateTaskDraft,
} from '@/lib/task-draft';
import { createAdvancedSummary, hasAdvancedCreateFields } from '@/lib/create-form-summary';
import { useMutation } from '@/hooks/use-resource';

export function CreateTaskDialog({ goals }: { goals: GoalWithProgress[] }) {
  const [open, setOpen] = useState(false);
  const [fields, setFields] = useState<CreateTaskDraftFields>({ ...EMPTY_CREATE_TASK_DRAFT });
  /**
   * 两个折叠区的展开态。纯本地视图状态——不写草稿、不落盘，所以刷新后回到默认
   * 的收起态，但已填的内容仍在草稿里。
   */
  const [showDescription, setShowDescription] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const store = defaultCreateTaskDraftStore();
  const mutation = useMutation(['tasks', 'queue', 'activity', 'goals']);

  /** 合并一个字段补丁并立刻落盘，所以任何关闭方式都不会丢输入。 */
  const update = (patch: Partial<CreateTaskDraftFields>) => {
    setFields((current) => {
      const next = { ...current, ...patch };
      store.save(serializeCreateTaskDraft(next));
      return next;
    });
  };

  /** 显式丢弃草稿：唯一会清空存储的手动入口。 */
  const discardDraft = () => {
    store.clear();
    setFields({ ...EMPTY_CREATE_TASK_DRAFT });
    setShowDescription(false);
    setShowAdvanced(false);
    mutation.clearError();
  };

  const hasContent = !isCreateTaskDraftEmpty(fields);

  /**
   * 描述区：已有内容时强制展开，否则听本地开关。这样从草稿恢复出一段描述时，
   * 它不会被折叠起来「藏」掉。
   */
  const descriptionOpen = showDescription || fields.description !== '';
  const advancedSummary = createAdvancedSummary(fields);
  const advancedTouched = hasAdvancedCreateFields(fields);

  const submit = async () => {
    const trimmed = fields.title.trim();
    if (!trimmed) return;

    const body: CreateTaskInput = { title: trimmed };
    if (fields.description.trim()) body.description = fields.description.trim();
    if (fields.goal_id) body.goal_id = fields.goal_id;
    // `datetime-local` has no zone; the server normalises whatever ISO it gets.
    if (fields.deadline_local) body.deadline = new Date(fields.deadline_local).toISOString();
    // 耗时一律按「数值 + 单位」发；服务端按最新 habits 配置换算出
    // estimated_minutes 落库，同时留档原单位供回显。
    if (fields.estimated_minutes_text.trim()) {
      body.duration_value = Number(fields.estimated_minutes_text);
      body.duration_unit = (fields.duration_unit || 'minute') as DurationUnit;
    }
    if (fields.task_type) body.task_type = fields.task_type as TaskType;
    if (fields.cognitive_load) body.cognitive_load = fields.cognitive_load as CognitiveLoad;
    if (fields.manual_priority !== '0') body.manual_priority = Number(fields.manual_priority);

    const created = await mutation.run('create', () => api.createTask(body));
    if (created) {
      store.clear();
      setFields({ ...EMPTY_CREATE_TASK_DRAFT });
      setShowDescription(false);
      setShowAdvanced(false);
      setOpen(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // 每次打开都从存储重新恢复，这样头部按钮和空状态里的两个实例行为一致。
        if (next) {
          const restored = restoreCreateTaskDraft(store);
          setFields(restored);
          // 草稿里已有描述就直接展开，并且记在开关上——这样用户把它删空时
          // 输入框不会在手底下塌掉。
          setShowDescription(restored.description !== '');
        }
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus />
          新建任务
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>新建任务</DialogTitle>
          <DialogDescription>
            只有标题是必填的。本地推断会给出一个象限，之后你可以确认或修改。
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="task-title">标题</Label>
            <Input
              id="task-title"
              value={fields.title}
              onChange={(event) => update({ title: event.target.value })}
              placeholder="例如：整理三季度复盘笔记"
              className="bg-card! disabled:bg-muted! read-only:bg-muted!"
              autoFocus
            />
          </div>

          {/* 描述默认折叠：大多数任务一句标题就够了。 */}
          <div className="space-y-1.5">
            {descriptionOpen ? (
              <>
                <Label htmlFor="task-description">描述</Label>
                <Textarea
                  id="task-description"
                  value={fields.description}
                  onChange={(event) => update({ description: event.target.value })}
                  placeholder="怎样算做完了？"
                  rows={2}
                  className="bg-card! disabled:bg-muted! read-only:bg-muted!"
                />
              </>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 px-2 text-muted-foreground"
                onClick={() => setShowDescription(true)}
                aria-expanded={false}
                aria-controls="task-description"
              >
                <ChevronDown />
                添加描述
              </Button>
            )}
          </div>

          {/* 常用基础项：目标、截止时间、预计耗时。 */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="task-goal">目标</Label>
              <NativeSelect
                id="task-goal"
                value={fields.goal_id}
                onChange={(event) => update({ goal_id: event.target.value })}
                className="bg-card! disabled:bg-muted!"
              >
                <NativeSelectOption value="">不关联目标</NativeSelectOption>
                {goals.map((goal) => (
                  <NativeSelectOption key={goal.id} value={goal.id}>
                    {goal.title}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="task-deadline">截止时间</Label>
              <TaskDateTimeField
                id="task-deadline"
                value={fields.deadline_local}
                onChange={(v) => update({ deadline_local: v })}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="task-minutes">预计耗时</Label>
              <DurationField
                id="task-minutes"
                value={fields.estimated_minutes_text}
                unit={(fields.duration_unit || 'minute') as DurationUnit}
                onValueChange={(next) => update({ estimated_minutes_text: next })}
                onUnitChange={(next) => update({ duration_unit: next })}
              />
            </div>
          </div>

          {/* 高级项折叠区：类型 / 认知负荷 / 手动优先级。 */}
          <div className="space-y-2 border-t border-border pt-3">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 px-2 text-muted-foreground"
                onClick={() => setShowAdvanced((current) => !current)}
                aria-expanded={showAdvanced}
                aria-controls="task-advanced-fields"
              >
                {showAdvanced ? <ChevronUp /> : <ChevronDown />}
                更多设置
              </Button>
              {/* 收起时才提示，免得跟下面展开的控件重复说一遍。 */}
              {!showAdvanced && advancedTouched ? (
                <span className="text-xs text-muted-foreground">{advancedSummary}</span>
              ) : null}
            </div>

            {showAdvanced ? (
              <div id="task-advanced-fields" className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="task-type">类型</Label>
                  <NativeSelect
                    id="task-type"
                    value={fields.task_type}
                    onChange={(event) => update({ task_type: event.target.value })}
                    className="bg-card! disabled:bg-muted!"
                  >
                    <NativeSelectOption value="">未指定</NativeSelectOption>
                    {TASK_TYPES.map((type) => (
                      <NativeSelectOption key={type} value={type}>
                        {TASK_TYPE_LABELS[type] ?? type}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="task-load">认知负荷</Label>
                  <NativeSelect
                    id="task-load"
                    value={fields.cognitive_load}
                    onChange={(event) => update({ cognitive_load: event.target.value })}
                    className="bg-card! disabled:bg-muted!"
                  >
                    <NativeSelectOption value="">未指定</NativeSelectOption>
                    {COGNITIVE_LOADS.map((value) => (
                      <NativeSelectOption key={value} value={value}>
                        {COGNITIVE_LOAD_LABELS[value]}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="task-priority">手动优先级</Label>
                  <NativeSelect
                    id="task-priority"
                    value={fields.manual_priority}
                    onChange={(event) => update({ manual_priority: event.target.value })}
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
            ) : null}
          </div>

          {mutation.error ? (
            <WriteError message={mutation.error} onDismiss={mutation.clearError} />
          ) : null}

          {hasContent ? (
            <p className="text-xs text-muted-foreground">
              草稿已自动保存，关闭后可继续编辑；点「清空草稿」可丢弃。
            </p>
          ) : null}

          <DialogFooter>
            {hasContent ? (
              <Button
                type="button"
                variant="ghost"
                onClick={discardDraft}
                disabled={mutation.pending !== null}
              >
                <Eraser />
                清空草稿
              </Button>
            ) : null}
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button
              type="submit"
              disabled={!fields.title.trim() || mutation.pending !== null}
            >
              {mutation.pending ? '创建中…' : '创建任务'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
