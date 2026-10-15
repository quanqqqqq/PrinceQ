/** Row → Task/Goal hydration shared by every repository query. */
import type {
  Goal,
  GoalProgress,
  GoalWithProgress,
  Task,
  TaskAssignment,
} from '../../shared/types.ts';
import { readRecurrence } from './recurrence.ts';
import { all, get, toBool, type Db, type Row } from '../db/connection.ts';

const TASK_SELECT = `
  SELECT t.*, g.title AS goal_title
  FROM tasks t
  LEFT JOIN goals g ON g.id = t.goal_id
`;

const DONE_STATUSES = new Set(['completed', 'archived']);

function hydrateAssignment(row: Row | undefined): TaskAssignment | null {
  if (!row) return null;
  return {
    id: row.id,
    task_id: row.task_id,
    actor_id: row.actor_id,
    actor_name: row.actor_name ?? row.actor_id,
    claimed_at: row.claimed_at,
    released_at: row.released_at ?? null,
    release_reason: row.release_reason ?? null,
  };
}

interface TaskGraph {
  dependsOn: Map<string, string[]>;
  blocks: Map<string, string[]>;
  statusById: Map<string, string>;
  assignments: Map<string, Row>;
  db: Db;
}

function loadGraph(db: Db): TaskGraph {
  const deps = all<Row>(db, 'SELECT task_id, depends_on_id FROM task_dependencies');
  const dependsOn = new Map<string, string[]>();
  const blocks = new Map<string, string[]>();
  for (const { task_id, depends_on_id } of deps) {
    dependsOn.set(task_id, [...(dependsOn.get(task_id) ?? []), depends_on_id]);
    blocks.set(depends_on_id, [...(blocks.get(depends_on_id) ?? []), task_id]);
  }
  const statusById = new Map<string, string>(
    all<Row>(db, 'SELECT id, status FROM tasks').map((r) => [r.id, r.status]),
  );
  const assignments = new Map<string, Row>(
    all<Row>(
      db,
      `SELECT a.*, ac.display_name AS actor_name
       FROM task_assignments a
       JOIN actors ac ON ac.id = a.actor_id
       WHERE a.released_at IS NULL`,
    ).map((r) => [r.task_id, r]),
  );
  return { dependsOn, blocks, statusById, assignments, db };
}

function hydrateTask(row: Row, graph: TaskGraph): Task {
  const dependsOn = graph.dependsOn.get(row.id) ?? [];
  const dependencyReady = dependsOn.every((id) =>
    DONE_STATUSES.has(graph.statusById.get(id) ?? 'inbox'),
  );
  return {
    id: row.id,
    recurrence: readRecurrence(graph.db, row.id),
    title: row.title,
    description: row.description ?? null,
    goal_id: row.goal_id ?? null,
    goal_title: row.goal_title ?? null,
    status: row.status,
    importance: row.importance,
    urgency: row.urgency,
    quadrant: row.quadrant ?? null,
    quadrant_source: row.quadrant_source,
    quadrant_confidence: row.quadrant_confidence ?? null,
    quadrant_reason: row.quadrant_reason ?? null,
    quadrant_confirmed: toBool(row.quadrant_confirmed),
    matrix_importance_score: row.matrix_importance_score ?? null,
    matrix_urgency_score: row.matrix_urgency_score ?? null,
    matrix_score_source: row.matrix_score_source ?? 'unset',
    matrix_score_reason: row.matrix_score_reason ?? null,
    matrix_score_confidence: row.matrix_score_confidence ?? null,
    matrix_score_version: row.matrix_score_version ?? 0,
    matrix_scored_at: row.matrix_scored_at ?? null,
    deadline: row.deadline ?? null,
    estimated_minutes: row.estimated_minutes ?? null,
    // 旧库/旧任务没有这两列（或为 NULL）：读成 null，前端按 minute 回退显示
    // estimated_minutes。
    duration_value: row.duration_value ?? null,
    duration_unit: row.duration_unit ?? null,
    cognitive_load: row.cognitive_load ?? null,
    task_type: row.task_type ?? null,
    manual_priority: row.manual_priority,
    manual_override: row.manual_override,
    blocked_reason: row.blocked_reason ?? null,
    is_demo: toBool(row.is_demo),
    created_at: row.created_at,
    updated_at: row.updated_at,
    started_at: row.started_at ?? null,
    completed_at: row.completed_at ?? null,
    version: row.version,
    active_assignment: hydrateAssignment(graph.assignments.get(row.id)),
    depends_on: dependsOn,
    blocks: graph.blocks.get(row.id) ?? [],
    dependency_ready: dependencyReady,
    queue_position: row.queue_position ?? null,
    queue_score: row.queue_score ?? null,
  };
}

