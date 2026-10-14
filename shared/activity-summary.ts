/**
 * `operations.summary` 的中文摘要渲染（纯函数，界面与后端搜索同源）。
 *
 * 落库的 summary 是英文（例如 `Changed quadrant of "..." to q2`），界面上渲染成
 * 中文（`将「…」的象限改为重要不紧急`）。用户在 /activity 搜索框里输入的是看到的
 * 中文，所以 `listOperations` 必须用**同一套**规则把每条 summary 渲染成中文再比对
 * ——这就是这个模块存在的理由：渲染逻辑只有这一份实现，`src/lib/format.ts` 直接
 * 调用它，不再自己维护一份正则表。
 *
 * 规则：每条都整句锚定匹配，标题、习惯描述等自由文本一律用捕获组原样带回，只替换
 * 系统自己写死的动词、状态和象限代码。
 */
import type { Quadrant, TaskAction, TaskStatus } from './types.ts';
import { ACTION_LABELS, QUADRANT_TITLES, STATUS_LABELS, snapshotReasonLabel } from './labels.ts';
import { displayDemoText } from './demo-text.ts';
import { translateSystemText } from './system-text.ts';

/** `habits/<file>.json` 的中文名，用于习惯类操作摘要。 */
const HABIT_FILE_LABELS: Record<string, string> = {
  explicit: '显式',
  inferred: '推断',
  constraints: '硬约束',
  weights: '权重',
};

/** 示例数据的标题才查表；用户自己录入的标题永不改写。 */
const titleText = (title: string): string =>
  displayDemoText(title, /^Demo(\s+goal)?:/.test(title.trim()));

const localizeDemoQuotes = (text: string): string =>
  text.replace(/「([^」]+)」/g, (_, title: string) => '「' + titleText(title) + '」');

const quadrantText = (code: string): string => QUADRANT_TITLES[code as Quadrant] ?? code;
const statusText = (code: string): string => STATUS_LABELS[code as TaskStatus] ?? code;
const actionText = (code: string): string => ACTION_LABELS[code as TaskAction] ?? code;
const habitFileText = (file: string): string => HABIT_FILE_LABELS[file] ?? file;

const SUMMARY_RULES: { pattern: RegExp; render: (m: RegExpExecArray) => string }[] = [
  // ── 助手（agent runtime）写入的摘要 ──
  { pattern: /^Agent created task "(.+)"$/, render: (m) => `助手创建任务「${titleText(m[1])}」` },
  { pattern: /^Agent created goal "(.+)"$/, render: (m) => `助手创建目标「${titleText(m[1])}」` },
  {
    pattern: /^Agent applied "(\w+)" to "(.+)"$/,
    render: (m) => `助手对「${titleText(m[2])}」执行${actionText(m[1])}`,
  },
  {
    pattern: /^Agent set "(.+)" to (q[1-4])$/,
    render: (m) => `助手将「${titleText(m[1])}」设为${quadrantText(m[2])}`,
  },
  {
    pattern: /^Agent confirmed (q[1-4]) for "(.+)"$/,
    render: (m) => `助手确认「${titleText(m[2])}」的象限为${quadrantText(m[1])}`,
  },
  {
    pattern: /^Agent added explicit habit "(.+)"$/,
    render: (m) => `助手新增显式习惯「${m[1]}」`,
  },
  {
    pattern: /^Agent disabled explicit habit "(.+)"$/,
    render: (m) => `助手停用显式习惯「${m[1]}」`,
  },

  // ── 任务 ──
  { pattern: /^Created task "(.+)"$/, render: (m) => `创建任务「${titleText(m[1])}」` },
  { pattern: /^Updated task "(.+)"$/, render: (m) => `修改任务「${titleText(m[1])}」` },
  {
    // 生命周期流转：`claim → "标题" (inbox → claimed)`
    pattern: /^(\w+) → "(.+)" \((\w+) → (\w+)\)$/,
    render: (m) =>
      `${actionText(m[1])}任务「${titleText(m[2])}」（${statusText(m[3])} → ${statusText(m[4])}）`,
  },
  { pattern: /^"(.+)" now depends on (.+)$/, render: (m) => `「${titleText(m[1])}」新增依赖 ${m[2]}` },

  // ── 象限与评分 ──
  {
    pattern: /^Confirmed (q[1-4]) for "(.+)"$/,
    render: (m) => `确认「${titleText(m[2])}」的象限为${quadrantText(m[1])}`,
  },
  {
    pattern: /^Changed quadrant of "(.+)" to (q[1-4])$/,
    render: (m) => `将「${titleText(m[1])}」的象限改为${quadrantText(m[2])}`,
  },
  {
    pattern: /^Re-inferred quadrant for "(.+)" → (q[1-4])$/,
    render: (m) => `重新推断「${titleText(m[1])}」的象限 → ${quadrantText(m[2])}`,
  },
  {
    // 后端已是中文，只需翻译标题与末尾的象限代码。
    pattern: /^为「(.+)」记录评分 重要 (\d+) \/ 紧急 (\d+) → (q[1-4])$/,
    render: (m) =>
      `为「${titleText(m[1])}」记录评分：重要 ${m[2]} · 紧急 ${m[3]} → ${quadrantText(m[4])}`,
  },

  // ── 目标 ──
  { pattern: /^Created goal "(.+)"$/, render: (m) => `创建目标「${titleText(m[1])}」` },
  { pattern: /^Updated goal "(.+)"$/, render: (m) => `修改目标「${titleText(m[1])}」` },
  {
    pattern: /^Created (\d+) task\(s\) under "(.+)"$/,
    render: (m) => `在「${titleText(m[2])}」下创建 ${m[1]} 个任务`,
  },
  {
    pattern: /^Confirmed decomposition of "(.+)" into (\d+) task\(s\)$/,
    render: (m) => `确认「${titleText(m[1])}」的拆分，创建 ${m[2]} 个任务`,
  },

  // ── 队列与习惯 ──
  {
    pattern: /^Recalculated the queue \((.+)\)$/,
    render: (m) => `重算队列 · ${snapshotReasonLabel(m[1])}`,
  },
  { pattern: /^Added explicit habit "(.+)"$/, render: (m) => `新增显式习惯「${m[1]}」` },
  {
    pattern: /^(Enabled|Disabled) (\w+) habit "(.+)"$/,
    render: (m) =>
      `${m[1] === 'Enabled' ? '启用' : '停用'}${habitFileText(m[2])}习惯「${m[3]}」`,
  },
  {
    pattern: /^Updated scoring weights \((.+)\)$/,
    render: (m) => `调整评分权重（${m[1]}）`,
  },
];

