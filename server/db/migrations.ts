/**
 * Idempotent, data-preserving column migrations.
 *
 * `schema.sql` is pure `CREATE … IF NOT EXISTS`, so a database created before a
 * column was added never gains it from re-applying the schema. These migrations
 * fill that gap: each one checks the current table shape first, so running them
 * repeatedly is a no-op. Nothing is ever deleted, re-seeded or re-classified.
 */
import type { Quadrant } from '../../shared/types.ts';
// `./rescoring-ddl.ts` imports nothing, so pulling the DDL in here keeps the
// single source of truth without reaching into `../repo/rescoring-service.ts`
// (which imports `./connection.ts`, which imports this module — a cycle).
import { TASK_EXECUTION_DDL } from './task-execution-ddl.ts';
import { AGENT_PENDING_ACTIONS_DDL } from './agent-pending-actions-ddl.ts';
import { RESCORING_REQUEST_DDL } from './rescoring-ddl.ts';

/**
 * Local structural aliases instead of importing `./connection.ts` — that module
 * calls into this one, and keeping the dependency one-way avoids a cycle.
 */
type Row = Record<string, any>;
type Db = {
  prepare(sql: string): { all(...params: any[]): unknown[]; run(...params: any[]): unknown };
};

const all = <T = Row>(db: Db, sql: string, params: unknown[] = []): T[] =>
  db.prepare(sql).all(...(params as any[])) as T[];
const run = (db: Db, sql: string, params: unknown[] = []): void => {
  db.prepare(sql).run(...(params as any[]));
};

/** The columns this round adds to `tasks`, with their DDL fragments. */
const TASK_MATRIX_COLUMNS: { name: string; ddl: string }[] = [
  {
    name: 'matrix_importance_score',
    ddl: 'REAL CHECK (matrix_importance_score IS NULL OR (matrix_importance_score BETWEEN 0 AND 100))',
  },
  {
    name: 'matrix_urgency_score',
    ddl: 'REAL CHECK (matrix_urgency_score IS NULL OR (matrix_urgency_score BETWEEN 0 AND 100))',
  },
  {
    name: 'matrix_score_source',
    ddl:
      "TEXT NOT NULL DEFAULT 'unset' " +
      "CHECK (matrix_score_source IN ('agent', 'user', 'rule', 'legacy', 'unset'))",
  },
  { name: 'matrix_score_reason', ddl: 'TEXT' },
  { name: 'matrix_score_confidence', ddl: 'REAL' },
  { name: 'matrix_score_version', ddl: 'INTEGER NOT NULL DEFAULT 0' },
  { name: 'matrix_scored_at', ddl: 'TEXT' },
];

export const LEGACY_SCORE_NOTICE = '旧版粗评分，待助手复评';

/**
 * 「耗时数值 + 单位」这一轮给 `tasks` 加的两列。DDL 与 `schema.sql` 逐字一致。
 */
const TASK_DURATION_COLUMNS: { name: string; ddl: string }[] = [
  {
    name: 'duration_value',
    ddl: 'REAL CHECK (duration_value IS NULL OR (duration_value > 0 AND duration_value <= 100000))',
  },
  {
    name: 'duration_unit',
    ddl: "TEXT CHECK (duration_unit IS NULL OR (duration_unit IN ('minute','day','month')))",
  },
];

/**
 * Coarse 1..5 → 0..100 projection used only for legacy rows.
 *
 * It is a *display* convenience, never a model judgement: the value stays inside
 * the band (>=50 high, <50 low) implied by the row's existing classification, so
 * the migration cannot move a task to a different quadrant.
 */
export function legacyScoreFor(oldValue: number, high: boolean): number {
  const clamped = Number.isFinite(oldValue) ? Math.min(Math.max(Math.round(oldValue), 1), 5) : 3;
  if (high) {
    // 4 → 65, 5 → 85; anything else that was classified high lands mid-band.
    return clamped >= 5 ? 85 : clamped <= 3 ? 60 : 65;
  }
  // 1 → 15, 2 → 25, 3 → 35; a 4/5 classified low stays just under the boundary.
  return clamped >= 4 ? 45 : clamped === 3 ? 35 : clamped === 2 ? 25 : 15;
}

