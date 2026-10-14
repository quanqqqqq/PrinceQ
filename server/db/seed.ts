/**
 * Seed data: three clearly labelled demo goals and six demo tasks (the brief's
 * ceiling), chosen to exercise every UI state — an unclassified task, an
 * unconfirmed suggestion, a blocked task, a dependency pair and one in-progress
 * claim.
 *
 * Every row is flagged `is_demo = 1` so demo content is distinguishable.
 */
import { AGENT_ACTOR_ID, AUTOMATION_ACTOR_ID, DEFAULT_ACTOR_ID } from '../config.ts';
import { get, run, transaction, type Db, type Row } from './connection.ts';
import { ensureHabitFiles, writeHabitFile, readHabitFile } from '../domain/habits.ts';
import { newId, nowIso } from '../lib/ids.ts';
import { createGoal } from '../repo/goal-service.ts';
import { refreshQueue } from '../repo/queue-service.ts';
import { addDependency, applyAction, createTask } from '../repo/task-service.ts';

const inDays = (days: number, hour = 18): string => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
};

export function seedActors(db: Db): void {
  const actors = [
    { id: DEFAULT_ACTOR_ID, kind: 'human', name: 'Me' },
    { id: AGENT_ACTOR_ID, kind: 'agent', name: 'Local Agent (deterministic)' },
    { id: AUTOMATION_ACTOR_ID, kind: 'automation', name: 'Scheduled automation' },
  ];
  for (const actor of actors) {
    run(
      db,
      'INSERT OR IGNORE INTO actors (id, kind, display_name, created_at) VALUES (?, ?, ?, ?)',
      [actor.id, actor.kind, actor.name, nowIso()],
    );
  }
}

function seedHabits(): void {
  ensureHabitFiles();

  // Only populate the demo habit content on a fresh file, so re-running setup
  // never clobbers habits the user has since written.
  const explicit = readHabitFile('explicit');
  if (explicit.payload.entries.length === 0) {
    const timestamp = nowIso();
    writeHabitFile('explicit', {
      ...explicit,
      updated_at: timestamp,
      payload: {
        entries: [
          {
            id: newId('habit'),
            statement: 'Demo: deep work happens in the morning, before meetings start',
            kind: 'scheduling',
            enabled: true,
            confidence: null,
            source: 'user',
            created_at: timestamp,
            updated_at: timestamp,
          },
          {
            id: newId('habit'),
            statement: 'Demo: batch review and communication work into one afternoon block',
            kind: 'batching',
            enabled: true,
            confidence: null,
            source: 'user',
            created_at: timestamp,
            updated_at: timestamp,
          },
        ],
      },
      history: [{ at: timestamp, actor: DEFAULT_ACTOR_ID, change: 'seeded demo explicit habits' }],
    });
  }

  // Inferred habits start empty; only evidence-backed Agent observation creates them.

  const constraints = readHabitFile('constraints');
  if (constraints.payload.entries.length === 0) {
    const timestamp = nowIso();
    writeHabitFile('constraints', {
      ...constraints,
      updated_at: timestamp,
      payload: {
        entries: [
          {
            id: newId('hc'),
            statement: 'Demo: no scheduled work after 20:00',
            kind: 'forbidden_window',
            enabled: true,
            value: '20:00-07:00',
          },
        ],
      },
      history: [{ at: timestamp, actor: DEFAULT_ACTOR_ID, change: 'seeded demo hard constraint' }],
    });
  }
}

export interface SeedSummary {
  goals: number;
  tasks: number;
  skipped: boolean;
}

