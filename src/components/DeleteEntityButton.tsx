import { useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { useMutation, useWorkspace } from '@/hooks/use-resource';
import { api } from '@/lib/api';

interface DeleteTarget {
  id: string;
  title: string;
  version: number;
}

/** Shared by cards and details; only the explicit confirmation sends DELETE. */
export function DeleteEntityButton({
  kind,
  entity,
  disabled = false,
  onDeleted,
}: {
  kind: 'task' | 'goal';
  entity: DeleteTarget;
  disabled?: boolean;
  onDeleted?: () => void;
}) {
  const [target, setTarget] = useState<DeleteTarget | null>(null);
  const inFlight = useRef(false);
  const mutation = useMutation(['tasks', 'goals', 'queue', 'activity']);
  const { invalidate } = useWorkspace();
  const busy = mutation.pending !== null;

  const confirm = async () => {
    if (!target || inFlight.current) return;
    inFlight.current = true;
    try {
      const result = await mutation.run<unknown>('delete', () =>
        kind === 'goal'
          ? api.deleteGoal(target.id, target.version)
          : api.deleteTask(target.id, target.version),
      );
      if (result) {
        setTarget(null);
        toast.success(kind === 'goal' ? `已删除目标「${target.title}」及其所有关联任务` : `已删除任务「${target.title}」`);
        onDeleted?.();
      } else {
        // Refresh stale versions; a fresh confirmation still requires reopening.
        invalidate(['tasks', 'goals', 'queue', 'activity']);
      }
    } finally {
      inFlight.current = false;
    }
  };

  return (
    <AlertDialog
      open={target !== null}
      onOpenChange={(open) => {
        if (inFlight.current) return;
        mutation.clearError();
        setTarget(open ? { ...entity } : null);
      }}
    >
      <AlertDialogTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          disabled={disabled || busy}
        >
          <Trash2 />
          删除
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent onClick={(event) => event.stopPropagation()}>
        <AlertDialogHeader>
          <AlertDialogTitle>{kind === 'goal' ? '删除目标及其所有任务？' : '删除任务？'}</AlertDialogTitle>
          <AlertDialogDescription className="break-words">
            将永久删除「{target?.title ?? entity.title}」，此操作无法撤销。
            {kind === 'goal'
              ? '此目标的所有关联任务（包括已完成、已归档的任务）也会永久删除，相关领取记录和依赖关系会一并清理。'
              : '相关任务的依赖关系会解除，其他任务会保留。'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {mutation.error ? (
          <p role="alert" className="text-sm text-destructive">
            {mutation.error} 若数据已更新，请取消后重新点击删除。
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
          <Button type="button" variant="destructive" disabled={busy} onClick={() => void confirm()}>
            {busy ? '删除中…' : '确认删除'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
