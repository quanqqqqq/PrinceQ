/**
 * 目标拆解的纯判定逻辑（UX-22）。
 *
 * 只有标题归一化与「草稿 ↔ 已有任务」的疑似重复匹配，零数据库、零 React 依赖，
 * 可被 `node --test` 直接 import。
 *
 * 为什么要归一化：草稿标题是 `目标标题：阶段后缀` 拼出来的，而用户手动建的同一
 * 件事可能只写了阶段后缀、或者用了不同的标点/空格。所以比较前先剥掉目标前缀、
 * 去掉标点与空白、统一大小写，再比主体。
 */

/** 归一化时要去掉的标点：全角与半角各一套，含冒号、引号、括号、顿号等。 */
const PUNCTUATION = /[\s:：，,。.、;；!！?？'"'""「」『』()（）[\]【】{}<>《》~～\-—_/\\|+*#&@]/g;

/**
 * 标题归一化：转小写、去标点与空白。
 *
 * 结果只用于相等/包含比较，不回显给用户，所以可以这么激进。
 */
export function normalizeTitleKey(text: string): string {
  if (!text) return '';
  return text.toLowerCase().replace(PUNCTUATION, '');
}

/**
 * 剥掉「目标标题：」前缀后的主体，再做归一化。
 *
 * 先按原文去掉前缀（这样 `学习 Rust：精读核心部分` → `精读核心部分`），归一化后
 * 再兜一次（应对用户写成 `学习Rust - 精读核心部分` 这类变体）。
 */
export function normalizeTitleBody(text: string, goalTitle: string): string {
  const trimmed = (text ?? '').trim();
  const goal = (goalTitle ?? '').trim();

  let body = trimmed;
  if (goal) {
    // 原文层面剥前缀：`目标标题` 后面跟任意一个分隔符。
    const prefixed = new RegExp(`^${escapeRegExp(goal)}\\s*[:：\\-—·|]*\\s*`, 'i');
    body = body.replace(prefixed, '');
  }

  const key = normalizeTitleKey(body);
  const goalKey = normalizeTitleKey(goal);
  // 归一化后仍带着目标前缀（原文分隔符没覆盖到）时再剥一次。
  if (goalKey && key !== goalKey && key.startsWith(goalKey)) {
    return key.slice(goalKey.length);
  }
  return key;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 匹配时只需要这两列，跟 `SELECT title, status` 对齐。 */
export interface ExistingTaskRow {
  title: string;
  status: string;
}

export interface PhaseMatch {
  task: ExistingTaskRow;
  reason: string;
}

/**
 * 把一个草稿阶段与目标下的已有任务做疑似重复匹配。
 *
 * 判定：归一化主体相等，或一方包含另一方（短的那个至少 3 个字符，否则 `收尾`
 * 这种两字后缀会把半个列表都误判成重复）。
 *
 * 命中多条时**不能**取「SQL 返回的第一条」——调用方要靠返回行的状态决定是整条
 * 跳过（已完成）还是只打重复标记（未完成）。如果一条措辞更松的未完成任务恰好
 * 排在前面，它就会盖掉真正精确命中的已完成任务，于是用户被再次建议去做一件已
 * 经做完的事。所以按「已完成优先、精确匹配优先」挑最有决定性的那条。
 */
export function matchPhaseToExisting(
  phaseSuffix: string,
  goalTitle: string,
  existing: ExistingTaskRow[],
): PhaseMatch | null {
  const draftKey = normalizeTitleBody(phaseSuffix, goalTitle);
  if (!draftKey) return null;

  let best: { match: PhaseMatch; rank: number } | null = null;

  for (const task of existing) {
    const taskKey = normalizeTitleBody(task.title ?? '', goalTitle);
    if (!taskKey) continue;

    let match: PhaseMatch | null = null;
    let exact = false;
    if (taskKey === draftKey) {
      match = { task, reason: '标题主体完全相同' };
      exact = true;
    } else {
      const shorter = taskKey.length <= draftKey.length ? taskKey : draftKey;
      const longer = shorter === taskKey ? draftKey : taskKey;
      if (shorter.length >= 3 && longer.includes(shorter)) {
        match = { task, reason: '标题主体互相包含' };
      }
    }
    if (!match) continue;

    // 已完成（会让整条阶段被跳过）比未完成更有决定性；同档里精确匹配优先。
    const rank = (task.status === 'completed' ? 2 : 0) + (exact ? 1 : 0);
    if (!best || rank > best.rank) best = { match, rank };
  }

  return best?.match ?? null;
}
