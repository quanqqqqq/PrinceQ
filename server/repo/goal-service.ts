/**
 * Goal writes plus deterministic goal→task decomposition.
 *
 * Decomposition is a two-step flow on purpose: `previewDecomposition` writes
 * nothing and returns drafts behind a token, and `confirmDecomposition` creates
 * the tasks only when the user accepts. Nothing is created without confirmation.
 */
import type {
  DecompositionDraft,
  DecompositionPreview,
  GoalWithProgress,
  QuadrantSuggestion,
  Task,
} from '../../shared/types.ts';
import {recordRecurrencePause,validateRecurrence} from './recurrence.ts';
import { calendarDate } from '../../shared/recurrence.ts';
import { all, get, run, type Db, type Row } from '../db/connection.ts';
import { matchPhaseToExisting } from '../domain/decomposition.ts';
import { inferQuadrant, QUADRANT_LABELS, ruleScore } from '../domain/quadrant.ts';
import { badRequest, conflict, notFound } from '../lib/errors.ts';
import { newId, nowIso } from '../lib/ids.ts';
import { createTask } from './task-service.ts';
import { findGoal } from './tasks.ts';

export interface CreateGoalInput {
  title: string;
  description?: string | null;
  target_date?: string | null;
  color?: string | null;
  is_demo?: boolean;
}

export function createGoal(db: Db, input: CreateGoalInput): GoalWithProgress {
  const id = newId('goal');
  const timestamp = nowIso();
  run(
    db,
    `INSERT INTO goals (id, title, description, status, target_date, color, is_demo, created_at, updated_at, version)
     VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, 1)`,
    [
      id,
      input.title.trim(),
      input.description?.trim() || null,
      input.target_date ?? null,
      input.color ?? null,
      input.is_demo ? 1 : 0,
      timestamp,
      timestamp,
    ],
  );
  return findGoal(db, id)!;
}

export interface UpdateGoalInput {
  title?: string;
  description?: string | null;
  status?: GoalWithProgress['status'];
  target_date?: string | null;
  color?: string | null;
  expected_version?: number;
}

export function updateGoal(db: Db, id: string, input: UpdateGoalInput): GoalWithProgress {
  const current = findGoal(db, id);
  if (!current) throw notFound(`No goal with id "${id}".`);
  if (input.expected_version != null && input.expected_version !== current.version) {
    throw conflict(
      `Goal was modified by someone else (expected version ${input.expected_version}, found ${current.version}).`,
    );
  }

  if ('target_date' in input) {
    for (const row of all<Row>(db,"SELECT r.* FROM task_recurrences r JOIN tasks t ON t.id=r.task_id WHERE t.goal_id=? AND r.end_mode='goal'",[id])) {
      if (!input.target_date)throw badRequest('目标日期不能清空：仍有关联循环任务');
      validateRecurrence(db,null,{...row as import('../../shared/recurrence.ts').RecurrenceInput,end_mode:'date',end_date:calendarDate(input.target_date,row.timezone)});
    }
  }
  const columns = ['title', 'description', 'status', 'target_date', 'color'] as const;
  const assignments: string[] = [];
  const params: (string | number | null)[] = [];
  for (const column of columns) {
    if (column in input) {
      assignments.push(`${column} = ?`);
      params.push((input[column] ?? null) as string | null);
    }
  }
  if (assignments.length === 0) throw badRequest('No updatable fields supplied.');

  params.push(nowIso(), id);
  run(
    db,
    `UPDATE goals SET ${assignments.join(', ')}, updated_at = ?, version = version + 1 WHERE id = ?`,
    params,
  );
  if(input.status && input.status!==current.status && (input.status==='paused'||current.status==='paused'))for(const row of all<Row>(db,'SELECT task_id FROM task_recurrences r JOIN tasks t ON t.id=r.task_id WHERE t.goal_id=?',[id]))recordRecurrencePause(db,row.task_id,'goal',input.status==='paused');
  return findGoal(db, id)!;
}

/**
 * Deterministic decomposition templates.
 *
 * Keyword-matched phase sets — no model involved. Each phase becomes a draft
 * task whose quadrant suggestion is computed with the same inference the Agent
 * uses, so the preview shows exactly what would be created.
 *
 * UX-22：阶段后缀与说明都是中文动作短语。模式同时认英文关键词（带 `\b`）与中文
 * 关键词（中文没有词边界，所以单独一组不带 `\b` 的分支）。
 */
interface Phase {
  suffix: string;
  description: string;
  minutes: number;
  type: DecompositionDraft['task_type'];
  load: DecompositionDraft['cognitive_load'];
}

