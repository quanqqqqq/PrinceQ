/**
 * Deterministic local command parser.
 *
 * This is NOT an LLM and does not pretend to be one. It is a regex/keyword
 * intent matcher that maps a line of natural-ish language onto one of the
 * supported commands plus typed arguments. Anything it cannot match with
 * confidence becomes a `clarification` so the caller never guesses at a write.
 *
 * Replacing this with a real Agent runtime means implementing the same
 * `AgentAdapter` interface in `runtime.ts` — nothing else needs to change.
 */
import type { Quadrant } from '../../shared/types.ts';
import { parseRelativeToIso } from '../../shared/datetime.ts';

export type Intent =
  | { kind: 'create_task'; title: string; deadline: string | null; minutes: number | null; goalTitle: string | null }
  | { kind: 'create_goal'; title: string; targetDate: string | null }
  | { kind: 'show_queue'; limit: number }
  | { kind: 'task_action'; action: 'claim' | 'release' | 'start' | 'complete' | 'block' | 'unblock'; title: string; reason: string | null }
  | { kind: 'change_quadrant'; title: string; quadrant: Quadrant }
  | { kind: 'confirm_quadrant'; title: string }
  | { kind: 'add_habit'; statement: string }
  | { kind: 'list_habits' }
  | { kind: 'disable_habit'; statement: string }
  | { kind: 'explain'; title: string }
  | { kind: 'draft_tasks'; goalTitle: string }
  | { kind: 'show_goals' }
  | { kind: 'help' }
  | { kind: 'batch_warning'; reason: string; original: string }
  | { kind: 'unknown'; original: string };

/** Natural-language dates the parser understands, resolved in the user's timezone. */
function parseWhen(text: string, now: Date = new Date()): string | null {
  const result = parseRelativeToIso(text, { now });
  return result?.iso ?? null;
};

function parseMinutes(text: string): number | null {
  const hours = text.match(/\b(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hours?|小时)\b/i);
  if (hours) return Math.round(Number(hours[1]) * 60);
  const minutes = text.match(/\b(\d+)\s*(?:m|min|mins|minutes?|分钟)\b/i);
  if (minutes) return Number(minutes[1]);
  return null;
}

const QUADRANT_ALIASES: { pattern: RegExp; quadrant: Quadrant }[] = [
  { pattern: /\b(q1|quadrant 1|important and urgent|urgent and important|do now)\b/i, quadrant: 'q1' },
  { pattern: /\b(q2|quadrant 2|important but not urgent|not urgent but important|schedule)\b/i, quadrant: 'q2' },
  { pattern: /\b(q3|quadrant 3|urgent but not important|not important but urgent|delegate)\b/i, quadrant: 'q3' },
  { pattern: /\b(q4|quadrant 4|neither|unimportant|drop|defer)\b/i, quadrant: 'q4' },
];

/** Trailing time/estimate phrases that belong to the metadata, not the title. */
const TRAILING_NOISE: RegExp[] = [
  // "… by tomorrow", "… due 2026-01-01", and bare "… tomorrow" alike: the
  // preposition is optional, since users drop it more often than not.
  /\s*\b(?:by|before|due|until|at|on)?\s*\b(today|tonight|tomorrow|next week|end of day|eod|in \d+ days?|\d{4}-\d{2}-\d{2}|今天|明天|下周)\b.*$/i,
  /\s*\b(takes?|estimate[ds]?|about|around|roughly)\s+\d+(?:\.\d+)?\s*(?:h|hr|hrs|hours?|m|min|mins|minutes?|小时|分钟)\b.*$/i,
  /\s*\b\d+(?:\.\d+)?\s*(?:h|hr|hrs|hours?|min|mins|minutes?|小时|分钟)\b\s*$/i,
];

/** Pulls a quoted string, or the text after a keyword, as the subject title. */
function extractSubject(text: string, afterKeywords: RegExp): string | null {
  const quoted = text.match(/["'“”‘’]([^"'“”‘’]{2,160})["'“”‘’]/);
  if (quoted) return quoted[1].trim();
  const match = text.match(afterKeywords);
  if (!match?.[1]) return null;

  let subject = match[1];
  for (const pattern of TRAILING_NOISE) subject = subject.replace(pattern, '');
  // Trim before stripping punctuation: the noise patterns leave trailing
  // whitespace, which would otherwise shield a dangling comma from the strip.
  return subject.trim().replace(/[.,;:!?，、]+$/, '').trim() || null;
}

