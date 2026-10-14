/**
 * 明确习惯区块：用户自己写下的工作习惯，排期时作为软性偏好参与打分。
 *
 * 新增与编辑共用一个对话框（`HabitDialog`），只是初始值不同——两处的字段、校验和
 * 白底样式必须一致，分开写迟早会漂移。
 *
 * 「移除」是 `enabled:false` 的软移除（后端没有 DELETE）：条目与历史都留着，只是
 * 不再参与排序，之后能在「已移除的习惯」折叠区里恢复。所以主列表只渲染 enabled
 * 的条目，并且只有在用的条目可编辑——改一条已移除的习惯没有意义，先恢复再改。
 *
 * kind 永远以英文 key 往后端发，中文只在 `kindLabel` 这一层做展示。
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
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { SectionCard } from '@/components/settings/SectionCard';
import {
  EXPLICIT_KIND_LABELS,
  kindLabel,
  splitByEnabled,
} from '@/components/settings/settings-contract';
import { useSettingsWrite } from '@/components/settings/settings-write';
import {
  createExplicit,
  getSnapshot,
  setExplicitEnabled,
  updateExplicit,
  type ExplicitHabitEntry,
  type SettingsVersions,
} from '@/lib/settings-client';

/** 新建时可选的 kind，顺序即下拉框顺序。 */
const KIND_OPTIONS = ['scheduling', 'batching', 'preference', 'estimation'] as const;

const SELECT_CLASS =
  'h-9 w-full rounded-md border border-input bg-card! px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20';

/**
 * 习惯的新增/编辑对话框。
 *
 * `trigger` 由调用方给：列表头是「新增习惯」按钮，每行是一个铅笔小按钮。
 */
