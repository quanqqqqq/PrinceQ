/**
 * Agent runtime adapter boundary.
 *
 * `AgentAdapter` is the only surface the HTTP layer knows about. The shipped
 * implementation (`DeterministicLocalAdapter`) is a rule-based command executor
 * — explicitly labelled `deterministic-local` in every response so the UI can
 * say so. Swapping in a real Agent runtime later means providing another
 * `AgentAdapter`; the routes, persistence and UI stay untouched.
 */
import type {
  AgentPendingAction,
  AgentResult,
  AgentResultBlock,
} from '../../shared/types.ts';
import { AGENT_ACTOR_ID, DEFAULT_ACTOR_ID } from '../config.ts';
import { get, run, type Db, type Row } from '../db/connection.ts';
import {
  addExplicitHabit,
  readAllHabits,
  setHabitEnabled,
} from '../domain/habits.ts';
import { QUADRANT_LABELS } from '../domain/quadrant.ts';
import { ApiError } from '../lib/errors.ts';
import { newId, nowIso } from '../lib/ids.ts';
import { cancelDecomposition, confirmDecomposition, createGoal, previewDecomposition } from '../repo/goal-service.ts';
import { withOperation } from '../repo/operations.ts';
import { explainTask, readQueue } from '../repo/queue-service.ts';
import {
  applyAction,
  changeQuadrant,
  confirmQuadrant,
  createTask,
} from '../repo/task-service.ts';
import { findGoal, findGoalsByTitle, findTask, findTasksByTitle, listGoals } from '../repo/tasks.ts';
import { parseCommand, SUPPORTED_COMMANDS, type Intent } from './commands.ts';

export interface AgentRequest {
  db: Db;
  message: string;
  actorId: string;
  idempotencyKey: string;
  /**
   * 点选歧义候选/点推荐示例时由前端回传的稳定 id。带上后直接按 id 命中，
   * 跳过标题模糊匹配——即便两个任务标题完全相同，也只操作被选中的那一条。
   * 这两个 id 只用于服务端定位，从不回显到 UI。
   */
  targetTaskId?: string;
  targetGoalId?: string;
  intent?: 'goal_task_drafts';
}

export interface AgentOutcome {
  result: AgentResult;
  invalidates: ('tasks' | 'goals' | 'queue' | 'activity' | 'habits')[];
}

/** Implement this to replace deterministic local mode with a real Agent. */
export interface AgentAdapter {
  readonly mode: 'deterministic-local';
  handle(request: AgentRequest): AgentOutcome;
}

const answer = (
  kind: AgentResult['kind'],
  headline: string,
  reasoning: string[],
  blocks: AgentResultBlock[] = [],
  matched: string | null = null,
  pending: AgentPendingAction | null = null,
): AgentResult => ({
  kind,
  headline,
  reasoning,
  blocks,
  pending_action: pending,
  matched_command: matched,
  mode: 'deterministic-local',
});

/**
 * Turns an ambiguous title lookup into a clarification instead of a guess.
 *
 * 歧义时不再吐一堆任务 id，而是给每个候选一张卡片（标题/目标/状态/截止），
 * `select_message` 是「同一指令 + 精确标题」——用户点一下就把它重新发回解析器，
 * 全程不暴露、也不需要复制任务 id。
 */
