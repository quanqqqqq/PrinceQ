/**
 * REST surface shared by the web UI and the future Skill.
 * Reference: docs/local-api.md (kept in sync with this file).
 */
import {habitInferenceStatus} from '../agent/habit-inference.ts';
import { randomUUID } from 'node:crypto';
import {discoverRuntimeModels} from '../agent/model-catalog.ts';
import {z} from 'zod';
import {deleteTask, deleteGoal, removeDependency} from '../repo/delete-service.ts';
import {skillCatalog, skillOperationSchema, definitionFor, operationPath, type SkillOperation} from '../skills/catalog.ts';
import {authorizePrinceQRequest} from '../skills/access.ts';
import {buildPrinceQContext} from '../agent/prompt-context.ts';
import {readInjectedPrinceQSkill} from '../skills/injection.ts';
import {savePendingActions} from '../agent/pending-actions.ts';
import {describePendingAction} from '../agent/preview-description.ts';
import type {
  AgentMessage,
  AgentMessageResponse,
  AgentRuntimeStatusView,
  HealthResponse,
  Task,
} from '../../shared/types.ts';
import { TASK_STATUSES } from '../../shared/types.ts';
import {
  invalidateHealth,
  isAgentReady,
  notReadyReason,
  refreshHealth,
} from '../agent/health.ts';
import { AgentRuntimeError, runAgentMessage } from '../agent/llm-adapter.ts';
import { connectionFor, listRuntimeProviders, testRuntimeProvider } from '../agent/provider-connections.ts';
import { detectCli } from '../agent/detect.ts';
import { cancelPendingActions, confirmPendingActions } from '../agent/pending-actions.ts';
import {
  defaultRuntimeConfig,
  persistDetected,
  readRuntimeConfig,
  writeRuntimeConfig,
} from '../agent/runtime-config.ts';
import { localAdapter, cancelPendingAction, confirmPendingAction, ensureSession } from '../agent/runtime.ts';
import { SUPPORTED_COMMANDS } from '../agent/commands.ts';
import { DEFAULT_ACTOR_ID, QUEUE_ALGORITHM_VERSION, DB_PATH } from '../config.ts';
import { all, get, getDb, run, transaction, type Db, type Row } from '../db/connection.ts';
import {
  addExplicitHabit,
  adoptSettingsInferred,
  buildSettingsSnapshot,
  createSettingsConstraint,
  createSettingsExplicit,
  findExistingAdoption,
  previewSettingsWeights,
  readAllHabits,
  resetSettingsConversion,
  saveSettingsWeights,
  setHabitEnabled,
  setSettingsConstraintEnabled,
  setSettingsHabitEnabled,
  updateDurationPrefs,
  updateSettingsConstraint,
  updateSettingsConversion,
  updateSettingsExplicit,
  updateWeights,
  type SettingsWriteResult,
} from '../domain/habits.ts';
import { QUADRANT_LABELS } from '../domain/quadrant.ts';
import { availableActions } from '../domain/transitions.ts';
import { badRequest, notFound } from '../lib/errors.ts';
import { newId, nowIso } from '../lib/ids.ts';
import {
  confirmDecomposition,
  createGoal,
  previewDecomposition,
  updateGoal,
} from '../repo/goal-service.ts';
import { listOperations, findOperationRecordByKey, withOperation } from '../repo/operations.ts';
import { explainTask, listSnapshots, readQueue } from '../repo/queue-service.ts';
import {
  cancelRescoringRequest,
  confirmRescoringRequest,
  createRescoringRequest,
  describeRescoringContext,
  listRescoringRequests,
  submitRescoringSuggestion,
} from '../repo/rescoring-service.ts';
import {
  addDependency,
  applyAction,
  changeQuadrant,
  confirmQuadrant,
  createTask,
  resuggestQuadrant,
  scoreTaskMatrix,
  updateTask,
} from '../repo/task-service.ts';
import { findGoal, findTask, listAssignments, listGoals, listTasks } from '../repo/tasks.ts';
import { Router, parse, type RequestContext } from './router.ts';
import * as S from './schemas.ts';

/** Writes require an Idempotency-Key header; we fall back to a generated one. */
const keyFor = (ctx: RequestContext, prefix: string): string =>
  ctx.idempotencyKey ?? `${prefix}-${randomUUID()}`;

const actorFor = (body: { actor_id?: string } | undefined): string =>
  body?.actor_id || DEFAULT_ACTOR_ID;

// ── /api/meta 的中文展示标签 ─────────────────────────────────────────────────
// 英文枚举 key（q1..q4、deterministic-local、actor id）全部保留，这里只追加中文
// 展示名，供 Skill / 界面直接渲染，不必各自再写一份映射。
const QUADRANT_TITLES_ZH: Record<string, string> = {
  q1: '重要且紧急',
  q2: '重要不紧急',
  q3: '不重要但紧急',
  q4: '不重要不紧急',
};

const AGENT_MODE_LABELS: Record<string, string> = {
  'deterministic-local': '确定性本地模式',
};

const ACTOR_DISPLAY_NAMES_ZH: Record<string, string> = {
  Me: '我',
  'Local Agent (deterministic)': '本地助手（确定性）',
  'Scheduled automation': '定时自动化',
};

/**
 * The task universe a goal reports on. Archived tasks are excluded so the task
 * list a client receives matches the counts in `progressFor`.
 */
const NON_ARCHIVED_STATUSES = TASK_STATUSES.filter((s) => s !== 'archived');

/**
 * The mutation runs before the queue refresh, so the task it returns still has
 * the previous queue_position/queue_score. Re-read it afterwards.
 */
const rehydrateTask =
  (database: Db) =>
  (task: Task): Task =>
    findTask(database, task.id) ?? task;

