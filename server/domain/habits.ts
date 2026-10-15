import {writeFileAtomically} from '../lib/atomic-file.ts';
/**
 * Habit files live in `habits/` inside the repository so the Skill/Agent can read
 * them directly on every call. Four separate concerns, four files:
 *
 *   explicit.json    — habits the user stated outright
 *   inferred.json    — habits derived from observed behaviour (carry confidence)
 *   constraints.json — hard constraints that must not be violated
 *   weights.json     — queue scoring weights + preferences
 *
 * Writes are validated with zod, carry a schema version and an append-only
 * history, and land via atomic rename (write temp → fsync → rename).
 */
import {usableObservation} from '../../shared/habit-inference.ts';
import {inferenceConnection} from '../agent/habit-inference-availability.ts';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { TASK_TYPES } from '../../shared/types.ts';
import type {
  HabitConstraint,
  HabitEntry,
  HabitFile,
  HabitFileName,
  HabitsResponse,
  ScoringWeights,
  SettingsHabitEntry,
  SettingsSnapshot,
  SettingsWeightsPayload,
  TaskType,
} from '../../shared/types.ts';
import {
  DAYS_PER_MONTH_MAX,
  DAYS_PER_MONTH_MIN,
  DEFAULT_DAYS_PER_MONTH,
  DEFAULT_HOURS_PER_DAY,
  HOURS_PER_DAY_MAX,
  HOURS_PER_DAY_MIN,
  type DurationConfig,
} from '../../shared/duration.ts';
import { HABITS_DIR } from '../config.ts';
import { badRequest, notFound, versionConflict } from '../lib/errors.ts';
import { newId, nowIso } from '../lib/ids.ts';

export const HABIT_SCHEMA_VERSION = 1;

const historyItemSchema = z.object({
  at: z.string(),
  actor: z.string(),
  change: z.string(),
});

const habitEntrySchema = z.object({
  id: z.string(),
  statement: z.string().min(1).max(400),
  kind: z.string().min(1).max(60),
  enabled: z.boolean(),
  confidence: z.number().min(0).max(1).nullable(),
  source: z.string().min(1).max(60),
  /**
   * 采纳来源的透传字段（`{type:'adopted_from_inferred', inferred_id}`）。
   *
   * `unknown().optional()` 而不是写死结构：它只被界面展示与溯源读，排序不碰；
   * 收紧成具体对象会让以后新增一种来源变成破坏性改动，也会让一份手改过这个字段
   * 的旧文件整体校验失败。
   */
  source_relation: z.unknown().optional(),
  created_at: z.string(),
  updated_at: z.string(),
});

/**
 * 硬约束条目。
 *
 * `kind` 刻意是开放字符串而非三种 known kind 的枚举（与 explicit/inferred 一致）：
 * `habits/constraints.json` 是用户能手改的本地文件，历史上也可能存过别的 kind。
 * 把**读取**收紧成枚举，一条不认识的旧约束就会让整份文件校验失败——设置页打不开，
 * PATCH 时还会把它丢掉。新建与显式校验仍只接受 `KNOWN_CONSTRAINT_KINDS`
 * （见 `server/http/schemas.ts`），PATCH 不给 kind 时保留原值。
 */
const constraintSchema = z.object({
  id: z.string(),
  statement: z.string().min(1).max(400),
  kind: z.string().min(1).max(60),
  enabled: z.boolean(),
  value: z.string().max(200),
  /** 旧数据没有这个键，所以是可选的；之后每次写都会补上。 */
  updated_at: z.string().optional(),
});

const weightsSchema = z.object({
  deadline: z.number().min(0).max(2),
  manual_priority: z.number().min(0).max(2),
  dependency: z.number().min(0).max(2),
  effort: z.number().min(0).max(2),
  habit_alignment: z.number().min(0).max(2),
  context_switch: z.number().min(0).max(2),
});

const fileEnvelope = <T extends z.ZodTypeAny>(payload: T) =>
  z.object({
    schema_version: z.number().int().positive(),
    updated_at: z.string(),
    payload,
    history: z.array(historyItemSchema).max(200),
  });

const entriesPayload = z.object({ entries: z.array(habitEntrySchema) });
const constraintsPayload = z.object({ entries: z.array(constraintSchema) });