function resolveTask(
  db: Db,
  title: string,
  verb: (exactTitle: string) => string,
  targetTaskId?: string,
) {
  // 前端点选/点推荐时回传了稳定 id：直接按 id 命中，跳过标题模糊匹配。
  if (targetTaskId) {
    const pinned = findTask(db, targetTaskId);
    if (!pinned) {
      return {
        error: answer(
          'clarification',
          '选中的任务已不存在（可能刚被归档）。',
          ['没有写入任何数据。请刷新队列后重试。'],
          [],
          'task lookup',
        ),
      };
    }
    return { task: pinned };
  }
  const matches = findTasksByTitle(db, title);
  if (matches.length === 0) {
    return {
      error: answer(
        'clarification',
        `No task matches "${title}".`,
        [
          'Title lookup is exact-first, then substring — neither matched.',
          'Nothing was written. Create the task first, or retry with the exact title.',
        ],
        [],
        'task lookup',
      ),
    };
  }
  if (matches.length > 1) {
    return {
      error: answer(
        'clarification',
        `「${title}」匹配到 ${matches.length} 个任务，请点选其中一个`,
        ['没有自动猜测，也没有写入任何数据。点下面某一条，就会只操作那一条（靠内部 id 精确选中，即使标题完全相同也不会再次歧义）。'],
        [
          {
            type: 'task_candidates',
            title: '请选择要操作的任务',
            candidates: matches.map((t) => ({
              title: t.title,
              goal_title: t.goal_title,
              status: t.status,
              deadline: t.deadline,
              task_id: t.id,
              select_message: verb(t.title),
            })),
          },
        ],
        'task lookup',
      ),
    };
  }
  return { task: matches[0] };
}

function resolveGoal(
  db: Db,
  title: string,
  verb: (exactTitle: string) => string,
  targetGoalId?: string,
) {
  if (targetGoalId) {
    const pinned = findGoal(db, targetGoalId);
    if (!pinned) {
      return {
        error: answer(
          'clarification',
          '选中的目标已不存在。',
          ['没有写入任何数据。'],
          [],
          'goal lookup',
        ),
      };
    }
    return { goal: pinned };
  }
  const matches = findGoalsByTitle(db, title);
  if (matches.length === 0) {
    return {
      error: answer(
        'clarification',
        `No goal matches "${title}".`,
        ['Nothing was written. Create the goal first, or retry with the exact title.'],
        [],
        'goal lookup',
      ),
    };
  }
  if (matches.length > 1) {
    return {
      error: answer(
        'clarification',
        `「${title}」匹配到 ${matches.length} 个目标，请点选其中一个`,
        ['没有自动猜测，也没有写入任何数据。点下面某一条，就会只操作那个目标。'],
        [
          {
            type: 'goal_candidates',
            title: '请选择要操作的目标',
            candidates: matches.map((g) => ({
              title: g.title,
              status: g.status,
              target_date: g.target_date,
              goal_id: g.id,
              select_message: verb(g.title),
            })),
          },
        ],
        'goal lookup',
      ),
    };
  }
  return { goal: matches[0] };
}

/** 中文动作名，用于歧义候选点选后重发的那条指令。 */
const TASK_ACTION_ZH: Record<string, string> = {
  claim: '领取',
  release: '释放',
  start: '开始',
  complete: '完成',
};

const taskVerb = (action: string) => (exactTitle: string): string =>
  action === 'block' ? `把"${exactTitle}"标记为受阻` : `${TASK_ACTION_ZH[action] ?? action} "${exactTitle}"`;

const helpResult = (): AgentResult =>
  answer(
    'answer',
    'Deterministic local mode — supported commands',
    [
      'This panel runs a rule-based command parser, not a language model.',
      'Unmatched or batch-like input returns a preview or clarification instead of writing.',
    ],
    [
      {
        type: 'facts',
        title: 'Commands',
        items: SUPPORTED_COMMANDS.map((c) => ({ label: c.command, value: c.example })),
      },
    ],
    'help',
  );

export class DeterministicLocalAdapter implements AgentAdapter {
  readonly mode = 'deterministic-local' as const;

  handle(request: AgentRequest): AgentOutcome {
    const intent = parseCommand(request.message);
    try {
      return this.execute(intent, request);
    } catch (error) {
      if (error instanceof ApiError) {
        return {
          result: answer(
            'error',
            error.message,
            [
              `The command was understood as "${intent.kind}" but the write was rejected.`,
              'No partial change was applied — the operation ran in a transaction.',
            ],
            [],
            intent.kind,
          ),
          invalidates: [],
        };
      }
      throw error;
    }
  }