const TEMPLATES: { pattern: RegExp; label: string; phases: Phase[] }[] = [
  {
    pattern: /\b(ship|launch|release|deliver|build)\b|(实现|上线|发布|交付)/i,
    label: 'delivery',
    phases: [
      { suffix: '明确范围与验收标准', description: '写清"怎样算做完"和验收检查', minutes: 45, type: 'deep_work', load: 'high' },
      { suffix: '完成核心实现', description: '做主体构建工作', minutes: 180, type: 'deep_work', load: 'high' },
      { suffix: '自评审并补齐缺口', description: '自查、修补遗漏、收尾', minutes: 60, type: 'review', load: 'medium' },
      { suffix: '发布并同步给相关人', description: '上线并通知等待的人', minutes: 30, type: 'communication', load: 'low' },
    ],
  },
  {
    pattern: /\b(learn|study|master|course|read|understand)\b|(学习|掌握|课程|读懂)/i,
    label: 'learning',
    phases: [
      { suffix: '选定一份权威资料并通览', description: '选单一权威来源，先看整体结构', minutes: 45, type: 'learning', load: 'medium' },
      { suffix: '精读核心部分并做笔记', description: '精读核心章节或模块', minutes: 120, type: 'learning', load: 'high' },
      { suffix: '用它做一个小练习', description: '套到一个小问题上暴露盲区', minutes: 90, type: 'deep_work', load: 'high' },
      { suffix: '写出可复习的小结', description: '浓缩成自己会重读的笔记', minutes: 30, type: 'shallow_work', load: 'low' },
    ],
  },
  {
    pattern: /\b(plan|strategy|decide|evaluate|research|investigate)\b|(调研|规划|评估|选型)/i,
    label: 'research',
    phases: [
      { suffix: '厘清要决策的问题与判断标准', description: '写明要拍什么板、什么证据能定案', minutes: 30, type: 'deep_work', load: 'high' },
      { suffix: '收集各选项的资料与先例', description: '为每个选项收集数据与先例', minutes: 90, type: 'learning', load: 'medium' },
      { suffix: '按标准逐项对比', description: '把选项按标准并排对比', minutes: 60, type: 'deep_work', load: 'high' },
      { suffix: '写下结论与依据', description: '记录决定与理由', minutes: 45, type: 'shallow_work', load: 'medium' },
    ],
  },
  {
    pattern: /\b(habit|routine|health|fitness|exercise|sleep)\b|(习惯|健康|健身|睡眠)/i,
    label: 'habit',
    phases: [
      { suffix: '定义每天都能坚持的最小版本', description: '选你绝不会跳过的最小量', minutes: 20, type: 'shallow_work', load: 'low' },
      { suffix: '绑定触发时机并确定记录方式', description: '挂到既有提示上，决定怎么记', minutes: 30, type: 'admin', load: 'low' },
      { suffix: '连续试行两周并逐日记录', description: '按最小量执行并每天记', minutes: 60, type: 'shallow_work', load: 'low' },
      { suffix: '回顾记录并调整', description: '看记录，决定保持、缩小或换触发', minutes: 30, type: 'review', load: 'medium' },
    ],
  },
  {
    pattern: /\b(review)\b|(评审|复核|审稿|验收)/i,
    label: 'review',
    phases: [
      { suffix: '通读待评审材料并标注问题', description: '通读并把问题标出来', minutes: 60, type: 'review', load: 'medium' },
      { suffix: '按清单逐项核对关键点', description: '用清单逐条核对', minutes: 90, type: 'review', load: 'medium' },
      { suffix: '汇总评审意见并反馈', description: '整理意见并反馈给作者', minutes: 45, type: 'communication', load: 'medium' },
    ],
  },
  {
    pattern: /\b(write|document|report|doc)\b|(文档|写作|报告|汇报)/i,
    label: 'writing',
    phases: [
      { suffix: '列出大纲与目标读者', description: '定结构与读者', minutes: 30, type: 'deep_work', load: 'medium' },
      { suffix: '撰写核心内容初稿', description: '写出主体初稿', minutes: 120, type: 'deep_work', load: 'high' },
      { suffix: '校对事实与表述', description: '核对事实与措辞', minutes: 45, type: 'review', load: 'medium' },
      { suffix: '定稿并发布', description: '定稿并分发', minutes: 20, type: 'communication', load: 'low' },
    ],
  },
];

const GENERIC: Phase[] = [
  { suffix: '用一句话写清"怎样算做完"', description: '一句话定义完成标准', minutes: 30, type: 'deep_work', load: 'medium' },
  { suffix: '迈出能产生实质进展的最小一步', description: '真正带来进展的最小动作', minutes: 60, type: 'deep_work', load: 'high' },
  { suffix: '完成主体工作', description: '朝目标推进的主体投入', minutes: 120, type: 'deep_work', load: 'high' },
  { suffix: '确认结果并复盘遗留', description: '确认是否达成，记下遗留', minutes: 45, type: 'review', load: 'medium' },
];

