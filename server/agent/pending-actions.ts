/**
 * 模型建议动作的暂存与确认执行。
 *
 * 这个模块是本特性的核心安全不变量：**模型永远拿不到写库能力。** 它的输出只能变成
 * `agent_pending_actions` 里的一行「待确认预览」；只有用户点确认之后，才由这里把每条
 * 动作转交给既有的确定性 service（`createTask` / `createGoal` / `applyAction` /
 * `addExplicitHabit`）去落库。模型从不接触 SQL、文件写入或 shell。
 *
 * 白名单由 PrinceQ Skill 操作合同与兼容动作共同定义：未注册的操作都被丢弃并记进 `notes`，而不是「尽力执行」。
 * 同理，标题解析要求**唯一命中**——多命中或零命中一律跳过并说明，绝不猜一个。
 */
import { z } from 'zod';
import { AGENT_ACTOR_ID, DEFAULT_ACTOR_ID } from '../config.ts';
import { get, run, type Db, type Row } from '../db/connection.ts';
import { addExplicitHabit } from '../domain/habits.ts';
import { badRequest, conflict, notFound } from '../lib/errors.ts';
import {skillOperationSchema, prepareSkillOperation, checkSkillPreconditions, definitionFor, describeSkillOperation, type SkillOperation} from '../skills/catalog.ts';
import { newId, nowIso } from '../lib/ids.ts';
import { createGoal } from '../repo/goal-service.ts';
import { withOperation } from '../repo/operations.ts';
import { applyAction, createTask } from '../repo/task-service.ts';
import { findGoalsByTitle, findTasksByTitle } from '../repo/tasks.ts';

/** One shared Skill operation contract, plus legacy and combined goal proposal shapes. */
export const pendingActionSchema = z.union([skillOperationSchema, z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('create_task'),
    title: z.string().trim().min(1).max(200),
    deadline_iso: z.string().trim().max(40).nullish(),
    minutes: z.number().int().min(1).max(10000).nullish(),
    goal_title: z.string().trim().max(200).nullish(),
  }),
  z.strictObject({
    action: z.literal('create_goal'),
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(4000).nullish(),
    target_date_iso: z.string().trim().max(40).nullish(),
  }),
  z.strictObject({
    action: z.literal('create_goal_with_tasks'),
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(4000).nullish(),
    target_date_iso: z.string().trim().max(40).nullish(),
    tasks: z.array(z.strictObject({
      title: z.string().trim().min(1).max(200),
      description: z.string().trim().min(1).max(4000),
      deadline_iso: z.string().trim().max(40).nullish(),
      minutes: z.number().int().min(1).max(10000).nullish(),
    })).min(1).max(19),
  }).superRefine((action, ctx) => {
    const seen = new Set<string>();
    action.tasks.forEach((task, index) => {
      const key = task.title.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
      if (seen.has(key)) ctx.addIssue({code: 'custom', path: ['tasks', index, 'title'], message: '任务标题不能重复。'});
      seen.add(key);
    });
  }),
  z.strictObject({
    action: z.literal('task_action'),
    task_title: z.string().trim().min(1).max(200),
    lifecycle: z.enum(['claim', 'release', 'start', 'complete', 'block']),
    reason: z.string().trim().max(400).nullish(),
  }),
  z.strictObject({
    action: z.literal('add_habit'),
    statement: z.string().trim().min(3).max(400),
  }),
])]);

export type PendingAction = z.infer<typeof pendingActionSchema>;

export interface SavePendingInput {
  sessionId: string | null;
  summary: string;
  actions: PendingAction[];
}

/** 存一份待确认预览，返回确认用的 token。**不写任何业务表。** */
export function savePendingActions(db: Db, input: SavePendingInput): string {
  if (!input.actions.length || input.actions.length > 20) throw badRequest('每份预览允许 1–20 个动作');
  const actions = input.actions.map(action => action.action === 'skill_operation' ? prepareSkillOperation(db, action) : pendingActionSchema.parse(action));
  if (actions.some(action => action.action === 'add_habit' || (action.action === 'skill_operation' && definitionFor(action).fileWrite)) && actions.length > 1) throw badRequest('修改个人设置需要单独预览，请逐项确认');
  const token = newId('pa');
  run(
    db,
    `INSERT INTO agent_pending_actions
       (token, session_id, summary, actions_json, status, created_at, resolved_at)
     VALUES (?, ?, ?, ?, 'pending', ?, NULL)`,
    [token, input.sessionId, input.summary, JSON.stringify(actions), nowIso()],
  );
  return token;
}

export interface ConfirmResult {
  summary: string;
  createdGoalIds: string[];
  createdTaskIds: string[];
  notes: string[];
}

/**
 * 确认并执行一份预览。整体包在 `withOperation` 里：操作日志、幂等键、队列重排与
 * 其它所有写路径共用同一套保证，重复点确认不会写第二遍。
 */
