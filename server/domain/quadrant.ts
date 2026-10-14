/**
 * Deterministic Eisenhower quadrant inference.
 *
 * This is explicitly NOT an LLM. It reads keyword signals, deadline proximity
 * and effort hints to derive importance/urgency scores (1..5), then maps them to
 * a quadrant along with the signals it used and a confidence value. Results are
 * always marked as awaiting user confirmation by the caller.
 *
 *   q1 important + urgent      → do now
 *   q2 important + not urgent   → schedule
 *   q3 not important + urgent   → delegate / batch
 *   q4 neither                  → drop / defer
 */
import type {
  CognitiveLoad,
  Quadrant,
  QuadrantSuggestion,
  TaskType,
} from '../../shared/types.ts';
import { clamp, now, round2 } from '../lib/ids.ts';

export interface QuadrantInput {
  title: string;
  description?: string | null;
  deadline?: string | null;
  estimated_minutes?: number | null
  cognitive_load?: CognitiveLoad | null;
  task_type?: TaskType | null;
  goal_title?: string | null;
}

const IMPORTANCE_SIGNALS: { pattern: RegExp; weight: number; label: string }[] = [
  { pattern: /\b(outage|incident|sev[-\s]?[12]|production down|data loss)\b/i, weight: 2, label: 'incident language' },
  { pattern: /\b(strategy|strategic|roadmap|architecture|hiring|compliance|security|contract|legal)\b/i, weight: 1.5, label: 'high-stakes topic' },
  { pattern: /\b(customer|client|stakeholder|revenue|launch|release|投产|上线)\b/i, weight: 1, label: 'external impact' },
  { pattern: /\b(learn|study|research|explore|prototype|设计|调研)\b/i, weight: 0.5, label: 'investment work' },
  { pattern: /\b(fyi|optional|nice to have|someday|maybe|无所谓)\b/i, weight: -1.5, label: 'low-stakes phrasing' },
  { pattern: /\b(newsletter|digest|browse|scroll|tidy|整理收藏)\b/i, weight: -1, label: 'low-value chore' },
];

const URGENCY_SIGNALS: { pattern: RegExp; weight: number; label: string }[] = [
  { pattern: /\b(asap|immediately|right now|urgent|today|tonight|紧急|今天)\b/i, weight: 2, label: 'explicit urgency' },
  { pattern: /\b(tomorrow|by eod|end of day|this week|明天|本周)\b/i, weight: 1.2, label: 'near-term wording' },
  { pattern: /\b(blocker|blocking|waiting on me|interrupt|ping|reply|respond)\b/i, weight: 1, label: 'someone is waiting' },
  { pattern: /\b(deadline|due|expires|cutoff|截止)\b/i, weight: 0.8, label: 'deadline mentioned' },
  { pattern: /\b(someday|eventually|backlog|next quarter|long[-\s]?term|以后)\b/i, weight: -1.5, label: 'explicitly deferred' },
];

const TASK_TYPE_BIAS: Record<TaskType, { importance: number; urgency: number }> = {
  deep_work: { importance: 0.8, urgency: -0.3 },
  shallow_work: { importance: -0.3, urgency: 0.2 },
  communication: { importance: -0.2, urgency: 0.8 },
  admin: { importance: -0.6, urgency: 0.3 },
  review: { importance: 0.2, urgency: 0.6 },
  learning: { importance: 0.6, urgency: -0.8 },
};

/** Hours until deadline → urgency bump. Mirrors the queue's deadline curve. */
function deadlineUrgency(deadline: string | null | undefined): { delta: number; label: string } | null {
  if (!deadline) return null;
  const at = Date.parse(deadline);
  if (Number.isNaN(at)) return null;
  const hours = (at - now().getTime()) / 36e5;
  if (hours <= 0) return { delta: 2.5, label: 'deadline has passed' };
  if (hours <= 24) return { delta: 2, label: 'due within 24h' };
  if (hours <= 72) return { delta: 1.2, label: 'due within 3 days' };
  if (hours <= 24 * 7) return { delta: 0.5, label: 'due within a week' };
  if (hours <= 24 * 30) return { delta: -0.3, label: 'due within a month' };
  return { delta: -0.8, label: 'deadline is far out' };
}

const toScale = (raw: number): number => clamp(Math.round(raw), 1, 5);

export function quadrantFor(importance: number, urgency: number): Quadrant {
  const important = importance >= 3.5;
  const urgent = urgency >= 3.5;
  if (important && urgent) return 'q1';
  if (important && !urgent) return 'q2';
  if (!important && urgent) return 'q3';
  return 'q4';
}

