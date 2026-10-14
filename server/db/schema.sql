-- Personal Work Queue — SQLite source of truth.
-- Applied by `npm run db:setup` (server/db/migrate.ts). Idempotent: every
-- statement is CREATE ... IF NOT EXISTS so re-running is safe.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS actors (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('human', 'agent', 'automation')),
  display_name TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS goals (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT,
  status      TEXT NOT NULL DEFAULT 'active'
              CHECK (status IN ('active', 'paused', 'achieved', 'dropped')),
  target_date TEXT,
  color       TEXT,
  is_demo     INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1)),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS tasks (
  id                  TEXT PRIMARY KEY,
  title               TEXT NOT NULL,
  description         TEXT,
  goal_id             TEXT REFERENCES goals (id) ON DELETE SET NULL,
  status              TEXT NOT NULL DEFAULT 'inbox'
                      CHECK (status IN ('inbox', 'claimed', 'in_progress', 'blocked', 'completed', 'archived')),
  importance          INTEGER NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
  urgency             INTEGER NOT NULL DEFAULT 3 CHECK (urgency BETWEEN 1 AND 5),
  quadrant            TEXT CHECK (quadrant IN ('q1', 'q2', 'q3', 'q4')),
  quadrant_source     TEXT NOT NULL DEFAULT 'unset'
                      CHECK (quadrant_source IN ('agent', 'user', 'rule', 'unset')),
  quadrant_confidence REAL,
  quadrant_reason     TEXT,
  quadrant_confirmed  INTEGER NOT NULL DEFAULT 0 CHECK (quadrant_confirmed IN (0, 1)),
  -- Continuous 0..100 matrix scores. Nullable: a task is unscored until an
  -- Agent or the user supplies both axes. `importance`/`urgency` above stay as
  -- the legacy 1..5 compatibility projection for older clients.
  matrix_importance_score REAL
                      CHECK (matrix_importance_score IS NULL
                             OR (matrix_importance_score BETWEEN 0 AND 100)),
  matrix_urgency_score    REAL
                      CHECK (matrix_urgency_score IS NULL
                             OR (matrix_urgency_score BETWEEN 0 AND 100)),
  matrix_score_source TEXT NOT NULL DEFAULT 'unset'
                      CHECK (matrix_score_source IN ('agent', 'user', 'rule', 'legacy', 'unset')),
  matrix_score_reason TEXT,
  matrix_score_confidence REAL,
  matrix_score_version    INTEGER NOT NULL DEFAULT 0,
  matrix_scored_at    TEXT,
  deadline            TEXT,
  estimated_minutes   INTEGER,
  -- 用户填的原始耗时数值与单位。`estimated_minutes` 仍是唯一参与评分的事实值
  -- （由这两列按 habits 配置换算而来）；这两列只为按原单位回显。两列对旧库由
  -- `migrateTaskDurationColumns` 补齐，且永不回填历史行。
  duration_value REAL CHECK (duration_value IS NULL OR (duration_value > 0 AND duration_value <= 100000)),
  duration_unit  TEXT CHECK (duration_unit  IS NULL OR (duration_unit  IN ('minute','day','month'))),
  cognitive_load      TEXT CHECK (cognitive_load IN ('low', 'medium', 'high')),
  task_type           TEXT CHECK (task_type IN ('deep_work', 'shallow_work', 'communication', 'admin', 'review', 'learning')),
  manual_priority     INTEGER NOT NULL DEFAULT 0 CHECK (manual_priority BETWEEN -2 AND 2),
  manual_override     REAL NOT NULL DEFAULT 0,
  blocked_reason      TEXT,
  queue_position      INTEGER,
  queue_score         REAL,
  is_demo             INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1)),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  started_at          TEXT,
  completed_at        TEXT,
  version             INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status);
CREATE INDEX IF NOT EXISTS idx_tasks_goal ON tasks (goal_id);
CREATE INDEX IF NOT EXISTS idx_tasks_queue_position ON tasks (queue_position);

-- One row per claim attempt. The partial unique index below is what actually
-- enforces "one active claim per task" at the storage layer.
CREATE TABLE IF NOT EXISTS task_assignments (
  id             TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  actor_id       TEXT NOT NULL REFERENCES actors (id),
  claimed_at     TEXT NOT NULL,
  released_at    TEXT,
  release_reason TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_claim_per_task
  ON task_assignments (task_id)
  WHERE released_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_assignments_task ON task_assignments (task_id);

CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id         TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  depends_on_id   TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  created_at      TEXT NOT NULL,
  PRIMARY KEY (task_id, depends_on_id),
  CHECK (task_id <> depends_on_id)
);

CREATE INDEX IF NOT EXISTS idx_deps_depends_on ON task_dependencies (depends_on_id);

CREATE TABLE IF NOT EXISTS queue_snapshots (
  id                TEXT PRIMARY KEY,
  created_at        TEXT NOT NULL,
  reason            TEXT NOT NULL,
  algorithm_version TEXT NOT NULL,
  entry_count       INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_snapshots_created ON queue_snapshots (created_at DESC);

CREATE TABLE IF NOT EXISTS queue_entries (
  id            TEXT PRIMARY KEY,
  snapshot_id   TEXT NOT NULL REFERENCES queue_snapshots (id) ON DELETE CASCADE,
  task_id       TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  position      INTEGER NOT NULL,
  score         REAL NOT NULL,
  -- Full explainable ScoreBreakdown as JSON.
  breakdown     TEXT NOT NULL,
  UNIQUE (snapshot_id, task_id)
);

CREATE INDEX IF NOT EXISTS idx_entries_snapshot ON queue_entries (snapshot_id, position);

CREATE TABLE IF NOT EXISTS operations (
  id              TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  operation_type  TEXT NOT NULL,
  target_type     TEXT NOT NULL,
  target_id       TEXT,
  actor_id        TEXT NOT NULL REFERENCES actors (id),
  status          TEXT NOT NULL CHECK (status IN ('succeeded', 'failed')),
  summary         TEXT NOT NULL,
  detail          TEXT,
  -- Cached response body so a replayed idempotency key returns the same payload.
  response        TEXT,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_operations_created ON operations (created_at DESC);

CREATE TABLE IF NOT EXISTS agent_sessions (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_messages (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES agent_sessions (id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('user', 'agent')),
  content    TEXT NOT NULL,
  result     TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON agent_messages (session_id, created_at);

-- Short-lived previews (goal decomposition, destructive batch confirmation).
CREATE TABLE IF NOT EXISTS pending_previews (
  token      TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  consumed_at TEXT
);
