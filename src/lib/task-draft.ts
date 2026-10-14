/**
 * 新建任务草稿（UX-21）。
 *
 * 目标：对话框被意外关闭（点遮罩、按 Esc、切页面）后不丢输入。用户再次打开
 * 「新建任务」时，之前填到一半的内容原样回来；只有提交成功或显式「清空草稿」
 * 才会丢弃。
 *
 * 这里刻意做成与 React、localStorage 完全解耦的纯逻辑：
 *   - 零 import，可以被 `node --test` 直接引入做语义测试；
 *   - 读写存储通过 CreateTaskDraftStore 接口注入，SSR / 隐私模式下静默降级；
 *   - 解析一律防御性处理（旧版本、半截的 JSON、被别人覆盖的 key），永不抛错。
 *
 * `advanced` 字段当前 UI 并不写入，是给第三轮「高级选项」复用预留的开放槽位：
 * 届时新增字段只往 advanced 里塞键值，不必再改信封结构和 schema 版本。
 */

/** localStorage key。带 v1 后缀，将来结构不兼容时换版本即可自然失效旧草稿。 */
export const CREATE_TASK_DRAFT_KEY = 'pwq.create-task-draft.v1';

/** 信封 schema 版本。parse 时版本不符一律视为无效草稿。 */
export const CREATE_TASK_DRAFT_SCHEMA = 1;

/** 对话框里所有受控输入的字符串快照（原样存，提交时才做类型转换）。 */
export interface CreateTaskDraftFields {
  title: string;
  description: string;
  goal_id: string;
  deadline_local: string;
  /**
   * 耗时的数值字符串。名字沿用历史（以前它就是分钟数），现在它的单位由下面的
   * `duration_unit` 决定。
   */
  estimated_minutes_text: string;
  /**
   * 耗时单位。空串按 'minute' 处理——这正是旧草稿（没有这个键）的行为，所以
   * schemaVersion 不用升：旧草稿照旧被当成「按分钟填的」恢复出来。
   */
  duration_unit: string;
  task_type: string;
  cognitive_load: string;
  manual_priority: string;
  /** 第三轮「高级选项」预留槽位；为空时不落盘。 */
  advanced?: Record<string, string | number | boolean | null>;
}

/** 落盘结构：字段外面套一层版本与时间戳，便于排查与将来迁移。 */
export interface CreateTaskDraftEnvelope {
  schemaVersion: number;
  savedAt: string;
  fields: CreateTaskDraftFields;
}

/** 空草稿。manual_priority 的「自动」档位是 '0'，不是空串。 */
export const EMPTY_CREATE_TASK_DRAFT: CreateTaskDraftFields = {
  title: '',
  description: '',
  goal_id: '',
  deadline_local: '',
  estimated_minutes_text: '',
  // 默认「分钟」：与改动前的行为逐字一致。
  duration_unit: 'minute',
  task_type: '',
  cognitive_load: '',
  manual_priority: '0',
};

/** normalize 认的 9 个键，顺序即落盘顺序。 */
const TEXT_KEYS = [
  'title',
  'description',
  'goal_id',
  'deadline_local',
  'estimated_minutes_text',
  'duration_unit',
  'task_type',
  'cognitive_load',
  'manual_priority',
] as const;

type TextKey = (typeof TEXT_KEYS)[number];

/**
 * 认可的耗时单位字面量。
 *
 * 本模块刻意保持零 import（这样 `node --test` 能直接引它做纯逻辑测试），所以这里
 * 重复一份枚举而不是从 `@shared/types` 取。`shared/types.ts` 的 `DURATION_UNITS`
 * 才是权威来源；两边都只会在新增单位时才动。
 */
