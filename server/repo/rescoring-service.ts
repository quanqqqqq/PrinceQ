/**
 * 复评请求的存储层：请求 → Agent 建议 → 用户确认，三步各自落在自己的行上。
 *
 * **建表是 add-only，并且已接入正式的幂等迁移路径。** `rescoring_requests` 现在
 * 由 `server/db/migrations.ts` 的 `migrateRescoringRequestsTable` 在
 * `runMigrations` 里建出——也就是服务器启动（`applySchema`）与 `npm run db:setup`
 * 都会走到的那条路径。DDL 是 `CREATE TABLE IF NOT EXISTS`，表已存在时整次调用是
 * no-op：只保证空表存在，既不塞种子数据也不回填、不改写任何既有行或既有表的形状。
 * DDL 的唯一来源是 `server/db/rescoring-ddl.ts`（零依赖，避免
 * migrations → repo → connection → migrations 成环），本模块的
 * `migrateRescoringSchema` 只是复用同一个常量，供隔离测试单独建表用。
 *
 * 这个流程存在的全部意义，是把"真实评分"和"用户确认"分成两个必须分别发生的
 * 事件：
 *
 * - `createRescoringRequest` 拍下当前两轴分数和任务 `version`，标 `pending`；
 * - `submitRescoringSuggestion` 校验并合并真实 Agent 的建议，标
 *   `awaiting_confirm`——**完全不碰 `tasks`**，所以用户确认前库里的分数纹丝不动；
 * - `confirmRescoringRequest` 才在一个事务里把分数写进 `tasks`，并校验
 *   `expected_version`；
 * - `cancelRescoringRequest` 标 `cancelled`，同样不碰 `tasks`。
 *
 * 任何一步都不会凭象限反推分数：写进 `tasks` 的两个数字只能来自 Agent 的建议或
 * 请求创建时的原值。象限只用来回答"哪几根轴需要重评"，见
 * `../domain/rescoring.ts` 的 `axesMismatchingQuadrant`。
 */
import { QUADRANTS, type Quadrant, type Task } from '../../shared/types.ts';
import { all, get, run, type Db, type Row } from '../db/connection.ts';
import { RESCORING_REQUEST_DDL } from '../db/rescoring-ddl.ts';
import { readAllHabits } from '../domain/habits.ts';
import {
  legacyAxisValue,
  quadrantFromScores,
  roundScore,
  validateScore,
} from '../domain/matrix-score.ts';
import {
  axesMismatchingQuadrant,
  mergeAgentScores,
  validateChangedAxes,
  type MergedScores,
  type RescoringAxis,
} from '../domain/rescoring.ts';
import { badRequest, conflict, notFound } from '../lib/errors.ts';
import { newId, nowIso } from '../lib/ids.ts';
import { withOperation } from './operations.ts';
import { findTask } from './tasks.ts';

/**
 * 复评请求表的 DDL。这里只是把唯一来源 `../db/rescoring-ddl.ts` 原样转出，方便
 * 既有调用方继续从本模块 import；正式迁移路径直接用那个零依赖模块，见文件头。
 */
export { RESCORING_REQUEST_DDL };

/**
 * 建表（add-only，幂等）。供隔离测试单独建表用——真实库走的是
 * `runMigrations` 里的 `migrateRescoringRequestsTable`，两边共用同一条 DDL。
 *
 * 返回 `created` 以便调用方区分"这次真的建了表"和"表早就在"，重复调用安全。
 */
export function migrateRescoringSchema(db: Db): { created: boolean } {
  const existing = get<Row>(
    db,
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rescoring_requests'`,
  );
  db.exec(RESCORING_REQUEST_DDL);
  return { created: existing == null };
}

/** 兼容早先的调用名；等价于 `migrateRescoringSchema`。 */
export function ensureRescoringSchema(db: Db): void {
  migrateRescoringSchema(db);
}

export type RescoringStatus = 'pending' | 'awaiting_confirm' | 'done' | 'cancelled';