export function listTasks(
  db: Db,
  filters: { status?: string[]; goal_id?: string; quadrant?: string; unconfirmed?: boolean } = {},
): Task[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filters.status?.length) {
    where.push(`t.status IN (${filters.status.map(() => '?').join(', ')})`);
    params.push(...filters.status);
  }
  if (filters.goal_id) {
    where.push('t.goal_id = ?');
    params.push(filters.goal_id);
  }
  if (filters.quadrant) {
    where.push(filters.quadrant === 'unclassified' ? 't.quadrant IS NULL' : 't.quadrant = ?');
    if (filters.quadrant !== 'unclassified') params.push(filters.quadrant);
  }
  if (filters.unconfirmed) {
    where.push('t.quadrant_confirmed = 0');
  }
  const sql = `${TASK_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY CASE WHEN t.queue_position IS NULL THEN 1 ELSE 0 END, t.queue_position, t.created_at DESC`;
  const graph = loadGraph(db);
  return all<Row>(db, sql, params).map((row) => hydrateTask(row, graph));
}

export function findTask(db: Db, id: string): Task | null {
  const row = get<Row>(db, `${TASK_SELECT} WHERE t.id = ?`, [id]);
  if (!row) return null;
  return hydrateTask(row, loadGraph(db));
}

/**
 * Case-insensitive title lookup used by the Agent's "by title" commands.
 * Prefers an exact match, then a unique substring match.
 */
export function findTasksByTitle(db: Db, title: string): Task[] {
  const needle = title.trim().toLowerCase();
  if (!needle) return [];
  const graph = loadGraph(db);
  const rows = all<Row>(
    db,
    `${TASK_SELECT} WHERE LOWER(t.title) = ? OR INSTR(LOWER(t.title), ?) > 0
     ORDER BY CASE WHEN LOWER(t.title) = ? THEN 0 ELSE 1 END, t.created_at DESC`,
    [needle, needle, needle],
  );
  const exact = rows.filter((r) => String(r.title).toLowerCase() === needle);
  return (exact.length === 1 ? exact : rows).map((row) => hydrateTask(row, graph));
}

function hydrateGoal(row: Row): Goal {
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? null,
    status: row.status,
    target_date: row.target_date ?? null,
    color: row.color ?? null,
    is_demo: toBool(row.is_demo),
    created_at: row.created_at,
    updated_at: row.updated_at,
    version: row.version,
  };
}

function progressFor(db: Db, goalId: string): GoalProgress {
  const row = get<Row>(
    db,
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
       SUM(CASE WHEN status IN ('claimed', 'in_progress') THEN 1 ELSE 0 END) AS in_flight,
       SUM(CASE WHEN status = 'inbox' THEN 1 ELSE 0 END) AS open,
       SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) AS blocked
     FROM tasks WHERE goal_id = ? AND status <> 'archived'`,
    [goalId],
  );
  const total = Number(row?.total ?? 0);
  const completed = Number(row?.completed ?? 0);
  return {
    total,
    completed,
    in_flight: Number(row?.in_flight ?? 0),
    open: Number(row?.open ?? 0),
    blocked: Number(row?.blocked ?? 0),
    ratio: total === 0 ? 0 : Math.round((completed / total) * 100) / 100,
  };
}

export function listGoals(db: Db, status?: string[]): GoalWithProgress[] {
  const where = status?.length ? `WHERE status IN (${status.map(() => '?').join(', ')})` : '';
  return all<Row>(db, `SELECT * FROM goals ${where} ORDER BY created_at DESC`, status ?? []).map(
    (row) => ({ ...hydrateGoal(row), progress: progressFor(db, row.id) }),
  );
}

export function findGoal(db: Db, id: string): GoalWithProgress | null {
  const row = get<Row>(db, 'SELECT * FROM goals WHERE id = ?', [id]);
  if (!row) return null;
  return { ...hydrateGoal(row), progress: progressFor(db, row.id) };
}

export function findGoalsByTitle(db: Db, title: string): GoalWithProgress[] {
  const needle = title.trim().toLowerCase();
  if (!needle) return [];
  const rows = all<Row>(
    db,
    `SELECT * FROM goals WHERE LOWER(title) = ? OR INSTR(LOWER(title), ?) > 0
     ORDER BY CASE WHEN LOWER(title) = ? THEN 0 ELSE 1 END, created_at DESC`,
    [needle, needle, needle],
  );
  const exact = rows.filter((r) => String(r.title).toLowerCase() === needle);
  return (exact.length === 1 ? exact : rows).map((row) => ({
    ...hydrateGoal(row),
    progress: progressFor(db, row.id),
  }));
}

export function listAssignments(db: Db, taskId: string): TaskAssignment[] {
  return all<Row>(
    db,
    `SELECT a.*, ac.display_name AS actor_name
     FROM task_assignments a JOIN actors ac ON ac.id = a.actor_id
     WHERE a.task_id = ? ORDER BY a.claimed_at DESC`,
    [taskId],
  ).map((row) => hydrateAssignment(row)!);
}

export { hydrateTask, loadGraph };
