/**
 * Task write operations. Each public function returns a `MutationResult`-shaped
 * payload for `withOperation`, which wraps it in a transaction together with the
 * queue refresh and the operation-log entry.
 */
import type {
  DurationUnit,
  Quadrant,
  QuadrantSuggestion,
  Task,
  TaskAction,
  TaskStatus,
} from '../../shared/types.ts';
import type { RecurrenceInput } from '../../shared/recurrence.ts';
import { configureRecurrence, validateRecurrence } from './recurrence.ts';
import { TASK_STATUSES } from '../../shared/types.ts';
import { durationToMinutes } from '../../shared/duration.ts';
import { get, run, type Db, type Row } from '../db/connection.ts';
import { loadDurationConfig } from '../domain/habits.ts';
import {
  legacyAxisValue,
  validateMatrixScore,
  type MatrixScoreSubmission,
} from '../domain/matrix-score.ts';
import { inferQuadrant, QUADRANT_LABELS, quadrantFor } from '../domain/quadrant.ts';
import { assertTransition, requiresClaim } from '../domain/transitions.ts';
import { badRequest, conflict, notFound } from '../lib/errors.ts';
import { newId, nowIso } from '../lib/ids.ts';
import { findTask } from './tasks.ts';

export interface CreateTaskInput {
  recurrence?: RecurrenceInput;
  title: string;
  description?: string | null;
  goal_id?: string | null;
  deadline?: string | null;
  estimated_minutes?: number | null;
  /**
   * 「数值 + 单位」的耗时输入。给了这一对就按**最新** habits 配置换算出
   * `estimated_minutes` 落库（覆盖同时传入的旧字段），两列本身留档供回显。
   * 只给旧 `estimated_minutes` 时这两列写 NULL。
   */
  duration_value?: number | null;
  duration_unit?: DurationUnit | null;
  cognitive_load?: 'low' | 'medium' | 'high' | null;
  task_type?: Task['task_type'];
  manual_priority?: number;
  /** Legacy 1..5 axes, kept for older clients. */
  importance?: number;
  urgency?: number;
  /**
   * Continuous 0..100 scores from a real Agent (or the user), supplied at
   * creation time so the task never briefly carries a rule score presented as
   * something it is not.
   */
  matrix_score?: MatrixScoreSubmission;
  /**
   * An already-computed rule suggestion to store verbatim instead of re-deriving
   * one (UX-22).
   *
   * The decomposition preview shows the user a quadrant and then creates the
   * task on confirmation. Re-running `inferQuadrant` here would recompute it
   * from scratch and silently drop any post-processing the preview applied — the
   * "no target date, so not urgent" demotion in particular — so the task would
   * land in a different quadrant than the one the user just confirmed. Passing
   * the suggestion through keeps preview and stored value identical. Still
   * `source = 'rule'` and unconfirmed: it is the same local rule judgement.
   */
  rule_suggestion?: QuadrantSuggestion;
  depends_on?: string[];
  is_demo?: boolean;
}

function requireTask(db: Db, id: string): Task {
  const task = findTask(db, id);
  if (!task) throw notFound(`No task with id "${id}".`);
  return task;
}

/** 一次耗时输入解析成要落库的三列。 */
interface ResolvedDuration {
  estimated_minutes: number | null;
  duration_value: number | null;
  duration_unit: DurationUnit | null;
}

/**
 * 把 `duration_value` + `duration_unit` 按**最新** habits 配置折算成分钟。
 *
 * 读配置这一步放在每次写入时做（`loadDurationConfig` 本身不缓存），所以用户刚
 * 改完「每天几小时」，下一个任务就按新配置算。换算失败（数值非正/非有限）由
 * `durationToMinutes` 抛错，这里翻译成 400，不让非法值进库。
 */
function resolveDuration(value: number, unit: DurationUnit): ResolvedDuration {
  try {
    return {
      estimated_minutes: durationToMinutes(value, unit, loadDurationConfig()),
      duration_value: value,
      duration_unit: unit,
    };
  } catch (error) {
    throw badRequest(`耗时换算失败：${(error as Error).message}`, { duration_value: value, duration_unit: unit });
  }
}

/**
 * Creates a task.
 *
 * Quadrant provenance, in precedence order:
 * 1. `matrix_score` — a real Agent or user judgement on the 0..100 axes. The
 *    quadrant is derived from those scores; an Agent score stays unconfirmed.
 * 2. explicit legacy `importance`/`urgency` — the user already decided, so the
 *    quadrant is derived from *their* numbers, not from the rule suggestion.
 * 3. otherwise the local keyword rules, stored as `source = 'rule'` — they are
 *    not a model and must never be labelled `agent`. `rule_suggestion` lets a
 *    caller hand in the rule result it already showed the user rather than
 *    having it recomputed here.
 */