  private execute(intent: Intent, request: AgentRequest): AgentOutcome {
    const { db, actorId, idempotencyKey } = request;

    switch (intent.kind) {
      case 'help':
        return { result: helpResult(), invalidates: [] };

      case 'unknown':
        return {
          result: answer(
            'clarification',
            'That command is not supported in deterministic local mode.',
            [
              'The parser matched no known intent, so nothing was written.',
              'A real Agent runtime can be plugged in behind the same adapter interface later.',
            ],
            [
              {
                type: 'facts',
                title: 'Try one of these',
                items: SUPPORTED_COMMANDS.map((c) => ({ label: c.command, value: c.example })),
              },
            ],
            null,
          ),
          invalidates: [],
        };

      case 'batch_warning':
        return {
          result: answer(
            'preview',
            'Held back — this looks destructive or batch-like.',
            [
              `Refused to execute automatically because ${intent.reason}.`,
              'Deterministic local mode never performs bulk or destructive writes without an explicit per-item command.',
              'Nothing was written.',
            ],
            [{ type: 'list', title: 'Your input', items: [intent.original] }],
            'batch guard',
          ),
          invalidates: [],
        };

      case 'show_queue': {
        const queue = readQueue(db);
        const top = queue.entries.slice(0, intent.limit);
        if (top.length === 0) {
          return {
            result: answer(
              'answer',
              'The queue is empty.',
              ['No tasks are in inbox, claimed, in_progress or blocked state.'],
              [],
              'show queue',
            ),
            invalidates: [],
          };
        }
        return {
          result: answer(
            'answer',
            `Top ${top.length} of ${queue.entries.length} ranked task(s)`,
            [
              `Ranked by snapshot ${queue.snapshot.id} (${queue.snapshot.algorithm_version}).`,
              'Ranking uses deadline, manual priority, dependencies, effort, habits and context continuity — not the quadrant.',
            ],
            [
              {
                type: 'facts',
                title: 'Queue',
                items: top.map((e) => ({
                  label: `#${e.position} ${e.task.title}`,
                  value: `score ${e.score} · ${e.task.status}${e.task.goal_title ? ` · goal: ${e.task.goal_title}` : ''}`,
                })),
              },
              { type: 'tasks', title: 'Tasks', task_ids: top.map((e) => e.task.id) },
            ],
            'show queue',
          ),
          invalidates: [],
        };
      }

      case 'show_goals': {
        const goals = listGoals(db, ['active', 'paused']);
        if (goals.length === 0) {
          return {
            result: answer('answer', 'No active goals.', ['Create one with: create goal "..."'], [], 'show goals'),
            invalidates: [],
          };
        }
        return {
          result: answer(
            'answer',
            `${goals.length} active goal(s)`,
            ['Progress is the share of non-archived linked tasks that are completed.'],
            [
              {
                type: 'facts',
                title: 'Goals',
                items: goals.map((g) => ({
                  label: g.title,
                  value: `${g.progress.completed}/${g.progress.total} done (${Math.round(g.progress.ratio * 100)}%)${g.target_date ? ` · target ${g.target_date.slice(0, 10)}` : ''}`,
                })),
              },
            ],
            'show goals',
          ),
          invalidates: [],
        };
      }

      case 'list_habits': {
        const habits = readAllHabits();
        return {
          result: answer(
            'answer',
            'Habit files',
            [
              `Read from habits/ on this call: explicit v${habits.explicit.schema_version}, inferred v${habits.inferred.schema_version}, constraints v${habits.constraints.schema_version}, weights v${habits.weights.schema_version}.`,
            ],
            [
              {
                type: 'facts',
                title: 'Explicit habits',
                items: habits.explicit.payload.entries.length
                  ? habits.explicit.payload.entries.map((h) => ({
                      label: h.statement,
                      value: `${h.enabled ? 'enabled' : 'disabled'} · ${h.kind} · ${h.id}`,
                    }))
                  : [{ label: '(none)', value: 'add one with: add habit "..."' }],
              },
              {
                type: 'facts',
                title: 'Inferred habits',
                items: habits.inferred.payload.entries.length
                  ? habits.inferred.payload.entries.map((h) => ({
                      label: h.statement,
                      value: `confidence ${h.confidence ?? 'n/a'} · ${h.enabled ? 'enabled' : 'disabled'}`,
                    }))
                  : [{ label: '(none)', value: 'inferred habits are seeded from observed behaviour' }],
              },
              {
                type: 'facts',
                title: 'Hard constraints',
                items: habits.constraints.payload.entries.length
                  ? habits.constraints.payload.entries.map((c) => ({ label: c.statement, value: `${c.kind} = ${c.value}` }))
                  : [{ label: '(none)', value: 'no hard constraints configured' }],
              },
              {
                type: 'facts',
                title: 'Scoring weights',
                items: Object.entries(habits.weights.payload.weights).map(([k, v]) => ({
                  label: k,
                  value: String(v),
                })),
              },
            ],
            'list habits',
          ),
          invalidates: [],
        };
      }

      case 'explain': {
        const resolved = resolveTask(db, intent.title, (t) => `explain "${t}"`, request.targetTaskId);
        if (resolved.error) return { result: resolved.error, invalidates: [] };
        const explanation = explainTask(db, resolved.task.id);
        const positive = [...explanation.breakdown.factors]
          .sort((a, b) => b.contribution - a.contribution)
          .slice(0, 2);
        return {
          result: answer(
            'answer',
            explanation.position
              ? `"${resolved.task.title}" sits at #${explanation.position} with score ${explanation.breakdown.score}.`
              : `"${resolved.task.title}" holds no queue position (status: ${resolved.task.status}).`,
            [
              `Biggest contributors: ${positive.map((f) => `${f.label} (+${f.contribution})`).join(', ')}.`,
              'Quadrant is not an input to this score — the queue and the matrix are separate views.',
              ...explanation.breakdown.notes,
            ],
            [{ type: 'score', title: 'Score breakdown', breakdown: explanation.breakdown }],
            'explain',
          ),
          invalidates: [],
        };
      }

      case 'draft_tasks': {
        const resolved = resolveGoal(db, intent.goalTitle, (g) => `为目标"${g}"拟任务`, request.targetGoalId);
        if (resolved.error) return { result: resolved.error, invalidates: [] };
        const preview = previewDecomposition(db, resolved.goal.id);
        return {
          result: answer(
            'preview',
            `${preview.drafts.length} draft task(s) for "${preview.goal_title}" — confirm to create.`,
            preview.notes,
            [
              {
                type: 'decomposition_preview',
                title: '任务草稿',
                preview: {
                  goal_title: preview.goal_title,
                  drafts: preview.drafts,
                  notes: preview.notes,
                },
              },
            ],
            'draft tasks',
            {
              token: preview.preview_token,
              command: 'confirm_decomposition',
              summary: `Create ${preview.drafts.length} task(s) under "${preview.goal_title}"`,
              affected_task_ids: [],
            },
          ),
          invalidates: [],
        };
      }

      case 'create_task': {
        const goal = intent.goalTitle
          ? resolveGoal(db, intent.goalTitle, (g) => `看看目标"${g}"`, request.targetGoalId)
          : null;
        if (goal?.error) return { result: goal.error, invalidates: [] };
        const outcome = withOperation(
          db,
          {
            idempotency_key: idempotencyKey,
            operation_type: 'agent.task.create',
            target_type: 'task',
            actor_id: actorId,
          },
          () => {
            const task = createTask(db, {
              title: intent.title,
              deadline: intent.deadline,
              estimated_minutes: intent.minutes,
              goal_id: goal?.goal?.id ?? null,
            });
            return {
              result: task,
              target_id: task.id,
              summary: `Agent created task "${task.title}"`,
              detail: { source: 'agent', quadrant: task.quadrant },
            };
          },
        );
        const task = outcome.result;
        return {
          result: answer(
            'applied',
            `Created "${task.title}" — suggested ${task.quadrant} awaiting your confirmation.`,
            [
              task.quadrant_reason ?? 'Quadrant inferred from the title.',
              `Queue position #${task.queue_position ?? '—'} with score ${task.queue_score ?? '—'} after recalculation.`,
              outcome.replayed ? 'Idempotency key replayed — no duplicate was created.' : `Logged as operation ${outcome.operation.id}.`,
            ],
            [
              {
                type: 'facts',
                title: 'Task',
                items: [
                  { label: 'Status', value: task.status },
                  { label: 'Deadline', value: task.deadline ? task.deadline.slice(0, 16).replace('T', ' ') : 'none' },
                  { label: 'Estimate', value: task.estimated_minutes ? `${task.estimated_minutes}m` : 'none' },
                  { label: 'Goal', value: task.goal_title ?? 'none' },
                  { label: 'Quadrant', value: `${task.quadrant} — ${QUADRANT_LABELS[task.quadrant!]}` },
                ],
              },
              { type: 'tasks', title: 'Created', task_ids: [task.id] },
            ],
            'create a task',
          ),
          invalidates: ['tasks', 'queue', 'activity', 'goals'],
        };
      }

      case 'create_goal': {
        const outcome = withOperation(
          db,
          {
            idempotency_key: idempotencyKey,
            operation_type: 'agent.goal.create',
            target_type: 'goal',
            actor_id: actorId,
          },
          () => {
            const goal = createGoal(db, { title: intent.title, target_date: intent.targetDate });
            return {
              result: goal,
              target_id: goal.id,
              summary: `Agent created goal "${goal.title}"`,
              detail: { source: 'agent' },
              skipQueueRefresh: true,
            };
          },
        );
        const goal = outcome.result;
        return {
          result: answer(
            'applied',
            `Created goal "${goal.title}".`,
            [
              'Goals and tasks are separate entities — this goal has no tasks yet.',
              `Next: draft tasks for goal "${goal.title}" to get a confirmable decomposition preview.`,
            ],
            [
              {
                type: 'facts',
                title: 'Goal',
                items: [
                  { label: 'Status', value: goal.status },
                  { label: 'Target date', value: goal.target_date?.slice(0, 10) ?? 'none' },
                  { label: 'Tasks', value: '0' },
                ],
              },
            ],
            'create a goal',
          ),
          invalidates: ['goals', 'activity'],
        };
      }

      case 'task_action': {
        const resolved = resolveTask(db, intent.title, taskVerb(intent.action), request.targetTaskId);
        if (resolved.error) return { result: resolved.error, invalidates: [] };
        const before = resolved.task;
        const outcome = withOperation(
          db,
          {
            idempotency_key: idempotencyKey,
            operation_type: `agent.task.${intent.action}`,
            target_type: 'task',
            actor_id: actorId,
          },
          () => {
            const task = applyAction(db, before.id, {
              action: intent.action,
              // Claims belong to the human actor even when the agent relays them.
              actor_id: actorId === AGENT_ACTOR_ID ? DEFAULT_ACTOR_ID : actorId,
              reason: intent.reason,
            });
            return {
              result: task,
              target_id: task.id,
              summary: `Agent applied "${intent.action}" to "${task.title}"`,
              detail: { from: before.status, to: task.status, reason: intent.reason },
            };
          },
        );
        const task = outcome.result;
        return {
          result: answer(
            'applied',
            `"${task.title}" moved from ${before.status} to ${task.status}.`,
            [
              `Transition "${intent.action}" is valid from ${before.status}.`,
              task.active_assignment
                ? `Claim held by ${task.active_assignment.actor_name} since ${task.active_assignment.claimed_at.slice(11, 16)}.`
                : 'No active claim on the task now.',
              `Queue recalculated — now at #${task.queue_position ?? '—'}.`,
            ],
            [{ type: 'tasks', title: 'Updated', task_ids: [task.id] }],
            `${intent.action} a task`,
          ),
          invalidates: ['tasks', 'queue', 'activity', 'goals'],
        };
      }

      case 'change_quadrant': {
        const resolved = resolveTask(db, intent.title, (t) => `move "${t}" to ${intent.quadrant}`, request.targetTaskId);
        if (resolved.error) return { result: resolved.error, invalidates: [] };
        const before = resolved.task;
        const outcome = withOperation(
          db,
          {
            idempotency_key: idempotencyKey,
            operation_type: 'agent.task.quadrant.change',
            target_type: 'task',
            actor_id: actorId,
          },
          () => {
            const task = changeQuadrant(db, before.id, intent.quadrant, 'Changed via the agent panel.');
            return {
              result: task,
              target_id: task.id,
              summary: `Agent set "${task.title}" to ${intent.quadrant}`,
              detail: { from: before.quadrant, to: intent.quadrant },
            };
          },
        );
        const task = outcome.result;
        return {
          result: answer(
            'applied',
            `"${task.title}" is now ${intent.quadrant} — ${QUADRANT_LABELS[intent.quadrant]}.`,
            [
              `Previous value: ${before.quadrant ?? 'unclassified'} (${before.quadrant_source}).`,
              'Marked as user-confirmed, so the agent will not re-suggest it.',
              'This changes the matrix view only — the queue score is computed independently.',
            ],
            [{ type: 'tasks', title: 'Updated', task_ids: [task.id] }],
            'change a task quadrant',
          ),
          invalidates: ['tasks', 'queue', 'activity'],
        };
      }

      case 'confirm_quadrant': {
        const resolved = resolveTask(db, intent.title, (t) => `confirm the quadrant for "${t}"`, request.targetTaskId);
        if (resolved.error) return { result: resolved.error, invalidates: [] };
        const before = resolved.task;
        const outcome = withOperation(
          db,
          {
            idempotency_key: idempotencyKey,
            operation_type: 'agent.task.quadrant.confirm',
            target_type: 'task',
            actor_id: actorId,
          },
          () => {
            const task = confirmQuadrant(db, before.id);
            return {
              result: task,
              target_id: task.id,
              summary: `Agent confirmed ${task.quadrant} for "${task.title}"`,
              detail: { quadrant: task.quadrant },
            };
          },
        );
        const task = outcome.result;
        return {
          result: answer(
            'applied',
            `Confirmed ${task.quadrant} for "${task.title}".`,
            [`Suggestion came from the ${before.quadrant_source} source with ${Math.round((before.quadrant_confidence ?? 0) * 100)}% confidence.`],
            [{ type: 'tasks', title: 'Updated', task_ids: [task.id] }],
            'confirm a quadrant',
          ),
          invalidates: ['tasks', 'activity'],
        };
      }

      case 'add_habit': {
        const outcome = withOperation(
          db,
          {
            idempotency_key: idempotencyKey,
            operation_type: 'agent.habit.add',
            target_type: 'habit',
            actor_id: actorId,
          },
          () => {
            const entry = addExplicitHabit({ statement: intent.statement, source: 'agent' }, actorId);
            return {
              result: entry,
              target_id: entry.id,
              summary: `Agent added explicit habit "${entry.statement}"`,
              detail: { file: 'habits/explicit.json' },
            };
          },
        );
        return {
          result: answer(
            'applied',
            `Recorded explicit habit "${outcome.result.statement}".`,
            [
              'Written to habits/explicit.json via validate-then-atomic-rename, with a history entry.',
              'The queue scorer reads habit files on every recalculation, so ranking may shift.',
            ],
            [
              {
                type: 'facts',
                title: 'Habit',
                items: [
                  { label: 'Id', value: outcome.result.id },
                  { label: 'Kind', value: outcome.result.kind },
                  { label: 'Enabled', value: String(outcome.result.enabled) },
                ],
              },
            ],
            'add an explicit habit',
          ),
          invalidates: ['habits', 'queue', 'activity', 'tasks'],
        };
      }

      case 'disable_habit': {
        const habits = readAllHabits();
        const needle = intent.statement.toLowerCase();
        const match = habits.explicit.payload.entries.find(
          (h) => h.id === intent.statement || h.statement.toLowerCase().includes(needle),
        );
        if (!match) {
          return {
            result: answer(
              'clarification',
              `No explicit habit matches "${intent.statement}".`,
              ['Nothing was written. Use "list habits" to see the exact statements and ids.'],
              [],
              'disable a habit',
            ),
            invalidates: [],
          };
        }
        const outcome = withOperation(
          db,
          {
            idempotency_key: idempotencyKey,
            operation_type: 'agent.habit.disable',
            target_type: 'habit',
            actor_id: actorId,
          },
          () => {
            const entry = setHabitEnabled('explicit', match.id, false, actorId);
            return {
              result: entry,
              target_id: entry.id,
              summary: `Agent disabled explicit habit "${entry.statement}"`,
              detail: { file: 'habits/explicit.json' },
            };
          },
        );
        return {
          result: answer(
            'applied',
            `Disabled habit "${outcome.result.statement}".`,
            [
              'The entry is retained but excluded from scoring, and the change is in the file history.',
              'Queue recalculated without it.',
            ],
            [],
            'disable a habit',
          ),
          invalidates: ['habits', 'queue', 'activity', 'tasks'],
        };
      }
    }
  }
}

