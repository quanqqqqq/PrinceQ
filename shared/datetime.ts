/**
 * 统一日期时间工具。冻结 API，供第二轮及之后复用。
 *
 * 存储约定
 *   数据库与 API 一律存绝对 UTC 瞬间（ISO 8601 带 Z，例如
 *   `2026-10-12T02:00:00.000Z`）。不允许把"本地墙钟时间 + 未标注时区"写入库。
 *
 * 解析约定
 *   所有"今天 / 明天 / 明天上午十点 / tomorrow / tomorrow 10am / next week /
 *   in N days / YYYY-MM-DD"这类相对或日历日期，都按用户时区解析为绝对 UTC。
 *   用户时区读取顺序：
 *     1. process.env.TZ（服务端显式覆盖）
 *     2. Intl.DateTimeFormat().resolvedOptions().timeZone（操作系统/浏览器本地时区）
 *     3. 兜底 'Asia/Singapore'
 *   绝不硬编码城市名作为唯一来源；本文件只把 Asia/Singapore 当作兜底。
 *
 * 展示约定
 *   所有相对/绝对展示都在用户时区渲染；绝对时间戳会显式带上 UTC 偏移标签
 *   （例如 `(UTC+8)`），避免把 UTC 当本地时间误读。
 *
 * 时区安全
 *   跨日、夏令时（DST）、闰年、月底都通过 Intl 查 IANA 时区数据库解析，不手动
 *   加减 8 小时。墙钟↔UTC 互转使用两次迭代偏移校正，DST 跳变窗口收敛。
 */

export const DEFAULT_TIMEZONE = 'Asia/Singapore';

/** EOD 默认墙钟小时（用户时区）。 */
export const DEFAULT_EOD_HOUR = 18;

/** 当前用户时区（env > 系统 > 兜底）。 */
export function getUserTimezone(): string {
  if (
    typeof process !== 'undefined' &&
    typeof process.env !== 'undefined' &&
    typeof process.env.TZ === 'string' &&
    process.env.TZ
  ) {
    return process.env.TZ;
  }
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz || DEFAULT_TIMEZONE;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

export interface ZonedParts {
  y: number;
  m: number; // 1-12
  d: number; // 1-31
  h: number; // 0-23
  min: number; // 0-59
  s: number; // 0-59
}

/** 把一个 UTC 毫秒瞬间换算成目标时区的墙钟字段。 */
export function partsInTz(dateMs: number, tz: string): ZonedParts {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const out: ZonedParts = { y: 1970, m: 1, d: 1, h: 0, min: 0, s: 0 };
  for (const p of dtf.formatToParts(new Date(dateMs))) {
    const v = Number(p.value);
    if (p.type === 'year') out.y = v;
    else if (p.type === 'month') out.m = v;
    else if (p.type === 'day') out.d = v;
    else if (p.type === 'hour') out.h = v === 24 ? 0 : v;
    else if (p.type === 'minute') out.min = v;
    else if (p.type === 'second') out.s = v;
  }
  return out;
}

/** 目标时区在某个 UTC 瞬间相对 UTC 的偏移（分钟，东八区 = +480）。 */
export function offsetMinutesAt(utcMs: number, tz: string): number {
  const p = partsInTz(utcMs, tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s);
  return Math.round((asUtc - utcMs) / 60000);
}

/**
 * 把"目标时区里的一个墙钟时间"换算成 UTC 毫秒。
 *
 * DST 安全：先用墙钟当 UTC 猜一次，再用猜中的瞬间反查偏移，二次迭代收敛。
 * 落在 DST 跳变空隙（被跳过的那一小时）时，Intl 会取两个候选偏移之一，
 * 本函数不做猜测性补全——调用方应在解析时把时间选在不模糊的小时（如 10:00、18:00）。
 */
export function zonedWallToUtc(
  y: number,
  mo: number,
  d: number,
  h: number,
  min: number,
  tz: string,
): number {
  const naiveUtc = Date.UTC(y, mo - 1, d, h, min, 0);
  const off1 = offsetMinutesAt(naiveUtc, tz);
  const candidate = naiveUtc - off1 * 60000;
  const off2 = offsetMinutesAt(candidate, tz);
  return naiveUtc - off2 * 60000;
}

/** 取 now 在 tz 下的墙钟日期，加上 N 个日历日（跨月/跨年/DST 安全）。 */
export function addDaysWall(baseMs: number, days: number, tz: string): ZonedParts {
  const p = partsInTz(baseMs, tz);
  // 用正午 12:00 作为锚点——DST 切换通常发生在凌晨，正午不会落在跳变空隙。
  const noonUtc = zonedWallToUtc(p.y, p.m, p.d + days, 12, 0, tz);
  return partsInTz(noonUtc, tz);
}

// ── 纯日期（date-only）互转 ─────────────────────────────────────────────────
//
// 目标日期这类字段在界面上是「墙钟日历日」（用户看到的 2026-10-13），在库里却
// 必须是绝对 UTC 瞬间。两边直接用 `new Date('YYYY-MM-DD')` / `.slice(0, 10)`
// 互转会把字符串当 UTC 午夜解析，非 UTC 时区就会整日偏移一天（例如纽约用户选
// 10-13，回显变成 10-12）。下面两个函数把这层换算收口：
//   - 一律以该墙钟日的 **12:00** 为锚点，和 `addDaysWall` 同一套理由——DST 跳变
//     发生在凌晨，正午永远不会落进被跳过的那一小时；
//   - 往返不变式：`isoToWallDate(wallDateToIso(d)) === d`。

/** 严格匹配 `YYYY-MM-DD`（只认这一种形式，不接受 `2026-1-3`）。 */
const WALL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * 墙钟日历日 `YYYY-MM-DD` → 绝对 UTC ISO 字符串。
 *
 * 非法输入（格式不符、月/日越界、2 月 30 日这类不存在的日子）返回 null，由调用
 * 方决定是报错还是当成「没填」。
 */
export function wallDateToIso(yyyyMmDd: string, tz: string = getUserTimezone()): string | null {
  const match = WALL_DATE_RE.exec(yyyyMmDd);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  // 日历日存在性校验：用 UTC 构造再读回，2 月 30 日会被规范化成 3 月 2 日。
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    return null;
  }
  return new Date(zonedWallToUtc(y, m, d, 12, 0, tz)).toISOString();
}