/** 一次复评还"在路上"的两个状态——这期间同一任务不允许再发起第二次。 */
const OPEN_STATUSES: readonly RescoringStatus[] = ['pending', 'awaiting_confirm'];

export interface RescoringRequest {
  id: string;
  task_id: string;
  status: RescoringStatus;
  /** 用户当初想拖到的象限；仅作上下文，派生象限不从它反推。 */
  target_quadrant: Quadrant | null;
  changed_axes: RescoringAxis[];
  before_importance: number | null;
  before_urgency: number | null;
  after_importance: number | null;
  after_urgency: number | null;
  reason: string | null;
  confidence: number | null;
  agent_name: string | null;
  expected_version: number;
  idempotency_key: string | null;
  created_at: string;
  submitted_at: string | null;
  decided_at: string | null;
}

/**
 * 行 → 对象。
 *
 * 列名带 `_score` 后缀（DDL 的契约），对外的字段名不带——沿用前两轮就在用的
 * `before_importance` 等名字，免得已经读这些字段的调用方跟着改。
 */
function hydrate(row: Row): RescoringRequest {
  return {
    id: row.id,
    task_id: row.task_id,
    status: row.status,
    target_quadrant: row.target_quadrant ?? null,
    // 存的是逗号分隔文本；解析回来后仍然过一次校验，坏数据不许悄悄通过。
    changed_axes: validateChangedAxes(String(row.changed_axes ?? '').split(',').filter(Boolean)),
    before_importance: row.before_importance_score ?? null,
    before_urgency: row.before_urgency_score ?? null,
    after_importance: row.after_importance_score ?? null,
    after_urgency: row.after_urgency_score ?? null,
    reason: row.reason ?? null,
    confidence: row.confidence ?? null,
    agent_name: row.agent_name ?? null,
    expected_version: Number(row.expected_version),
    idempotency_key: row.idempotency_key ?? null,
    created_at: row.created_at,
    submitted_at: row.submitted_at ?? null,
    decided_at: row.decided_at ?? null,
  };
}

export function findRescoringRequest(db: Db, id: string): RescoringRequest | null {
  const row = get<Row>(db, 'SELECT * FROM rescoring_requests WHERE id = ?', [id]);
  return row ? hydrate(row) : null;
}

function requireRequest(db: Db, id: string): RescoringRequest {
  const request = findRescoringRequest(db, id);
  if (!request) throw notFound(`没有 id 为 "${id}" 的复评请求。`);
  return request;
}

/** 列表查询，可按状态过滤；最新的排在前面。 */
export function listRescoringRequests(
  db: Db,
  opts: { status?: string } = {},
): RescoringRequest[] {
  const where = opts.status ? 'WHERE status = ?' : '';
  const params = opts.status ? [opts.status] : [];
  return all<Row>(
    db,
    `SELECT * FROM rescoring_requests ${where} ORDER BY created_at DESC, rowid DESC`,
    params,
  ).map(hydrate);
}

export interface CreateRescoringRequestInput {
  /** 用户想把任务拖到的象限。给了它就能自动算出要重评哪几根轴。 */
  target_quadrant?: Quadrant;
  /** 显式指定要重评的轴。两者都不给是调用方 bug，直接拒。 */
  changed_axes?: RescoringAxis[];
}

/**
 * 发起一次复评请求：拍快照，不动任务。
 *
 * `changed_axes` 缺省时由 `axesMismatchingQuadrant` 从快照和目标象限算出——只有
 * 真正跨线的轴才进来，已经在目标那一侧的轴继续留着原值。两者都不给就报错，而不
 * 是默认"两根都重评"：那等于替用户决定要动哪些分数。
 *
 * 快照包含任务当前的 `version`，确认时用它做乐观并发校验——期间任务被别的写入
 * 改过，这份建议就是基于过时信息做的，必须让 Agent 重新评。
 */