export function createTask(db: Db, input: CreateTaskInput): Task {
  if (input.recurrence) validateRecurrence(db, input.goal_id ?? null, input.recurrence);
  const goalTitle = input.goal_id
    ? (get<Row>(db, 'SELECT title FROM goals WHERE id = ?', [input.goal_id])?.title ?? null)
    : null;
  if (input.goal_id && goalTitle === null) {
    throw notFound(`No goal with id "${input.goal_id}".`);
  }

  const scored = input.matrix_score ? validateMatrixScore(input.matrix_score) : null;
  const explicitScores = input.importance != null && input.urgency != null;
  // 「数值 + 单位」优先：给了这一对就以换算结果为准，覆盖同时传入的旧字段。
  const duration: ResolvedDuration =
    input.duration_value != null && input.duration_unit
      ? resolveDuration(input.duration_value, input.duration_unit)
      : {
          estimated_minutes: input.estimated_minutes ?? null,
          duration_value: null,
          duration_unit: null,
        };
  const suggestion =
    input.rule_suggestion ??
    inferQuadrant({
      title: input.title,
      description: input.description,
      deadline: input.deadline,
      // 象限推断读的始终是换算后的分钟事实，规则本身一字未改。
      estimated_minutes: duration.estimated_minutes,
      cognitive_load: input.cognitive_load,
      task_type: input.task_type,
      goal_title: goalTitle,
    });

  // One derivation, one source of truth, whichever branch supplied the numbers.
  const resolved = scored
    ? {
        importance: legacyAxisValue(scored.importance_score),
        urgency: legacyAxisValue(scored.urgency_score),
        quadrant: scored.quadrant,
        quadrantSource: scored.source,
        confidence: scored.confidence,
        reason: scored.reason,
        confirmed: scored.quadrant_confirmed,
        matrixImportance: scored.importance_score,
        matrixUrgency: scored.urgency_score,
        matrixSource: scored.source as string,
        matrixVersion: 1,
      }
    : explicitScores
      ? {
          importance: input.importance!,
          urgency: input.urgency!,
          // Derived from the user's own numbers — not from the rule suggestion.
          quadrant: quadrantFor(input.importance!, input.urgency!),
          quadrantSource: 'user',
          confidence: null,
          reason:
            `由用户给出的 importance ${input.importance}/5、urgency ${input.urgency}/5 直接判定象限。`,
          confirmed: true,
          matrixImportance: null,
          matrixUrgency: null,
          matrixSource: 'unset',
          matrixVersion: 0,
        }
      : {
          importance: suggestion.importance,
          urgency: suggestion.urgency,
          quadrant: suggestion.quadrant,
          // Local keyword rules — deliberately not 'agent'.
          quadrantSource: 'rule',
          confidence: suggestion.confidence,
          reason: suggestion.reason,
          confirmed: false,
          matrixImportance: suggestion.importance_score,
          matrixUrgency: suggestion.urgency_score,
          matrixSource: 'rule',
          matrixVersion: 0,
        };

  const id = newId('task');
  const timestamp = nowIso();

  run(
    db,
    `INSERT INTO tasks (
       id, title, description, goal_id, status, importance, urgency,
       quadrant, quadrant_source, quadrant_confidence, quadrant_reason, quadrant_confirmed,
       matrix_importance_score, matrix_urgency_score, matrix_score_source,
       matrix_score_reason, matrix_score_confidence, matrix_score_version, matrix_scored_at,
       deadline, estimated_minutes, duration_value, duration_unit,
       cognitive_load, task_type, manual_priority, manual_override,
       is_demo, created_at, updated_at, version
     ) VALUES (?, ?, ?, ?, 'inbox', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 1)`,
    [
      id,
      input.title.trim(),
      input.description?.trim() || null,
      input.goal_id ?? null,
      resolved.importance,
      resolved.urgency,
      resolved.quadrant,
      resolved.quadrantSource,
      resolved.confidence,
      resolved.reason,
      resolved.confirmed ? 1 : 0,
      resolved.matrixImportance,
      resolved.matrixUrgency,
      resolved.matrixSource,
      resolved.matrixImportance == null ? null : resolved.reason,
      resolved.matrixImportance == null ? null : resolved.confidence,
      resolved.matrixVersion,
      resolved.matrixImportance == null ? null : timestamp,
      input.deadline ?? null,
      duration.estimated_minutes,
      duration.duration_value,
      duration.duration_unit,
      input.cognitive_load ?? null,
      input.task_type ?? null,
      input.manual_priority ?? 0,
      input.is_demo ? 1 : 0,
      timestamp,
      timestamp,
    ],
  );

  if (input.recurrence) configureRecurrence(db, id, input.recurrence);

  for (const dependencyId of input.depends_on ?? []) {
    if (!findTask(db, dependencyId)) {
      throw notFound(`Cannot depend on unknown task "${dependencyId}".`);
    }
    run(
      db,
      'INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_id, created_at) VALUES (?, ?, ?)',
      [id, dependencyId, timestamp],
    );
  }

  return requireTask(db, id);
}