function HabitDialog({
  title,
  trigger,
  initial,
  pending,
  onSubmit,
  reload,
}: {
  title: string;
  trigger: React.ReactNode;
  initial: { statement: string; kind: string };
  pending: boolean;
  onSubmit: (input: { statement: string; kind: string }) => Promise<boolean>;
  reload?: () => Promise<{input: { statement: string; kind: string }; submit: (input: { statement: string; kind: string }) => Promise<boolean>}>;
}) {
  const [open, setOpen] = useState(false);
  const editing = title.startsWith('编辑');
  const [editAction, setEditAction] = useState(() => onSubmit);
  const [statement, setStatement] = useState(initial.statement);
  const [kind, setKind] = useState(initial.kind);

  // 每次打开都回到传入的初始值：编辑时预填最新一次快照，新增时清空上回的输入。
  const changeOpen = (next: boolean) => {
    if (next) {
      autosave.reset({statement: initial.statement.trim(), kind: initial.kind});
      setEditAction(() => onSubmit);
      setStatement(initial.statement);
      setKind(initial.kind);
    }
    if (!next && editing) { void autosave.flush().then(ok => { if (ok) setOpen(false); }); }
    else setOpen(next);
  };

  const trimmed = statement.trim();
  const autosave = useSettingsAutosave({statement: trimmed, kind}, Boolean(trimmed && trimmed.length <= 400),
    () => editAction({statement: trimmed, kind}), editing && open);

  const submit = async () => {
    if (!trimmed) return;
    const ok = await onSubmit({ statement: trimmed, kind });
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
            <Label htmlFor="habit-statement">习惯描述</Label>
            <Textarea
              id="habit-statement"
              value={statement}
              onChange={(event) => setStatement(event.target.value)}
              placeholder="例如：上午只做深度工作，会议都排到下午"
              rows={3}
              maxLength={400}
              className="bg-card! disabled:bg-muted! read-only:bg-muted!"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="habit-kind">类型</Label>
            <select
              id="habit-kind"
              value={kind}
              onChange={(event) => setKind(event.target.value)}
              className={SELECT_CLASS}
            >
              {!KIND_OPTIONS.includes(kind as typeof KIND_OPTIONS[number]) ? <option value={kind}>{kindLabel(EXPLICIT_KIND_LABELS, kind)}</option> : null}
              {KIND_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {kindLabel(EXPLICIT_KIND_LABELS, option)}
                </option>
              ))}
            </select>
          </div>
          {editing ? <AutosaveStatus state={autosave.state} message={autosave.message} retry={autosave.retry}
            onReload={reload ? async () => {
              const fresh = await reload();
              const next = {statement: fresh.input.statement.trim(), kind: fresh.input.kind};
              autosave.reset(next); setStatement(fresh.input.statement); setKind(fresh.input.kind);
              setEditAction(() => fresh.submit);
            } : undefined} /> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => changeOpen(false)}>{editing ? '完成' : '取消'}</Button>
            {editing && ['invalid', 'error', 'conflict'].includes(autosave.state) ? <Button type="button" variant="ghost" onClick={() => {
              autosave.reset({statement: initial.statement.trim(), kind: initial.kind});
              setOpen(false);
            }}>放弃未保存的修改</Button> : null}
            {!editing ? <Button type="submit" disabled={!trimmed || pending}>{pending ? '添加中…' : '添加'}</Button> : null}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ExplicitHabitsSection({
  entries,
  versions,
  onDone,
}: {
  entries: ExplicitHabitEntry[];
  versions: SettingsVersions;
  onDone: () => void;
}) {
  const write = useSettingsWrite(onDone);
  const { active, removed, removedCount } = splitByEnabled(entries);

  const setEnabled = (entry: ExplicitHabitEntry, enabled: boolean) =>
    write.submit(
      () => setExplicitEnabled(entry.id, enabled, versions.explicit),
      enabled ? '已恢复这条习惯' : '已移除这条习惯',
    );

  return (
    <SectionCard
      title="明确习惯"
      description="你写下的工作习惯，排期时作为偏好参与排序。"
      actions={
        <HabitDialog
          title="新增习惯"
          trigger={
            <Button size="sm">
              <Plus />
              新增习惯
            </Button>
          }
          initial={{ statement: '', kind: KIND_OPTIONS[0] }}
          pending={write.pending}
          onSubmit={(input) =>
            write.submit(() => createExplicit(input, versions.explicit), '已新增习惯')
          }
        />
      }
    >
      <div className="space-y-3">
        {active.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            还没有在用的明确习惯。写下一条，排序会立刻参考它。
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
                  <Badge variant="outline" className="font-normal text-muted-foreground">
                    {kindLabel(EXPLICIT_KIND_LABELS, entry.kind)}
                  </Badge>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <HabitDialog
                    title="编辑习惯"
                    trigger={
                      <Button size="sm" variant="ghost" className="min-h-9" aria-label="编辑习惯">
                        <Pencil />
                      </Button>
                    }
                    initial={{ statement: entry.statement, kind: entry.kind }}
                    pending={write.pending}
                    reload={async () => {
                      const fresh = await getSnapshot();
                      const latest = fresh.explicit.find(item => item.id === entry.id);
                      if (!latest) throw new Error('这条习惯已不存在');
                      onDone();
                      return {input: {statement: latest.statement, kind: latest.kind}, submit: async input => {
                        await updateExplicit(entry.id, input, fresh.versions.explicit); onDone(); return true;
                      }};
                    }}
                    onSubmit={async (input) => {
                      await updateExplicit(entry.id, input, versions.explicit);
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
                        aria-label={`移除习惯：${demoTitle(entry.statement)}`}
                      >
                        移除
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>移除这条习惯？</AlertDialogTitle>
                        <AlertDialogDescription>
                          移除后它不再参与排序，但记录会保留——之后可以在「已移除的习惯」里恢复。
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
              <span>已移除的习惯（{removedCount}）</span>
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
                      {kindLabel(EXPLICIT_KIND_LABELS, entry.kind)} · 不参与排序
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="min-h-9 shrink-0"
                    disabled={write.pending}
                    aria-label={`恢复习惯：${demoTitle(entry.statement)}`}
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
