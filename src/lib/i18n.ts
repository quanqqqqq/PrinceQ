/**
 * 中文界面文案与展示映射。
 *
 * 规则：这里只翻译 **系统** 产生的文字——导航、表头、状态、按钮、错误码、
 * 规则引擎写入的理由。用户自己录入的标题、描述、目标、习惯原文永不改写。
 *
 * 唯一的例外是 `is_demo = true` 的示例数据：它由本项目的 seed 写入，属于系统
 * 内容，因此通过下面的只读映射以中文显示，数据库里的原值保持不变。
 */
import { DEMO_TEXT, displayDemoText } from '../../shared/demo-text.ts';
import type {
  CognitiveLoad,
  GoalStatus,
  MatrixScoreSource,
  Quadrant,
  TaskStatus,
  TaskType,
} from '@shared/types';

/**
 * 象限/状态/动作标签与系统文案词典住在 `shared/`：操作记录的中文摘要渲染既要在
 * 界面上用，也要供服务端的中文搜索用，shared 不能反向依赖 src。这里原样再导出，
 * 界面层的导入路径（`@/lib/i18n`）保持不变。
 *
 * 用相对路径而不是 `@shared/*`：tests/ux24 直接用 node 跑本文件，Node 不认 vite
 * 的 alias（`demo-text` 的导入同理）。
 */
export {
  ACTION_LABELS,
  QUADRANT_TITLES,
  SNAPSHOT_REASON_LABELS,
  STATUS_LABELS,
  snapshotReasonLabel,
} from '../../shared/labels.ts';
export { translateSystemText } from '../../shared/system-text.ts';

import { QUADRANT_TITLES, STATUS_LABELS } from '../../shared/labels.ts';
import { translateSystemText } from '../../shared/system-text.ts';

// ── 导航与页面 ──────────────────────────────────────────────────────────────

export const APP_NAME = 'PrinceQ';
export const APP_TAGLINE = '把重要的事，排在前面。';

export const NAV_LABELS = {
  home: '任务优先队列',
  matrix: '任务分布视图',
  goals: '目标',
  activity: '操作记录',
} as const;

export const NAV_HINTS = {
  home: '按评分算法排序',
  matrix: '按任务轻重缓急分布，而非单纯排序',
  goals: '目标及其任务',
  activity: '操作日志与队列快照',
} as const;

export const PAGE_TITLES: Record<string, string> = {
  '/': '任务优先队列',
  '/matrix': '任务分布视图',
  '/goals': '目标',
  '/activity': '操作记录',
};

// ── 象限 ────────────────────────────────────────────────────────────────────

/** 行动建议，作为象限标题的副标题使用。 */
export const QUADRANT_ACTIONS: Record<Quadrant, string> = {
  q1: '立即处理',
  q2: '安排计划',
  q3: '批量处理或委派',
  q4: '延后或放弃',
};

export const QUADRANT_SUBTITLES: Record<Quadrant, string> = {
  q1: '重要 · 紧急',
  q2: '重要 · 不紧急',
  q3: '不重要 · 紧急',
  q4: '不重要 · 不紧急',
};

export const MATRIX_SCORE_SOURCE_LABELS: Record<MatrixScoreSource, string> = {
  agent: '助手评分',
  user: '本人评分',
  rule: '本地规则',
  legacy: '旧版粗评分',
  unset: '未评分',
};

export const MATRIX_SCORE_SOURCE_HINTS: Record<MatrixScoreSource, string> = {
  agent: '由外部 Agent 加载 Skill 后给出的两轴评分',
  user: '由你本人直接指定的分值',
  rule: '本地关键词规则推断，不是模型评分',
  legacy: '由旧版 1..5 粗评分换算显示，待助手复评',
  unset: '尚未评分',
};

// ── 队列评分因子（按英文 key 映射，比按英文文案匹配更稳）─────────────────────

/**
 * 队列评分因子的中文标签。key 是评分器写死的英文枚举（`deadline` 等），
 * 直接按 key 映射，不依赖后端返回的英文 `label`。
 */
export const QUEUE_FACTOR_LABELS: Record<string, string> = {
  deadline: '截止时间压力',
  manual_priority: '手动优先级',
  dependency: '依赖就绪度',
  effort: '预计工作量',
  habit_alignment: '习惯契合度',
  context_switch: '上下文连续性',
};

// ── 任务 ────────────────────────────────────────────────────────────────────

export const TASK_TYPE_LABELS: Record<TaskType, string> = {
  deep_work: '深度工作',
  shallow_work: '浅层工作',
  communication: '沟通',
  admin: '事务',
  review: '评审',
  learning: '学习',
};

export const COGNITIVE_LOAD_LABELS: Record<CognitiveLoad, string> = {
  low: '低',
  medium: '中',
  high: '高',
};

export const GOAL_STATUS_LABELS: Record<GoalStatus, string> = {
  active: '进行中',
  paused: '已暂停',
  achieved: '已达成',
  dropped: '已放弃',
};