/** Phrases that must never silently write — they get a preview instead. */
const BATCH_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\b(all|every|everything|each)\b.*\b(task|tasks|goal|goals)\b/i, reason: 'it targets every task or goal at once' },
  { pattern: /\b(delete|remove|wipe|purge|clear|reset|drop)\b/i, reason: 'it is a destructive verb' },
  { pattern: /\b(archive|complete|close)\s+(all|everything)\b/i, reason: 'it is a bulk lifecycle change' },
];

// ── 中文自然表达 ────────────────────────────────────────────────────────────
//
// 中文没有空格分词，所以不能复用英文的 \b 词边界。这里用「先识别开头动词短语，
// 再把剩下的文本当标题，最后剥掉结尾的日期/耗时短语」的方式提取主题。带引号的
// 标题一律优先，引号内的内容原样保留。

/** 抽取中文「书名号/引号」包裹的主题，没有就返回 null。 */
function extractQuotedZh(text: string): string | null {
  const m = text.match(/[「『“‘"]([^」』”’"']{1,160})[」』”’"']/);
  return m ? m[1].trim() : null;
}

/** 中文标题里结尾的日期与耗时短语，剥掉它们，不要混进标题。 */
function zhCleanTitle(raw: string): string {
  let t = raw.trim();
  // 结尾耗时：“需要 45 分钟”“大概 2 小时”
  t = t.replace(
    /[,，、\s]*(?:需要|耗时|大概|大约|约|预计|花)?\s*\d+(?:\.\d+)?\s*(?:个半)?\s*(?:小时|钟头|分钟)(?:\s*(?:左右|上下|大概))?.*$/,
    '',
  );
  // 结尾日期：“明天”“截止 2026-03-04”“今天上午十点”
  t = t.replace(
    /[,，、\s]*(?:截止|到期|到|于|在|约|定在)?\s*(?:今天|今晚|明天|后天|大后天|下周|下个?月|\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?)(?:上午|下午|晚上)?(?:[一二两三四五六七八九十]+点(?:半)?)?.*$/,
    '',
  );
  return t.trim().replace(/^[「『“‘"“]+/, '').replace(/[」』”’"”。.；;！!？?，,、\s]+$/, '').trim();
}

/** 去掉开头的命令动词短语，返回剩下的主题；动词不匹配返回 null。 */
function afterLeadingVerb(text: string, verbSource: string): string | null {
  const m = text.match(new RegExp(`^(?:帮我|给我|请)?(?:${verbSource})\\s*`));
  if (!m) return null;
  const rest = text.slice(m[0].length).trim();
  return rest || null;
}

const ZH_LIMIT = (text: string): number => {
  const n = Number(text.match(/前\s*(\d+)\s*(?:个|条|项)?/)?.[1] ?? text.match(/top\s*(\d+)/i)?.[1] ?? 10);
  return Math.min(Math.max(n, 1), 50);
};

/**
 * 中文意图解析。命中返回 Intent，拿不准返回 null（让上层继续英文解析或落到
 * unknown）。绝不因为只命中半个词就去写库。
 */
