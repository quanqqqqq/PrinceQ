/** Queue snapshot persistence — writes explainable ranking records. */
import type {
  QueueEntry,
  QueueResponse,
  QueueSnapshot,
  ScoreBreakdown,
} from '../../shared/types.ts';
import { QUEUE_ALGORITHM_VERSION } from '../config.ts';
import { all, get, run, type Db, type Row } from '../db/connection.ts';
import { loadHabitContext } from '../domain/habits.ts';
import { rankTasks, buildScoringContext, scoreTask } from '../domain/queue.ts';
import { notFound } from '../lib/errors.ts';
import { newId, nowIso } from '../lib/ids.ts';
import { findTask, listTasks } from './tasks.ts';

export interface QueueRefresh {
  snapshot: QueueSnapshot | null;
  entries: QueueEntry[];
}

const hydrateSnapshot = (row: Row): QueueSnapshot => ({
  id: row.id,
  created_at: row.created_at,
  reason: row.reason,
  algorithm_version: row.algorithm_version,
  entry_count: row.entry_count,
});

/**
 * Recomputes the ranking, writes a new snapshot with per-task breakdowns, and
 * denormalises position/score onto `tasks` for cheap list rendering.
 *
 * Caller must already be inside a transaction when this runs as part of a write
 * (see `withOperation`).
 */
export function refreshQueue(db: Db, reason: string): QueueRefresh {
  const habits = loadHabitContext();
  const ranked = rankTasks(listTasks(db), habits);

  const snapshotId = newId('snap');
  const createdAt = nowIso();
  run(
    db,
    `INSERT INTO queue_snapshots (id, created_at, reason, algorithm_version, entry_count)
     VALUES (?, ?, ?, ?, ?)`,
    [snapshotId, createdAt, reason, QUEUE_ALGORITHM_VERSION, ranked.length],
  );

  run(db, 'UPDATE tasks SET queue_position = NULL, queue_score = NULL');

  const entries: QueueEntry[] = [];
  for (const { task, breakdown, position } of ranked) {
    run(
      db,
      `INSERT INTO queue_entries (id, snapshot_id, task_id, position, score, breakdown)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [newId('qe'), snapshotId, task.id, position, breakdown.score, JSON.stringify(breakdown)],
    );
    run(db, 'UPDATE tasks SET queue_position = ?, queue_score = ? WHERE id = ?', [
      position,
      breakdown.score,
      task.id,
    ]);
    entries.push({
      position,
      score: breakdown.score,
      task: { ...task, queue_position: position, queue_score: breakdown.score },
      breakdown,
    });
  }

  // Keep history bounded — the activity page only shows recent recalculations.
  run(
    db,
    `DELETE FROM queue_snapshots
      WHERE id NOT IN (SELECT id FROM queue_snapshots ORDER BY created_at DESC, rowid DESC LIMIT 50)`,
  );

  return {
    snapshot: {
      id: snapshotId,
      created_at: createdAt,
      reason,
      algorithm_version: QUEUE_ALGORITHM_VERSION,
      entry_count: ranked.length,
    },
    entries,
  };
}

export function latestSnapshot(db: Db): QueueSnapshot | null {
  const row = get<Row>(
    db,
    'SELECT * FROM queue_snapshots ORDER BY created_at DESC, rowid DESC LIMIT 1',
  );
  return row ? hydrateSnapshot(row) : null;
}

export function listSnapshots(db: Db, limit = 25): QueueSnapshot[] {
  return all<Row>(
    db,
    'SELECT * FROM queue_snapshots ORDER BY created_at DESC, rowid DESC LIMIT ?',
    [limit],
  ).map(hydrateSnapshot);
}

/** Reads the current queue, recalculating on first use when no snapshot exists. */
export function readQueue(db: Db): QueueResponse {
  const snapshot = latestSnapshot(db);
  if (!snapshot) {
    const refreshed = refreshQueue(db, 'initial-read');
    return { snapshot: refreshed.snapshot!, entries: refreshed.entries };
  }

  const taskRows = all<Row>(
    db,
    'SELECT task_id, position, score, breakdown FROM queue_entries WHERE snapshot_id = ? ORDER BY position',
    [snapshot.id],
  );

  const entries: QueueEntry[] = [];
  for (const row of taskRows) {
    const task = findTask(db, row.task_id);
    if (!task) continue; // Task deleted after the snapshot was taken.
    entries.push({
      position: row.position,
      score: row.score,
      task,
      breakdown: JSON.parse(row.breakdown) as ScoreBreakdown,
    });
  }
  return { snapshot, entries };
}

export function explainTask(db: Db, taskId: string): { task_id: string; position: number | null; breakdown: ScoreBreakdown; snapshot: QueueSnapshot | null } {
  const task = findTask(db, taskId);
  if (!task) throw notFound(`No task with id "${taskId}".`);

  const snapshot = latestSnapshot(db);
  const row = snapshot
    ? get<Row>(db, 'SELECT * FROM queue_entries WHERE snapshot_id = ? AND task_id = ?', [
        snapshot.id,
        taskId,
      ])
    : undefined;

  if (row) {
    return {
      task_id: taskId,
      position: row.position,
      breakdown: JSON.parse(row.breakdown) as ScoreBreakdown,
      snapshot,
    };
  }

  // Finished/archived tasks hold no queue position — score them on the fly so
  // the explanation endpoint still returns a full breakdown.
  const ctx = buildScoringContext(listTasks(db), loadHabitContext());
  return { task_id: taskId, position: null, breakdown: scoreTask(task, ctx), snapshot };
}