const UPDATABLE_COLUMNS = {
  title: 'title',
  description: 'description',
  goal_id: 'goal_id',
  deadline: 'deadline',
  estimated_minutes: 'estimated_minutes',
  cognitive_load: 'cognitive_load',
  task_type: 'task_type',
  manual_priority: 'manual_priority',
  manual_override: 'manual_override',
  importance: 'importance',
  urgency: 'urgency',
} as const;

export type UpdateTaskInput = Partial<Record<keyof typeof UPDATABLE_COLUMNS, unknown>> & {
  /**
   * 「数值 + 单位」的耗时输入。不是直接列映射：给了就按最新 habits 配置重算
   * `estimated_minutes`，三列一起写（见 `durationAssignments`）。
   */
  duration_value?: number | null;
  duration_unit?: DurationUnit | null;
  /** Optimistic concurrency: reject the write if the task moved on. */
  expected_version?: number;
};

/**
 * 耗时三列的 SET 片段。
 *
 * - 传了 `duration_value` + `duration_unit` → 换算后同时写 `estimated_minutes`、
 *   `duration_value`、`duration_unit`，所以事实值和回显单位永远一致。
 * - `duration_value: null` → 视为清空耗时：三列一起置 NULL。
 * - 两者都没传 → 返回空，`estimated_minutes` 走原来的直接列映射，**不动** duration
 *   两列（旧客户端只改分钟时，任务原本记着的单位不该被悄悄抹掉）。
 */
function durationAssignments(input: UpdateTaskInput): {
  assignments: string[];
  params: (string | number | null)[];
} {
  const hasValue = 'duration_value' in input;
  const hasUnit = 'duration_unit' in input;
  if (!hasValue && !hasUnit) return { assignments: [], params: [] };

  const columns = ['estimated_minutes = ?', 'duration_value = ?', 'duration_unit = ?'];

  // 清空：null 值（或只给了 duration_unit: null）把耗时整体擦掉。
  if (input.duration_value == null) {
    if (input.duration_unit != null) {
      throw badRequest('清空耗时时不能同时指定单位：请把 duration_value 与 duration_unit 一起置空。');
    }
    return { assignments: columns, params: [null, null, null] };
  }

  if (!input.duration_unit) {
    throw badRequest('duration_value 与 duration_unit 必须同时提供。');
  }

  const resolved = resolveDuration(input.duration_value, input.duration_unit);
  return {
    assignments: columns,
    params: [resolved.estimated_minutes, resolved.duration_value, resolved.duration_unit],
  };
}

