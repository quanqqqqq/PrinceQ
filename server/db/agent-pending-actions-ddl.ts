/**
 * `agent_pending_actions` 建表 DDL 的唯一来源。
 *
 * 和 `./rescoring-ddl.ts` 同样的理由：**不 import 任何模块**。
 * `server/db/migrations.ts` 要用它建表，而 `server/agent/pending-actions.ts`
 * import 了 `./connection.ts`、`connection.ts` 又 import `migrations.ts`——DDL 若留在
 * pending-actions 里，迁移反过来 import 它就会成环。
 *
 * `actions_json` 存的是**已过白名单校验**的动作数组。确认时会再校验一遍：这一行从
 * 写入到确认之间可能跨进程重启，不能假设当时的校验规则还和现在一样。
 */
export const AGENT_PENDING_ACTIONS_DDL = `CREATE TABLE IF NOT EXISTS agent_pending_actions (
  token TEXT PRIMARY KEY,
  session_id TEXT,
  summary TEXT NOT NULL,
  actions_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  resolved_at TEXT
)`;
