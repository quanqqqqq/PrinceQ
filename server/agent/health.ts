/**
 * CLI 可用性探测 + 带 TTL 的健康缓存。
 *
 * 为什么要缓存：`/api/agent/message` 每一轮都要先回答「现在能不能走 agent」。如果
 * 每次都 spawn 一次 `--version`，用户每发一句话就多付一次进程启动的延迟。TTL 做成
 * 10 秒：足够挡住连续对话，又短到配置改完/CLI 装好之后很快自愈。
 *
 * `isAgentReady` 只做廉价的 fs 检查、**从不 spawn**，因为它在请求路径上同步调用。
 */
import fs from 'node:fs';
import { runCli } from './cli-exec.ts';
import type { AgentRuntimeConfig } from './runtime-config.ts';

export interface HealthSnapshot {
  ok: boolean;
  reason: string | null;
  checkedAt: string;
}

/** 探测 `--version` 的上限：这一步只是确认二进制能跑起来，不该等满业务超时。 */
const PROBE_TIMEOUT_CAP_MS = 5000;

export const HEALTH_TTL_MS = 10_000;

let healthCache: { checkedAt: number; ok: boolean; reason: string | null; key: string } | null = null;
const configKey = (cfg: AgentRuntimeConfig) => JSON.stringify({enabled: cfg.enabled, provider: cfg.provider,
  path: cfg.cli_path, cwd: cfg.working_directory, env: cfg.allowed_env_names, timeout: cfg.timeout_ms});

/** 配置一变、或 agent 调用刚失败过，就把缓存作废，下一次重新探测。 */
export function invalidateHealth(): void {
  healthCache = null;
}

/** 测试用的读取口，避免测试去碰模块私有变量。 */
export function peekHealth(): { ok: boolean; reason: string | null } | null {
  return healthCache ? { ok: healthCache.ok, reason: healthCache.reason } : null;
}

/** 磁盘上这个路径是不是一个可执行文件。不 spawn。 */
function executableOnDisk(cliPath: string): { ok: boolean; reason: string | null } {
  if (!cliPath) return { ok: false, reason: 'cli_not_found' };
  try {
    const stat = fs.statSync(cliPath);
    if (!stat.isFile()) return { ok: false, reason: 'cli_not_found' };
  } catch {
    return { ok: false, reason: 'cli_not_found' };
  }
  try {
    fs.accessSync(cliPath, fs.constants.X_OK);
  } catch {
    return { ok: false, reason: 'cli_not_executable' };
  }
  return { ok: true, reason: null };
}

/**
 * 刷新健康状态。`force` 时忽略 TTL（状态路由要的是实时结果）。
 */
export async function refreshHealth(
  cfg: AgentRuntimeConfig,
  opts: { force?: boolean } = {},
): Promise<HealthSnapshot> {
  const now = Date.now();
  if (!opts.force && healthCache?.key === configKey(cfg) && now - healthCache.checkedAt < HEALTH_TTL_MS) {
    return {
      ok: healthCache.ok,
      reason: healthCache.reason,
      checkedAt: new Date(healthCache.checkedAt).toISOString(),
    };
  }

  const record = (ok: boolean, reason: string | null): HealthSnapshot => {
    const checkedAt = Date.now();
    healthCache = { checkedAt, ok, reason, key: configKey(cfg) };
    return { ok, reason, checkedAt: new Date(checkedAt).toISOString() };
  };

  if (!cfg.enabled) return record(false, 'disabled');

  const onDisk = executableOnDisk(cfg.cli_path);
  if (!onDisk.ok) return record(false, onDisk.reason);

  const probe = await runCli({
    executable: cfg.cli_path,
    args: ['--version'],
    cwd: cfg.working_directory,
    envNames: cfg.allowed_env_names,
    timeoutMs: Math.min(cfg.timeout_ms, PROBE_TIMEOUT_CAP_MS),
    provider: cfg.provider,
  });

  if (probe.exitCode === 0) return record(true, null);
  return record(false, 'cli_probe_failed');
}

/**
 * 同步、廉价的「现在可以走 agent 吗」。
 *
 * 要求三件事同时成立：配置开着、CLI 在磁盘上可执行、而且**最近一次探测是 ok 的**。
 * 最后一条让「从没探测过」默认走确定性模式——宁可退回命令解析，也不要把用户的
 * 第一句话送进一个还没验证过的可执行文件。
 */
export function isAgentReady(cfg: AgentRuntimeConfig): boolean {
  if (!cfg.enabled) return false;
  if (!executableOnDisk(cfg.cli_path).ok) return false;
  return healthCache?.key === configKey(cfg) && healthCache.ok === true;
}

/** `isAgentReady` 为假时，给用户一句能对上的原因。 */
export function notReadyReason(cfg: AgentRuntimeConfig): string {
  if (!cfg.enabled) return 'not_enabled';
  const onDisk = executableOnDisk(cfg.cli_path);
  if (!onDisk.ok) return onDisk.reason ?? 'cli_not_found';
  if (!healthCache || healthCache.key !== configKey(cfg)) return 'health_unknown';
  return healthCache.reason ?? 'cli_probe_failed';
}
