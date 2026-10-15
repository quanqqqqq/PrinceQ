import { recurrenceDue } from '../../shared/recurrence.ts';
/**
 * Work-queue ranking.
 *
 * Deliberately independent of the Eisenhower quadrant: the quadrant view is a
 * distribution lens, while the queue answers "what should I pick up next".
 * Six weighted factors, each normalised to 0..1 (penalties go negative), each
 * recorded with its own label and human-readable detail so the UI and the Agent
 * can explain any position.
 *
 *   deadline         — time pressure curve
 *   manual_priority  — explicit user pin (-2..+2)
 *   dependency       — readiness bonus, blocking-others bonus, blocked penalty
 *   effort           — favours finishable work, mild penalty for giant tasks
 *   habit_alignment   — preferred task types, peak hours, explicit habits
 *   context_switch   — continuity with what is already in progress
 *
 * Plus `manual_override`, added verbatim after weighting so a user can always
 * force an item up or down.
 */
import type {
  ScoreBreakdown,
  ScoreFactor,
  Task,
  TaskType,
} from '../../shared/types.ts';
import { DEFAULT_WEIGHTS, type HabitContext } from './habits.ts';
import { DURATION_UNIT_LABELS_ZH } from '../../shared/duration.ts';
import { peakHoursFor } from '../../shared/peak-hours.ts';
import { clamp, now, round2 } from '../lib/ids.ts';
import {observationEvidence} from '../../shared/habit-inference.ts';
import {localObservationTime} from '../agent/habit-inference-availability.ts';

/** Only these statuses compete for a queue position. */
const QUEUEABLE = new Set(['inbox', 'claimed', 'in_progress', 'blocked']);

export interface ScoringContext {
  habits: HabitContext;
  /** Task types currently in progress — drives the context-switch factor. */
  inProgressTypes: TaskType[];
  inProgressGoalIds: string[];
  at: Date;
}

export function buildScoringContext(tasks: Task[], habits: HabitContext, at = now()): ScoringContext {
  const active = tasks.filter((t) => t.status === 'in_progress');
  return {
    habits,
    inProgressTypes: active.map((t) => t.task_type).filter((t): t is TaskType => Boolean(t)),
    inProgressGoalIds: active.map((t) => t.goal_id).filter((g): g is string => Boolean(g)),
    at,
  };
}

/** Deadline pressure: overdue = 1, a month out ≈ 0.1, no deadline = 0.35 neutral. */
function deadlineFactor(task: Task, at: Date): { value: number; detail: string } {
  if (!task.deadline) {
    return { value: 0.35, detail: 'No deadline — neutral time pressure (0.35).' };
  }
  const ts = Date.parse(task.deadline);
  if (Number.isNaN(ts)) {
    return { value: 0.35, detail: 'Unparseable deadline — treated as neutral (0.35).' };
  }
  const hours = (ts - at.getTime()) / 36e5;
  if (hours <= 0) {
    return { value: 1, detail: `Overdue by ${Math.round(-hours)}h — maximum time pressure.` };
  }
  if (hours <= 24) {
    return { value: 0.95, detail: `Due in ${Math.round(hours)}h — due today.` };
  }
  if (hours <= 72) {
    return { value: 0.8, detail: `Due in ${Math.round(hours / 24)}d — within three days.` };
  }
  if (hours <= 24 * 7) {
    return { value: 0.6, detail: `Due in ${Math.round(hours / 24)}d — this week.` };
  }
  if (hours <= 24 * 30) {
    return { value: 0.3, detail: `Due in ${Math.round(hours / 24)}d — this month.` };
  }
  return { value: 0.1, detail: `Due in ${Math.round(hours / 24)}d — far out.` };
}

/** manual_priority -2..+2 mapped onto 0..1 with 0 → 0.5. */
function manualPriorityFactor(task: Task): { value: number; detail: string } {
  const value = clamp((task.manual_priority + 2) / 4);
  const label =
    task.manual_priority === 0
      ? 'No manual priority set (neutral).'
      : `Manual priority ${task.manual_priority > 0 ? '+' : ''}${task.manual_priority} applied.`;
  return { value, detail: label };
}

function dependencyFactor(task: Task): { value: number; detail: string } {
  const details: string[] = [];
  let value = 0.5;

  if (!task.dependency_ready) {
    value -= 0.45;
    details.push(`${task.depends_on.length} unfinished dependency(ies) — not ready to start`);
  } else if (task.depends_on.length > 0) {
    value += 0.2;
    details.push('all dependencies complete — ready to start');
  } else {
    details.push('no dependencies');
  }

  if (task.blocks.length > 0) {
    const bump = Math.min(0.3, task.blocks.length * 0.15);
    value += bump;
    details.push(`unblocks ${task.blocks.length} other task(s) (+${round2(bump)})`);
  }

  if (task.status === 'blocked') {
    value -= 0.3;
    details.push('explicitly blocked');
  }

  return { value: clamp(value, -0.5, 1), detail: `${details.join('; ')}.` };
}