export function buildRouter(dbFactory: () => Db = getDb): Router {
  const router = new Router();
  const db = () => dbFactory();

  // ── health ────────────────────────────────────────────────────────────────
  router.get('/api/health', (): HealthResponse => {
    const counts = get<Row>(
      db(),
      `SELECT
         (SELECT COUNT(*) FROM goals) AS goals,
         (SELECT COUNT(*) FROM tasks) AS tasks,
         (SELECT COUNT(*) FROM operations) AS operations`,
    );
    return {
      status: 'ok',
      mode: 'deterministic-local',
      database: DB_PATH,
      algorithm_version: QUEUE_ALGORITHM_VERSION,
      now: nowIso(),
      counts: {
        goals: Number(counts?.goals ?? 0),
        tasks: Number(counts?.tasks ?? 0),
        operations: Number(counts?.operations ?? 0),
      },
    };
  });

  router.get('/api/meta', () => ({
    quadrant_labels: QUADRANT_LABELS,
    quadrant_titles: QUADRANT_TITLES_ZH,
    algorithm_version: QUEUE_ALGORITHM_VERSION,
    agent_mode: localAdapter.mode,
    agent_mode_label: AGENT_MODE_LABELS[localAdapter.mode] ?? localAdapter.mode,
    supported_commands: SUPPORTED_COMMANDS,
    default_actor_id: DEFAULT_ACTOR_ID,
    actors: all<Row>(db(), 'SELECT * FROM actors ORDER BY kind, display_name').map((row) => ({
      ...row,
      display_name_zh: ACTOR_DISPLAY_NAMES_ZH[row.display_name as string] ?? row.display_name,
    })),
  }));

  // ── tasks ─────────────────────────────────────────────────────────────────
  router.get('/api/tasks', (ctx) => {
    const query = parse(S.taskListQuerySchema, Object.fromEntries(ctx.url.searchParams));
    const tasks = listTasks(db(), {
      status: query.active ? S.ACTIVE_STATUS_LIST : query.status,
      goal_id: query.goal_id,
      quadrant: query.quadrant,
      unconfirmed: query.unconfirmed,
    });
    return {
      tasks: tasks.map((task) => ({ ...task, available_actions: availableActions(task.status) })),
    };
  });

  router.post('/api/tasks', (ctx) => {
    const body = parse(S.createTaskSchema, ctx.body);
    const outcome = withOperation(
      db(),
      {
        idempotency_key: keyFor(ctx, 'task-create'),
        operation_type: 'task.create',
        target_type: 'task',
        actor_id: DEFAULT_ACTOR_ID,
      },
      () => {
        const task = createTask(db(), body);
        return {
          result: task,
          target_id: task.id,
          summary: `Created task "${task.title}"`,
          detail: {
            quadrant: task.quadrant,
            confidence: task.quadrant_confidence,
            score_source: task.matrix_score_source,
            importance_score: task.matrix_importance_score,
            urgency_score: task.matrix_urgency_score,
          },
          rehydrate: rehydrateTask(db()),
        };
      },
    );
    return {
      task: outcome.result,
      operation: outcome.operation,
      queue_snapshot: outcome.queue.snapshot,
      replayed: outcome.replayed,
    };
  });

  router.get('/api/tasks/:id', (ctx) => {
    const task = findTask(db(), ctx.params.id);
    if (!task) throw notFound(`No task with id "${ctx.params.id}".`);
    return {
      task: { ...task, available_actions: availableActions(task.status) },
      assignments: listAssignments(db(), task.id),
      explanation: explainTask(db(), task.id),
    };
  });

  router.patch('/api/tasks/:id', (ctx) => {
    const body = parse(S.updateTaskSchema, ctx.body);
    const outcome = withOperation(
      db(),
      {
        idempotency_key: keyFor(ctx, 'task-update'),
        operation_type: 'task.update',
        target_type: 'task',
        actor_id: DEFAULT_ACTOR_ID,
      },
      () => {
        const task = updateTask(db(), ctx.params.id, body);
        return {
          result: task,
          target_id: task.id,
          summary: `Updated task "${task.title}"`,
          detail: { fields: Object.keys(body) },
          rehydrate: rehydrateTask(db()),
        };
      },
    );
    return { task: outcome.result, operation: outcome.operation, replayed: outcome.replayed };
  });

  router.post('/api/tasks/:id/actions', (ctx) => {
    const body = parse(S.taskActionSchema, ctx.body);
    const outcome = withOperation(
      db(),
      {
        idempotency_key: keyFor(ctx, `task-${body.action}`),
        operation_type: `task.${body.action}`,
        target_type: 'task',
        actor_id: actorFor(body),
      },
      () => {
        const before = findTask(db(), ctx.params.id);
        if (!before) throw notFound(`No task with id "${ctx.params.id}".`);
        const task = applyAction(db(), ctx.params.id, {
          action: body.action,
          actor_id: actorFor(body),
          reason: body.reason,
          expected_version: body.expected_version,
        });
        return {
          result: task,
          target_id: task.id,
          summary: `${body.action} → "${task.title}" (${before.status} → ${task.status})`,
          detail: { from: before.status, to: task.status, reason: body.reason ?? null },
          rehydrate: rehydrateTask(db()),
        };
      },
    );
    return {
      task: outcome.result,
      operation: outcome.operation,
      queue_snapshot: outcome.queue.snapshot,
      replayed: outcome.replayed,
    };
  });

  router.post('/api/tasks/:id/dependencies', (ctx) => {
    const body = parse(S.addDependencySchema, ctx.body);
    const outcome = withOperation(
      db(),
      {
        idempotency_key: keyFor(ctx, 'task-dep'),
        operation_type: 'task.dependency.add',
        target_type: 'task',
        actor_id: DEFAULT_ACTOR_ID,
      },
      () => {
        const task = addDependency(db(), ctx.params.id, body.depends_on_id);
        return {
          result: task,
          target_id: task.id,
          summary: `"${task.title}" now depends on ${body.depends_on_id}`,
          detail: { depends_on: body.depends_on_id },
          rehydrate: rehydrateTask(db()),
        };
      },
    );
    return { task: outcome.result, operation: outcome.operation };
  });

  router.delete('/api/tasks/:id', (ctx) => {
    const body=parse(z.strictObject({expected_version:z.number().int().positive().optional()}),ctx.body);
    const outcome=withOperation(db(),{idempotency_key:keyFor(ctx,'task-delete'),operation_type:'task.delete',target_type:'task',actor_id:DEFAULT_ACTOR_ID},()=>{
      const result=deleteTask(db(),ctx.params.id,body.expected_version);
      return {result,target_id:ctx.params.id,summary:`永久删除任务「${result.title}」`,detail:result};
    });
    return {...outcome.result,operation:outcome.operation,replayed:outcome.replayed};
  });
  router.post('/api/tasks/:id/dependencies/remove', (ctx) => {
    const body=parse(S.addDependencySchema,ctx.body);
    const outcome=withOperation(db(),{idempotency_key:keyFor(ctx,'dependency-remove'),operation_type:'task.dependency.remove',target_type:'task',actor_id:DEFAULT_ACTOR_ID},()=>{
      const task=removeDependency(db(),ctx.params.id,body.depends_on_id);
      return {result:task,target_id:task.id,summary:`移除「${task.title}」的依赖`,detail:{depends_on_id:body.depends_on_id},rehydrate:rehydrateTask(db())};
    });
    return {task:outcome.result,operation:outcome.operation,replayed:outcome.replayed};
  });

  // ── quadrant ──────────────────────────────────────────────────────────────
  router.post('/api/tasks/:id/quadrant/confirm', (ctx) => {
    const outcome = withOperation(
      db(),
      {
        idempotency_key: keyFor(ctx, 'quadrant-confirm'),
        operation_type: 'task.quadrant.confirm',
        target_type: 'task',
        actor_id: DEFAULT_ACTOR_ID,
      },
      () => {
        const task = confirmQuadrant(db(), ctx.params.id);
        return {
          result: task,
          target_id: task.id,
          summary: `Confirmed ${task.quadrant} for "${task.title}"`,
          detail: { quadrant: task.quadrant },
          rehydrate: rehydrateTask(db()),
        };
      },
    );
    return { task: outcome.result, operation: outcome.operation, replayed: outcome.replayed };
  });

  /**
   * Records a two-axis 0..100 judgement produced by the caller.
   *
   * Validate-and-persist only: the service never calls a model. A `source` of
   * `agent` means a real Agent (loading the Skill) did the judging, and stays
   * unconfirmed until the user accepts it.
   */
  router.post('/api/tasks/:id/matrix-score', (ctx) => {
    const body = parse(S.matrixScoreSchema, ctx.body);
    const outcome = withOperation(
      db(),
      {
        idempotency_key: keyFor(ctx, 'task-matrix-score'),
        operation_type: 'task.matrix.score',
        target_type: 'task',
        actor_id: DEFAULT_ACTOR_ID,
      },
      () => {
        const task = scoreTaskMatrix(db(), ctx.params.id, {
          importance_score: body.importance_score,
          urgency_score: body.urgency_score,
          reason: body.reason,
          source: body.source,
          confidence: body.confidence ?? null,
          expected_version: body.expected_version,
        });
        return {
          result: task,
          target_id: task.id,
          summary:
            `为「${task.title}」记录评分 重要 ${task.matrix_importance_score}` +
            ` / 紧急 ${task.matrix_urgency_score} → ${task.quadrant}`,
          detail: {
            importance_score: task.matrix_importance_score,
            urgency_score: task.matrix_urgency_score,
            quadrant: task.quadrant,
            source: task.matrix_score_source,
            confirmed: task.quadrant_confirmed,
            score_version: task.matrix_score_version,
          },
          rehydrate: rehydrateTask(db()),
        };
      },
    );
    return { task: outcome.result, operation: outcome.operation, replayed: outcome.replayed };
  });

  router.post('/api/tasks/:id/quadrant/change', (ctx) => {
    const body = parse(S.quadrantChangeSchema, ctx.body);
    const outcome = withOperation(
      db(),
      {
        idempotency_key: keyFor(ctx, 'quadrant-change'),
        operation_type: 'task.quadrant.change',
        target_type: 'task',
        actor_id: DEFAULT_ACTOR_ID,
      },
      () => {
        const before = findTask(db(), ctx.params.id);
        if (!before) throw notFound(`No task with id "${ctx.params.id}".`);
        const task = changeQuadrant(db(), ctx.params.id, body.quadrant, body.reason);
        return {
          result: task,
          target_id: task.id,
          summary: `Changed quadrant of "${task.title}" to ${body.quadrant}`,
          detail: { from: before.quadrant, to: body.quadrant },
          rehydrate: rehydrateTask(db()),
        };
      },
    );
    return { task: outcome.result, operation: outcome.operation, replayed: outcome.replayed };
  });

  router.post('/api/tasks/:id/quadrant/resuggest', (ctx) => {
    const outcome = withOperation(
      db(),
      {
        idempotency_key: keyFor(ctx, 'quadrant-resuggest'),
        operation_type: 'task.quadrant.resuggest',
        target_type: 'task',
        actor_id: DEFAULT_ACTOR_ID,
      },
      () => {
        const task = resuggestQuadrant(db(), ctx.params.id);
        return {
          result: task,
          target_id: task.id,
          summary: `Re-inferred quadrant for "${task.title}" → ${task.quadrant}`,
          detail: { quadrant: task.quadrant, confidence: task.quadrant_confidence },
          rehydrate: rehydrateTask(db()),
        };
      },
    );
    return { task: outcome.result, operation: outcome.operation };
  });

  // ── goals ─────────────────────────────────────────────────────────────────
  router.get('/api/goals', () => ({ goals: listGoals(db()) }));

  router.post('/api/goals', (ctx) => {
    const body = parse(S.createGoalSchema, ctx.body);
    const outcome = withOperation(
      db(),
      {
        idempotency_key: keyFor(ctx, 'goal-create'),
        operation_type: 'goal.create',
        target_type: 'goal',
        actor_id: DEFAULT_ACTOR_ID,
      },
      () => {
        const goal = createGoal(db(), body);
        return {
          result: goal,
          target_id: goal.id,
          summary: `Created goal "${goal.title}"`,
          skipQueueRefresh: true,
        };
      },
    );
    return { goal: outcome.result, operation: outcome.operation, replayed: outcome.replayed };
  });

  router.get('/api/goals/:id', (ctx) => {
    const goal = findGoal(db(), ctx.params.id);
    if (!goal) throw notFound(`No goal with id "${ctx.params.id}".`);
    return { goal, tasks: listTasks(db(), { goal_id: goal.id, status: NON_ARCHIVED_STATUSES }) };
  });

  router.patch('/api/goals/:id', (ctx) => {
    const body = parse(S.updateGoalSchema, ctx.body);
    const outcome = withOperation(
      db(),
      {
        idempotency_key: keyFor(ctx, 'goal-update'),
        operation_type: 'goal.update',
        target_type: 'goal',
        actor_id: DEFAULT_ACTOR_ID,
      },
      () => {
        const goal = updateGoal(db(), ctx.params.id, body);
        return {
          result: goal,
          target_id: goal.id,
          summary: `Updated goal "${goal.title}"`,
          detail: { fields: Object.keys(body) },
        };
      },
    );
    return { goal: outcome.result, operation: outcome.operation };
  });

  router.delete('/api/goals/:id', (ctx) => {
    const body=parse(z.strictObject({expected_version:z.number().int().positive().optional()}),ctx.body);
    const outcome=withOperation(db(),{idempotency_key:keyFor(ctx,'goal-delete'),operation_type:'goal.delete',target_type:'goal',actor_id:DEFAULT_ACTOR_ID},()=>{
      const result=deleteGoal(db(),ctx.params.id,body.expected_version);
      return {result,target_id:ctx.params.id,summary:`永久删除目标「${result.title}」；保留 ${result.retained_task_ids.length} 个任务`,detail:result};
    });
    return {...outcome.result,operation:outcome.operation,replayed:outcome.replayed};
  });

  /** Preview only — writes no tasks. */
  router.post('/api/goals/:id/decomposition/preview', (ctx) => ({
    preview: previewDecomposition(db(), ctx.params.id),
  }));

  router.post('/api/goals/:id/decomposition/confirm', (ctx) => {
    const body = parse(S.confirmDecompositionSchema, ctx.body);
    const outcome = withOperation(
      db(),
      {
        idempotency_key: keyFor(ctx, 'goal-decompose'),
        operation_type: 'goal.decomposition.confirm',
        target_type: 'goal',
        actor_id: DEFAULT_ACTOR_ID,
      },
      () => {
        const created = confirmDecomposition(db(), body.preview_token, {
          acceptedTitles: body.accepted_titles,
          acceptedDrafts: body.accepted_drafts,
        });
        return {
          result: created,
          target_id: created.goal.id,
          summary: `Created ${created.tasks.length} task(s) under "${created.goal.title}"`,
          detail: { task_ids: created.tasks.map((t) => t.id) },
        };
      },
    );
    return {
      goal: outcome.result.goal,
      tasks: outcome.result.tasks,
      operation: outcome.operation,
      replayed: outcome.replayed,
    };
  });

  // ── queue ─────────────────────────────────────────────────────────────────
  router.get('/api/queue', () => readQueue(db()));

  router.post('/api/queue/recalculate', (ctx) => {
    const body = parse(S.recalculateSchema, ctx.body);
    const reason = body.reason ?? 'manual-recalculate';
    // The refresh itself is the mutation here, so it runs inside the same
    // transaction as the operation-log entry.
    const outcome = withOperation(
      db(),
      {
        idempotency_key: keyFor(ctx, 'queue-recalc'),
        operation_type: 'queue.recalculate',
        target_type: 'queue',
        actor_id: DEFAULT_ACTOR_ID,
      },
      () => ({
        result: { reason },
        target_id: null,
        summary: `Recalculated the queue (${reason})`,
        detail: { reason },
      }),
    );
    return { queue: readQueue(db()), operation: outcome.operation };
  });

  router.get('/api/queue/explain/:id', (ctx) => explainTask(db(), ctx.params.id));

  // ── activity ──────────────────────────────────────────────────────────────
  router.get('/api/activity', (ctx) => {
    const query = parse(S.activityQuerySchema, Object.fromEntries(ctx.url.searchParams));
    // The parsed query object already matches the repo filter shape
    // ({ limit, query?, type?, from?, to? }), so it is bound as parameters there.
    return {
      operations: listOperations(db(), query),
      snapshots: listSnapshots(db(), 25),
    };
  });

  // ── rescoring ─────────────────────────────────────────────────────────────
  // 复评的五条路由。请求 → 真实 Agent 建议 → 用户确认，分数只在 confirm 这一步
  // 落进 `tasks`；create / submit / cancel 一个字节都不写任务行。
  //
  // 这些路由读写 `rescoring_requests` 表。该表现在由正式的幂等迁移路径建出
  // （`server/db/migrations.ts` 的 `migrateRescoringRequestsTable`，挂在
  // `runMigrations` 上，服务器启动与 `npm run db:setup` 都会走到），所以主库访问
  // 这几条路由时表一定在。建表是 `CREATE TABLE IF NOT EXISTS` 的纯 add-only：
  // 只保证空表存在，不塞种子数据、不回填、不改写任何既有行或既有表的形状。

  /**
   * 发起复评：拍下当前两轴分数的快照，标 `pending`。**不动任务。**
   *
   * `target_quadrant` 与 `changed_axes` 的互斥/缺失关系交给
   * `createRescoringRequest` 判断——它手上有快照，才能解释「这几根轴已经在目标
   * 那一侧了」这类错误。
   */
  router.post('/api/tasks/:id/rescoring-request', (ctx) => {
    const body = parse(S.createRescoringRequestSchema, ctx.body);
    const outcome = withOperation(
      db(),
      {
        idempotency_key: keyFor(ctx, 'rescore-create'),
        operation_type: 'task.matrix.rescore.request',
        target_type: 'task',
        actor_id: DEFAULT_ACTOR_ID,
      },
      () => {
        const request = createRescoringRequest(db(), ctx.params.id, body);
        const task = findTask(db(), request.task_id);
        return {
          result: {
            ...request,
            // 面板发起后立刻要显示任务、目标、依赖与习惯摘要，顺手附上省一次往返。
            context: describeRescoringContext(db(), request.id),
          },
          target_id: request.task_id,
          summary:
            `为「${task?.title ?? request.task_id}」发起复评（${request.changed_axes.join('+')}）`,
          detail: {
            request_id: request.id,
            changed_axes: request.changed_axes,
            target_quadrant: request.target_quadrant,
            before: { importance: request.before_importance, urgency: request.before_urgency },
          },
          // 请求本身不改变任何排序输入。
          skipQueueRefresh: true,
        };
      },
    );
    return { request: outcome.result, operation: outcome.operation, replayed: outcome.replayed };
  });

  /** 列表，可按状态过滤。读路由，不带幂等键。 */
  router.get('/api/rescoring-requests', (ctx) => {
    const query = parse(S.rescoringListQuerySchema, Object.fromEntries(ctx.url.searchParams));
    return { requests: listRescoringRequests(db(), query) };
  });

  /**
   * 外部 Agent 提交建议。**完全不碰 `tasks`**——用户确认前库里的分数纹丝不动。
   *
   * 界面不调这条路由：网页里没有真实语言模型，也不该出现让用户自己填分数的输入框。
   */
  router.post('/api/rescoring-requests/:id/submit', (ctx) => {
    const body = parse(S.rescoringSubmitSchema, ctx.body);
    const outcome = withOperation(
      db(),
      {
        idempotency_key: keyFor(ctx, 'rescore-submit'),
        operation_type: 'task.matrix.rescore.submit',
        target_type: 'task',
        actor_id: DEFAULT_ACTOR_ID,
      },
      () => {
        const request = submitRescoringSuggestion(db(), ctx.params.id, {
          importance_score: body.importance_score,
          urgency_score: body.urgency_score,
          reason: body.reason,
          confidence: body.confidence ?? undefined,
          agent_name: body.agent_name,
        });
        return {
          result: request,
          target_id: request.task_id,
          summary:
            `${request.agent_name} 提交复评建议（${request.changed_axes.join('+')}）：` +
            `重要 ${request.after_importance} / 紧急 ${request.after_urgency}，等待确认`,
          detail: {
            request_id: request.id,
            changed_axes: request.changed_axes,
            after: { importance: request.after_importance, urgency: request.after_urgency },
            agent_name: request.agent_name,
            confidence: request.confidence,
          },
          // 建议还没落进 tasks，排序输入没有变化。
          skipQueueRefresh: true,
        };
      },
    );
    return { request: outcome.result, operation: outcome.operation, replayed: outcome.replayed };
  });

  /**
   * 用户确认——整个流程里唯一会写 `tasks` 的一步。
   *
   * 幂等由 service 内部的 `withOperation` 负责（它要和分数写入同一个事务），所以
   * 这里不再套一层：重放同一个 key 会原样返回上次的任务，不会二次加分或再提版本号。
   */
  router.post('/api/rescoring-requests/:id/confirm', (ctx) => {
    const key = keyFor(ctx, 'rescore-confirm');
    const outcome = confirmRescoringRequest(db(), ctx.params.id, DEFAULT_ACTOR_ID, key);
    return {
      task: outcome.task,
      request: outcome.request,
      operation: findOperationRecordByKey(db(), key),
      replayed: outcome.replayed,
    };
  });

  /** 放弃这次复评。只标 `cancelled`，`tasks` 一个字节都不动。 */
  router.post('/api/rescoring-requests/:id/cancel', (ctx) => {
    const outcome = withOperation(
      db(),
      {
        idempotency_key: keyFor(ctx, 'rescore-cancel'),
        operation_type: 'task.matrix.rescore.cancel',
        target_type: 'task',
        actor_id: DEFAULT_ACTOR_ID,
      },
      () => {
        const request = cancelRescoringRequest(db(), ctx.params.id);
        return {
          result: request,
          target_id: request.task_id,
          summary: `取消复评请求 ${request.id}（未写入任何分数）`,
          detail: { request_id: request.id, changed_axes: request.changed_axes },
          skipQueueRefresh: true,
        };
      },
    );
    return { request: outcome.result, operation: outcome.operation, replayed: outcome.replayed };
  });

  // ── habits ────────────────────────────────────────────────────────────────
  router.get('/api/habits', () => readAllHabits());

  router.post('/api/habits', (ctx) => {
    const body = parse(S.addHabitSchema, ctx.body);
    const outcome = withOperation(
      db(),
      {
        idempotency_key: keyFor(ctx, 'habit-add'),
        operation_type: 'habit.add',
        target_type: 'habit',
        actor_id: DEFAULT_ACTOR_ID,
      },
      () => {
        const entry = addExplicitHabit(body, DEFAULT_ACTOR_ID);
        return {
          result: entry,
          target_id: entry.id,
          summary: `Added explicit habit "${entry.statement}"`,
          detail: { file: 'habits/explicit.json' },
        };
      },
    );
    return { habit: outcome.result, habits: readAllHabits(), operation: outcome.operation };
  });

  router.post('/api/habits/enabled', (ctx) => {
    const body = parse(S.habitEnabledSchema, ctx.body);
    const outcome = withOperation(
      db(),
      {
        idempotency_key: keyFor(ctx, 'habit-toggle'),
        operation_type: body.enabled ? 'habit.enable' : 'habit.disable',
        target_type: 'habit',
        actor_id: DEFAULT_ACTOR_ID,
      },
      () => {
        const entry = setHabitEnabled(body.file, body.id, body.enabled, DEFAULT_ACTOR_ID);
        return {
          result: entry,
          target_id: entry.id,
          summary: `${body.enabled ? 'Enabled' : 'Disabled'} ${body.file} habit "${entry.statement}"`,
          detail: { file: `habits/${body.file}.json` },
        };
      },
    );
    return { habit: outcome.result, habits: readAllHabits(), operation: outcome.operation };
  });

  router.post('/api/habits/weights', (ctx) => {
    const body = parse(S.weightsSchema, ctx.body);
    const outcome = withOperation(
      db(),
      {
        idempotency_key: keyFor(ctx, 'habit-weights'),
        operation_type: 'habit.weights.update',
        target_type: 'habit',
        actor_id: DEFAULT_ACTOR_ID,
      },
      () => {
        const weights = updateWeights(body, DEFAULT_ACTOR_ID);
        return {
          result: weights,
          target_id: 'weights',
          summary: `Updated scoring weights (${Object.keys(body).join(', ')})`,
          detail: { weights },
        };
      },
    );
    return { weights: outcome.result, habits: readAllHabits(), operation: outcome.operation };
  });

  /**
   * 耗时换算偏好：每天工作几小时、每月工作几天。
   *
   * 只影响**之后**新建/更新任务时的「天/月 → 分钟」折算；已落库的
   * `estimated_minutes` 是写入当时的事实，这里不回算、不批改任何任务。
   */
  router.post('/api/habits/duration-prefs', (ctx) => {
    const body = parse(S.durationPrefsSchema, ctx.body);
    const outcome = withOperation(
      db(),
      {
        idempotency_key: keyFor(ctx, 'habit-duration-prefs'),
        operation_type: 'habit.duration_prefs.update',
        target_type: 'habit',
        actor_id: DEFAULT_ACTOR_ID,
      },
      () => {
        const prefs = updateDurationPrefs(body, DEFAULT_ACTOR_ID);
        return {
          result: prefs,
          target_id: 'weights',
          summary:
            `更新耗时换算配置：${prefs.hours_per_day} 小时/天、${prefs.days_per_month} 天/月` +
            `（仅影响之后的换算）`,
          detail: { prefs, fields: Object.keys(body) },
          // 换算配置不改任何任务的分钟数，队列排序没有变化，省掉一次刷新。
          skipQueueRefresh: true,
        };
      },
    );
    return { prefs: outcome.result, habits: readAllHabits(), operation: outcome.operation };
  });

  // ── settings ──────────────────────────────────────────────────────────────
  /**
   * 设置页的统一读写面。四个习惯文件在界面上是**一页**设置，所以这里把它们摊平
   * 成一个快照，并让每个写操作都回最新快照——客户端写完直接替换本地状态，不必
   * 二次拉取。
   *
   * 三条贯穿所有写路由的规则：
   *   1. **版本校验不可跳过。** body 里的 `expected_version` 必须等于对应文件的
   *      `updated_at`，不符即 409（错误体带当前快照，给客户端直接替换）。校验在
   *      动笔之前，所以一次失败不会留下半截写入。
   *   2. **都套 `withOperation`。** 幂等（Idempotency-Key）与操作日志与任务侧
   *      完全同源，设置写不是「小改动」所以也不走捷径。
   *   3. **跳过队列刷新。** 习惯确实影响排序，但重算在 `refreshQueue` 里读的是
   *      最新文件，而设置页写完会触发客户端刷新；真正需要立刻重排的调用方可以
   *      显式 `POST /api/queue/recalculate`。唯一的例外是权重/偏好的保存——它
   *      直接改排序输入，必须当场重算。
   */

  /** 读快照。纯读，不写操作日志。 */
  router.get('/api/settings', () => buildSettingsSnapshot());
  router.get('/api/settings/inference-status', () => habitInferenceStatus(db()));

  /**
   * 一次设置写：版本校验 → 落盘 → 操作日志 → 回最新快照。
   *
   * `refreshQueue` 决定要不要顺带重排队列：只有改排序权重/偏好时才需要。
   */
  const settingsWrite = (
    ctx: RequestContext,
    options: { operation: string; keyPrefix: string; refreshQueue?: boolean },
    mutate: () => SettingsWriteResult,
  ) => {
    const outcome = withOperation(
      db(),
      {
        idempotency_key: keyFor(ctx, options.keyPrefix),
        operation_type: options.operation,
        target_type: 'habit',
        actor_id: DEFAULT_ACTOR_ID,
      },
      () => {
        const written = mutate();
        return {
          result: { snapshot: written.snapshot },
          target_id: written.target_id,
          summary: written.summary,
          detail: { versions: written.snapshot.versions },
          skipQueueRefresh: !options.refreshQueue,
        };
      },
    );
    // 重放时 `result` 是上次缓存的响应体，形状一致，所以直接回它。
    return outcome.result;
  };

  router.post('/api/settings/conversion', (ctx) => {
    const body = parse(S.settingsConversionSchema, ctx.body);
    return settingsWrite(
      ctx,
      { operation: 'settings.conversion.update', keyPrefix: 'settings-conversion' },
      () => updateSettingsConversion(body, DEFAULT_ACTOR_ID),
    );
  });

  router.post('/api/settings/conversion/reset', (ctx) => {
    const body = parse(S.settingsVersionOnlySchema, ctx.body);
    return settingsWrite(
      ctx,
      { operation: 'settings.conversion.reset', keyPrefix: 'settings-conversion-reset' },
      () => resetSettingsConversion(body, DEFAULT_ACTOR_ID),
    );
  });

  router.post('/api/settings/constraints', (ctx) => {
    const body = parse(S.settingsConstraintCreateSchema, ctx.body);
    return settingsWrite(
      ctx,
      { operation: 'settings.constraint.create', keyPrefix: 'settings-constraint-create' },
      () => createSettingsConstraint(body, DEFAULT_ACTOR_ID),
    );
  });

  router.patch('/api/settings/constraints/:id', (ctx) => {
    const body = parse(S.settingsConstraintPatchSchema, ctx.body);
    return settingsWrite(
      ctx,
      { operation: 'settings.constraint.update', keyPrefix: 'settings-constraint-update' },
      () => updateSettingsConstraint(ctx.params.id, body, DEFAULT_ACTOR_ID),
    );
  });

  router.post('/api/settings/constraints/:id/enabled', (ctx) => {
    const body = parse(S.settingsEnabledSchema, ctx.body);
    return settingsWrite(
      ctx,
      {
        operation: body.enabled ? 'settings.constraint.enable' : 'settings.constraint.disable',
        keyPrefix: 'settings-constraint-enabled',
      },
      () => setSettingsConstraintEnabled(ctx.params.id, body, DEFAULT_ACTOR_ID),
    );
  });

  router.post('/api/settings/explicit', (ctx) => {
    const body = parse(S.settingsExplicitCreateSchema, ctx.body);
    return settingsWrite(
      ctx,
      { operation: 'settings.explicit.create', keyPrefix: 'settings-explicit-create' },
      () => createSettingsExplicit(body, DEFAULT_ACTOR_ID),
    );
  });

  router.patch('/api/settings/explicit/:id', (ctx) => {
    const body = parse(S.settingsExplicitPatchSchema, ctx.body);
    return settingsWrite(
      ctx,
      { operation: 'settings.explicit.update', keyPrefix: 'settings-explicit-update' },
      () => updateSettingsExplicit(ctx.params.id, body, DEFAULT_ACTOR_ID),
    );
  });

  router.post('/api/settings/explicit/:id/enabled', (ctx) => {
    const body = parse(S.settingsEnabledSchema, ctx.body);
    return settingsWrite(
      ctx,
      {
        operation: body.enabled ? 'settings.explicit.enable' : 'settings.explicit.disable',
        keyPrefix: 'settings-explicit-enabled',
      },
      () => setSettingsHabitEnabled('explicit', ctx.params.id, body, DEFAULT_ACTOR_ID),
    );
  });

  /** 推断习惯没有新建/改写，只有启停与采纳——它的内容是观察的结论，不是用户的话。 */
  router.post('/api/settings/inferred/:id/enabled', (ctx) => {
    const body = parse(S.settingsEnabledSchema, ctx.body);
    return settingsWrite(
      ctx,
      {
        operation: body.enabled ? 'settings.inferred.enable' : 'settings.inferred.disable',
        keyPrefix: 'settings-inferred-enabled',
      },
      () => setSettingsHabitEnabled('inferred', ctx.params.id, body, DEFAULT_ACTOR_ID),
    );
  });

  /**
   * 双资源写：两个版本都要带、都要比对（见 `adoptSettingsInferred`）。
   *
   * **先做一次纯读的已采纳预检，再决定要不要动笔。** 采纳按钮会被重复点、客户端
   * 会重试，而 `withOperation` 的幂等只认 Idempotency-Key：换一个 key 的同一次
   * 采纳照样会 append 第二条 explicit（真实数据里已经出现过）。所以这里在进入
   * `settingsWrite` 之前就判断「这条 inferred 是否已有对应的 explicit」，命中就
   * 直接回当前快照 + `already: true`，**不写文件、不追加 history、不写操作日志**
   * ——无论请求带的是相同还是不同的 Idempotency-Key。
   *
   * 这条幂等路径也**不校验版本**：它什么都没改，拿一个可能过期的版本号把一次
   * 「结果已经达成」的请求判成 409 只会让界面弹无意义的冲突提示。
   *
   * 没采纳过才落到原流程：双版本校验 + 原子写 explicit/inferred。并发的第二个
   * 请求因此会被 `assertSettingsVersion` 判 409（第一个已推进 explicit 版本），
   * 不需要额外的锁。
   */
  router.post('/api/settings/inferred/:id/adopt', (ctx) => {
    const body = parse(S.settingsAdoptSchema, ctx.body);
    const existing = findExistingAdoption(ctx.params.id);
    if (existing) {
      return { snapshot: buildSettingsSnapshot(), already: true, existing_id: existing.id };
    }
    return settingsWrite(
      ctx,
      { operation: 'settings.inferred.adopt', keyPrefix: 'settings-inferred-adopt' },
      () => adoptSettingsInferred(ctx.params.id, body, DEFAULT_ACTOR_ID),
    );
  });

  /**
   * 权重试算。**不是写操作**：不套 `withOperation`、不写文件、不收版本号。
   *
   * 所以它既不会出现在操作日志里，也不会推进 weights 文件的版本——用户可以放心
   * 连点预览，不会把自己的 `expected_version` 搞过期。
   */
  router.post('/api/settings/weights/preview', (ctx) => {
    const body = parse(S.settingsWeightsPreviewSchema, ctx.body);
    return previewSettingsWeights(body);
  });

  router.post('/api/settings/weights', (ctx) => {
    const body = parse(S.settingsWeightsSaveSchema, ctx.body);
    return settingsWrite(
      ctx,
      {
        operation: 'settings.weights.save',
        keyPrefix: 'settings-weights-save',
        // 唯一需要当场重排的设置写：这六项就是排序公式的系数。
        refreshQueue: true,
      },
      () => saveSettingsWeights(body, DEFAULT_ACTOR_ID),
    );
  });

  // ── agent ─────────────────────────────────────────────────────────────────
  const persistExchange = (
    database: Db,
    sessionId: string,
    userText: string,
    reply: { result: unknown },
  ): AgentMessage[] => {
    const timestamp = nowIso();
    const userMessage: AgentMessage = {
      id: newId('msg'),
      session_id: sessionId,
      role: 'user',
      content: userText,
      result: null,
      created_at: timestamp,
    };
    const agentMessage: AgentMessage = {
      id: newId('msg'),
      session_id: sessionId,
      role: 'agent',
      content: (reply.result as { headline: string }).headline,
      result: reply.result as AgentMessage['result'],
      created_at: nowIso(),
    };
    transaction(database, () => {
      for (const message of [userMessage, agentMessage]) {
        run(
          database,
          'INSERT INTO agent_messages (id, session_id, role, content, result, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          [
            message.id,
            message.session_id,
            message.role,
            message.content,
            message.result ? JSON.stringify(message.result) : null,
            message.created_at,
          ],
        );
      }
      run(database, 'UPDATE agent_sessions SET updated_at = ? WHERE id = ?', [nowIso(), sessionId]);
    });
    return [userMessage, agentMessage];
  };

  const sessionPayload = (database: Db, sessionId: string) => {
    const row = get<Row>(database, 'SELECT * FROM agent_sessions WHERE id = ?', [sessionId])!;
    const count = get<Row>(database, 'SELECT COUNT(*) AS n FROM agent_messages WHERE session_id = ?', [
      sessionId,
    ]);
    return {
      id: row.id,
      title: row.title,
      created_at: row.created_at,
      updated_at: row.updated_at,
      message_count: Number(count?.n ?? 0),
    };
  };

  const executeSkillOperation = (ctx:RequestContext,call:SkillOperation,index:number,token:string):unknown => {
    const def=definitionFor(call),path=operationPath(call),matched=router.match(def.method,path);
    if(!matched)throw notFound('PrinceQ Skill 操作尚未注册');
    const payload={...call.payload};
    // All original versions were checked together before the first action. Earlier actions
    // in this same synchronous transaction may legitimately have advanced a version.
    if ('expected_version' in payload && (def.target==='task'||def.target==='goal')) {
      payload.expected_version=(def.target==='task'?findTask(db(),call.target_id!):findGoal(db(),call.target_id!))?.version;
    }
    if (call.operation==='task.action' && typeof payload.actor_id !== 'string') payload.actor_id=DEFAULT_ACTOR_ID;
    const result=matched.handler({...ctx,params:matched.params,url:new URL(path,ctx.url),body:payload,
      idempotencyKey:`princeq-preview-${token}-${index}`});
    if(result instanceof Promise)throw new Error('PrinceQ mutation handlers must be synchronous');
    return result;
  };
  router.get('/api/skills/princeq',ctx=>{authorizePrinceQRequest(ctx,'read');return {...skillCatalog(),skill:readInjectedPrinceQSkill()};});
  router.get('/api/skills/princeq/context',ctx=>{
    const principal=authorizePrinceQRequest(ctx,'read');
    const sessionId=ctx.url.searchParams.get('session_id')??undefined;
    if(sessionId&&!get(db(),'SELECT id FROM agent_sessions WHERE id = ?',[sessionId]))throw notFound('会话不存在');
    return buildPrinceQContext({db:db(),message:'',actorId:principal.actorId,idempotencyKey:'read-only-context'},readRuntimeConfig(),sessionId);
  });
  router.get('/api/skills/princeq/previews',ctx=>{
    authorizePrinceQRequest(ctx,'read');
    const sessionId=ctx.url.searchParams.get('session_id');
    const rows=sessionId?all<Row>(db(),"SELECT * FROM agent_pending_actions WHERE session_id = ? AND status = 'pending' ORDER BY created_at DESC",[sessionId])
      :all<Row>(db(),"SELECT * FROM agent_pending_actions WHERE status = 'pending' ORDER BY created_at DESC");
    return {previews:rows.map(row=>({...row,actions:JSON.parse(String(row.actions_json)),actions_json:undefined}))};
  });
  router.get('/api/skills/princeq/previews/:token',ctx=>{
    authorizePrinceQRequest(ctx,'read');
    const row=get<Row>(db(),'SELECT * FROM agent_pending_actions WHERE token = ?',[ctx.params.token]);
    if(!row)throw notFound('预览不存在');
    return {...row,actions:JSON.parse(String(row.actions_json)),actions_json:undefined};
  });
  router.post('/api/skills/princeq/previews',ctx=>{
    const principal=authorizePrinceQRequest(ctx,'preview');
    const body=parse(z.strictObject({actions:z.array(skillOperationSchema).min(1).max(20),summary:z.string().trim().min(1).max(200).optional(),session_id:z.string().max(60).nullish()}),ctx.body);
    // External previews live in ordinary chat history, so the user can review and confirm them in PrinceQ.
    const database=db();
    const outcome=withOperation(database,{idempotency_key:keyFor(ctx,'skill-preview'),operation_type:'skill.preview',target_type:'agent',actor_id:principal.actorId},()=>{
    const session=ensureSession(database,body.session_id,`来自 ${principal.callerLabel} 的工作建议`);
    const summary=body.summary??`待确认的 ${body.actions.length} 项 PrinceQ 操作`;
    const token=savePendingActions(database,{sessionId:session.id,summary,actions:body.actions});
    const stored=get<Row>(database,'SELECT actions_json FROM agent_pending_actions WHERE token = ?',[token])!;
    const storedActions=JSON.parse(String(stored.actions_json)) as SkillOperation[];
    const result={kind:'preview' as const,headline:summary,answer:`${summary}。尚未执行，请查看预览后确认。`,reasoning:[],
      blocks:[{type:'list' as const,title:'待确认的动作',items:storedActions.map(action=>describePendingAction(database,action))}],
      pending_action:{token,command:'agent.preview',summary,affected_task_ids:body.actions.filter(a=>definitionFor(a).target==='task').map(a=>a.target_id!)},matched_command:null,mode:'agent' as const};
    const messages=persistExchange(database,session.id,`外部 Agent（${principal.callerLabel}）提交了修改预览。`,{result});
    return {result:{token,status:'pending',summary,session:sessionPayload(database,session.id),messages,result,actions:storedActions,
      review_url:`http://127.0.0.1:28641/?agent_session=${encodeURIComponent(session.id)}`,invalidates:[]},target_id:token,summary,skipQueueRefresh:true};
    });
    return {...outcome.result,replayed:outcome.replayed};
  });
  for(const action of ['confirm','cancel'] as const)router.post(`/api/skills/princeq/previews/:token/${action}`,ctx=>{
    authorizePrinceQRequest(ctx,action);
    const body=parse(z.strictObject({session_id:z.string().max(60).nullish(),confirmed:z.boolean().optional()}),ctx.body);
    if(action==='confirm'&&body.confirmed!==true)throw badRequest('确认需要显式 confirmed=true；请先向用户展示预览');
    const row=get<Row>(db(),'SELECT session_id FROM agent_pending_actions WHERE token = ?',[ctx.params.token]);
    if(!row)throw notFound('预览不存在');
    if(body.session_id && body.session_id !== row.session_id) throw badRequest('预览不属于指定会话');
    const matched=router.match('POST',`/api/agent/preview/${action}`)!;
    return matched.handler({...ctx,body:{token:ctx.params.token,session_id:body.session_id??row.session_id}});
  });

  /**
   * 一条消息要么交给本地 CLI 模型，要么交给规则解析器——由 `processing_mode` 与
   * 运行时健康状况共同决定，并把结论原样写进响应的 `source`，界面不必猜。
   *
   * 不变量：无论走哪条路、无论成败，**用户的原始消息一定落库**（`persistExchange`
   * 在所有分支之后统一调用），所以会话不会因为一次模型失败而丢上下文。
   */
  router.post('/api/agent/message', async (ctx) => {
    const body = parse(S.agentMessageSchema, ctx.body);
    const database = db();
    const session = ensureSession(database, body.session_id, body.message);
    const request = {
      db: database,
      message: body.message,
      actorId: actorFor(body),
      idempotencyKey: keyFor(ctx, 'agent-msg'),
      targetTaskId: body.target_task_id ?? undefined,
      targetGoalId: body.target_goal_id ?? undefined,
      intent: body.intent,
    };

    const cfg = readRuntimeConfig();
    const mode = body.intent === 'goal_task_drafts' ? 'agent' : body.processing_mode ?? 'auto';

    /** 规则解析器那一支，带上「为什么是它」的理由。 */
    const viaCommand = (
      source: 'deterministic-local' | 'deterministic-local-fallback',
      reason: string | null,
    ) => {
      const outcome = localAdapter.handle(request);
      return {
        outcome,
        mode: 'deterministic-local' as const,
        provider: null,
        source,
        fallbackReason: reason,
        availableActions: [] as string[],
      };
    };

    /** agent 失败/未就绪时的错误块。不写任何数据，给出两个明确的下一步。 */
    const asError = (kind: string, detail: string) => ({
      outcome: {
        result: {
          kind: 'error' as const,
          headline: 'Agent 运行失败，未写入任何数据',
          reasoning: [
            `失败类型：${kind}。${detail}`,
            '已保留你的原始消息，可重试或切命令模式。',
          ],
          blocks: [],
          pending_action: null,
          matched_command: null,
          mode: 'agent' as const,
        },
        invalidates: [] as AgentMessageResponse['invalidates'],
      },
      mode: 'agent' as const,
      provider: cfg.provider,
      source: 'agent-error' as const,
      fallbackReason: kind,
      availableActions: ['retry_agent', 'process_with_command_mode'],
    });

    const runAgent = async () => {
      try {
        const llm = await runAgentMessage(request, cfg, { sessionId: session.id });
        return {
          outcome: { result: llm.result, invalidates: llm.invalidates },
          mode: llm.mode,
          provider: cfg.provider,
          source: llm.source,
          fallbackReason: null as string | null,
          availableActions: [] as string[],
        };
      } catch (error) {
        if (!(error instanceof AgentRuntimeError)) throw error;
        // 这次调用失败了，健康缓存不再可信——下一轮重新探测。
        invalidateHealth();
        // 只有请求显式要求，才回退到确定性解析，并如实标注来源。
        if (body.fallback === true && body.intent !== 'goal_task_drafts') {
          return viaCommand('deterministic-local-fallback', 'agent-error-fallback');
        }
        return asError(error.kind, error.message);
      }
    };

    // A server restart or provider switch must not require opening Settings before the first message.
    if (mode !== 'command' && cfg.enabled) await refreshHealth(cfg);

    const chosen =
      mode === 'command'
        ? viaCommand('deterministic-local', 'user-requested-command-mode')
        : mode === 'agent'
          ? isAgentReady(cfg)
            ? await runAgent()
            : asError(notReadyReason(cfg), 'Agent 运行时尚未就绪。')
          : isAgentReady(cfg)
            ? await runAgent()
            : viaCommand('deterministic-local', notReadyReason(cfg));

    const messages = persistExchange(database, session.id, body.message, chosen.outcome);
    return {
      session: sessionPayload(database, session.id),
      messages,
      result: chosen.outcome.result,
      invalidates: chosen.outcome.invalidates,
      mode: chosen.mode,
      provider: chosen.provider,
      source: chosen.source,
      fallback_reason: chosen.fallbackReason,
      available_actions: chosen.availableActions,
    };
  });

  // ── 本地 CLI Agent 运行时：配置 / 测试 / 状态 ───────────────────────────────
  // 配置文件里只有环境变量**名**，所以这几条路由可以原样回显，不需要脱敏。

  router.get('/api/agent/runtime-config', () => {
    const config = readRuntimeConfig();
    return { config, updated_at: config.updated_at };
  });

  router.put('/api/agent/runtime-config', (ctx) => {
    const body = parse(S.agentRuntimeConfigPutSchema, ctx.body);
    const config = writeRuntimeConfig(body.config, body.expected_version, DEFAULT_ACTOR_ID);
    // 配置可能换了 CLI 路径，旧的健康结论立刻作废。
    invalidateHealth();
    return { config, updated_at: config.updated_at, replayed: false };
  });

  /**
   * 连通性测试。只发一句固定的「请回复OK」，**不建 session、不写库、不带业务上下文**。
   */
  router.post('/api/agent/runtime-test', async (ctx) => {
    const body = parse(S.agentRuntimeTestSchema, ctx.body);
    const cfg = readRuntimeConfig();
    return testRuntimeProvider(cfg, body.provider && body.cli_path ? {provider: body.provider, cli_path: body.cli_path} : undefined);
  });

  router.get('/api/agent/runtime-providers', () => listRuntimeProviders(readRuntimeConfig()));
  router.get('/api/agent/models', async ctx => {
    const query=parse(z.strictObject({provider:z.enum(['claude','codex']).optional(),refresh:z.enum(['1','0']).optional()}),Object.fromEntries(ctx.url.searchParams));
    return discoverRuntimeModels(readRuntimeConfig(),query.provider,query.refresh==='1');
  });

  /**
   * 本地 CLI 自动检测。默认**纯只读**：不写库、不建 session、不写配置文件。
   *
   * 只有显式带 `persist=true`（且带上 `expected_version`）时才写回配置，而且写回也只
   * 覆盖 `field_sources` 里仍是 `auto` 的字段——标成 `manual` 的值与标记都原样保留，
   * `enabled` 和 `allowed_env_names` 从不被自动改动。探不到可用候选时只刷新 `detected`
   * 快照，六个值一个都不动：检测失败不该擦掉用户已经配好的东西。
   *
   * 「恢复自动值」仍然是一次普通的 PUT，不需要第二套并发语义。
   */
  router.post('/api/agent/runtime-detect', async (ctx) => {
    const body = parse(S.agentRuntimeDetectSchema, ctx.body);
    const detection = await detectCli({ provider: body.provider });
    if (!body.persist) {
      return { ...detection, persisted: false };
    }
    // schema 的 refine 保证了 persist=true 时 expected_version 一定在。
    const { config } = persistDetected({
      detection,
      expectedVersion: body.expected_version!,
    });
    // 配置可能换了 CLI 路径，旧的健康结论立刻作废。
    invalidateHealth();
    return { ...detection, persisted: true, config, updated_at: config.updated_at };
  });

  router.get('/api/agent/runtime-status', async () => {
    const cfg = readRuntimeConfig();
    // 状态面板要的是实时结论，这里强制跳过 TTL 缓存。
    const health = await refreshHealth(cfg, { force: true });
    const status: AgentRuntimeStatusView = {
      // 「配置过」= 文件真的被写过一次，而不只是落回默认值。
      configured: cfg.updated_at !== defaultRuntimeConfig().updated_at,
      enabled: cfg.enabled,
      provider: cfg.enabled ? cfg.provider : null,
      health: { ok: health.ok, reason: health.reason, checked_at: health.checkedAt },
      effective_mode: health.ok ? 'agent' : 'deterministic-local',
      connection: connectionFor(cfg),
      // 后台常驻 agent 没实现，就如实这么报，不假装支持。
      background: { implemented: false, status: 'not_implemented' },
    };
    return status;
  });

  /**
   * 确认模型建议的那份预览——**这才是模型的写意图第一次真正落库的地方**，而且执行者
   * 是既有的确定性 service，不是模型。
   */
  router.post('/api/agent/preview/confirm', (ctx) => {
    authorizePrinceQRequest(ctx, 'confirm');
    const body = parse(S.agentPreviewConfirmSchema, ctx.body);
    const database = db();
    const session = ensureSession(database, body.session_id, 'Confirmation');
    const applied = confirmPendingActions(
      database,
      body.token,
      actorFor(body),
      keyFor(ctx, 'preview-confirm'),
      (call,index)=>executeSkillOperation(ctx,call,index,body.token),
    );
    const outcome = {
      result: {
        kind: 'applied' as const,
        headline: `已确认：${applied.summary}`,
        answer: [`已处理：${applied.summary}`, ...applied.notes].join('\n'),
        reasoning: [
          '动作由确定性服务执行，模型全程没有写库权限。',
          applied.createdTaskIds.length
            ? `新建了 ${applied.createdTaskIds.length} 个任务。`
            : '没有新建任务。',
          ...applied.notes,
        ],
        blocks: applied.createdTaskIds.length
          ? [
              {
                type: 'tasks' as const,
                title: 'Created tasks',
                task_ids: applied.createdTaskIds,
              },
            ]
          : [],
        pending_action: null,
        matched_command: null,
        mode: 'agent' as const,
      },
      invalidates: ['tasks', 'goals', 'habits', 'queue', 'activity'] as AgentMessageResponse['invalidates'],
    };
    const messages = persistExchange(database, session.id, '确认了模型建议的动作。', outcome);
    return {
      session: sessionPayload(database, session.id),
      messages,
      result: outcome.result,
      invalidates: outcome.invalidates,
    };
  });

  router.post('/api/agent/preview/cancel', (ctx) => {
    authorizePrinceQRequest(ctx, 'cancel');
    const body = parse(S.agentPreviewCancelSchema, ctx.body);
    const database = db();
    const session = ensureSession(database, body.session_id, 'Cancelled the pending preview.');
    const applied = cancelPendingActions(database, body.token);
    const outcome = {
      result: {
        kind: 'applied' as const,
        headline: `已取消：${applied.summary}`,
        answer: `已取消：${applied.summary}。没有执行任何动作。`,
        reasoning: applied.notes,
        blocks: [],
        pending_action: null,
        matched_command: null,
        mode: 'agent' as const,
      },
      invalidates: [] as AgentMessageResponse['invalidates'],
    };
    const messages = persistExchange(database, session.id, '取消了模型建议的动作。', outcome);
    return {
      session: sessionPayload(database, session.id),
      messages,
      result: outcome.result,
      invalidates: outcome.invalidates,
    };
  });

  router.post('/api/agent/confirm', (ctx) => {
    const body = parse(S.agentConfirmSchema, ctx.body);
    const database = db();
    const session = ensureSession(database, body.session_id, 'Confirmation');
    const outcome = confirmPendingAction(
      database,
      body.token,
      actorFor(body),
      keyFor(ctx, 'agent-confirm'),
      body.accepted_drafts,
    );
    const messages = persistExchange(database, session.id, 'Confirmed the pending preview.', outcome);
    return {
      session: sessionPayload(database, session.id),
      messages,
      result: outcome.result,
      invalidates: outcome.invalidates,
    };
  });

  router.post('/api/agent/cancel', (ctx) => {
    const body = parse(S.agentCancelSchema, ctx.body);
    const database = db();
    const session = ensureSession(database, body.session_id, 'Cancelled the pending preview.');
    const outcome = cancelPendingAction(database, body.token, actorFor(body), keyFor(ctx, 'agent-cancel'));
    const messages = persistExchange(database, session.id, 'Cancelled the pending preview.', outcome);
    return {
      session: sessionPayload(database, session.id),
      messages,
      result: outcome.result,
      invalidates: outcome.invalidates,
    };
  });

  router.get('/api/agent/sessions', (ctx) => {
    const query=parse(z.object({limit:z.coerce.number().int().min(1).max(100).default(20),cursor:z.string().max(500).optional()}),Object.fromEntries(ctx.url.searchParams));
    let cursor:{updated_at:string;rowid:number}|undefined;
    if(query.cursor) {
      try {cursor=z.object({updated_at:z.string().refine(value=>!Number.isNaN(Date.parse(value))),rowid:z.number().int().positive()}).parse(JSON.parse(Buffer.from(query.cursor,'base64url').toString('utf8')));}
      catch {throw badRequest('历史会话分页参数无效');}
    }
    const rows=all<Row>(db(),`SELECT s.*, s.rowid AS cursor_rowid,
      (SELECT COUNT(*) FROM agent_messages m WHERE m.session_id = s.id) AS message_count,
      (SELECT substr(m.content,1,100) FROM agent_messages m WHERE m.session_id=s.id ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1) AS last_message
      FROM agent_sessions s WHERE EXISTS (SELECT 1 FROM agent_messages m WHERE m.session_id=s.id)
      ${cursor?'AND (s.updated_at < ? OR (s.updated_at = ? AND s.rowid < ?))':''}
      ORDER BY s.updated_at DESC,s.rowid DESC LIMIT ?`,cursor?[cursor.updated_at,cursor.updated_at,cursor.rowid,query.limit+1]:[query.limit+1]);
    const page=rows.slice(0,query.limit),last=page.at(-1);
    return {sessions:page.map(({cursor_rowid:_,...session})=>session),next_cursor:rows.length>query.limit&&last?Buffer.from(JSON.stringify({updated_at:last.updated_at,rowid:last.cursor_rowid})).toString('base64url'):null};
  });

  router.get('/api/agent/sessions/:id', (ctx) => {
    const database=db(),session=get<Row>(database,'SELECT * FROM agent_sessions WHERE id = ?',[ctx.params.id]);
    if(!session)throw notFound(`No agent session with id "${ctx.params.id}".`);
    const messages=all<Row>(database,'SELECT * FROM agent_messages WHERE session_id = ? ORDER BY created_at,rowid',[ctx.params.id]).map(row=>({id:row.id,session_id:row.session_id,role:row.role,content:row.content,result:row.result?JSON.parse(row.result):null,created_at:row.created_at}));
    const disabled=new Set(all<Row>(database,"SELECT token FROM agent_pending_actions WHERE session_id = ? AND status <> 'pending'",[ctx.params.id]).map(row=>String(row.token)));
    for(const message of messages) {
      const token=message.result?.pending_action?.token;
      if(typeof token==='string'&&!token.startsWith('pa_')) {
        const row=get<Row>(database,'SELECT consumed_at FROM pending_previews WHERE token = ?',[token]);
        if(row?.consumed_at)disabled.add(token);
      }
    }
    return {session:sessionPayload(database,ctx.params.id),messages,disabled_tokens:[...disabled]};
  });

  /**
   * Event stream of queue recalculations. Kept deliberately simple: an initial
   * snapshot event then periodic diffs, so the UI can live-refresh without
   * polling. Falls back gracefully when the client does not use it.
   */
  router.get('/api/events', (ctx) => {
    const { res } = ctx;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    let lastSnapshotId = '';
    const push = () => {
      const snapshots = listSnapshots(db(), 1);
      const current = snapshots[0];
      if (current && current.id !== lastSnapshotId) {
        lastSnapshotId = current.id;
        res.write(`event: queue\ndata: ${JSON.stringify(current)}\n\n`);
      } else {
        res.write(': keep-alive\n\n');
      }
    };
    push();
    const timer = setInterval(push, 3000);
    ctx.req.on('close', () => clearInterval(timer));
    // Signals to the dispatcher that the response is already being handled.
    return undefined;
  });

  // Returned for unhandled routes so a Skill gets a useful hint, not a bare 404.
  router.get('/api', () => ({
    service: 'personal-work-queue',
    reference: 'docs/local-api.md',
    mode: 'deterministic-local',
  }));

  return router;
}

/** Marks the SSE route so the dispatcher does not try to serialise a response. */
export const STREAMING_PATHS = new Set(['/api/events']);