/**
 * 耗时单位换算的两个个人习惯键。
 *
 * 都带 `.default(...)`，所以**旧的 `habits/weights.json`（没有这两个键）照旧能读**
 * ——zod 在解析时自动补上 8 小时/天、20 天/月，不会报校验错。范围见
 * `shared/duration.ts`：hours_per_day ∈ [0.5, 24]，days_per_month ∈ [1, 31]。
 */
const hoursPerDaySchema = z
  .number()
  .min(HOURS_PER_DAY_MIN)
  .max(HOURS_PER_DAY_MAX)
  .default(DEFAULT_HOURS_PER_DAY);
const daysPerMonthSchema = z
  .number()
  .min(DAYS_PER_MONTH_MIN)
  .max(DAYS_PER_MONTH_MAX)
  .default(DEFAULT_DAYS_PER_MONTH);

const weightsPayload = z.object({
  weights: weightsSchema,
  preferred_task_types: z.array(
    z.enum(['deep_work', 'shallow_work', 'communication', 'admin', 'review', 'learning']),
  ),
  peak_hours: z.array(z.number().int().min(0).max(23)).max(24),
  task_type_peak_hours: z.partialRecord(z.enum(TASK_TYPES), z.array(z.number().int().min(0).max(23)).max(24)).default({}),
  hours_per_day: hoursPerDaySchema,
  days_per_month: daysPerMonthSchema,
});

const SCHEMAS = {
  explicit: fileEnvelope(entriesPayload),
  inferred: fileEnvelope(entriesPayload),
  constraints: fileEnvelope(constraintsPayload),
  weights: fileEnvelope(weightsPayload),
} as const;

export const DEFAULT_WEIGHTS: ScoringWeights = {
  deadline: 1,
  manual_priority: 1,
  dependency: 1,
  effort: 1,
  habit_alignment: 1,
  context_switch: 1,
};

const filePath = (name: HabitFileName): string => path.join(HABITS_DIR, `${name}.json`);

function defaults(name: HabitFileName): unknown {
  const base = { schema_version: HABIT_SCHEMA_VERSION, updated_at: nowIso(), history: [] };
  switch (name) {
    case 'explicit':
    case 'inferred':
      return { ...base, payload: { entries: [] } };
    case 'constraints':
      return { ...base, payload: { entries: [] } };
    case 'weights':
      return {
        ...base,
        payload: {
          weights: { ...DEFAULT_WEIGHTS },
          preferred_task_types: ['deep_work'],
          peak_hours: [9, 10, 11],
          hours_per_day: DEFAULT_HOURS_PER_DAY,
          days_per_month: DEFAULT_DAYS_PER_MONTH,
        },
      };
  }
}

/** Reads and validates one habit file, falling back to defaults when absent. */
export function readHabitFile<N extends HabitFileName>(
  name: N,
): z.infer<(typeof SCHEMAS)[N]> {
  const target = filePath(name);
  let raw: unknown;
  if (!fs.existsSync(target)) {
    raw = defaults(name);
  } else {
    try {
      raw = JSON.parse(fs.readFileSync(target, 'utf8'));
    } catch (error) {
      throw badRequest(`habits/${name}.json is not valid JSON: ${(error as Error).message}`);
    }
  }
  const parsed = SCHEMAS[name].safeParse(raw);
  if (!parsed.success) {
    throw badRequest(`habits/${name}.json failed validation`, parsed.error.issues);
  }
  return parsed.data as z.infer<(typeof SCHEMAS)[N]>;
}

/** Validate-then-atomically-replace. Never leaves a half-written habit file. */
export function writeHabitFile<N extends HabitFileName>(
  name: N,
  next: unknown,
): z.infer<(typeof SCHEMAS)[N]> {
  const parsed = SCHEMAS[name].safeParse(next);
  if (!parsed.success) {
    throw badRequest(`Refusing to write habits/${name}.json — invalid payload`, parsed.error.issues);
  }
  writeFileAtomically(filePath(name), `${JSON.stringify(parsed.data, null, 2)}\n`);
  return parsed.data as z.infer<(typeof SCHEMAS)[N]>;
}