/** 模板 label → notes 里用的中文名。 */
const TEMPLATE_LABELS_ZH: Record<string, string> = {
  delivery: '发布上线',
  learning: '学习掌握',
  research: '调研规划',
  habit: '习惯养成',
  review: '评审复核',
  writing: '文档写作',
};

/** 重复提示里要显示的已有任务状态中文名（已完成不会走到这里）。 */
const EXISTING_STATUS_ZH: Record<string, string> = {
  inbox: '待处理',
  claimed: '已领取',
  in_progress: '进行中',
  blocked: '受阻',
  completed: '已完成',
};

/**
 * 目标没有截止日期时，草稿不该被判成「紧急」。
 *
 * 紧急性在这个产品里只有一个客观依据——死线。目标没给死线，草稿也就不带死线，
 * 这时如果还因为标题里有「上线」「发布」之类的词把它放进紧急象限，就是凭措辞臆
 * 造紧迫感。所以把紧急象限降一档（q1→q2、q3→q4），并把 urgency_score 压到非紧急
 * 区间。`inferQuadrant` 本身不动，只在这里对结果做映射。
 */
const NON_URGENT_RAW = 2.8;

function withoutUrgency(suggestion: QuadrantSuggestion): QuadrantSuggestion {
  if (suggestion.quadrant !== 'q1' && suggestion.quadrant !== 'q3') return suggestion;
  const quadrant = suggestion.quadrant === 'q1' ? 'q2' : 'q4';
  return {
    ...suggestion,
    quadrant,
    // 1..5 轴与 0..100 分同步降档，否则徽章说「不紧急」而旁边的 urgency 还写 4/5。
    urgency: Math.round(NON_URGENT_RAW),
    urgency_score: ruleScore(NON_URGENT_RAW),
    // reason 是 inferQuadrant 拼好的整句，开头就是降档前的象限标签。换掉开头并
    // 补一句原因，免得展开「依据」看到的结论和徽章自相矛盾。
    reason:
      suggestion.reason.replace(
        QUADRANT_LABELS[suggestion.quadrant],
        QUADRANT_LABELS[quadrant],
      ) + ' 目标无截止依据，已按非紧急处理。',
    signals: [...suggestion.signals, '目标无截止依据，未按紧急象限处理'],
  };
}

/** Builds drafts without writing anything; the token gates the actual create. */
export function previewDecomposition(db: Db, goalId: string): DecompositionPreview {
  const goal = findGoal(db, goalId);
  if (!goal) throw notFound(`No goal with id "${goalId}".`);

  const haystack = `${goal.title} ${goal.description ?? ''}`;
  const template = TEMPLATES.find((t) => t.pattern.test(haystack));
  const phases = template?.phases ?? GENERIC;

  // Spread deadlines across the goal's target date when it has one.
  const targetMs = goal.target_date ? Date.parse(goal.target_date) : NaN;
  const hasTarget = !Number.isNaN(targetMs);

  // UX-22：本目标下未归档任务的标题与状态，用于查重。
  const existing = all<Row>(
    db,
    "SELECT title, status FROM tasks WHERE goal_id = ? AND status <> 'archived'",
    [goalId],
  ).map((row) => ({ title: String(row.title ?? ''), status: String(row.status ?? '') }));

  const notes: string[] = [];
  const drafts: DecompositionDraft[] = [];

  phases.forEach((phase, index) => {
    const match = matchPhaseToExisting(phase.suffix, goal.title, existing);

    // 已完成的工作不建议重做：整条跳过，只在 notes 里交代一句。
    if (match && match.task.status === 'completed') {
      notes.push(
        `「${phase.suffix}」已有已完成任务「${match.task.title}」，不再重复建议。`,
      );
      return;
    }

    const deadline = hasTarget
      ? new Date(
          Date.now() + ((targetMs - Date.now()) * (index + 1)) / phases.length,
        ).toISOString()
      : null;
    const title = `${goal.title}：${phase.suffix}`;
    const suggestion = inferQuadrant({
      title,
      description: phase.description,
      deadline,
      estimated_minutes: phase.minutes,
      cognitive_load: phase.load,
      task_type: phase.type,
      goal_title: goal.title,
    });

    drafts.push({
      title,
      description: phase.description,
      estimated_minutes: phase.minutes,
      task_type: phase.type,
      cognitive_load: phase.load,
      deadline,
      suggestion: hasTarget ? suggestion : withoutUrgency(suggestion),
      duplicate: match
        ? {
            existing_title: match.task.title,
            existing_status: match.task.status,
            reason:
              `已存在类似任务：「${match.task.title}」（` +
              `${EXISTING_STATUS_ZH[match.task.status] ?? match.task.status}），默认未勾选`,
          }
        : null,
    });
  });

  const token = newId('preview');
  run(
    db,
    'INSERT INTO pending_previews (token, kind, payload, created_at) VALUES (?, ?, ?, ?)',
    [token, 'goal_decomposition', JSON.stringify({ goal_id: goalId, drafts }), nowIso()],
  );

  return {
    goal_id: goalId,
    goal_title: goal.title,
    preview_token: token,
    drafts,
    notes: [
      `命中确定性拆分模板「${template ? TEMPLATE_LABELS_ZH[template.label] : '通用'}」，未调用任何模型。`,
      hasTarget
        ? `草稿的截止时间在目标日期（${goal.target_date}）之前均匀分布。`
        : '目标没有截止日期，草稿不设截止时间，也不按紧急象限建议。',
      ...notes,
      `本目标已有 ${existing.length} 个任务，确认前不会新建。`,
      '每个象限均为建议，创建后仍待你确认。',
    ],
  };
}

