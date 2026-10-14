/**
 * 后端系统文案的中文展示映射（纯函数，无任何界面依赖）。
 *
 * 放在 shared/ 的原因与 `./labels.ts` 相同：操作记录的中文摘要既要在界面上渲染，
 * 也要供 `listOperations` 的中文搜索使用，两边必须同源。`src/lib/i18n.ts` 再导出
 * 本文件的 `translateSystemText`，界面层的导入路径保持不变。
 */

/**
 * 后端返回的系统提示文案的中文展示映射。
 *
 * 只按整句精确匹配系统自己写死的句子，匹配不上就原样显示——这样绝不会碰到
 * 用户录入的自由文本。
 */
import { ACTION_LABELS, STATUS_LABELS } from './labels.ts';
import type { TaskAction, TaskStatus } from './types.ts';

const SYSTEM_MESSAGE_MAP: Record<string, string> = {
  'Cannot reach the local API on 127.0.0.1:28642. Start it with `npm run dev`.':
    '无法连接 127.0.0.1:28642 上的本地 API，请先执行 `npm run dev` 启动服务。',
};

/** 规则引擎写入的象限理由里出现的固定英文片段。 */
const SYSTEM_PHRASE_MAP: [RegExp, string][] = [
  [/^Important & urgent — do now\./, '重要且紧急，建议立即处理。'],
  [/^Important, not urgent — schedule\./, '重要但不紧急，建议排入计划。'],
  [/^Urgent, not important — batch or delegate\./, '紧急但不重要，建议批量处理或委派。'],
  [/^Neither — defer or drop\./, '既不重要也不紧急，建议延后或放弃。'],
  [/Derived importance ([\d.]+) → (\d)\/5 and urgency ([\d.]+) → (\d)\/5 from (\d+) signal\(s\)\./,
    '由 $5 条信号推导：重要度 $1 → $2/5，紧急度 $3 → $4/5。'],
  [/Confidence (\d+)% — awaiting your confirmation\./, '置信度 $1%，等待你确认。'],

  // 目标拆分草稿：模板写死的阶段名与说明（`goal.title: <阶段名>`，前半段是用户文本，
  // 只替换后面的固定片段）。
  [/: scope and acceptance criteria$/, '：明确范围与验收标准'],
  [/: implementation$/, '：动手实现'],
  [/: review and polish$/, '：自查与收尾'],
  [/: ship and announce$/, '：发布并同步'],
  [/: pick one source and skim it$/, '：选定一份资料并通读一遍'],
  [/: work through the core material$/, '：精读核心内容'],
  [/: build something small with it$/, '：做一个小练习验证'],
  [/: write a summary$/, '：写一份总结'],
  [/: frame the question$/, '：界定要回答的问题'],
  [/: gather evidence$/, '：收集证据'],
  [/: compare options$/, '：横向比较各方案'],
  [/: write the recommendation$/, '：写出结论与理由'],
  [/: define the minimum daily version$/, '：定义每天的最小版本'],
  [/: set up the trigger and tracking$/, '：设置触发点与记录方式'],
  [/: run a two-week trial$/, '：先试行两周'],
  [/: review and adjust$/, '：复盘并调整'],
  [/: clarify the outcome$/, '：明确目标结果'],
  [/: first concrete step$/, '：第一个具体步骤'],
  [/: main body of work$/, '：主体工作'],
  [/: wrap up and review$/, '：收尾与复盘'],

  [/^Write down what "done" means and the checks that prove it\.$/, '写清"完成"的定义，以及验证它的检查项。'],
  [/^Do the core build work\.$/, '完成核心实现工作。'],
  [/^Self-review, fix gaps, tidy loose ends\.$/, '自查、补齐缺口、清理遗留问题。'],
  [/^Release it and tell the people who are waiting\.$/, '发布，并通知在等这件事的人。'],
  [/^Choose a single authoritative source; skim for the shape of it\.$/, '选一份权威资料，先通读建立整体印象。'],
  [/^Study the central chapters\/modules with notes\.$/, '精读核心章节或模块，并做笔记。'],
  [/^Apply it to a toy problem to expose the gaps\.$/, '用一个小问题练手，暴露理解上的缺口。'],
  [/^Condense what you learned into notes you would reread\.$/, '把学到的内容浓缩成你愿意回看的笔记。'],
  [/^State the decision and what evidence would settle it\.$/, '写明要做的决定，以及什么证据能定论。'],
  [/^Collect data and prior art for each option\.$/, '为每个方案收集数据与已有实践。'],
  [/^Lay the options side by side against the criteria\.$/, '按评判标准把各方案并排比较。'],
  [/^Record the call and its rationale\.$/, '记录结论及其理由。'],
  [/^Pick the smallest version you would never skip\.$/, '选一个你绝不会跳过的最小版本。'],
  [/^Attach it to an existing cue; decide how you will log it\.$/, '挂到已有的日常触发点上，并确定记录方式。'],
  [/^Follow the minimum version and record every day\.$/, '按最小版本执行，并每天记录。'],
  [/^Look at the log; keep, shrink or change the trigger\.$/, '回看记录，决定保持、缩小还是更换触发点。'],
  [/^Write a one-sentence definition of done\.$/, '用一句话写清完成的标准。'],
  [/^The smallest action that creates real progress\.$/, '能带来真实进展的最小动作。'],
  [/^The bulk of the effort toward the outcome\.$/, '达成结果所需的主要投入。'],
  [/^Confirm the outcome was reached; capture what is left\.$/, '确认结果已达成，并记录剩余事项。'],

  // 拆分预览的说明行。
  [/^Matched the deterministic "(.+)" decomposition template — no model was called\.$/,
    '命中确定性拆分模板「$1」，未调用任何模型。'],
  [/^Draft deadlines are spread evenly up to the goal target date \((.+)\)\.$/,
    '草稿的截止时间在目标日期（$1）之前均匀分布。'],
  [/^The goal has no target date, so drafts carry no deadlines\.$/,
    '该目标没有设定日期，因此草稿不带截止时间。'],
  [/^This goal already has (\d+) task\(s\)\. Nothing is created until you confirm\.$/,
    '该目标已有 $1 个任务。在你确认之前不会创建任何内容。'],

  // 助手面板（确定性本地模式）的回复文案。凡是夹着用户标题的句子都用捕获组
  // 原样带回，绝不改写用户输入。
  [/^No task matches "(.+)"\.$/, '没有标题匹配「$1」的任务。'],
  [/^"(.+)" matches (\d+) tasks — which one\?$/, '「$1」匹配到 $2 个任务，是哪一个？'],
  [/^No goal matches "(.+)"\.$/, '没有标题匹配「$1」的目标。'],
  [/^"(.+)" matches (\d+) goals — which one\?$/, '「$1」匹配到 $2 个目标，是哪一个？'],
  [/^No explicit habit matches "(.+)"\.$/, '没有匹配「$1」的显式习惯。'],
  [/^Title lookup is exact-first, then substring — neither matched\.$/,
    '标题查找先精确匹配再做子串匹配，两者都没命中。'],
  [/^Nothing was written\. Create the task first, or retry with the exact title\.$/,
    '未写入任何数据。请先创建该任务，或用完整标题重试。'],
  [/^Nothing was written\. Use "list habits" to see the exact statements and ids\.$/,
    '未写入任何数据。可用 "list habits" 查看完整的习惯描述与 id。'],
  [/^Deterministic local mode — supported commands$/, '确定性本地模式——支持的指令'],
  [/^This panel runs a rule-based command parser, not a language model\.$/,
    '这个面板运行的是基于规则的命令解析器，不是语言模型。'],
  [/^Unmatched or batch-like input returns a preview or clarification instead of writing\.$/,
    '无法匹配或涉及批量的输入只会返回预览或追问，不会直接写入。'],
  [/^That command is not supported in deterministic local mode\.$/,
    '确定性本地模式不支持这条指令。'],
  [/^The parser matched no known intent, so nothing was written\.$/,
    '解析器没有命中任何已知意图，因此没有写入数据。'],
  [/^A real Agent runtime can be plugged in behind the same adapter interface later\.$/,
    '当前使用本地命令模式，可在个人设置中配置并启用助手 Agent。'],
  [/^Held back — this looks destructive or batch-like\.$/, '已拦截——这看起来是破坏性或批量操作。'],
  [/^Refused to execute automatically because (.+)\.$/, '拒绝自动执行，原因：$1。'],
  [/^Deterministic local mode never performs bulk or destructive writes without an explicit per-item command\.$/,
    '确定性本地模式不会在没有逐条明确指令的情况下执行批量或破坏性写入。'],
  [/^Nothing was written\.$/, '未写入任何数据。'],
  [/^The command was understood as "(.+)" but the write was rejected\.$/,
    '指令被识别为「$1」，但写入被拒绝。'],
  [/^No partial change was applied — the operation ran in a transaction\.$/,
    '没有产生部分生效的改动——整个操作在事务中执行。'],
  [/^The queue is empty\.$/, '队列是空的。'],
  [/^No tasks are in inbox, claimed, in_progress or blocked state\.$/,
    '没有处于待处理、已领取、进行中或受阻状态的任务。'],
  [/^Top (\d+) of (\d+) ranked task\(s\)$/, '已排序任务共 $2 个，这里是前 $1 个'],
  [/^Ranked by snapshot (.+) \((.+)\)\.$/, '依据当前工作队列的排序结果展示。'],
  [/^Ranking uses deadline, manual priority, dependencies, effort, habits and context continuity — not the quadrant\.$/,
    '排序依据截止时间、手动优先级、依赖、工作量、习惯与上下文连续性，与象限无关。'],
  [/^No active goals\.$/, '没有进行中的目标。'],
  [/^Create one with: create goal "\.\.\."$/, '可以用 create goal "..." 创建一个。'],
  [/^(\d+) active goal\(s\)$/, '$1 个进行中的目标'],
  [/^Progress is the share of non-archived linked tasks that are completed\.$/,
    '进度是关联的未归档任务中已完成的比例。'],
  [/^Habit files$/, '习惯文件'],
  [/^Quadrant is not an input to this score — the queue and the matrix are separate views\.$/,
    '象限不是这个分值的输入项——队列与矩阵是两个独立视图。'],
  [/^Goals and tasks are separate entities — this goal has no tasks yet\.$/,
    '目标与任务是两类独立对象——这个目标暂时还没有任务。'],
  [/^Created goal "(.+)"\.$/, '已创建目标「$1」。'],
  [/^Created (\d+) task\(s\) under "(.+)"\.$/, '已在「$2」下创建 $1 个任务。'],
  [/^Created only after your explicit confirmation of the preview\.$/,
    '仅在你明确确认预览之后才创建。'],
  [/^Each task carries an unconfirmed quadrant suggestion you can confirm or change\.$/,
    '每个任务都带一个待确认的象限建议，你可以确认或修改。'],
  [/^Goal progress is now (\d+)\/(\d+)\.$/, '目标进度现在是 $1/$2。'],
  [/^Idempotency key replayed — no duplicate was created\.$/,
    '幂等键命中重放——没有创建重复数据。'],
  [/^Logged as operation (.+)\.$/, '已记录为操作 $1。'],
  [/^Quadrant inferred from the title\.$/, '象限由标题推断得出。'],
  [/^Marked as user-confirmed, so the agent will not re-suggest it\.$/,
    '已标记为用户确认，助手不会再重新推断。'],
  [/^This changes the matrix view only — the queue score is computed independently\.$/,
    '这只影响矩阵视图——队列分值是独立计算的。'],
  [/^No active claim on the task now\.$/, '该任务当前没有生效的领取记录。'],
  [/^The entry is retained but excluded from scoring, and the change is in the file history\.$/,
    '该条目保留但不参与评分，改动已记入文件历史。'],
  [/^Queue recalculated without it\.$/, '已在不计入它的情况下重算队列。'],
  [/^Written to habits\/explicit\.json via validate-then-atomic-rename, with a history entry\.$/,
    '通过"先校验再原子改名"写入 habits/explicit.json，并留下一条历史记录。'],
  [/^The queue scorer reads habit files on every recalculation, so ranking may shift\.$/,
    '队列评分每次重算都会读取习惯文件，排名可能因此变化。'],
  [/^Recorded explicit habit "(.+)"\.$/, '已记录显式习惯「$1」。'],
  [/^Disabled habit "(.+)"\.$/, '已停用习惯「$1」。'],
  [/^Created "(.+)" — suggested (q[1-4]) awaiting your confirmation\.$/,
    '已创建「$1」，推断象限 $2，等待你确认。'],
  [/^(\d+) draft task\(s\) for "(.+)" — confirm to create\.$/,
    '为「$2」拟了 $1 个任务草稿，确认后才会创建。'],
  [/^"(.+)" moved from (\w+) to (\w+)\.$/, '「$1」已从 $2 流转到 $3。'],
  [/^Transition "(.+)" is valid from (\w+)\.$/, '在 $2 状态下，「$1」是合法的流转。'],
  [/^Claim held by (.+) since (.+)\.$/, '由 $1 于 $2 起领取中。'],
  [/^Queue position #(.+) with score (.+) after recalculation\.$/,
    '重算后队列位置 #$1，分值 $2。'],
  [/^Queue recalculated — now at #(.+)\.$/, '队列已重算——当前位置 #$1。'],
  [/^"(.+)" is now (q[1-4]) — (.+)\.$/, '「$1」现在是 $2——$3。'],
  [/^Previous value: (.+) \((.+)\)\.$/, '原值：$1（来源 $2）。'],
  [/^Confirmed (q[1-4]) for "(.+)"\.$/, '已确认「$2」的象限为 $1。'],
  [/^Suggestion came from the (\w+) source with (\d+)% confidence\.$/,
    '该建议来自 $1，置信度 $2%。'],
  [/^"(.+)" sits at #(\d+) with score (.+)\.$/, '「$1」排在第 $2 位，分值 $3。'],
  [/^"(.+)" holds no queue position \(status: (\w+)\)\.$/,
    '「$1」当前不在队列中（状态：$2）。'],
  [/^Biggest contributors: (.+)\.$/, '贡献最大的因素：$1。'],
  [/^Next: draft tasks for goal "(.+)" to get a confirmable decomposition preview\.$/,
    '下一步：为目标「$1」拟一份可确认的任务拆分草稿。'],

  // 队列评分因子的 detail / notes（评分器写死的英文句子，按锚点替换）。
  [/^No deadline — neutral time pressure \(([\d.]+)\)\.$/, '没有截止时间——时间压力为中性（$1）。'],
  [/^Unparseable deadline — treated as neutral \(([\d.]+)\)\.$/, '截止时间无法解析——按中性处理（$1）。'],
  [/^Overdue by (\d+)h — maximum time pressure\.$/, '已逾期 $1 小时——时间压力最大。'],
  [/^Due in (\d+)h — due today\.$/, '$1 小时内到期——就是今天。'],
  [/^Due in (\d+)d — within three days\.$/, '$1 天内到期——三天以内。'],
  [/^Due in (\d+)d — this week\.$/, '$1 天内到期——本周。'],
  [/^Due in (\d+)d — this month\.$/, '$1 天内到期——本月。'],
  [/^Due in (\d+)d — far out\.$/, '$1 天后到期——还很远。'],
  [/^No estimate — slight uncertainty discount \(([\d.]+)\)\.$/, '没有预计耗时——略打折扣（$1）。'],
  [/^(\d+)m — quick win\.$/, '$1 分钟——顺手就能做完。'],
  [/^(\d+)m — fits one focused block\.$/, '$1 分钟——一个专注时段能完成。'],
  [/^(\d+)m — one long block\.$/, '$1 分钟——需要一整个长时段。'],
  [/^(\d+)m — needs a scheduled session\.$/, '$1 分钟——需要专门排一个时段。'],
  [/^(\d+)m — large; consider splitting it\.$/, '$1 分钟——体量较大，考虑拆分。'],
  [/^Nothing in progress — no switching cost\.$/, '当前没有进行中的任务——没有切换成本。'],
  [/^Manual override of ([+-][\d.]+) applied after weighting\.$/, '加权后又叠加了手动调整 $1。'],
  [/^Not startable yet: at least one dependency is unfinished\.$/, '还不能开始：至少有一个依赖未完成。'],
  [/^Blocked: (.+)\.$/, '受阻：$1。'],
  [/^Blocked\.$/, '已标记受阻。'],
  [/^Quadrant is an unconfirmed agent suggestion; it does not affect this score\.$/,
    '象限是尚未确认的助手建议，不影响这个分值。'],
  [/^Hard constraint in force: (.+)$/, '生效中的硬约束：$1。'],

  [/^Read from habits\/ on this call: explicit v(\S+), inferred v(\S+), constraints v(\S+), weights v(\S+)\.$/,
    '本次调用读取 habits/：显式 v$1、推断 v$2、硬约束 v$3、权重 v$4。'],
  [/^Create (\d+) task\(s\) under "(.+)"$/, '在「$2」下创建 $1 个任务'],
];

/**
 * 把后端系统文案转为中文展示。
 *
 * 先整句匹配，再做固定片段替换；都匹配不上则原样返回。用于 `quadrant_reason`、
 * 错误消息等由代码生成的字段，不要用在用户输入上。
 */
export function translateSystemText(text: string | null | undefined): string {
  if (!text) return '';
  const transition = /^Cannot (\w+) a task in status "(\w+)" — allowed from: ([\w, ]+)\.$/.exec(text.trim());
  if (transition) {
    const action = ACTION_LABELS[transition[1] as TaskAction] ?? transition[1];
    const status = STATUS_LABELS[transition[2] as TaskStatus] ?? transition[2];
    const allowed = transition[3].split(',').map(value => STATUS_LABELS[value.trim() as TaskStatus] ?? value.trim()).join('、');
    return `当前任务为「${status}」，不能${action}；允许的起始状态：${allowed}。`;
  }
  const preview = /^(claim|release|start|complete|block)：(.+)$/.exec(text);
  if (preview) return ACTION_LABELS[preview[1] as TaskAction] + '：' + preview[2];
  const exact = SYSTEM_MESSAGE_MAP[text.trim()];
  if (exact) return exact;
  let output = text;
  for (const [pattern, replacement] of SYSTEM_PHRASE_MAP) {
    output = output.replace(pattern, replacement);
  }
  return output;
}