const DRAFT_DURATION_UNITS: readonly string[] = ['minute', 'day', 'month'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 把任意值收敛成字符串：字符串直接用，有限数字转字符串（例如历史上写进去的
 * manual_priority: 3），其余（布尔、对象、数组、null、NaN）回退到默认值。
 */
function toText(value: unknown, fallback: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return fallback;
}

function normalizeAdvanced(
  value: unknown,
): Record<string, string | number | boolean | null> | undefined {
  if (!isPlainObject(value)) return undefined;

  const result: Record<string, string | number | boolean | null> = {};
  let count = 0;
  for (const key of Object.keys(value)) {
    const entry = value[key];
    if (
      entry === null ||
      typeof entry === 'string' ||
      typeof entry === 'number' ||
      typeof entry === 'boolean'
    ) {
      result[key] = entry as string | number | boolean | null;
      count += 1;
    }
  }

  return count > 0 ? result : undefined;
}

/**
 * 防御性归一化：丢掉未知键、补齐缺省键、强制字段类型。任何输入（包括 null、
 * 字符串、数组）都返回一个合法的 CreateTaskDraftFields，不抛错。
 */
export function normalizeCreateTaskFields(input: unknown): CreateTaskDraftFields {
  const source = isPlainObject(input) ? input : {};
  const fields = { ...EMPTY_CREATE_TASK_DRAFT } as CreateTaskDraftFields;

  for (const key of TEXT_KEYS) {
    fields[key as TextKey] = toText(source[key], EMPTY_CREATE_TASK_DRAFT[key as TextKey]);
  }

  // 旧草稿没有 duration_unit（或存了别的字符串）：一律收敛成 'minute'，也就是
  // 这个字段出现之前的行为——数值直接当分钟数。
  if (!DRAFT_DURATION_UNITS.includes(fields.duration_unit)) {
    fields.duration_unit = 'minute';
  }

  const advanced = normalizeAdvanced(source.advanced);
  if (advanced) fields.advanced = advanced;

  return fields;
}

/**
 * 草稿是否「没内容」。manual_priority 的 '' / '0' 都算没选，避免默认档位
 * 让空对话框一打开就显示「清空草稿」。
 *
 * `duration_unit` 同理不单独计入：它永远有值（默认 'minute'），只改单位却没填
 * 数字并不算填了东西；真正的耗时内容看 `estimated_minutes_text`。
 */
export function isCreateTaskDraftEmpty(fields: CreateTaskDraftFields): boolean {
  if (fields.title.trim()) return false;
  if (fields.description.trim()) return false;
  if (fields.goal_id) return false;
  if (fields.deadline_local) return false;
  if (fields.estimated_minutes_text.trim()) return false;
  if (fields.task_type) return false;
  if (fields.cognitive_load) return false;
  if (fields.manual_priority !== '' && fields.manual_priority !== '0') return false;
  if (fields.advanced && Object.keys(fields.advanced).length > 0) return false;
  return true;
}

/** 组装信封 JSON。savedAt 可注入，方便测试与固定时钟。 */
export function serializeCreateTaskDraft(
  fields: CreateTaskDraftFields,
  savedAt: string = new Date().toISOString(),
): string {
  const envelope: CreateTaskDraftEnvelope = {
    schemaVersion: CREATE_TASK_DRAFT_SCHEMA,
    savedAt,
    fields: normalizeCreateTaskFields(fields),
  };
  return JSON.stringify(envelope);
}

/**
 * 解析信封。坏数据（空串、非 JSON、非对象、版本不符、fields 不是对象）统一
 * 返回 null，由调用方决定是清空还是忽略。永不抛错。
 */
export function parseCreateTaskDraft(
  raw: string | null | undefined,
): CreateTaskDraftFields | null {
  if (typeof raw !== 'string' || raw === '') return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isPlainObject(parsed)) return null;
  if (parsed.schemaVersion !== CREATE_TASK_DRAFT_SCHEMA) return null;
  if (!isPlainObject(parsed.fields)) return null;

  return normalizeCreateTaskFields(parsed.fields);
}

/** 草稿存储抽象。真实实现是 localStorage，测试里用内存 Map。 */
export interface CreateTaskDraftStore {
  load(): string | null;
  save(value: string): void;
  clear(): void;
}

/**
 * 默认存储：围绕 CREATE_TASK_DRAFT_KEY 操作 localStorage。
 *
 * 惰性取 storage（而不是模块加载时取一次），这样 SSR、隐私模式、storage 被
 * 禁用等情况下只是静默 no-op，而不会在 import 阶段就炸掉。
 */
export function defaultCreateTaskDraftStore(): CreateTaskDraftStore {
  const storage = (): Storage | null => {
    try {
      if (typeof globalThis === 'undefined') return null;
      const candidate = (globalThis as { localStorage?: Storage }).localStorage;
      return typeof candidate === 'undefined' || candidate === null ? null : candidate;
    } catch {
      return null;
    }
  };

  return {
    load() {
      try {
        return storage()?.getItem(CREATE_TASK_DRAFT_KEY) ?? null;
      } catch {
        return null;
      }
    },
    save(value: string) {
      try {
        storage()?.setItem(CREATE_TASK_DRAFT_KEY, value);
      } catch {
        // 配额满 / 隐私模式：草稿是增益功能，存不下就算了。
      }
    },
    clear() {
      try {
        storage()?.removeItem(CREATE_TASK_DRAFT_KEY);
      } catch {
        // 同上，清不掉也不该影响用户正在做的事。
      }
    },
  };
}

/**
 * 打开对话框时调用：读出草稿，坏数据顺手清掉，保证返回的一定是可直接塞进
 * state 的合法字段对象。
 */
export function restoreCreateTaskDraft(store: CreateTaskDraftStore): CreateTaskDraftFields {
  const parsed = parseCreateTaskDraft(store.load());
  if (parsed === null) {
    store.clear();
    return { ...EMPTY_CREATE_TASK_DRAFT };
  }
  return parsed;
}
