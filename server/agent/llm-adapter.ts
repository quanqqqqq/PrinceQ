/**
 * 真实模型适配器：把一条用户消息交给本地 CLI（claude / codex），再把回答收敛成
 * 既有的 `AgentResult` 形状。
 *
 * 喂给模型的是固定 PrinceQ 指令与完整只读工作快照、同一会话历史。模型不应调用工具、没有
 * SQLite、没有文件写、没有 shell；它唯一能表达的「写意图」就是输出一个
 * `proposed_actions` 数组，而那个数组只会变成一行待确认预览（见
 * `./pending-actions.ts`）。因此本模块里**没有任何一处写业务表**。
 *
 * 超时、取消和无有效回答抛 AgentRuntimeError；有效回答伴非零退出保留并单列警告。
 * 仅请求明确允许才回退命令模式，不能把规则结果冒充模型回答。
 */
import {recordAgentConnection} from './provider-connections.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {composePrinceQSystemPrompt} from '../skills/injection.ts';
import {describePendingAction} from './preview-description.ts';
import { goalDraftFingerprint, normalizeGoalDraftActions } from './goal-draft-contract.ts';
import type { AgentResult, AgentRuntimeProvider, AgentWarning } from '../../shared/types.ts';
import {buildPrinceQContext, serializePrinceQContext, readPrinceQSystemPrompt} from './prompt-context.ts';
import { buildProviderPromptArgs, runCli } from './cli-exec.ts';
import { normalizeCliOutput, isOkReply } from './output.ts';
import { pendingActionSchema, savePendingActions, type PendingAction } from './pending-actions.ts';
import type { AgentRuntimeConfig } from './runtime-config.ts';
import type { AgentRequest } from './runtime.ts';

/** 一次 agent 调用的失败类型。`kind` 直接回显给用户，所以保持可读。 */
export class AgentRuntimeError extends Error {
  readonly kind: string;

  constructor(kind: string, message: string) {
    super(message);
    this.name = 'AgentRuntimeError';
    this.kind = kind;
  }
}

export interface LlmOutcome {
  result: AgentResult;
  invalidates: ('tasks' | 'goals' | 'queue' | 'activity' | 'habits')[];
  mode: 'agent';
  source: 'agent' | 'agent-error';
}

interface ParsedReply {
  answer: string;
  actions: PendingAction[];
  dropped: number;
}

/**
 * 解析 CLI 的 stdout。
 *
 * 容忍模型在 JSON 前后夹带文字：截取首个 `{` 到末个 `}` 再试。解析不出结构就把整段
 * 当纯文本回答——「模型话多」不该变成报错，但**非法的动作一定被丢弃并计数**。
 */
export function parseAgentReply(stdout: string): ParsedReply {
  const text = stdout.trim();
  if (!text) return { answer: '（模型没有输出内容。）', actions: [], dropped: 0 };

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return { answer: text, actions: [], dropped: 0 };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return { answer: text, actions: [], dropped: 0 };
  }

  const obj = parsed as Record<string, unknown> | null;
  if (!obj || typeof obj !== 'object' || typeof obj.answer !== 'string') {
    return { answer: text, actions: [], dropped: 0 };
  }

  const actions: PendingAction[] = [];
  let dropped = 0;
  const proposed = Array.isArray(obj.proposed_actions) ? obj.proposed_actions : [];
  for (const candidate of proposed) {
    const result = pendingActionSchema.safeParse(candidate);
    if (result.success) actions.push(result.data);
    else dropped += 1;
  }

  return { answer: obj.answer, actions, dropped };
}

export interface RunAgentOptions {
  sessionId?: string | null;
}

/**
 * 跑一轮 agent。调用方（路由）负责先确认 `isAgentReady`。
 */