/** Idempotent: if demo rows already exist, seeding is skipped. */
export function seed(db: Db): SeedSummary {
  seedActors(db);
  seedHabits();

  const existing = get<Row>(db, 'SELECT COUNT(*) AS n FROM tasks');
  if (Number(existing?.n ?? 0) > 0) {
    return { goals: 0, tasks: 0, skipped: true };
  }

  return transaction(db, () => {
    const billing = createGoal(db, {
      title: 'Demo goal: Ship the billing rewrite',
      description:
        'Replace the legacy invoicing path. Demo data — delete it once you add your own work.',
      target_date: inDays(21),
      color: 'indigo',
      is_demo: true,
    });

    const learning = createGoal(db, {
      title: 'Demo goal: Learn SQLite internals',
      description: 'Understand WAL, indexes and query planning well enough to debug slow reads.',
      target_date: inDays(45),
      color: 'teal',
      is_demo: true,
    });

    const health = createGoal(db, {
      title: 'Demo goal: Sustainable work rhythm',
      description: 'Protect mornings for deep work and stop finishing the day depleted.',
      target_date: null,
      color: 'amber',
      is_demo: true,
    });

    // 1 — overdue, incident-flavoured: lands in q1 and tops the queue.
    const incident = createTask(db, {
      title: 'Demo: Fix the production invoice rounding incident',
      description:
        'Customers report cent-level mismatches on invoices. Urgent, customer-facing revenue impact.',
      goal_id: billing.id,
      deadline: inDays(-1, 17),
      estimated_minutes: 90,
      cognitive_load: 'high',
      task_type: 'deep_work',
      manual_priority: 1,
      is_demo: true,
    });

    // 2 — the dependency for #3, so the matrix and queue show readiness.
    const schema = createTask(db, {
      title: 'Demo: Design the new invoice schema',
      description: 'Decide the table layout and migration path before writing the migration.',
      goal_id: billing.id,
      deadline: inDays(3),
      estimated_minutes: 120,
      cognitive_load: 'high',
      task_type: 'deep_work',
      is_demo: true,
    });

    // 3 — blocked by #2: demonstrates the dependency penalty.
    const migration = createTask(db, {
      title: 'Demo: Write the invoice migration script',
      description: 'Backfill historical invoices once the schema is agreed.',
      goal_id: billing.id,
      deadline: inDays(7),
      estimated_minutes: 180,
      cognitive_load: 'high',
      task_type: 'deep_work',
      is_demo: true,
    });
    addDependency(db, migration.id, schema.id);

    // 4 — learning work: important, not urgent → q2.
    createTask(db, {
      title: 'Demo: Read the SQLite WAL design doc and take notes',
      description: 'One authoritative source, skimmed then studied. No deadline pressure.',
      goal_id: learning.id,
      deadline: inDays(30),
      estimated_minutes: 45,
      cognitive_load: 'medium',
      task_type: 'learning',
      is_demo: true,
    });

    // 5 — urgent chore, low stakes → q3.
    createTask(db, {
      title: 'Demo: Reply to the vendor renewal email today',
      description: 'They are waiting on a yes/no. Quick, but someone is blocked on me.',
      deadline: inDays(0, 17),
      estimated_minutes: 15,
      cognitive_load: 'low',
      task_type: 'communication',
      is_demo: true,
    });

    // 6 — standalone habit work tied to the rhythm goal.
    const rhythm = createTask(db, {
      title: 'Demo: Block mornings for deep work in the calendar',
      description: 'Make the habit structural rather than aspirational.',
      goal_id: health.id,
      estimated_minutes: 20,
      cognitive_load: 'low',
      task_type: 'admin',
      is_demo: true,
    });

    // Put the incident in progress and the schema task in a blocked state so
    // the first run shows a live claim and a blocked lane.
    applyAction(db, incident.id, { action: 'claim', actor_id: DEFAULT_ACTOR_ID });
    applyAction(db, incident.id, { action: 'start', actor_id: DEFAULT_ACTOR_ID });
    applyAction(db, rhythm.id, { action: 'claim', actor_id: DEFAULT_ACTOR_ID });
    applyAction(db, rhythm.id, {
      action: 'block',
      actor_id: DEFAULT_ACTOR_ID,
      reason: 'Waiting for next quarter calendar to open',
    });

    refreshQueue(db, 'seed');

    return { goals: 3, tasks: 6, skipped: false };
  });
}