const columnNames = (db: Db, table: string): Set<string> =>
  new Set(all<Row>(db, `PRAGMA table_info(${table})`).map((r) => String(r.name)));

export interface MigrationReport {
  columns_added: string[];
  rows_backfilled: number;
}

/**
 * Adds the matrix-score columns when missing and backfills rows that have no
 * continuous score yet.
 *
 * Backfill rules:
 * - A row keeps its existing `quadrant` verbatim; the legacy scores are placed
 *   inside that quadrant's band, so no classification changes.
 * - A row with no quadrant is left `unset` — it belongs in the "待评分" area
 *   rather than being given an invented score.
 * - Rows that already carry both matrix scores are never touched, so the
 *   migration is safe to re-run after real Agent scoring has happened.
 */
export function migrateTasksMatrixScores(db: Db): MigrationReport {
  const existing = columnNames(db, 'tasks');
  const added: string[] = [];
  for (const column of TASK_MATRIX_COLUMNS) {
    if (existing.has(column.name)) continue;
    run(db, `ALTER TABLE tasks ADD COLUMN ${column.name} ${column.ddl}`);
    added.push(column.name);
  }

  const pending = all<Row>(
    db,
    `SELECT id, importance, urgency, quadrant
       FROM tasks
      WHERE quadrant IS NOT NULL
        AND (matrix_importance_score IS NULL OR matrix_urgency_score IS NULL)`,
  );

  for (const row of pending) {
    const quadrant = row.quadrant as Quadrant;
    const important = quadrant === 'q1' || quadrant === 'q2';
    const urgent = quadrant === 'q1' || quadrant === 'q3';
    run(
      db,
      `UPDATE tasks
          SET matrix_importance_score = ?,
              matrix_urgency_score = ?,
              matrix_score_source = 'legacy',
              matrix_score_reason = ?,
              matrix_score_confidence = NULL,
              matrix_score_version = 0
        WHERE id = ?`,
      [
        legacyScoreFor(Number(row.importance), important),
        legacyScoreFor(Number(row.urgency), urgent),
        `${LEGACY_SCORE_NOTICE}：由旧版 importance ${row.importance}/5、urgency ${row.urgency}/5 ` +
          `按 ${quadrant} 原分类换算，非模型评分。`,
        row.id,
      ],
    );
  }

  return { columns_added: added, rows_backfilled: pending.length };
}

/**
 * 为早于 `goals.status` 引入的数据库补齐该列。
 *
 * 幂等：先看 `PRAGMA table_info(goals)`，列已存在就直接返回。
 * 保留数据：已有行一律填 `'active'`（进行中），不重分类、不删除任何目标。
 * 现代库（含本次真实库）已经带这一列，所以这里对它们是纯 no-op。
 */
export function migrateGoalsStatus(db: Db): MigrationReport {
  const existing = columnNames(db, 'goals');
  if (existing.has('status')) {
    return { columns_added: [], rows_backfilled: 0 };
  }
  run(
    db,
    `ALTER TABLE goals ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
       CHECK (status IN ('active', 'paused', 'achieved', 'dropped'))`,
  );
  // ALTER TABLE 已用默认值回填全部历史行；这里只报告事实，不再 UPDATE。
  return { columns_added: ['status'], rows_backfilled: 0 };
}

/**
 * 建出 `rescoring_requests`（复评请求表），纯 add-only。
 *
 * 幂等：DDL 本身是 `CREATE TABLE IF NOT EXISTS`，表已存在时整次调用是 no-op——
 * 不改列、不加列、不删列。这张表只记录复评流程自己的行，这里只保证空表存在，
 * 一行都不写、不回填、不动 `tasks` 等任何既有表。
 *
 * DDL 来自 `./rescoring-ddl.ts`（零依赖，唯一来源），和
 * `../repo/rescoring-service.ts` 的 `migrateRescoringSchema` 共用同一个常量。
 */
