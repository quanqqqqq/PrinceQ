/**
 * API contract shared by the local Node service (`server/`) and the web UI (`src/`).
 *
 * Type-only module on purpose: the server loads it through Node's native type
 * stripping (relative `../shared/types.ts` specifiers), the frontend through the
 * `@shared/*` Vite alias. Keep it free of runtime values so both sides agree.
 */

export const TASK_STATUSES = [
  'inbox',
  'claimed',
  'in_progress',
  'blocked',
  'completed',
  'archived',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Statuses that still represent work in the system (shown in matrix/queue views). */
export const ACTIVE_TASK_STATUSES = [
  'inbox',
  'claimed',
  'in_progress',
  'blocked',
] as const;

export const TASK_ACTIONS = [
  'claim',
  'release',
  'start',
  'block',
  'unblock',
  'complete',
  'archive',
  'restore',
  'reopen',
] as const;
export type TaskAction = (typeof TASK_ACTIONS)[number];

export const QUADRANTS = ['q1', 'q2', 'q3', 'q4'] as const;
export type Quadrant = (typeof QUADRANTS)[number];

export const QUADRANT_SOURCES = ['agent', 'user', 'rule', 'unset'] as const;
export type QuadrantSource = (typeof QUADRANT_SOURCES)[number];

/**
 * Provenance of the continuous 0..100 matrix scores.
 *
 * - `agent` — a real external Agent (loading the Skill) judged both axes.
 * - `user`  — the person supplied the numbers, or confirmed a quadrant.
 * - `rule`  — the local deterministic keyword rules in `server/domain/quadrant.ts`.
 *             This is NOT a model; it must never be labelled `agent`.
 * - `legacy`— converted from the old 1..5 integers, awaiting a real re-score.
 * - `unset` — no score yet.
 */
export const MATRIX_SCORE_SOURCES = ['agent', 'user', 'rule', 'legacy', 'unset'] as const;
export type MatrixScoreSource = (typeof MATRIX_SCORE_SOURCES)[number];

/** Scores at or above this value count as "high" on either axis. */
export const MATRIX_HIGH_THRESHOLD = 50;
export const MATRIX_SCORE_MIN = 0;
export const MATRIX_SCORE_MAX = 100;

/** Payload accepted by `POST /api/tasks/:id/matrix-score`. */
export interface MatrixScoreInput {
  importance_score: number;
  urgency_score: number;
  reason: string;
  source?: Extract<MatrixScoreSource, 'agent' | 'user'>;
  confidence?: number | null;
  expected_version?: number;
}

export const TASK_TYPES = [
  'deep_work',
  'shallow_work',
  'communication',
  'admin',
  'review',
  'learning',
] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const COGNITIVE_LOADS = ['low', 'medium', 'high'] as const;
export type CognitiveLoad = (typeof COGNITIVE_LOADS)[number];

/**
 * 耗时输入的单位。换算成 `estimated_minutes` 的规则与中文标签都在
 * `shared/duration.ts`——那里是运行时模块，这里只放枚举与类型。
 */
export const DURATION_UNITS = ['minute', 'day', 'month'] as const;
export type DurationUnit = (typeof DURATION_UNITS)[number];

export const ACTOR_KINDS = ['human', 'agent', 'automation'] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

export const GOAL_STATUSES = ['active', 'paused', 'achieved', 'dropped'] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

export interface Actor {
  id: string;
  kind: ActorKind;
  display_name: string;
  created_at: string;
}

export interface Goal {
  id: string;
  title: string;
  description: string | null;
  status: GoalStatus;
  target_date: string | null;
  color: string | null;
  is_demo: boolean;
  created_at: string;
  updated_at: string;
  version: number;
}

export interface GoalProgress {
  total: number;
  completed: number;
  in_flight: number;
  open: number;
  blocked?: number;
  /** 0..1 */
  ratio: number;
}

export interface GoalWithProgress extends Goal {
  progress: GoalProgress;
}

export interface TaskAssignment {
  id: string;
  task_id: string;
  actor_id: string;
  actor_name: string;
  claimed_at: string;
  released_at: string | null;
  release_reason: string | null;
}

export interface Task {
  id: string;
  title: string;
  description: string | null;
  goal_id: string | null;
  goal_title: string | null;
  status: TaskStatus;
  importance: number;
  urgency: number;
  quadrant: Quadrant | null;
  quadrant_source: QuadrantSource;
  quadrant_confidence: number | null;
  quadrant_reason: string | null;
  quadrant_confirmed: boolean;
  /** Continuous 0..100 axis scores (1 decimal). Null until scored. */
  matrix_importance_score: number | null;
  matrix_urgency_score: number | null;
  matrix_score_source: MatrixScoreSource;
  matrix_score_reason: string | null;
  matrix_score_confidence: number | null;
  matrix_score_version: number;
  matrix_scored_at: string | null;
  deadline: string | null;
  estimated_minutes: number | null;
  /**
   * 用户当初填的耗时数值与单位（如 `2` + `'day'`）。
   *
   * 只用于回显原单位；参与评分的事实一律是上面换算好的 `estimated_minutes`。
   * 旧任务（新增这两列之前创建的）这里是 null，前端按 minute 回退显示
   * `estimated_minutes`。
   */
  duration_value: number | null;
  duration_unit: DurationUnit | null;
  cognitive_load: CognitiveLoad | null;
  task_type: TaskType | null;
  manual_priority: number;
  manual_override: number;
  blocked_reason: string | null;
  is_demo: boolean;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  version: number;
  /** Current unreleased claim, when the task is claimed/in_progress/blocked. */
  active_assignment: TaskAssignment | null;
  /** Task ids this task depends on. */
  depends_on: string[];
  /** Task ids waiting on this task. */
  blocks: string[];
  /** True when every dependency is completed/archived. */
  dependency_ready: boolean;
  queue_position: number | null;
  queue_score: number | null;
}

export interface ScoreFactor {
  key: string;
  label: string;
  /** Normalised factor value, 0..1 (may be negative for penalties). */
  value: number;
  weight: number;
  /** value * weight * 100, rounded to 2 decimals. */
  contribution: number;
  detail: string;
}

export interface ScoreBreakdown {
  task_id: string;
  score: number;
  factors: ScoreFactor[];
  notes: string[];
  computed_at: string;
}

export interface QueueEntry {
  position: number;
  score: number;
  task: Task;
  breakdown: ScoreBreakdown;
}

export interface QueueSnapshot {
  id: string;
  created_at: string;
  reason: string;
  algorithm_version: string;
  entry_count: number;
}

export interface QueueResponse {
  snapshot: QueueSnapshot;
  entries: QueueEntry[];
}

export interface OperationRecord {
  id: string;
  idempotency_key: string;
  operation_type: string;
  target_type: string;
  target_id: string | null;
  actor_id: string;
  actor_name: string;
  status: 'succeeded' | 'failed';
  summary: string;
  detail: Record<string, unknown> | null;
  replayed: boolean;
  created_at: string;
}

export interface ActivityResponse {
  operations: OperationRecord[];
  snapshots: QueueSnapshot[];
}

export const HABIT_FILES = ['explicit', 'inferred', 'constraints', 'weights'] as const;
export type HabitFileName = (typeof HABIT_FILES)[number];

export interface HabitEntry {
  id: string;
  statement: string;
  kind: string;
  enabled: boolean;
  confidence: number | null;
  source: string;
  /**
   * 来源关联，目前只有「采纳自某条推断习惯」一种：
   * `{ type: 'adopted_from_inferred', inferred_id }`。
   *
   * 刻意留成 `unknown`：这是给界面展示与溯源用的透传字段，排序一个字节都不读，
   * 把结构写死在类型里只会让以后新增一种来源变成破坏性改动。
   */
  source_relation?: unknown;
  created_at: string;
  updated_at: string;
}

export interface HabitFile<T> {
  schema_version: number;
  updated_at: string;
  payload: T;
  history: HabitHistoryItem[];
}

export interface HabitHistoryItem {
  at: string;
  actor: string;
  change: string;
}

export interface ScoringWeights {
  deadline: number;
  manual_priority: number;
  dependency: number;
  effort: number;
  habit_alignment: number;
  context_switch: number;
}

/** 三种已知的硬约束 kind。新建时只接受这三种；读取时放开（见下）。 */
export const KNOWN_CONSTRAINT_KINDS = [
  'forbidden_window',
  'max_daily_minutes',
  'required_buffer',
] as const;
export type KnownConstraintKind = (typeof KNOWN_CONSTRAINT_KINDS)[number];

export interface HabitConstraint {
  id: string;
  statement: string;
  /**
   * 读取时是开放的字符串，不是三种 known kind 的枚举。
   *
   * `habits/constraints.json` 是用户可以手改的本地文件，历史上也可能存过别的
   * kind。把读取收紧成枚举会让整份文件直接校验失败——一条不认识的旧约束会连带
   * 让设置页打不开、PATCH 时把它丢掉。新建/校验仍只接受
   * `KNOWN_CONSTRAINT_KINDS`，PATCH 不给 kind 时原值保留。
   */
  kind: string;
  enabled: boolean;
  value: string;
  /** 条目级更新时间。旧数据没有这个键，读出来就是 undefined。 */
  updated_at?: string;
}

export interface HabitsResponse {
  explicit: HabitFile<{ entries: HabitEntry[] }>;
  inferred: HabitFile<{ entries: HabitEntry[] }>;
  constraints: HabitFile<{ entries: HabitConstraint[] }>;
  /**
   * `hours_per_day` / `days_per_month` 是耗时单位换算的个人习惯配置：
   * 天 → 分钟按前者，月 → 天按后者。旧的 weights.json 没有这两个键，读取时由
   * zod 自动补默认值（8 小时/天、20 天/月），不报错。
   */
  weights: HabitFile<{
    weights: ScoringWeights;
    preferred_task_types: TaskType[];
    peak_hours: number[];
    task_type_peak_hours?: Partial<Record<TaskType, number[]>>;
    hours_per_day: number;
    days_per_month: number;
  }>;
}

// ── /api/settings/* 的快照形状 ───────────────────────────────────────────────
// 设置页只吃这一个形状：四个文件被摊平成「四个版本号 + 四类数据」，`weights.json`
// 里的两个换算系数被提到顶层 `conversion`，因为它们只影响耗时折算、与排序权重无
// 关，混在一起会让界面把两件事当成一件。

/**
 * 四个设置文件各自的 `updated_at`。
 *
 * 写操作必须带上对应那一项作为 `expected_version`，服务端比对不符即 409
 * ——文件各自独立，所以版本也是四个而不是一个全局号。
 */
export interface SettingsVersions {
  explicit: string;
  constraints: string;
  inferred: string;
  weights: string;
}

/** 排序偏好三件套，同住 `weights.json`，由权重区块整份提交。 */
export interface SettingsWeightsPayload {
  weights: ScoringWeights;
  preferred_task_types: TaskType[];
  peak_hours: number[];
  task_type_peak_hours?: Partial<Record<TaskType, number[]>>;
}

/** 明确/推断习惯的快照条目：去掉 `created_at`，补上条目级 `updated_at`。 */
export interface SettingsHabitEntry {
  id: string;
  statement: string;
  kind: string;
  enabled: boolean;
  confidence: number | null;
  source: string;
  source_relation?: unknown;
  updated_at?: string;
}

export interface SettingsSnapshot {
  versions: SettingsVersions;
  weights: SettingsWeightsPayload;
  conversion: DurationConfigShape;
  explicit: SettingsHabitEntry[];
  inferred: SettingsHabitEntry[];
  constraints: HabitConstraint[];
}

/**
 * `shared/duration.ts` 的 `DurationConfig` 的纯类型镜像。
 *
 * 本文件是纯类型模块（不含任何运行时值），而 `shared/duration.ts` 是运行时值
 * 模块，从这里 import 它会把换算常量拖进每个只要类型的消费者。两个键的范围由
 * 那边的常量单独约束。
 */
export interface DurationConfigShape {
  hours_per_day: number;
  days_per_month: number;
}

export interface QuadrantSuggestion {
  quadrant: Quadrant;
  importance: number;
  urgency: number;
  /** The same judgement on the continuous 0..100 axes. */
  importance_score: number;
  urgency_score: number;
  confidence: number;
  reason: string;
  signals: string[];
}

/**
 * UX-22：草稿与目标下某个已有任务疑似重复时的提示。
 *
 * 只在「已有任务尚未完成」时出现——已完成的同名任务不会生成草稿，所以这里永远
 * 不会带 completed 状态。
 */
export interface DecompositionDraftDuplicate {
  existing_title: string;
  existing_status: string;
  reason: string;
}

export interface DecompositionDraft {
  title: string;
  description: string;
  estimated_minutes: number;
  task_type: TaskType;
  cognitive_load: CognitiveLoad;
  deadline: string | null;
  suggestion: QuadrantSuggestion;
  /** UX-22：命中已有关联任务时的重复提示；无重复时缺省或为 null。 */
  duplicate?: DecompositionDraftDuplicate | null;
}

export interface DecompositionPreview {
  goal_id: string;
  goal_title: string;
  preview_token: string;
  drafts: DecompositionDraft[];
  notes: string[];
}

export const AGENT_MESSAGE_ROLES = ['user', 'agent'] as const;
export type AgentMessageRole = (typeof AGENT_MESSAGE_ROLES)[number];

export const AGENT_RESULT_KINDS = [
  'applied',
  'preview',
  'clarification',
  'answer',
  'error',
] as const;
export type AgentResultKind = (typeof AGENT_RESULT_KINDS)[number];

export interface AgentPendingAction {
  token: string;
  command: string;
  summary: string;
  affected_task_ids: string[];
}

export interface AgentWarning {
  code: 'model_config_warning' | 'nonzero_exit' | 'cli_warning';
  message: string;
}

/** Structured, Perplexity-style result block rendered by the agent panel. */
export interface AgentResult {
  kind: AgentResultKind;
  headline: string;
  /** Complete model answer, retained across session restoration. */
  answer?: string;
  warnings?: AgentWarning[];
  provider?: AgentRuntimeProvider | null;
  reasoning: string[];
  /** Named sections of rendered detail, e.g. queue rows or a draft preview. */
  blocks: AgentResultBlock[];
  pending_action: AgentPendingAction | null;
  /** Which local deterministic command was matched. */
  matched_command: string | null;
  /**
   * `deterministic-local` 是规则解析器的回答；`agent` 表示由本地 CLI 模型生成。
   * 两者的写入权限完全一样——`agent` 的写意图只能是待确认预览。
   */
  mode: 'deterministic-local' | 'agent';
}

/**
 * 同名任务的候选。只展示标题/目标/状态/截止；`task_id` 是点选后回传服务器的稳定
 * 绑定（前端藏在按钮里，绝不渲染/复制给用户），`select_message` 是给人看的那句
 * 重发指令。完全同名的任务也能靠这个 id 精确选中，不会再次歧义。
 */
export interface TaskCandidate {
  title: string;
  goal_title: string | null;
  status: TaskStatus;
  deadline: string | null;
  task_id: string;
  select_message: string;
}

/** 同名目标的候选，同上：点选回传 goal_id 精确选中，前端不展示 id。 */
export interface GoalCandidate {
  title: string;
  status: GoalStatus;
  target_date: string | null;
  goal_id: string;
  select_message: string;
}

/** 助手面板里可勾选/编辑的目标拆分草稿（与 GoalsPage 的预览同源）。 */
export interface AgentDecompositionPreview {
  goal_title: string;
  drafts: DecompositionDraft[];
  notes: string[];
}

export type AgentResultBlock =
  | { type: 'facts'; title: string; items: { label: string; value: string }[] }
  | { type: 'list'; title: string; items: string[] }
  | { type: 'tasks'; title: string; task_ids: string[] }
  | { type: 'score'; title: string; breakdown: ScoreBreakdown }
  | { type: 'task_candidates'; title: string; candidates: TaskCandidate[] }
  | { type: 'goal_candidates'; title: string; candidates: GoalCandidate[] }
  | { type: 'decomposition_preview'; title: string; preview: AgentDecompositionPreview };

export interface AgentMessage {
  id: string;
  session_id: string;
  role: AgentMessageRole;
  content: string;
  result: AgentResult | null;
  created_at: string;
}

export interface AgentSession {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  message_count: number;
  last_message?: string;
}

export interface AgentMessageResponse {
  session: AgentSession;
  /** The persisted user message followed by the agent reply. */
  messages: AgentMessage[];
  result: AgentResult;
  /** Set when the command mutated state, so the UI knows what to refetch. */
  invalidates: ('tasks' | 'goals' | 'queue' | 'activity' | 'habits')[];
  /**
   * 以下字段都是**可选**的后端契约扩展：旧前端完全不读它们也能正常工作。
   *
   * `source` 比 `mode` 更细，用来回答「这条回答到底是谁给的」：
   * - `agent`：本地 CLI 模型正常回答
   * - `deterministic-local`：按预期走了规则解析器（未配置 / 用户选了命令模式）
   * - `deterministic-local-fallback`：agent 失败后，**且请求显式要求回退**才会出现
   * - `agent-error`：agent 失败且没有回退，用户需要重试或改模式
   */
  mode?: 'agent' | 'deterministic-local';
  provider?: AgentRuntimeProvider | null;
  source?: 'agent' | 'deterministic-local' | 'deterministic-local-fallback' | 'agent-error';
  fallback_reason?: string | null;
  /** 出错时给用户的下一步选项，如 `retry_agent` / `process_with_command_mode`。 */
  available_actions?: string[];
}

// ── 本地 CLI Agent 运行时 ─────────────────────────────────────────────────────
// 配置文件里**只存环境变量名，绝不存值**，所以这些类型可以安全地直接回显给界面。

export type AgentRuntimeProvider = 'claude' | 'codex';

/** `config/agent-runtime.json` 的形状。GET / PUT 共用。 */
export interface AgentRuntimeConfig {
  schema_version: 1;
  enabled: boolean;
  provider: AgentRuntimeProvider;
  cli_path: string;
  model: string | null;
  args: string[];
  timeout_ms: number;
  /** 必须位于项目目录内——这是模型被启动时的沙箱边界。 */
  working_directory: string;
  /** 允许透传给子进程的环境变量**名字**，不含值。 */
  allowed_env_names: string[];
  /**
   * 每个字段的值是「自动检测来的」还是「用户手动填的」。**可选**：旧配置文件没有
   * 这一项，读回来会兜底成 `{}`。
   *
   * 这是「重检不抢手动值」的唯一依据——标成 `manual` 的字段，重新检测后不被覆盖。
   * 合并由前端做：`POST /api/agent/runtime-detect` 只返回建议，后端不自动写回。
   */
  field_sources?: Record<string, 'auto' | 'manual'>;
  /**
   * 最近一次检测的快照（候选摘要 + 推荐路径 + 检测时间）。**可选**，旧配置兜底 null。
   *
   * 故意是宽松类型：它纯粹是给界面回显「上次检测看到了什么」的，形状跟着
   * `RuntimeDetectResponse` 演进，不该让一次字段增减把整份配置判成不合法。
   */
  detected?: unknown | null;
  updated_at: string;
  history: { at: string; change: string }[];
}

/** GET/PUT 响应里的配置视图，与 `AgentRuntimeConfig` 同形。 */
export type AgentRuntimeConfigView = AgentRuntimeConfig;

export interface AgentRuntimeStatusView {
  configured: boolean;
  enabled: boolean;
  provider: AgentRuntimeProvider | null;
  health: { ok: boolean; reason: string | null; checked_at: string | null };
  effective_mode: 'agent' | 'deterministic-local';
  /** Last actual model check; separate from the inexpensive CLI installation check. */
  connection?: {ok: boolean; checked_at: string; reason: string | null; status?: string} | null;
  /** 后台常驻 agent 尚未实现；这里固定如此上报，不假装支持。 */
  background: { implemented: false; status: 'not_implemented' };
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface HealthResponse {
  status: 'ok';
  mode: 'deterministic-local';
  database: string;
  algorithm_version: string;
  now: string;
  counts: { goals: number; tasks: number; operations: number };
}

// ── 复评（rescoring）──────────────────────────────────────────────────────────
// 请求 → 真实 Agent 建议 → 用户确认，三步各自是一个独立事件。这里只是契约，
// 落库规则见 `server/repo/rescoring-service.ts`；**没有任何一处会生成分数**。

/** 一次复评可以请求重评的轴。与 `server/domain/rescoring.ts` 的同名类型同构。 */
export const RESCORING_AXES = ['importance', 'urgency'] as const;
export type RescoringAxis = (typeof RESCORING_AXES)[number];

export const RESCORING_STATUSES = ['pending', 'awaiting_confirm', 'done', 'cancelled'] as const;
export type RescoringStatus = (typeof RESCORING_STATUSES)[number];

/**
 * 一条复评请求对外的形状。
 *
 * `before_*` 是请求创建那一刻的快照，`after_*` 是 Agent 建议合并后的结果——两者
 * 分开存，界面才能逐轴显示「30 → 72」，并把未请求的轴标成「原样保留」。
 * `pending` 阶段 `after_*` 必然为 `null`：那时还没有任何真实建议。
 */
export interface RescoringRequestRecord {
  id: string;
  task_id: string;
  status: RescoringStatus;
  /** 用户当初想拖到的象限；派生象限仍由确认时的两轴分数算出，不从它反推。 */
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
  created_at: string;
  submitted_at: string | null;
  decided_at: string | null;
}

/** 交给外部 Agent 的上下文：全部是读出来的事实，没有一处是生成的判断。 */
export interface RescoringContextRecord {
  task: Task;
  goal_title: string | null;
  depends_on: { id: string; title: string; status: string }[];
  habits_summary: string;
}

/** 列表/创建返回里每条请求可以附带它的上下文，省掉前端再发一次请求。 */
export type RescoringRequestWithContext = RescoringRequestRecord & {
  context?: RescoringContextRecord | null;
};

/** `POST /api/tasks/:id/rescoring-request` 的请求体。 */
export interface CreateRescoringRequestBody {
  target_quadrant?: Quadrant;
  changed_axes?: RescoringAxis[];
}

/** `POST /api/rescoring-requests/:id/submit` 的请求体——只有真实 Agent 调用它。 */
export interface RescoringSubmitBody {
  importance_score?: number;
  urgency_score?: number;
  reason: string;
  confidence?: number | null;
  agent_name: string;
}
