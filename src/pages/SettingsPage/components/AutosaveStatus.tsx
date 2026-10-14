import { Check, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import type { SaveState } from '@/lib/settings-autosave';

export function AutosaveStatus({ state, message, retry, onReload }: { state: SaveState; message?: string; retry: () => void; onReload?: () => Promise<void> }) {
  const label = {saved: '已保存', editing: '编辑中', waiting: '即将保存', saving: '保存中…', invalid: '请完善输入，尚未保存', error: '保存失败', conflict: '需要核对修改'}[state];
  const failed = state === 'error' || state === 'conflict';
  return <div role="status" aria-live="polite" className={'flex flex-wrap items-center gap-1.5 text-xs ' + (failed || state === 'invalid' ? 'text-destructive' : 'text-muted-foreground')}>
    {state === 'saving' ? <Loader2 className="size-3 animate-spin" /> : state === 'saved' ? <Check className="size-3" /> : null}
    <span>{label}</span>
    {failed ? <span>{message}</span> : null}
    {state === 'error' ? <Button type="button" size="sm" variant="outline" onClick={retry}>重试保存</Button> : null}
    {state === 'conflict' && onReload ? <Button type="button" size="sm" variant="outline" onClick={() => {
      if (!window.confirm('重新读取会丢弃当前未保存的输入，是否继续？')) return;
      void onReload().catch(() => toast.error('读取设置失败，当前输入已保留'));
    }}>重新读取设置</Button> : null}
  </div>;
}
