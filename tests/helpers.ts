/** Shared test helpers: in-memory database and task factories. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Task } from '../shared/types.ts';
import { applySchema, openDatabase, setDb, type Db } from '../server/db/connection.ts';
import { seedActors } from '../server/db/seed.ts';
import { DEFAULT_WEIGHTS, type HabitContext } from '../server/domain/habits.ts';

/** Fresh in-memory database with the schema and the three actors applied. */
export function freshDb(): Db {
  const db = openDatabase(':memory:');
  applySchema(db);
  seedActors(db);
  setDb(db);
  return db;
}

/** Isolated habits directory so tests never read or write the repo's habits/. */
export function withTempHabits(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwq-habits-'));
  process.env.PWQ_HABITS_DIR = dir;
  return dir;
}

export const emptyHabits = (overrides: Partial<HabitContext> = {}): HabitContext => ({
  weights: { ...DEFAULT_WEIGHTS },
  preferredTaskTypes: [],
  peakHours: [],
  explicit: [],
  inferred: [],
  constraints: [],
  ...overrides,
});

let counter = 0;

/** Minimal valid Task with sensible neutral defaults. */
export function makeTask(overrides: Partial<Task> = {}): Task {
  counter += 1;
  return {
    id: `task_test_${counter}`,
    title: `Test task ${counter}`,
    description: null,
    goal_id: null,
    goal_title: null,
    status: 'inbox',
    importance: 3,
    urgency: 3,
    quadrant: 'q2',
    quadrant_source: 'rule',
    quadrant_confidence: 0.5,
    quadrant_reason: 'test',
    quadrant_confirmed: false,
    matrix_importance_score: 40,
    matrix_urgency_score: 40,
    matrix_score_source: 'rule',
    matrix_score_reason: 'test',
    matrix_score_confidence: 0.5,
    matrix_score_version: 0,
    matrix_scored_at: null,
    deadline: null,
    estimated_minutes: null,
    duration_value: null,
    duration_unit: null,
    cognitive_load: null,
    task_type: null,
    manual_priority: 0,
    manual_override: 0,
    blocked_reason: null,
    is_demo: false,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    started_at: null,
    completed_at: null,
    version: 1,
    active_assignment: null,
    depends_on: [],
    blocks: [],
    dependency_ready: true,
    queue_position: null,
    queue_score: null,
    ...overrides,
  };
}

export const hoursFromNow = (hours: number, at = new Date()): string =>
  new Date(at.getTime() + hours * 36e5).toISOString();