/** 绝对 UTC 瞬间 → 该时区下的墙钟日历日 `YYYY-MM-DD`。 */
export function isoToWallDate(iso: string, tz: string = getUserTimezone()): string {
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return '';
  const p = partsInTz(ms, tz);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

export interface RelativeParseOptions {
  /** 覆盖"现在"（测试用）；默认 new Date()。 */
  now?: Date;
  /** 覆盖时区；默认 getUserTimezone()。 */
  timezone?: string;
  /** 覆盖 EOD 小时；默认 DEFAULT_EOD_HOUR。 */
  eodHour?: number;
}

export interface RelativeParseResult {
  /** 绝对 UTC ISO 字符串，可直接入库。 */
  iso: string;
  /** 解析后的墙钟（用户时区），用于回显与调试。 */
  wall: ZonedParts;
  /** 实际使用的时区名。 */
  timezone: string;
}

/** 中文数字"十/十一/十二/两/三…"→ 小时数。 */
function chineseHourToNumber(s: string): number | null {
  const map: Record<string, number> = {
    一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
    六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
    十一: 11, 十二: 12,
  };
  if (map[s] != null) return map[s];
  if (s.startsWith('十')) {
    const rest = s.slice(1);
    if (!rest) return 10;
    if (map[rest] != null) return 10 + map[rest];
  }
  return null;
}

/** 从自由文本里抽出"几点"；识别不出来返回 null（调用方回落 EOD）。 */
export function extractTimeOfDay(lower: string, original: string): { hour: number; minute: number } | null {
  // morning / 上午 → 10:00；afternoon / 下午 → 14:00；evening / 晚上 → 19:00
  if (/\bmorning\b|\bam\b/.test(lower) || original.includes('上午')) return { hour: 10, minute: 0 };
  if (/\bafternoon\b/.test(lower) || original.includes('下午')) return { hour: 14, minute: 0 };
  if (/\bevening\b/.test(lower) || original.includes('晚上')) return { hour: 19, minute: 0 };

  // "10am" / "10 am" / "10:30pm"
  const ampm = lower.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  if (ampm) {
    let h = Number(ampm[1]);
    const min = Number(ampm[2] ?? 0);
    if (ampm[3] === 'pm' && h < 12) h += 12;
    if (ampm[3] === 'am' && h === 12) h = 0;
    return { hour: h, minute: min };
  }
  // 24h "HH:mm"
  const hhmm = lower.match(/\b(\d{1,2}):(\d{2})\b/);
  if (hhmm) return { hour: Number(hhmm[1]), minute: Number(hhmm[2]) };
  // 中文 "十点" / "十点半" / "上午十点"
  const cn = original.match(/([一二两三四五六七八九十]+)点(半)?/);
  if (cn) {
    const h = chineseHourToNumber(cn[1]);
    if (h != null) return { hour: h, minute: cn[2] === '半' ? 30 : 0 };
  }
  return null;
}

function hasToday(lower: string, text: string): boolean {
  return (
    /\b(today|tonight|by eod|end of day)\b/.test(lower) ||
    text.includes('今天') ||
    text.includes('今晚')
  );
}
function hasTomorrow(lower: string, text: string): boolean {
  return /\btomorrow\b/.test(lower) || text.includes('明天');
}
function hasNextWeek(lower: string, text: string): boolean {
  return /\bnext week\b/.test(lower) || text.includes('下周');
}

/**
 * 把"今天/明天/明天上午十点/tomorrow 10am/next week/in N days/YYYY-MM-DD"
 * 解析成绝对 UTC ISO。识别不到日期短语返回 null。
 *
 * 纯日历日期（YYYY-MM-DD）不带时间时默认取 EOD 小时；
 * "今天/明天/下周/in N days" 同理，除非文本里显式给出"上午十点/10am/22:00"。
 */
export function parseRelativeToIso(
  text: string,
  opts: RelativeParseOptions = {},
): RelativeParseResult | null {
  const tz = opts.timezone ?? getUserTimezone();
  const now = opts.now ?? new Date();
  const eodHour = opts.eodHour ?? DEFAULT_EOD_HOUR;
  const lower = text.toLowerCase();

  const tod = extractTimeOfDay(lower, text) ?? { hour: eodHour, minute: 0 };

  let base: ZonedParts | null = null;
  if (hasToday(lower, text)) {
    base = partsInTz(now.getTime(), tz);
  } else if (hasTomorrow(lower, text)) {
    base = addDaysWall(now.getTime(), 1, tz);
  } else if (hasNextWeek(lower, text)) {
    base = addDaysWall(now.getTime(), 7, tz);
  } else {
    const inDays = lower.match(/\bin (\d+) days?\b/);
    if (inDays) base = addDaysWall(now.getTime(), Number(inDays[1]), tz);
  }

  const isoMatch = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (isoMatch) {
    base = {
      y: Number(isoMatch[1]),
      m: Number(isoMatch[2]),
      d: Number(isoMatch[3]),
      h: tod.hour,
      min: tod.minute,
      s: 0,
    };
  }

  if (!base) return null;

  const wall: ZonedParts = { ...base, h: tod.hour, min: tod.minute, s: 0 };
  const utcMs = zonedWallToUtc(wall.y, wall.m, wall.d, wall.h, wall.min, tz);
  return { iso: new Date(utcMs).toISOString(), wall, timezone: tz };
}

// ── 展示 ────────────────────────────────────────────────────────────────────

export interface FormatOptions {
  timezone?: string;
  now?: Date;
}

/** 生成 `(UTC+8)` / `(UTC−4:30)` 这类偏移标签。 */
export function tzLabel(tz: string, at: Date): string {
  const offMin = offsetMinutesAt(at.getTime(), tz);
  const sign = offMin < 0 ? '−' : '+';
  const abs = Math.abs(offMin);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return m === 0 ? `(UTC${sign}${h})` : `(UTC${sign}${h}:${String(m).padStart(2, '0')})`;
}

/** 绝对日期（用户时区），例如 2026年10月12日。 */
export function formatLocalDate(iso: string, opts: FormatOptions = {}): string {
  const tz = opts.timezone ?? getUserTimezone();
  return new Date(iso).toLocaleDateString('zh-CN', {
    timeZone: tz,
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

/** 绝对日期时间（用户时区），并显式带 UTC 偏移，例如 `2026年10月12日 20:30 (UTC+8)`。 */
export function formatLocalTimestamp(iso: string, opts: FormatOptions = {}): string {
  const tz = opts.timezone ?? getUserTimezone();
  const dtf = new Intl.DateTimeFormat('zh-CN', {
    timeZone: tz,
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return `${dtf.format(new Date(iso))} ${tzLabel(tz, new Date(iso))}`;
}

/** 相对时间"x 分钟前 / x 小时前 / x 天前"，与其它展示共用一个时钟。 */
export function formatLocalRelative(iso: string, opts: FormatOptions = {}): string {
  const now = opts.now ?? new Date();
  const seconds = Math.round((now.getTime() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return '刚刚';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86400)} 天前`;
}

/** 截止时间剩余/逾期描述；远期截止回落到本地日期。 */
export function formatDeadlineLocal(deadline: string | null, opts: FormatOptions = {}): string {
  if (!deadline) return '无截止时间';
  const now = opts.now ?? new Date();
  const diffHours = (new Date(deadline).getTime() - now.getTime()) / 36e5;
  if (diffHours < 0) {
    const overdue = Math.abs(diffHours);
    return overdue < 24
      ? `已逾期 ${Math.round(overdue)} 小时`
      : `已逾期 ${Math.round(overdue / 24)} 天`;
  }
  if (diffHours < 1) return '1 小时内到期';
  if (diffHours < 24) return `${Math.round(diffHours)} 小时后到期`;
  if (diffHours < 24 * 14) return `${Math.round(diffHours / 24)} 天后到期`;
  return `${formatLocalDate(deadline, opts)} 到期`;
}

export const isOverdueLocal = (deadline: string | null, now: Date = new Date()): boolean =>
  deadline != null && new Date(deadline).getTime() < now.getTime();
