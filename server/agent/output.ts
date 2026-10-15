/** Provider output normalization. Diagnostics never become the assistant answer. */
import type { AgentRuntimeProvider, AgentWarning } from '../../shared/types.ts';
import type { ExecResult } from './cli-exec.ts';

const clean = (text: string): string => text
  // eslint-disable-next-line no-control-regex -- Strip CLI ANSI sequences.
  .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
  // eslint-disable-next-line no-control-regex -- Strip nonprinting control bytes.
  .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim();

const diagnostic = /^(?:warning\b|error\b|\[claude-code:|\[.*(?:warning|error)\]|openai codex\b|codex v\d|tokens? used\b|reading additional input from stdin|permission allow rule|authentication (?:failed|required)|not logged in|api error\b)/i;
const metadata = /^(?:[-=]{3,}|workdir:|model:|provider:|approval:|sandbox:|reasoning (?:effort|summaries):|session id:|mcp startup:|hook(?:s)?:|tokens? used|\d[\d,]*$)/i;

export interface NormalizedCliOutput {
  answer: string;
  valid: boolean;
  warnings: AgentWarning[];
}

function normalizeClaudeStream(text: string): {recognized: boolean; answer: string; failed: boolean} {
  let recognized = false;
  let failed = false;
  let streamedText = '';
  let finalResult = '';
  let assistantText = '';
  for (const line of text.split(/\r?\n/).filter((part) => part.trim())) {
    let outer: Record<string, any>;
    try { outer = JSON.parse(line) as Record<string, any>; } catch { continue; }
    if (outer.type === 'result') {
      recognized = true;
      failed ||= Boolean(outer.is_error) || /error/i.test(String(outer.subtype ?? ''));
      if (typeof outer.result === 'string') finalResult = outer.result;
      continue;
    }
    if (outer.type === 'stream_event' && outer.event && typeof outer.event === 'object') {
      recognized = true;
      const event = outer.event as Record<string, any>;
      const delta = event.delta as Record<string, any> | undefined;
      if (event.type === 'content_block_delta' && delta?.type === 'text_delta' && typeof delta.text === 'string') {
        streamedText += delta.text;
      }
      continue;
    }
    if (outer.type === 'assistant' && outer.message && Array.isArray(outer.message.content)) {
      recognized = true;
      for (const block of outer.message.content) {
        if (block?.type === 'text' && typeof block.text === 'string') assistantText += block.text;
      }
    }
  }
  return {
    recognized,
    answer: clean(streamedText || assistantText || finalResult),
    failed,
  };
}

export function normalizeCliOutput(provider: AgentRuntimeProvider, exec: ExecResult): NormalizedCliOutput {
  let text = clean(exec.stdout);
  const stderr = clean(exec.stderr);
  const warnings: AgentWarning[] = [];
  const warn = (code: AgentWarning['code'], message: string) => {
    if (!warnings.some(w => w.code === code)) warnings.push({ code, message });
  };
  if (/unrecognized_model|unknown model|model.*(?:not found|not recognized|isn't described)/i.test(stderr)) {
    warn('model_config_warning', 'CLI 本机模型配置有警告，可检查模型映射或在高级设置中指定模型。');
  } else if (stderr) {
    warn('cli_warning', 'CLI 返回诊断提示，已与回答正文分开。');
  }
  if (exec.exitCode !== 0 && !exec.timedOut && !exec.canceled) {
    warn('nonzero_exit', 'CLI 以非零状态退出；仅在已提取到有效回答时保留该回答。');
  }

  // Claude stream-json contains partial-message events; only text deltas are
  // accumulated. Thinking and other event blocks stay out of the user reply.
  if (provider === 'claude') {
    const stream = normalizeClaudeStream(text);
    if (stream.recognized) text = stream.failed ? '' : stream.answer;
  }

  // Claude's single-result JSON transport envelope is distinct from model JSON.
  try {
    const envelope = JSON.parse(text);
    if (envelope && typeof envelope === 'object' && envelope.type === 'result') {
      if (envelope.is_error || /error/i.test(String(envelope.subtype ?? ''))) text = '';
      else text = typeof envelope.result === 'string' ? clean(envelope.result) : '';
    }
  } catch { /* Plain text and model JSON are valid transport forms. */ }

  if (provider === 'codex') {
    const lines = text.split('\n');
    const events: Record<string, any>[] = [];
    let isEventStream = true;
    for (const line of lines.filter(line => line.trim())) {
      try {
        const event = JSON.parse(line);
        if (!event || typeof event !== 'object' || typeof event.type !== 'string') { isEventStream = false; break; }
        events.push(event);
      } catch { isEventStream = false; break; }
    }
    if (isEventStream && events.some(event => /^(thread|turn|item)\./.test(event.type))) {
      let finalAnswer = '';
      for (const event of events) {
        if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') finalAnswer = event.item.text;
        if (event.type === 'error' || event.type === 'turn.failed' || event.item?.type === 'error') {
          warn('cli_warning', 'CLI 返回诊断提示，已与回答正文分开。');
        }
      }
      text = clean(finalAnswer);
    } else {
    let lastMarker = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/^(?:codex|assistant|agent)\s*:?\s*$/i.test(lines[i].trim())) lastMarker = i;
    }
    if (lastMarker >= 0) {
      const answerLines: string[] = [];
      for (const line of lines.slice(lastMarker + 1)) {
        if (/^(?:tokens? used|user|thinking|exec|tool|mcp startup:|hook(?:s)?:)\s*:?(?:\s|$)/i.test(line.trim())) break;
        if (diagnostic.test(line.trim())) {
          warn('cli_warning', 'CLI 返回诊断提示，已与回答正文分开。');
          continue;
        }
        answerLines.push(line);
      }
      text = answerLines.join('\n').trim();
    } else if (lines.some(line => /^(?:openai codex\b|workdir:|tokens? used\b)/i.test(line.trim()))) {
      // A banner with no final assistant section is not a model answer.
      text = '';
    }
    }
  }

  // Drop leading diagnostics only, preserving ordinary prose and all user text.
  const lines = text.split('\n');
  while (lines.length && (diagnostic.test(lines[0].trim()) || metadata.test(lines[0].trim()) || !lines[0].trim())) {
    if (lines[0].trim()) warn('cli_warning', 'CLI 返回诊断提示，已与回答正文分开。');
    lines.shift();
  }
  text = lines.join('\n').trim();
  let meaningful = text;
  try {
    const reply = JSON.parse(text);
    if (reply && typeof reply === 'object' && 'answer' in reply) {
      meaningful = typeof reply.answer === 'string' ? reply.answer.trim() : '';
    }
  } catch { /* Ordinary prose. */ }
  const valid = Boolean(meaningful) && !meaningful.split('\n').every(line => !line.trim() || diagnostic.test(line.trim()) || metadata.test(line.trim()));
  return { answer: valid ? text : '', valid, warnings };
}

/** Fixed connection probes require a final OK answer, never an occurrence in a log. */
export function isOkReply(answer: string): boolean {
  let text = answer.trim();
  try {
    const value = JSON.parse(text);
    if (typeof value === 'string') text = value;
    else if (value && typeof value.answer === 'string') text = value.answer;
  } catch { /* Plain text. */ }
  return /^["'\x60]?OK[.!。！]?["'\x60]?$/i.test(text.trim());
}