export const localAdapter = new DeterministicLocalAdapter();

/** Confirms a pending preview produced by a previous agent turn. */
export function confirmPendingAction(
  db: Db,
  token: string,
  actorId: string,
  idempotencyKey: string,
  acceptedDrafts?: { index: number; title: string; description?: string | null }[],
): AgentOutcome {
  const outcome = withOperation(
    db,
    {
      idempotency_key: idempotencyKey,
      operation_type: 'agent.decomposition.confirm',
      target_type: 'goal',
      actor_id: actorId,
    },
    () => {
      const created = confirmDecomposition(db, token, acceptedDrafts?.length ? { acceptedDrafts } : {});
      return {
        result: created,
        target_id: created.goal.id,
        summary: `Confirmed decomposition of "${created.goal.title}" into ${created.tasks.length} task(s)`,
        detail: { task_ids: created.tasks.map((t) => t.id) },
      };
    },
  );

  const { goal, tasks } = outcome.result;
  return {
    result: answer(
      'applied',
      `Created ${tasks.length} task(s) under "${goal.title}".`,
      [
        'Created only after your explicit confirmation of the preview.',
        'Each task carries an unconfirmed quadrant suggestion you can confirm or change.',
        `Goal progress is now ${goal.progress.completed}/${goal.progress.total}.`,
      ],
      [{ type: 'tasks', title: 'Created tasks', task_ids: tasks.map((t) => t.id) }],
      'confirm decomposition',
    ),
    invalidates: ['tasks', 'goals', 'queue', 'activity'],
  };
}