export function createRescoringRequest(
  db: Db,
  taskId: string,
  opts: CreateRescoringRequestInput = {},
): RescoringRequest {
  const task = findTask(db, taskId);
  if (!task) throw notFound(`没有 id 为 "${taskId}" 的任务。`);

  let target: Quadrant | null = null;
  if (opts.target_quadrant != null) {
    if (!QUADRANTS.includes(opts.target_quadrant)) {
      throw badRequest(
        `目标象限只能是 q1..q4，收到了 ${JSON.stringify(opts.target_quadrant)}。`,
      );
    }
    target = opts.target_quadrant;
  }

  if (opts.changed_axes == null && target == null) {
    throw badRequest(
      '发起复评必须给出目标象限（target_quadrant）或要重评的轴（changed_axes），两者都没有时无法判断该动哪根轴。',
    );
  }

  // 同一任务只允许有一条在途请求：并行两条会各自基于同一份快照给建议，
  // 后确认的那条必然撞上 expected_version，不如在入口就说清楚。
  const open = get<Row>(
    db,
    `SELECT id FROM rescoring_requests
      WHERE task_id = ? AND status IN (${OPEN_STATUSES.map(() => '?').join(', ')})`,
    [task.id, ...OPEN_STATUSES],
  );
  if (open) {
    throw badRequest(
      `任务「${task.title}」已有进行中的复评请求（${open.id}），请先确认或取消它再发起新的。`,
    );
  }

  const snapshot = {
    importance_score: task.matrix_importance_score,
    urgency_score: task.matrix_urgency_score,
  };

  // 没给 changed_axes 时由目标象限算出要动哪几根轴。算出空集说明当前分数已经落
  // 在目标象限里——这时走完一轮复评也不会改变任何东西，不如明说。
  let axes: RescoringAxis[];
  if (opts.changed_axes != null) {
    axes = validateChangedAxes(opts.changed_axes);
  } else {
    const auto = axesMismatchingQuadrant(snapshot, target!);
    if (auto.length === 0) {
      throw badRequest(
        `任务「${task.title}」的当前分数（重要 ${snapshot.importance_score ?? '未评分'} / ` +
          `紧急 ${snapshot.urgency_score ?? '未评分'}）已经落在目标象限里，没有轴需要重新评分。` +
          `如仍要复评，请显式指定 changed_axes。`,
      );
    }
    axes = validateChangedAxes(auto);
  }

  const id = newId('resc');
  run(
    db,
    `INSERT INTO rescoring_requests
       (id, task_id, status, target_quadrant, changed_axes,
        before_importance_score, before_urgency_score,
        after_importance_score, after_urgency_score, reason, confidence, agent_name,
        expected_version, idempotency_key, created_at, submitted_at, decided_at)
     VALUES (?, ?, 'pending', ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, NULL, ?, NULL, NULL)`,
    [
      id,
      task.id,
      target,
      axes.join(','),
      snapshot.importance_score,
      snapshot.urgency_score,
      task.version,
      nowIso(),
    ],
  );
  return requireRequest(db, id);
}

/** 交给外部 Agent 的上下文。全部是读出来的事实，没有一处是生成的判断。 */
export interface RescoringContext {
  task: Task;
  goal_title: string | null;
  depends_on: { id: string; title: string; status: string }[];
  /** 启用中的显式习惯条数与权重名，中文一句话。 */
  habits_summary: string;
}

/**
 * 汇总一次复评要用的上下文：任务本身、所属目标、依赖任务、习惯摘要。
 *
 * 面板把这些原样显示给用户看，外部 Agent（加载本 Skill 的主 Agent）读完后再提交
 * 建议。这里不做任何打分，也不推荐任何分数——它只是把散落在几张表和 `habits/`
 * 里的事实拼到一起。
 */
export function describeRescoringContext(db: Db, requestId: string): RescoringContext {
  const request = requireRequest(db, requestId);
  const task = findTask(db, request.task_id);
  if (!task) throw notFound(`没有 id 为 "${request.task_id}" 的任务。`);

  const depends_on = task.depends_on.map((id) => {
    const dependency = findTask(db, id);
    return {
      id,
      title: dependency?.title ?? '(已删除的任务)',
      status: dependency?.status ?? 'unknown',
    };
  });

  const habits = readAllHabits();
  const explicit = habits.explicit.payload.entries.filter((entry) => entry.enabled);
  const weightNames = Object.keys(habits.weights.payload.weights).join('、');
  const habits_summary =
    `启用中的明确习惯 ${explicit.length} 条；` +
    `评分权重项：${weightNames || '（无）'}。`;

  return { task, goal_title: task.goal_title, depends_on, habits_summary };
}

