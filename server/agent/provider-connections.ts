/** Connection evidence is independent of the enabled switch and never touches business data. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { AgentRuntimeConfig, AgentRuntimeProvider } from '../../shared/types.ts';
import { agentRuntimeConfigPath } from '../config.ts';
import { badRequest } from '../lib/errors.ts';
import { detectCli, type DetectedCandidate } from './detect.ts';
import { buildProviderPromptArgs } from './cli-exec.ts';
import type {ConnectionTestResult} from './llm-adapter.ts';

export interface ConnectionEvidence extends ConnectionTestResult { checked_at: string; provider: AgentRuntimeProvider; }
export interface ProviderEntry {
  provider: AgentRuntimeProvider;
  candidate: DetectedCandidate | null;
  connection: ConnectionEvidence | null;
}
export const providerTimeout = (provider: AgentRuntimeProvider) => provider === 'codex' ? 120000 : 60000;
const cachePath = () => agentRuntimeConfigPath() + '.connections.json';
export function runtimeConnectionKey(cfg: AgentRuntimeConfig) {
  let executableVersion: number | null = null;
  try { executableVersion = fs.statSync(cfg.cli_path).mtimeMs; } catch { /* missing file cannot be trusted */ }
  return createHash('sha256').update(JSON.stringify({provider: cfg.provider, path: cfg.cli_path, executableVersion,
    args: buildProviderPromptArgs(cfg.provider, 'connection-check', cfg), cwd: cfg.working_directory,
    timeout: cfg.timeout_ms, env: [...new Set(cfg.allowed_env_names)].sort()})).digest('hex');
}
function readEvidence(): Record<string, ConnectionEvidence> {
  try {
    const entries: unknown = JSON.parse(fs.readFileSync(cachePath(), 'utf8'));
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return {};
    return Object.fromEntries(Object.entries(entries).filter(([, value]) => value && typeof value === 'object' &&
      typeof value.ok === 'boolean' && typeof value.stdout_excerpt === 'string' && typeof value.exit_code === 'number' &&
      typeof value.timed_out === 'boolean' && Array.isArray(value.warnings) &&
      value.warnings.every((warning: unknown) => warning && typeof warning === 'object' && 'code' in warning && typeof warning.code === 'string' && 'message' in warning && typeof warning.message === 'string') &&
      typeof value.checked_at === 'string' && Number.isFinite(Date.parse(value.checked_at))));
  } catch { return {}; }
}
export function connectionFor(cfg: AgentRuntimeConfig): ConnectionEvidence | null {
  const value = readEvidence()[runtimeConnectionKey(cfg)];
  return value && typeof value.ok === 'boolean' && typeof value.checked_at === 'string' &&
    Number.isFinite(Date.parse(value.checked_at)) ? {...value, provider: cfg.provider} : null;
}
function saveEvidence(cfg: AgentRuntimeConfig, result: ConnectionEvidence) {
  const file = cachePath();
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const values = {...readEvidence(), [runtimeConnectionKey(cfg)]: result};
  const recent = Object.fromEntries(Object.entries(values).sort((a,b) => b[1].checked_at.localeCompare(a[1].checked_at)).slice(0, 30));
  const tmp = file + '.' + randomUUID() + '.tmp';
  try { fs.writeFileSync(tmp, JSON.stringify(recent, null, 2), {mode: 0o600}); fs.renameSync(tmp, file); }
  finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}
/** Record real connectivity without storing conversation content. */
export function recordAgentConnection(cfg:AgentRuntimeConfig,ok:boolean,exitCode=0) {
  saveEvidence(cfg,{ok,stdout_excerpt:ok?'有效的 Agent 回复':'',exit_code:exitCode,timed_out:false,
    reason:ok?null:'agent_unavailable',warnings:[],status:ok?'success':'failure',
    provider:cfg.provider,checked_at:new Date().toISOString()});
}
export function candidateConfig(cfg: AgentRuntimeConfig, candidate: Pick<DetectedCandidate, 'provider' | 'path'>): AgentRuntimeConfig {
  if (cfg.provider === candidate.provider && cfg.cli_path === candidate.path) return {...cfg, enabled: true};
  // A provider switch uses that CLI's own model and arguments, never the other provider's overrides.
  return {...cfg, enabled: true, provider: candidate.provider, cli_path: candidate.path,
    model: null, args: [], timeout_ms: providerTimeout(candidate.provider)};
}
export async function listRuntimeProviders(cfg: AgentRuntimeConfig): Promise<{providers: ProviderEntry[]}> {
  const detection = await detectCli();
  const providers = (['claude', 'codex'] as const).map(provider => {
    const candidates = detection.candidates.filter(item => item.provider === provider && item.exists && item.exit_code === 0);
    const candidate = candidates.find(item => item.path === cfg.cli_path && cfg.provider === provider) ?? candidates[0] ?? null;
    return {provider, candidate, connection: candidate ? connectionFor(candidateConfig(cfg, candidate)) : null};
  });
  return {providers};
}
export async function testRuntimeProvider(cfg: AgentRuntimeConfig, target?: {provider: AgentRuntimeProvider; cli_path: string}) {
  let tested = {...cfg, enabled: true};
  if (target) {
    const detection = await detectCli({provider: target.provider});
    const candidate = detection.candidates.find(item => item.provider === target.provider && item.path === target.cli_path && item.exists && item.exit_code === 0);
    if (!candidate) throw badRequest('只能验证本机检测到的可用 CLI，请重新检测后再试。');
    tested = candidateConfig(cfg, candidate);
  }
  if (!tested.cli_path) throw badRequest('尚未配置可用 CLI，请先检测并选择 Claude 或 Codex。');
  const started = Date.now();
  const {runConnectionTest} = await import('./llm-adapter.ts');
  const result = await runConnectionTest(tested);
  const evidence = {...result, provider: tested.provider, checked_at: new Date().toISOString()};
  saveEvidence(tested, evidence);
  return {...evidence, provider: tested.provider, cli_path: tested.cli_path, latency_ms: Date.now() - started};
}
