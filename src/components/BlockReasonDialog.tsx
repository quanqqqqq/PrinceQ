/**
 * 站内「标记受阻」原因弹窗。
 *
 * 取代浏览器原生 window.prompt：中文界面、可输入原因、确认 / 取消。
 * 受控组件——打开、忙碌、报错全部由 useTaskActions 注入；提交失败时弹窗保持
 * 打开、已输入的原因不清空，用户可直接修改后重试。
 */
import { useState } from 'react';
import type { Task } from '@shared/types';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

export interface BlockReasonDialogProps {
  /** 当前要标记受阻的任务；null 表示弹窗关闭。 */
  task: Task | null;
  /** 正在提交受阻请求。 */
  pending: boolean;
  /** 上一次提交失败的中文错误；存在时弹窗不关闭，原因输入保留。 */
  error: string | null;
  /** 用户点「确认受阻」，传入去空白后的原因。 */
  onConfirm: (reason: string) => void;
  /** 用户点「取消」、遮罩或 Esc——不发送任何请求。 */
  onCancel: () => void;
}

export function BlockReasonDialog({
  task,
  pending,
  error,
  onConfirm,
  onCancel,
}: BlockReasonDialogProps) {
  const [reason, setReason] = useState(task?.blocked_reason ?? '');

  const trimmed = reason.trim();
  const open = task !== null;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !pending) onCancel(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>标记为受阻</DialogTitle>
          <DialogDescription>
            {task ? `「${task.title}」因为什么受阻？` : '把任务标记为受阻。'}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (trimmed && !pending) onConfirm(trimmed);
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="block-reason">受阻原因</Label>
            <Textarea
              id="block-reason"
              autoFocus
              rows={3}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="例如：在等设计稿评审、依赖的 API 还没上线…"
              disabled={pending}
            />
          </div>

          {error ? (
            <Alert variant="destructive">
              <AlertTitle>提交失败，没有标记受阻</AlertTitle>
              <AlertDescription>{error}。可修改原因后重试，或取消放弃。</AlertDescription>
            </Alert>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>
              取消
            </Button>
            <Button type="submit" disabled={!trimmed || pending}>
              {pending ? '提交中…' : '确认受阻'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