export function confirmPendingActions(
  db: Db,
  token: string,
  actorId: string,
  idempotencyKey: string,
  executeSkill?: (action: SkillOperation, index: number) => unknown,
): ConfirmResult {
  const outcome = withOperation(
    db,
    {
      idempotency_key: idempotencyKey,
      operation_type: 'agent.preview.confirm',
      target_type: 'task',
      actor_id: actorId,
    },
    () => {
      const row = get<Row>(db, 'SELECT * FROM agent_pending_actions WHERE token = ?', [token]);
      if (!row) throw notFound(`No pending agent preview with token "${token}".`);
      if (row.status !== 'pending') {
        throw notFound(`该预览已被处理过（状态：${row.status}），没有重复执行。`);
      }

      const notes: string[] = [];
      const createdGoalIds: string[] = [];
      const createdTaskIds: string[] = [];
      const raw = JSON.parse(String(row.actions_json)) as unknown[];
      const validated = raw.map(candidate => pendingActionSchema.parse(candidate));
      checkSkillPreconditions(db, validated.filter((action): action is SkillOperation => action.action === 'skill_operation'));
      let index = 0;

      for (const candidate of raw) {
        // 落库前再过一遍白名单：这一行可能跨进程重启存活，不能相信写入时的校验。
        const parsed = pendingActionSchema.safeParse(candidate);
        if (!parsed.success) {
          notes.push('跳过一条不在白名单内的建议动作。');
          continue;
        }
        const action = parsed.data;

        switch (action.action) {
          case 'skill_operation': {
            if (!executeSkill) throw badRequest('当前调用未接入 PrinceQ Skill 执行器');
            const description = describeSkillOperation(db, action);
            const result = executeSkill(action, index++) as {task?:{id:string};tasks?:{id:string}[]};
            if (action.operation === 'task.create' && result?.task) createdTaskIds.push(result.task.id);
            if (action.operation === 'goal.decomposition.confirm') createdTaskIds.push(...(result?.tasks??[]).map(task=>task.id));
            notes.push('已执行：' + description);
            break;
          }
          case 'create_task': {
            let goalId: string | null = null;
            if (action.goal_title) {
              const goals = findGoalsByTitle(db, action.goal_title);
              if (goals.length !== 1) {
                notes.push(
                  `「${action.title}」未挂到目标「${action.goal_title}」：` +
                    `${goals.length === 0 ? '没有匹配的目标' : `匹配到 ${goals.length} 个目标`}，已跳过该动作。`,
                );
                continue;
              }
              goalId = goals[0].id;
            }
            const task = createTask(db, {
              title: action.title,
              deadline: action.deadline_iso ?? null,
              estimated_minutes: action.minutes ?? null,
              goal_id: goalId,
            });
            createdTaskIds.push(task.id);
            break;
          }

          case 'create_goal': {
            const goal = createGoal(db, {
              title: action.title,
              description: action.description ?? null,
              target_date: action.target_date_iso ?? null,
            });
            createdGoalIds.push(goal.id);
            break;
          }

          case 'create_goal_with_tasks': {
            const goal = createGoal(db, {
              title: action.title,
              description: action.description ?? null,
              target_date: action.target_date_iso ?? null,
            });
            createdGoalIds.push(goal.id);
            for (const draft of action.tasks) {
              const task = createTask(db, {
                title: draft.title,
                description: draft.description,
                deadline: draft.deadline_iso ?? null,
                estimated_minutes: draft.minutes ?? null,
                goal_id: goal.id,
              });
              createdTaskIds.push(task.id);
            }
            break;
          }

          case 'task_action': {
            const tasks = findTasksByTitle(db, action.task_title);
            if (tasks.length !== 1) {
              notes.push(
                `「${action.task_title}」的 ${action.lifecycle} 未执行：` +
                  `${tasks.length === 0 ? '没有匹配的任务' : `匹配到 ${tasks.length} 个任务`}，已跳过（不猜）。`,
              );
              continue;
            }
            applyAction(db, tasks[0].id, {
              action: action.lifecycle,
              // 领取归属到人类 actor，即便这条动作由助手转达。
              actor_id: actorId === AGENT_ACTOR_ID ? DEFAULT_ACTOR_ID : actorId,
              reason: action.reason ?? null,
            });
            break;
          }

          case 'add_habit': {
            addExplicitHabit({ statement: action.statement, source: 'agent' }, actorId);
            break;
          }
        }
      }

      run(
        db,
        "UPDATE agent_pending_actions SET status = 'confirmed', resolved_at = ? WHERE token = ?",
        [nowIso(), token],
      );

      return {
        result: { summary: String(row.summary), createdGoalIds, createdTaskIds, notes },
        target_id: createdGoalIds[0] ?? createdTaskIds[0] ?? null,
        summary: `确认模型建议：${row.summary}`,
        detail: { task_ids: createdTaskIds, notes },
      };
    },
  );

  return outcome.result;
}

/** 取消一份预览：只翻状态，**不执行任何写**。幂等——重复取消返回同样的结果。 */
export function cancelPendingActions(db: Db, token: string): ConfirmResult {
  const row = get<Row>(db, 'SELECT * FROM agent_pending_actions WHERE token = ?', [token]);
  if (!row) throw notFound(`No pending agent preview with token "${token}".`);

  if (row.status === 'confirmed') throw conflict('这份预览已确认执行，不能取消；需要另行预览撤销操作');
  if (row.status === 'pending') {
    run(
      db,
      "UPDATE agent_pending_actions SET status = 'cancelled', resolved_at = ? WHERE token = ?",
      [nowIso(), token],
    );
  }

  return {
    summary: String(row.summary),
    createdGoalIds: [],
    createdTaskIds: [],
    notes:
      row.status === 'pending'
        ? ['已取消，没有执行任何动作。']
        : [`该预览此前已是 ${row.status} 状态，没有重复处理。`],
  };
}
