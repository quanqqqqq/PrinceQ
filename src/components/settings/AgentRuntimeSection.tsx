/**
 * 设置页里的「Agent 运行时」独立区块。
 *
 * 数据来源（routes.ts 实测）：
 * - GET `/api/agent/runtime-config` → `{ config, updated_at }`（含 field_sources / detected）。
 * - GET `/api/agent/runtime-status`  → 实时健康徽章。
 * - POST `/api/agent/runtime-detect`（**只有 POST**）→ 自动检测；persist=true 才写回，且只覆盖
 *   field_sources=auto 的字段，manual 不被重检覆盖。
 *
 * 初始：先 GET。若 config.detected 已存在 → 直接显示，不再 POST；不存在则**防重复地**
 * POST 一次 `{provider, expected_version, persist:true}`，再重新 GET。
 *
 * 安全红线：env 只填大写变量名（绝不收值）；无 shell 字符串字段；连接测试会真实启动
 * **已保存 CLI** 跑固定无副作用问答——弹二次确认，用户确认才 POST。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSettingsAutosave } from '@/hooks/use-settings-autosave';
import { AutosaveStatus } from '@/pages/SettingsPage/components/AutosaveStatus';
import { RuntimeProviderChoices } from '@/pages/SettingsPage/components/RuntimeProviderChoices';
import {AgentModelSelector} from '@/pages/SettingsPage/components/AgentModelSelector';
import { toast } from 'sonner';
import {
  AlertTriangle,
  CheckCircle2,
  FlaskConical,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { SectionCard } from '@/components/settings/SectionCard';
import { ErrorState, LoadingRows } from '@/components/states';
import {
  getRuntimeConfig,
  getRuntimeStatus,
  isRuntimeConflict,
  postRuntimeDetect,
  saveRuntimeConfig,
  testRuntimeConnection,
} from '@/lib/agent-runtime-client';
import {
  TIMEOUT_MS_MAX,
  TIMEOUT_MS_MIN,
  addArgToList,
  adoptCandidate,
  allAutoSources,
  applyDetectedRecommendation,
  buildSavePayload,
  checkWorkingDir,
  healthMeta,
  markManual,
  parseDetectedSnapshot,
  parseEnvName,
  pickRecommendedCandidate,
  providerLabel,
  sourcesFromRecord,
  validateConfig,
  type AgentConfigForm,
  type DetectedCandidate,
  type FieldSource,
  type RuntimeDetectResponse,
  type AgentRuntimeProvider,
  type AgentRuntimeStatusView,
  type RuntimeConfigEnvelope,
  type RuntimeTestResult,
} from '@/lib/agent-runtime-contract';
import { cn } from '@/lib/utils';
import { APP_NAME } from '@/lib/i18n';
import { AgentWarnings } from '@/components/AgentResultView';
import { useAgentWarningPreferences } from '@/hooks/use-agent-warning-preferences';

const TONE_CLASS: Record<string, string> = {
  ok: 'border-emerald-300 bg-emerald-50 text-emerald-700',
  muted: 'border-border bg-muted text-muted-foreground',
  warn: 'border-amber-300 bg-amber-50 text-amber-700',
  bad: 'border-red-300 bg-red-50 text-red-700',
};

function SourceBadge({ source }: { source: 'auto' | 'manual' }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        'font-normal',
        source === 'auto'
          ? 'border-sky-200 bg-sky-50 text-sky-700'
          : 'border-violet-200 bg-violet-50 text-violet-700',
      )}
    >
      {source === 'auto' ? '自动' : '手动'}
    </Badge>
  );
}

function toForm(config: RuntimeConfigEnvelope['config']): AgentConfigForm {
  return {
    enabled: config.enabled,
    provider: config.provider,
    cli_path: config.cli_path,
    model: config.model,
    args: config.args,
    timeout_ms: config.timeout_ms,
    working_directory: config.working_directory,
    allowed_env_names: config.allowed_env_names,
  };
}

export function AgentRuntimeSection() {
  const {dismissed} = useAgentWarningPreferences();
  const [configEnv, setConfigEnv] = useState<RuntimeConfigEnvelope | null>(null);
  const [status, setStatus] = useState<AgentRuntimeStatusView | null>(null);
  const [detect, setDetect] = useState<RuntimeDetectResponse | null>(null);
  const [detectBroken, setDetectBroken] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [form, setForm] = useState<AgentConfigForm | null>(null);
  const [sources, setSources] = useState<FieldSource>(allAutoSources());

  const [argInput, setArgInput] = useState('');
  const [editingArg, setEditingArg] = useState<number | null>(null);
  const [argError, setArgError] = useState<string | null>(null);

  const [envInput, setEnvInput] = useState('');
  const [envError, setEnvError] = useState<string | null>(null);
  const [envWarning, setEnvWarning] = useState<string | null>(null);

  const [timeoutSecText, setTimeoutSecText] = useState('20');
  const [dirError, setDirError] = useState<string | null>(null);

  const [testing, setTesting] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [testResult, setTestResult] = useState<RuntimeTestResult | null>(null);

  // 防重复：mount 自动检测只跑一次。
  const autoDetectRan = useRef(false);

  const loadAll = useCallback(async (): Promise<RuntimeConfigEnvelope | null> => {
    const [cfg, st] = await Promise.all([getRuntimeConfig(), getRuntimeStatus()]);
    setConfigEnv(cfg);
    setStatus(st);
    setForm(toForm(cfg.config));
    setSources(sourcesFromRecord(cfg.config.field_sources));
    setDetect(parseDetectedSnapshot(cfg.config.detected));
    setTimeoutSecText(String(Math.round(cfg.config.timeout_ms / 1000)));
    return cfg;
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await loadAll();
        if (cancelled) return;
        setLoadError(null);
        // config 里没有检测快照 → 防重复地 POST 一次 persist:true，再重新拉。
        if (cfg && !parseDetectedSnapshot(cfg.config.detected) && !autoDetectRan.current) {
          autoDetectRan.current = true;
          try {
            await postRuntimeDetect({
              expected_version: cfg.updated_at,
              persist: true,
            });
            if (!cancelled) await loadAll();
          } catch {
            if (!cancelled) setDetectBroken(true);
          }
        }
      } catch (cause) {
        if (!cancelled) setLoadError(cause instanceof Error ? cause.message : '读取 Agent 运行时配置失败。');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [loadAll]);

  if (loading) return <LoadingRows rows={3} />;
  if (loadError || !configEnv || !status || !form) {
    return <ErrorState message={loadError ?? '没有 Agent 运行时配置。'} onRetry={() => void loadAll()} />;
  }

  const set = <K extends keyof AgentConfigForm>(
    key: K,
    value: AgentConfigForm[K],
    sourceKey?: keyof FieldSource,
  ) => {
    setForm((f) => (f ? { ...f, [key]: value } : f));
    if (sourceKey) setSources((s) => markManual(s, sourceKey));
  };

  const timeoutMs = Number(timeoutSecText) * 1000;
  const recommended = pickRecommendedCandidate(detect ?? {
    detected_at: '', latency_ms: 0, candidates: [], recommended: null,
    config_patch: { provider: null, cli_path: null, model: null, timeout_ms: 0, working_directory: '', recommended_args: [], model_source: 'cli-config' },
    note: '',
  });

  const commitArg = () => {
    if (editingArg !== null) {
      const token = argInput.trim();
      if (!token) { setArgError('参数为空。'); return; }
      const others = form.args.filter((_, i) => i !== editingArg);
      if (/[;&|`$<>\\\n\r]/.test(token)) { setArgError('参数应逐项添加，不要包含 shell 符号。'); return; }
      if (others.includes(token)) { setArgError('该参数已存在。'); return; }
      set('args', form.args.map((a, i) => (i === editingArg ? token : a)), 'args');
      setArgInput(''); setEditingArg(null); setArgError(null);
      return;
    }
    const res = addArgToList(form.args, argInput);
    if (res.error) { setArgError(res.error); return; }
    set('args', res.args, 'args');
    setArgInput(''); setArgError(null);
  };

  const commitEnv = () => {
    const parsed = parseEnvName(envInput);
    if (!parsed.ok) { setEnvError(parsed.message ?? '变量名不合法。'); setEnvWarning(null); return; }
    if (form.allowed_env_names.includes(parsed.name)) { setEnvError('该变量名已在白名单里。'); setEnvWarning(null); return; }
    set('allowed_env_names', [...form.allowed_env_names, parsed.name]);
    setEnvInput(''); setEnvError(null);
    setEnvWarning(parsed.message ?? null);
  };

  const dirCheck = checkWorkingDir(form.working_directory);
  const formErrors = [
    ...validateConfig({ ...form, timeout_ms: Number.isFinite(timeoutMs) ? timeoutMs : NaN }),
    ...(dirCheck.error ? [dirCheck.error] : []),
  ];

  // 重新检测：POST persist=true（带当前 updated_at），后端只覆盖 auto 字段，再重新拉。
  const rerunDetect = async () => {
    setDetecting(true);
    try {
      await postRuntimeDetect({
        expected_version: configEnv.updated_at,
        persist: true,
      });
      await loadAll();
      toast.success('已重新检测本机 CLI');
    } catch {
      setDetectBroken(true);
      toast.message('自动检测失败，可继续手动配置');
    } finally {
      setDetecting(false);
    }
  };

  // 恢复自动值：把 detected.config_patch merge 到全 auto 的字段上，随 PUT 一起写回。
  const restoreAuto = async () => {
    if (!detect) { toast.message('还没有检测结果可恢复'); return; }
    const fresh = toForm(configEnv.config);
    const merged = applyDetectedRecommendation(fresh, allAutoSources(), detect);
    const { config, expected_version } = buildSavePayload(merged.form, configEnv.updated_at, allAutoSources());
    try {
      const saved = await saveRuntimeConfig(config, expected_version);
      setConfigEnv(saved);
      setForm(toForm(saved.config));
      setSources(allAutoSources());
      setTimeoutSecText(String(Math.round(saved.config.timeout_ms / 1000)));
      toast.success('已恢复为自动检测推荐值');
    } catch (cause) {
      if (isRuntimeConflict(cause)) { toast.warning('配置已在别处被修改，已刷新'); await loadAll(); }
      else toast.error(cause instanceof Error ? cause.message : '保存失败。');
    }
  };

  const save = async () => {
    if (formErrors.length) throw new Error(formErrors[0]);
    const {config, expected_version} = buildSavePayload({...form, timeout_ms: timeoutMs}, configEnv.updated_at, sources);
    const saved = await saveRuntimeConfig(config, expected_version);
    // Only acknowledge the server version; leave the editable form intact while typing continues.
    setConfigEnv(saved);
    setTestResult(null);
    void getRuntimeStatus().then(setStatus).catch(() => {});
  };

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testRuntimeConnection();
      setTestResult(result);
      toast[result.ok ? 'success' : 'error'](result.ok ? '连接测试成功：CLI 可用' : '连接测试失败');
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '连接测试失败。');
    } finally {
      setTesting(false);
    }
  };

  return (
    <RuntimeAutosave reload={async () => {
      const fresh = await loadAll();
      if (!fresh) throw new Error('读取运行时配置失败');
      setArgInput(''); setEnvInput(''); setEditingArg(null); setArgError(null); setEnvError(null);
      return {form: toForm(fresh.config), sources: sourcesFromRecord(fresh.config.field_sources),
        timeoutSecText: String(Math.round(fresh.config.timeout_ms / 1000)), argInput: '', envInput: '', editingArg: null};
    }} value={{form, sources, timeoutSecText, argInput, envInput, editingArg}} valid={!formErrors.length && !argInput.trim() && !envInput.trim() && editingArg === null} save={save}>
    {(saveStatus) => (
    <SectionCard
      title={APP_NAME + ' 助手'}
      description="用本机已登录的 Claude / Codex CLI 处理助手请求；关闭或不可用时自动回落到确定性本地命令。工作 Agent 留作后续扩展，目前不会在后台自动执行任务。"
      actions={
        <div className="flex items-center gap-2">
          {saveStatus}
          <Label htmlFor="agent-enabled" className="text-xs text-muted-foreground">启用</Label>
          <Switch id="agent-enabled" checked={form.enabled} onCheckedChange={(on) => set('enabled', on === true)} aria-label="启用 Agent 运行时" />
        </div>
      }
    >
      <div className="space-y-5">
        <RuntimeProviderChoices refreshKey={configEnv.updated_at} provider={form.provider} cliPath={form.cli_path} enabled={form.enabled} onSelect={candidate => {
          const merged = adoptCandidate(form, sources, candidate);
          setForm({...merged.form, enabled: true}); setSources(merged.source);
          setTimeoutSecText(String(merged.form.timeout_ms / 1000));
        }} />
        <AgentModelSelector provider={form.provider} cliPath={form.cli_path} model={form.model} refreshKey={configEnv.updated_at} onChange={value=>set('model',value,'model')} />
        <details><summary className="cursor-pointer text-xs text-muted-foreground">查看本机 CLI 检测详情</summary>
        {/* ── 自动检测详情 ── */}
        <div className="rounded-md border border-border bg-muted/30 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 text-sm font-medium">
              <ShieldCheck className="size-4 text-primary" />
              自动检测
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => void rerunDetect()} disabled={detecting}>
                {detecting ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                重新检测
              </Button>
              <Button size="sm" variant="outline" onClick={() => void restoreAuto()} disabled={!detect}>
                <RotateCcw />
                恢复自动值
              </Button>
            </div>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            纯本机探查：每个候选只跑 --version 与 --help，不联网、不调用模型、不产生计费调用，也不读密钥。
          </p>

          {detectBroken && !detect ? (
            <p className="mt-2 flex items-center gap-1 text-xs text-amber-700">
              <AlertTriangle className="size-3.5" />
              自动检测暂不可用，可在下方高级设置里手动填写。
            </p>
          ) : recommended ? (
            <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
              <span className="text-muted-foreground">提供方：<b className="font-normal text-foreground">{providerLabel(recommended.provider)}</b></span>
              <span className="text-muted-foreground">路径：<code className="font-mono">{recommended.path}</code></span>
              <span className="text-muted-foreground">版本：{recommended.version ?? '未知'}</span>
              <span className="text-muted-foreground">可运行：{recommended.exists && recommended.exit_code === 0 ? '是' : '否'}</span>
              <span className="text-muted-foreground">登录态：<Badge variant="outline" className="font-normal text-muted-foreground">未知</Badge></span>
              <span className="text-muted-foreground">检测延迟：{recommended.latency_ms} ms</span>
              <span className="text-muted-foreground">
                能力：{recommended.capabilities.help_checked
                  ? [recommended.capabilities.non_interactive && '非交互', recommended.capabilities.supports_model_flag && '--model', ...recommended.capabilities.output_formats.map((f) => `格式:${f}`)].filter(Boolean).join('、')
                  : 'help 未读到（保守默认）'}
              </span>
              <span className="text-muted-foreground">模型：由 CLI 配置决定</span>
              <span className="text-muted-foreground">默认目录：<code className="font-mono">{detect?.config_patch.working_directory ?? form.working_directory}</code></span>
              <span className="text-muted-foreground">推荐超时：{Math.round((detect?.config_patch.timeout_ms ?? form.timeout_ms) / 1000)} 秒</span>
              <span className="text-muted-foreground">推荐参数：{detect && detect.config_patch.recommended_args.length ? detect.config_patch.recommended_args.join(' ') : '（无）'}</span>
              <span className="text-muted-foreground">检测时间：{detect?.detected_at ? new Date(detect.detected_at).toLocaleTimeString() : '—'}</span>
            </div>
          ) : (
            <p className="mt-2 text-xs text-muted-foreground">还没有检测到可用 CLI。点「重新检测」开始。</p>
          )}

          {detect && detect.candidates.length > 1 ? (
            <div className="mt-3 space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">检测到多个 CLI：</p>
              {detect.candidates.map((c: DetectedCandidate) => (
                <button
                  key={c.path}
                  type="button"
                  onClick={() => {
                    const merged = adoptCandidate(form, sources, c);
                    setForm(merged.form);
                    setSources(merged.source);
                    setTimeoutSecText(String(merged.form.timeout_ms / 1000));
                    toast.message(`已选择 ${providerLabel(c.provider)}，稍后自动保存。`);
                  }}
                  className="flex w-full flex-wrap items-center gap-2 rounded-md border border-border bg-background px-2.5 py-1.5 text-left text-xs hover-elevate"
                >
                  <b className="font-medium">{providerLabel(c.provider)}</b>
                  <code className="font-mono text-muted-foreground">{c.path}</code>
                  <span className="text-muted-foreground">v{c.version ?? '?'}</span>
                  <Badge variant="outline" className="font-normal text-muted-foreground">未知</Badge>
                </button>
              ))}
            </div>
          ) : null}
        </div>

        </details>

        {/* ── 当前健康 ── */}
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className={cn('font-normal', TONE_CLASS[healthMeta(status.health).tone])}>
            {status.enabled ? healthMeta(status.health).label : '助手已关闭，选择上方入口即可启用'}
          </Badge>
          <Badge variant="outline" className="font-normal text-muted-foreground">
            {providerLabel(status.provider)}
          </Badge>
        </div>

        {/* ── 高级设置（折叠）：可手动覆盖，改完即标 manual ── */}
        <Collapsible className="space-y-3">
          <CollapsibleTrigger asChild>
            <Button type="button" variant="ghost" size="sm" className="text-muted-foreground">
              高级设置（手动覆盖）
              <Pencil className="size-3" />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <div className="flex items-center gap-1.5">
                  <Label htmlFor="agent-provider">CLI Provider</Label>
                  <SourceBadge source={sources.provider} />
                </div>
                <Select value={form.provider} onValueChange={(v) => set('provider', v as AgentRuntimeProvider, 'provider')}>
                  <SelectTrigger id="agent-provider" className="bg-card! w-full"><SelectValue placeholder="选择 provider" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="claude">Claude</SelectItem>
                    <SelectItem value="codex">Codex</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center gap-1.5">
                  <Label htmlFor="agent-cli-path">CLI 路径（绝对路径）</Label>
                  <SourceBadge source={sources.cli_path} />
                </div>
                <Input id="agent-cli-path" value={form.cli_path} onChange={(e) => set('cli_path', e.target.value, 'cli_path')} placeholder="CLI 可执行文件的完整路径" className="bg-card!" autoComplete="off" spellCheck={false} />
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5">
                <Label htmlFor="agent-arg">命令行参数（逐项添加，非 shell 字符串）</Label>
                <SourceBadge source={sources.args} />
              </div>
              <div className="flex gap-2">
                <Input id="agent-arg" value={argInput} onChange={(e) => setArgInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitArg(); } }} placeholder={editingArg !== null ? '编辑后回车或点更新' : '填写一个参数，回车或点添加'} className="bg-card!" autoComplete="off" spellCheck={false} />
                <Button type="button" size="sm" variant="outline" onClick={commitArg}>
                  <Plus />
                  {editingArg !== null ? '更新' : '添加'}
                </Button>
                {editingArg !== null ? <Button type="button" size="sm" variant="ghost" onClick={() => {setEditingArg(null); setArgInput(''); setArgError(null);}}>取消编辑</Button> : null}
              </div>
              {argError ? <p className="text-xs text-red-600">{argError}</p> : null}
              {form.args.length > 0 ? (
                <ul className="flex flex-wrap gap-1.5 pt-1">
                  {form.args.map((arg, i) => (
                    <li key={`${arg}-${i}`}>
                      <Badge variant="outline" className="gap-1 font-mono font-normal">
                        {arg}
                        <button type="button" aria-label={`编辑参数 ${arg}`} onClick={() => { setArgInput(arg); setEditingArg(i); setArgError(null); }} className="text-muted-foreground hover:text-foreground"><Pencil className="size-3" /></button>
                        <button type="button" aria-label={`移除参数 ${arg}`} onClick={() => { set('args', form.args.filter((_, j) => j !== i), 'args'); if (editingArg === i) { setEditingArg(null); setArgInput(''); } }} className="text-muted-foreground hover:text-red-600"><X className="size-3" /></button>
                      </Badge>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5">
                <Label htmlFor="agent-timeout">超时（秒）</Label>
                <SourceBadge source={sources.timeout_ms} />
              </div>
              <Input id="agent-timeout" type="number" min={TIMEOUT_MS_MIN / 1000} max={TIMEOUT_MS_MAX / 1000} value={timeoutSecText} onChange={(e) => { setTimeoutSecText(e.target.value); setSources((s) => markManual(s, 'timeout_ms')); }} className="bg-card! sm:max-w-[10rem]" />
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5">
                <Label htmlFor="agent-dir">工作目录（项目目录内的绝对路径）</Label>
                <SourceBadge source={sources.working_directory} />
              </div>
              <Input id="agent-dir" value={form.working_directory} onChange={(e) => { set('working_directory', e.target.value, 'working_directory'); setDirError(checkWorkingDir(e.target.value).error ?? null); }} placeholder="PrinceQ 项目目录或其子目录" className="bg-card!" autoComplete="off" spellCheck={false} />
              <p className={cn('text-xs', dirError ? 'text-red-600' : 'text-muted-foreground')}>
                {dirError ?? '必须落在项目目录内，不能让 CLI 在别处读写文件。'}
              </p>
            </div>
          </CollapsibleContent>
        </Collapsible>

        {/* env：只变量名，绝不值 */}
        <div className="space-y-1.5">
          <Label htmlFor="agent-env">环境变量白名单（只填大写名字）</Label>
          <div className="flex gap-2">
            <Input id="agent-env" value={envInput} onChange={(e) => { setEnvInput(e.target.value); setEnvError(null); }} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitEnv(); } }} placeholder="例如 PATH 或 ANTHROPIC_API_KEY" className="bg-card! font-mono" autoComplete="off" spellCheck={false} />
            <Button type="button" size="sm" variant="outline" onClick={commitEnv}><Plus />添加</Button>
          </div>
          {envError ? <p className="text-xs text-red-600">{envError}</p> : null}
          {envWarning ? <p className="flex items-center gap-1 text-xs text-amber-700"><AlertTriangle className="size-3" />{envWarning}</p> : null}
          {form.allowed_env_names.length > 0 ? (
            <ul className="flex flex-wrap gap-1.5 pt-1">
              {form.allowed_env_names.map((name) => (
                <li key={name}>
                  <Badge variant="outline" className="gap-1 font-mono font-normal">
                    {name}
                    <button type="button" aria-label={`移除环境变量 ${name}`} onClick={() => set('allowed_env_names', form.allowed_env_names.filter((n) => n !== name))} className="text-muted-foreground hover:text-red-600"><X className="size-3" /></button>
                  </Badge>
                </li>
              ))}
            </ul>
          ) : null}
          <p className="text-xs text-muted-foreground">逐项添加后自动保存。只记录变量名，不显示或保存密钥值。</p>
        </div>

        {testResult ? (
          <div className="space-y-1">
            <p className={cn('flex items-center gap-1 text-xs', testResult.ok ? 'text-emerald-700' : 'text-red-600')}>
              {testResult.ok ? <CheckCircle2 className="size-3.5" /> : <AlertTriangle className="size-3.5" />}
              {testResult.ok ? (testResult.warnings?.some(warning => !dismissed.has(warning.code)) ? '连接正常，CLI 有警告。' : '连接正常。') : `连接失败：${healthMeta(testResult).label}`}
            </p>
            <AgentWarnings warnings={testResult.warnings} />
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button size="sm" variant="outline" disabled={testing}>
                {testing ? <Loader2 className="animate-spin" /> : <FlaskConical />}
                测试连接
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>连接测试会真实启动 CLI</AlertDialogTitle>
                <AlertDialogDescription>
                  这会真实启动**已保存的 CLI**，执行一次固定的无副作用问答（会真正发一次请求），
                  可能产生服务端调用与用量。它不写入你的任务/目标数据库。确认继续？
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>取消</AlertDialogCancel>
                <AlertDialogAction onClick={() => void runTest()}>
                  {testing ? '测试中…' : '继续测试'}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
        {formErrors.length > 0 ? <p className="text-xs text-red-600">{formErrors[0]}</p> : null}
      </div>
    </SectionCard>)}
    </RuntimeAutosave>
  );
}

function RuntimeAutosave({value, valid, save, reload, children}: {
  value: unknown; valid: boolean; save: () => Promise<unknown>; reload: () => Promise<unknown>; children: (status: React.ReactNode) => React.ReactNode;
}) {
  const autosave = useSettingsAutosave(value, valid, save);
  // Config-changing detect/restore and the connection-test trigger must wait for pending edits.
  const guard = (event: React.MouseEvent<HTMLDivElement>) => {
    const button = (event.target as HTMLElement).closest('button');
    if (!button || !['重新检测', '恢复自动值', '测试连接', '继续测试'].includes(button.textContent?.trim() ?? '')) return;
    if (autosave.state !== 'saved') {
      event.stopPropagation(); event.preventDefault();
      void autosave.flush();
      toast.message('正在保存当前设置，请保存完成后再操作。');
    }
  };
  return <div {...autosave.events} onClickCapture={guard} className="space-y-2">
    {children(<AutosaveStatus state={autosave.state} message={autosave.message} retry={autosave.retry}
      onReload={async () => {const fresh = await reload(); autosave.reset(fresh);}} />)}
  </div>;
}