export async function runAgentMessage(
  req: AgentRequest & { fallback?: boolean },
  cfg: AgentRuntimeConfig,
  opts: RunAgentOptions = {},
): Promise<LlmOutcome> {
  let prompt: string;
  let systemPrompt: string;
  let goalDraftSnapshot: string | null = null;
  let existingGoalTaskTitles: string[] = [];
  try {
    const context = buildPrinceQContext(req, cfg, opts.sessionId);
    if (req.intent === 'goal_task_drafts') {
      if (!req.targetGoalId) throw new Error('missing selected goal');
      goalDraftSnapshot = goalDraftFingerprint(req.db, req.targetGoalId);
      existingGoalTaskTitles = context.work_snapshot.tasks.filter(task => task.goal_id === req.targetGoalId).map(task => task.title);
    }
    prompt = serializePrinceQContext(context);
    systemPrompt = composePrinceQSystemPrompt(readPrinceQSystemPrompt(), context);
    if (Buffer.byteLength(prompt, 'utf8') + Buffer.byteLength(systemPrompt, 'utf8') > 2 * 1024 * 1024) throw new Error('PRINCEQ_CONTEXT_TOO_LARGE');
  }
  catch (cause) {
    if (cause instanceof Error && cause.message === 'PRINCEQ_CONTEXT_TOO_LARGE') {
      throw new AgentRuntimeError('context_too_large', '完整工作上下文超过 2 MiB，本次没有截断或发送。请缩短当前会话或减少过大的任务描述后重试。');
    }
    throw new AgentRuntimeError('context_unavailable', '读取完整工作上下文失败，本次没有调用模型。请检查任务或习惯数据后重试。');
  }
  // Both providers read a unique private instruction file, so even large settings stay out of argv.
  const instructionDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'princeq-instructions-'));
  let exec: Awaited<ReturnType<typeof runCli>>;
  try {
    const systemPromptFile = path.join(instructionDirectory, 'system.md');
    fs.writeFileSync(systemPromptFile, systemPrompt, {mode:0o600});
    const args = buildProviderPromptArgs(cfg.provider, '', cfg, {systemPrompt, systemPromptFile, promptViaStdin:true});
    exec = await runCli({executable:cfg.cli_path,args,cwd:cfg.working_directory,envNames:cfg.allowed_env_names,
      timeoutMs:cfg.timeout_ms,provider:cfg.provider,input:prompt});
  } finally {
    if (instructionDirectory) fs.rmSync(instructionDirectory, {recursive:true,force:true});
  }

  if (exec.timedOut) {
    recordAgentConnection(cfg, false, exec.exitCode);
    throw new AgentRuntimeError('timeout', `CLI 超过 ${cfg.timeout_ms}ms 未返回，已终止。`);
  }
  if (exec.canceled) {
    throw new AgentRuntimeError('canceled', '调用被取消。');
  }
  const normalized = normalizeCliOutput(cfg.provider, exec);
  if (!normalized.valid) {
    recordAgentConnection(cfg, false, exec.exitCode);
    throw new AgentRuntimeError(
      exec.exitCode !== 0 ? 'nonzero_exit' : 'no_answer',
      normalized.warnings.some(w => w.code === 'model_config_warning')
        ? 'CLI 本机模型配置有警告，且未返回有效回答。'
        : 'CLI 未返回有效的助手回答。',
    );
  }

  // A real valid answer establishes connectivity without persisting conversation content.
  recordAgentConnection(cfg, true, exec.exitCode);
  const reply = parseAgentReply(normalized.answer);
  if (req.intent === 'goal_task_drafts') {
    try {
      if (goalDraftSnapshot !== goalDraftFingerprint(req.db, req.targetGoalId!)) {
        throw new Error('生成期间目标或已有任务改变了，请按最新信息重新生成。');
      }
      reply.actions = normalizeGoalDraftActions(reply.actions, req.targetGoalId!, existingGoalTaskTitles, reply.dropped);
    } catch (cause) {
      throw new AgentRuntimeError('preview_invalid', cause instanceof Error ? cause.message : '目标任务草稿不符合要求。');
    }
  }
  if (reply.dropped) reply.answer += `\n\n其中 ${reply.dropped} 条操作不受支持，未执行；只有有效的待确认预览能用于后续写入。`;
  const droppedNote = reply.dropped
    ? [`丢弃了 ${reply.dropped} 条不在白名单内的建议动作。`]
    : [];

  if (reply.actions.length === 0) {
    return {
      result: {
        kind: 'answer',
        headline: reply.answer.slice(0, 200),
        answer: reply.answer,
        warnings: normalized.warnings,
        provider: cfg.provider,
        reasoning: [
          `由本地 ${cfg.provider} CLI 回答，模型没有建议任何写动作。`,
          ...droppedNote,
        ],
        blocks: [],
        pending_action: null,
        matched_command: null,
        mode: 'agent',
      },
      invalidates: [],
      mode: 'agent',
      source: 'agent',
    };
  }

  const summary = `模型建议 ${reply.actions.length} 个动作，待确认`;
  let token: string;
  try {
    token = savePendingActions(req.db, {sessionId:opts.sessionId??null,summary,actions:reply.actions});
  } catch {
    throw new AgentRuntimeError('preview_invalid', '建议动作未通过预览校验，尚未执行。请检查对象版本和操作字段，或将设置修改拆成独立预览后重试。');
  }

  return {
    result: {
      kind: 'preview',
      headline: reply.answer.slice(0, 200),
      answer: reply.answer,
      warnings: normalized.warnings,
      provider: cfg.provider,
      reasoning: [
        `由本地 ${cfg.provider} CLI 生成，${reply.actions.length} 个动作**尚未执行**。`,
        '确认之后才会由确定性服务落库；取消则一个字都不写。',
        ...droppedNote,
      ],
      blocks: [
        {
          type: 'list',
          title: '待确认的动作',
          items: reply.actions.map(action => describePendingAction(req.db, action)),
        },
      ],
      pending_action: {
        token,
        command: 'agent.preview',
        summary,
        affected_task_ids: [],
      },
      matched_command: null,
      mode: 'agent',
    },
    invalidates: [],
    mode: 'agent',
    source: 'agent',
  };
}

