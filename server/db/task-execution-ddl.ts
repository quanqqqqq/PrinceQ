export const TASK_EXECUTION_DDL = `
CREATE TABLE IF NOT EXISTS task_recurrences (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  start_date TEXT NOT NULL, every_days INTEGER NOT NULL DEFAULT 1, start_time TEXT NOT NULL DEFAULT '09:00', interval INTEGER NOT NULL CHECK(interval BETWEEN 1 AND 365),
  unit TEXT NOT NULL CHECK(unit IN ('hour','day','week','month')),
  timezone TEXT NOT NULL, end_mode TEXT NOT NULL CHECK(end_mode IN ('goal','date')),
  end_date TEXT, status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','ended')),
  version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS task_recurrence_revisions (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES task_recurrences(task_id) ON DELETE CASCADE,
  effective_from TEXT NOT NULL, plan_json TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(task_id,effective_from)
);
CREATE TABLE IF NOT EXISTS task_assistance_previews (
  token TEXT PRIMARY KEY REFERENCES agent_pending_actions(token) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES task_assistance_sessions(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  message_id TEXT, snapshot_json TEXT NOT NULL, result_json TEXT, replaced_by TEXT
);
CREATE TABLE IF NOT EXISTS task_recurrence_pauses (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES task_recurrences(task_id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK(scope IN ('task','goal')), from_key TEXT NOT NULL, to_key TEXT
);
CREATE TABLE IF NOT EXISTS task_occurrences (
  task_id TEXT NOT NULL REFERENCES task_recurrences(task_id) ON DELETE CASCADE,
  date TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','in_progress','completed','skipped')),
  opened_at TEXT, completed_at TEXT, note TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(task_id,date)
);
CREATE TABLE IF NOT EXISTS task_assistance_sessions (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
  artifact TEXT NOT NULL DEFAULT '', artifact_task_version INTEGER, artifact_date TEXT, ready INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0,
  accepted_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS task_assistance_messages (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES task_assistance_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('user','assistant')), content TEXT NOT NULL, summary_json TEXT NOT NULL DEFAULT '[]',
  request_key TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(session_id,request_key,role)
);
`;