/** Favours tasks that fit in a sitting; very long and unestimated work scores lower. */
/**
 * 耗时在解释文案里的写法。
 *
 * 任务记了原始单位（`2` + `'day'`）时写成「2 天 ≈ 960 分钟」，让用户在队列解释里
 * 看到的就是自己填的那个单位；否则沿用原来的 `${minutes}m`。
 *
 * 这里只改**文案**：分母用的仍是库里那个 `estimated_minutes`，不重新换算，
 * 所以 effort 的分值与阈值一字未动。
 */
function effortLabel(task: Task, minutes: number): string {
  if (task.duration_value != null && task.duration_unit && task.duration_unit !== 'minute') {
    const value = Math.round(task.duration_value * 100) / 100;
    return `${value} ${DURATION_UNIT_LABELS_ZH[task.duration_unit]} ≈ ${minutes} 分钟`;
  }
  return `${minutes}m`;
}

function effortFactor(task: Task): { value: number; detail: string } {
  const minutes = task.estimated_minutes;
  if (minutes == null) {
    return { value: 0.4, detail: 'No estimate — slight uncertainty discount (0.40).' };
  }
  const shown = effortLabel(task, minutes);
  if (minutes <= 15) return { value: 0.9, detail: `${shown} — quick win.` };
  if (minutes <= 45) return { value: 0.8, detail: `${shown} — fits one focused block.` };
  if (minutes <= 90) return { value: 0.65, detail: `${shown} — one long block.` };
  if (minutes <= 180) return { value: 0.45, detail: `${shown} — needs a scheduled session.` };
  return { value: 0.25, detail: `${shown} — large; consider splitting it.` };
}

function habitAlignmentFactor(
  task: Task,
  ctx: ScoringContext,
): { value: number; detail: string } {
  const details: string[] = [];
  let value = 0.5;

  if (task.task_type && ctx.habits.preferredTaskTypes.includes(task.task_type)) {
    value += 0.2;
    details.push(`"${task.task_type}" is a preferred task type (+0.20)`);
  }

  const hour = localObservationTime(ctx.at).hour;
  const inPeak = peakHoursFor(task.task_type, ctx.habits.peakHours, ctx.habits.peakHoursByTaskType).includes(hour);
  if (inPeak && task.cognitive_load === 'high') {
    value += 0.2;
    details.push(`${hour}:00 is a peak hour and this is high-load work (+0.20)`);
  } else if (!inPeak && task.cognitive_load === 'high') {
    value -= 0.15;
    details.push(`${hour}:00 is outside peak hours for high-load work (-0.15)`);
  } else if (!inPeak && task.cognitive_load === 'low') {
    value += 0.1;
    details.push(`low-load work suits off-peak hours (+0.10)`);
  }

  // Explicit habits beat inferred ones; inferred contributions scale by confidence.
  const matches = (statement: string) => {
    const words = statement
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 4);
    const haystack = `${task.title} ${task.description ?? ''} ${task.task_type ?? ''}`.toLowerCase();
    return words.some((w) => haystack.includes(w));
  };

  for (const habit of ctx.habits.explicit) {
    if (matches(habit.statement)) {
      value += 0.15;
      details.push(`matches explicit habit "${habit.statement}" (+0.15)`);
    }
  }
  for (const habit of ctx.habits.inferred) {
    const evidence = observationEvidence(habit.source_relation);
    if (evidence?.pattern === 'start_hour' && evidence.preferred_hours.includes(hour) &&
        (!evidence.task_types.length || Boolean(task.task_type && evidence.task_types.includes(task.task_type)))) {
      const bump = round2(0.1 * (habit.confidence ?? 0.5));
      value += bump;
      details.push(`matches inferred habit "${habit.statement}" (+${bump})`);
    }
  }

  if (details.length === 0) details.push('no habit signals');
  return { value: clamp(value), detail: `${details.join('; ')}.` };
}