function parseChineseCommand(input: string): Intent | null {
  const text = input.trim();
  if (!text || !/[一-鿿]/.test(text)) return null;

  // 帮助
  if (/^(帮助|你好|你会做什么|你能做什么|你能帮我做什么|你可以做什么|命令|功能|可用指令)$/.test(text)) {
    return { kind: 'help' };
  }

  // 破坏性 / 批量：一律先拦下
  if (
    /(删除|清空|清除|抹掉|重置|数据库).*(任务|目标|数据|队列)/.test(text) ||
    /(全部|所有|每个|所有的).*(任务|目标)/.test(text) ||
    /^(删除|清空|清除|重置)(一切|所有|全部)?$/.test(text)
  ) {
    return { kind: 'batch_warning', reason: 'it targets every task or goal at once', original: text };
  }

  // 查看队列：含「队列/待办」，或「哪些任务/什么任务」这类查看说法，且不是目标/习惯语境
  if (
    (/队列|待办(清单|列表)?/.test(text) || (/任务/.test(text) && /(哪些|什么|看看|查看|现在|当前)/.test(text))) &&
    !/(目标|习惯|象限)/.test(text) &&
    !/(创建|新建|加个|提醒我|完成|开始|领取|标记)/.test(text)
  ) {
    return { kind: 'show_queue', limit: ZH_LIMIT(text) };
  }

  // 查看目标
  if (/目标/.test(text) && /(看看|查看|显示|列出|列一下|有哪些|都有什么|进展|情况)/.test(text) && !/(创建|新建|加个|增加|拆分|拆解|分解)/.test(text)) {
    return { kind: 'show_goals' };
  }

  // 习惯：先看是「查看」还是「添加/停用」
  if (/习惯/.test(text)) {
    if (/(查看|看看|有哪些|都有什么|列出|我的)/.test(text) && !/(添加|新增|记录|记住|停止|停用|关掉)/.test(text)) {
      return { kind: 'list_habits' };
    }
    const addStatement = afterLeadingVerb(text, '(?:添加|新增|加一个|记一下|记录|记住)(?:一条|一个|个)?(?:习惯)?[:：]?');
    if (addStatement) {
      return { kind: 'add_habit', statement: zhCleanTitle(addStatement) || addStatement.trim() };
    }
    const disableStatement = afterLeadingVerb(text, '(?:停用|停止|关掉|禁用)(?:一个|条|个)?(?:习惯)?[:：]?');
    if (disableStatement) {
      return { kind: 'disable_habit', statement: zhCleanTitle(disableStatement) || disableStatement.trim() };
    }
  }

  // 创建目标
  if (/目标/.test(text) && /(创建|新建|加个|增加|设立|开一个)/.test(text)) {
    const rest = afterLeadingVerb(text, '(?:创建|新建|加个|增加|设立|开一个)(?:一个|一条|个|项)?(?:新的?)?(?:目标)(?:叫做|叫|名为|是|：|:)?');
    if (rest) return { kind: 'create_goal', title: zhCleanTitle(rest) || rest.trim(), targetDate: parseWhen(text) };
  }

  // 拆分目标任务
  if (/目标/.test(text) && /(拆分|拆解|分解|拟任务|列任务).*(任务|计划)?/.test(text)) {
    const rest = afterLeadingVerb(text, '(?:给|把)?(?:这个|该|那个)?(?:目标)(?:拆|分解|拆解).*(?:成|为)?(?:任务|计划)?[:：]?');
    const goalTitle = extractQuotedZh(text) ?? (rest ? zhCleanTitle(rest) : null);
    if (goalTitle) return { kind: 'draft_tasks', goalTitle };
  }

  // 任务流转动词（领取/开始/完成/受阻/释放）——在「创建任务」之前判断，避免被吞掉
  const taskTitle = extractQuotedZh(text);
  // 「标记受阻」「X 卡住了」单独处理
  const isBlock = /(标记为受阻|标为受阻|标记受阻|受阻|卡住了|被阻塞|阻塞了)/.test(text) && !/(创建|新建)/.test(text);

  if (isBlock) {
    // 形如「把 X 标记为受阻」「标记 X 受阻」或「X 卡住了」
    let title = taskTitle;
    let reason: string | null = null;
    const reasonMatch = text.match(/(?:因为|由于|卡在|阻塞在|在等)\s*(.+)$/);
    if (reasonMatch) reason = reasonMatch[1].trim();
    if (!title) {
      let core = text.replace(/^(?:把|帮我把)/, '');
      // 先去掉原因尾巴，再去掉「标记为受阻/卡住了」这类标记短语（可能在中间或结尾）。
      core = core.replace(/[,，。\s]*(?:因为|由于|卡在|阻塞在|在等)\s*.+$/, '').trim();
      core = core
        .replace(/(?:标记为受阻|标为受阻|标记受阻|卡住了|被阻塞|阻塞了|受阻了?|受阻)/g, '')
        .trim();
      title = core;
    }
    if (title) return { kind: 'task_action', action: 'block', title: zhCleanTitle(title) || title, reason };
  }

  // 完成：既能「完成 X」，也能「把 X 做完」「标记 X 完成」
  const isComplete = /(完成|做完|搞定)/.test(text) && !/(创建|新建|加个|提醒我)/.test(text);
  if (isComplete) {
    let title = taskTitle;
    if (!title) {
      const leading = afterLeadingVerb(text, '(?:完成|做完|搞定)(?:了|掉|一下)?');
      const trailing = text
        .replace(/^(?:把|帮我把|标记)(?:一下)?\s*/, '')
        .replace(/(?:完|完成|做完|搞定|了|掉)$/, '')
        .trim();
      title = leading ?? trailing;
    }
    if (title) return { kind: 'task_action', action: 'complete', title: zhCleanTitle(title) || title, reason: null };
  }

  const ACTIONS_ZH: { test: RegExp; action: 'claim' | 'start' | 'release'; verbSource: string }[] = [
    { test: /(领取|认领|接手)/, action: 'claim', verbSource: '(?:领取|认领|接手)(?:一下|了|过|个|条|项|那个|这条|任务)?' },
    { test: /(释放|退回|放弃|不做了)/, action: 'release', verbSource: '(?:释放|退回|放弃)(?:一下|个|条|项|那个|这条|任务)?' },
    { test: /(开始|动手|着手|开始做)/, action: 'start', verbSource: '(?:开始|动手|着手)(?:做|一下|个|条|项|那个|这条|任务)?' },
  ];
  const isAction = ACTIONS_ZH.some((a) => a.test.test(text)) && !/(创建|新建|加个|提醒我)/.test(text);

  if (isAction) {
    for (const a of ACTIONS_ZH) {
      if (!a.test.test(text)) continue;
      let title = taskTitle;
      if (!title) {
        title = afterLeadingVerb(text, a.verbSource);
      }
      if (title) return { kind: 'task_action', action: a.action, title: zhCleanTitle(title) || title, reason: null };
    }
  }

  // 创建任务
  if (/(创建|新建|加个|增加|记一下|记录|提醒我|帮我记|写个|补一个)/.test(text) && !/(目标|习惯)/.test(text)) {
    let rest = afterLeadingVerb(text, '(?:创建|新建|加个|增加|写个|补一个|记一下|记录)(?:一个|一条|个|项|)?(?:任务|待办|事项|todo)?(?:叫做|叫|是|：|:)?');
    if (rest == null) {
      rest = afterLeadingVerb(text, '(?:提醒我|帮我记|提醒)(?:一下|要|需要)?(?:去|要|应该)?');
    }
    if (rest == null && taskTitle) rest = taskTitle;
    if (rest) {
      const goalTitle = text.match(/(?:在|为|面向|朝向)(?:这个|该|那个)?目标\s*(.+)$/)?.[1]?.trim() ?? null;
      const title = goalTitle ? rest.replace(/(?:在|为|面向|朝向)(?:这个|该|那个)?目标\s*.+$/, '').trim() : rest;
      return {
        kind: 'create_task',
        title: zhCleanTitle(title) || title.trim(),
        deadline: parseWhen(text),
        minutes: parseMinutes(text),
        goalTitle,
      };
    }
  }

  return null;
}

