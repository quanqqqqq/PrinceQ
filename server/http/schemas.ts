/** Zod request schemas. Every write body is validated before it reaches a service. */
import { z } from 'zod';
import { agentRuntimeConfigDraft } from '../agent/runtime-config.ts';
import {
  ACTIVE_TASK_STATUSES,
  COGNITIVE_LOADS,
  DURATION_UNITS,
  GOAL_STATUSES,
  KNOWN_CONSTRAINT_KINDS,
  QUADRANTS,
  RESCORING_AXES,
  RESCORING_STATUSES,
  TASK_ACTIONS,
  TASK_STATUSES,
  TASK_TYPES,
} from '../../shared/types.ts';
import {
  DAYS_PER_MONTH_MAX,
  DAYS_PER_MONTH_MIN,
  HOURS_PER_DAY_MAX,
  HOURS_PER_DAY_MIN,
} from '../../shared/duration.ts';

/** Accepts an ISO-8601 instant or a bare date; normalises to a full ISO string. */
const isoDate = z
  .string()
  .trim()
  .min(4)
  .max(40)
  .refine((value) => !Number.isNaN(Date.parse(value)), 'Expected an ISO-8601 date or datetime')
  .transform((value) => new Date(value).toISOString());

const title = z.string().trim().min(1, 'Title is required').max(200);
const description = z.string().trim().max(4000).nullish();

export const idempotencyKeySchema = z.string().trim().min(8).max(200);

/**
 * One continuous matrix axis: 0..100 with at most one decimal.
 *
 * The range and precision are enforced here as well as in the domain layer, so
 * a bad payload fails as a 400 with issue details before touching the database.
 */
const matrixAxis = z
  .number()
  .min(0)
  .max(100)
  .refine((value) => Math.round(value * 10) === value * 10, '最多保留 1 位小数');

/** Scores produced by a real Agent or supplied by the user — never by a script. */
export const matrixScoreSchema = z.object({
  importance_score: matrixAxis,
  urgency_score: matrixAxis,
  reason: z.string().trim().min(4, '必须说明评分依据').max(2000),
  source: z.enum(['agent', 'user']).optional(),
  confidence: z.number().min(0).max(1).nullish(),
  expected_version: z.number().int().positive().optional(),
});

/**
 * 「数值 + 单位」的耗时输入。
 *
 * 两者必须**同时出现或同时缺省**——只给一半没法换算，默认补一个单位等于替用户
 * 猜。`duration_value: null` + `duration_unit: null` 是清空耗时的约定写法。
 */
const durationValue = z.number().positive().max(100_000).nullish();
const durationUnit = z.enum(DURATION_UNITS).nullish();

/** 两个键要么都出现、要么都不出现（值可以都为 null，表示清空）。 */
const durationPairPresent = (value: Record<string, unknown>): boolean =>
  ('duration_value' in value) === ('duration_unit' in value);

const DURATION_PAIR_MESSAGE = 'duration_value 与 duration_unit 必须同时提供（或同时省略）';

export const createTaskSchema = z
  .object({
    title,
    description: description,
    goal_id: z.string().trim().max(60).nullish(),
    deadline: isoDate.nullish(),
    estimated_minutes: z.number().int().min(1).max(10_000).nullish(),
    duration_value: durationValue,
    duration_unit: durationUnit,
    cognitive_load: z.enum(COGNITIVE_LOADS).nullish(),
    task_type: z.enum(TASK_TYPES).nullish(),
    manual_priority: z.number().int().min(-2).max(2).optional(),
    importance: z.number().int().min(1).max(5).optional(),
    urgency: z.number().int().min(1).max(5).optional(),
    /** The Agent's own two-axis judgement, supplied at creation time. */
    matrix_score: matrixScoreSchema.omit({ expected_version: true }).optional(),
    depends_on: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
  })
  .refine(durationPairPresent, DURATION_PAIR_MESSAGE);