/**
 * 一条操作的中文摘要。
 *
 * 规则都匹配不上时退回 `translateSystemText`（它覆盖了拆分草稿、助手回复等其它
 * 系统文案），最终仍无匹配则原样返回。
 *
 * `operation_type` / `target_type` 目前不参与渲染（规则靠 summary 整句锚定即可
 * 区分），仍收在入参里：调用方手上就有这两个字段，将来要按类型消歧时不必改签名。
 */
export function renderOperationSummaryZh(input: {
  summary: string | null | undefined;
  operation_type?: string;
  target_type?: string;
}): string {
  if (!input.summary) return '';
  const text = input.summary.trim();
  for (const rule of SUMMARY_RULES) {
    const match = rule.pattern.exec(text);
    if (match) return localizeDemoQuotes(rule.render(match));
  }
  return localizeDemoQuotes(translateSystemText(text));
}

/** 搜索比对前的规范化：与展示同源，只做 trim + 小写。 */
export function normalizeSearchText(text: string): string {
  return text.trim().toLowerCase();
}

/**
 * JS 侧的子串命中判定（中文标题别名与渲染后的中文摘要都走这里）。
 *
 * 除了规范化后的直接子串，再补一次「忽略空白」的比较：中文里夹英文时用户常常不打
 * 空格，输入「阅读SQLite WAL」要能命中展示文本「阅读 SQLite WAL 设计文档…」。
 *
 * 只用于 JS 侧比较。SQL 的 LIKE 仍用 `normalizeSearchText` 的原串——那边比的是库里
 * 存的原文，抽掉空格会让 `Changed quadrant` 这类多词英文永远匹配不上。
 */
export function matchesSearchText(haystack: string, needle: string): boolean {
  const target = normalizeSearchText(haystack);
  const term = normalizeSearchText(needle);
  // 空搜索词不能变成「匹配一切」——调用方据此建 id 白名单，全命中等于没过滤。
  if (!term) return false;
  if (target.includes(term)) return true;
  const squeeze = (text: string): string => text.replace(/\s+/g, '');
  const squeezed = squeeze(term);
  return squeezed.length > 0 && squeeze(target).includes(squeezed);
}

/**
 * 转义 SQL LIKE 的通配符，供参数化的 `%...%` 子串匹配使用。
 *
 * 搭配 `ESCAPE '\'`：用户输入的 `50%` 要当字面量匹配，而不是「以 50 开头的任何值」。
 * 反斜杠自己必须先转义，否则会吃掉后一个字符的转义。
 */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`);
}