export interface RescoringSuggestionInput {
  importance_score?: unknown;
  urgency_score?: unknown;
  reason: unknown;
  confidence?: unknown;
  agent_name: unknown;
}

/**
 * 记录真实 Agent 的建议。**不碰 `tasks`。**
 *
 * `mergeAgentScores` 负责那条红线：被请求的轴必须给值，未被请求的轴提交了不同
 * 值就整次拒绝。校验失败时这里什么都没写，请求仍停在 `pending`，Agent 可以带上
 * 正确的轴重试。
 */
export function submitRescoringSuggestion(
  db: Db,
  requestId: string,
  input: RescoringSuggestionInput,
): RescoringRequest {
  const request = requireRequest(db, requestId);
  if (request.status !== 'pending') {
    throw conflict(
      `复评请求 ${requestId} 当前状态为 ${request.status}，只有 pending 的请求可以提交建议。`,
    );
  }

  // 先合并校验，再校验文案——任何一步抛出都意味着这次调用没有写过库。
  const merged: MergedScores = mergeAgentScores(
    { importance_score: request.before_importance, urgency_score: request.before_urgency },
    request.changed_axes,
    input,
  );

  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (reason.length < 4) {
    throw badRequest('复评建议必须给出理由（至少 4 个字符），说明这次改分的依据。');
  }
  if (reason.length > 2000) {
    throw badRequest('复评理由过长，最多 2000 个字符。');
  }

  const agentName = typeof input.agent_name === 'string' ? input.agent_name.trim() : '';
  if (agentName.length === 0) {
    throw badRequest('复评建议必须署名给出判断的 Agent（agent_name）。');
  }

  let confidence: number | null = null;
  if (input.confidence != null) {
    if (typeof input.confidence !== 'number' || !Number.isFinite(input.confidence)) {
      throw badRequest('置信度必须是 0..1 之间的数字。');
    }
    if (input.confidence < 0 || input.confidence > 1) {
      throw badRequest(`置信度 ${input.confidence} 超出范围，必须在 0..1 之间。`);
    }
    confidence = Math.round(input.confidence * 100) / 100;
  }

  run(
    db,
    `UPDATE rescoring_requests
        SET status = 'awaiting_confirm', after_importance_score = ?, after_urgency_score = ?,
            reason = ?, confidence = ?, agent_name = ?, submitted_at = ?
      WHERE id = ?`,
    [
      merged.importance_score,
      merged.urgency_score,
      reason,
      confidence,
      agentName,
      nowIso(),
      requestId,
    ],
  );
  return requireRequest(db, requestId);
}

export interface RescoringConfirmation {
  request: RescoringRequest;
  task: Task;
  replayed: boolean;
}

/**
 * 用户确认，建议这才落进 `tasks`——整个流程里唯一写分数的地方。
 *
 * 一个事务里做完：版本校验 → 写 `tasks`（两轴分数、由分数派生的象限、legacy
 * 1..5 列、`source = 'agent'`、`quadrant_confirmed = 1`、`matrix_score_version + 1`）
 * → 请求标 `done` → operations 落日志。中间任何一步失败就整体回滚，不会出现
 * "分数写了但请求还挂着"的半成品。
 *
 * 幂等靠 `withOperation` 的 idempotency key：同一个 key 重放会直接返回上次的
 * 结果，不会再次加分或再次提升版本号。
 */
