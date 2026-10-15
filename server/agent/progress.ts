import type {AgentProgressPhase, AgentProgressView} from '../../shared/types.ts';

const progress = new Map<string, AgentProgressView>();
const TERMINAL_TTL_MS = 2 * 60 * 1000;

const MESSAGES: Record<AgentProgressPhase, string> = {
  checking: '正在检查 Agent 运行状态',
  context: '正在整理当前对话、任务、目标和习惯上下文',
  calling: '上下文已准备，正在调用本机 Agent',
  response: 'Agent 已开始返回内容，正在接收结果',
  validation: '正在解析答复并校验待确认操作',
  complete: '答复已生成',
  failed: '本轮处理未完成',
};

export function updateAgentProgress(
  requestId: string | undefined,
  phase: AgentProgressPhase,
): void {
  if (!requestId) return;
  const previous = progress.get(requestId);
  const now = new Date().toISOString();
  const state: AgentProgressView = {
    request_id: requestId,
    phase,
    message: MESSAGES[phase],
    summary_text: previous?.summary_text,
    started_at: previous?.started_at ?? now,
    updated_at: now,
  };
  progress.set(requestId, state);
  if (phase === 'complete' || phase === 'failed') {
    const timer = setTimeout(() => progress.delete(requestId), TERMINAL_TTL_MS);
    timer.unref?.();
  }
}

export function appendAgentProgressSummary(requestId: string | undefined, delta: string): void {
  if (!requestId || !delta) return;
  const previous = progress.get(requestId);
  if (!previous || previous.summary_text?.length === 1200) return;
  const remaining = 1200 - (previous.summary_text?.length ?? 0);
  progress.set(requestId, {
    ...previous,
    summary_text: `${previous.summary_text ?? ''}${delta.slice(0, remaining)}`,
    updated_at: new Date().toISOString(),
  });
}

export function readAgentProgress(requestId: string): AgentProgressView | null {
  return progress.get(requestId) ?? null;
}