export function updateTask(db: Db, id: string, input: UpdateTaskInput): Task {
  const current = requireTask(db, id);
  if (input.expected_version != null && input.expected_version !== current.version) {
    throw conflict(
      `Task was modified by someone else (expected version ${input.expected_version}, found ${current.version}).`,
      { expected: input.expected_version, actual: current.version },
    );
  }

  if ('goal_id' in input && current.recurrence) validateRecurrence(db, input.goal_id as string | null, current.recurrence);
  const duration = durationAssignments(input);
  const assignments: string[] = [...duration.assignments];
  const params: (string | number | null)[] = [...duration.params];
  for (const [field, column] of Object.entries(UPDATABLE_COLUMNS)) {
    if (field in input && field !== 'expected_version') {
      // duration 分支已经写过 estimated_minutes 了，别再写第二遍（后者会覆盖换算结果）。
      if (field === 'estimated_minutes' && duration.assignments.length > 0) continue;
      const value = input[field as keyof typeof UPDATABLE_COLUMNS];
      assignments.push(`${column} = ?`);
      params.push(value === undefined ? null : (value as string | number | null));
    }
  }
  if (assignments.length === 0) {
    throw badRequest('No updatable fields supplied.');
  }

  if (input.goal_id) {
    if (!get<Row>(db, 'SELECT 1 FROM goals WHERE id = ?', [input.goal_id as string])) {
      throw notFound(`No goal with id "${input.goal_id}".`);
    }
  }

  params.push(nowIso(), id);
  run(
    db,
    `UPDATE tasks SET ${assignments.join(', ')}, updated_at = ?, version = version + 1 WHERE id = ?`,
    params,
  );

  // Changing either axis must move the quadrant with it — otherwise the stored
  // classification silently disagrees with the scores it claims to come from.
  if ('importance' in input || 'urgency' in input) {
    const after = requireTask(db, id);
    const quadrant = quadrantFor(after.importance, after.urgency);
    if (quadrant !== after.quadrant) {
      run(
        db,
        `UPDATE tasks
            SET quadrant = ?, quadrant_source = 'user', quadrant_confidence = NULL,
                quadrant_confirmed = 1, quadrant_reason = ?
          WHERE id = ?`,
        [
          quadrant,
          `象限随用户修改的 importance ${after.importance}/5、urgency ${after.urgency}/5 重新判定为 ${quadrant}。`,
          id,
        ],
      );
    }
  }

  return requireTask(db, id);
}

/**
 * Records a continuous 0..100 judgement for both axes and derives the quadrant
 * from it.
 *
 * This endpoint **validates and persists only** — it does not call, and does not
 * pretend to call, any model. The caller (a real Agent loading the Skill, or the
 * user) is the one that produced the numbers and the rationale.
 */
export function scoreTaskMatrix(
  db: Db,
  id: string,
  input: MatrixScoreSubmission & { expected_version?: number },
): Task {
  const current = requireTask(db, id);
  if (input.expected_version != null && input.expected_version !== current.version) {
    throw conflict(
      `任务已被其他写入修改（期望版本 ${input.expected_version}，实际 ${current.version}），请重新读取后再提交评分。`,
      { expected: input.expected_version, actual: current.version },
    );
  }

  const scored = validateMatrixScore(input);
  const timestamp = nowIso();

  run(
    db,
    `UPDATE tasks
        SET matrix_importance_score = ?, matrix_urgency_score = ?, matrix_score_source = ?,
            matrix_score_reason = ?, matrix_score_confidence = ?,
            matrix_score_version = matrix_score_version + 1, matrix_scored_at = ?,
            importance = ?, urgency = ?,
            quadrant = ?, quadrant_source = ?, quadrant_confidence = ?,
            quadrant_reason = ?, quadrant_confirmed = ?,
            updated_at = ?, version = version + 1
      WHERE id = ?`,
    [
      scored.importance_score,
      scored.urgency_score,
      scored.source,
      scored.reason,
      scored.confidence,
      timestamp,
      legacyAxisValue(scored.importance_score),
      legacyAxisValue(scored.urgency_score),
      scored.quadrant,
      scored.source,
      scored.confidence,
      scored.reason,
      scored.quadrant_confirmed ? 1 : 0,
      timestamp,
      id,
    ],
  );

  return requireTask(db, id);
}

export interface ActionInput {
  action: TaskAction;
  actor_id: string;
  reason?: string | null;
  /** Optimistic concurrency: reject the move if the task moved on. */
  expected_version?: number;
}

/**
 * Reads the status a task had right before it was archived, from the most recent
 * succeeded `task.archive` operation. Falls back to `completed` for legacy
 * archived rows that have no archive operation on record (a safe out-of-queue
 * resting state rather than silently dropping the task into the inbox).
 */