/**
 * 用户在助手面板点「取消当前预览」：服务端把这份预览注销，不创建任何任务。
 * 注销后即便刷新页面，旧 token 也不能再确认/重复提交。
 */
export function cancelPendingAction(
  db: Db,
  token: string,
  actorId: string,
  idempotencyKey: string,
): AgentOutcome {
  const outcome = withOperation(
    db,
    {
      idempotency_key: idempotencyKey,
      operation_type: 'agent.decomposition.cancel',
      target_type: 'goal',
      actor_id: actorId,
    },
    () => {
      const cancelled = cancelDecomposition(db, token);
      return {
        result: cancelled,
        target_id: null,
        summary: `Cancelled decomposition of "${cancelled.goal_title}" without creating tasks`,
      };
    },
  );
  const { goal_title, already } = outcome.result;

  return {
    result: answer(
      'applied',
      `已取消「${goal_title}」的任务草稿${already ? '（之前已处理过）' : ''}。`,
      ['没有创建任何任务。', '这份预览已被服务端注销，旧按钮不会再执行。'],
      [],
      'cancel decomposition',
    ),
    invalidates: [],
  };
}

export interface SessionRecord {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export function ensureSession(db: Db, sessionId?: string | null, firstMessage?: string): SessionRecord {
  if (sessionId) {
    const existing = get<Row>(db, 'SELECT * FROM agent_sessions WHERE id = ?', [sessionId]);
    if (existing) return existing as SessionRecord;
  }
  const id = sessionId ?? newId('sess');
  const timestamp = nowIso();
  const title = firstMessage?.slice(0, 60) || 'Agent session';
  run(
    db,
    'INSERT INTO agent_sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)',
    [id, title, timestamp, timestamp],
  );
  return { id, title, created_at: timestamp, updated_at: timestamp };
}