export interface ConnectionTestResult {
  ok: boolean;
  stdout_excerpt: string;
  exit_code: number;
  timed_out: boolean;
  reason: string | null;
  warnings: AgentWarning[];
  status: 'success' | 'success_with_warning' | 'failure';
}

/**
 * 连通性测试：**只发一句固定字符串**，不带任何业务上下文、不建 session、不写库。
 *
 * 用户点「测试连接」只想知道「这个可执行文件能不能应答」，没理由把队列内容送出去。
 */
export async function runConnectionTest(cfg: AgentRuntimeConfig): Promise<ConnectionTestResult> {
  const args = buildProviderPromptArgs(cfg.provider, '只回复OK，不调用工具，不读取任何文件，不执行命令。', cfg);
  const exec = await runCli({
    executable: cfg.cli_path,
    args,
    cwd: cfg.working_directory,
    envNames: cfg.allowed_env_names,
    timeoutMs: cfg.timeout_ms,
    provider: cfg.provider,
  });

  const normalized = normalizeCliOutput(cfg.provider, exec);
  const ok = !exec.timedOut && !exec.canceled && normalized.valid && isOkReply(normalized.answer);
  return {
    ok,
    stdout_excerpt: normalized.answer.slice(0, 200),
    exit_code: exec.exitCode,
    timed_out: exec.timedOut,
    warnings: normalized.warnings,
    status: ok ? (normalized.warnings.length ? 'success_with_warning' : 'success') : 'failure',
    reason: ok ? null : exec.timedOut ? 'timeout' : exec.canceled ? 'canceled'
      : normalized.warnings.some(w => w.code === 'model_config_warning') ? 'model_config_warning'
      : exec.exitCode !== 0 ? 'nonzero_exit' : 'no_ok_in_output',
  };
}

/** provider 的中文展示名，给状态路由与文档共用。 */
export const PROVIDER_LABELS: Record<AgentRuntimeProvider, string> = {
  claude: 'Claude CLI',
  codex: 'Codex CLI',
};