/**
 * 手动优先级档位。label 只说语义不露数字——选项读起来是「较高」而不是
 * 「较高（+1）」；value 仍是后端认的 -2..2，所以存储与接口完全没变。
 */
export const MANUAL_PRIORITY_LABELS: { value: string; label: string }[] = [
  { value: '-2', label: '低' },
  { value: '-1', label: '较低' },
  { value: '0', label: '普通' },
  { value: '1', label: '较高' },
  { value: '2', label: '高' },
];

// ── 错误码 ──────────────────────────────────────────────────────────────────

/** 后端 `ApiErrorBody.error.code` 的中文说明；业务值本身保持英文。 */
export const ERROR_CODE_LABELS: Record<string, string> = {
  offline: '无法连接本地 API',
  bad_request: '请求参数有误',
  not_found: '未找到对应数据',
  conflict: '状态冲突，操作未执行',
  unprocessable: '数据校验未通过',
  validation_failed: '数据校验未通过',
  internal_error: '本地服务内部错误',
  unknown: '未知错误',
};

/** 错误展示：`错误码说明：详细消息`。 */
export function formatApiError(code: string, message: string): string {
  const label = ERROR_CODE_LABELS[code];
  const detail = translateSystemText(message);
  if (!label) return detail;
  return detail && detail !== label ? `${label}：${detail}` : label;
}

// ── 操作记录 ────────────────────────────────────────────────────────────────

/** `operations.operation_type` 的中文名；键本身是 API 枚举，保持英文。 */
export const OPERATION_TYPE_LABELS: Record<string, string> = {
  'task.create': '创建任务',
  'task.update': '修改任务',
  'task.action': '任务流转',
  'task.dependency.add': '添加依赖',
  'task.matrix_score': '提交矩阵评分',
  'quadrant.confirm': '确认象限',
  'quadrant.change': '修改象限',
  'quadrant.resuggest': '重新推断象限',
  'goal.create': '创建目标',
  'goal.update': '修改目标',
  'goal.decompose': '拆分目标',
  'queue.recalculate': '重算队列',
  'habit.add': '新增习惯',
  'habit.toggle': '启停习惯',
  'habit.weights': '调整权重',
  'agent.message': '助手消息',
  'agent.confirm': '助手确认',
};

export const TARGET_TYPE_LABELS: Record<string, string> = {
  task: '任务',
  goal: '目标',
  queue: '队列',
  habit: '习惯',
  agent: '助手',
};

export const OPERATION_STATUS_LABELS: Record<string, string> = {
  succeeded: '成功',
  failed: '失败',
};

const labelled = (map: Record<string, string>, key: string | null | undefined): string =>
  (key && map[key]) || key || '';

export const operationTypeLabel = (type: string): string => labelled(OPERATION_TYPE_LABELS, type);
export const targetTypeLabel = (type: string): string => labelled(TARGET_TYPE_LABELS, type);

// ── 示例数据的只读中文展示 ──────────────────────────────────────────────────

/**
 * 示例内容的中文展示文案。
 *
 * 映射表与实现都在 `@shared/demo-text`——服务端的操作记录搜索要用同一张表把
 * 中文搜索词回解析成英文原值，所以不能只存在于界面层。
 */
export function demoText(text: string | null | undefined, isDemo: boolean): string {
  return displayDemoText(text, isDemo);
}

/**
 * 展示用标题映射：不依赖 is_demo 标记，已知 Demo 种子标题直接返回中文；
 * 用户自建标题不在 DEMO_TEXT 表内，原样返回。专供助手动态推荐/候选卡等
 * 拿不到 is_demo 的展示层使用。只用于显示，绝不改写要发给解析器的原始标题。
 */
export function demoTitle(title: string | null | undefined): string {
  if (!title) return '';
  return DEMO_TEXT[title.trim()] ?? title;
}

// ── 助手回复的结构化区块 ────────────────────────────────────────────────────

/** `AgentResult.kind` 的中文标签。 */
export const AGENT_KIND_LABELS: Record<string, string> = {
  applied: '已执行',
  preview: '待确认',
  clarification: '需要补充',
  answer: '回答',
  error: '已拒绝',
};

/** 区块标题与事实项标签都是后端写死的英文，按整词映射。 */
export const AGENT_BLOCK_TITLES: Record<string, string> = {
  Candidates: '候选项',
  Commands: '支持的指令',
  'Try one of these': '可以试试这些',
  'Your input': '你的输入',
  Queue: '队列',
  Tasks: '任务',
  Goals: '目标',
  'Explicit habits': '显式习惯',
  'Inferred habits': '推断习惯',
  'Hard constraints': '硬约束',
  'Scoring weights': '评分权重',
  'Score breakdown': '分值构成',
  Drafts: '任务草稿',
  Task: '任务',
  Created: '已创建',
  'Created tasks': '已创建的任务',
  Updated: '已更新',
  Goal: '目标',
  Habit: '习惯',
};

