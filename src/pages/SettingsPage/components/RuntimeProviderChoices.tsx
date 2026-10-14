import {useEffect, useState} from 'react';
import {CheckCircle2, Loader2} from 'lucide-react';
import {toast} from 'sonner';
import {Button} from '@/components/ui/button';
import {AgentWarnings} from '@/components/AgentResultView';
import {AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger} from '@/components/ui/alert-dialog';
import {getRuntimeProviders, testRuntimeConnection} from '@/lib/agent-runtime-client';
import {providerLabel, type DetectedCandidate, type RuntimeProviderEntry} from '@/lib/agent-runtime-contract';

export function RuntimeProviderChoices({provider, cliPath, enabled, refreshKey, onSelect}: {
  provider: string; cliPath: string; enabled: boolean; refreshKey: string; onSelect: (candidate: DetectedCandidate) => void;
}) {
  const [entries, setEntries] = useState<RuntimeProviderEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let cancelled = false;
    getRuntimeProviders().then(data => {if (!cancelled) {setEntries(data.providers); setError(null);}})
      .catch(() => {if (!cancelled) setError('暂时无法读取 CLI 列表，请重试。');});
    return () => {cancelled = true;};
  }, [revision, provider, cliPath, refreshKey]);
  const check = async (entry: RuntimeProviderEntry) => {
    if (!entry.candidate) return;
    setTesting(entry.provider);
    try {
      const result = await testRuntimeConnection({provider: entry.provider, cli_path: entry.candidate.path});
      setEntries(current => current.map(item => item.provider === entry.provider ? {...item, connection: result} : item));
      toast[result.ok ? 'success' : 'error'](result.ok ? `${providerLabel(entry.provider)} 连接验证成功` : `${providerLabel(entry.provider)} 验证失败：${result.reason ?? '未知原因'}`);
    } catch (cause) {toast.error(cause instanceof Error ? cause.message : '连接验证失败。');}
    finally {setTesting(null);}
  };
  if (error) return <div role="status" className="text-xs text-destructive">{error}<Button size="sm" variant="outline" onClick={() => setRevision(value => value+1)}>重试</Button></div>;
  if (!entries.length) return <p className="text-xs text-muted-foreground">正在检查 Claude / Codex…</p>;
  return <div className="space-y-2">
    <p className="text-xs text-muted-foreground">选择一个助手即可。连接验证只发送固定的 OK 问答，不发送任务内容。</p>
    <div className="grid gap-3 sm:grid-cols-2">
      {entries.map(entry => {
        const current = enabled && provider === entry.provider && cliPath === entry.candidate?.path;
        const connection = entry.connection;
        return <div key={entry.provider} className={'space-y-2 rounded-lg border p-3 ' + (current ? 'border-primary bg-primary/5' : 'border-border')}>
          <div className="flex items-center justify-between gap-2"><b className="text-sm">{providerLabel(entry.provider)}</b>{current ? <span className="text-xs text-primary">当前使用</span> : null}</div>
          <p className={'flex items-center gap-1 text-xs ' + (connection?.ok ? 'text-emerald-700' : 'text-muted-foreground')}>
            {connection?.ok ? <CheckCircle2 className="size-3.5"/> : null}
            {!entry.candidate ? '未找到可用 CLI' : connection?.ok ? '连接验证通过' : connection ? '上次连接验证失败' : '已安装，尚未验证连接'}
          </p>
          {connection?.checked_at ? <p className="text-[11px] text-muted-foreground">验证于 {new Date(connection.checked_at).toLocaleString('zh-CN')}</p> : null}
          {connection?.ok ? <p className="text-xs">模型回复：{connection.stdout_excerpt}</p> : null}
          <AgentWarnings warnings={connection?.warnings} />
          {entry.candidate ? <p className="break-all text-[11px] text-muted-foreground">{entry.candidate.path}</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant={current ? 'outline' : 'default'} disabled={!entry.candidate || current || testing !== null}
              onClick={() => {if (entry.candidate) onSelect(entry.candidate);}}>{current ? '已选用' : `使用 ${providerLabel(entry.provider)}`}</Button>
            <AlertDialog>
              <AlertDialogTrigger asChild><Button type="button" size="sm" variant="outline" disabled={!entry.candidate || testing !== null}>
                {testing === entry.provider ? <Loader2 className="size-3 animate-spin"/> : null}验证 {providerLabel(entry.provider)}
              </Button></AlertDialogTrigger>
              <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>验证 {providerLabel(entry.provider)} 连接</AlertDialogTitle>
                <AlertDialogDescription>会启动该 CLI，向模型发送一次固定的 OK 问答，可能产生用量。不会发送你的任务内容，也不会切换或启用助手。</AlertDialogDescription>
              </AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction onClick={() => void check(entry)}>开始验证</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
            </AlertDialog>
          </div>
        </div>;
      })}
    </div>
  </div>;
}