export interface ConfirmDecompositionOptions {
  /** Legacy acceptance by draft title; kept for the Skill/agent surface. */
  acceptedTitles?: string[];
  /**
   * Positional acceptance. The preview lets the user edit a draft before
   * confirming, so `title`/`description` here win over the stored draft.
   */
  acceptedDrafts?: { index: number; title: string; description?: string | null }[];
}

/** Consumes the preview token and creates the accepted drafts. */
export function confirmDecomposition(
  db: Db,
  token: string,
  opts: ConfirmDecompositionOptions = {},
): { goal: GoalWithProgress; tasks: Task[] } {
  const row = get<Row>(db, 'SELECT * FROM pending_previews WHERE token = ?', [token]);
  if (!row) throw notFound('That decomposition preview is unknown or expired.');
  if (row.consumed_at) throw conflict('That decomposition preview was already confirmed.');

  const payload = JSON.parse(row.payload) as { goal_id: string; drafts: DecompositionDraft[] };

  let accepted: DecompositionDraft[];
  if (opts.acceptedDrafts?.length) {
    accepted = opts.acceptedDrafts.map((override) => {
      const draft = payload.drafts[override.index];
      if (!draft) {
        throw badRequest(
          `Draft index ${override.index} is out of range for this preview (${payload.drafts.length} draft(s)).`,
        );
      }
      return {
        ...draft,
        title: override.title,
        description: override.description ?? draft.description,
      };
    });
  } else if (opts.acceptedTitles?.length) {
    accepted = payload.drafts.filter((d) => opts.acceptedTitles!.includes(d.title));
  } else {
    accepted = payload.drafts;
  }

  if (accepted.length === 0) {
    throw badRequest('No drafts were accepted, so nothing was created.');
  }

  run(db, 'UPDATE pending_previews SET consumed_at = ? WHERE token = ?', [nowIso(), token]);

  const tasks = accepted.map((draft) =>
    createTask(db, {
      title: draft.title,
      description: draft.description,
      goal_id: payload.goal_id,
      deadline: draft.deadline,
      estimated_minutes: draft.estimated_minutes,
      task_type: draft.task_type,
      cognitive_load: draft.cognitive_load,
      // 存预览里展示过的那份判定，而不是让 createTask 重算一遍——否则「无截止
      // 依据不判紧急」的降档会被重新推断覆盖，任务最终落到用户刚刚确认过的
      // 象限之外。
      rule_suggestion: draft.suggestion,
    }),
  );

  return { goal: findGoal(db, payload.goal_id)!, tasks };
}

/**
 * 用户在助手面板点「取消」：把这份预览标记为已消费，但绝不创建任何任务。
 * 服务端注销后，即使用户刷新页面，旧 token 也不能再被确认或重复提交。
 * 幂等：重复取消同一个 token 返回相同结果，不报错。
 */
export function cancelDecomposition(db: Db, token: string): { goal_title: string; already: boolean } {
  const row = get<Row>(db, 'SELECT * FROM pending_previews WHERE token = ?', [token]);
  if (!row) throw notFound('That decomposition preview is unknown or expired.');
  const payload = JSON.parse(row.payload) as { goal_id: string };
  const goal = findGoal(db, payload.goal_id);
  if (row.consumed_at) {
    return { goal_title: goal?.title ?? '(已删除目标)', already: true };
  }
  run(db, 'UPDATE pending_previews SET consumed_at = ? WHERE token = ?', [nowIso(), token]);
  return { goal_title: goal?.title ?? '(已删除目标)', already: false };
}