export function confirmRescoringRequest(
  db: Db,
  requestId: string,
  actorId: string,
  idempotencyKey: string,
): RescoringConfirmation {
  const preflight = requireRequest(db, requestId);
  if (preflight.status === 'cancelled') {
    throw conflict(`复评请求 ${requestId} 已取消，无法确认。`);
  }
  if (preflight.status === 'pending') {
    throw badRequest(
      `复评请求 ${requestId} 还没有收到真实 Agent 的建议，没有任何分数可以确认。`,
    );
  }

  const outcome = withOperation(
    db,
    {
      idempotency_key: idempotencyKey,
      operation_type: 'task.matrix.rescore.confirm',
      target_type: 'task',
      actor_id: actorId,
    },
    () => {
      const request = requireRequest(db, requestId);
      // 重放之外的第二次确认：事务里再看一眼状态，避免并发双写。
      if (request.status !== 'awaiting_confirm') {
        throw conflict(
          `复评请求 ${requestId} 当前状态为 ${request.status}，只有 awaiting_confirm 可以确认。`,
        );
      }

      const task = findTask(db, request.task_id);
      if (!task) throw notFound(`没有 id 为 "${request.task_id}" 的任务。`);
      if (task.version !== request.expected_version) {
        throw conflict(
          `任务已被其他写入修改（复评请求基于版本 ${request.expected_version}，实际 ${task.version}），` +
            `请重新发起复评，本次未写入任何分数。`,
          { expected: request.expected_version, actual: task.version },
        );
      }

      // 落库的两个数字只能来自建议行，并且再过一次范围校验。
      const importance = validateScore('importance', roundScore(Number(request.after_importance)));
      const urgency = validateScore('urgency', roundScore(Number(request.after_urgency)));
      const quadrant = quadrantFromScores(importance, urgency);
      const timestamp = nowIso();
      const note =
        `复评（${request.changed_axes.join('+')}）由 ${request.agent_name} 给出并经用户确认：` +
        `${request.reason}`;

      run(
        db,
        `UPDATE tasks
            SET matrix_importance_score = ?, matrix_urgency_score = ?,
                matrix_score_source = 'agent', matrix_score_reason = ?,
                matrix_score_confidence = ?,
                matrix_score_version = matrix_score_version + 1, matrix_scored_at = ?,
                importance = ?, urgency = ?,
                quadrant = ?, quadrant_source = 'agent', quadrant_confidence = ?,
                quadrant_reason = ?, quadrant_confirmed = 1,
                updated_at = ?, version = version + 1
          WHERE id = ?`,
        [
          importance,
          urgency,
          note,
          request.confidence,
          timestamp,
          legacyAxisValue(importance),
          legacyAxisValue(urgency),
          quadrant,
          request.confidence,
          note,
          timestamp,
          task.id,
        ],
      );

      run(
        db,
        `UPDATE rescoring_requests
            SET status = 'done', decided_at = ?, idempotency_key = ?
          WHERE id = ?`,
        [timestamp, idempotencyKey, requestId],
      );

      const updated = findTask(db, task.id)!;
      return {
        result: updated,
        target_id: updated.id,
        summary: `复评确认："${updated.title}" 的${request.changed_axes.join('+')}轴更新为 ${importance}/${urgency}`,
        detail: {
          request_id: requestId,
          changed_axes: request.changed_axes,
          before: {
            importance: request.before_importance,
            urgency: request.before_urgency,
          },
          after: { importance, urgency },
          quadrant,
          agent_name: request.agent_name,
        },
        rehydrate: (result: Task): Task => findTask(db, result.id) ?? result,
      };
    },
  );

  return {
    request: requireRequest(db, requestId),
    task: outcome.result,
    replayed: outcome.replayed,
  };
}

/** 用户放弃这次复评。只标状态，`tasks` 一个字节都不动。 */
export function cancelRescoringRequest(db: Db, requestId: string): RescoringRequest {
  const request = requireRequest(db, requestId);
  if (request.status === 'done') {
    throw conflict(`复评请求 ${requestId} 已确认落库，无法取消。`);
  }
  run(
    db,
    `UPDATE rescoring_requests SET status = 'cancelled', decided_at = ? WHERE id = ?`,
    [nowIso(), requestId],
  );
  return requireRequest(db, requestId);
}