/** Rewards staying in the current lane (same goal or same task type). */
function contextSwitchFactor(task: Task, ctx: ScoringContext): { value: number; detail: string } {
  if (ctx.inProgressTypes.length === 0 && ctx.inProgressGoalIds.length === 0) {
    return { value: 0.5, detail: 'Nothing in progress — no switching cost.' };
  }
  const details: string[] = [];
  let value = 0.35;

  if (task.status === 'in_progress') {
    value += 0.45;
    details.push('already in progress — finish it before switching (+0.45)');
  }
  if (task.goal_id && ctx.inProgressGoalIds.includes(task.goal_id)) {
    value += 0.2;
    details.push(`same goal as work in progress (+0.20)`);
  }
  if (task.task_type && ctx.inProgressTypes.includes(task.task_type)) {
    value += 0.15;
    details.push(`same task type as work in progress (+0.15)`);
  }
  if (details.length === 0) {
    details.push('different goal and type from what is in progress — switching cost applies');
  }
  return { value: clamp(value), detail: `${details.join('; ')}.` };
}

const FACTOR_LABELS: Record<keyof typeof DEFAULT_WEIGHTS, string> = {
  deadline: '截止时间压力',
  manual_priority: '手动优先级',
  dependency: '依赖就绪度',
  effort: '预计工作量',
  habit_alignment: '习惯契合度',
  context_switch: '上下文连续性',
};

export function scoreTask(task: Task, ctx: ScoringContext): ScoreBreakdown {
  const weights = { ...DEFAULT_WEIGHTS, ...ctx.habits.weights };
  const raw = {
    deadline: deadlineFactor(task, ctx.at),
    manual_priority: manualPriorityFactor(task),
    dependency: dependencyFactor(task),
    effort: effortFactor(task),
    habit_alignment: habitAlignmentFactor(task, ctx),
    context_switch: contextSwitchFactor(task, ctx),
  };

  const totalWeight = Object.values(weights).reduce((sum, w) => sum + w, 0) || 1;
  const factors: ScoreFactor[] = (Object.keys(raw) as (keyof typeof raw)[]).map((key) => {
    const weight = weights[key];
    // Normalise by total weight so the score stays on a 0..100 scale whatever
    // the user's weights sum to.
    const contribution = round2((raw[key].value * weight * 100) / totalWeight);
    return {
      key,
      label: FACTOR_LABELS[key],
      value: round2(raw[key].value),
      weight,
      contribution,
      detail: raw[key].detail,
    };
  });

  const notes: string[] = [];
  let score = factors.reduce((sum, f) => sum + f.contribution, 0);

  if (task.manual_override !== 0) {
    score += task.manual_override;
    notes.push(`Manual override of ${task.manual_override > 0 ? '+' : ''}${task.manual_override} applied after weighting.`);
  }
  if (!task.dependency_ready) {
    notes.push('Not startable yet: at least one dependency is unfinished.');
  }
  if (task.status === 'blocked') {
    notes.push(`Blocked${task.blocked_reason ? `: ${task.blocked_reason}` : ''}.`);
  }
  if (!task.quadrant_confirmed && task.quadrant) {
    notes.push('Quadrant is an unconfirmed agent suggestion; it does not affect this score.');
  }
  for (const constraint of ctx.habits.constraints) {
    notes.push(`Hard constraint in force: ${constraint.statement}`);
  }

  return {
    task_id: task.id,
    score: round2(score),
    factors,
    notes,
    computed_at: ctx.at.toISOString(),
  };
}

export interface RankedTask {
  task: Task;
  breakdown: ScoreBreakdown;
  position: number;
}

/**
 * Ranks all queueable tasks. Ties break on deadline, then manual priority, then
 * creation time, so ordering is stable across recalculations.
 */
export function rankTasks(tasks: Task[], habits: HabitContext, at = now()): RankedTask[] {
  const queueable = tasks.filter((t) => QUEUEABLE.has(t.status) && recurrenceDue(t.recurrence));
  const ctx = buildScoringContext(tasks, habits, at);

  const scored = queueable.map((task) => ({ task, breakdown: scoreTask(task, ctx) }));

  scored.sort((a, b) => {
    if (b.breakdown.score !== a.breakdown.score) return b.breakdown.score - a.breakdown.score;
    const aDue = a.task.deadline ? Date.parse(a.task.deadline) : Number.POSITIVE_INFINITY;
    const bDue = b.task.deadline ? Date.parse(b.task.deadline) : Number.POSITIVE_INFINITY;
    if (aDue !== bDue) return aDue - bDue;
    if (b.task.manual_priority !== a.task.manual_priority) {
      return b.task.manual_priority - a.task.manual_priority;
    }
    return Date.parse(a.task.created_at) - Date.parse(b.task.created_at);
  });

  return scored.map((entry, index) => ({ ...entry, position: index + 1 }));
}