export function parseCommand(input: string): Intent {
  const text = input.trim();
  if (!text) return { kind: 'unknown', original: input };
  const lower = text.toLowerCase();

  if (/^(help|\?|what can you do|commands)$/i.test(text)) {
    return { kind: 'help' };
  }

  for (const { pattern, reason } of BATCH_PATTERNS) {
    if (pattern.test(text)) {
      return { kind: 'batch_warning', reason, original: text };
    }
  }

  // Explanation before action matching: "why is X ranked first" contains no verb
  // we would otherwise act on, but "explain" overlaps with other keywords.
  if (/\b(why|explain|reason|how come)\b/i.test(lower) && !/\bhabits?\b/i.test(lower)) {
    const title = extractSubject(
      text,
      /\b(?:why\s+(?:is|does|did)?\s*|explain\s+(?:why\s+)?|reason\s+for\s+)(.+?)(?:\s+(?:rank|ranked|ranking|position|score|scored|first|second|last|so high|so low|above|below|here)\b.*)?$/i,
    );
    if (title) return { kind: 'explain', title };
  }

  if (/\b(show|list|what(?:'s| is)? (?:in|on)|view|open)\b.*\bqueue\b/i.test(lower) || /^queue$/i.test(lower)) {
    const limit = Number(lower.match(/\btop\s+(\d+)\b/)?.[1] ?? 10);
    return { kind: 'show_queue', limit: Math.min(Math.max(limit, 1), 50) };
  }

  if (/\b(show|list|view)\b.*\bgoals?\b/i.test(lower)) {
    return { kind: 'show_goals' };
  }

  if (/\b(draft|decompose|break (?:down|up)|split)\b/i.test(lower) && /\bgoal\b/i.test(lower)) {
    const goalTitle = extractSubject(
      text,
      /\b(?:draft tasks for|decompose|break down|break up|split)\s+(?:the\s+)?(?:goal\s+)?(.+?)(?:\s+into.*)?$/i,
    );
    if (goalTitle) return { kind: 'draft_tasks', goalTitle: goalTitle.replace(/^goal\s+/i, '') };
  }

  if (/\bhabits?\b/i.test(lower)) {
    if (/\b(list|show|view|what)\b/i.test(lower)) return { kind: 'list_habits' };
    if (/\b(disable|turn off|stop|deactivate)\b/i.test(lower)) {
      const statement = extractSubject(text, /\b(?:disable|turn off|stop|deactivate)\s+(?:the\s+)?(?:habit\s+)?(.+?)$/i);
      if (statement) return { kind: 'disable_habit', statement: statement.replace(/\s+habit$/i, '') };
    }
    if (/\b(add|record|remember|note|track)\b/i.test(lower)) {
      const statement = extractSubject(
        text,
        /\b(?:add|record|remember|note|track)\s+(?:an?\s+)?(?:explicit\s+)?(?:habit[:\s]+)?(.+?)$/i,
      );
      if (statement) return { kind: 'add_habit', statement };
    }
  }

  // Quadrant moves must be checked before generic task actions, since "move X
  // to q1" would otherwise fall through to the unknown branch.
  if (/\b(move|change|set|reclassify|put)\b/i.test(lower) && /\b(q[1-4]|quadrant)\b/i.test(lower)) {
    const quadrant = QUADRANT_ALIASES.find((q) => q.pattern.test(lower))?.quadrant;
    const title = extractSubject(
      text,
      /\b(?:move|change|set|reclassify|put)\s+(?:task\s+)?(.+?)\s+(?:to|into|as)\s+(?:quadrant\s+)?q?[1-4]\b/i,
    );
    if (quadrant && title) return { kind: 'change_quadrant', title, quadrant };
    if (title && !quadrant) {
      return { kind: 'unknown', original: text };
    }
  }

  if (/\bconfirm\b/i.test(lower) && /\b(quadrant|classification|suggestion)\b/i.test(lower)) {
    const title = extractSubject(
      text,
      /\bconfirm\s+(?:the\s+)?(?:quadrant|classification|suggestion)\s+(?:for|on|of)\s+(.+?)$/i,
    );
    if (title) return { kind: 'confirm_quadrant', title };
  }

  const ACTIONS: { pattern: RegExp; action: Extract<Intent, { kind: 'task_action' }>['action'] }[] = [
    { pattern: /\b(claim|take|pick up|assign (?:me|myself))\b/i, action: 'claim' },
    { pattern: /\b(release|unclaim|give (?:up|back)|drop claim)\b/i, action: 'release' },
    { pattern: /\b(start|begin|work on|working on)\b/i, action: 'start' },
    { pattern: /\b(complete|finish|done with|mark done|completed)\b/i, action: 'complete' },
    { pattern: /\b(unblock|unstick)\b/i, action: 'unblock' },
    { pattern: /\b(block|stuck on|waiting on)\b/i, action: 'block' },
  ];

  for (const { pattern, action } of ACTIONS) {
    if (!pattern.test(lower)) continue;
    // "create a task to start the thing" is a create, not a start.
    if (/\b(create|add|new|make)\b.*\b(task|todo)\b/i.test(lower)) break;
    const title = extractSubject(
      text,
      new RegExp(`\\b(?:${pattern.source.replace(/\\b/g, '').replace(/^\(|\)$/g, '')})\\s+(?:the\\s+)?(?:task\\s+)?(.+?)$`, 'i'),
    );
    if (!title) continue;
    const reason =
      action === 'block'
        ? (text.match(/\b(?:because|since|due to|blocked by|waiting on)\s+(.+?)$/i)?.[1]?.trim() ?? null)
        : null;
    const cleanTitle = reason
      ? title.replace(/\s*\b(?:because|since|due to|blocked by|waiting on)\s+.+$/i, '').trim()
      : title;
    return { kind: 'task_action', action, title: cleanTitle, reason };
  }

  if (/\b(create|add|new|make|capture)\b/i.test(lower) && /\bgoal\b/i.test(lower)) {
    const title = extractSubject(
      text,
      /\b(?:create|add|new|make|capture)\s+(?:an?\s+)?(?:new\s+)?goal\s*(?:called|named|:)?\s*(.+?)$/i,
    );
    if (title) return { kind: 'create_goal', title, targetDate: parseWhen(text) };
  }

  if (/\b(create|add|new|make|capture|remind me to)\b/i.test(lower)) {
    const title = extractSubject(
      text,
      /\b(?:create|add|new|make|capture)\s+(?:an?\s+)?(?:new\s+)?(?:task|todo|item)?\s*(?:called|named|to|:)?\s*(.+?)$/i,
    ) ?? extractSubject(text, /\bremind me to\s+(.+?)$/i);
    if (title) {
      const goalTitle = text.match(/\b(?:for|under|toward|towards)\s+(?:the\s+)?goal\s+(.+?)$/i)?.[1]?.trim() ?? null;
      return {
        kind: 'create_task',
        title: goalTitle ? title.replace(/\s*\b(?:for|under|toward|towards)\s+(?:the\s+)?goal\s+.+$/i, '').trim() : title,
        deadline: parseWhen(text),
        minutes: parseMinutes(text),
        goalTitle,
      };
    }
  }

  // 英文规则没命中时，再试一遍中文自然表达。
  const zh = parseChineseCommand(text);
  if (zh) return zh;

  return { kind: 'unknown', original: text };
}

/** Short reference rendered by the `help` intent and the UI's empty state. */
export const SUPPORTED_COMMANDS: { command: string; example: string; description_zh: string }[] = [
  { command: 'create a task', example: 'create task "Draft Q3 review notes" by tomorrow, takes 45m', description_zh: '创建一个任务' },
  { command: 'create a goal', example: 'create goal "Ship the billing rewrite" by 2026-12-01', description_zh: '创建一个目标' },
  { command: 'show queue', example: 'show queue top 5', description_zh: '查看队列排名' },
  { command: 'show goals', example: 'list goals', description_zh: '查看目标列表' },
  { command: 'claim / release / start / complete / block a task', example: 'start "Draft Q3 review notes"', description_zh: '领取 / 释放 / 开始 / 完成 / 受阻 一个任务' },
  { command: 'change a task quadrant', example: 'move "Draft Q3 review notes" to q2', description_zh: '修改任务象限' },
  { command: 'confirm a quadrant suggestion', example: 'confirm the quadrant for "Draft Q3 review notes"', description_zh: '确认象限建议' },
  { command: 'draft tasks for a goal', example: 'draft tasks for goal "Ship the billing rewrite"', description_zh: '为目标拟任务草稿' },
  { command: 'add / list / disable an explicit habit', example: 'add habit "deep work before noon"', description_zh: '新增 / 列出 / 停用显式习惯' },
  { command: 'explain a ranking', example: 'why is "Draft Q3 review notes" ranked first', description_zh: '解释一次排名' },
];
