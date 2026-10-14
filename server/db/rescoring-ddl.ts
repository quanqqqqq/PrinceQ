/**
 * `rescoring_requests` 建表 DDL 的唯一来源。
 *
 * 单独放一个文件、**不 import 任何模块**，是为了同时被两边用而不绕出环：
 * `server/db/migrations.ts`（正式迁移路径）要用它建表，而
 * `server/repo/rescoring-service.ts` 又 import 了 `./connection.ts`，
 * `connection.ts` 则 import `migrations.ts`——DDL 若留在 service 里，迁移反过来
 * import service 就会成环。这里保持零依赖，依赖方向永远是单向的。
 *
 * `before_*_score` 是请求创建那一刻的快照：确认时要用它判断未被请求的轴有没有
 * 被动过，所以必须和 `after_*_score` 分开存。`target_quadrant` 只记录"用户当初
 * 想把任务拖到哪一格"，派生象限仍由确认时的两轴分数算出，不从这一列反推。
 */
export const RESCORING_REQUEST_DDL = `CREATE TABLE IF NOT EXISTS rescoring_requests (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'awaiting_confirm', 'done', 'cancelled')),
  target_quadrant TEXT,
  changed_axes TEXT NOT NULL,
  before_importance_score REAL,
  before_urgency_score REAL,
  after_importance_score REAL,
  after_urgency_score REAL,
  reason TEXT,
  confidence REAL,
  agent_name TEXT,
  expected_version INTEGER NOT NULL,
  idempotency_key TEXT,
  created_at TEXT NOT NULL,
  submitted_at TEXT,
  decided_at TEXT
)`;