export function migrateRescoringRequestsTable(db: Db): MigrationReport {
  run(db, RESCORING_REQUEST_DDL);
  // 建表不产生任何列变更报告，也不回填任何行。
  return { columns_added: [], rows_backfilled: 0 };
}

/**
 * 为早于「耗时单位」特性的数据库补齐 `duration_value` / `duration_unit` 两列。
 *
 * 幂等：先看 `PRAGMA table_info(tasks)`，缺哪列才 `ALTER TABLE ... ADD COLUMN`，
 * DDL 与 `schema.sql` 里逐字一致。
 *
 * **绝不回填任何行**：历史任务的这两列保持 NULL，表示「当初是按分钟填的」，
 * 读取时前端按 minute 回退显示 `estimated_minutes`。给它们编一个单位等于凭空
 * 替用户做决定，而且会让 `duration_value` 与真实输入不符。
 */
export function migrateTaskDurationColumns(db: Db): MigrationReport {
  const existing = columnNames(db, 'tasks');
  const added: string[] = [];
  for (const column of TASK_DURATION_COLUMNS) {
    if (existing.has(column.name)) continue;
    run(db, `ALTER TABLE tasks ADD COLUMN ${column.name} ${column.ddl}`);
    added.push(column.name);
  }
  // 不回填：旧行的两列留空即是「按分钟填的」这一事实。
  return { columns_added: added, rows_backfilled: 0 };
}

/**
 * 建出 `agent_pending_actions`（模型建议的待确认动作），纯 add-only。
 *
 * 幂等：DDL 自带 `CREATE TABLE IF NOT EXISTS`，表已存在时整次调用是 no-op——
 * 不改列、不加列、不删列。只保证空表存在，一行都不写、不回填、不动任何既有表。
 *
 * 这张表是「模型想写什么」与「数据库里真有什么」之间的隔离带：模型的输出只落在
 * 这里，直到用户确认，才由既有的确定性 service 真正落库。
 */
export function migrateAgentPendingActionsTable(db: Db): MigrationReport {
  run(db, AGENT_PENDING_ACTIONS_DDL);
  // 建表不产生任何列变更报告，也不回填任何行。
  return { columns_added: [], rows_backfilled: 0 };
}

/** Runs every pending migration. Idempotent; preserves all existing rows. */
export function runMigrations(db: Db): MigrationReport {
  for (const statement of TASK_EXECUTION_DDL.split(';').map(item=>item.trim()).filter(Boolean)) run(db, statement);
  // Keep work created by older local recurrence prototypes intact.
  for (const [table,columns] of Object.entries({
    task_recurrences:{interval:'INTEGER NOT NULL DEFAULT 1',unit:"TEXT NOT NULL DEFAULT 'day'",start_time:"TEXT NOT NULL DEFAULT '09:00'"},
    task_assistance_messages:{summary_json:"TEXT NOT NULL DEFAULT '[]'"},
    task_assistance_sessions:{artifact_task_version:'INTEGER',artifact_date:'TEXT',ready:'INTEGER NOT NULL DEFAULT 0'},
  })) {
    const existing=columnNames(db,table);
    for(const [name,ddl] of Object.entries(columns))if(!existing.has(name)) {
      run(db,`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
      if(table==='task_recurrences'&&name==='interval'&&existing.has('every_days'))run(db,'UPDATE task_recurrences SET interval=every_days');
    }
  }
  const taskReport = migrateTasksMatrixScores(db);
  const goalReport = migrateGoalsStatus(db);
  const rescoringReport = migrateRescoringRequestsTable(db);
  const durationReport = migrateTaskDurationColumns(db);
  const pendingActionsReport = migrateAgentPendingActionsTable(db);
  return {
    columns_added: [
      ...taskReport.columns_added,
      ...goalReport.columns_added,
      ...rescoringReport.columns_added,
      ...durationReport.columns_added,
      ...pendingActionsReport.columns_added,
    ],
    rows_backfilled:
      taskReport.rows_backfilled +
      goalReport.rows_backfilled +
      rescoringReport.rows_backfilled +
      durationReport.rows_backfilled +
      pendingActionsReport.rows_backfilled,
  };
}