export const updateTaskSchema = z
  .object({
    title: title.optional(),
    description,
    goal_id: z.string().trim().max(60).nullish(),
    deadline: isoDate.nullish(),
    estimated_minutes: z.number().int().min(1).max(10_000).nullish(),
    duration_value: durationValue,
    duration_unit: durationUnit,
    cognitive_load: z.enum(COGNITIVE_LOADS).nullish(),
    task_type: z.enum(TASK_TYPES).nullish(),
    manual_priority: z.number().int().min(-2).max(2).optional(),
    manual_override: z.number().min(-50).max(50).optional(),
    importance: z.number().int().min(1).max(5).optional(),
    urgency: z.number().int().min(1).max(5).optional(),
    expected_version: z.number().int().positive().optional(),
  })
  .refine(
    (value) => Object.keys(value).some((key) => key !== 'expected_version'),
    'At least one field must be supplied',
  )
  .refine(durationPairPresent, DURATION_PAIR_MESSAGE);

/**
 * `POST /api/habits/duration-prefs` 的请求体。
 *
 * 两个键都是可选的（只改一个也行），但至少要给一个。范围与
 * `shared/duration.ts`、`server/domain/habits.ts` 的 zod 一致：
 * hours_per_day ∈ [0.5, 24]，days_per_month ∈ [1, 31]。
 */
export const durationPrefsSchema = z
  .object({
    hours_per_day: z.number().min(HOURS_PER_DAY_MIN).max(HOURS_PER_DAY_MAX).optional(),
    days_per_month: z.number().min(DAYS_PER_MONTH_MIN).max(DAYS_PER_MONTH_MAX).optional(),
  })
  .refine(
    (value) => value.hours_per_day !== undefined || value.days_per_month !== undefined,
    'hours_per_day 与 days_per_month 至少要提供一个',
  );

export const taskActionSchema = z.object({
  action: z.enum(TASK_ACTIONS),
  actor_id: z.string().trim().min(1).max(60).optional(),
  reason: z.string().trim().max(500).nullish(),
  /**
   * Optimistic concurrency for lifecycle moves (archive / restore / reopen …).
   * When supplied the write is rejected with 409 unless the task's version still
   * matches, so a stale undo can't clobber a state the user already moved on.
   */
  expected_version: z.number().int().positive().optional(),
});

export const taskListQuerySchema = z.object({
  status: z
    .string()
    .optional()
    .transform((value) => value?.split(',').map((s) => s.trim()).filter(Boolean))
    .pipe(z.array(z.enum(TASK_STATUSES)).optional()),
  goal_id: z.string().trim().max(60).optional(),
  quadrant: z.enum([...QUADRANTS, 'unclassified']).optional(),
  unconfirmed: z
    .string()
    .optional()
    .transform((value) => value === 'true' || value === '1'),
  active: z
    .string()
    .optional()
    .transform((value) => value === 'true' || value === '1'),
});

export const ACTIVE_STATUS_LIST = [...ACTIVE_TASK_STATUSES];

export const quadrantChangeSchema = z.object({
  quadrant: z.enum(QUADRANTS),
  reason: z.string().trim().max(500).optional(),
});

export const createGoalSchema = z.object({
  title,
  description,
  target_date: isoDate.nullish(),
  color: z.string().trim().max(40).nullish(),
});

export const updateGoalSchema = z
  .object({
    title: title.optional(),
    description,
    status: z.enum(GOAL_STATUSES).optional(),
    target_date: isoDate.nullish(),
    color: z.string().trim().max(40).nullish(),
    expected_version: z.number().int().positive().optional(),
  })
  .refine(
    (value) => Object.keys(value).some((key) => key !== 'expected_version'),
    'At least one field must be supplied',
  );

export const confirmDecompositionSchema = z.object({
  preview_token: z.string().trim().min(4).max(80),
  accepted_titles: z.array(z.string().trim().min(1).max(260)).max(20).optional(),
  /**
   * Positional overrides: the user may edit a draft's title/description in the
   * preview, so acceptance is keyed by index rather than by the original title.
   */
  accepted_drafts: z
    .array(
      z.object({
        index: z.number().int().min(0),
        title,
        description: description.nullish(),
      }),
    )
    .max(20)
    .optional(),
});

export const addDependencySchema = z.object({
  depends_on_id: z.string().trim().min(1).max(60),
});

