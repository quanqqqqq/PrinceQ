/**
 * 硬性约束区块。
 *
 * 和习惯的区别是硬性的：习惯是打分时的偏好，约束是排期时不能违反的红线，所以这里
 * 的文案要把这点说清楚。
 *
 * 「移除」与明确习惯同构：`enabled:false` 的软移除，记录与历史都留着，只是不再限制
 * 排期，之后能在「已移除的约束」折叠区里恢复。主列表只渲染在用的条目，编辑也只对
 * 在用的开放。
 *
 * `value` 的格式随 kind 变——禁止时段是 `"HH:MM-HH:MM"`，另两种是分钟数的字符串。
 * 对话框按 kind 切换输入控件，提交前统一拼回字符串，界面层不自己发明别的格式。
 */
import { demoTitle } from '@/lib/i18n';
import { useState } from 'react';
import { useSettingsAutosave } from '@/hooks/use-settings-autosave';
import { AutosaveStatus } from '@/pages/SettingsPage/components/AutosaveStatus';
import { ChevronDown, Pencil, Plus } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { SectionCard } from '@/components/settings/SectionCard';
import {
  CONSTRAINT_KIND_LABELS,
  kindLabel,
  splitByEnabled,
} from '@/components/settings/settings-contract';
import { useSettingsWrite } from '@/components/settings/settings-write';
import {
  createConstraint,
  getSnapshot,
  setConstraintEnabled,
  updateConstraint,
  type ConstraintEntry,
} from '@/lib/settings-client';

const KIND_OPTIONS = ['forbidden_window', 'max_daily_minutes', 'required_buffer'] as const;

const SELECT_CLASS =
  'h-9 w-full rounded-md border border-input bg-card! px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20';

const TIME_CLASS =
  'h-9 w-full rounded-md border border-input bg-card! px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20';

/** 禁止时段的默认区间，新建时给一个合理起点而不是两个空框。 */
const DEFAULT_WINDOW = { from: '12:00', to: '13:00' };

/** 把 `"HH:MM-HH:MM"` 拆成两段；格式不认就落回默认值，不让界面崩在脏数据上。 */
function splitWindow(value: string): { from: string; to: string } {
  const match = /^(\d{2}:\d{2})-(\d{2}:\d{2})$/.exec(value.trim());
  if (!match) return { ...DEFAULT_WINDOW };
  return { from: match[1], to: match[2] };
}