/** Full habit set; the Skill/Agent reads this on every call. */
export function readAllHabits(): HabitsResponse {
  return {
    explicit: readHabitFile('explicit') as HabitFile<{ entries: HabitEntry[] }>,
    inferred: readHabitFile('inferred') as HabitFile<{ entries: HabitEntry[] }>,
    constraints: readHabitFile('constraints') as HabitFile<{ entries: HabitConstraint[] }>,
    weights: readHabitFile('weights') as HabitsResponse['weights'],
  };
}

export interface HabitContext {
  weights: ScoringWeights;
  preferredTaskTypes: TaskType[];
  peakHours: number[];
  peakHoursByTaskType?: Partial<Record<TaskType, number[]>>;
  explicit: HabitEntry[];
  inferred: HabitEntry[];
  constraints: HabitConstraint[];
}

/** Flattened view used by the queue scorer. Enabled entries only. */
export function loadHabitContext(): HabitContext {
  const habits = readAllHabits();
  return {
    weights: habits.weights.payload.weights,
    preferredTaskTypes: habits.weights.payload.preferred_task_types,
    peakHours: habits.weights.payload.peak_hours,
    peakHoursByTaskType: habits.weights.payload.task_type_peak_hours,
    explicit: habits.explicit.payload.entries.filter((e) => e.enabled),
    inferred: inferenceConnection().connected ? habits.inferred.payload.entries.filter((e) => e.enabled && usableObservation(e)) : [],
    constraints: habits.constraints.payload.entries.filter((e) => e.enabled),
  };
}

const appendHistory = <T extends { history: { at: string; actor: string; change: string }[] }>(
  file: T,
  actor: string,
  change: string,
): T => ({
  ...file,
  updated_at: nowIso(),
  // Newest first, capped at the schema's 200-entry ceiling.
  history: [{ at: nowIso(), actor, change }, ...file.history].slice(0, 200),
});