export const QUADRANT_LABELS: Record<Quadrant, string> = {
  q1: 'Important & urgent — do now',
  q2: 'Important, not urgent — schedule',
  q3: 'Urgent, not important — batch or delegate',
  q4: 'Neither — defer or drop',
};

export function inferQuadrant(input: QuadrantInput): QuadrantSuggestion {
  const haystack = [input.title, input.description ?? '', input.goal_title ?? ''].join(' ');
  const signals: string[] = [];

  // Start at the neutral middle of the 1..5 scale and move with evidence.
  let importance = 3;
  let urgency = 3;
  let evidence = 0;

  for (const signal of IMPORTANCE_SIGNALS) {
    if (signal.pattern.test(haystack)) {
      importance += signal.weight;
      evidence += Math.abs(signal.weight);
      signals.push(`importance ${signal.weight > 0 ? '+' : ''}${signal.weight}: ${signal.label}`);
    }
  }

  for (const signal of URGENCY_SIGNALS) {
    if (signal.pattern.test(haystack)) {
      urgency += signal.weight;
      evidence += Math.abs(signal.weight);
      signals.push(`urgency ${signal.weight > 0 ? '+' : ''}${signal.weight}: ${signal.label}`);
    }
  }

  const dl = deadlineUrgency(input.deadline);
  if (dl) {
    urgency += dl.delta;
    evidence += Math.abs(dl.delta);
    signals.push(`urgency ${dl.delta > 0 ? '+' : ''}${dl.delta}: ${dl.label}`);
  }

  if (input.task_type) {
    const bias = TASK_TYPE_BIAS[input.task_type];
    importance += bias.importance;
    urgency += bias.urgency;
    evidence += 0.5;
    signals.push(`task type "${input.task_type}" biases importance ${bias.importance >= 0 ? '+' : ''}${bias.importance}, urgency ${bias.urgency >= 0 ? '+' : ''}${bias.urgency}`);
  }

  if (input.cognitive_load === 'high') {
    importance += 0.4;
    evidence += 0.3;
    signals.push('high cognitive load suggests substantive work (importance +0.4)');
  } else if (input.cognitive_load === 'low') {
    importance -= 0.3;
    evidence += 0.2;
    signals.push('low cognitive load suggests a minor item (importance -0.3)');
  }

  if (input.goal_title) {
    importance += 0.6;
    evidence += 0.4;
    signals.push(`linked to goal "${input.goal_title}" (importance +0.6)`);
  }

  if (typeof input.estimated_minutes === 'number') {
    if (input.estimated_minutes >= 120) {
      importance += 0.3;
      evidence += 0.2;
      signals.push('large estimate (>=2h) suggests meaningful scope (importance +0.3)');
    } else if (input.estimated_minutes <= 15) {
      importance -= 0.2;
      evidence += 0.1;
      signals.push('very small estimate (<=15m) suggests a quick chore (importance -0.2)');
    }
  }

  const importanceScale = toScale(importance);
  const urgencyScale = toScale(urgency);
  const quadrant = quadrantFor(importance, urgency);
  // Confidence grows with evidence and with distance from the 3.5 decision
  // boundary — a task sitting exactly on the line is a coin flip.
  const margin = Math.min(Math.abs(importance - 3.5), Math.abs(urgency - 3.5));
  const evidenceScore = clamp(evidence / 5);
  const marginScore = clamp(margin / 1.5);
  const confidence = round2(clamp(0.3 + 0.4 * evidenceScore + 0.3 * marginScore, 0.2, 0.95));

  if (signals.length === 0) {
    signals.push('no strong signals in the title, description, deadline or type');
  }

  const reason =
    `${QUADRANT_LABELS[quadrant]}. Derived importance ${round2(importance)} → ${importanceScale}/5 and urgency ` +
    `${round2(urgency)} → ${urgencyScale}/5 from ${signals.length} signal(s). ` +
    `Confidence ${Math.round(confidence * 100)}% — awaiting your confirmation.`;

  return {
    quadrant,
    importance: importanceScale,
    urgency: urgencyScale,
    importance_score: ruleScore(importance),
    urgency_score: ruleScore(urgency),
    confidence,
    reason,
    signals,
  };
}

/**
 * Projects the internal 1..5 rule scale onto the 0..100 matrix axis, keeping the
 * 3.5 rule boundary aligned with the 50 matrix boundary so the derived quadrant
 * is identical either way.
 *
 * These are *rule* scores (`matrix_score_source = 'rule'`), never Agent scores.
 */
export function ruleScore(raw: number): number {
  const value = raw >= 3.5 ? 50 + ((raw - 3.5) / 1.5) * 50 : (raw - 1) / 2.5 * 50;
  return Math.round(Math.min(Math.max(value, 0), 100) * 10) / 10;
}