export const AGENT_FACT_LABELS: Record<string, string> = {
  Status: '状态',
  Deadline: '截止时间',
  Estimate: '预计耗时',
  Goal: '目标',
  Quadrant: '象限',
  'Target date': '目标日期',
  Tasks: '任务数',
  Id: '标识',
  Kind: '类型',
  Enabled: '已启用',
  '(none)': '（暂无）',
};

export const agentKindLabel = (kind: string): string => labelled(AGENT_KIND_LABELS, kind);
export const agentBlockTitle = (title: string): string => labelled(AGENT_BLOCK_TITLES, title);
export const agentFactLabel = (label: string): string => {
  if (AGENT_COMMAND_LABELS[label]) return AGENT_COMMAND_LABELS[label];
  const numbered = /^(#\d+\s+)(.+)$/.exec(label);
  return numbered ? numbered[1] + demoTitle(numbered[2]) : labelled(AGENT_FACT_LABELS, label);
};

/** 助手 facts 块里「支持的指令」英文 command 的中文展示；英文 command 本身保留可发送。 */
export const AGENT_COMMAND_LABELS: Record<string, string> = {
  'create a task': '创建一个任务',
  'create a goal': '创建一个目标',
  'show queue': '查看队列排名',
  'show goals': '查看目标列表',
  'claim / release / start / complete / block a task': '领取 / 释放 / 开始 / 完成 / 受阻 一个任务',
  'change a task quadrant': '修改任务象限',
  'confirm a quadrant suggestion': '确认象限建议',
  'draft tasks for a goal': '为目标拟任务草稿',
  'add / list / disable an explicit habit': '新增 / 列出 / 停用显式习惯',
  'explain a ranking': '解释一次排名',
};

export const agentCommandLabel = (command: string): string =>
  AGENT_COMMAND_LABELS[command] ?? command;

/**
 * 助手 facts 块里 `value` 的中文展示。
 *
 * 只翻译系统写死的枚举值与固定词（状态/象限/none/enabled 等）；用户录入的标题、
 * 习惯描述、ID 一律原样保留。认不出就原样返回，绝不改写自由文本。
 */
export function agentFactValue(label: string, value: string): string {
  const examples: Record<string, string> = {
    'create task "Draft Q3 review notes" by tomorrow, takes 45m': '创建任务「写季度复盘」，明天截止，预计45分钟',
    'create goal "Ship the billing rewrite" by 2026-12-01': '创建目标「上线计费系统重写」，目标日期2026-12-01',
    'show queue top 5': '看看队列前5个任务',
    'list goals': '查看目标列表',
    'start "Draft Q3 review notes"': '开始「写季度复盘」',
    'move "Draft Q3 review notes" to q2': '请为「写季度复盘」重新评估重要与紧急程度',
    'confirm the quadrant for "Draft Q3 review notes"': '确认「写季度复盘」的象限建议',
    'draft tasks for goal "Ship the billing rewrite"': '为目标「上线计费系统重写」拟任务草稿',
    'add habit "deep work before noon"': '新增习惯「中午前做深度工作」',
    'why is "Draft Q3 review notes" ranked first': '为什么「写季度复盘」排在前面',
  };
  if (AGENT_COMMAND_LABELS[label] && examples[value]) return examples[value];
  if (value === 'none') return '（暂无）';
  if (value === 'true') return '已启用';
  if (value === 'false') return '未启用';

  // 整个值就是一个任务状态枚举。
  if (STATUS_LABELS[value as TaskStatus]) return STATUS_LABELS[value as TaskStatus];
  // 整个值就是一个目标状态枚举。
  if (GOAL_STATUS_LABELS[value as GoalStatus]) return GOAL_STATUS_LABELS[value as GoalStatus];

  // 象限值形如 `q1 — Important & urgent — do now`。
  const quadrantMatch = /^(q[1-4]) — .+$/.exec(value);
  if (quadrantMatch) return `${quadrantMatch[1]} · ${QUADRANT_TITLES[quadrantMatch[1] as Quadrant]}`;

  // 复合队列值：`score 82.5 · in_progress · goal: 我的目标`。
  let out = value;
  out = out.replace(/\b(inbox|claimed|in_progress|blocked|completed|archived)\b/g, (s) =>
    STATUS_LABELS[s as TaskStatus] ?? s,
  );
  out = out.replace(/\b(enabled|disabled)\b/g, (s) => (s === 'enabled' ? '已启用' : '已停用'));
  out = out.replace(/^(\d+)\/(\d+) done \(/, '$1/$2 已完成（');
  out = out.replace(/ · goal: /, ' · 目标：');
  if (/^#\d+\s/.test(label)) out = out.replace(/^score\s+/, '评分 ');
  out = out.replace(/( · 目标：)(.+)$/, (_, prefix: string, title: string) => prefix + demoTitle(title));
  return out;
}