export const recalculateSchema = z.object({
  reason: z.string().trim().min(1).max(120).optional(),
});

export const addHabitSchema = z.object({
  statement: z.string().trim().min(3).max(400),
  kind: z.string().trim().min(1).max(60).optional(),
});

export const habitEnabledSchema = z.object({
  file: z.enum(['explicit', 'inferred']),
  id: z.string().trim().min(1).max(60),
  enabled: z.boolean(),
});

export const weightsSchema = z
  .object({
    deadline: z.number().min(0).max(2).optional(),
    manual_priority: z.number().min(0).max(2).optional(),
    dependency: z.number().min(0).max(2).optional(),
    effort: z.number().min(0).max(2).optional(),
    habit_alignment: z.number().min(0).max(2).optional(),
    context_switch: z.number().min(0).max(2).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'At least one weight must be supplied');

// ── /api/settings/* ─────────────────────────────────────────────────────────
//
// 设置页的十几条写路由共享一套约定：
//   - 每个写 body 带 `expected_version`（对应那个文件的 `updated_at`），服务端
//     比对不符即 409。唯一的例外是 `/weights/preview`——它只读不写，拿版本号校验
//     只会制造虚假冲突。
//   - 两个耗时换算系数的范围与 `shared/duration.ts` 同源；天数额外要求整数。
//   - 约束的 kind：**新建**只接受三种 known kind，**PATCH** 不给就保留原值
//     （手改过的旧数据读得出来就必须改得了、不丢）。

/** 文件版本号就是 ISO 时间戳字符串，长度给足余量即可。 */
const expectedVersion = z.string().trim().min(1).max(80);

const settingsStatement = z.string().trim().min(1).max(400);
const settingsKind = z.string().trim().min(1).max(60);
const constraintValue = z.string().trim().max(200);

export const settingsConversionSchema = z
  .object({
    hours_per_day: z.number().min(HOURS_PER_DAY_MIN).max(HOURS_PER_DAY_MAX).optional(),
    // 半个工作日没有意义，所以这里比 duration-prefs 多一条整数要求。
    days_per_month: z
      .number()
      .int()
      .min(DAYS_PER_MONTH_MIN)
      .max(DAYS_PER_MONTH_MAX)
      .optional(),
    expected_version: expectedVersion,
  })
  .refine(
    (value) => value.hours_per_day !== undefined || value.days_per_month !== undefined,
    'hours_per_day 与 days_per_month 至少要提供一个',
  );

export const settingsVersionOnlySchema = z.object({ expected_version: expectedVersion });

export const settingsEnabledSchema = z.object({
  enabled: z.boolean(),
  expected_version: expectedVersion,
});

export const settingsConstraintCreateSchema = z.object({
  statement: settingsStatement,
  kind: z.enum(KNOWN_CONSTRAINT_KINDS),
  value: constraintValue,
  expected_version: expectedVersion,
});

export const settingsConstraintPatchSchema = z
  .object({
    statement: settingsStatement.optional(),
    // 开放字符串：原值可能是一种已不在 known 列表里的旧 kind，改别的字段时不该
    // 因为「顺手带上了原值」而被拒。
    kind: settingsKind.optional(),
    value: constraintValue.optional(),
    expected_version: expectedVersion,
  })
  .refine(
    (value) => Object.keys(value).some((key) => key !== 'expected_version'),
    '至少要提供一个要修改的字段',
  );

export const settingsExplicitCreateSchema = z.object({
  statement: settingsStatement,
  kind: settingsKind.optional(),
  expected_version: expectedVersion,
});

export const settingsExplicitPatchSchema = z
  .object({
    statement: settingsStatement.optional(),
    kind: settingsKind.optional(),
    expected_version: expectedVersion,
  })
  .refine(
    (value) => Object.keys(value).some((key) => key !== 'expected_version'),
    '至少要提供一个要修改的字段',
  );

/** adopt 是双资源写：inferred（标停用）与 explicit（插一条）两个版本都要比对。 */
export const settingsAdoptSchema = z.object({
  expected_version: expectedVersion,
  expected_explicit_version: expectedVersion,
});

/** 六项权重全给，各 0..2。界面是 0/1/2 三档，这里不强求整数以便留出余量。 */
const settingsWeightValues = z.object({
  deadline: z.number().min(0).max(2),
  manual_priority: z.number().min(0).max(2),
  dependency: z.number().min(0).max(2),
  effort: z.number().min(0).max(2),
  habit_alignment: z.number().min(0).max(2),
  context_switch: z.number().min(0).max(2),
});

const settingsWeightsDraft = {
  weights: settingsWeightValues,
  preferred_task_types: z.array(z.enum(TASK_TYPES)).max(TASK_TYPES.length).optional(),
  peak_hours: z.array(z.number().int().min(0).max(23)).max(24).optional(),
  task_type_peak_hours: z.partialRecord(z.enum(TASK_TYPES), z.array(z.number().int().min(0).max(23)).max(24)).optional(),
};

/** dry-run，所以**没有** `expected_version`：它不写任何东西。 */
export const settingsWeightsPreviewSchema = z.object(settingsWeightsDraft);

export const settingsWeightsSaveSchema = z.object({
  ...settingsWeightsDraft,
  expected_version: expectedVersion,
});

export const agentMessageSchema = z.object({
  intent: z.literal('goal_task_drafts').optional(),
  message: z.string().trim().min(1).max(1000),
  session_id: z.string().trim().max(60).nullish(),
  actor_id: z.string().trim().max(60).optional(),
  /**
   * 点选歧义候选/点推荐示例时回传的稳定 id。带上后按 id 精确命中，跳过标题模糊
   * 匹配——完全同名也能选中唯一那条。这些 id 只用于服务端定位，不回显到 UI。
   */
  target_task_id: z.string().trim().max(60).nullish(),
  target_goal_id: z.string().trim().max(60).nullish(),
  /**
   * `auto` 按运行时健康状况择一；`agent` 强制走模型（未就绪就报错而非悄悄降级）；
   * `command` 强制走规则解析器。
   */
  processing_mode: z.enum(['auto', 'agent', 'command']).optional(),
  /** 重试时带上被重试那条消息的 id，纯标记用途。 */
  retry_of: z.string().trim().max(60).nullish(),
  /**
   * **只有显式为 true**，agent 失败后才会回退到确定性解析。默认不回退：静默降级会
   * 让用户以为模型在工作。
   */
  fallback: z.boolean().optional(),
}).superRefine((value, ctx) => {
  if (value.intent === 'goal_task_drafts' && !value.target_goal_id?.trim()) {
    ctx.addIssue({ code: 'custom', path: ['target_goal_id'], message: '目标任务草稿必须指定所选目标。' });
  }
});

/** 模型建议预览的确认 / 取消。与 decomposition 的那套 token 互不相干。 */
export const agentPreviewConfirmSchema = z.object({
  token: z.string().trim().min(4).max(80),
  session_id: z.string().trim().max(60).nullish(),
  actor_id: z.string().trim().max(60).optional(),
});

export const agentPreviewCancelSchema = z.object({
  token: z.string().trim().min(4).max(80),
  session_id: z.string().trim().max(60).nullish(),
});

/**
 * 运行时配置的 PUT。只收可写字段——`schema_version`/`updated_at`/`history` 由服务端
 * 产生，客户端送来也不作数。
 *
 * `allowed_env_names` 是**名字**；任何环境变量的值都不会被接受，也不会被回显。
 */
export const agentRuntimeConfigPutSchema = z.object({
  config: z.object(agentRuntimeConfigDraft),
  expected_version: z.string().min(1).max(80),
});

/** Empty body checks the configured CLI; an explicit target checks a discovered provider without changing settings. */
export const agentRuntimeTestSchema = z.object({
  provider: z.enum(['claude', 'codex']).optional(),
  cli_path: z.string().trim().min(1).max(400).optional(),
}).strict().refine(value => Boolean(value.provider) === Boolean(value.cli_path), 'provider 与 cli_path 必须同时提供');

/**
 * 本地 CLI 自动检测。`provider` 缺省 = 两个都找。
 *
 * **没有「在哪找」这类参数**：搜索目录是服务端固定的白名单，不接受调用方指定路径或
 * basename——否则这条路由就变成了「让我 spawn 任意文件」。
 *
 * `persist` 是唯一的写入开关，默认 `false`（纯只读）。开启时 `expected_version` 必填：
 * 写回走的是和 `PUT` 同一套乐观并发，没有版本号就没法判断「我看到的还是最新的吗」，
 * 所以这里宁可 400，也不默认成「强行覆盖」。
 */
export const agentRuntimeDetectSchema = z
  .object({
    provider: z.enum(['claude', 'codex']).optional(),
    persist: z.boolean().optional().default(false),
    expected_version: z.string().trim().min(1).max(80).optional(),
  })
  .refine((d) => !d.persist || !!d.expected_version, {
    message: 'persist=true 时 expected_version 必填',
    path: ['expected_version'],
  });

export const agentCancelSchema = z.object({
  token: z.string().trim().min(4).max(80),
  session_id: z.string().trim().max(60).nullish(),
  actor_id: z.string().trim().max(60).optional(),
});

export const agentConfirmSchema = z.object({
  token: z.string().trim().min(4).max(80),
  session_id: z.string().trim().max(60).nullish(),
  actor_id: z.string().trim().max(60).optional(),
  /**
   * 助手面板里逐条勾选/编辑后的草稿：按下标回传，标题/描述为最终文本。
   * 不传则沿用预览里的全部草稿（与目标详情页同一套 accepted_drafts 约定）。
   */
  accepted_drafts: z
    .array(
      z.object({
        index: z.number().int().min(0),
        title,
        description: description.nullish(),
      }),
    )
    .max(20)
    .optional(),
});

/**
 * `GET /api/activity` filters. Every value is validated here before it reaches
 * SQL, and the repo binds them as parameters — no string interpolation.
 *
 * - `query`  free-text search over task / goal titles (falls back to summary),
 * - `type`   comma-separated `operation_type` whitelist,
 * - `from`/`to` inclusive `created_at` bounds (ISO-8601 or bare date),
 * - `limit`  page size, clamped to 1–500.
 */
export const activityQuerySchema = z.object({
  limit: z
    .string()
    .optional()
    .transform((value) => {
      const parsed = Number(value ?? 100);
      return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 500) : 100;
    }),
  query: z.string().trim().min(1).max(120).optional(),
  type: z.string().trim().min(1).max(200).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

// ── 复评（rescoring）────────────────────────────────────────────────────────
// 三条写路由的请求体 + 一条列表查询。这里只做形状与范围校验；
// 「两者至少给一个」「未请求的轴不许改分」这类语义规则留给 service 层去抛
// badRequest——它们依赖库里的快照，schema 看不到。

/**
 * 发起复评。`target_quadrant` 与 `changed_axes` 都是可选的：
 * 只给前者时由 `axesMismatchingQuadrant` 算出真正跨线的轴；两者都不给由
 * `createRescoringRequest` 拒绝（它才知道该如何解释这个错误）。
 */
export const createRescoringRequestSchema = z.object({
  target_quadrant: z.enum(QUADRANTS).optional(),
  changed_axes: z.array(z.enum(RESCORING_AXES)).min(1).max(2).optional(),
});

/**
 * 外部 Agent 的建议。两轴都是可选的——只该给被请求的那几根；给多了或给漏了都由
 * `mergeAgentScores` 按快照判定并拒绝。
 */
export const rescoringSubmitSchema = z.object({
  importance_score: matrixAxis.optional(),
  urgency_score: matrixAxis.optional(),
  reason: z.string().trim().min(4, '必须说明这次改分的依据').max(2000),
  confidence: z.number().min(0).max(1).nullish(),
  agent_name: z.string().trim().min(1, '复评建议必须署名给出判断的 Agent').max(120),
});

/** `GET /api/rescoring-requests?status=pending` 的查询串。 */
export const rescoringListQuerySchema = z.object({
  status: z.enum(RESCORING_STATUSES).optional(),
});