function restoreTargetFromHistory(db: Db, taskId: string): TaskStatus {
  const row = get<Row>(
    db,
    `SELECT detail FROM operations
      WHERE operation_type = 'task.archive' AND target_id = ? AND status = 'succeeded'
      ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    [taskId],
  );
  if (row?.detail) {
    try {
      const parsed = JSON.parse(String(row.detail)) as { from?: string };
      if (parsed?.from && TASK_STATUSES.includes(parsed.from as TaskStatus)) {
        return parsed.from as TaskStatus;
      }
    } catch {
      // Corrupt detail falls through to the safe default.
    }
  }
  return 'completed';
}

/**
 * Applies a lifecycle action. Claim bookkeeping is derived from the transition
 * table; "one active claim per task" is enforced both here and by a partial
 * unique index in the schema.
 *
 * `restore` is the one move whose destination is dynamic: it reverses the most
 * recent `task.archive`, returning the task to that recorded status and
 * re-activating the claim the archive had released. The task id, goal link,
 * assignment rows and operation records are all preserved — nothing is deleted
 * and recreated.
 */
export function applyAction(db: Db, id: string, input: ActionInput): Task {
  const task = requireTask(db, id);
  if (task.recurrence && input.action === 'complete') throw conflict('循环任务请完成当日执行记录；整个循环需到结束日后单独结束');
  if (input.expected_version != null && input.expected_version !== task.version) {
    throw conflict(
      `任务已被其他写入修改（期望版本 ${input.expected_version}，实际 ${task.version}），请重新读取后再操作。`,
      { expected: input.expected_version, actual: task.version },
    );
  }
  const { to, claim } = assertTransition(task.status, input.action);
  const timestamp = nowIso();

  if (requiresClaim(input.action)) {
    if (!task.active_assignment) {
      throw conflict(`Cannot ${input.action} "${task.title}" — nobody holds a claim on it.`);
    }
    if (task.active_assignment.actor_id !== input.actor_id) {
      throw conflict(
        `Cannot ${input.action} "${task.title}" — claimed by ${task.active_assignment.actor_name}.`,
        { held_by: task.active_assignment.actor_id },
      );
    }
  }

  if (claim === 'acquire') {
    if (task.active_assignment) {
      throw conflict(
        `"${task.title}" is already claimed by ${task.active_assignment.actor_name}.`,
        { held_by: task.active_assignment.actor_id },
      );
    }
    if (!get<Row>(db, 'SELECT 1 FROM actors WHERE id = ?', [input.actor_id])) {
      throw notFound(`No actor with id "${input.actor_id}".`);
    }
    run(
      db,
      'INSERT INTO task_assignments (id, task_id, actor_id, claimed_at) VALUES (?, ?, ?, ?)',
      [newId('asg'), id, input.actor_id, timestamp],
    );
  } else if (claim === 'release' && task.active_assignment) {
    run(
      db,
      'UPDATE task_assignments SET released_at = ?, release_reason = ? WHERE id = ?',
      [timestamp, input.reason ?? input.action, task.active_assignment.id],
    );
  }

  // The real destination for a restore comes from the archive history, not the
  // static placeholder. Re-activate the assignment the archive released so the
  // task returns to the same actor that held it.
  const effectiveTo: TaskStatus =
    input.action === 'restore' ? restoreTargetFromHistory(db, id) : to;
  if (input.action === 'restore') {
    if (effectiveTo === 'claimed' || effectiveTo === 'in_progress' || effectiveTo === 'blocked') {
      const released = get<Row>(
        db,
        `SELECT id FROM task_assignments
          WHERE task_id = ? AND released_at IS NOT NULL
          ORDER BY released_at DESC LIMIT 1`,
        [id],
      );
      if (released) {
        run(
          db,
          'UPDATE task_assignments SET released_at = NULL, release_reason = NULL WHERE id = ?',
          [released.id],
        );
      }
    }
  }

  // 进行中：补上 started_at（若缺）；其余状态一律保留原值——包括归档，这样
  // restore 回到已完成/进行中时不会丢掉归档前记录的时间戳。
  const startedAt =
    effectiveTo === 'in_progress' ? task.started_at ?? timestamp : task.started_at;
  const completedAt =
    effectiveTo === 'completed'
      ? task.completed_at ?? timestamp
      : effectiveTo === 'inbox'
        ? null
        : task.completed_at;
  const blockedReason =
    effectiveTo === 'blocked'
      ? input.reason ?? (task.blocked_reason ?? '从归档恢复：归档前处于受阻状态')
      : null;

  run(
    db,
    `UPDATE tasks
        SET status = ?, started_at = ?, completed_at = ?, blocked_reason = ?,
            updated_at = ?, version = version + 1
      WHERE id = ?`,
    [effectiveTo, startedAt, completedAt, blockedReason, timestamp, id],
  );

  return requireTask(db, id);
}

/** User confirms the suggested quadrant as-is. */
export function confirmQuadrant(db: Db, id: string): Task {
  const task = requireTask(db, id);
  if (!task.quadrant) {
    throw badRequest(`"${task.title}" has no suggested quadrant to confirm.`);
  }
  run(
    db,
    `UPDATE tasks SET quadrant_confirmed = 1, quadrant_source = 'user',
       quadrant_reason = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
    [
      `${task.quadrant_reason ?? ''}\nConfirmed by the user without change.`.trim(),
      nowIso(),
      id,
    ],
  );
  return requireTask(db, id);
}