export function addExplicitHabit(
  input: { statement: string; kind?: string; source?: string },
  actor: string,
): HabitEntry {
  const file = readHabitFile('explicit');
  const entry: HabitEntry = {
    id: newId('habit'),
    statement: input.statement.trim(),
    kind: input.kind ?? 'preference',
    enabled: true,
    confidence: null,
    source: input.source ?? 'user',
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  writeHabitFile(
    'explicit',
    appendHistory(
      { ...file, payload: { entries: [...file.payload.entries, entry] } },
      actor,
      `added explicit habit "${entry.statement}"`,
    ),
  );
  return entry;
}

export function setHabitEnabled(
  name: 'explicit' | 'inferred',
  id: string,
  enabled: boolean,
  actor: string,
): HabitEntry {
  const file = readHabitFile(name);
  const existing = file.payload.entries.find((e) => e.id === id);
  if (!existing) {
    throw notFound(`No ${name} habit with id "${id}".`);
  }
  const updated: HabitEntry = {
    ...existing,
    confidence: existing.confidence ?? null,
    enabled,
    updated_at: nowIso(),
  };
  writeHabitFile(
    name,
    appendHistory(
      {
        ...file,
        payload: { entries: file.payload.entries.map((e) => (e.id === id ? updated : e)) },
      },
      actor,
      `${enabled ? 'enabled' : 'disabled'} ${name} habit "${existing.statement}"`,
    ),
  );
  return updated;
}

export function updateWeights(partial: Partial<ScoringWeights>, actor: string): ScoringWeights {
  const file = readHabitFile('weights');
  const next = { ...file.payload.weights, ...partial };
  const parsed = weightsSchema.safeParse(next);
  if (!parsed.success) {
    throw badRequest('Invalid scoring weights', parsed.error.issues);
  }
  writeHabitFile(
    'weights',
    appendHistory(
      { ...file, payload: { ...file.payload, weights: parsed.data } },
      actor,
      `updated scoring weights: ${Object.keys(partial).join(', ')}`,
    ),
  );
  return parsed.data;
}

/**
 * 当前的耗时换算配置。
 *
 * **每次调用都重新读文件，绝不缓存**：用户随时可以改 `habits/weights.json`
 * （界面、Skill、甚至手改），而每一次新建/更新任务都必须按最新配置折算分钟数，
 * 否则同一个「2 天」会因为进程启动时机不同落出不同的 `estimated_minutes`。
 */
export function loadDurationConfig(): DurationConfig {
  const file = readHabitFile('weights');
  return {
    hours_per_day: file.payload.hours_per_day,
    days_per_month: file.payload.days_per_month,
  };
}

/**
 * 改耗时换算偏好（每天小时数 / 每月工作天数）。
 *
 * 读最新文件 → 合并传入的那几个键 → 校验范围 → 追加一条 history → 原子写回。
 * 只影响**之后**的换算：已落库的 `estimated_minutes` 是当时的事实，不回算、不批改。
 */
export function updateDurationPrefs(
  input: { hours_per_day?: number; days_per_month?: number },
  actor: string,
): DurationConfig {
  const file = readHabitFile('weights');
  const next: DurationConfig = {
    hours_per_day: input.hours_per_day ?? file.payload.hours_per_day,
    days_per_month: input.days_per_month ?? file.payload.days_per_month,
  };
  const parsed = z
    .object({ hours_per_day: hoursPerDaySchema, days_per_month: daysPerMonthSchema })
    .safeParse(next);
  if (!parsed.success) {
    throw badRequest('耗时换算配置超出合理范围', parsed.error.issues);
  }

  const changed = Object.keys(input).filter(
    (key) => input[key as keyof typeof input] !== undefined,
  );
  writeHabitFile(
    'weights',
    appendHistory(
      { ...file, payload: { ...file.payload, ...parsed.data } },
      actor,
      `更新耗时换算配置（${changed.join('、')}）：` +
        `${parsed.data.hours_per_day} 小时/天、${parsed.data.days_per_month} 天/月`,
    ),
  );
  return parsed.data;
}

/** Creates the four habit files if they are missing (used by db:setup). */export function ensureHabitFiles(): HabitFileName[] {
  const created: HabitFileName[] = [];
  for (const name of ['explicit', 'inferred', 'constraints', 'weights'] as const) {
    if (!fs.existsSync(filePath(name))) {
      writeHabitFile(name, defaults(name));
      created.push(name);
    }
  }
  return created;
}

// ── 设置页的统一读写面（/api/settings/*）────────────────────────────────────────
//
// 四个习惯文件在界面上是**一页**设置，所以这里把它们摊平成一个快照：四个版本号
// （各文件的 `updated_at`）+ 四类数据。两个耗时换算系数住在 `weights.json` 的
// payload 里，但语义上与排序权重无关，所以提到快照顶层的 `conversion`——混在
// `weights` 里会让界面把「折算系数」和「排序偏好」当成一回事。
//
// 每个写操作都走「读文件 → 比版本 → 改 payload → appendHistory → 原子写回 →
// 回最新快照」这一条路，版本校验是其中不可跳过的一步（见 `assertSettingsVersion`）。

/** 条目的展示投影：去掉 `created_at`，保留界面会读的那几个键。 */
const toSettingsEntry = (entry: HabitEntry): SettingsHabitEntry => ({
  id: entry.id,
  statement: entry.statement,
  kind: entry.kind,
  enabled: entry.enabled,
  confidence: entry.confidence ?? null,
  source: entry.source,
  ...(entry.source_relation === undefined ? {} : { source_relation: entry.source_relation }),
  updated_at: entry.updated_at,
});

/**
 * 当前完整快照。四个文件各读一次，不缓存——用户/Skill 随时可能在别处改写。
 */
export function buildSettingsSnapshot(): SettingsSnapshot {
  const explicit = readHabitFile('explicit');
  const inferred = readHabitFile('inferred');
  const constraints = readHabitFile('constraints');
  const weights = readHabitFile('weights');

  return {
    versions: {
      explicit: explicit.updated_at,
      constraints: constraints.updated_at,
      inferred: inferred.updated_at,
      weights: weights.updated_at,
    },
    weights: {
      weights: weights.payload.weights,
      preferred_task_types: weights.payload.preferred_task_types,
      peak_hours: weights.payload.peak_hours,
      task_type_peak_hours: weights.payload.task_type_peak_hours,
    },
    conversion: {
      hours_per_day: weights.payload.hours_per_day,
      days_per_month: weights.payload.days_per_month,
    },
    explicit: explicit.payload.entries.map(toSettingsEntry),
    inferred: inferred.payload.entries.map(toSettingsEntry),
    constraints: constraints.payload.entries as HabitConstraint[],
  };
}

/**
 * 乐观并发检查：客户端的 `expected_version` 必须等于该文件当前的 `updated_at`。
 *
 * 不符就抛 409，错误体里带上当前完整快照，客户端直接替换本地状态即可。因为
 * **先抛错再改任何东西**，一次失败的校验不会留下半截写入。
 */
export function assertSettingsVersion(name: HabitFileName, expected: string): void {
  if (readHabitFile(name).updated_at !== expected) {
    throw versionConflict(buildSettingsSnapshot());
  }
}

/** 一次写操作的返回：最新快照 + 一句中文摘要，摘要进操作日志。 */
export interface SettingsWriteResult {
  snapshot: SettingsSnapshot;
  summary: string;
  /** 被改动的那条记录的 id（权重/换算这类整体配置给 `weights`）。 */
  target_id: string;
}

/** 按 id 找一条，找不到就 404——绝不静默忽略一个不存在的目标。 */
function requireEntry<T extends { id: string }>(entries: T[], id: string, label: string): T {
  const found = entries.find((entry) => entry.id === id);
  if (!found) throw notFound(`没有 id 为 "${id}" 的${label}。`);
  return found;
}

// ── explicit ────────────────────────────────────────────────────────────────

export function createSettingsExplicit(
  input: { statement: string; kind?: string; expected_version: string },
  actor: string,
): SettingsWriteResult {
  assertSettingsVersion('explicit', input.expected_version);
  const file = readHabitFile('explicit');
  const entry: HabitEntry = {
    id: newId('habit'),
    statement: input.statement.trim(),
    kind: input.kind ?? 'preference',
    enabled: true,
    confidence: null,
    source: 'user',
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  writeHabitFile(
    'explicit',
    appendHistory(
      { ...file, payload: { entries: [...file.payload.entries, entry] } },
      actor,
      `新增明确习惯「${entry.statement}」`,
    ),
  );
  return {
    snapshot: buildSettingsSnapshot(),
    summary: `新增明确习惯「${entry.statement}」`,
    target_id: entry.id,
  };
}

export function updateSettingsExplicit(
  id: string,
  input: { statement?: string; kind?: string; expected_version: string },
  actor: string,
): SettingsWriteResult {
  assertSettingsVersion('explicit', input.expected_version);
  const file = readHabitFile('explicit');
  const existing = requireEntry(file.payload.entries, id, '明确习惯');
  // 只覆盖真正给出的字段：没给的键原样保留，PATCH 不该把它清空。
  const updated: HabitEntry = {
    ...existing,
    // zod 的 `nullable()` 推出来是可选键，而 `HabitEntry.confidence` 是必填的
    // `number | null`——显式落成 null，与 `setSettingsHabitEnabled` 同一写法。
    confidence: existing.confidence ?? null,
    statement: input.statement?.trim() ?? existing.statement,
    kind: input.kind ?? existing.kind,
    updated_at: nowIso(),
  };
  writeHabitFile(
    'explicit',
    appendHistory(
      {
        ...file,
        payload: { entries: file.payload.entries.map((e) => (e.id === id ? updated : e)) },
      },
      actor,
      `修改明确习惯「${updated.statement}」`,
    ),
  );
  return {
    snapshot: buildSettingsSnapshot(),
    summary: `修改明确习惯「${updated.statement}」`,
    target_id: id,
  };
}

/**
 * 启停一条明确/推断习惯。
 *
 * 这就是「软删除」：条目永远留在文件里（历史可追溯），`enabled: false` 只是把它
 * 从排序输入里摘出去。没有任何路由会真的删掉一条习惯。
 */
export function setSettingsHabitEnabled(
  name: 'explicit' | 'inferred',
  id: string,
  input: { enabled: boolean; expected_version: string },
  actor: string,
): SettingsWriteResult {
  assertSettingsVersion(name, input.expected_version);
  const label = name === 'explicit' ? '明确习惯' : '推断习惯';
  const file = readHabitFile(name);
  const existing = requireEntry(file.payload.entries, id, label);
  const updated: HabitEntry = {
    ...existing,
    confidence: existing.confidence ?? null,
    enabled: input.enabled,
    updated_at: nowIso(),
  };
  const change = `${input.enabled ? '启用' : '停用'}${label}「${existing.statement}」`;
  writeHabitFile(
    name,
    appendHistory(
      {
        ...file,
        payload: { entries: file.payload.entries.map((e) => (e.id === id ? updated : e)) },
      },
      actor,
      change,
    ),
  );
  return { snapshot: buildSettingsSnapshot(), summary: change, target_id: id };
}

/**
 * 这条推断习惯是否已经被采纳过——**纯读，不写任何文件**。
 *
 * 采纳是「一条 inferred → 一条 explicit」的一次性动作，所以重复点击、客户端重试、
 * 或者带着不同 Idempotency-Key 的重放都不该再建一条。判据是 explicit 侧的
 * `source_relation`：`{type:'adopted_from_inferred', inferred_id}` 指回源条目。
 *
 * 返回**第一条**命中的条目（而不是最后一条，也不报错）：历史数据里已经存在同一个
 * inferred 对应多条 explicit 的情况，那几条都是真实记录，不区分谁是用户操作、谁是
 * 重复写入，所以只认最早的那条为「这次采纳的结果」，一条都不碰。
 *
 * `source_relation` 在 schema 里是 `unknown`（见 `habitEntrySchema` 的注释），
 * 所以这里要自己收窄类型，手改过该字段的旧文件只会匹配不上，不会抛错。
 */
export function findExistingAdoption(inferredId: string): HabitEntry | null {
  const entries = readHabitFile('explicit').payload.entries as HabitEntry[];
  const found = entries.find((entry) => {
    const relation = entry.source_relation as
      | { type?: unknown; inferred_id?: unknown }
      | null
      | undefined;
    return relation?.type === 'adopted_from_inferred' && relation?.inferred_id === inferredId;
  });
  return found ?? null;
}

/**
 * 采纳一条推断习惯为明确习惯——**双资源写**。
 *
 * 两个文件各有自己的版本号，所以两个都要带、两个都要比对：只比一个就留下了「另一
 * 个文件在这期间被改过」的窗口。校验全部通过后才动笔，顺序是先写 explicit 再写
 * inferred。
 *
 * 原推断条目只被标 `enabled: false`，**绝不删除**：它是这条明确习惯的来源证据，
 * 新条目的 `source_relation` 指回它的 id。
 *
 * **采纳只做一次。** 路由会先 `findExistingAdoption` 预检并幂等返回，这里在动笔前
 * 再读一次 explicit 做同样的检查——双保险：别的调用方（Skill、测试、以后的批量
 * 采纳）直接调这个函数时，同样不会写出第二条。命中就原样返回已有条目，既不写
 * explicit、也不重复停用 inferred。
 */
export function adoptSettingsInferred(
  id: string,
  input: { expected_version: string; expected_explicit_version: string },
  actor: string,
): SettingsWriteResult {
  assertSettingsVersion('inferred', input.expected_version);
  assertSettingsVersion('explicit', input.expected_explicit_version);

  const inferredFile = readHabitFile('inferred');
  const source = requireEntry(inferredFile.payload.entries, id, '推断习惯');

  const alreadyAdopted = findExistingAdoption(id);
  if (alreadyAdopted) {
    return {
      snapshot: buildSettingsSnapshot(),
      summary: `推断习惯「${source.statement}」已采纳过，未重复创建`,
      target_id: alreadyAdopted.id,
    };
  }

  const explicitFile = readHabitFile('explicit');
  const adopted: HabitEntry = {
    id: newId('habit'),
    statement: source.statement,
    kind: source.kind,
    enabled: true,
    // 采纳之后它就是用户自己说的话了：置信度（观察的不确定性）不再适用。
    confidence: null,
    source: 'user',
    source_relation: { type: 'adopted_from_inferred', inferred_id: id },
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  const change = `采纳推断习惯「${source.statement}」为明确习惯`;

  writeHabitFile(
    'explicit',
    appendHistory(
      { ...explicitFile, payload: { entries: [...explicitFile.payload.entries, adopted] } },
      actor,
      change,
    ),
  );
  writeHabitFile(
    'inferred',
    appendHistory(
      {
        ...inferredFile,
        payload: {
          entries: inferredFile.payload.entries.map((e) =>
            e.id === id ? { ...e, enabled: false, updated_at: nowIso() } : e,
          ),
        },
      },
      actor,
      `${change}（原条目保留并停用）`,
    ),
  );

  return { snapshot: buildSettingsSnapshot(), summary: change, target_id: adopted.id };
}

// ── constraints ─────────────────────────────────────────────────────────────

export function createSettingsConstraint(
  input: { statement: string; kind: string; value: string; expected_version: string },
  actor: string,
): SettingsWriteResult {
  assertSettingsVersion('constraints', input.expected_version);
  const file = readHabitFile('constraints');
  const entry: HabitConstraint = {
    id: newId('hc'),
    statement: input.statement.trim(),
    kind: input.kind,
    enabled: true,
    value: input.value,
    updated_at: nowIso(),
  };
  const change = `新增硬性约束「${entry.statement}」`;
  writeHabitFile(
    'constraints',
    appendHistory(
      { ...file, payload: { entries: [...file.payload.entries, entry] } },
      actor,
      change,
    ),
  );
  return { snapshot: buildSettingsSnapshot(), summary: change, target_id: entry.id };
}

/**
 * 改一条硬性约束。给出的字段才覆盖，其余原样保留。
 *
 * `kind` 不给就保留原值——哪怕原值不是三种 known kind 之一（手改过的旧数据）。
 * 这是「放开读容忍」的另一半：读得出来，就必须改得了、不丢。
 */
export function updateSettingsConstraint(
  id: string,
  input: { statement?: string; kind?: string; value?: string; expected_version: string },
  actor: string,
): SettingsWriteResult {
  assertSettingsVersion('constraints', input.expected_version);
  const file = readHabitFile('constraints');
  const existing = requireEntry(file.payload.entries, id, '硬性约束');
  const updated: HabitConstraint = {
    ...existing,
    statement: input.statement?.trim() ?? existing.statement,
    kind: input.kind ?? existing.kind,
    value: input.value ?? existing.value,
    updated_at: nowIso(),
  };
  const change = `修改硬性约束「${updated.statement}」`;
  writeHabitFile(
    'constraints',
    appendHistory(
      {
        ...file,
        payload: { entries: file.payload.entries.map((e) => (e.id === id ? updated : e)) },
      },
      actor,
      change,
    ),
  );
  return { snapshot: buildSettingsSnapshot(), summary: change, target_id: id };
}

/** 启停一条硬性约束。同样是软删除：条目留着，只是不再参与排序。 */
export function setSettingsConstraintEnabled(
  id: string,
  input: { enabled: boolean; expected_version: string },
  actor: string,
): SettingsWriteResult {
  assertSettingsVersion('constraints', input.expected_version);
  const file = readHabitFile('constraints');
  const existing = requireEntry(file.payload.entries, id, '硬性约束');
  const change = `${input.enabled ? '启用' : '停用'}硬性约束「${existing.statement}」`;
  writeHabitFile(
    'constraints',
    appendHistory(
      {
        ...file,
        payload: {
          entries: file.payload.entries.map((e) =>
            e.id === id ? { ...e, enabled: input.enabled, updated_at: nowIso() } : e,
          ),
        },
      },
      actor,
      change,
    ),
  );
  return { snapshot: buildSettingsSnapshot(), summary: change, target_id: id };
}

// ── conversion（weights.json 里的两个换算系数）────────────────────────────────

export function updateSettingsConversion(
  input: { hours_per_day?: number; days_per_month?: number; expected_version: string },
  actor: string,
): SettingsWriteResult {
  assertSettingsVersion('weights', input.expected_version);
  const prefs = updateDurationPrefs(
    { hours_per_day: input.hours_per_day, days_per_month: input.days_per_month },
    actor,
  );
  return {
    snapshot: buildSettingsSnapshot(),
    summary:
      `更新耗时换算配置：${prefs.hours_per_day} 小时/天、${prefs.days_per_month} 天/月` +
      `（仅影响之后的换算）`,
    target_id: 'weights',
  };
}

/** 恢复 8 小时/天、20 天/月。已落库的 `estimated_minutes` 一律不回算。 */
export function resetSettingsConversion(
  input: { expected_version: string },
  actor: string,
): SettingsWriteResult {
  assertSettingsVersion('weights', input.expected_version);
  const prefs = updateDurationPrefs(
    { hours_per_day: DEFAULT_HOURS_PER_DAY, days_per_month: DEFAULT_DAYS_PER_MONTH },
    actor,
  );
  return {
    snapshot: buildSettingsSnapshot(),
    summary: `恢复默认耗时换算配置：${prefs.hours_per_day} 小时/天、${prefs.days_per_month} 天/月`,
    target_id: 'weights',
  };
}

// ── weights（预览 + 保存）────────────────────────────────────────────────────

/** 一行中文试算说明，`preview` 与保存后的摘要共用。 */
function describeWeights(draft: SettingsWeightsPayload): string {
  const nonDefault = (Object.keys(draft.weights) as (keyof ScoringWeights)[])
    .filter((key) => draft.weights[key] !== 1)
    .map((key) => `${WEIGHT_LABELS_ZH[key]}=${draft.weights[key]}`);
  const parts = [
    nonDefault.length ? `权重偏离默认：${nonDefault.join('、')}` : '六项权重全部保持默认（1）',
  ];
  parts.push(
    draft.preferred_task_types.length
      ? `偏好任务类型 ${draft.preferred_task_types.length} 项`
      : '未设置偏好任务类型',
  );
  parts.push(
    draft.peak_hours.length ? `精力高峰 ${draft.peak_hours.length} 个时段` : '未设置精力高峰时段',
  );
  const configured = Object.keys(draft.task_type_peak_hours ?? {}).length;
  if (configured) parts.push(`按任务类型单独配置 ${configured} 组高峰时段`);
  return parts.join('；');
}

const WEIGHT_LABELS_ZH: Record<keyof ScoringWeights, string> = {
  deadline: '截止时间',
  manual_priority: '手动优先级',
  dependency: '依赖关系',
  effort: '预计耗时',
  habit_alignment: '习惯契合',
  context_switch: '上下文连续性',
};

/**
 * 权重试算（dry-run）。
 *
 * **只读不写**：不碰文件、不追加 history、不写操作日志、也不收 `expected_version`
 * ——它什么都没改，拿一个版本号来校验只会制造虚假的冲突。未给出的两项落回文件里
 * 的现值，这样试算说明描述的就是「真要保存的话会变成什么样」。
 */
export function previewSettingsWeights(input: {
  weights: ScoringWeights;
  preferred_task_types?: TaskType[];
  peak_hours?: number[];
  task_type_peak_hours?: Partial<Record<TaskType, number[]>>;
}): { weights: ScoringWeights; message: string } {
  const current = readHabitFile('weights');
  const draft: SettingsWeightsPayload = {
    weights: input.weights,
    preferred_task_types: input.preferred_task_types ?? current.payload.preferred_task_types,
    peak_hours: input.peak_hours ?? current.payload.peak_hours,
    task_type_peak_hours: input.task_type_peak_hours ?? current.payload.task_type_peak_hours,
  };
  return { weights: draft.weights, message: `试算：${describeWeights(draft)}。保存后生效。` };
}

/**
 * 保存权重草稿。覆盖 weights / preferred_task_types / peak_hours 三项；
 * 未给出的项保持文件里的原值（界面可以只提交它负责的那部分）。
 *
 * 两个换算系数住在同一个文件里但不属于这次写入，原样带过去。
 */
export function saveSettingsWeights(
  input: {
    weights: ScoringWeights;
    preferred_task_types?: TaskType[];
    peak_hours?: number[];
    task_type_peak_hours?: Partial<Record<TaskType, number[]>>;
    expected_version: string;
  },
  actor: string,
): SettingsWriteResult {
  assertSettingsVersion('weights', input.expected_version);
  const file = readHabitFile('weights');
  const draft: SettingsWeightsPayload = {
    weights: input.weights,
    preferred_task_types: input.preferred_task_types ?? file.payload.preferred_task_types,
    peak_hours: input.peak_hours ?? file.payload.peak_hours,
    task_type_peak_hours: input.task_type_peak_hours ?? file.payload.task_type_peak_hours,
  };
  const change = `保存排序偏好：${describeWeights(draft)}`;
  writeHabitFile(
    'weights',
    appendHistory({ ...file, payload: { ...file.payload, ...draft } }, actor, change),
  );
  return { snapshot: buildSettingsSnapshot(), summary: change, target_id: 'weights' };
}