function ConstraintDialog({
  title,
  trigger,
  initial,
  pending,
  onSubmit,
  reload,
}: {
  title: string;
  trigger: React.ReactNode;
  initial: { statement: string; kind: string; value: string };
  pending: boolean;
  onSubmit: (input: { statement: string; kind: string; value: string }) => Promise<boolean>;
  reload?: () => Promise<{input: { statement: string; kind: string; value: string }; submit: (input: { statement: string; kind: string; value: string }) => Promise<boolean>}>;
}) {
  const [open, setOpen] = useState(false);
  const editing = title.startsWith('编辑');
  const [editAction, setEditAction] = useState(() => onSubmit);
  const [statement, setStatement] = useState(initial.statement);
  const [kind, setKind] = useState(initial.kind);
  const [window, setWindow] = useState(() => splitWindow(initial.value));
  // 分钟数同样存字符串，理由同 ConversionSection：允许输入框暂时为空。
  const [minutes, setMinutes] = useState(
    initial.kind === 'forbidden_window' ? '' : initial.value,
  );

  const changeOpen = (next: boolean) => {
    if (next) {
      autosave.reset({statement: initial.statement.trim(), kind: initial.kind, value: initial.value});
      setEditAction(() => onSubmit);
      setStatement(initial.statement);
      setKind(initial.kind);
      setWindow(splitWindow(initial.value));
      setMinutes(initial.kind === 'forbidden_window' ? '' : initial.value);
    }
    if (!next && editing) { void autosave.flush().then(ok => { if (ok) setOpen(false); }); }
    else setOpen(next);
  };

  const isWindow = kind === 'forbidden_window';
  const trimmed = statement.trim();
  const minutesNumber = Number(minutes);
  const valueReady = isWindow
    ? Boolean(window.from && window.to)
    : minutes !== '' && Number.isFinite(minutesNumber) && minutesNumber > 0;

  const autoValue = isWindow ? `${window.from}-${window.to}` : String(minutesNumber);
  const autosave = useSettingsAutosave({statement: trimmed, kind, value: autoValue},
    Boolean(trimmed && trimmed.length <= 400 && valueReady), () => editAction({statement: trimmed, kind, value: autoValue}), editing && open);

  const submit = async () => {
    if (!trimmed || !valueReady) return;
    const value = isWindow ? `${window.from}-${window.to}` : String(minutesNumber);
    const ok = await onSubmit({ statement: trimmed, kind, value });
    if (ok) setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-3"
          {...autosave.events}
          onSubmit={(event) => {
            event.preventDefault();
            if (editing) void autosave.flush(); else void submit();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="constraint-statement">约束描述</Label>
            <Textarea
              id="constraint-statement"
              value={statement}
              onChange={(event) => setStatement(event.target.value)}
              placeholder="例如：午休不排任何任务"
              rows={3}
              maxLength={400}
              className="bg-card! disabled:bg-muted! read-only:bg-muted!"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="constraint-kind">类型</Label>
            <select
              id="constraint-kind"
              value={kind}
              onChange={(event) => setKind(event.target.value)}
              className={SELECT_CLASS}
            >
              {!KIND_OPTIONS.includes(kind as typeof KIND_OPTIONS[number]) ? <option value={kind}>{kindLabel(CONSTRAINT_KIND_LABELS, kind)}</option> : null}
              {KIND_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {kindLabel(CONSTRAINT_KIND_LABELS, option)}
                </option>
              ))}
            </select>
          </div>

          {isWindow ? (
            <div className="space-y-1.5">
              <Label htmlFor="constraint-from">时段</Label>
              <div className="flex items-center gap-2">
                <input
                  id="constraint-from"
                  type="time"
                  value={window.from}
                  onChange={(event) => setWindow((prev) => ({ ...prev, from: event.target.value }))}
                  className={TIME_CLASS}
                />
                <span className="text-xs text-muted-foreground">至</span>
                <input
                  type="time"
                  aria-label="时段结束"
                  value={window.to}
                  onChange={(event) => setWindow((prev) => ({ ...prev, to: event.target.value }))}
                  className={TIME_CLASS}
                />
              </div>
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="constraint-minutes">分钟数</Label>
              <Input
                id="constraint-minutes"
                type="number"
                step="1"
                min="1"
                value={minutes}
                onChange={(event) => setMinutes(event.target.value)}
                className="bg-card! disabled:bg-muted! read-only:bg-muted!"
              />
            </div>
          )}

          {editing ? <AutosaveStatus state={autosave.state} message={autosave.message} retry={autosave.retry}
            onReload={reload ? async () => {
              const fresh = await reload();
              const nextWindow = splitWindow(fresh.input.value);
              const nextValue = fresh.input.kind === 'forbidden_window'
                ? `${nextWindow.from}-${nextWindow.to}` : String(Number(fresh.input.value));
              autosave.reset({statement: fresh.input.statement.trim(), kind: fresh.input.kind, value: nextValue});
              setStatement(fresh.input.statement); setKind(fresh.input.kind); setWindow(nextWindow);
              setMinutes(fresh.input.kind === 'forbidden_window' ? '' : fresh.input.value);
              setEditAction(() => fresh.submit);
            } : undefined} /> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => changeOpen(false)}>{editing ? '完成' : '取消'}</Button>
            {editing && ['invalid', 'error', 'conflict'].includes(autosave.state) ? <Button type="button" variant="ghost" onClick={() => {
              autosave.reset({statement: initial.statement.trim(), kind: initial.kind, value: initial.value});
              setOpen(false);
            }}>放弃未保存的修改</Button> : null}
            {!editing ? <Button type="submit" disabled={!trimmed || !valueReady || pending}>{pending ? '添加中…' : '添加'}</Button> : null}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ConstraintsSection({
  entries,
  version,
  onDone,
}: {
  entries: ConstraintEntry[];
  version: string;
  onDone: () => void;
}) {
  const write = useSettingsWrite(onDone);
  const { active, removed, removedCount } = splitByEnabled(entries);

  const setEnabled = (entry: ConstraintEntry, enabled: boolean) =>
    write.submit(
      () => setConstraintEnabled(entry.id, enabled, version),
      enabled ? '已恢复这条约束' : '已移除这条约束',
    );

  return (
    <SectionCard
      title="硬性约束"
      description="硬性约束：排期时不可违反。"
      actions={
        <ConstraintDialog
          title="新增约束"
          trigger={
            <Button size="sm">
              <Plus />
              新增约束
            </Button>
          }
          initial={{
            statement: '',
            kind: KIND_OPTIONS[0],
            value: `${DEFAULT_WINDOW.from}-${DEFAULT_WINDOW.to}`,
          }}
          pending={write.pending}
          onSubmit={(input) =>
            write.submit(() => createConstraint(input, version), '已新增约束')
          }
        />
      }
    >
      <div className="space-y-3">
        {active.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            还没有在用的硬性约束。排期目前只受习惯与权重影响。
          </p>
        ) : (
          <ul className="space-y-2">
            {active.map((entry) => (
              <li
                key={entry.id}
                className="flex items-start justify-between gap-3 rounded-md border border-border p-3"
              >
                <div className="min-w-0 space-y-1.5">
                  <p className="text-sm">{demoTitle(entry.statement)}</p>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className="font-normal text-muted-foreground">
                      {kindLabel(CONSTRAINT_KIND_LABELS, entry.kind)}
                    </Badge>
                    <span className="text-xs text-muted-foreground">{entry.value}</span>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <ConstraintDialog
                    title="编辑约束"
                    trigger={
                      <Button size="sm" variant="ghost" className="min-h-9" aria-label="编辑约束">
                        <Pencil />
                      </Button>
                    }
                    initial={{ statement: entry.statement, kind: entry.kind, value: entry.value }}
                    pending={write.pending}
                    reload={async () => {
                      const fresh = await getSnapshot();
                      const latest = fresh.constraints.find(item => item.id === entry.id);
                      if (!latest) throw new Error('这条约束已不存在');
                      onDone();
                      return {input: {statement: latest.statement, kind: latest.kind, value: latest.value}, submit: async input => {
                        await updateConstraint(entry.id, input, fresh.versions.constraints); onDone(); return true;
                      }};
                    }}
                    onSubmit={async (input) => {
                      await updateConstraint(entry.id, input, version);
                      onDone(); return true;
                    }}
                  />
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="min-h-9 text-destructive"
                        disabled={write.pending}
                        aria-label={`移除约束：${demoTitle(entry.statement)}`}
                      >
                        移除
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>移除这条约束？</AlertDialogTitle>
                        <AlertDialogDescription>
                          移除后它不再限制排期，但记录会保留——之后可以在「已移除的约束」里恢复。
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <p className="text-sm">{demoTitle(entry.statement)}</p>
                      <AlertDialogFooter>
                        <AlertDialogCancel>取消</AlertDialogCancel>
                        <AlertDialogAction onClick={() => void setEnabled(entry, false)}>
                          确认移除
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              </li>
            ))}
          </ul>
        )}

        {removedCount > 0 ? (
          <Collapsible>
            <CollapsibleTrigger className="flex h-9 w-full items-center justify-between gap-2 rounded-md px-1 text-sm hover:bg-muted">
              <span>已移除的约束（{removedCount}）</span>
              <ChevronDown className="size-4 text-muted-foreground" />
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-2 pt-2">
              {removed.map((entry) => (
                <div
                  key={entry.id}
                  className="flex items-start justify-between gap-3 rounded-md border border-dashed border-border p-3"
                >
                  <div className="min-w-0 space-y-1">
                    <p className="text-sm text-muted-foreground">{demoTitle(entry.statement)}</p>
                    <p className="text-xs text-muted-foreground">
                      {kindLabel(CONSTRAINT_KIND_LABELS, entry.kind)} · {entry.value} · 不限制排期
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="min-h-9 shrink-0"
                    disabled={write.pending}
                    aria-label={`恢复约束：${demoTitle(entry.statement)}`}
                    onClick={() => void setEnabled(entry, true)}
                  >
                    恢复
                  </Button>
                </div>
              ))}
            </CollapsibleContent>
          </Collapsible>
        ) : null}
      </div>
    </SectionCard>
  );
}