/**
 * 「手动移动象限」已停用——这个入口**只拒绝，不写库**。
 *
 * 它过去把两轴分数写死到所选象限的band里（75/25 之类），那是伪评分：用户选的
 * 是一个格子，不是两个分数，凭一次点击造出来的数字会伪装成真实判断落进
 * `matrix_*` 列，再也分不出哪些分数有依据。所以现在一律抛 `ApiError`：
 * 真实评分必须来自真实 Agent 的复评建议，并经用户确认后才写库
 * （见 `server/repo/rescoring-service.ts`）。
 *
 * 签名保持不变，调用方（routes.ts / agent runtime）照旧捕获 `ApiError` 并把
 * 这段文案回给用户——这正是期望的行为，不需要改动它们。
 */
export function changeQuadrant(db: Db, id: string, quadrant: Quadrant, reason?: string): Task {
  const task = requireTask(db, id);
  throw badRequest(
    `「手动移动象限」已停用：请对「${task.title}」发起复评请求，` +
      `由真实 Agent 给出两轴建议并经你确认后才会落库。` +
      `本次未写入任何分数或象限确认。` +
      `（请求的目标象限 ${quadrant}（${QUADRANT_LABELS[quadrant]}）${reason ? `，理由：${reason}` : ''}）`,
    { task_id: task.id, requested_quadrant: quadrant, wrote: false },
  );
}

/**
 * Re-runs the local keyword rules, e.g. after the deadline or type changed.
 *
 * Stored as `source = 'rule'`: this is a regex/keyword engine, and labelling its
 * output `agent` would misrepresent a script's output as a model judgement.
 */
export function resuggestQuadrant(db: Db, id: string): Task {
  const task = requireTask(db, id);
  const suggestion = inferQuadrant({
    title: task.title,
    description: task.description,
    deadline: task.deadline,
    estimated_minutes: task.estimated_minutes,
    cognitive_load: task.cognitive_load,
    task_type: task.task_type,
    goal_title: task.goal_title,
  });
  run(
    db,
    `UPDATE tasks
        SET quadrant = ?, importance = ?, urgency = ?, quadrant_source = 'rule',
            quadrant_confidence = ?, quadrant_confirmed = 0, quadrant_reason = ?,
            matrix_importance_score = ?, matrix_urgency_score = ?,
            matrix_score_source = 'rule', matrix_score_reason = ?,
            matrix_score_confidence = ?, matrix_scored_at = ?,
            updated_at = ?, version = version + 1
      WHERE id = ?`,
    [
      suggestion.quadrant,
      suggestion.importance,
      suggestion.urgency,
      suggestion.confidence,
      suggestion.reason,
      suggestion.importance_score,
      suggestion.urgency_score,
      suggestion.reason,
      suggestion.confidence,
      nowIso(),
      nowIso(),
      id,
    ],
  );
  return requireTask(db, id);
}

export function addDependency(db: Db, taskId: string, dependsOnId: string): Task {
  requireTask(db, taskId);
  requireTask(db, dependsOnId);
  if (taskId === dependsOnId) {
    throw badRequest('A task cannot depend on itself.');
  }
  if (createsCycle(db, taskId, dependsOnId)) {
    throw badRequest('That dependency would create a cycle.');
  }
  if (!get(db, 'SELECT 1 FROM task_dependencies WHERE task_id = ? AND depends_on_id = ?', [taskId, dependsOnId])) {
    run(db, 'INSERT INTO task_dependencies (task_id, depends_on_id, created_at) VALUES (?, ?, ?)', [taskId, dependsOnId, nowIso()]);
    for (const id of [taskId, dependsOnId]) run(db, 'UPDATE tasks SET version = version + 1, updated_at = ? WHERE id = ?', [nowIso(), id]);
  }
  return requireTask(db, taskId);
}

/** Walks the existing edges to check whether `dependsOnId` already needs `taskId`. */
function createsCycle(db: Db, taskId: string, dependsOnId: string): boolean {
  const seen = new Set<string>();
  const stack = [dependsOnId];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === taskId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    const rows = db
      .prepare('SELECT depends_on_id FROM task_dependencies WHERE task_id = ?')
      .all(current) as Row[];
    stack.push(...rows.map((r) => r.depends_on_id as string));
  }
  return false;
}
